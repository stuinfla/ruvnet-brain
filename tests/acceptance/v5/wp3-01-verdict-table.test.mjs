// WP3-01 the one verdict, table-driven. Every combination of evidence (installed, process alive,
// heartbeat, self-test, lanes, last search, last update; one and two servers) maps to exactly one
// state, the same in any server order; `ok` is reachable only with a live process, a fresh heartbeat
// and a passed self-test that really ran; every non-ok verdict names one cause and the one command
// for that cause; the rendered line is one line of at most 160 characters that always keeps its fix.
// Breaks: a probe that did not run reads ok; the fix per cause is dropped; truncation cuts the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wp3 } from './wp3-helpers.mjs';

const NOW = Date.parse('2026-11-17T15:00:00Z');
const BASE = { now: NOW, installed: true, staleAfterMs: 180_000, rollbackNoticeMs: 86_400_000, probeIntervalMs: 1_800_000, update: null };
const RESULT = [{ question: 'q', expect: 'r/f', pass: true, top: 'r/f' }];
const HEART = { fresh: NOW - 20_000, stale: NOW - 600_000, missing: undefined };
const PROBE = {
  none: null,
  failed: { ok: false, at: NOW - 60_000, failingSince: NOW - 120_000, error: 'a probe did not find its expected file', results: [{ ...RESULT[0], pass: false, top: null }] },
  passed: { ok: true, at: NOW - 60_000, results: RESULT },
  empty: { ok: true, at: NOW - 60_000, results: [] },
  overdue: { ok: true, at: NOW - 3 * 3_600_000, results: RESULT },
};
const LANES = { all: [{ name: 'lexical', available: true }], off: [{ name: 'lexical', available: true }, { name: 'history', available: false }] };
const SEARCH = { none: null, normal: { ok: true, at: NOW - 5_000 }, safe: { ok: false, at: NOW - 5_000, safeMode: true, reason: 'worker stopped' } };
const UPDATE = {
  none: null,
  rolledBack: { result: 'rolled-back', rolledBack: true, at: NOW - 3_600_000, to: { app: '5.0.2' }, reason: 'probe failed' },
  oldRollback: { result: 'rolled-back', rolledBack: true, at: NOW - 3 * 86_400_000, to: { app: '5.0.2' }, reason: 'probe failed' },
  refused: { result: 'refused', rolledBack: false, at: NOW - 3_600_000, to: { app: '5.0.2' }, reason: 'probes failed' },
};
const FIXES = new Set(['ruvnet-brain install', "run 'node -v'; then restart the session", 'restart the session', 'wait one minute', 'ruvnet-brain install --repair', 'ruvnet-brain doctor']);

const server = (pid, k) => ({ pid, alive: k.alive, heartbeatAt: HEART[k.hb], startedAt: NOW - 600_000, knowledgeDate: '2026-11-14', probe: PROBE[k.probe], lanes: LANES[k.lanes], lastSearch: SEARCH[k.search] });
const serverOk = (k) => k.alive && k.hb === 'fresh' && (k.probe === 'passed') && k.lanes === 'all' && k.search !== 'safe';

function* combos() {
  for (const alive of [true, false]) for (const hb of Object.keys(HEART)) for (const probe of Object.keys(PROBE)) {
    for (const lanes of Object.keys(LANES)) for (const search of Object.keys(SEARCH)) yield { alive, hb, probe, lanes, search };
  }
}

test('WP3-01 every combination of evidence maps to exactly one state; ok only from a probe that ran', { timeout: 120_000 }, async (t) => {
  const { mod } = wp3(t, 'wp3-01');
  const { assess } = await mod('assess.mjs');
  const { renderLine } = await mod('line.mjs');
  const { STATES } = await import('../../../packages/contract/constants.mjs');
  const all = [...combos()];
  let n = 0;
  const check = (ev, expectOk, what) => {
    const v = assess(ev);
    n++;
    assert.ok(STATES.includes(v.state), `${what}: state ${v.state} is not one of the five`);
    assert.deepEqual(assess(ev), v, `${what}: the same evidence must give the same verdict`);
    assert.equal(v.state === 'ok', expectOk, `${what}: ok only with a live process, a fresh heartbeat and a passed probe that ran (got ${v.state}: ${v.reason})`);
    const line = renderLine(v);
    assert.ok(line.length <= 160 && !line.includes('\n'), `${what}: one line of at most 160 characters: ${line}`);
    if (v.state !== 'ok') {
      assert.ok(FIXES.has(v.fix), `${what}: the fix for ${v.cause} must be one known command, got "${v.fix}"`);
      assert.ok(line.endsWith(` · fix: ${v.fix}]`), `${what}: the line keeps its fix: ${line}`);
    }
    return v;
  };
  check({ ...BASE, installed: false, servers: [] }, false, 'not installed');
  check({ ...BASE, servers: [] }, false, 'no server');
  for (const [uk, update] of Object.entries(UPDATE)) {
    for (const k of all) check({ ...BASE, update, servers: [server(101, k)] }, serverOk(k) && uk !== 'rolledBack', `one server ${JSON.stringify(k)} update ${uk}`);
  }
  // Two servers: worst state wins whatever order the files are read in.
  const pick = all.filter((k, i) => i % 7 === 0);
  for (const a of pick) for (const b of pick) {
    const ev = { ...BASE, servers: [server(101, a), server(102, b)] };
    const v = check(ev, (serverOk(a) || !a.alive) && (serverOk(b) || !b.alive) && (a.alive || b.alive), `two servers ${JSON.stringify([a, b])}`);
    assert.equal(assess({ ...ev, servers: [...ev.servers].reverse() }).state, v.state, 'two servers: the order of the status files must not matter');
  }
  t.diagnostic(`${n} combinations checked`);
});

test('WP3-01 each cause names its own fix, and a long reason never pushes the fix off the line', { timeout: 60_000 }, async (t) => {
  const { mod } = wp3(t, 'wp3-01');
  const { assess } = await mod('assess.mjs');
  const { renderLine } = await mod('line.mjs');
  const k = { alive: true, hb: 'fresh', probe: 'passed', lanes: 'all', search: 'none' };
  const rows = [
    ['not installed', { ...BASE, installed: false, servers: [] }, 'not-installed', 'NOT INSTALLED', /not installed/, 'ruvnet-brain install'],
    ['server stopped', { ...BASE, servers: [server(1, { ...k, alive: false })] }, 'down', 'NOT RUNNING', /did not start/, "run 'node -v'; then restart the session"],
    ['stale heartbeat', { ...BASE, servers: [server(1, { ...k, hb: 'stale' })] }, 'unknown', 'UNKNOWN', /stale heartbeat/, 'restart the session'],
    ['self-test still running', { ...BASE, servers: [server(1, { ...k, probe: 'none' })] }, 'unknown', 'UNKNOWN', /has not finished/, 'wait one minute'],
    ['self-test ran no probes', { ...BASE, servers: [server(1, { ...k, probe: 'empty' })] }, 'unknown', 'UNKNOWN', /ran no probes/, 'ruvnet-brain install --repair'],
    ['self-test overdue', { ...BASE, servers: [server(1, { ...k, probe: 'overdue' })] }, 'unknown', 'UNKNOWN', /has not run for 3 h/, 'restart the session'],
    ['pack damaged', { ...BASE, servers: [server(1, { ...k, probe: 'failed' })] }, 'down', 'DOWN', /pack failed its self-test/, 'ruvnet-brain install --repair'],
    ['lane unavailable', { ...BASE, servers: [server(1, { ...k, lanes: 'off' })] }, 'degraded', 'DEGRADED', /lane history unavailable/, 'ruvnet-brain install --repair'],
    ['safe mode', { ...BASE, servers: [server(1, { ...k, search: 'safe' })] }, 'degraded', 'DEGRADED', /safe mode \(worker stopped\)/, 'restart the session'],
    ['rolled back', { ...BASE, update: UPDATE.rolledBack, servers: [server(1, k)] }, 'degraded', 'DEGRADED', /update to 5\.0\.2 failed its check after the switch and was rolled back/, 'ruvnet-brain doctor'],
    ['refused update', { ...BASE, update: UPDATE.refused, servers: [server(1, k)] }, 'ok', 'OK', /knowledge of/, null],
  ];
  for (const [what, ev, state, label, reason, fix] of rows) {
    const v = assess(ev);
    assert.equal(v.state, state, `${what}: state`);
    assert.equal(v.label, label, `${what}: label`);
    assert.match(v.reason, reason, `${what}: cause`);
    if (fix) assert.equal(v.fix, fix, `${what}: fix for ${what} must be "${fix}", got "${v.fix}"`);
  }
  const long = { ...PROBE.failed, error: `worker said:\n${'x'.repeat(400)}\nend` };
  const line = renderLine(assess({ ...BASE, servers: [{ ...server(1, k), probe: long }] }));
  assert.ok(line.length <= 160 && !line.includes('\n'), `one line of at most 160 characters: ${line}`);
  assert.ok(line.startsWith('[RuvNet Brain DOWN since ') && line.endsWith(' · fix: ruvnet-brain install --repair]'), `a long reason must be shortened and the line keeps its fix: ${line}`);
});
