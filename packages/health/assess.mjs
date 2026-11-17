// The one health verdict every reader prints: the prompt hook, `ruvnet-brain doctor`, `status` and
// the owner page all call assess() and nothing else. The contract's verdict() is the kernel; this
// adds only what the contract is silent on, in one ordered pass over each live server's evidence:
//   1. "ok" needs a probe that really ran: a passed self-test with no probe results, or one older
//      than two probe intervals plus a minute, is UNKNOWN (a probe that did not run is never OK);
//   2. every non-ok state names one cause and the one command that fixes that cause;
//   3. with several servers the worst state wins, never the newest writer.
import { verdict } from '../contract/verdict.mjs';
import { readEvidence } from './status.mjs';

const RANK = { ok: 0, degraded: 1, unknown: 2, down: 3 };
export const FIX = {
  heartbeat: 'restart the session',
  pending: 'wait one minute',
  'no-probes': 'ruvnet-brain install --repair',
  overdue: 'restart the session',
  incomplete: 'restart the session',
  // A server on a generation that is neither installed nor kept: a new session starts on the installed one.
  generation: 'restart the session',
  'probe-failed': 'ruvnet-brain install --repair',
  lane: 'ruvnet-brain install --repair',
  'safe-mode': 'restart the session',
  // The previous version is answering; retrying would offer the same release again, so the one
  // useful command is the one that shows what failed. The notice ends by itself after a day.
  'rolled-back': 'ruvnet-brain doctor',
  // A host was registered but its server entry was refused (another program holds the name), so that
  // host searches through something else: never OK. The reason names the host and the file; doctor
  // prints it whole (a re-registration needs the release source, which a folder install does not keep).
  'host-unserved': 'ruvnet-brain doctor',
};

const ago = (ms) => (ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

/** The evidence field that decides one live server's state, in the contract's own check order. */
export function causeOf(s, ev) {
  const now = ev.now ?? Date.now();
  if (!s.heartbeatAt || now - s.heartbeatAt > ev.staleAfterMs) return 'heartbeat';
  if (!s.probe) return 'pending';
  if (!s.probe.ok) return 'probe-failed';
  if (!Array.isArray(s.probe.results) || !s.probe.results.length) return 'no-probes';
  if (!probeComplete(s.probe, now)) return 'incomplete';
  if (now - s.probe.at > overdueAfter(ev)) return 'overdue';
  if (ev.pointer && !onKeptGeneration(s, ev.pointer)) return 'generation';
  if ((s.lanes || []).some((l) => !l.available)) return 'lane';
  if (s.lastSearch && !s.lastSearch.ok) return 'safe-mode';
  return null;
}

export const overdueAfter = (ev) => 2 * ev.probeIntervalMs + 60_000;

/**
 * A server answers from the installed generation or the one kept before it: an idle session goes on
 * serving the previous one (kept on disk) until its next search or probe moves it, and its self-test
 * evidence is for that generation. Any other generation is not what this machine has installed.
 */
const onKeptGeneration = (s, ptr) => [ptr, ptr.previous].some((g) => g && s.app === g.app && s.pack === g.pack);

/** A passed self-test record that proves a run (review F14): a real time, not in the future, and
 *  every result a probe that named its file and passed. `{ ok: true, results: [{}] }` is not one. */
export const probeComplete = (p, now) => Number.isFinite(p.at) && p.at > 0 && p.at <= now + 60_000
  && p.results.every((r) => r && r.pass === true && typeof r.expect === 'string' && r.expect.length > 0);

function server(s, ev) {
  const cause = causeOf(s, ev);
  if (cause === 'no-probes') return { state: 'unknown', label: 'UNKNOWN', since: s.probe.at, reason: 'the self-test ran no probes', fix: FIX[cause], cause };
  if (cause === 'incomplete') return { state: 'unknown', label: 'UNKNOWN', since: null, reason: 'the self-test record is incomplete (no valid time, or a result that did not pass)', fix: FIX[cause], cause };
  if (cause === 'generation') {
    return { state: 'unknown', label: 'UNKNOWN', since: s.probe.at, reason: `the server is on app ${s.app} pack ${s.pack}, neither the installed app ${ev.pointer.app} nor the one kept before it`, fix: FIX[cause], cause };
  }
  if (cause === 'overdue') {
    return { state: 'unknown', label: 'UNKNOWN', since: s.probe.at, reason: `the self-test has not run for ${ago(ev.now - s.probe.at)}`, fix: FIX[cause], cause };
  }
  const v = verdict({ now: ev.now, installed: true, servers: [s], staleAfterMs: ev.staleAfterMs });
  return v.state === 'ok' ? { ...v, cause } : { ...v, fix: FIX[cause] ?? v.fix, cause };
}

/** The verdict from evidence (see readEvidence). Pure: reads nothing, writes nothing. */
export function assess(evidence) {
  const ev = { probeIntervalMs: 30 * 60_000, ...evidence, now: evidence.now ?? Date.now() };
  const live = (ev.servers || []).filter((s) => s.alive);
  if (!ev.installed) return { ...verdict(ev), cause: 'not-installed' };
  if (!live.length) return { ...verdict(ev), cause: 'not-running' };
  let worst = null;
  for (const s of live) {
    const v = server(s, ev);
    if (!worst || RANK[v.state] > RANK[worst.state]) worst = v;
  }
  if (worst.state !== 'ok') return worst;
  // Every live server is ok by every rule above, so the contract's whole-evidence verdict is either
  // that same ok or its rollback notice.
  const v = verdict(ev);
  if (v.state !== 'ok') return { ...v, fix: FIX['rolled-back'], cause: 'rolled-back' };
  const off = (ev.unserved ?? []).filter((u) => u?.host);
  if (off.length) {
    const why = `${off.map((u) => u.host).join(' and ')} not served by version 5 (${off[0].why ?? 'its server entry was refused'}${off[0].file ? ` in ${off[0].file}` : ''})`;
    return { state: 'degraded', label: 'DEGRADED', since: null, reason: why, fix: FIX['host-unserved'], cause: 'host-unserved' };
  }
  return { ...v, cause: null };
}

export const assessHome = (home, { now } = {}) => assess(readEvidence(home, { now }));
