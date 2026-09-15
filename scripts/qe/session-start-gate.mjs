#!/usr/bin/env node
// session-start-gate.mjs — ADR-058 D6's SECOND hard gate: session-start WALL TIME, the first
// user-felt number in this repo that a build can fail on.
//
// WHY THIS EXISTS (the deduction, quoted): an independent grader scored D6 68 and wrote — "the hard
// gate measures a 0.03–0.22ms in-process function against a 250ms budget (~1000x headroom — it can
// only catch catastrophic regression classes, by design per its header). Everything the user
// actually FEELS — heavy-lane query seconds, session-start wall time, install minutes, dead air,
// refusal clarity — is advisory or unmeasured", and "the gate has trivially never failed in earnest
// (thresholds set at 1000x measured cost)". Their own cheapest fix was named: promote ONE user-felt
// number to a hard gate, and give it a budget row in the same governed manifest. This is that.
//
// WHAT MAKES IT USER-FELT: this is the wall time of the hook a stranger's Claude Code fires at
// SessionStart, BEFORE their first prompt is answered. Nobody experiences kb/card-lane.mjs's
// 0.1158ms. Everybody experiences this.
//
// NOTHING HERE HAND-ROLLS A SECOND TIMER. scripts/selfcheck.mjs ALREADY fires the literal registered
// command through an external process-group watchdog and already returns elapsedMs per firing, and
// already enforces the declared timeout with TIMEOUT_MARGIN. Writing a private timer beside it would
// recreate the adjacent-door defect (ADR-055 F16: a gate and its evidence as two different code
// paths). So this file is a THRESHOLD POLICY over selfcheck's existing measurement — fireHook(),
// resolveInstalledSurface() and readInstalledRegistrations() are imported, not reproduced.
//
// MEASUREMENT METHOD, DELIBERATE — and the OPPOSITE of the card lane's, for a stated reason:
// card-lane-gate.mjs measures IN-PROCESS because the thing it measures is an in-process function and
// a subprocess per firing would measure the OS scheduler instead. Here the thing measured IS a
// subprocess (node → hook-shim → bash → session-start.sh), so subprocess-per-firing is not a
// concession, it is the only honest method. The four consequences that follow are handled explicitly
// rather than assumed away, and are restated in kb/card-lane-budget.json's `measurementMethod`:
//   1. SURFACE — resolveInstalledSurface() prefers a machine's INSTALLED plugin cache over the
//      checkout. On a developer's machine that cache is usually an older release, so a gate that
//      took the default would grade code that is not in this commit. We therefore hand it a fresh
//      EMPTY home, which leaves the checkout as the only candidate. (Verified live 2026-07-28: with
//      the real homedir it selected `installed:` and measured a build 12 versions old.)
//   2. HOME — a fresh temp dir per run. The hook writes once-per-machine marker files; pointing it
//      at the developer's real HOME would both perturb the measurement and silently consume their
//      real first-run offers.
//   3. COLD + STEADY — ONE cold fire before the steady-state window. The first-ever fire in a virgin
//      HOME emits once-per-machine offers, but it is still a real user wait: it must finish inside
//      both absoluteFailMs and the hook's declared timeout. The following samples measure the common
//      steady state without allowing a failed cold start to disappear into a percentile.
//   4. SEQUENTIAL — never concurrent. Concurrency would measure the runner's core count.
//
// THE THRESHOLDS ARE NOT HARDCODED HERE. They live in kb/card-lane-budget.json under `sessionStart`,
// which docs/adr/0058-the-95-contract.md `governs:` — so a silent raise shows up as governed-set
// drift under `node scripts/doc-currency.mjs --check` rather than being a free edit. And they are
// set from a measured distribution (n=110, p50 148ms, worst p95 323ms, max 440ms), not from a round
// number: p95 budget 1000ms is ~3.1x the worst measured p95, sized for a 2-vCPU CI runner. A budget
// at 1000x measured cost is the exact criticism above; it is not repeated here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireHook, resolveInstalledSurface, readInstalledRegistrations } from '../selfcheck.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const BUDGET_PATH = path.join(REPO_ROOT, 'kb', 'card-lane-budget.json');

/** Read the `sessionStart` block. Same validation shape as card-lane-gate.mjs's loadBudget(). */
export function loadBudget(budgetPath = BUDGET_PATH) {
  const doc = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
  const budget = doc.sessionStart;
  if (!budget || typeof budget !== 'object') {
    throw new Error(`card-lane-budget.json: no "sessionStart" block — this gate has no checked-in budget to enforce`);
  }
  for (const key of ['sampleSize', 'p95BudgetMs', 'absoluteFailMs']) {
    if (typeof budget[key] !== 'number' || !(budget[key] > 0)) {
      throw new Error(`card-lane-budget.json sessionStart: "${key}" must be a positive number, got ${JSON.stringify(budget[key])}`);
    }
  }
  return budget;
}

/** Nearest-rank percentile over an ASCENDING-sorted array. p in [0,100]. */
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/**
 * Resolve the SessionStart registration to fire, from the CHECKOUT's plugin tree.
 * `home` is a fresh empty dir on purpose (see note 1 in the header) — it is what forces
 * resolveInstalledSurface() to pick `source: 'checkout'` instead of a stale installed cache.
 */
export function resolveSessionStart({ repo = REPO_ROOT, home = null } = {}) {
  const emptyHome = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ssgate-resolve-'));
  const surface = resolveInstalledSurface({ home: emptyHome, repo });
  if (!surface.ok) throw new Error(`could not resolve a plugin surface to measure: ${surface.reason}`);
  const reg = readInstalledRegistrations(surface.hooksFile).find((r) => r.event === 'SessionStart');
  if (!reg) throw new Error(`no SessionStart registration in ${surface.hooksFile} — there is nothing to measure`);
  return { surface, reg, command: reg.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', surface.root) };
}

/**
 * Fire the SessionStart hook `n` times through selfcheck's watchdog and return each firing's wall
 * time in ms, plus the warm-up's own numbers (reported, never gated — it is a different regime).
 *
 * `fireFn` defaults to the real fireHook and exists as an injectable seam ONLY so
 * tests/unit/session-start-gate.test.mjs can prove the THRESHOLD LOGIC catches a slow hook without
 * mutating the shipped plugin to do it. The shipped hook's own mutant is exercised separately, for
 * real, against the real path — the same split card-lane-gate.mjs uses and for the same reason.
 */
export async function measureFirings({ n = 30, repo = REPO_ROOT, fireFn = fireHook, resolved = null } = {}) {
  const r = resolved ?? resolveSessionStart({ repo });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssgate-home-'));
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const stateDir = path.join(home, '.config', 'ruvnet-brain');
  // HOME alone is not isolation on Windows: os.homedir() follows USERPROFILE there, while Git Bash
  // follows HOME. The old gate therefore let hook-shim.mjs read the runner's real spine while the
  // shell body wrote to the fixture home. Keep every authority on one root, exactly as the shipped
  // Windows installer/host tests do.
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    RUVNET_BRAIN_HOME: brainHome,
    RUVNET_BRAIN_STATE_DIR: stateDir,
    RUVNET_SESSION_TRACE: '1',
    CLAUDE_PLUGIN_ROOT: r.surface.root,
  };
  const timeoutSec = typeof r.reg.timeout === 'number' ? r.reg.timeout : 5;
  const fire = () => fireFn({ command: r.command, event: 'SessionStart', regime: 'valid', timeoutSec, cwd: os.tmpdir(), env });

  const warmup = await fire(); // separate regime, but its declared-timeout result is still gated
  const samplesMs = [];
  for (let i = 0; i < n; i++) {
    const m = await fire();
    // A firing the watchdog had to kill has no meaningful elapsedMs to average — it is a hang, and a
    // hang must never be smoothed into a percentile. Charge it as the full timeout so it can only
    // ever make the verdict worse, and name it in the verdict below.
    samplesMs.push(m.timedOut ? timeoutSec * 1000 : m.elapsedMs);
  }
  return {
    samplesMs,
    warmupMs: warmup.elapsedMs,
    warmupStdoutBytes: warmup.stdoutBytes,
    warmupTimedOut: Boolean(warmup.timedOut),
    warmupStatus: warmup.status,
    warmupStderr: String(warmup.stderr || '').slice(-1000),
    timeoutSec,
    surface: r.surface,
    home,
  };
}

/**
 * The gate. Returns a verdict object; never throws on a threshold breach (that is a normal result,
 * not an exceptional one) — it throws only if the hook or the manifest could not be resolved at all,
 * which scripts/qe/ux-suite.mjs treats as its own hard failure ("could not measure" is never success).
 */
export async function runSessionStartGate(opts = {}) {
  const budget = loadBudget(opts.budgetPath);
  const {
    samplesMs, warmupMs, warmupStdoutBytes, warmupTimedOut, warmupStatus, warmupStderr,
    timeoutSec, surface,
  } = await measureFirings({
    n: budget.sampleSize, repo: opts.repo, fireFn: opts.fireFn, resolved: opts.resolved,
  });
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];

  const reasons = [];
  if (warmupTimedOut) {
    reasons.push(`COLD-START FAIL — the first SessionStart fire exceeded its declared ${timeoutSec}s timeout (${warmupMs.toFixed(0)}ms); first-run latency is user-felt and may not be hidden as an untimed warm-up`);
  }
  if (warmupMs > budget.absoluteFailMs) {
    reasons.push(`COLD-START ABSOLUTE FAIL — the first SessionStart fire took ${warmupMs.toFixed(0)}ms > absoluteFailMs=${budget.absoluteFailMs}ms, even though the command timeout is ${timeoutSec}s; first-run latency may not bypass the absolute limit as an untimed warm-up`);
  }
  if (p95 > budget.absoluteFailMs || max > budget.absoluteFailMs) {
    reasons.push(`ABSOLUTE FAIL — the hook has no margin left inside its own declared ${timeoutSec}s timeout: max=${max.toFixed(0)}ms p95=${p95.toFixed(0)}ms > absoluteFailMs=${budget.absoluteFailMs}ms (= TIMEOUT_MARGIN 0.8 x ${timeoutSec}s, the same wall scripts/selfcheck.mjs already enforces on a stranger's machine)`);
  } else if (p95 > budget.p95BudgetMs) {
    reasons.push(`BUDGET BREACH: p95=${p95.toFixed(0)}ms > p95BudgetMs=${budget.p95BudgetMs}ms over ${budget.sampleSize} real firings of the registered SessionStart command (measured baseline p95 ${budget.measuredBaseline?.worstRunP95Ms ?? '?'}ms)`);
  }

  return {
    pass: reasons.length === 0,
    n: samplesMs.length,
    p50,
    p95,
    max,
    warmupMs,
    warmupStdoutBytes,
    warmupTimedOut,
    warmupStatus,
    warmupStderr,
    timeoutSec,
    surface,
    budget,
    reasons,
    samplesMs,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
function fmt(ms) { return `${ms.toFixed(0)}ms`; }

async function main() {
  console.log('\n  session-start wall-time gate (ADR-058 D6 — HARD gate, real registered command, user-felt)\n');
  let result;
  try {
    result = await runSessionStartGate();
  } catch (e) {
    console.error(`  ✗ could not run the gate: ${e.message}`);
    process.exit(2);
  }
  console.log(`  budget source   kb/card-lane-budget.json → sessionStart`);
  console.log(`  surface         ${result.surface.source} (${result.surface.root})`);
  console.log(`  firings         1 cold + ${result.n} steady-state, sequential, fresh isolated HOME`);
  console.log(`  cold first fire ${fmt(result.warmupMs)} / ${result.warmupStdoutBytes} bytes  (${result.warmupTimedOut ? 'TIMED OUT — HARD FAIL' : 'inside declared timeout'})`);
  console.log(`  p50             ${fmt(result.p50)}`);
  console.log(`  p95             ${fmt(result.p95)}   (budget ${result.budget.p95BudgetMs}ms)`);
  console.log(`  max             ${fmt(result.max)}   (absolute fail ${result.budget.absoluteFailMs}ms = 0.8 x the ${result.timeoutSec}s declared timeout)`);
  console.log('');
  if (result.pass) {
    console.log('  PASS — session start inside budget.\n');
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
