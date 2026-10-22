// learn-capture under load (measured 2026-10-21: 1,162 ledger rows, 826 from this one hook — hundreds of concurrent
// detached `ruflo memory store` children timing out against each other, duplicates logged as failures, a child that
// could not find the ruflo its parent had already found). Each case below fails on the code before this change.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, tmp } from '../helpers/continuity-fixture.mjs';
import { slowRuflo, ledgerRows, storedRows, presetRows, until } from '../helpers/slow-ruflo.mjs';
import { acquireObserveSlot, releaseObserveSlot, recentlyCaptured, markCaptured, OBSERVE_SLOTS, SLOT_STALE_MS, COALESCE_MS, SHED_ERROR } from '../../plugin/scripts/learn-capture.mjs';
import { recordLearningObservation, observationKey } from '../../plugin/scripts/learning-store.mjs';
import { learningContext } from '../../plugin/scripts/runtime-preferences.mjs';
import { createHash } from 'node:crypto';
import { recordHookFailure, failureLine, REPEAT_WINDOW_MS } from '../../plugin/scripts/hook-failures.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const LEARN = path.join(ROOT, 'plugin/scripts/learn-capture.mjs');
const posix = process.platform !== 'win32';
afterEach(() => cleanup());

/** A user-scope learner with persisted consent, a stub ruflo and its own Brain home (the N1 fixture shape). */
function learner(opts) {
  const home = fs.realpathSync.native(tmp('load-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'global-memory', '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db'), '');
  fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}');
  const stubDir = tmp('load-ruflo-'); const stub = slowRuflo(stubDir, opts); const brainHome = tmp('load-bh-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, RUVNET_LEARNING_SCOPE: 'user',
    RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain') };
  return { home, stub, stubDir, brainHome, env };
}
const payload = (command, session = 'load') => ({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok' } });

/** Run captureLearning(detach) in a separate parent process, handing it the ruflo path the way session-snapshot does. */
function drive(l, payloads, binary) {
  const code = `import { captureLearning } from ${JSON.stringify(pathToFileURL(LEARN).href)};
    process.stdout.write(JSON.stringify(${JSON.stringify(payloads)}.map((p) => captureLearning(p, { env: process.env, binary: ${JSON.stringify(binary)}, brainHome: ${JSON.stringify(l.brainHome)}, detach: true }))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: l.env, cwd: l.home, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const slotPids = (brainHome) => fs.readdirSync(path.join(brainHome, 'learn-capture', 'slots')).map((n) => JSON.parse(fs.readFileSync(path.join(brainHome, 'learn-capture', 'slots', n), 'utf8')).pid);

describe('1. a duplicate key holding the identical observation is success, a different one is not', () => {
  it.skipIf(!posix)('the second store of the same (session, tool, action) returns alreadyStored instead of throwing', () => {
    const l = learner();
    const context = learningContext({ env: l.env });
    expect(context.enabled).toBe(true);
    const o = { tool: 'Bash', action: 'npm test', session: 'dup' };
    expect(recordLearningObservation(l.stub.bin, context, o, { env: l.env }).alreadyStored).toBeUndefined();
    expect(recordLearningObservation(l.stub.bin, context, o, { env: l.env }).alreadyStored).toBe(true); // stub refuses with --no-upsert, readback is exact
    expect(l.stub.calls().filter((c) => c.argv[1] === 'store')).toHaveLength(2);
  }, 30_000);
  it.skipIf(!posix)('a key already holding DIFFERENT bytes stays a failure that says so', () => {
    const l = learner();
    const context = learningContext({ env: l.env });
    const key = observationKey({ session: 'dup2', tool: 'Bash', action: 'npm test' });
    presetRows(l.stubDir, { [`learning-observations/${key}`]: '{"other":true}' });
    expect(() => recordLearningObservation(l.stub.bin, context, { tool: 'Bash', action: 'npm test', session: 'dup2' }, { env: l.env })).toThrow(/different observation/);
  }, 30_000);
});

describe('2. at most OBSERVE_SLOTS detached children; the rest are shed and counted, one ledger row per window', () => {
  it.skipIf(!posix)('4 distinct observations against a 2.5 s ruflo: 2 children run, 2 are shed, one aggregated row', async () => {
    const l = learner({ delayMs: 2500 });
    expect(OBSERVE_SLOTS).toBe(2);
    const outcome = drive(l, ['npm test', 'npm run', 'npm install', 'npm ci'].map((c) => payload(c)), l.stub.bin);
    expect(outcome).toEqual([true, true, false, false]);
    const pids = slotPids(l.brainHome);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(alive(pid), `slot pid ${pid} is a live child`).toBe(true);
    // Every shed is recorded; the ledger's own window keeps them on ONE row and SessionStart reports the true total.
    expect(ledgerRows(l.brainHome)).toEqual([expect.objectContaining({ hook: 'learn-capture', event: 'PostToolUse', error: SHED_ERROR })]);
    expect(fs.existsSync(path.join(l.brainHome, 'learn-capture', 'shed.json'))).toBe(false);
    expect(await until(() => Object.keys(storedRows(l.stubDir)).length === 2, 15_000)).toBe(true);
    expect(await until(() => fs.readdirSync(path.join(l.brainHome, 'learn-capture', 'slots')).length === 0, 10_000), 'children release their slots').toBe(true);
    expect(ledgerRows(l.brainHome)).toHaveLength(1); // the two stores succeeded; shedding stayed one row
    expect(failureLine(l.brainHome)).toMatch(/\] 2 advisory hook run\(s\).*learn-capture ×2 \(shed observation \(load\)\)/); // both sheds counted
  }, 40_000);

  it('a slot held by a dead pid, or older than SLOT_STALE_MS, is reclaimed; a live fresh one is not', () => {
    const brainHome = tmp('slot-bh-');
    const dir = path.join(brainHome, 'learn-capture', 'slots'); fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'slot-0'), JSON.stringify({ pid: 2 ** 22 - 1, at: now }));               // no such process
    fs.writeFileSync(path.join(dir, 'slot-1'), JSON.stringify({ pid: process.pid, at: now - SLOT_STALE_MS - 1 })); // alive but too old
    expect(acquireObserveSlot(brainHome, now)).toBe(path.join(dir, 'slot-0'));
    expect(acquireObserveSlot(brainHome, now)).toBe(path.join(dir, 'slot-1'));
    expect(acquireObserveSlot(brainHome, now)).toBeNull(); // both now live (this pid) and fresh
    releaseObserveSlot(path.join(dir, 'slot-0'));
    expect(acquireObserveSlot(brainHome, now)).toBe(path.join(dir, 'slot-0'));
    releaseObserveSlot(path.join(dir, 'slot-1'), 12345); // not the holder: nothing happens
    expect(fs.existsSync(path.join(dir, 'slot-1'))).toBe(true);
  });
});

describe('3. parent-side coalescing: an identical key inside the window spawns nothing', () => {
  it('markCaptured makes recentlyCaptured true inside COALESCE_MS and false after it; the directory stays bounded', () => {
    const brainHome = tmp('coalesce-bh-');
    const key = observationKey({ session: 's', tool: 'Bash', action: 'npm test' });
    expect(recentlyCaptured(brainHome, key)).toBe(false);
    markCaptured(brainHome, key);
    expect(recentlyCaptured(brainHome, key)).toBe(true);
    expect(recentlyCaptured(brainHome, key, Date.now() + COALESCE_MS + 1)).toBe(false);
    const dir = path.join(brainHome, 'learn-capture', 'recent');
    for (let i = 0; i < 300; i += 1) fs.writeFileSync(path.join(dir, `old-${i}`), '');
    const old = Date.now() - COALESCE_MS - 1000;
    for (const n of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, n), old / 1000, old / 1000);
    markCaptured(brainHome, 'fresh');
    expect(fs.readdirSync(dir)).toEqual(['fresh']);
  });
  it.skipIf(!posix)('the real hook fired 20 times with one command reaches ruflo once', () => {
    const l = learner();
    const env = { ...l.env, RUFLO_BIN: l.stub.bin };
    for (let i = 0; i < 20; i += 1) expect(spawnSync(process.execPath, [LEARN], { env, encoding: 'utf8', timeout: 20_000, input: JSON.stringify(payload('npm test')) }).status).toBe(0);
    expect(l.stub.calls().filter((c) => c.argv[1] === 'store')).toHaveLength(1);
    expect(Object.keys(storedRows(l.stubDir))).toHaveLength(1);
    expect(ledgerRows(l.brainHome)).toEqual([]);
  }, 120_000);
});

describe('4. the child receives the parent\'s resolved ruflo through RUFLO_BIN', () => {
  it.skipIf(!posix)('with no RUFLO_BIN and an empty PATH the detached child still stores through the binary the parent resolved', async () => {
    const l = learner();
    delete l.env.RUFLO_BIN; l.env.PATH = ''; // the child cannot resolve ruflo on its own (HOME has no ~/.npm-global)
    expect(drive(l, [payload('npm test')], l.stub.bin)).toEqual([true]);
    expect(await until(() => l.stub.calls().some((c) => c.argv[1] === 'retrieve'), 15_000)).toBe(true);
    expect(ledgerRows(l.brainHome)).toEqual([]);
  }, 30_000);
});

describe('5. the ledger counts repeats of one failure inside a window on one row, keeps distinct errors, stays readable', () => {
  it('5 identical failures = 1 row; a later one closes the window as a count row and opens a new one', () => {
    const brainHome = tmp('agg-bh-');
    const t0 = Date.parse('2026-10-21T12:00:00Z');
    const fail = (error, at) => recordHookFailure({ hook: 'learn-capture', event: 'PostToolUse', error }, { brainHome, now: t0 + at });
    for (let i = 0; i < 5; i += 1) fail(`ruflo memory store refused the observation: [ERROR] key "workflow-${i}abcdef0123456789abcdef" already exists`, i * 1000);
    fail('ruflo not found', 2000);
    expect(ledgerRows(brainHome).map((r) => [r.error.slice(0, 20), r.count])).toEqual([['ruflo memory store r', undefined], ['ruflo not found', undefined]]);
    fail('ruflo memory store refused the observation: [ERROR] key "workflow-ffffffffffffffffffff" already exists', REPEAT_WINDOW_MS + 1);
    const rows = ledgerRows(brainHome);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toMatchObject({ hook: 'learn-capture', count: 4, since: new Date(t0).toISOString() });
    expect(rows[2].error).toMatch(/"workflow-\*" already exists \(repeated\)$/);
    expect(rows[3].error).toContain('workflow-ffff');
    const line = failureLine(brainHome, { now: t0 + REPEAT_WINDOW_MS + 2 });
    expect(line).toMatch(/\] 7 advisory hook run\(s\)/); // 1 + 4 repeats + ruflo not found + the new first row
    expect(line).toMatch(/learn-capture ×7 \(ruflo memory store refused the observati, ruflo not found\)/); // two reasons, the count row adds none
  });
  it('short numbers stay verbatim: exit 1 and exit 137 are distinct rows; long ids and hashes collapse', () => {
    const brainHome = tmp('agg-exit-bh-');
    for (const error of ['exit 1', 'exit 137', 'exit 1', 'pid 48213 timed out', 'pid 90117 timed out']) recordHookFailure({ hook: 'x', event: 'Stop', error }, { brainHome });
    expect(ledgerRows(brainHome).map((r) => r.error)).toEqual(['exit 1', 'exit 137', 'pid 48213 timed out']);
    expect(failureLine(brainHome)).toMatch(/\] 5 advisory hook run\(s\)/);
  });
  it('a window file of the wrong shape is treated as empty: recording keeps working and the reader does not throw', () => {
    for (const bad of ['"str"', '[1,2]', '42', 'null', '{"x":null}', '{"a":{"at":"x","count":1},"b":{"at":1,"count":"2"},"c":[1]}']) {
      const brainHome = tmp('agg-bad-bh-');
      fs.writeFileSync(path.join(brainHome, 'hook-failures.window.json'), bad);
      expect(recordHookFailure({ hook: 'x', event: 'Stop', error: 'boom' }, { brainHome }), bad).toBe(true);
      expect(recordHookFailure({ hook: 'x', event: 'Stop', error: 'boom' }, { brainHome }), bad).toBe(true);
      expect(ledgerRows(brainHome), bad).toHaveLength(1);
      expect(() => failureLine(brainHome), bad).not.toThrow();
      expect(failureLine(brainHome, { advance: false }), bad).toBe(''); // the summary advanced; the file was rewritten as a valid window file
      expect(JSON.parse(fs.readFileSync(path.join(brainHome, 'hook-failures.window.json'), 'utf8')), bad).toEqual({});
    }
  });
  it('entries a Date cannot hold, non-integer or zero counts, and missing hook/error are dropped; the legitimate ones are kept and reported', () => {
    const brainHome = tmp('agg-badentry-bh-');
    const now = Date.now();
    const good = { at: now - 1000, count: 3, hook: 'checkpoint', event: 'SessionEnd', error: 'store failed: timed out' };
    const bad = { hook: 'x', event: 'Stop', error: 'bad' };
    fs.writeFileSync(path.join(brainHome, 'hook-failures.window.json'), JSON.stringify({
      ok: good, neg: { ...bad, at: -1e300, count: 3 }, huge: { ...bad, at: 1e300, count: 3 }, never: { ...bad, at: 8.64e15 + 1, count: 3 },
      frac: { ...bad, at: now, count: 2.5 }, zero: { ...bad, at: now, count: 0 }, nohook: { at: now, count: 2, error: 'e' }, noerror: { at: now, count: 2, hook: 'x' },
    }));
    expect(recordHookFailure({ hook: 'other', event: 'Stop', error: 'fresh' }, { brainHome, now })).toBe(true);
    const kept = JSON.parse(fs.readFileSync(path.join(brainHome, 'hook-failures.window.json'), 'utf8'));
    expect(Object.keys(kept).sort()).toEqual(['ok', createHash('sha256').update('other\0Stop\0fresh').digest('hex').slice(0, 16)].sort());
    let line; expect(() => { line = failureLine(brainHome, { now }); }).not.toThrow();
    expect(line).toMatch(/\] 3 advisory hook run\(s\).*checkpoint ×2 \(store failed: timed out\).*other ×1/); // fresh ×1 + the kept window's 2 repeats (its first row predates this fixture)
  });
  it('a first row that cannot be appended leaves no window claiming it was written', () => {
    const brainHome = tmp('agg-noappend-bh-');
    fs.mkdirSync(path.join(brainHome, 'hook-failures.jsonl')); // a directory where the ledger should be: appendFileSync throws
    expect(recordHookFailure({ hook: 'x', event: 'Stop', error: 'boom' }, { brainHome })).toBe(false);
    let windows = {}; try { windows = JSON.parse(fs.readFileSync(path.join(brainHome, 'hook-failures.window.json'), 'utf8')); } catch { /* never written */ }
    expect(windows).toEqual({});
  });
  it('SessionStart reports the repeats still inside an open window', () => {
    const brainHome = tmp('agg-open-bh-');
    for (let i = 0; i < 3; i += 1) recordHookFailure({ hook: 'checkpoint', event: 'SessionEnd', error: 'store failed: timed out' }, { brainHome });
    expect(ledgerRows(brainHome)).toHaveLength(1);
    expect(failureLine(brainHome)).toMatch(/\] 3 advisory hook run\(s\).*checkpoint ×3 \(store failed: timed out\)/);
    expect(ledgerRows(brainHome)).toHaveLength(2);
    expect(failureLine(brainHome)).toBe('');
  });
});
