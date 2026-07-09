#!/usr/bin/env node
// eval-brain.mjs — the eval flywheel. Ask the frozen held-out questions, and judge the answers by
// GROUND TRUTH rather than by a model's opinion of them.
//
// TWO GATES, both checkable without an LLM:
//   1. GROUNDED   — the top citation resolves to a passage that really exists in the on-disk store.
//                   (kb/verify-citation.mjs. A path that doesn't resolve is a fabricated citation.)
//   2. ROUTED     — the repo it cited is one that actually owns the capability being asked about.
//
// Why no model judge: an LLM panel scored a ZERO-CITATION answer 98/100 on this repo. Model-as-judge
// is blind to precisely the failure that matters here. Ground truth is not.
//
// FAIL-CLOSED PROMOTION: `--gate` compares against evals/baseline.json and exits 1 when either gate
// regresses. A missing baseline is a failure too — you cannot promote against nothing. Record a new
// baseline deliberately with `--record`, never automatically: a baseline that follows the code is a
// ratchet with no teeth.
//
//   node scripts/eval-brain.mjs                 # run + print the table
//   node scripts/eval-brain.mjs --gate          # run + fail (exit 1) on regression
//   node scripts/eval-brain.mjs --record        # run + write evals/baseline.json (deliberate)
//   node scripts/eval-brain.mjs --json          # machine-readable

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = process.env.RUVNET_BRAIN_KB || path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
const HELD_OUT = path.join(ROOT, 'evals', 'held-out.json');
const BASELINE = path.join(ROOT, 'evals', 'baseline.json');

const argv = process.argv.slice(2);
const GATE = argv.includes('--gate');
const RECORD = argv.includes('--record');
const JSON_OUT = argv.includes('--json');

const die = (msg) => { console.error(`eval-brain: ${msg}`); process.exit(2); };

if (!fs.existsSync(path.join(KB, 'forge-ask-all.mjs'))) die(`no brain at ${KB} — run: npx ruvnet-brain`);
const verifier = path.join(KB, 'verify-citation.mjs');
if (!fs.existsSync(verifier)) die(`this bundle predates verify-citation.mjs — refusing to score grounding without a way to check it`);
const { verifyGrounding } = await import(pathToFileURL(verifier).href);

const { questions } = JSON.parse(fs.readFileSync(HELD_OUT, 'utf8'));

/** Ask the brain one question. Relative filename + cwd — see the identity-check note in install.mjs. */
function ask(query) {
  const r = spawnSync('node', ['forge-ask-all.mjs', '--dir', KB, '--q', query, '--k', '3'], {
    cwd: KB, encoding: 'utf8', timeout: 240000, env: process.env,
  });
  return r.status === 0 ? String(r.stdout || '') : '';
}

const results = [];
for (const q of questions) {
  const out = ask(q.query);
  const v = out ? await verifyGrounding(out, KB) : { grounded: false, reason: 'no-answer', citations: [] };
  const top = v.citations[0] || null;
  // ROUTED is judged on the citation we could VERIFY, falling back to the top hit when nothing
  // resolved — so a fabricated citation can never earn a routing point.
  const citedRepo = v.grounded ? v.receipt.repo : top?.repo ?? null;
  const routed = v.grounded && q.expectRepo.includes(citedRepo);
  results.push({
    id: q.id, query: q.query, expectRepo: q.expectRepo,
    grounded: v.grounded, reason: v.reason, citedRepo,
    citedPath: v.grounded ? v.receipt.path : (top?.fullPath ?? null),
    routed,
  });
}

const grounded = results.filter((r) => r.grounded).length;
const routed = results.filter((r) => r.routed).length;
const score = { total: results.length, grounded, routed };

if (JSON_OUT) {
  console.log(JSON.stringify({ score, results }, null, 2));
} else {
  console.log(`\n# eval-brain — frozen held-out set (${results.length} questions)\n`);
  console.log('| # | grounded | routed | cited | question |');
  console.log('|---|:---:|:---:|---|---|');
  for (const r of results) {
    const g = r.grounded ? '✓' : `✗ ${r.reason}`;
    const rt = r.routed ? '✓' : `✗ ${r.citedRepo ?? '—'}`;
    console.log(`| ${r.id} | ${g} | ${rt} | \`${r.citedPath ?? '—'}\` | ${r.query.slice(0, 58)} |`);
  }
  console.log(`\n**grounded ${grounded}/${results.length}** · **routed ${routed}/${results.length}**`);
  console.log('\nGrounded = the cited passage really exists on disk. Routed = it came from a repo that owns');
  console.log('the capability. No model graded anything here.\n');
}

if (RECORD) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify({ recorded: new Date().toISOString(), score }, null, 2) + '\n');
  console.error(`[eval-brain] baseline recorded: grounded ${grounded}/${score.total}, routed ${routed}/${score.total}`);
}

if (GATE) {
  if (!fs.existsSync(BASELINE)) {
    console.error('[eval-brain] FAIL: no baseline to promote against. Record one deliberately: --record');
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).score;
  const regressions = [];
  if (grounded < base.grounded) regressions.push(`grounded ${grounded} < baseline ${base.grounded}`);
  if (routed < base.routed) regressions.push(`routed ${routed} < baseline ${base.routed}`);
  if (regressions.length) {
    console.error(`[eval-brain] FAIL (fail-closed): ${regressions.join('; ')}`);
    process.exit(1);
  }
  console.error(`[eval-brain] PASS: grounded ${grounded}≥${base.grounded}, routed ${routed}≥${base.routed}`);
}
