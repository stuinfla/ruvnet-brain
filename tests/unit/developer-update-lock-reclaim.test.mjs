// WP-B2 (4.7.21, AuditC #9): the developer lock wedged forever on an empty or invalid owner.json ("lock unknown") and
// treated any live process holding a reused pid as the owner. Reclaim is bounded: only an owner that is provably gone
// (dead pid, or a live pid whose process start differs from the recorded one) or unreadable, and only once it is
// STALE_RECLAIM_MS old. Every refusal names the directory and the exact removal command.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireDeveloperLock, sharedLockStatus, processStartOf, STALE_RECLAIM_MS, CLAIM_STALE_MS } from '../../plugin/scripts/developer-update-lock.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const brain = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dul-'))); roots.push(d); return d; };
const lockDir = brainHome => path.join(brainHome, 'developer-update.lock');
const ageDir = (dir, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(dir, t, t); };
const token = 't'.repeat(32);

describe('developer update lock reclaim', () => {
  it('pins the reclaim window at ten minutes', () => expect(STALE_RECLAIM_MS).toBe(600_000));

  it('an empty lock directory 11 minutes old is reclaimed and acquired', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); ageDir(dir, 11 * 60_000);
    expect(sharedLockStatus({ brainHome }).state).toBe('unknown');
    const lock = acquireDeveloperLock({ brainHome });
    expect(lock.inherited).toBe(false);
    expect(sharedLockStatus({ brainHome })).toMatchObject({ state: 'running', owner: { pid: process.pid, token: lock.token } });
    lock.release();
    expect(sharedLockStatus({ brainHome }).state).toBe('idle');
  });

  it('an empty lock directory 2 minutes old is refused, naming the path and the removal command', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); ageDir(dir, 2 * 60_000);
    let message = '';
    try { acquireDeveloperLock({ brainHome }); } catch (error) { message = error.message; }
    expect(message).toMatch(/^developer update lock unknown; /);
    expect(message).toContain(dir);
    expect(message).toContain(process.platform === 'win32' ? `Remove-Item -Recurse -Force "${dir}"` : `rm -rf "${dir}"`);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('an invalid owner.json is judged by the directory age the same way', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), '');
    ageDir(dir, 3 * 60_000);
    expect(() => acquireDeveloperLock({ brainHome })).toThrow(/lock unknown/);
    ageDir(dir, 20 * 60_000);
    acquireDeveloperLock({ brainHome }).release();
  });

  it('a dead owner without startedAt is reclaimed by the directory mtime, and refused while it is young', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, token }));
    ageDir(dir, 60_000);
    expect(() => acquireDeveloperLock({ brainHome, alive: () => false })).toThrow(/lock stale/);
    ageDir(dir, 20 * 60_000);
    acquireDeveloperLock({ brainHome, alive: () => false }).release();
  });

  it('a live pid whose process start differs from the recorded one is a reused pid: reclaimed', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, token, startedAt: new Date(Date.now() - 11 * 60_000).toISOString(), processStart: 'Mon Jan  1 00:00:00 2001' }));
    const status = sharedLockStatus({ brainHome, alive: () => true, startOf: () => 'Sun Oct 26 00:15:00 2026' });
    expect(status).toMatchObject({ state: 'stale', reusedPid: true });
    const lock = acquireDeveloperLock({ brainHome, alive: () => true, startOf: () => 'Sun Oct 26 00:15:00 2026' });
    expect(lock.inherited).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))).toMatchObject({ pid: process.pid, token: lock.token, processStart: 'Sun Oct 26 00:15:00 2026' });
  });

  it('a live pid with the matching process start is the owner: refused as running', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, token, startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), processStart: 'Sun Oct 26 00:15:00 2026' }));
    expect(() => acquireDeveloperLock({ brainHome, alive: () => true, startOf: () => 'Sun Oct 26 00:15:00 2026' })).toThrow(/lock running; .*rm -rf|lock running; .*Remove-Item/);
  });

  it.skipIf(process.platform === 'win32')('records the real process start, and the real ps reading of this process matches it', () => {
    const brainHome = brain();
    const start = processStartOf(process.pid);
    expect(start).toMatch(/\d{2}:\d{2}:\d{2}/);
    const lock = acquireDeveloperLock({ brainHome });
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir(brainHome), 'owner.json'), 'utf8'));
    expect(owner.processStart).toBe(start);
    expect(fs.existsSync(path.join(lockDir(brainHome), 'owner.json.tmp'))).toBe(false);
    expect(sharedLockStatus({ brainHome }).state).toBe('running');
    lock.release();
  });
});

// 4.7.21 review (Codex #1): two contenders judged the same abandoned lock; A reclaimed and acquired, then B moved A's
// FRESH lock aside on its stale judgement and both ran. Takeover is now claimed inside the judged directory and
// re-checked (dev/ino + owner bytes) before the move; owner.json is published with an exclusive link.
describe('developer update lock: concurrent reclaimers', () => {
  const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'developer-update-lock.mjs');
  const ownerOf = brainHome => JSON.parse(fs.readFileSync(path.join(lockDir(brainHome), 'owner.json'), 'utf8'));
  const plantDead = brainHome => {
    const dir = lockDir(brainHome);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 4242, token, startedAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
    ageDir(dir, 11 * 60_000);
  };
  const notDead = pid => pid !== 4242;
  const errorOf = fn => { try { fn(); return null; } catch (error) { return error; } };

  it('B judged a dead owner, A reclaimed and acquired first: B refuses and A keeps its lock', () => {
    const brainHome = brain();
    plantDead(brainHome);
    let a = null, fired = false;
    // alive() runs right after B has read the lock: A's whole acquisition happens there.
    const bAlive = pid => { if (!fired) { fired = true; a = acquireDeveloperLock({ brainHome, alive: notDead }); } return notDead(pid); };
    const bError = errorOf(() => acquireDeveloperLock({ brainHome, alive: bAlive }));
    expect(fired).toBe(true);
    expect(a?.inherited).toBe(false);
    expect(bError?.message).toMatch(/^developer update lock running; /); // before: B took the lock too
    expect(ownerOf(brainHome).token).toBe(a.token);
    expect(fs.readdirSync(lockDir(brainHome))).toEqual(['owner.json']); // B left no claim behind
    a.release();
    expect(sharedLockStatus({ brainHome }).state).toBe('idle');
  });

  it('an empty lock: A acquires inside B\'s takeover window, and exactly one of them owns the lock', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); ageDir(dir, 11 * 60_000);
    const realRename = fs.renameSync;
    let a = null, aError = null, fired = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!fired && from === dir && String(to).startsWith(`${dir}.stale-`)) {
        fired = true;
        try { a = acquireDeveloperLock({ brainHome }); } catch (error) { aError = error; }
      }
      return realRename(from, to);
    });
    let b = null, bError = null;
    try { b = acquireDeveloperLock({ brainHome }); } catch (error) { bError = error; } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    const owners = [a, b].filter(Boolean);
    expect(owners, `A: ${aError?.message} / B: ${bError?.message}`).toHaveLength(1); // before: both owned it
    expect(ownerOf(brainHome).token).toBe(owners[0].token);
    owners[0].release();
  });

  it('an owner that publishes after this process judged the lock free wins: the publication rename refuses, no overwrite', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    const foreign = { pid: process.pid, token: 'f'.repeat(32), startedAt: new Date().toISOString(), processStart: processStartOf(process.pid) };
    const realRename = fs.renameSync;
    let fired = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!fired && to === dir) { fired = true; fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(foreign)); }
      return realRename(from, to);
    });
    let error = null;
    try { acquireDeveloperLock({ brainHome }); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    expect(error?.message).toMatch(/^developer update lock running; /); // before: the foreign owner was overwritten
    expect(ownerOf(brainHome).token).toBe(foreign.token);
    expect(fs.readdirSync(brainHome).filter(name => name !== 'developer-update.lock')).toEqual([]); // staging removed
  });

  it.skipIf(process.platform === 'win32')('a mkdir-then-write owner (agentic-kit) caught between its two steps cannot also own the lock', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    const realRename = fs.renameSync;
    let kitError = null, fired = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (fired || to !== dir) return realRename(from, to);
      fired = true;
      fs.mkdirSync(dir); // Kit's atomic mkdir succeeded; its owner write has not happened yet
      const result = realRename(from, to); // POSIX replaces an EMPTY directory
      try { fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 1, token: 'k'.repeat(32) }), { flag: 'wx' }); }
      catch (error) { kitError = error; }
      return result;
    });
    let lock;
    try { lock = acquireDeveloperLock({ brainHome }); } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    expect(kitError?.code).toBe('EEXIST'); // Kit's exclusive owner write refuses: one owner
    expect(ownerOf(brainHome).token).toBe(lock.token);
    lock.release();
  });

  it('while one reclaimer holds the claim, a second one refuses instead of racing it', () => {
    const brainHome = brain();
    plantDead(brainHome);
    let second = null;
    const a = acquireDeveloperLock({ brainHome, alive: notDead,
      afterTakeoverClaim: () => { second = errorOf(() => acquireDeveloperLock({ brainHome, alive: notDead })); } });
    expect(second?.message).toMatch(/^developer update lock is being reclaimed by another process; /);
    expect(ownerOf(brainHome).token).toBe(a.token);
    a.release();
  });

  it('a claim left by a crashed reclaimer is superseded once older than the claim window', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    plantDead(brainHome);
    const claim = path.join(dir, 'takeover.json');
    fs.writeFileSync(claim, '{}');
    expect(() => acquireDeveloperLock({ brainHome, alive: notDead })).toThrow(/being reclaimed by another process/);
    const old = (Date.now() - CLAIM_STALE_MS - 60_000) / 1000;
    fs.utimesSync(claim, old, old);
    const lock = acquireDeveloperLock({ brainHome, alive: notDead });
    expect(ownerOf(brainHome).token).toBe(lock.token);
    lock.release();
  });

  it('a reclaimer that dies holding its claim does not restart the owner-less lock\'s age (Opus r2 #6)', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    fs.mkdirSync(dir); ageDir(dir, 11 * 60_000);
    const crashed = errorOf(() => acquireDeveloperLock({ brainHome, afterTakeoverClaim: () => { throw Error('killed after claiming'); } }));
    expect(crashed?.message).toBe('killed after claiming');
    expect(fs.readdirSync(dir)).toEqual(['takeover.json']);
    const ageMs = Date.now() - fs.lstatSync(dir).mtimeMs;
    expect(ageMs).toBeGreaterThan(10 * 60_000); // before: ~0, the claim write had reset it
    expect(ageMs).toBeLessThan(12 * 60_000);
    const old = (Date.now() - CLAIM_STALE_MS - 60_000) / 1000;
    fs.utimesSync(path.join(dir, 'takeover.json'), old, old);
    const lock = acquireDeveloperLock({ brainHome }); // before: refused "lock unknown" for another ten minutes
    expect(ownerOf(brainHome).token).toBe(lock.token);
    lock.release();
  });

  it('the judged lock vanishing before the claim is re-judged, not thrown (Fable r2 P3-1)', () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    plantDead(brainHome);
    const realReaddir = fs.readdirSync;
    let fired = false;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...rest) => {
      if (!fired && target === dir) { fired = true; fs.renameSync(dir, `${dir}.stale-other`); fs.rmSync(`${dir}.stale-other`, { recursive: true }); }
      return realReaddir(target, ...rest);
    });
    let lock = null, error = null;
    try { lock = acquireDeveloperLock({ brainHome, alive: notDead }); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    expect(error?.message).toBeUndefined(); // before: ENOENT: no such file or directory, scandir
    expect(ownerOf(brainHome).token).toBe(lock.token);
    lock.release();
  });

  it('six processes released together on one dead lock: exactly one owns it', async () => {
    const brainHome = brain();
    plantDead(brainHome);
    const barrier = path.join(brainHome, 'go');
    const script = `
      import fs from 'node:fs';
      const m = await import(${JSON.stringify(MODULE)});
      while (!fs.existsSync(${JSON.stringify(barrier)})) { /* barrier */ }
      try {
        const lock = m.acquireDeveloperLock({ brainHome: ${JSON.stringify(brainHome)}, alive: (pid) => pid !== 4242, startOf: () => null });
        console.log('OWNED ' + lock.token);
      } catch (error) { console.log('REFUSED ' + error.message); }`;
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const outputs = children.map(child => new Promise(resolve => {
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('exit', () => resolve(out.trim()));
    }));
    await new Promise(resolve => setTimeout(resolve, 400));
    fs.writeFileSync(barrier, '');
    const results = await Promise.all(outputs);
    const owned = results.filter(line => line.startsWith('OWNED '));
    expect(owned, results.join('\n')).toHaveLength(1);
    expect(results.filter(line => line.startsWith('REFUSED ')), results.join('\n')).toHaveLength(5);
    expect(ownerOf(brainHome).token).toBe(owned[0].slice('OWNED '.length));
  }, 30_000);
});

// 4.7.21 review round 4 (Codex #1): a lock directory that existed before its owner record could be judged owner-less
// and old by a reclaimer, claimed and re-checked (still owner-less: the same), and then moved aside together with the
// owner the first process published in between. Both ran. Two worker threads drive that interleaving through
// barriers: A stops at its publication step, B (whose clock is 11 minutes ahead) stops just before moving the lock
// aside. The lock is now published fully populated by one rename, so no owner-less moment exists to be judged.
describe('developer update lock: publication cannot be split by a takeover', () => {
  const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'developer-update-lock.mjs');
  const ownerOf = brainHome => JSON.parse(fs.readFileSync(path.join(lockDir(brainHome), 'owner.json'), 'utf8'));
  // Slots: 0 = B reached its move-aside, 1 = release B, 2 = A reached its publication, 3 = release A.
  const WORKER = `
    const { workerData, parentPort } = require('node:worker_threads');
    const fs = require('node:fs'); const path = require('node:path');
    const flags = new Int32Array(workerData.sab); const dir = workerData.dir;
    const pause = (reached, release) => { Atomics.store(flags, reached, 1); Atomics.notify(flags, reached); Atomics.wait(flags, release, 0, 15000); };
    let fired = false;
    if (workerData.role === 'B') {
      const real = fs.renameSync;
      fs.renameSync = function (from, to) {
        if (!fired && from === dir && String(to).startsWith(dir + '.stale-')) { fired = true; pause(0, 1); }
        return real.apply(this, arguments);
      };
    } else {
      // A's publication step: the owner write into the lock (mkdir-then-write) or the rename that publishes it.
      const realWrite = fs.writeFileSync, realRename = fs.renameSync;
      fs.writeFileSync = function (file) {
        if (!fired && String(file).startsWith(dir + path.sep + 'owner.json')) { fired = true; pause(2, 3); }
        return realWrite.apply(this, arguments);
      };
      fs.renameSync = function (from, to) {
        if (!fired && to === dir) { fired = true; pause(2, 3); }
        return realRename.apply(this, arguments);
      };
    }
    import(workerData.module).then((m) => {
      try {
        const lock = m.acquireDeveloperLock({ brainHome: workerData.brainHome, now: Date.now() + workerData.skewMs, startOf: () => 'same-process' });
        parentPort.postMessage({ token: lock.token });
      } catch (error) { parentPort.postMessage({ refused: error.message }); }
    }, (error) => parentPort.postMessage({ error: String(error && error.stack || error) }));`;
  const waitFor = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw Error('timed out waiting for the interleaving');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };

  it('A is mid-publication when B judges the lock owner-less and old: exactly one owns it, and it is the recorded owner', async () => {
    const brainHome = brain(), dir = lockDir(brainHome);
    const sab = new SharedArrayBuffer(16), flags = new Int32Array(sab);
    const start = (role, skewMs) => {
      const worker = new Worker(WORKER, { eval: true, workerData: { role, sab, dir, brainHome, skewMs, module: pathToFileURL(MODULE).href } });
      const result = { done: false, value: null };
      worker.once('message', value => { result.value = value; result.done = true; });
      worker.once('error', error => { result.value = { error: String(error) }; result.done = true; });
      return result;
    };
    const a = start('A', 0);
    await waitFor(() => Atomics.load(flags, 2) === 1 || a.done);
    const b = start('B', 11 * 60_000);
    await waitFor(() => Atomics.load(flags, 0) === 1 || b.done);
    Atomics.store(flags, 3, 1); Atomics.notify(flags, 3);
    await waitFor(() => a.done);
    Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
    await waitFor(() => b.done);
    expect(a.value.error, a.value.error).toBeUndefined();
    expect(b.value.error, b.value.error).toBeUndefined();
    const owners = [a.value, b.value].filter(value => value.token);
    expect(owners, JSON.stringify({ a: a.value, b: b.value })).toHaveLength(1); // before: both A and B held tokens
    expect(ownerOf(brainHome).token).toBe(owners[0].token);
    expect(fs.readdirSync(brainHome).filter(name => name !== 'developer-update.lock')).toEqual([]); // no staging or tomb litter
  }, 40_000);
});
