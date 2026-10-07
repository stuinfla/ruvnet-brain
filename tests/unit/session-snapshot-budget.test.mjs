// tests/unit/session-snapshot-budget.test.mjs
//
// CODEX SESSIONEND IS CAPPED AT 3 SECONDS (the host prints "clamping SessionEnd hook timeout to 3s").
// The codex-hooks.json launcher kills the wrapper at 2500ms; before 4.4.0 the wrapper still planned a
// 4000ms budget and the snapshot body planned 8000ms, and the body spent its first seconds REPLAYING
// OLD outbox snapshots (one ~3s `ruflo` write each) before it even produced this session's own. A
// SIGKILL then left this session's state nowhere — not even in the durable outbox.
//
// The rules pinned here: the wrapper hands SessionEnd a 2200ms budget; the body plans inside the
// handed-down budget; the NEW snapshot is captured first; replay is skipped (deferred, never dropped)
// when the budget is under REPLAY_MIN_BUDGET_MS.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CAPTURE_BUDGET_MS, REPLAY_MIN_BUDGET_MS, effectiveBudgetMs, queueCapture, queuedCaptures, refreshReplayLock, releaseReplayLock, REPLAY_LOCK_STALE_MS,
  replayOutboxDetached, runOutboxReplay, runSessionSnapshotHook, takeReplayLock, queuedWork, REPLAY_LOCK_ABANDON_MS,
  processStart, reclaimOrphans, adoptReplayLock,
} from '../../plugin/scripts/session-snapshot-hook.mjs';
import { createStore } from '../helpers/continuity-fixture.mjs';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';

it('an inherited expired deadline starts no metadata, capture, producer or replay work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-snapshot-'));
  try {
    const work = vi.fn(() => { throw new Error('expired work executed'); });
    const env = { HOME: root, USERPROFILE: root, RUVNET_BRAIN_HOME: path.join(root, 'brain') };
    const result = runSessionSnapshotHook(root, 'SessionStart', { env, deadlineAt: Date.now() - 1,
      captureTurn: work, captureEvents: work, produce: work });
    expect(result.metadataWritten).toBe(false); expect(result.progressionCaptured).toBe(false); expect(result.skipped).toMatch(/deadline exceeded/);
    expect(runOutboxReplay({ projectDir: root, env, deadlineAt: Date.now() - 1, runCapture: work, makeStoreFactory: work })).toBe(0);
    expect(work).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function project() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-budget-')));
  fs.mkdirSync(path.join(root, '.swarm'));
  createStore(path.join(root, '.swarm', 'memory.db'));
  roots.push(root);
  return root;
}
it('cancellation after claiming a replay returns the exact original without admitting another capture', () => {
  const dir = project(); const env = { HOME: dir, USERPROFILE: dir, RUVNET_BRAIN_HOME: path.join(dir, 'brain') };
  const file = queueCapture({ projectDir: dir, env, event: 'Stop', host: 'codex', payload: { session_id: 'cancelled', hook_event_name: 'Stop' } });
  expect(file).toBeTruthy(); const before = fs.readFileSync(file);
  const controller = new AbortController(); const capture = vi.fn(() => ({ progressionCaptured: true, receipt: { eventKey: 'must-not-run' } }));
  const fakeStore = () => () => ({ outbox: new ProgressionOutbox({ projectRoot: dir }) });
  expect(runOutboxReplay({ projectDir: dir, env, signal: controller.signal, deadlineAt: Date.now() + 2000,
    makeStoreFactory: fakeStore, onClaim: () => controller.abort(), runCapture: capture })).toBe(0);
  expect(capture).not.toHaveBeenCalled(); expect(fs.readFileSync(file)).toEqual(before); expect(queuedCaptures(dir)).toContain(file);
});
function run(budgetMs) {
  const order = [];
  const dir = project();
  const result = runSessionSnapshotHook(dir, 'SessionEnd', {
    rawInput: JSON.stringify({ session_id: 'budget-1', hook_event_name: 'SessionEnd', cwd: dir }),
    host: 'codex',
    budgetMs,
    produce: () => { order.push('produce'); return { projectProgression: { fixture: true }, provenance: {} }; },
    captureProgression: () => { order.push('capture'); return { receipt: { eventKey: 'new' } }; },
    makeStoreFactory: () => () => ({ replay: () => { order.push('replay'); return [{ eventKey: 'old' }]; } }),
  });
  return { order, result };
}

describe('session-snapshot: the budget it is handed, and what it spends it on first', () => {
  it('the budget is the handed-down one minus spawn overhead, never more than the capture budget', () => {
    expect(effectiveBudgetMs({})).toBe(CAPTURE_BUDGET_MS);
    expect(effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: '2200' })).toBe(1900);
    expect(effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: '60000' })).toBe(CAPTURE_BUDGET_MS);
    expect(effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: 'nonsense' })).toBe(CAPTURE_BUDGET_MS);
  });

  // CAUSAL ORDER: the producer links a new snapshot to COMMITTED heads, so old debt must be committed
  // before the new snapshot is produced, or the project ends with two unrelated heads
  // (tests/acceptance/cross-host-project-resume.test.mjs).
  it('a full budget replays the outbox FIRST, then produces and captures (causal order)', () => {
    const { order, result } = run(CAPTURE_BUDGET_MS);
    expect(order).toEqual(['replay', 'produce', 'capture']);
    expect(result).toMatchObject({ progressionCaptured: true, receipt: { eventKey: 'new' }, replayed: 1 });
  });

  it('under REPLAY_MIN_BUDGET_MS with NO debt it captures inline and replays nothing', () => {
    const { order, result } = run(REPLAY_MIN_BUDGET_MS - 1);
    expect(order).toEqual(['produce', 'capture']);
    expect(result).toMatchObject({ progressionCaptured: true, receipt: { eventKey: 'new' }, replayed: 0 });
  });

  it('under REPLAY_MIN_BUDGET_MS WITH debt it neither replays nor produces inline: it queues the capture behind the debt', () => {
    const dir = project();
    new ProgressionOutbox({ projectRoot: dir }).appendRecord({ type: 'snapshot', eventKey: 'old-1', payloadDigest: 'a'.repeat(64), snapshot: { eventKey: 'old-1' } });
    const order = [];
    const spawned = [];
    const result = runSessionSnapshotHook(dir, 'SessionEnd', {
      rawInput: JSON.stringify({ session_id: 'budget-2', hook_event_name: 'SessionEnd', cwd: dir }), host: 'codex', budgetMs: 1900,
      produce: () => { order.push('produce'); return { projectProgression: {}, provenance: {} }; },
      captureProgression: () => { order.push('capture'); return { receipt: {} }; },
      makeStoreFactory: () => () => ({ replay: () => { order.push('replay'); return []; } }),
      spawnReplay: (x) => { spawned.push(x); return true; },
    });
    expect(order).toEqual(['produce']);
    expect(result).toMatchObject({ progressionCaptured: false, deferredToReplayer: true });
    expect(result.replaySkipped).toMatch(/1 pending; this capture queued behind it, handed to a detached worker/);
    expect(spawned).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, '.swarm')).filter((n) => n.startsWith('.progression-capture-queue-'))).toHaveLength(1);
  });
});

// 4.4.0 review S1: on Codex no capture boundary ever has REPLAY_MIN_BUDGET_MS (Stop 3700ms effective,
// SessionEnd 1900ms, no PreCompact), so a deferred snapshot used to wait for a boundary that never
// came. Now the boundary hands the debt to a detached, bounded, single-instance replayer.
describe.skipIf(process.platform === 'win32')('Codex-only lifecycle: a deferred snapshot EVENTUALLY reaches AgentDB', () => {
  function fakeRuflo(dir) {
    const db = path.join(dir, 'fake-agentdb.json');
    const bin = path.join(dir, 'ruflo');
    fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); const db = ${JSON.stringify(db)};
const get = (f) => a[a.indexOf(f) + 1]; let rows = {}; try { rows = JSON.parse(fs.readFileSync(db, 'utf8')); } catch {}
if (a[0] === 'memory' && a[1] === 'store') { const k = get('--key'); if (rows[k]) process.exit(1); rows[k] = get('--value'); fs.writeFileSync(db, JSON.stringify(rows)); process.exit(0); }
if (a[0] === 'memory' && a[1] === 'retrieve') { const v = rows[get('--key')]; if (v === undefined) process.exit(1); process.stdout.write(v); process.exit(0); }
process.exit(2);
`, { mode: 0o755 });
    return { bin, rows: () => { try { return JSON.parse(fs.readFileSync(db, 'utf8')); } catch { return {}; } } };
  }
  const pendingIn = (dir) => new ProgressionOutbox({ projectRoot: dir }).pendingSnapshots().length;

  it('SessionEnd (1900ms) defers its row; the next Stop (3700ms) hands it to the detached replayer, which commits it', async () => {
    const dir = project();
    const ruflo = fakeRuflo(dir);
    const prior = process.env.RUFLO_BIN;
    process.env.RUFLO_BIN = ruflo.bin;
    try {
      const spawned = [];
      const ended = runSessionSnapshotHook(dir, 'SessionEnd', {
        rawInput: JSON.stringify({ session_id: 'codex-a', hook_event_name: 'SessionEnd', cwd: dir }), host: 'codex', budgetMs: 1900,
        makeStoreFactory: () => (options) => new ProjectProgressionStore({ ...options, reader: null, runner: () => { throw new Error('capture budget exceeded'); } }),
        spawnReplay: (x) => { spawned.push(x); return false; },
      });
      expect(ended.skipped).toMatch(/capture deferred/);
      expect(pendingIn(dir), 'the deferred row is durable in the outbox').toBe(1);
      expect(spawned, 'a short boundary with pending debt hands it on').toHaveLength(1);

      const stopped = runSessionSnapshotHook(dir, 'Stop', {
        rawInput: JSON.stringify({ session_id: 'codex-b', hook_event_name: 'Stop', cwd: dir }), host: 'codex',
        budgetMs: effectiveBudgetMs({ RUVNET_CODEX_BUDGET_MS: '4000' }),
      });
      expect(stopped).toMatchObject({ progressionCaptured: false, deferredToReplayer: true });
      expect(stopped.replaySkipped).toMatch(/1 pending; this capture queued behind it, handed to a detached worker/);

      const lock = path.join(dir, '.swarm', '.progression-replay.lock');
      const until = Date.now() + 30_000;
      while ((Object.keys(ruflo.rows()).length < 2 || fs.existsSync(lock)) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      expect(pendingIn(dir), 'the detached worker committed the deferred row').toBe(0);
      const rows = Object.values(ruflo.rows()).map((v) => JSON.parse(v));
      expect(rows.length, 'both sessions\' snapshots are in the store').toBe(2);
      // CAUSAL ORDER, kept off the host's clock: the worker committed the debt BEFORE it stored the
      // queued capture (the fake store keeps write order). The head LINK itself needs the real store's
      // committed-heads read (node:sqlite), which this JSON fake cannot provide — it is proven with real
      // ruflo by tests/acceptance/cross-host-project-resume.test.mjs ("ONE head ... descended").
      expect(rows.map((r) => r.sessionIdentity)).toEqual(['codex-a', 'codex-b']);
      expect(fs.existsSync(lock), 'lock released').toBe(false);
      expect(fs.readdirSync(path.join(dir, '.swarm')).filter((n) => n.startsWith('.progression-capture-queue-')), 'queue drained').toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.RUFLO_BIN; else process.env.RUFLO_BIN = prior;
    }
  }, 40_000);

  it('4.4.1 SLEEP, REAL WORKER: the detached worker records ITS OWN pid on the lock, so a stale-by-time lock held by a live worker is not taken over', async () => {
    const dir = project();
    const ruflo = fakeRuflo(dir);
    // A slow ruflo keeps the real worker alive long enough to observe it.
    fs.writeFileSync(ruflo.bin, fs.readFileSync(ruflo.bin, 'utf8').replace('const fs = require', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); const fs = require'));
    const prior = process.env.RUFLO_BIN;
    process.env.RUFLO_BIN = ruflo.bin;
    try {
      queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: 'slow', hook_event_name: 'Stop', cwd: dir } });
      // The lock as a hook leaves it after spawning the worker and EXITING: its token names a dead pid.
      const token = '999999999-1-exitedhook';
      fs.writeFileSync(path.join(dir, '.swarm', '.progression-replay.lock'), `${token}\npid 999999999\n`);
      let childPid = null;
      expect(replayOutboxDetached({ projectDir: dir, token, spawnFn: (...a) => { const c = spawn(...a); childPid = c.pid; return c; } })).toBe(true);
      const lock = path.join(dir, '.swarm', '.progression-replay.lock');
      const readPid = () => { try { return Number((/^pid (\d+)$/m.exec(fs.readFileSync(lock, 'utf8')) || [])[1]); } catch { return null; } };
      const until = Date.now() + 15_000;
      while (readPid() !== childPid && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(readPid(), 'the lock names the WORKER, not the spawning hook').toBe(childPid);
      expect(childPid).not.toBe(process.pid);
      const old = new Date(Date.now() - REPLAY_LOCK_STALE_MS - 10_000); fs.utimesSync(lock, old, old);
      expect(takeReplayLock(dir), 'a stale-looking lock whose worker is alive (asleep mid-step) is not taken over').toBeNull();
      const done = Date.now() + 30_000;
      while (fs.existsSync(lock) && Date.now() < done) await new Promise((r) => setTimeout(r, 200));
      expect(fs.existsSync(lock), 'the worker finished and released its own lock').toBe(false);
    } finally {
      if (prior === undefined) delete process.env.RUFLO_BIN; else process.env.RUFLO_BIN = prior;
    }
  }, 60_000);

  it('only ONE replayer at a time: a held, fresh lock refuses a second spawn', () => {
    const dir = project();
    expect(takeReplayLock(dir)).toBeTruthy();
    let spawns = 0;
    expect(replayOutboxDetached({ projectDir: dir, spawnFn: () => { spawns += 1; return { unref() {} }; } })).toBe(false);
    expect(spawns).toBe(0);
  });
});

// 4.4.0 re-review S-A: the lock is the right to commit IN ORDER. Queued boundaries count as older
// work in EVERY path; the lock has an owner token, a heartbeat, and is released only by its owner.
describe('ordering under a live worker, stranded queues, and lock ownership', () => {
  const boundary = (dir, budgetMs, order, spawned, sid) => runSessionSnapshotHook(dir, 'Stop', {
    rawInput: JSON.stringify({ session_id: sid, hook_event_name: 'Stop', cwd: dir }), host: 'codex', budgetMs,
    produce: () => { order.push(`produce ${sid}`); return { projectProgression: {}, provenance: {} }; },
    captureProgression: () => { order.push(`capture ${sid}`); return { receipt: {} }; },
    makeStoreFactory: () => () => ({ replay: () => { order.push('replay outbox'); return []; } }),
    spawnReplay: (x) => { spawned.push(x); return Boolean(x.token); },
  });
  const sessionOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).payload.session_id;

  it('THE REVIEWER\'S PROBE: an older boundary is queued and a worker holds the lock; new boundaries at 1900ms and 30000ms do NOT produce or capture inline — they queue BEHIND it, and the worker commits in order', () => {
    const dir = project();
    const workerToken = takeReplayLock(dir);
    queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: 'old', hook_event_name: 'Stop' } });
    const order = []; const spawned = [];
    for (const [budget, sid] of [[1900, 'new-short'], [30_000, 'new-full']]) {
      const r = boundary(dir, budget, order, spawned, sid);
      expect(r).toMatchObject({ progressionCaptured: false, deferredToReplayer: true });
      expect(r.replaySkipped).toMatch(/a worker is committing older work; this capture queued behind it/);
    }
    expect(order, 'origin snapshots are frozen, but nothing captured ahead of older work').toEqual(['produce new-short', 'produce new-full']);
    expect(queuedCaptures(dir).map(sessionOf)).toEqual(['old', 'new-short', 'new-full']);

    const ran = [];
    const fakeStore = () => () => ({ outbox: new ProgressionOutbox({ projectRoot: dir }), appendExact: () => { throw new Error('no outbox debt here'); } });
    runOutboxReplay({ projectDir: dir, token: workerToken, makeStoreFactory: fakeStore,
      runCapture: (d, ev, opts) => { ran.push(JSON.parse(opts.rawInput).session_id); expect(opts.ordered).toBe(workerToken); return { progressionCaptured: true, receipt: { eventKey: 'verified' } }; } });
    expect(ran, 'the worker commits strictly in queue order').toEqual(['old', 'new-short', 'new-full']);
    expect(queuedCaptures(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.swarm', '.progression-replay.lock'))).toBe(false);
  });

  it('a STRANDED queue (worker died) is drained from ANY boundary: no lock → a FULL-budget boundary queues behind it and starts a worker', () => {
    const dir = project();
    queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: 'stranded', hook_event_name: 'Stop' } });
    const order = []; const spawned = [];
    const r = boundary(dir, 30_000, order, spawned, 'later');
    expect(order).toEqual(['produce later']);
    expect(r.replaySkipped).toMatch(/1 older capture\(s\) queued; this capture queued behind it, handed to a detached worker/);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].token, 'the boundary hands over the lock it took').toBeTruthy();
    expect(queuedCaptures(dir).map(sessionOf)).toEqual(['stranded', 'later']);
  });

  it('a STALE lock (dead worker, never released) is taken over; a FRESH one is not', () => {
    const dir = project();
    const lock = path.join(dir, '.swarm', '.progression-replay.lock');
    fs.writeFileSync(lock, 'dead-worker\n');
    expect(takeReplayLock(dir), 'a fresh foreign lock is respected').toBeNull();
    const old = new Date(Date.now() - REPLAY_LOCK_STALE_MS - 10_000); fs.utimesSync(lock, old, old);
    const t = takeReplayLock(dir);
    expect(t).toBeTruthy();
    expect(fs.readFileSync(lock, 'utf8').split('\n')[0].trim()).toBe(t);
  });

  it('heartbeat: the owner refreshes the lock; a non-owner cannot refresh or release it', () => {
    const dir = project();
    const lock = path.join(dir, '.swarm', '.progression-replay.lock');
    const t = takeReplayLock(dir);
    const old = new Date(Date.now() - 100_000); fs.utimesSync(lock, old, old);
    expect(refreshReplayLock(dir, 'someone-else')).toBe(false);
    expect(fs.statSync(lock).mtimeMs).toBeLessThan(Date.now() - 50_000);
    expect(refreshReplayLock(dir, t)).toBe(true);
    expect(fs.statSync(lock).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
    expect(releaseReplayLock(dir, 'someone-else')).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(releaseReplayLock(dir, t)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('4.4.1 STRAND: a boundary B that queues while A holds the lock is handed to a worker when A releases (two simultaneous SessionEnds)', () => {
    const dir = project();
    const spawned = [];
    const spawnReplay = (x) => { spawned.push({ ...x, at: 'call' }); return Boolean(x.token); };
    let inner = null;
    const mk = (sid, during) => runSessionSnapshotHook(dir, 'SessionEnd', {
      rawInput: JSON.stringify({ session_id: sid, hook_event_name: 'SessionEnd', cwd: dir }), host: 'claude', budgetMs: 8000,
      produce: () => { during?.(); return { projectProgression: {}, provenance: {} }; },
      captureProgression: () => ({ receipt: { sid } }), makeStoreFactory: () => () => ({ replay: () => [] }), spawnReplay,
    });
    const a = mk('A', () => { inner = mk('B'); });
    expect(a.progressionCaptured).toBe(true);
    expect(inner.replaySkipped).toMatch(/the current lock holder hands the queue to a worker when it releases/);
    const lock = path.join(dir, '.swarm', '.progression-replay.lock');
    const handed = spawned.find((x) => x.token);
    expect(handed, 'A handed its lock to a worker instead of releasing it').toBeTruthy();
    expect(fs.readFileSync(lock, 'utf8').split('\n')[0].trim()).toBe(handed.token);
    expect(queuedCaptures(dir).map(sessionOf)).toEqual(['B']);
  });

  it('4.4.1 TWO SUCCESSORS: a successor that takes a stale lock between our check and our rename keeps it; we back off', () => {
    const dir = project();
    const lock = path.join(dir, '.swarm', '.progression-replay.lock');
    fs.writeFileSync(lock, '999999999-1-dead\n');
    const old = new Date(Date.now() - REPLAY_LOCK_STALE_MS - 10_000); fs.utimesSync(lock, old, old);
    let successor = null;
    const ours = takeReplayLock(dir, Date.now(), { isAlive: () => false, beforeRename: () => { successor = takeReplayLock(dir, Date.now(), { isAlive: () => false }); } });
    expect(successor, 'the successor took the stale lock').toBeTruthy();
    expect(ours, 'we moved the successor\'s FRESH lock, saw it was not the stale one, and backed off').toBeNull();
    expect(fs.readFileSync(lock, 'utf8').split('\n')[0].trim(), 'the successor\'s lock is back in place').toBe(successor);
    expect(fs.readdirSync(path.join(dir, '.swarm')).filter((n) => n.includes('.stale-'))).toEqual([]);
  });

  it('4.4.1 SLEEP: a stale lock whose holder is ALIVE (laptop asleep mid-step) is not taken over until the abandon horizon', () => {
    const dir = project();
    const lock = path.join(dir, '.swarm', '.progression-replay.lock');
    fs.writeFileSync(lock, `${process.pid}-1-sleeping\n`);
    const stale = new Date(Date.now() - REPLAY_LOCK_STALE_MS - 10_000); fs.utimesSync(lock, stale, stale);
    expect(takeReplayLock(dir)).toBeNull();
    const abandoned = new Date(Date.now() - REPLAY_LOCK_ABANDON_MS - 10_000); fs.utimesSync(lock, abandoned, abandoned);
    expect(takeReplayLock(dir)).toBeTruthy();
  });

  it('4.4.1 CLAIMS: a capture claimed by a LIVE worker is never run by another; a dead worker\'s claim returns to the queue', () => {
    const dir = project();
    const live = queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: 'live-claim', hook_event_name: 'Stop' } });
    const dead = queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: 'dead-claim', hook_event_name: 'Stop' } });
    const claim = (file, pid, start = 'na') => { const to = path.join(dir, '.swarm', `.progression-capture-claimed-${pid}-${start}-1-${path.basename(file).slice('.progression-capture-queue-'.length)}`); fs.renameSync(file, to); return to; };
    const liveClaim = claim(live, process.pid, processStart(process.pid) || 'na');
    claim(dead, 999999999);
    expect(queuedWork(dir), 'claimed work still counts as work a boundary must wait behind').toBe(2);
    const ran = [];
    const fakeStore = () => () => ({ outbox: new ProgressionOutbox({ projectRoot: dir }), appendExact: () => { throw new Error('none'); } });
    runOutboxReplay({ projectDir: dir, token: takeReplayLock(dir), makeStoreFactory: fakeStore,
      runCapture: (d, ev, opts) => { ran.push(JSON.parse(opts.rawInput).session_id); return { progressionCaptured: true, receipt: { eventKey: 'verified' } }; } });
    expect(ran, 'only the dead worker\'s claim was reclaimed and run').toEqual(['dead-claim']);
    expect(fs.existsSync(liveClaim), 'the live worker\'s claim is untouched').toBe(true);
  });

  it('4.4.1 ORDER without a clock: queue names follow exclusive-creation order after every queued or claimed one', () => {
    const dir = project();
    const names = ['a', 'b', 'c'].map((s) => path.basename(queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: s } })));
    expect(names).toEqual(['000000000001', '000000000002', '000000000003'].map((n) => `.progression-capture-queue-${n}.json`));
    fs.renameSync(path.join(dir, '.swarm', names[2]), path.join(dir, '.swarm', `.progression-capture-claimed-${process.pid}-na-1-000000000003.json`));
    expect(path.basename(queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: 'd' } })))
      .toBe('.progression-capture-queue-000000000004.json');
    expect(queuedCaptures(dir).map(sessionOf)).toEqual(['a', 'b', 'd']);
  });

  it('4.4.1 UPGRADE WINDOW: mixed 4.4.0 (timestamp) and 4.4.1 (sequence) queue files replay in creation order, not name order', () => {
    const dir = project();
    const sw = path.join(dir, '.swarm');
    const put = (name, sid, ageMs) => { const f = path.join(sw, name); fs.writeFileSync(f, JSON.stringify({ event: 'Stop', host: 'codex', payload: { session_id: sid } })); const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); };
    put('.progression-capture-queue-001790000000000-123456789-111-1.json', 'legacy-old', 40_000);    // 4.4.0, before the update
    put('.progression-capture-queue-000000000001.json', 'seq-1', 30_000);                               // 4.4.1
    put('.progression-capture-queue-001790000000100-123456789-222-1.json', 'legacy-after-update', 20_000); // an open 4.4.0 window
    put('.progression-capture-queue-000000000002.json', 'seq-2', 10_000);
    expect(queuedCaptures(dir).map(sessionOf)).toEqual(['legacy-old', 'seq-1', 'legacy-after-update', 'seq-2']);
    // Once the legacy entries are gone, the sequence alone decides, whatever the clocks say.
    for (const n of fs.readdirSync(sw).filter((x) => /-\d{15}-/.test(x))) fs.rmSync(path.join(sw, n));
    const t = new Date(Date.now() - 999_000); fs.utimesSync(path.join(sw, '.progression-capture-queue-000000000002.json'), t, t);
    expect(queuedCaptures(dir).map(sessionOf)).toEqual(['seq-1', 'seq-2']);
  });

  it('4.4.1 ORPHANS: a claim returns when its pid now belongs to ANOTHER process (start time differs) or it is past the ceiling; a live claim stays', () => {
    const dir = project();
    const mk = (sid, start, ageMs) => {
      const f = queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: sid } });
      const to = path.join(dir, '.swarm', `.progression-capture-claimed-${process.pid}-${start}-1-${path.basename(f).slice('.progression-capture-queue-'.length)}`);
      fs.renameSync(f, to); const t = new Date(Date.now() - ageMs); fs.utimesSync(to, t, t); return to;
    };
    const own = processStart(process.pid) || 'na';
    const kept = mk('live', own, 1_000);
    mk('reused-pid', 'ThuJan11000001970', 1_000);
    mk('ancient', own, REPLAY_LOCK_ABANDON_MS + 60_000);
    expect(reclaimOrphans(dir, { startOf: (pid) => (pid === process.pid ? own : null) })).toBe(own === 'na' ? 1 : 2);
    expect(queuedCaptures(dir).map(sessionOf).sort()).toEqual((own === 'na' ? ['ancient'] : ['ancient', 'reused-pid']).sort());
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('4.4.1 NIT: the recorded start time does not depend on the caller\'s TZ or locale (no false "pid reused")', () => {
    const prior = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    try {
      process.env.TZ = 'Asia/Tokyo'; process.env.LC_ALL = 'C';
      const tokyo = processStart(process.pid);
      if (tokyo === null) return;   // no `ps` on this platform: only the ceiling applies there
      process.env.TZ = 'America/Los_Angeles'; process.env.LC_ALL = 'fr_FR.UTF-8'; process.env.LANG = 'fr_FR.UTF-8';
      expect(processStart(process.pid)).toBe(tokyo);
    } finally {
      for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('4.4.1 NIT: a claim put back in the mixed upgrade window keeps its ORIGINAL creation order', () => {
    const dir = project();
    const sw = path.join(dir, '.swarm');
    const put = (name, sid, ageMs) => { const f = path.join(sw, name); fs.writeFileSync(f, JSON.stringify({ event: 'Stop', host: 'codex', payload: { session_id: sid } })); const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); };
    put('.progression-capture-queue-001790000000000-123456789-111-1.json', 'legacy-oldest', 60_000);
    put('.progression-capture-queue-000000000001.json', 'seq-1', 40_000);
    put('.progression-capture-queue-000000000002.json', 'seq-2', 20_000);
    const lock = path.join(sw, '.progression-replay.lock');
    const fakeStore = () => () => ({ outbox: new ProgressionOutbox({ projectRoot: dir }), appendExact: () => { throw new Error('none'); } });
    // The worker claims the oldest, then loses the lock and puts the claim back.
    runOutboxReplay({ projectDir: dir, token: takeReplayLock(dir), makeStoreFactory: fakeStore,
      onClaim: () => fs.writeFileSync(lock, 'successor\npid 1\n'), runCapture: () => { throw new Error('must not run'); } });
    expect(queuedCaptures(dir).map(sessionOf)).toEqual(['legacy-oldest', 'seq-1', 'seq-2']);
  });

  it('4.4.1 NIT: a hook whose lock is taken over before it commits does not produce or capture — it queues itself', () => {
    const dir = project();
    const order = [];
    const lock = path.join(dir, '.swarm', '.progression-replay.lock');
    const r = runSessionSnapshotHook(dir, 'Stop', {
      rawInput: JSON.stringify({ session_id: 'racer', hook_event_name: 'Stop', cwd: dir }), host: 'claude', budgetMs: 8000,
      produce: () => { order.push('produce'); return { projectProgression: {}, provenance: {} }; },
      captureProgression: () => { order.push('capture'); return { receipt: {} }; },
      makeStoreFactory: () => () => ({ replay: () => { fs.writeFileSync(lock, 'intruder\npid 1\n'); return []; } }),
      spawnReplay: () => false,
    });
    expect(order).toEqual(['produce']);
    expect(r).toMatchObject({ progressionCaptured: false, deferredToReplayer: true });
    expect(r.replaySkipped).toMatch(/the lock was taken over before this capture committed/);
    expect(fs.readFileSync(lock, 'utf8').split('\n')[0]).toBe('intruder');
  });

  it('4.4.1 NIT: ownership is re-checked right after a claim — a worker that lost the lock puts the claim back UNRUN', () => {
    const dir = project();
    const lock = path.join(dir, '.swarm', '.progression-replay.lock');
    queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: 'claimed-then-lost' } });
    const ran = [];
    const fakeStore = () => () => ({ outbox: new ProgressionOutbox({ projectRoot: dir }), appendExact: () => { throw new Error('none'); } });
    runOutboxReplay({ projectDir: dir, token: takeReplayLock(dir), makeStoreFactory: fakeStore,
      onClaim: () => fs.writeFileSync(lock, 'successor\npid 1\n'), runCapture: (d, ev, opts) => ran.push(JSON.parse(opts.rawInput).session_id) });
    expect(ran).toEqual([]);
    expect(queuedCaptures(dir).map(sessionOf)).toEqual(['claimed-then-lost']);
    expect(fs.readdirSync(path.join(dir, '.swarm')).filter((n) => n.startsWith('.progression-capture-claimed-'))).toEqual([]);
  });

  it('NIT 6: the detached worker is spawned hidden (no console window on Windows), detached, and handed the lock token', () => {
    const dir = project();
    let opts = null;
    expect(replayOutboxDetached({ projectDir: dir, spawnFn: (bin, args, o) => { opts = o; return { unref() {} }; } })).toBe(true);
    expect(opts).toMatchObject({ windowsHide: true, detached: true, stdio: 'ignore' });
    expect(opts.env.RUVNET_REPLAY_LOCK_TOKEN).toBe(fs.readFileSync(path.join(dir, '.swarm', '.progression-replay.lock'), 'utf8').split('\n')[0].trim());
  });

  it('a worker whose lock was taken over STOPS (no duplicate work) and never deletes the successor\'s lock', () => {
    const dir = project();
    const lock = path.join(dir, '.swarm', '.progression-replay.lock');
    const t = takeReplayLock(dir);
    for (const s of ['a', 'b']) queueCapture({ projectDir: dir, event: 'Stop', host: 'codex', payload: { session_id: s, hook_event_name: 'Stop' } });
    const ran = [];
    const fakeStore = () => () => ({ outbox: new ProgressionOutbox({ projectRoot: dir }), appendExact: () => { throw new Error('none'); } });
    runOutboxReplay({ projectDir: dir, token: t, makeStoreFactory: fakeStore,
      runCapture: (d, ev, opts) => { ran.push(JSON.parse(opts.rawInput).session_id); fs.writeFileSync(lock, 'successor\n'); } });
    expect(ran, 'stopped after the takeover').toEqual(['a']);
    expect(fs.readFileSync(lock, 'utf8').split('\n')[0].trim()).toBe('successor');
  });
});

describe.skipIf(process.platform === 'win32')('codex-hook-wrapper hands SessionEnd a budget inside the 2500ms launcher', () => {
  // The REAL wrapper, against a fake brain home whose adapter prints the budget it was handed.
  function budgetFor(args) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-budget-'));
    roots.push(home);
    const brain = path.join(home, 'brain');
    const scripts = path.join(brain, 'versions', '1', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'codex-hook-adapter.mjs'), 'process.stdout.write(String(process.env.RUVNET_CODEX_BUDGET_MS));\n');
    fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ codeRoot: 'versions/1' }));
    const env = { ...process.env, HOME: home, RUVNET_BRAIN_HOME: brain, CODEX_HOME: path.join(home, '.codex') };
    delete env.RUVNET_CODEX_HOOK_TIMEOUT_MS;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'), ...args],
      { input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's', cwd: home }), env, encoding: 'utf8', timeout: 15_000 });
    return Number(r.stdout);
  }
  it('session-snapshot SessionEnd gets 2200ms; session-snapshot Stop keeps 4000ms', () => {
    expect(budgetFor(['session-snapshot', 'SessionEnd'])).toBe(2200);
    expect(budgetFor(['session-snapshot', 'Stop'])).toBe(4000);
  });
  it('the codex-hooks.json SessionEnd launcher really is 2500ms / 3s, so 2200 fits inside it', () => {
    const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'codex-hooks.json'), 'utf8')).hooks;
    const handler = codex.SessionEnd.flatMap((g) => g.hooks).find((h) => / session-snapshot SessionEnd$/.test(h.command));
    expect(handler.timeout).toBe(3);
    expect(Number(handler.command.match(/" (\d+) session-snapshot SessionEnd$/)[1])).toBe(2500);
  });
});


describe('supported Codex PreCompact snapshot boundary', () => {
  it('runs the existing snapshot producer and capture path before returning at compaction', () => {
    const dir = project();
    const order = [];
    const result = runSessionSnapshotHook(dir, 'PreCompact', {
      rawInput: JSON.stringify({ session_id: 'compact-fixture', hook_event_name: 'PreCompact', cwd: dir }),
      host: 'codex', budgetMs: 8_000,
      produce: () => { order.push('produce'); return { projectProgression: { fixture: true }, provenance: {} }; },
      captureProgression: () => { order.push('capture'); return { receipt: { eventKey: 'compact-fixture-capture' } }; },
      makeStoreFactory: () => () => ({ replay: () => [] }),
    });
    expect(order).toEqual(['produce', 'capture']);
    expect(result.progressionCaptured).toBe(true);
    expect(result.receipt.eventKey).toBe('compact-fixture-capture');
  });
});
