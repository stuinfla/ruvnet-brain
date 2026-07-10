#!/usr/bin/env node
// eval-brain.mjs — the eval flywheel. Ask the frozen held-out questions, and judge the answers by
// GROUND TRUTH rather than by a model's opinion of them. (ADR-0011 Phase 0.)
//
// FIVE STRATA, because a gate that only asks easy questions cannot fail:
//   named       — the repo is named in the question           pass = grounded AND routed
//   described   — capability described, no names              pass = grounded AND routed
//   scenario    — a real-world situation, no names            pass = grounded AND routed
//   adversarial — the correct answer is NOT in this corpus    pass = ABSTAINED (top ce < 0, or no hits)
//   provenance  — gist-shaped content                          pass = grounded AND (if the top hit IS a
//                 gist chunk, it must carry its GIST STATUS banner — better repo grounding also passes)
//
// GATING IS ON THE WILSON LOWER BOUND, never the point estimate. With n=12, routed 10/12 had a 95%
// CI of [55.2%, 95.3%] and 9/12's upper bound (91.1%) overlapped it completely — the gate could not
// detect the regression it existed to catch. n=120 gives ≥80% power for a 0.90 -> 0.80 drop (n≈69
// suffices; computed 2026-07-09).
//
// FAIL-CLOSED PROMOTION: `--gate` compares each metric's lower bound against evals/baseline.json and
// exits 1 on any drop. A missing baseline is a failure too — you cannot promote against nothing.
// Baselines are only ever written deliberately with `--record`.
//
// Why no model judge: an LLM panel scored a ZERO-CITATION answer 98/100 on this repo.
//
//   node scripts/eval-brain.mjs                 # run + table
//   node scripts/eval-brain.mjs --gate          # run + exit 1 on regression (or missing baseline)
//   node scripts/eval-brain.mjs --record        # run + write evals/baseline.json (deliberate)
//   node scripts/eval-brain.mjs --json          # machine-readable
//   node scripts/eval-brain.mjs --strata named,adversarial   # subset (never gate on a subset)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
const HELD_OUT = path.join(ROOT, 'evals', 'held-out.json');
const BASELINE = path.join(ROOT, 'evals', 'baseline.json');

// The cross-encoder emits a relevance logit per (query, passage): strongly negative when unrelated.
// An adversarial question "passes" when the brain effectively found nothing relevant. 0 is the
// neutral cut; per-question ce values are recorded so this stays inspectable, and the Wilson-gated
// baseline makes the stratum a regression detector even if the absolute rate is imperfect.
export const ABSTAIN_CE = 0;

/**
 * Order-independent, tamper-evident hash of the held-out set — rUv's own frozen-eval pattern
 * (ruflo harness-frozen-eval: humanEvalHash / FROZEN_HUMAN_EVAL_HASH). The pinned constant lives in
 * tests/unit/eval-brain-gate.test.mjs; editing ANY question turns that test red, which is what
 * "frozen" means mechanically. Reordering does not (sorting makes the hash order-independent).
 */
export async function heldOutHash(questions) {
  const { createHash } = await import('node:crypto');
  const per = questions.map((q) =>
    createHash('sha256').update(JSON.stringify({ id: q.id, stratum: q.stratum, query: q.query, expectRepo: q.expectRepo ?? null })).digest('hex'));
  return createHash('sha256').update(per.sort().join('')).digest('hex');
}

/** Wilson score interval — the same instrument rUv uses on every SWE-bench number. */
export function wilson(k, n, z = 1.96) {
  if (!n) return { p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/**
 * Grade one answered question by its stratum's rule. Pure — takes the verifier verdict, the top
 * citation (with its ce score), and whether the raw output carried the gist provenance banner.
 */
export function gradeQuestion(q, { grounded, citations, bannerPresent }) {
  const top = citations?.[0] ?? null;
  const routed = !!(grounded && q.expectRepo?.length && top && q.expectRepo.includes(top.repo));
  const abstained = !top || (typeof top.ce === 'number' && top.ce < ABSTAIN_CE);
  switch (q.stratum) {
    case 'adversarial':
      return { grounded, routed: null, abstained, pass: abstained };
    case 'provenance':
      // The mechanism under test: IF a gist chunk wins, it must carry its own status banner.
      // A better hit from the real repo is not a failure — it is better grounding.
      return { grounded, routed: null, abstained, pass: !!grounded && (top?.repo !== 'ruv-gists' || bannerPresent) };
    default:
      return { grounded, routed, abstained, pass: !!grounded && routed };
  }
}

/** Aggregate graded rows into the four gated metrics, each with its Wilson interval. */
export function aggregate(rows) {
  const by = (pred) => rows.filter(pred);
  const routedStrata = (r) => ['named', 'described', 'scenario'].includes(r.stratum);
  const groundable = by((r) => r.stratum !== 'adversarial');
  const routed = by(routedStrata);
  const adversarial = by((r) => r.stratum === 'adversarial');
  const provenance = by((r) => r.stratum === 'provenance');
  const metric = (arr, key) => {
    const k = arr.filter((r) => r[key]).length;
    return { k, n: arr.length, ...wilson(k, arr.length) };
  };
  return {
    grounded: metric(groundable, 'grounded'),
    routed: metric(routed, 'pass'),
    abstain: metric(adversarial, 'pass'),
    banner: metric(provenance, 'pass'),
  };
}

/** The fail-closed comparison: every metric's lower bound must hold the baseline's lower bound. */
export function gateAgainst(current, baseline) {
  if (!baseline) return { pass: false, regressions: ['no baseline to promote against — record one deliberately (--record)'] };
  // An old-schema baseline (pre-strata counts, no {k,n,lo}) must FAIL, not pass vacuously — a gate
  // that silently compares against nothing is the decorated-green failure this whole phase kills.
  if (!['grounded', 'routed', 'abstain', 'banner'].some((m) => baseline[m]?.n)) {
    return { pass: false, regressions: ['baseline is from an older schema — re-record deliberately (--record)'] };
  }
  const regressions = [];
  for (const m of ['grounded', 'routed', 'abstain', 'banner']) {
    const cur = current[m];
    const base = baseline[m];
    if (!base || !base.n) continue; // metric absent from an older baseline — cannot regress against nothing
    if (!cur.n) { regressions.push(`${m}: stratum is empty but the baseline has n=${base.n}`); continue; }
    if (cur.lo < base.lo - 1e-9) regressions.push(`${m}: lower bound ${(cur.lo * 100).toFixed(1)}% < baseline ${(base.lo * 100).toFixed(1)}%`);
  }
  return { pass: regressions.length === 0, regressions };
}

async function main() {
  const argv = process.argv.slice(2);
  const GATE = argv.includes('--gate');
  const RECORD = argv.includes('--record');
  const JSON_OUT = argv.includes('--json');
  const strataArg = argv.includes('--strata') ? argv[argv.indexOf('--strata') + 1]?.split(',') : null;
  const die = (msg) => { console.error(`eval-brain: ${msg}`); process.exit(2); };

  if (!fs.existsSync(path.join(KB, 'forge-ask-all.mjs'))) die(`no brain at ${KB} — run: npx ruvnet-brain`);
  const verifierPath = path.join(KB, 'verify-citation.mjs');
  if (!fs.existsSync(verifierPath)) die('this bundle predates verify-citation.mjs — refusing to score grounding without a way to check it');
  const { verifyGrounding } = await import(pathToFileURL(verifierPath).href);

  let { questions } = JSON.parse(fs.readFileSync(HELD_OUT, 'utf8'));
  for (const q of questions) if (!q.stratum) die(`question ${q.id} has no stratum`);
  if (strataArg) {
    questions = questions.filter((q) => strataArg.includes(q.stratum));
    if (GATE || RECORD) die('--strata is for local iteration only; never gate or record on a subset');
  }

  // Each question is an independent subprocess with its own ONNX thread, so the pool parallelizes
  // cleanly across cores — spawnSync would serialize the whole run on the event loop. Measured
  // serial cost was ~13.5s/question ≈ 27 min for 120; at concurrency 6 the wall drops ~6×.
  const { execFile } = await import('node:child_process');
  const ask = (query) => new Promise((resolve) => {
    execFile('node', ['forge-ask-all.mjs', '--dir', KB, '--q', query, '--k', '3'],
      { cwd: KB, timeout: 240000, env: process.env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });

  const CONC = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? (argv.includes('--concurrency') ? argv[argv.indexOf('--concurrency') + 1] : 6)) || 6);
  const rows = new Array(questions.length);
  let cursor = 0;
  let done = 0;
  // An empty answer means the SUBPROCESS failed (contention, timeout, OOM) — an infrastructure
  // event, not a retrieval verdict. Scoring it as "not grounded" pollutes the quality metric with
  // ops noise: one dead process under 6-wide load dragged grounded's lower bound below baseline and
  // failed a gate that retrieval never failed (caught live, 2026-07-10, question ho-04 → "ce=—").
  // Retry once; if it still returns nothing, the row is an INFRA ERROR and the run is inconclusive.
  const infraErrors = [];
  const runOne = async () => {
    while (true) {
      const i = cursor++;
      if (i >= questions.length) return;
      const q = questions[i];
      let out = await ask(q.query);
      if (!out) { await new Promise((r) => setTimeout(r, 2000)); out = await ask(q.query); }
      if (!out) {
        infraErrors.push(q.id);
        done++;
        process.stderr.write(`\r[eval] ${done}/${questions.length} ! ${q.id} (infra)          `);
        continue;
      }
      const v = await verifyGrounding(out, KB);
      const graded = gradeQuestion(q, { grounded: v.grounded, citations: v.citations, bannerPresent: /GIST STATUS/.test(out) });
      const top = v.citations?.[0] ?? null;
      rows[i] = {
        id: q.id, stratum: q.stratum, query: q.query,
        citedRepo: top?.repo ?? null, citedPath: top?.fullPath ?? null, ce: top?.ce ?? null,
        ...graded,
      };
      done++;
      process.stderr.write(`\r[eval] ${done}/${questions.length} ${graded.pass ? '✓' : '✗'} ${q.id}          `);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, questions.length) }, runOne));
  process.stderr.write('\n');

  if (infraErrors.length) {
    console.error(`[eval-brain] INCONCLUSIVE — ${infraErrors.length} infrastructure failure(s) after retry: ${infraErrors.join(', ')}`);
    console.error('  A dead subprocess is not a retrieval verdict. Re-run (consider EVAL_CONCURRENCY=3 on a loaded machine).');
    process.exit(2); // never a quality verdict, never a recorded baseline
  }

  const score = aggregate(rows.filter(Boolean));

  if (JSON_OUT) {
    console.log(JSON.stringify({ score, rows }, null, 2));
  } else {
    console.log(`\n# eval-brain — frozen held-out set (${rows.length} questions)\n`);
    console.log('| metric | k/n | rate | 95% Wilson |');
    console.log('|---|---|---|---|');
    for (const [m, s] of Object.entries(score)) {
      if (!s.n) continue;
      console.log(`| ${m} | ${s.k}/${s.n} | ${(s.p * 100).toFixed(1)}% | [${(s.lo * 100).toFixed(1)}%, ${(s.hi * 100).toFixed(1)}%] |`);
    }
    const fails = rows.filter((r) => !r.pass);
    if (fails.length) {
      console.log(`\nFailures (${fails.length}):`);
      for (const f of fails) console.log(`  ✗ ${f.id} [${f.stratum}] → ${f.citedRepo ?? '—'} ce=${f.ce ?? '—'}  ${f.query.slice(0, 64)}`);
    }
    console.log('\nGrounded = the cited passage exists on disk. Routed = the owning repo answered.');
    console.log('Abstain = the brain declined an out-of-corpus question. Banner = a winning gist chunk carried its provenance.');
    console.log('No model graded anything here.\n');
  }

  if (RECORD) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify({ recorded: new Date().toISOString(), n: rows.length, score }, null, 2) + '\n');
    console.error(`[eval-brain] baseline recorded (${rows.length} questions)`);
  }

  if (GATE) {
    const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')).score : null;
    const g = gateAgainst(score, baseline);
    if (!g.pass) {
      console.error(`[eval-brain] FAIL (fail-closed): ${g.regressions.join('; ')}`);
      process.exit(1);
    }
    console.error('[eval-brain] PASS: every metric holds its baseline Wilson lower bound');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
