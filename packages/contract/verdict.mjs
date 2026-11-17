// The one health verdict (architecture section 3). Every reader (prompt hook, doctor, installer,
// updater, release rail) calls this function and nothing else may produce these states.
//
// evidence = { now, installed, servers: [status file + { alive }], update: state/update.json | null }
import { DEFAULTS } from './constants.mjs';

const RANK = { ok: 0, degraded: 1, unknown: 2, down: 3 };
const LABEL = { ok: 'OK', degraded: 'DEGRADED', down: 'DOWN', unknown: 'UNKNOWN', 'not-installed': 'NOT INSTALLED' };
const DOCTOR = 'ruvnet-brain doctor';

const make = (state, since, reason, fix, extra = {}) => ({ state, label: LABEL[state], since: since ?? null, reason, fix, ...extra });

function one(s, now, staleAfterMs) {
  if (!s.heartbeatAt || now - s.heartbeatAt > staleAfterMs) {
    return make('unknown', s.heartbeatAt, 'the search server stopped reporting (stale heartbeat)', DOCTOR);
  }
  if (!s.probe) return make('unknown', s.startedAt, 'the self-test has not finished yet', DOCTOR);
  if (!s.probe.ok) {
    const why = s.probe.error ? `pack failed its self-test (${s.probe.error})` : 'pack failed its self-test';
    return make('down', s.probe.failingSince ?? s.probe.at, why, 'ruvnet-brain install --repair');
  }
  // OK needs a completed run: a real time and every result passed (review F14).
  const r = s.probe.results;
  if (!Number.isFinite(s.probe.at) || !Array.isArray(r) || !r.length || r.some((x) => x?.pass !== true)) {
    return make('unknown', s.startedAt, 'the self-test record does not show a completed run', DOCTOR);
  }
  const off = (s.lanes || []).filter((l) => !l.available);
  if (off.length) return make('degraded', s.probe.at, `lane ${off.map((l) => l.name).join(', ')} unavailable`, DOCTOR);
  if (s.lastSearch && !s.lastSearch.ok) {
    return make('degraded', s.lastSearch.at, `last search used keyword-only safe mode (${s.lastSearch.reason})`, DOCTOR);
  }
  return make('ok', s.probe.at, `knowledge of ${s.knowledgeDate}`, null, { knowledgeDate: s.knowledgeDate });
}

export function verdict(evidence) {
  const now = evidence.now ?? Date.now();
  const staleAfterMs = evidence.staleAfterMs ?? DEFAULTS.staleAfterMs;
  if (!evidence.installed) return make('not-installed', null, 'RuvNet Brain 5 is not installed', 'ruvnet-brain install');
  const live = (evidence.servers || []).filter((s) => s.alive);
  if (!live.length) {
    return make('down', null, 'the search server did not start in this session', "run 'node -v'; then restart the session", { label: 'NOT RUNNING' });
  }
  let worst = null;
  for (const s of live) {
    const v = one(s, now, staleAfterMs);
    if (!worst || RANK[v.state] > RANK[worst.state]) worst = v;
  }
  const u = evidence.update;
  if (worst.state === 'ok' && u?.rolledBack && now - u.at < (evidence.rollbackNoticeMs ?? DEFAULTS.rollbackNoticeMs)) {
    return make('degraded', u.at, `update to ${u.to?.app} failed its check after the switch and was rolled back`, DOCTOR);
  }
  return worst;
}
