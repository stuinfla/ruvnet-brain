import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIR_NAME, LEGACY_NAME, aggregate, isAlive, readAll, readAggregate, writeOwn,
} from '../../plugin/scripts/mcp-readiness.mjs';

/**
 * ISSUE #133, second half — global readiness was last-writer-wins across MCP shells.
 *
 * Every shell wrote the same `mcp-readiness.json`, so one shell's `degraded` overwrote another's
 * `ready` and back again, and `--doctor` reported the state of whichever process wrote last as the
 * state of the machine. Two writers, one file, no owner.
 *
 * A process now owns only its own record and the machine-level answer is DERIVED. These tests are
 * mostly about the two ways a derived answer can still lie: losing a degraded shell behind a healthy
 * one, and trusting a record whose process is gone.
 */
let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const ALL_ALIVE = { alive: () => true };
const NONE_ALIVE = { alive: () => false };

describe('a shell owns its own record and nothing else', () => {
  it('two shells write two records — neither overwrites the other', () => {
    // THE ORIGINAL BUG, stated as a test: before this, the second write destroyed the first.
    writeOwn(home, { state: 'ready' }, { pid: 111, now: 1 });
    writeOwn(home, { state: 'degraded', phase: 'worker-exit' }, { pid: 222, now: 2 });
    const all = readAll(home, ALL_ALIVE);
    expect(all.map((r) => r.pid).sort()).toEqual([111, 222]);
    expect(all.find((r) => r.pid === 111).state, 'the healthy shell keeps its own truth').toBe('ready');
  });

  it('keeps the legacy single file as a mirror, so an older reader still sees something true', () => {
    writeOwn(home, { state: 'ready' }, { pid: 111, now: 1 });
    const legacy = JSON.parse(fs.readFileSync(path.join(home, LEGACY_NAME), 'utf8'));
    expect(legacy).toMatchObject({ state: 'ready', pid: 111 });
  });

  it('writes atomically — no .tmp survives a completed write', () => {
    writeOwn(home, { state: 'ready' }, { pid: 111, now: 1 });
    expect(fs.readdirSync(path.join(home, DIR_NAME)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the machine state is derived, and degraded is never lost', () => {
  it('TEETH: one degraded shell beats any number of healthy ones', () => {
    // The exact inversion the old file produced whenever a healthy shell happened to write last.
    writeOwn(home, { state: 'ready' }, { pid: 1, now: 1 });
    writeOwn(home, { state: 'degraded', phase: 'worker-exit', error: 'boom' }, { pid: 2, now: 2 });
    writeOwn(home, { state: 'ready' }, { pid: 3, now: 3 });
    const agg = readAggregate(home, ALL_ALIVE);
    expect(agg.state).toBe('degraded');
    expect(agg.shells).toBe(3);
    expect(agg.degraded).toBe(1);
    expect(agg.pid, '"which one?" must be answerable, not inferred').toBe(2);
    expect(agg.error).toBe('boom');
  });

  it('all-ready is ready, and reports how many shells backed the answer', () => {
    writeOwn(home, { state: 'ready' }, { pid: 1, now: 1 });
    writeOwn(home, { state: 'ready' }, { pid: 2, now: 2 });
    expect(readAggregate(home, ALL_ALIVE)).toMatchObject({ state: 'ready', shells: 2, degraded: 0 });
  });

  it('TEETH: nothing live is UNKNOWN, never healthy', () => {
    // Reporting "ready" for a machine with no live shell is the empty-corpus lie (#132) wearing a
    // different surface: absence of evidence rendered as evidence of health.
    expect(aggregate([])).toMatchObject({ state: 'unknown', shells: 0 });
    expect(readAggregate(home, ALL_ALIVE).state).toBe('unknown');
  });

  it('a shell still starting is not counted as ready', () => {
    writeOwn(home, { state: 'ready' }, { pid: 1, now: 1 });
    writeOwn(home, { state: 'starting' }, { pid: 2, now: 2 });
    expect(readAggregate(home, ALL_ALIVE).state).toBe('starting');
  });
});

describe('dead shells cannot vote', () => {
  it('TEETH: a dead pid is pruned from disk on read, not trusted', () => {
    // A crashed shell cannot clean up after itself. A reaper that only runs on graceful exit is the
    // failure ADR-027 already paid for with 1,884 undelivered events — so pruning happens on read.
    writeOwn(home, { state: 'degraded', error: 'from a process that no longer exists' }, { pid: 999_001, now: 1 });
    expect(fs.readdirSync(path.join(home, DIR_NAME))).toHaveLength(1);
    expect(readAll(home, NONE_ALIVE)).toEqual([]);
    expect(fs.readdirSync(path.join(home, DIR_NAME)), 'the stale record must be gone from disk').toEqual([]);
  });

  it('a dead degraded shell does not hold the machine hostage', () => {
    writeOwn(home, { state: 'degraded' }, { pid: 999_001, now: 1 });
    writeOwn(home, { state: 'ready' }, { pid: process.pid, now: 2 });
    // Only the live pid survives, so the machine reports what is actually true right now.
    expect(readAggregate(home).state).toBe('ready');
  });

  it('isAlive is honest about the three cases', () => {
    expect(isAlive(process.pid), 'this very process').toBe(true);
    expect(isAlive(999_999_999), 'a pid that cannot exist').toBe(false);
    expect(isAlive(0), 'not a pid').toBe(false);
    // EPERM means the process EXISTS and belongs to someone else — alive, not absent.
    expect(isAlive(1, () => { const e = new Error('x'); e.code = 'EPERM'; throw e; })).toBe(true);
  });

  it('an unreadable record is dropped rather than crashing the read', () => {
    fs.mkdirSync(path.join(home, DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(home, DIR_NAME, `${process.pid}.json`), '{ not json');
    expect(() => readAll(home)).not.toThrow();
    expect(readAll(home)).toEqual([]);
  });
});
