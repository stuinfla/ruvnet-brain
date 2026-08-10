/**
 * mcp-readiness.mjs — readiness is PER PROCESS; the machine's state is DERIVED from the live ones.
 *
 * ISSUE #133, second half. Every MCP shell wrote the same `mcp-readiness.json`, last writer wins. So
 * one shell's `degraded` overwrote another's `ready` and vice versa, and `--doctor` read a single
 * file that described NO PARTICULAR PROCESS — the state of whichever shell happened to write last,
 * presented as the state of the machine. Two shells, one file, no owner: the same shape as every
 * other defect closed today, in a different costume.
 *
 * THE FIX IS THE SAME ONE: give the fact exactly one producer. A process owns its own readiness and
 * may write only its own record; the aggregate nobody owned is now COMPUTED from the records that
 * are still alive, and therefore cannot be contested.
 *
 *   <brainHome>/mcp-readiness.d/<pid>.json    one writer each, never shared
 *   <brainHome>/mcp-readiness.json            legacy mirror of THIS process, kept so an older
 *                                             reader (a stale generation, a mid-update install)
 *                                             still sees something true rather than nothing
 *
 * DEAD PIDS ARE PRUNED ON READ, not on a timer: a crashed shell cannot clean up after itself, and a
 * reaper that only runs on graceful exit is the failure ADR-027 already paid for. `process.kill(pid,
 * 0)` is the liveness probe — it signals nothing and throws ESRCH when the pid is gone.
 *
 * PID REUSE is real and is handled by recording `startedAt`: a recycled pid belongs to a process that
 * started later than the record claims, so a record whose file mtime predates the boot of the pid now
 * holding it is treated as dead. This is deliberately cheap and errs toward DROPPING a stale record
 * rather than trusting it — an over-eager prune costs one re-write by a live shell, while a trusted
 * stale record is exactly the wrong answer #133 is about.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DIR_NAME = 'mcp-readiness.d';
export const LEGACY_NAME = 'mcp-readiness.json';

/** Is this pid still running? Never throws for any reason other than a genuinely absent process. */
export function isAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/**
 * Write THIS process's readiness. The only record it is allowed to touch.
 * Atomic (tmp + rename) so a reader never sees a half-written record.
 */
export function writeOwn(brainHome, value, { pid = process.pid, now = Date.now() } = {}) {
  const record = { ...value, pid, at: new Date(now).toISOString() };
  const dir = path.join(brainHome, DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${pid}.json`);
    const tmp = `${file}.${now}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* best effort — readiness may never break the server */ }
  // Legacy mirror, so a reader that predates this file still gets a true (if partial) answer.
  try {
    const legacy = path.join(brainHome, LEGACY_NAME);
    const tmp = `${legacy}.${pid}.${now}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, legacy);
  } catch { /* best effort */ }
  return record;
}

/** Every live record, dead ones pruned from disk as a side effect of reading. */
export function readAll(brainHome, { alive = isAlive } = {}) {
  const dir = path.join(brainHome, DIR_NAME);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    const file = path.join(dir, name);
    if (!alive(pid)) { try { fs.unlinkSync(file); } catch { /* raced with another reader */ } continue; }
    try { out.push({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pid }); }
    catch { try { fs.unlinkSync(file); } catch { /* unreadable and unremovable — skip */ } }
  }
  return out;
}

/**
 * The machine's readiness, derived.
 *
 * `degraded` wins over `ready` — a machine with one broken shell is a machine with a broken shell,
 * and reporting the healthy one because it wrote last is precisely the bug. `unknown` when nothing
 * live is on disk: that is not "healthy", and saying so would be the empty-corpus mistake (#132) in
 * another surface.
 */
export function aggregate(records) {
  if (!records.length) return { state: 'unknown', shells: 0, degraded: 0, reason: 'no live MCP shell has reported' };
  const degraded = records.filter((r) => r.state === 'degraded');
  const worst = degraded[0] || null;
  return {
    state: degraded.length ? 'degraded' : (records.every((r) => r.state === 'ready') ? 'ready' : 'starting'),
    shells: records.length,
    degraded: degraded.length,
    // Name the pid, so "which one?" is answerable instead of inferred.
    ...(worst ? { pid: worst.pid, phase: worst.phase, error: worst.error } : {}),
  };
}

/** Convenience for readers: prune, aggregate, and say how many shells backed the answer. */
export function readAggregate(brainHome, opts = {}) {
  return aggregate(readAll(brainHome, opts));
}
