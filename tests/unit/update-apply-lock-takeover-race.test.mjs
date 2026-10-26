/**
 * The Stable Spine lock under concurrent reclaimers (4.7.21 review: Codex #1 applied to update-apply.mjs, then round 2/4).
 *
 * Real worker threads drive each interleaving through barriers; exactly one run may own the lock.
 *
 * 1. Publication split (Codex r4 #1): A had created LOCK but not yet published its owner; B judged that owner-less
 *    directory as debris past the grace, claimed it, re-checked it (still owner-less: "the same"), and moved it aside
 *    together with the owner A published meanwhile. Both applied. LOCK is now published complete by one rename.
 * 2. Stale judgement (Opus r2 #1): B judges the debris D1 and pauses before claiming; A reclaims D1 and owns a fresh D2;
 *    B then claims INSIDE D2. Only the dev/ino + owner-bytes re-check stops B moving A's live lock. The earlier test
 *    never reached this point (B's claim bumped LOCK's mtime, so A stopped at the grace), and passed with the re-check
 *    deleted; this one fails when it is deleted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'update-apply.mjs');
const homes = [];
afterEach(() => homes.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// Slots: 0 = B paused, 1 = release B, 2 = A paused, 3 = release A. Each role pauses once, at workerData.pauseAt.
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs'); const path = require('node:path');
const flags = new Int32Array(workerData.sab);
const lock = workerData.lock;
const [reached, release] = workerData.role === 'B' ? [0, 1] : [2, 3];
const pause = () => { Atomics.store(flags, reached, 1); Atomics.notify(flags, reached); Atomics.wait(flags, release, 0, 15000); };
let fired = false;
const hook = (name, when) => { const real = fs[name]; fs[name] = function (...args) { if (!fired && when(...args)) { fired = true; pause(); } return real.apply(this, args); }; };
if (workerData.pauseAt === 'move-aside') hook('renameSync', (from, to) => from === lock && String(to).startsWith(lock + '.stale-'));
if (workerData.pauseAt === 'publish') {
  hook('writeFileSync', (file) => String(file).startsWith(lock + path.sep + 'owner.json')); // mkdir, then write the owner
  hook('renameSync', (from, to) => to === lock); // or: one rename publishes the populated lock
}
if (workerData.pauseAt === 'claim') hook('readdirSync', (dir) => dir === lock); // judged, not yet claimed
if (workerData.pauseAt === 'publish-failed') hook('rmSync', (dir) => String(dir).startsWith(lock + '.acquire-')); // rename refused, staging not yet removed
import(workerData.module).then((m) => parentPort.postMessage({ acquired: Boolean(m.acquireLock('race-' + workerData.role).acquired) }),
  (error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
`;

const waitFor = async (predicate, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the interleaving');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
function harness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-race-'));
  homes.push(home);
  const lock = path.join(home, '.update.lock');
  const sab = new SharedArrayBuffer(16);
  const flags = new Int32Array(sab);
  const env = { ...process.env, RUVNET_BRAIN_HOME: home, RUVNET_BRAIN_IMPORT_ONLY: 'update-shell-test' };
  const start = (role, pauseAt) => {
    const worker = new Worker(WORKER, { eval: true, env, workerData: { role, pauseAt, sab, lock, module: pathToFileURL(ENGINE).href } });
    const result = { done: false, value: null };
    worker.once('message', (value) => { result.value = value; result.done = true; });
    worker.once('error', (error) => { result.value = { error: String(error) }; result.done = true; });
    return result;
  };
  const paused = (slot) => Atomics.load(flags, slot) === 1;
  const resume = (slot) => { Atomics.store(flags, slot, 1); Atomics.notify(flags, slot); };
  return { home, lock, start, paused, resume };
}
const age = (target, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(target, t, t); };
const expectOneOwner = (lock, a, b) => {
  expect(a.value.error, a.value.error).toBeUndefined();
  expect(b.value.error, b.value.error).toBeUndefined();
  const owners = [['A', a.value], ['B', b.value]].filter(([, value]) => value.acquired);
  expect(owners.map(([role]) => role), JSON.stringify({ a: a.value, b: b.value })).toHaveLength(1); // before: both acquired
  const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  expect(owner.target).toBe(`race-${owners[0][0]}`);
  return owners[0][0];
};

describe('update-apply lock: two concurrent runs', () => {
  it('A is mid-publication when B judges the lock owner-less and past the grace: exactly one run owns it', async () => {
    const { home, lock, start, paused, resume } = harness();
    const a = start('A', 'publish');
    await waitFor(() => paused(2) || a.done);
    if (fs.existsSync(lock)) age(lock, 5 * 60_000); // A's owner-less directory has outlived the publication grace
    const b = start('B', 'move-aside');
    await waitFor(() => paused(0) || b.done);
    resume(3);
    await waitFor(() => a.done);
    resume(1);
    await waitFor(() => b.done);
    expectOneOwner(lock, a, b);
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.update.lock.'))).toEqual([]); // no staging or tomb left
  }, 40_000);

  it('B judged the debris, A reclaimed it and owns a fresh lock, B claims inside A\'s lock: the re-check refuses B', async () => {
    const { lock, start, paused, resume } = harness();
    fs.mkdirSync(lock); // debris: an unreadable owner from a run killed long ago
    fs.writeFileSync(path.join(lock, 'owner.json'), '');
    age(path.join(lock, 'owner.json'), 5 * 60_000); age(lock, 5 * 60_000);
    const b = start('B', 'claim');
    await waitFor(() => paused(0) || b.done);
    expect(b.done, JSON.stringify(b.value)).toBe(false); // B must be holding a stale judgement of the debris
    const a = start('A', 'none');
    await waitFor(() => a.done);
    expect(a.value).toEqual({ acquired: true });
    resume(1);
    await waitFor(() => b.done);
    expect(expectOneOwner(lock, a, b)).toBe('A'); // without the re-check: B moved A's live lock aside and both applied
    expect(fs.readdirSync(lock)).toEqual(['owner.json']); // B's claim is gone from A's lock
  }, 40_000);
});

describe('update-apply lock: a takeover claim', () => {
  it('a run killed while holding its claim does not restart the publication grace (Opus r2 #6)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-claim-'));
    homes.push(home);
    const lock = path.join(home, '.update.lock');
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), '');
    age(path.join(lock, 'owner.json'), 5 * 60_000); age(lock, 5 * 60_000);
    // The run claims, then dies at its re-check (its next read of the lock's owner).
    const script = `
      const fs = require('node:fs'); const path = require('node:path');
      const real = fs.readFileSync; let reads = 0;
      fs.readFileSync = function (file) { if (String(file).endsWith(path.join('.update.lock', 'owner.json')) && ++reads === 2) process.exit(9); return real.apply(this, arguments); };
      import(${JSON.stringify(pathToFileURL(ENGINE).href)}).then((m) => { m.acquireLock('killed'); process.exit(0); });`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8',
      env: { ...process.env, RUVNET_BRAIN_HOME: home, RUVNET_BRAIN_IMPORT_ONLY: 'update-shell-test' } });
    expect(r.status, r.stderr).toBe(9);
    expect(fs.readdirSync(lock).sort()).toEqual(['owner.json', 'takeover.json']);
    const ageMs = Date.now() - fs.lstatSync(lock).mtimeMs;
    expect(ageMs).toBeGreaterThan(4 * 60_000); // before: ~0, the claim write had reset the grace clock
    expect(ageMs).toBeLessThan(6 * 60_000);
  });

  it('the judged lock vanishing before the claim is re-judged, not thrown (Fable r2 P3-1)', async () => {
    const { lock, start, paused, resume } = harness();
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), '');
    age(path.join(lock, 'owner.json'), 5 * 60_000); age(lock, 5 * 60_000);
    const b = start('B', 'claim');
    await waitFor(() => paused(0) || b.done);
    fs.rmSync(lock, { recursive: true }); // another run moved the judged debris away and has not re-locked yet
    resume(1);
    await waitFor(() => b.done);
    expect(b.value).toEqual({ acquired: true }); // before: ENOENT: scandir out of acquireLock
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).target).toBe('race-B');
  }, 40_000);
});

// Opus r3 P2-1: a publication rename refused because a holder was there, and the holder released before the refusal was
// looked at again. The run re-checked fs.existsSync(LOCK), found nothing, and rethrew the raw ENOTEMPTY: main exited 1
// instead of BUSY_EXIT 75 (the reviewer's stress run: 7 of 8 runs crashed this way). A refused publication is contention
// whatever is there a moment later; the run re-observes, and a vanished lock is simply tried again.
describe('update-apply lock: the holder releases while a publication is being refused', () => {
  it('the refused run re-judges and acquires the freed lock instead of throwing ENOTEMPTY', async () => {
    const { home, lock, start, paused, resume } = harness();
    fs.mkdirSync(lock); // a live holder's populated lock
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, target: 'holder', token: 'h'.repeat(32) }));
    const b = start('B', 'publish-failed');
    await waitFor(() => paused(0) || b.done);
    expect(b.done, JSON.stringify(b.value)).toBe(false); // B's rename was refused by the holder's lock
    fs.renameSync(lock, `${lock}.released-holder`); fs.rmSync(`${lock}.released-holder`, { recursive: true }); // the holder releases
    resume(1);
    await waitFor(() => b.done);
    expect(b.value).toEqual({ acquired: true }); // before: { error: 'Error: ENOTEMPTY: directory not empty, rename ...' }
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).target).toBe('race-B');
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.update.lock.'))).toEqual([]); // no staging left
  }, 40_000);

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a staging directory that cannot be created is a real error, not "busy"', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-perm-'));
    homes.push(home);
    fs.chmodSync(home, 0o500);
    try {
      const script = `import(${JSON.stringify(pathToFileURL(ENGINE).href)}).then((m) => { try { console.log(JSON.stringify(m.acquireLock('perm'))); } catch (e) { console.log('THREW ' + e.code); } });`;
      const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8',
        env: { ...process.env, RUVNET_BRAIN_HOME: home, RUVNET_BRAIN_IMPORT_ONLY: 'update-shell-test' } });
      expect(r.stdout.trim(), r.stderr).toBe('THREW EACCES'); // a fix that called every publication failure contention would say busy here
    } finally { fs.chmodSync(home, 0o700); }
  });
});

