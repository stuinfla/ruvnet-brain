#!/usr/bin/env node
// scripts/claims-verify.mjs — the CLAIMS LEDGER (ADR-0011 Phase 0, last open item).
//
// Every user-facing number must be regenerable from a real artifact on disk, and CI must fail
// when one can't be. Each ledger entry is { claim, source, verify } where verify() re-derives
// the number from the artifact — NO network, NO model calls, brain-independent, so it runs on
// a bare CI runner. If a check needs the 512MB brain and the brain is absent, it SKIPs LOUDLY
// (printed with a reason) — a skip is never a silent pass.
//
// Usage:  node scripts/claims-verify.mjs        (or: npm run claims:verify)
// Exit:   0 = every claim regenerated (skips allowed, printed); 1 = any claim failed.
//
// Verify functions take artifact paths as parameters (repo paths as defaults) so tests can
// point them at tampered copies. Main-guarded like scripts/eval-brain.mjs so tests can import
// the functions without running the CLI.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PASS = 'PASS';
const FAIL = 'FAIL';
const SKIP = 'SKIP';
const pass = (evidence) => ({ status: PASS, evidence });
const fail = (evidence) => ({ status: FAIL, evidence });
const skip = (evidence) => ({ status: SKIP, evidence });

// ── claim 1: "grounded 12/12 → n=120 baseline" ──────────────────────────────────────────────────
// evals/baseline.json is the recorded truth the eval gate promotes against. Assert the recorded
// stratum sizes (grounded k=n=100, routed n=80) plus internal consistency for EVERY metric:
// k ≤ n, p = k/n, lo ≤ p ≤ hi, all probabilities in [0,1]. No other expectations are hardcoded —
// the point is that the file is self-consistent and matches what we advertise, not that the
// scores themselves are any particular value.
export function verifyBaseline(file = path.join(ROOT, 'evals', 'baseline.json')) {
  let b;
  try {
    b = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`cannot read/parse ${file}: ${e.message}`);
  }
  if (!b.score || typeof b.score !== 'object') return fail('baseline has no score object');

  for (const [name, m] of Object.entries(b.score)) {
    if (!m || typeof m !== 'object') return fail(`metric ${name} is not an object`);
    const { k, n, p, lo, hi } = m;
    if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n <= 0)
      return fail(`metric ${name}: k/n must be non-negative integers with n>0 (k=${k}, n=${n})`);
    if (k > n) return fail(`metric ${name}: k=${k} > n=${n} — impossible count`);
    if (Math.abs(p - k / n) > 1e-9) return fail(`metric ${name}: p=${p} ≠ k/n=${k / n}`);
    // EPS absorbs float artifacts of the Wilson formula (k=n yields hi = 0.9999999999999999,
    // one ulp under p=1) without letting a real inconsistency through.
    const EPS = 1e-9;
    if (!(lo >= -EPS && hi <= 1 + EPS && lo <= p + EPS && p <= hi + EPS))
      return fail(`metric ${name}: interval broken — need 0 ≤ lo ≤ p ≤ hi ≤ 1 (lo=${lo}, p=${p}, hi=${hi})`);
  }

  const g = b.score.grounded, r = b.score.routed;
  if (!g || g.n !== 100 || g.k !== 100)
    return fail(`recorded truth drifted: expected grounded k=100/n=100, got k=${g?.k}/n=${g?.n} — if the baseline was deliberately re-recorded, update this ledger in the same commit`);
  if (!r || r.n !== 80)
    return fail(`recorded truth drifted: expected routed n=80, got n=${r?.n} — if the baseline was deliberately re-recorded, update this ledger in the same commit`);

  return pass(`grounded ${g.k}/${g.n}, routed n=${r.n}; all ${Object.keys(b.score).length} metrics satisfy k≤n and lo≤p≤hi`);
}

// ── claim 2: "held-out set is frozen at 120 questions across 5 strata" ──────────────────────────
// Recount the strata from the artifact itself. The expected census is the advertised one.
export const EXPECTED_STRATA = { named: 28, described: 32, scenario: 20, adversarial: 20, provenance: 20 };

export function verifyHeldOutStrata(file = path.join(ROOT, 'evals', 'held-out.json'), expected = EXPECTED_STRATA) {
  let setJson;
  try {
    setJson = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`cannot read/parse ${file}: ${e.message}`);
  }
  const qs = setJson.questions;
  if (!Array.isArray(qs)) return fail('held-out set has no questions array');

  const counts = {};
  for (const q of qs) counts[q.stratum] = (counts[q.stratum] || 0) + 1;

  const expectedTotal = Object.values(expected).reduce((a, b) => a + b, 0);
  const problems = [];
  for (const [stratum, want] of Object.entries(expected)) {
    if ((counts[stratum] || 0) !== want) problems.push(`${stratum}: ${counts[stratum] || 0} ≠ ${want}`);
  }
  for (const stratum of Object.keys(counts)) {
    if (!(stratum in expected)) problems.push(`unexpected stratum "${stratum}" (${counts[stratum]})`);
  }
  if (qs.length !== expectedTotal) problems.push(`total: ${qs.length} ≠ ${expectedTotal}`);
  if (problems.length) return fail(`strata census drifted: ${problems.join('; ')}`);

  return pass(`${qs.length} questions: ` + Object.entries(expected).map(([s, c]) => `${s} ${c}`).join(', '));
}

// ── claim 3: "~56× cheaper" (explainer + hook) ──────────────────────────────────────────────────
// Derived from the corpus fact recorded in the agent-harness-generator KB: a run cost $0.267
// (with the 51.33 figure alongside it). ~56× = $15 / $0.267 ≈ 56.2. We re-find both corpus
// strings with a plain streaming grep (first match wins) and re-do the arithmetic. The passages
// file ships with the 512MB brain, which CI does not have — absent file is a LOUD SKIP, never
// a silent pass.
export async function verifyCheaperFactor(file = path.join(ROOT, 'kb', 'agent-harness-generator.passages.jsonl')) {
  if (!fs.existsSync(file)) {
    return skip(`brain not installed — ${path.relative(ROOT, file)} absent, cannot re-derive ~56× from corpus (runs on machines with the brain)`);
  }

  const needles = ['$0.267', '51.33'];
  const found = new Set();
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      for (const needle of needles) if (!found.has(needle) && line.includes(needle)) found.add(needle);
      if (found.size === needles.length) break; // first match wins; stop streaming
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const missing = needles.filter((n) => !found.has(n));
  if (missing.length) return fail(`corpus fact missing from ${path.relative(ROOT, file)}: ${missing.join(', ')} — the ~56× claim no longer regenerates`);

  const factor = 15 / 0.267;
  if (Math.abs(factor - 56.2) > 0.1) return fail(`arithmetic drifted: 15 / 0.267 = ${factor.toFixed(2)}, expected ≈ 56.2`);

  return pass(`"$0.267" and "51.33" found in corpus; 15 / 0.267 = ${factor.toFixed(1)} ≈ 56×`);
}

// ── claim 4: "coverage badge says 10% of ALL source" ────────────────────────────────────────────
// The README badge and vitest.config.mjs must agree: the badge advertises 10% measured over ALL
// shipped source, which is only honest while `all: true` is set. If either drifts, the fix is to
// re-run coverage and update both together.
export const BADGE_NEEDLE = 'coverage-10%25%20of%20ALL%20source';

export function verifyCoverageBadge(
  readmeFile = path.join(ROOT, 'README.md'),
  vitestFile = path.join(ROOT, 'vitest.config.mjs'),
) {
  let readme, vitestCfg;
  try {
    readme = fs.readFileSync(readmeFile, 'utf8');
    vitestCfg = fs.readFileSync(vitestFile, 'utf8');
  } catch (e) {
    return fail(`cannot read artifact: ${e.message}`);
  }

  const badgeOk = readme.includes(BADGE_NEEDLE);
  const allTrue = /\ball\s*:\s*true\b/.test(vitestCfg);
  if (!badgeOk || !allTrue) {
    const what = [
      badgeOk ? null : `README badge no longer contains "${BADGE_NEEDLE}"`,
      allTrue ? null : 'vitest.config.mjs no longer sets coverage `all: true`',
    ].filter(Boolean).join(' AND ');
    return fail(`${what} — re-run \`npm run test:cov\` and update BOTH the README badge and vitest.config.mjs so the advertised number stays honest`);
  }
  return pass('README badge advertises 10% of ALL source and vitest.config.mjs has all: true');
}

// ── claim 5: "version surfaces agree" ───────────────────────────────────────────────────────────
// Delegated to the existing single-source-of-truth checker; we propagate its exit code.
export function verifyVersionSurfaces(root = ROOT) {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-version.mjs'), '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').pop() || '(no output)';
  if (res.status !== 0) return fail(`sync-version --check exited ${res.status}: ${out}`);
  return pass(out);
}

// ── the ledger ──────────────────────────────────────────────────────────────────────────────────
export const ledger = [
  {
    claim: 'grounded 12/12 → n=120 baseline',
    source: 'evals/baseline.json',
    verify: verifyBaseline,
  },
  {
    claim: 'held-out set is frozen at 120 questions across 5 strata',
    source: 'evals/held-out.json',
    verify: verifyHeldOutStrata,
  },
  {
    claim: '~56× cheaper (explainer + hook)',
    source: 'kb/agent-harness-generator.passages.jsonl',
    verify: verifyCheaperFactor,
  },
  {
    claim: 'coverage badge says 10% of ALL source',
    source: 'README.md + vitest.config.mjs',
    verify: verifyCoverageBadge,
  },
  {
    claim: 'version surfaces agree',
    source: 'scripts/sync-version.mjs --check',
    verify: verifyVersionSurfaces,
  },
];

// ── runner ──────────────────────────────────────────────────────────────────────────────────────
const cell = (s) => String(s).replaceAll('|', '\\|');

export async function runLedger(entries = ledger) {
  const rows = [];
  for (const entry of entries) {
    let result;
    try {
      result = await entry.verify();
    } catch (e) {
      result = fail(`verify() threw: ${e.message}`);
    }
    rows.push({ claim: entry.claim, source: entry.source, ...result });
  }
  return rows;
}

async function main() {
  const rows = await runLedger();

  console.log('## Claims ledger — every advertised number must regenerate from an artifact\n');
  console.log('| claim | status | evidence |');
  console.log('|---|---|---|');
  for (const r of rows) console.log(`| ${cell(r.claim)} | ${r.status} | ${cell(r.evidence)} |`);
  console.log('');

  const skipped = rows.filter((r) => r.status === SKIP);
  for (const s of skipped) console.log(`SKIPPED (not a pass): ${s.claim} — ${s.evidence}`);

  const failed = rows.filter((r) => r.status === FAIL);
  if (failed.length) {
    console.error(`\nclaims:verify FAILED — ${failed.length} claim(s) no longer regenerate from their artifacts.`);
    process.exit(1);
  }
  console.log(`\nclaims:verify OK — ${rows.length - skipped.length} verified, ${skipped.length} skipped (loudly).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
