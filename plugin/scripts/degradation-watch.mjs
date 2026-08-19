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

/**
 * THE PROBE TARGET IS A SCRATCH DB, NOT THE PROJECT'S.
 *
 * This was `process.cwd()/.swarm/memory.db`. The hook runs MACHINE-WIDE, so in any repo that is not
 * ruvnet-brain it ran `ruflo memory store --path <that repo>/.swarm/memory.db` — CREATING a .swarm
 * directory and writing a probe row into somebody else's project. An independent audit named it
 * "unrelated-project mutation", and it is the plainest possible violation of this project's own rule
 * (ADR-058 D5: never touch what we do not own). Shipped by me, today, in the hook whose entire
 * purpose is to stop silent damage.
 *
 * The fix is not tighter scoping — it is noticing the question was mis-framed. "Does `ruflo memory
 * store` durably persist?" is a property of the SQLite DRIVER and its ABI against the running node.
 * That is machine-wide. It has nothing to do with which repo you happen to be standing in, so a
 * scratch database answers it exactly as well, mutates nothing, and additionally covers the case an
 * audit flagged separately: with a real project path, an ABSENT store had to be skipped, which made
 * the store-CREATING first write the one write the guard could never falsify. A scratch path is
 * always absent and always created — the first-write case is now the ONLY case.
 */
const defaultDb = () => path.join(os.tmpdir(), `ruvnet-durability-probe-${process.pid}.db`);

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * THE ONLY ACCEPTABLE PROOF OF A WRITE: store, then RETRIEVE that exact key through the managed
 * interface and read the value back. Explicitly NOT evidence, each having been believed once: the
 * `[OK]` success line, a semantic-search hit, the .db mtime, the daemon being up, or which driver is
 * loaded. And explicitly NOT permitted, per issue #140: opening the managed store with `sqlite3`.
 */
export function proveMemoryDurable(dbPath = defaultDb(), { run = defaultRun } = {}) {
  // AN ABSENT STORE IS NOT AN EXEMPTION. This returned `{ok:true, skipped:true}` when the file did
  // not exist, which — as an independent audit put it — means "the first `ruflo memory store`, the
  // operation that CREATES the store, is precisely the write the guard cannot falsify." That is a
  // hole shaped exactly like the moment durability matters most: a fresh machine, first write, and
  // the sql.js fallback silently swallowing it. `ruflo memory store` creates the file, so probing an
  // absent path is a valid question with a real answer; only a path we cannot even attempt is a skip.
  const key = `durability-probe-${process.pid}-${Date.now()}`;
  try {
    // THE PROOF IS THE RETRIEVED VALUE, NOT A SQL ROWCOUNT (issue #140, @sparkling).
    //
    // This read the row back with `sqlite3`, which opens a Ruflo-MANAGED store directly — the exact
    // boundary violation ADR-063 and `hijack-ruvnet` exist to stop, committed by the hook that
    // guards durability. The justification was real at the time: a write could report success and
    // persist nothing. But rUv closed that upstream in v3.32.34 ("No manual SQL is required"; the
    // bridge now FAILS CLOSED and reports the native error instead of a misleading fallback), and
    // the 2026-08-13 incident confirms retrieve was always sufficient — it answered `Key not found`
    // on precisely the writes that had evaporated. Verified on ruflo 3.38.12 before this change:
    // the round-trip returns the stored VALUE, and a damaged store answers `[ERROR] no such table`
    // rather than a false success.
    const probeValue = `probe-${key}`;
    run('ruflo', ['memory', 'store', '--path', dbPath, '-n', 'default', '-k', key, '--value', probeValue]);
    const back = run('ruflo', ['memory', 'retrieve', '--path', dbPath, '-n', 'default', '-k', key]);
    if (!String(back).includes(probeValue)) {
      return { ok: false, why: 'stored a key and retrieving it did not return the value — the store reports a success it cannot honour' };
    }
    return { ok: true, why: 'store → retrieve round-trip returned the exact value through the managed interface' };
  } catch (e) {
    // "CANNOT PROBE" IS NOT "PROBED AND FAILED", and collapsing them shipped the worst
    // stranger-facing bug in this repo. Measured with PATH=/usr/bin:/bin — i.e. most machines that
    // install this plugin but not ruflo — EVERY `git push`, `npm publish` and `gh release create`
    // was refused, with instructions to `npm rebuild better-sqlite3` in a package the user never
    // installed. Same for a missing `sqlite3`, which is normal on Linux and Windows.
    //
    // The rule was already written, one file away, in identifier-preflight.mjs's header: "FAIL OPEN.
    // An identifier this cannot resolve is ALLOWED, silently... a fabricated diagnosis is worse than
    // no check, because it burns the credibility the channel runs on." That header even cites THIS
    // file as the sibling whose bug taught the rule. The rule was recorded and not applied to the
    // file it was learned from — the same shape as freshness machinery pointed at coverage but not
    // the eval, and resolveBash existing but unused at a new call site.
    //
    // A missing binary means this machine cannot answer the question. It does not mean the answer
    // is "broken".
    const msg = String(e?.message ?? e);
    if (/ENOENT|not found|spawnSync .* ENOENT/i.test(msg)) {
      return { ok: true, why: `cannot probe on this machine (${msg.split('\n')[0]}) — declining to guess`, skipped: true };
    }
    return { ok: false, why: `probe could not complete: ${msg.split('\n')[0]}` };
  } finally {
    // The scratch db is ours alone; remove it and its WAL siblings rather than leaving litter in tmp.
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* never existed, or already gone */ }
    }
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
  // `cat lesson-bridge.mjs` used to match `record-lesson`, so READING the file needed to fix a
  // degradation was refused while degraded. The verb has to be in the pattern, not just the noun.
  { event: 'record-lesson', match: /\bruflo\s+memory\s+store\b|lesson-bridge\.mjs\s+--apply/ },
  // `git -C <path> push` and `git --git-dir=… push` are the forms an agent with absolute paths
  // actually writes — this environment's own instructions mandate them — and the first version
  // matched neither. Two independent audits caught that the same day, and both also caught the
  // inverse: `grep -n "npm publish" docs/…` matched, so reading ABOUT shipping counted as shipping.
  { event: 'ship', match: /\bgit\b[^|;&]*\bpush\b|\b(?:npm|yarn|pnpm)\s+publish\b|\bgh\s+release\s+create\b|release\.mjs/ },
];

/**
 * QUOTED TEXT IS AN ARGUMENT, NOT A COMMAND. The same correction identifier-preflight.mjs needed
 * hours earlier: the truth-maker is what will EXECUTE, and a prompt, a grep pattern or a commit
 * message is not that. Without it, `git commit -m "ready to git push"` reads as shipping.
 */
const executablePart = (cmd) => String(cmd || '').replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');

export function dependentEvent(command, table = DEPENDENT_COMMANDS) {
  const cmd = executablePart(command);
  return table.find((c) => c.match.test(cmd))?.event ?? null;
}

/**
 * THE CACHE IS GONE, AND ITS REMOVAL IS THE FIX.
 *
 * It was keyed `/tmp/ruvnet-degradation-$USER.json` while the probe targets a PER-PROJECT path. Two
 * independent adversarial audits, blind to each other, each found a different bug in it on the same
 * day — which is the strongest signal available that the cache, not its key, was the defect:
 *
 *   · a DEGRADED project cached ok:false, so `git push` in a HEALTHY project was refused for five
 *     minutes citing another repo's evidence;
 *   · a HEALTHY project cached ok:true, so a BROKEN project shipped inside the TTL without ever
 *     being probed — the direction that actually costs data.
 *
 * The probe runs only on `git push`, `npm publish` and `ruflo memory store`: rare, deliberate acts
 * where one or two seconds is invisible and a wrong answer is expensive. Caching bought latency
 * nobody was asking for and sold correctness to pay for it. A cache whose key is not the thing that
 * determines the answer is a restated fact, which is the defect this whole file exists to close.
 */
export function cachedDegradations(opts = {}) {
  return activeDegradations(SIGNATURES, opts);
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
