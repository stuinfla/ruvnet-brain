#!/usr/bin/env node
// card-lane-gate.mjs — ADR-058 D6's HARD gate over kb/card-lane.mjs's decision lane.
//
// WHY THIS IS A HARD GATE WHEN THE REST OF ux-suite.mjs's TIMINGS ARE ADVISORY: ux-suite.mjs's own
// header argues, correctly, that a flaky timing gate trains people to override it — server-ready,
// console paint, etc. are all subject to real environmental noise (cold node boot, first-paint,
// disk cache state) that has nothing to do with whether the product is correct. kb/card-lane.mjs's
// decision lane is different in kind, not degree: it is MODEL-FREE, ML-FREE, keyword overlap over a
// ~20KB in-memory-cached file (measured 0.1158ms warm — see kb/card-lane-budget.json). A budget set
// at ~2,159x that baseline (250ms) and an absolute ceiling at ~8,600x it (1000ms) leaves so much
// headroom that a breach cannot be scheduler jitter — it can only be a correctness regression (an
// accidental await, a removed cache, a blocking fs call in the hot path). That is exactly the case
// this file's own anti-flake rule permits hard-gating, and is why this is a SEPARATE, narrow gate
// rather than an entry in the shared WARN table.
//
// MEASUREMENT METHOD, DELIBERATE (CI CONSTRAINT): this measures IN-PROCESS function calls only — no
// `spawnSync` per firing. A GitHub ubuntu runner has 2 vCPU against this dev machine's 16, and
// subprocess-per-firing measurement has already produced starved, silently-empty output on that
// runner twice tonight. In-process calls have no fork()/exec() cost and no OS scheduling of a new
// process per sample, so the number this file reports is the LANE's cost, not the scheduler's. If
// this ever needs to spawn a subprocess instead, the budget below MUST be re-derived and explicitly
// re-sized for a 2 vCPU runner — do not silently keep a 16-core-measured number for a 2 vCPU gate.
//
// THE THRESHOLDS ARE NOT HARDCODED HERE. They live in the checked-in manifest kb/card-lane-budget.json,
// which docs/adr/0058-the-95-contract.md `governs:` — so a silent threshold raise there shows up as
// governed-set drift under `node scripts/doc-currency.mjs --check` rather than being a free edit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerFromCards } from '../../kb/card-lane.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const KB_DIR = path.join(REPO_ROOT, 'kb');
export const BUDGET_PATH = path.join(KB_DIR, 'card-lane-budget.json');

// Real, first-party questions (plugin/test/capability-questions.json) rather than an invented
// string — the lane's cost should not depend on which of these it is asked, and cycling several
// (rather than one) avoids over-fitting the measurement to a single query's token count.
const FALLBACK_QUERIES = [
  'Can ruflo orchestrate agent swarms?',
  'Does RuVector use HNSW for vector search?',
  'Can rUv building blocks run graph queries over agent memory?',
];

function loadQueries() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin/test/capability-questions.json'), 'utf8'));
    const qs = raw.map((r) => r.query).filter(Boolean);
    return qs.length ? qs.slice(0, 5) : FALLBACK_QUERIES;
  } catch {
    return FALLBACK_QUERIES; // absence of the fixture must not sink the gate — it has its own tests
  }
}

export function loadBudget(budgetPath = BUDGET_PATH) {
  const raw = fs.readFileSync(budgetPath, 'utf8');
  const budget = JSON.parse(raw);
  for (const key of ['sampleSize', 'p95BudgetMs', 'absoluteFailMs']) {
    if (typeof budget[key] !== 'number' || !(budget[key] > 0)) {
      throw new Error(`card-lane-budget.json: "${key}" must be a positive number, got ${JSON.stringify(budget[key])}`);
    }
  }
  return budget;
}

// Nearest-rank percentile over an ASCENDING-sorted array. p in [0,100].
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * Fire the decision lane `n` times, IN-PROCESS, and return each firing's wall time in ms.
 * `answerFn` defaults to the real `answerFromCards` and exists as an injectable seam ONLY so
 * tests/unit/card-lane-gate.test.mjs can prove the THRESHOLD LOGIC catches a slow lane using a real
 * (setTimeout-based, not mocked-away) synthetic function, without needing to mutate the shipped
 * kb/card-lane.mjs to do it — that file's own mutant is exercised separately, for real, per ADR-058.
 * Tolerates `answerFn` returning either a plain object (today's shipped shape) or a thenable (what a
 * mutant that inserts `await new Promise(...)` inside it would produce) — the timing loop must
 * actually wait on the delay for the mutant to be observable at all.
 */
export async function measureFirings({ dir = KB_DIR, queries = loadQueries(), n = 100, answerFn = answerFromCards } = {}) {
  if (!queries.length) throw new Error('measureFirings: no queries to fire');
  // Warm-up: one untimed call, matching the lane's own memoization (kb/card-lane.mjs's `_cache`) so
  // the measured 100 firings reflect the WARM cost, not the one-time capability-cards.md parse.
  const warm = answerFn(queries[0], dir);
  if (warm && typeof warm.then === 'function') await warm;

  const samplesMs = [];
  for (let i = 0; i < n; i++) {
    const q = queries[i % queries.length];
    const t0 = process.hrtime.bigint();
    const result = answerFn(q, dir);
    if (result && typeof result.then === 'function') await result;
    const t1 = process.hrtime.bigint();
    samplesMs.push(Number(t1 - t0) / 1e6);
  }
  return samplesMs;
}

/**
 * The gate. Returns a verdict object; never throws on a threshold breach (that is a normal result,
 * not an exceptional one) — it throws only if the lane or the manifest could not run at all, which
 * scripts/qe/ux-suite.mjs treats as its own hard failure ("could not measure" is never success).
 */
export async function runCardLaneGate(opts = {}) {
  const budget = loadBudget(opts.budgetPath);
  const samplesMs = await measureFirings({ dir: opts.dir, queries: opts.queries, n: budget.sampleSize, answerFn: opts.answerFn });
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];

  const reasons = [];
  if (p95 > budget.absoluteFailMs || max > budget.absoluteFailMs) {
    reasons.push(`ABSOLUTE FAIL — correctness event, not jitter: max=${max.toFixed(4)}ms p95=${p95.toFixed(4)}ms > absoluteFailMs=${budget.absoluteFailMs}ms (${budget.measuredBaseline?.warmMs != null ? `~${(budget.absoluteFailMs / budget.measuredBaseline.warmMs).toFixed(0)}x the measured ${budget.measuredBaseline.warmMs}ms warm baseline` : 'far above the measured baseline'})`);
  } else if (p95 > budget.p95BudgetMs) {
    reasons.push(`BUDGET BREACH: p95=${p95.toFixed(4)}ms > p95BudgetMs=${budget.p95BudgetMs}ms over ${budget.sampleSize} in-process firings`);
  }

  return {
    pass: reasons.length === 0,
    n: samplesMs.length,
    p50, p95, max,
    budget,
    reasons,
    samplesMs,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
function fmt(ms) { return `${ms.toFixed(4)}ms`; }

async function main() {
  console.log('\n  card-lane decision-lane latency gate (ADR-058 D6 — HARD gate, in-process, model-free)\n');
  let result;
  try {
    result = await runCardLaneGate();
  } catch (e) {
    console.error(`  ✗ could not run the gate: ${e.message}`);
    process.exit(2);
  }
  console.log(`  budget source   kb/card-lane-budget.json`);
  console.log(`  firings         ${result.n} (in-process, no subprocess per firing)`);
  console.log(`  p50             ${fmt(result.p50)}`);
  console.log(`  p95             ${fmt(result.p95)}   (budget ${result.budget.p95BudgetMs}ms)`);
  console.log(`  max             ${fmt(result.max)}   (absolute fail ${result.budget.absoluteFailMs}ms)`);
  console.log('');
  if (result.pass) {
    console.log('  PASS — decision lane inside budget.\n');
    process.exit(0);
  }
  console.log('  FAIL (hard):');
  for (const r of result.reasons) console.log(`    ✗ ${r}`);
  console.log('');
  process.exit(1);
}

// Entry-point guard. Compares REALPATHS on both sides: path.resolve() normalizes a path but does
// NOT follow symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (npm bin
// shims, wrapper scripts, and every os.tmpdir() path on macOS) the two sides disagree, so main()
// never runs -- and because nothing throws, the process exits 0. A silent exit 0 is indistinguishable
// from "ran, found nothing", which is how prepareCorpusCandidate once reported SUCCESS with no
// archive on disk. Reproduced live 2026-07-27; pinned by tests/unit/entrypoint-symlink.test.mjs.
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const invokedDirectly = isDirectInvocation();
if (invokedDirectly) main();
