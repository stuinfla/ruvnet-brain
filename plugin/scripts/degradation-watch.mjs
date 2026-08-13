/**
 * degradation-watch.mjs — a printed warning is not a control. This turns one into a REFUSAL.
 *
 * THE FAILURE, 2026-08-13. `ruflo memory store` printed, on every write, for three days:
 *
 *     [WARN] Data stored, but persistence is not guaranteed: sql.js fallback driver in use —
 *            this write may not be durably persisted to disk.
 *
 * Nothing persisted after 2026-08-10 17:38. Every lesson, checkpoint and session-end handoff went
 * into a WASM buffer and evaporated, while the CLI printed `[OK] Data stored successfully`. Root
 * cause, proven: `better_sqlite3.node` was built against NODE_MODULE_VERSION 141 and the running
 * node needs 137, so the native bridge threw ERR_DLOPEN_FAILED and the driver fell back.
 *
 * I READ THAT WARNING AND CONTINUED. That is the defect, and it is not an information problem —
 * the answer was ALSO in capability-cards.md, which I had printed to screen twenty minutes earlier:
 * "a native SQLite ABI mismatch is degraded, not healthy: verify and rebuild the active
 * better-sqlite3 bridge rather than treating a sql.js fallback as equivalent." Knowing was never
 * missing. STOPPING was.
 *
 * So the cure cannot be printing it again, louder. This project already disproved that approach:
 * the flywheel hook printed `NOT auto-surfaced: default=38` every session for EIGHT DAYS while six
 * curated lessons never fired. A diagnostic nobody reads is the same as no diagnostic, and I am the
 * "nobody" in both sentences.
 *
 * WHAT GROUNDING CHANGED HERE (search_ruvnet, receipt ede43691e2d5, against
 * v3/@claude-flow/cli/src/commands/memory.ts). My first draft detected the DRIVER — "is it sql.js?"
 * The real source says `// Use direct sql.js storage with automatic embedding generation`: sql.js is
 * a legitimate path in ruflo, not a fault signal. A driver-identity check would have cried wolf on
 * healthy installs, and a channel that cries wolf gets skimmed, which is the disease this file
 * exists to cure. So the PROVER is the authority and it tests the only thing that actually matters:
 * did the row survive to disk. Signatures are hints that trigger a probe, never the verdict.
 *
 * THREE PROPERTIES, all required or this is theatre:
 *   1. DETECTION MUST NOT DEPEND ON ME NOTICING — the prover exercises the real path, because the
 *      success line lied: `[OK]` printed over rowcount 0.
 *   2. THE VERDICT MUST REFUSE, NOT INFORM — an operation whose truth depends on durable storage
 *      cannot proceed while storage is not durable. "We learned X" is FALSE if X did not persist.
 *   3. IT MUST FAIL ON THE BROKEN SHAPE — proven by mutation in the test, because "a guard that
 *      cannot fail" is the other bug I shipped today.
 *
 * WHY NOT "ALWAYS CONSULT MEMORY FIRST": measured the same day — when I graded the architecture from
 * file counts, the facts I needed sat in FOUR reachable places and I read none. A fifth advisory
 * surface cannot fix a failure caused by skipping four. Retrieval cures ignorance; only
 * interception cures confidence.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Required by the isMain guard below. Its try/catch would otherwise swallow the ReferenceError and
// return false, so the policy entrypoint would silently never run — a guard that cannot fire, which
// is the exact defect class this file exists to close. Caught by counting occurrences, not by
// reading the code and believing it.
import { fileURLToPath } from 'node:url';

const defaultDb = () => path.join(process.env.RUVNET_BRAIN_PROJECT_DIR || process.cwd(), '.swarm', 'memory.db');

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * THE ONLY ACCEPTABLE PROOF OF A WRITE: store, then confirm the exact row through SQL on the same
 * path. Explicitly NOT evidence, each having been believed once: the `[OK]` success line, a
 * semantic-search hit, the .db mtime, the daemon being up, or which driver is loaded.
 */
export function proveMemoryDurable(dbPath = defaultDb(), { run = defaultRun } = {}) {
  if (!fs.existsSync(dbPath)) return { ok: true, why: `no store at ${dbPath} — nothing claims to persist`, skipped: true };
  const key = `durability-probe-${process.pid}-${Date.now()}`;
  try {
    run('ruflo', ['memory', 'store', '--path', dbPath, '-n', 'default', '-k', key, '--value', 'probe']);
    const rows = run('sqlite3', [dbPath, `SELECT COUNT(*) FROM memory_entries WHERE key='${key}';`]).trim();
    if (rows !== '1') {
      return { ok: false, why: `stored a row, SQL found ${rows} — the store reports a success it cannot honour` };
    }
    try { run('sqlite3', [dbPath, `DELETE FROM memory_entries WHERE key='${key}';`]); } catch { /* probe row is harmless */ }
    return { ok: true, why: 'store → SQL round-trip confirmed the exact row on disk' };
  } catch (e) {
    return { ok: false, why: `probe could not complete: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}

/**
 * A degradation is only worth a channel if something PROVES it. `detect` spots a smell in output a
 * tool already printed and is a HINT ONLY — it decides when to probe, never what is true.
 */
export const SIGNATURES = [
  {
    id: 'memory-not-durable',
    detect: /persistence is not guaranteed|NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|not durably persisted/i,
    what: 'the memory store is not durably persisting writes',
    costs: 'every lesson, checkpoint and handoff is silently lost — the learning loop is severed',
    blocks: ['claim-done', 'ship', 'record-lesson'],
    fix: 'npm rebuild better-sqlite3 in $(npm root -g)/ruflo, then re-run the round-trip probe',
    prove: proveMemoryDurable,
  },
];

/** Spot a known degradation in text a tool printed. A hint that a probe is warranted — not a verdict. */
export function detectIn(text, signatures = SIGNATURES) {
  if (!text) return [];
  return signatures.filter((s) => s.detect.test(text));
}

/**
 * Run every prover and return only the degradations that are REAL RIGHT NOW. A signature its prover
 * clears is not reported, because a warning channel that cries wolf gets skimmed — which is exactly
 * how three days of memory were lost.
 */
export function activeDegradations(signatures = SIGNATURES, opts = {}) {
  const out = [];
  for (const s of signatures) {
    const verdict = s.prove ? s.prove(opts.dbPath, opts) : { ok: false, why: 'no prover — unprovable claims are treated as failures' };
    if (!verdict.ok) out.push({ ...s, verdict });
  }
  return out;
}

/**
 * THE REFUSAL — the property that makes a warning stop being skimmable, because it is no longer
 * text, it is a closed door. Only operations whose truth DEPENDS on durable storage are blocked;
 * blocking everything would make this the next thing routed around.
 */
export function refusalFor(event, degradations) {
  const hit = degradations.find((d) => d.blocks.includes(event));
  if (!hit) return null;
  return {
    allow: false,
    policy: 'degradation-watch',
    reason:
      `BLOCKED — ${hit.what}.\n`
      + `  proof: ${hit.verdict.why}\n`
      + `  cost:  ${hit.costs}\n`
      + `  fix:   ${hit.fix}\n`
      + 'This refuses rather than warns on purpose: the warning WAS printed, on every write, for '
      + 'three days, and read. Repair the store, then repeat the action.',
  };
}

/**
 * WHICH COMMANDS DEPEND ON DURABLE MEMORY. The probe shells out to ruflo + sqlite3, so running it on
 * every Bash call would add seconds to every command and become the next thing someone disables.
 * It fires only where a false success actually costs something: recording a lesson into a store that
 * drops it, or shipping while claiming the project learned something it did not.
 */
export const DEPENDENT_COMMANDS = [
  { event: 'record-lesson', match: /\bruflo\s+memory\s+store\b|lesson-bridge|memory_store/ },
  { event: 'ship', match: /\bgit\s+push\b|npm\s+publish|release\.mjs/ },
];

export function dependentEvent(command, table = DEPENDENT_COMMANDS) {
  return table.find((c) => c.match.test(String(command || '')))?.event ?? null;
}

/** Cache briefly so a gate consulted many times in one turn does not re-probe on each call. */
const CACHE = path.join(os.tmpdir(), `ruvnet-degradation-${process.env.USER || 'u'}.json`);
const TTL_MS = 5 * 60_000;

export function cachedDegradations(opts = {}) {
  if (!opts.noCache) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      if (Date.now() - c.at < TTL_MS) {
        return c.ids.map((id) => ({ ...SIGNATURES.find((s) => s.id === id), verdict: c.why[id] })).filter((d) => d.id);
      }
    } catch { /* a cold cache is not an error */ }
  }
  const live = activeDegradations(SIGNATURES, opts);
  try {
    fs.writeFileSync(CACHE, JSON.stringify({
      at: Date.now(),
      ids: live.map((d) => d.id),
      why: Object.fromEntries(live.map((d) => [d.id, d.verdict])),
    }));
  } catch { /* the cache is an optimisation, never a correctness requirement */ }
  return live;
}

/**
 * POLICY ENTRYPOINT — spawned by decision-gate.mjs exactly like the other refusers: payload on
 * stdin, exit 0 to allow, exit 2 to refuse with the reason on stderr. Deliberately NOT a new hook
 * mechanism; the invariant this repo already paid for is that ONE process refuses a given tool call.
 */
const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch { /* no stdin is not a refusal */ }
  let input = {};
  try { input = JSON.parse(payload)?.tool_input ?? {}; } catch { /* malformed payload degrades to allow */ }
  const event = dependentEvent(input.command);
  // The overwhelmingly common case: this command does not depend on durable memory. Cost ~0ms.
  if (!event) process.exit(0);
  const refusal = refusalFor(event, cachedDegradations());
  if (!refusal) process.exit(0);
  process.stderr.write(`⛔ ${refusal.reason}\n`);
  process.exit(2);
}
