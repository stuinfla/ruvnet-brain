// 4.7.21 review round 3 (Opus r3 P2-1..P2-3): the developer update lock when an owner releases while a contender is
// mid-step. Each interleaving is driven through real worker threads and Atomics barriers; the main thread is the owner.
//
// P2-1: B's publication rename was refused by the owner's lock; the owner released before B looked again, B's
//       fs.existsSync re-check found nothing and B threw a raw ENOTEMPTY out of install/developer-update.
// P2-2: B read the owner's lock, the owner released, owner.json read ENOENT, a new owner published, and B judged that
//       live lock "unknown" and told the user to rm -rf it.
// P2-3: release moves the whole lock aside in one step. Removing owner.json first left an empty directory a
//       contender's publication rename could replace, and the follow-up removal then deleted that live lock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireDeveloperLock, sharedLockStatus } from '../../plugin/scripts/developer-update-lock.mjs';

const MODULE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'developer-update-lock.mjs')).href;
const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const brain = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dulr-'))); roots.push(d); return d; };
const lockDir = brainHome => path.join(brainHome, 'developer-update.lock');
const ownerOf = brainHome => JSON.parse(fs.readFileSync(path.join(lockDir(brainHome), 'owner.json'), 'utf8'));
const litter = brainHome => fs.readdirSync(brainHome).filter(name => name !== 'developer-update.lock');

// B pauses at up to two points, each named by workerData.pauses[i] = [fsFunction, when ('before'|'after'), pathTest].
// Slots: 2i = B reached pause i, 2i+1 = release B from pause i.
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const flags = new Int32Array(workerData.sab); const dir = workerData.dir;
const tests = {
  staged: (p) => String(p).startsWith(dir + '.acquire-'),
  owner: (p) => String(p) === require('node:path').join(dir, 'owner.json'),
  lock: (p) => String(p) === dir,
};
workerData.pauses.forEach(([name, when, test], i) => {
  const real = fs[name]; let fired = false;
  const pause = () => { Atomics.store(flags, 2 * i, 1); Atomics.notify(flags, 2 * i); Atomics.wait(flags, 2 * i + 1, 0, 15000); };
  fs[name] = function (...args) {
    const hit = !fired && tests[test](args[name === 'renameSync' ? 1 : 0]);
    if (hit) fired = true;
    if (hit && when === 'before') pause();
    try { return real.apply(this, args); } finally { if (hit && when === 'after') pause(); }
  };
});
import(workerData.module).then((m) => {
  try { parentPort.postMessage({ token: m.acquireDeveloperLock({ brainHome: workerData.brainHome, token: undefined }).token }); }
  catch (error) { parentPort.postMessage({ refused: error.message, code: error.code }); }
}, (error) => parentPort.postMessage({ error: String(error && error.stack || error) }));`;

function contender(brainHome, pauses) {
  const sab = new SharedArrayBuffer(16), flags = new Int32Array(sab);
  const worker = new Worker(WORKER, { eval: true, workerData: { sab, pauses, dir: lockDir(brainHome), brainHome, module: MODULE } });
  const result = { done: false, value: null };
  worker.once('message', value => { result.value = value; result.done = true; });
  worker.once('error', error => { result.value = { error: String(error) }; result.done = true; });
  return {
    result,
    paused: i => Atomics.load(flags, 2 * i) === 1,
    resume: i => { Atomics.store(flags, 2 * i + 1, 1); Atomics.notify(flags, 2 * i + 1); },
    // For a main thread that must stay synchronous (inside a release()): block until B reaches pause i.
    waitPaused: i => { if (Atomics.wait(flags, 2 * i, 0, 15000) === 'timed-out') throw Error(`B never reached pause ${i}`); },
  };
}
const waitFor = async (predicate, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('timed out waiting for the interleaving');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

describe('developer update lock: the owner releases while a contender is mid-step', () => {
  it('P2-1: the owner releases after refusing B\'s publication: B re-judges and acquires, no raw ENOTEMPTY', async () => {
    const brainHome = brain();
    // Pause 0: B judged the lock idle and is about to publish. Pause 1: B's rename was refused, its staging not yet removed.
    const b = contender(brainHome, [['renameSync', 'before', 'lock'], ['rmSync', 'before', 'staged']]);
    await waitFor(() => b.paused(0) || b.result.done);
    expect(b.result.done, JSON.stringify(b.result.value)).toBe(false);
    const a = acquireDeveloperLock({ brainHome, token: undefined });
    b.resume(0);
    await waitFor(() => b.paused(1) || b.result.done);
    expect(b.result.done, JSON.stringify(b.result.value)).toBe(false);
    a.release();
    b.resume(1);
    await waitFor(() => b.result.done);
    expect(b.result.value.refused, b.result.value.refused).toBeUndefined(); // before: "ENOTEMPTY: directory not empty, rename ..."
    expect(b.result.value.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(ownerOf(brainHome).token).toBe(b.result.value.token);
    expect(litter(brainHome)).toEqual([]);
  }, 40_000);

  it('P2-2: a new owner publishes while B is judging the released lock: B refuses it as running, never "unknown" with rm -rf', async () => {
    const brainHome = brain();
    const a = acquireDeveloperLock({ brainHome, token: undefined });
    // Pause 0: B has lstat'ed A's lock and is about to read owner.json. Pause 1: owner.json read ENOENT, B is about to
    // ask whether the directory exists.
    const b = contender(brainHome, [['readFileSync', 'before', 'owner'], ['existsSync', 'before', 'lock']]);
    await waitFor(() => b.paused(0) || b.result.done);
    expect(b.result.done, JSON.stringify(b.result.value)).toBe(false);
    a.release();
    b.resume(0);
    await waitFor(() => b.paused(1) || b.result.done);
    expect(b.result.done, JSON.stringify(b.result.value)).toBe(false);
    const c = acquireDeveloperLock({ brainHome, token: undefined }); // a new owner publishes, complete, in one rename
    b.resume(1);
    await waitFor(() => b.result.done);
    expect(b.result.value.refused).toMatch(/^developer update lock running; /); // before: "developer update lock unknown; ... rm -rf"
    expect(ownerOf(brainHome).token).toBe(c.token); // C's live lock is untouched
    c.release();
    expect(sharedLockStatus({ brainHome }).state).toBe('idle');
  }, 40_000);

  it('P2-2: the lock is gone when B looks and a new owner\'s lock is there when B checks again: running, never "unknown"', async () => {
    const brainHome = brain();
    const a = acquireDeveloperLock({ brainHome, token: undefined });
    // Pause 0: B is about to lstat the lock. Pause 1: the lstat failed ENOENT, B is about to ask whether it exists.
    const b = contender(brainHome, [['lstatSync', 'before', 'lock'], ['existsSync', 'before', 'lock']]);
    await waitFor(() => b.paused(0) || b.result.done);
    expect(b.result.done, JSON.stringify(b.result.value)).toBe(false);
    a.release();
    b.resume(0);
    await waitFor(() => b.paused(1) || b.result.done);
    expect(b.result.done, JSON.stringify(b.result.value)).toBe(false);
    const c = acquireDeveloperLock({ brainHome, token: undefined });
    b.resume(1);
    await waitFor(() => b.result.done);
    expect(b.result.value.refused).toMatch(/^developer update lock running; /); // before: "developer update lock unknown; ... rm -rf"
    expect(ownerOf(brainHome).token).toBe(c.token);
    c.release();
  }, 40_000);

  it('P2-2: a lock with no owner yet that is seconds old (agentic-kit between mkdir and its owner write) is not offered for removal', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir);
    let message = '';
    try { acquireDeveloperLock({ brainHome, token: undefined }); } catch (error) { message = error.message; }
    expect(message).toBe(`developer update lock is being created by another process; ${dir}. Retry shortly.`); // before: "unknown; ... rm -rf"
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('P2-3: a contender\'s publication landing mid-release survives the release', async () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    // B judges the lock idle and pauses just before its publication rename (pause 0) and again right after it (pause 1).
    const b = contender(brainHome, [['renameSync', 'before', 'lock'], ['renameSync', 'after', 'lock']]);
    await waitFor(() => b.paused(0) || b.result.done);
    expect(b.result.done, JSON.stringify(b.result.value)).toBe(false);
    const a = acquireDeveloperLock({ brainHome, token: undefined });
    // A's release lets B's publication land between A's release steps: right after an owner.json removal (the old
    // unlink-first order) or right before the move-aside (the current one-step order), whichever A reaches first.
    const realUnlink = fs.unlinkSync, realRename = fs.renameSync;
    let landed = false;
    const land = () => { if (landed) return; landed = true; b.resume(0); b.waitPaused(1); };
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file, ...rest) => {
      const out = realUnlink(file, ...rest);
      if (file === path.join(dir, 'owner.json')) land();
      return out;
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to, ...rest) => {
      if (from === dir && String(to).startsWith(`${dir}.released-`)) land();
      return realRename(from, to, ...rest);
    });
    let releaseError = null;
    try { a.release(); } catch (error) { releaseError = error; }
    vi.restoreAllMocks();
    b.resume(1);
    expect(landed).toBe(true);
    await waitFor(() => b.result.done);
    expect(b.result.value.error, b.result.value.error).toBeUndefined();
    if (b.result.value.token) {
      // B owns a lock: it must still be there, B's (before: A's release moved B's freshly published lock aside and deleted it).
      expect(fs.existsSync(path.join(dir, 'owner.json')), `B owns ${b.result.value.token} but its lock is gone; A: ${releaseError?.message}`).toBe(true);
      expect(ownerOf(brainHome).token).toBe(b.result.value.token);
    } else {
      expect(b.result.value.refused).toMatch(/^developer update lock (running|is contended)/);
      expect(releaseError).toBeNull();
      expect(fs.existsSync(dir)).toBe(false);
    }
  }, 40_000);
});
