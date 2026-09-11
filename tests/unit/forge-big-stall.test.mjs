// tests/unit/forge-big-stall.test.mjs — kb/shard-progress.mjs, the stall-detection half of the
// 2026-09-11 incident fix (an 8-shard gists embed sat at 0% CPU for six hours with every wrapper
// pid alive and a heartbeat that still said "running"). These functions are deliberately split out
// of kb/forge-big.mjs (which runs its MODE dispatch, including `process.exit`, at import time — see
// that file's own header and tests/unit/forge-big-sharding.test.mjs) so they can be imported and
// exercised directly, with a FIXTURE standing in for "a mock embedder that stops advancing": a
// progress file written once via `poll()`, then left untouched while the clock keeps moving.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  progressPath, writeShardProgress, readShardProgress, clearShardProgress,
  createStallWatcher, oldestIncompleteProgress,
} from '../../kb/shard-progress.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shard-progress-'));

describe('progressPath / writeShardProgress / readShardProgress / clearShardProgress', () => {
  it('round-trips a shard progress record and cleans it up', () => {
    const dir = tmpdir();
    writeShardProgress(dir, 'corpus', 2, 8, 64, 382);
    const rec = readShardProgress(dir, 'corpus', 2, 8);
    expect(rec).toMatchObject({ shard: 2, of: 8, completed: 64, total: 382 });
    expect(new Date(rec.updatedAt).toString()).not.toBe('Invalid Date');
    expect(fs.existsSync(progressPath(dir, 'corpus', 2, 8))).toBe(true);
    clearShardProgress(dir, 'corpus', 2, 8);
    expect(readShardProgress(dir, 'corpus', 2, 8)).toBeNull();
  });

  it('clearShardProgress on a file that never existed is a silent no-op', () => {
    const dir = tmpdir();
    expect(() => clearShardProgress(dir, 'nope', 0, 1)).not.toThrow();
  });

  it('a write is atomic — readers never see a half-written temp file at the real path', () => {
    const dir = tmpdir();
    writeShardProgress(dir, 'corpus', 0, 1, 10, 100);
    expect(fs.readdirSync(dir).some((f) => f.includes('.tmp-'))).toBe(false);
  });
});

describe('createStallWatcher — the guard that must trip on a real 0%-CPU-forever hang', () => {
  // "A test that cannot fail on broken code is not a test": every case below is proven both ways —
  // it fires when the guarded condition is true, and it does NOT fire when the shard is genuinely
  // still advancing or has already finished.

  it('fires onStall for a shard whose completed-count has not advanced within the stall budget — the mock-embedder-that-hangs case', () => {
    const dir = tmpdir();
    let clock = 0;
    const now = () => clock;
    writeShardProgress(dir, 'corpus', 0, 1, 32, 382, { now: () => new Date(clock) });
    const stalls = [];
    const watcher = createStallWatcher({ dir, name: 'corpus', of: 1, stallMs: 1000, pollMs: 0, now, onStall: (i, info) => stalls.push({ i, info }) });
    watcher.poll(); // t=0: first sighting of completed=32, no stall yet (nothing to compare against)
    expect(stalls).toHaveLength(0);
    clock = 500;
    watcher.poll(); // still within budget, no further write — like an embedder still "working"
    expect(stalls).toHaveLength(0);
    clock = 1500; // now past the 1000ms budget since the LAST advance (t=0)
    watcher.poll();
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ i: 0, info: { lastCompleted: 32 } });
    expect(stalls[0].info.staleMs).toBeGreaterThanOrEqual(1000);
  });

  it('does NOT fire when the shard keeps advancing — the "just slow, not hung" case a stall guard must not cry wolf on', () => {
    const dir = tmpdir();
    let clock = 0;
    const now = () => clock;
    const stalls = [];
    writeShardProgress(dir, 'corpus', 0, 1, 32, 382, { now: () => new Date(clock) });
    const watcher = createStallWatcher({ dir, name: 'corpus', of: 1, stallMs: 1000, pollMs: 0, now, onStall: (i, info) => stalls.push({ i, info }) });
    watcher.poll();
    for (let t = 500; t <= 5000; t += 500) {
      clock = t;
      writeShardProgress(dir, 'corpus', 0, 1, 32 + t / 10, 382, { now: () => new Date(clock) }); // real progress every tick
      watcher.poll();
    }
    expect(stalls).toHaveLength(0);
  });

  it('does NOT fire once a shard reports completed >= total — a finished shard cannot be "the one that hung"', () => {
    const dir = tmpdir();
    let clock = 0;
    const now = () => clock;
    const stalls = [];
    writeShardProgress(dir, 'corpus', 0, 1, 382, 382, { now: () => new Date(clock) }); // already done
    const watcher = createStallWatcher({ dir, name: 'corpus', of: 1, stallMs: 100, pollMs: 0, now, onStall: (i, info) => stalls.push({ i, info }) });
    watcher.poll();
    clock = 10_000; // long past any reasonable budget
    watcher.poll();
    expect(stalls).toHaveLength(0);
  });

  it('fires at most once per shard, and independently across shards — one hung shard does not mask, or get masked by, a healthy one', () => {
    const dir = tmpdir();
    let clock = 0;
    const now = () => clock;
    const stalls = [];
    writeShardProgress(dir, 'corpus', 0, 2, 10, 100, { now: () => new Date(clock) }); // shard 0: will hang
    writeShardProgress(dir, 'corpus', 1, 2, 10, 100, { now: () => new Date(clock) }); // shard 1: keeps going
    const watcher = createStallWatcher({ dir, name: 'corpus', of: 2, stallMs: 1000, pollMs: 0, now, onStall: (i, info) => stalls.push({ i, info }) });
    watcher.poll();
    for (const t of [1200, 2500, 4000]) {
      clock = t;
      writeShardProgress(dir, 'corpus', 1, 2, 10 + t / 100, 100, { now: () => new Date(clock) }); // only shard 1 advances
      watcher.poll();
    }
    expect(stalls).toHaveLength(1); // shard 0 flagged exactly once, not once per poll
    expect(stalls[0].i).toBe(0);
  });
});

describe('oldestIncompleteProgress — the evidence scripts/nightly-watchdog.mjs reads', () => {
  const pattern = (name) => new RegExp(`^${name}\\.big\\.progress\\.\\d+-\\d+\\.json$`);

  it('returns null when no shard has started yet — absence is not evidence of a stall', () => {
    const dir = tmpdir();
    expect(oldestIncompleteProgress(dir, pattern('corpus'))).toBeNull();
  });

  it('returns null when every shard already finished', () => {
    const dir = tmpdir();
    writeShardProgress(dir, 'corpus', 0, 2, 100, 100);
    writeShardProgress(dir, 'corpus', 1, 2, 100, 100);
    expect(oldestIncompleteProgress(dir, pattern('corpus'))).toBeNull();
  });

  it('names the OLDEST still-incomplete shard across multiple progress files', async () => {
    const dir = tmpdir();
    writeShardProgress(dir, 'corpus', 0, 2, 90, 100, { now: () => new Date(Date.now() - 1000) }); // older, incomplete
    writeShardProgress(dir, 'corpus', 1, 2, 50, 100, { now: () => new Date() }); // newer, incomplete
    const oldest = oldestIncompleteProgress(dir, pattern('corpus'));
    expect(oldest).toMatchObject({ shard: 0, of: 2, completed: 90, total: 100 });
  });
});
