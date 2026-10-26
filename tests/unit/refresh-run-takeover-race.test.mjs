/**
 * Refresh-lock takeover under contention (4.7.21 review fixes).
 *
 * Opus updater #2: an owner recorded under another hostname and older than 3 h was declared dead without looking
 * at its pid. On macOS the hostname follows the Wi-Fi, so a laptop that slept mid-update lost its lock to a second
 * updater and two runs wrote the same kb/. A remote-host owner whose pid is live HERE with the same process start
 * and executable is now the owner.
 *
 * Codex #1: two contenders judged the same abandoned lock; A reclaimed and acquired, then B removed A's FRESH lock
 * on its stale judgement and both ran. Takeover now holds an exclusive claim inside the judged directory and
 * re-checks the directory identity and owner bytes before moving it. The interleavings below are driven through
 * `now` (called after B has read the lock and before it acts, in the old code and the new) and through the
 * takeover-claim hook, plus one real multi-process race released by a barrier.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRefreshLock, refreshLockPath, releaseRefreshLock, CLAIM_STALE_MS } from '../../kb/refresh-run.mjs';

const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'kb', 'refresh-run.mjs');
const roots = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-race-'));
  roots.push(root);
  const kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir);
  return { root, kbDir, lockPath: refreshLockPath(kbDir) };
};
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const DEAD_PID = 4242;
const START = 'Mon Oct 26 03:30:00 2026';
const inspect = (pid) => (pid === DEAD_PID ? { state: 'dead' } : { state: 'live', processStart: START, executable: process.execPath });
const as = (pid, extra = {}) => ({ pid, processStart: START, executable: process.execPath, hostname: 'this-mac', inspectProcess: inspect, ...extra });
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const ownerToken = (lockPath) => JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token;
const errorOf = (fn) => { try { fn(); return null; } catch (error) { return error; } };
/** A `now` that runs `interleave` once, on its Nth call: call 1 stamps the staged owner, call 2 follows the read. */
const nowThatInterleaves = (n, interleave) => { let calls = 0; return () => { calls += 1; if (calls === n) interleave(); return new Date().toISOString(); }; };

describe('a remote-hostname owner whose process is alive here (Opus updater #2)', () => {
  it('this live process, recorded under the previous Wi-Fi hostname 4 h ago, keeps its lock', () => {
    const { root, kbDir, lockPath } = fixture();
    const first = acquireRefreshLock({ kbDir, brainHome: root, hostname: 'mbp-on-home-wifi', now: () => hoursAgo(4) });
    expect(first.owner.pid).toBe(process.pid);
    const error = errorOf(() => acquireRefreshLock({ kbDir, brainHome: root, hostname: 'mbp-on-cafe-wifi' }));
    expect(error?.message).toMatch(/another refresh run is active \(pid \d+ on mbp-on-home-wifi/);
    expect(ownerToken(lockPath)).toBe(first.token);
    expect(fs.existsSync(path.join(root, 'refresh-runs', `${first.runId}.json`))).toBe(false); // not recorded ABANDONED
    expect(releaseRefreshLock(first)).toBe(true);
  });

  it('the same verdict through an injected inspector; a different process on that pid is still aged out', () => {
    const { kbDir, lockPath } = fixture();
    const first = acquireRefreshLock({ kbDir, ...as(777, { hostname: 'old-host', now: () => hoursAgo(4) }) });
    expect(() => acquireRefreshLock({ kbDir, ...as(888, { hostname: 'new-host' }) })).toThrow(/another refresh run is active/);
    expect(ownerToken(lockPath)).toBe(first.token);
    const reused = (pid) => ({ state: 'live', processStart: pid === 777 ? 'Tue Oct 27 01:00:00 2026' : START, executable: process.execPath });
    const next = acquireRefreshLock({ kbDir, ...as(888, { hostname: 'new-host', inspectProcess: reused }) });
    expect(ownerToken(lockPath)).toBe(next.token);
    expect(releaseRefreshLock(next)).toBe(true);
  });
});

describe('concurrent reclaimers of one abandoned lock (Codex #1)', () => {
  it('an incomplete lock: A reclaims and acquires inside B\'s takeover window; exactly one of them owns it', () => {
    const { kbDir, lockPath } = fixture();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), '');
    const t = new Date(Date.now() - 1.5 * 3600_000);
    fs.utimesSync(path.join(lockPath, 'owner.json'), t, t);
    fs.utimesSync(lockPath, t, t);
    // B has judged the lock and is about to move it aside: A runs its whole acquisition right then.
    const realRename = fs.renameSync;
    let a = null;
    let aError = null;
    let fired = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!fired && from === lockPath && String(to).startsWith(`${lockPath}.stale-`)) {
        fired = true;
        try { a = acquireRefreshLock({ kbDir, ...as(101) }); } catch (error) { aError = error; }
      }
      return realRename(from, to);
    });
    let b = null;
    let bError = null;
    try { b = acquireRefreshLock({ kbDir, ...as(202) }); } catch (error) { bError = error; } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    const owners = [a, b].filter((lock) => lock?.owned);
    expect(owners, `A: ${aError?.message} / B: ${bError?.message}`).toHaveLength(1); // before: both owned it
    expect(ownerToken(lockPath)).toBe(owners[0].token);
    expect(releaseRefreshLock(owners[0])).toBe(true);
  });

  it('a dead owner: the losing contender leaves no claim behind, so A\'s lock can itself be reclaimed later', () => {
    const { kbDir, lockPath } = fixture();
    acquireRefreshLock({ kbDir, ...as(DEAD_PID) });
    let a = null;
    const error = errorOf(() => acquireRefreshLock({ kbDir, ...as(202, {
      now: nowThatInterleaves(2, () => { a = acquireRefreshLock({ kbDir, ...as(101) }); }) }) }));
    expect(error?.message).toMatch(/another refresh run is active \(pid 101 /);
    expect(ownerToken(lockPath)).toBe(a.token);
    expect(fs.readdirSync(lockPath).sort()).toEqual(['owner.json']); // before: B's takeover.json stayed in A's lock
    // A dies; C reclaims it. Before: the leftover claim made every later takeover fail with EEXIST.
    const c = acquireRefreshLock({ kbDir, ...as(303, { inspectProcess: (pid) => (pid === 101 ? { state: 'dead' } : inspect(pid)) }) });
    expect(ownerToken(lockPath)).toBe(c.token);
    expect(releaseRefreshLock(c)).toBe(true);
  });

  it('while one reclaimer holds the claim, a second one refuses instead of racing it', () => {
    const { kbDir, lockPath } = fixture();
    const dead = acquireRefreshLock({ kbDir, ...as(DEAD_PID) });
    let second = null;
    const a = acquireRefreshLock({ kbDir, ...as(101, {
      afterTakeoverClaim: () => { second = errorOf(() => acquireRefreshLock({ kbDir, ...as(202) })); } }) });
    expect(second?.message).toMatch(/another process is taking over the refresh lock/);
    expect(ownerToken(lockPath)).toBe(a.token);
    expect(a.token).not.toBe(dead.token);
    expect(releaseRefreshLock(a)).toBe(true);
  });

  it('a claim left by a crashed reclaimer is superseded once it is older than the claim window', () => {
    const { kbDir, lockPath } = fixture();
    acquireRefreshLock({ kbDir, ...as(DEAD_PID) });
    const claim = path.join(lockPath, 'takeover.json');
    fs.writeFileSync(claim, '{}');
    expect(() => acquireRefreshLock({ kbDir, ...as(101) })).toThrow(/another process is taking over/);
    const old = new Date(Date.now() - CLAIM_STALE_MS - 60_000);
    fs.utimesSync(claim, old, old);
    const a = acquireRefreshLock({ kbDir, ...as(101) });
    expect(ownerToken(lockPath)).toBe(a.token);
    expect(releaseRefreshLock(a)).toBe(true);
  });

  it('a reclaimer that dies holding its claim does not restart an incomplete lock\'s age (Opus r2 #6)', () => {
    const { kbDir, lockPath } = fixture();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), '');
    const t = new Date(Date.now() - 1.5 * 3600_000);
    fs.utimesSync(path.join(lockPath, 'owner.json'), t, t);
    fs.utimesSync(lockPath, t, t);
    const crashed = errorOf(() => acquireRefreshLock({ kbDir, ...as(101, { afterTakeoverClaim: () => { throw new Error('killed after claiming'); } }) }));
    expect(crashed?.message).toBe('killed after claiming');
    expect(fs.readdirSync(lockPath).sort()).toEqual(['owner.json', 'takeover.json']);
    const ageMs = Date.now() - fs.lstatSync(lockPath).mtimeMs;
    expect(ageMs).toBeGreaterThan(1.4 * 3600_000); // before: ~0, so the next takeover waited another hour
    expect(ageMs).toBeLessThan(1.6 * 3600_000);
    const old = new Date(Date.now() - CLAIM_STALE_MS - 60_000);
    fs.utimesSync(path.join(lockPath, 'takeover.json'), old, old);
    const a = acquireRefreshLock({ kbDir, ...as(202) }); // before: "incomplete or unreadable; refusing takeover until it is 1 h old"
    expect(ownerToken(lockPath)).toBe(a.token);
    expect(releaseRefreshLock(a)).toBe(true);
  });

  it('the judged lock vanishing before the claim is re-judged, not thrown (Fable r2 P3-1)', () => {
    const { kbDir, lockPath } = fixture();
    acquireRefreshLock({ kbDir, ...as(DEAD_PID) });
    const realReaddir = fs.readdirSync;
    let fired = false;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((target, ...rest) => {
      if (!fired && target === lockPath) { fired = true; fs.rmSync(lockPath, { recursive: true }); } // another reclaimer moved it
      return realReaddir(target, ...rest);
    });
    let lock = null;
    let error = null;
    try { lock = acquireRefreshLock({ kbDir, ...as(101) }); } catch (e) { error = e; } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    expect(error?.message).toBeUndefined(); // before: ENOENT: no such file or directory, scandir
    expect(ownerToken(lockPath)).toBe(lock.token);
    expect(releaseRefreshLock(lock)).toBe(true);
  });

  it('six processes released together on one dead lock: exactly one owns it', async () => {
    const { kbDir, lockPath } = fixture();
    acquireRefreshLock({ kbDir, ...as(DEAD_PID) });
    const barrier = path.join(path.dirname(kbDir), 'go');
    const script = `
      import fs from 'node:fs';
      const m = await import(${JSON.stringify(MODULE)});
      const inspect = (pid) => (pid === ${DEAD_PID} ? { state: 'dead' } : { state: 'live', processStart: 'p', executable: process.execPath });
      while (!fs.existsSync(${JSON.stringify(barrier)})) { /* barrier */ }
      try {
        const lock = m.acquireRefreshLock({ kbDir: ${JSON.stringify(kbDir)}, processStart: 'p', executable: process.execPath,
          hostname: 'this-mac', inspectProcess: inspect });
        console.log('OWNED ' + lock.token);
      } catch (error) { console.log('REFUSED ' + error.message); }`;
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const outputs = children.map((child) => new Promise((resolve) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('exit', () => resolve(out.trim()));
    }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    fs.writeFileSync(barrier, '');
    const results = await Promise.all(outputs);
    const owned = results.filter((line) => line.startsWith('OWNED '));
    expect(owned, results.join('\n')).toHaveLength(1);
    expect(results.filter((line) => line.startsWith('REFUSED ')), results.join('\n')).toHaveLength(5);
    expect(ownerToken(lockPath)).toBe(owned[0].slice('OWNED '.length));
  }, 30_000);
});
