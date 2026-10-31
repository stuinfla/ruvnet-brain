// discover() reads every receipt of every release (1,254 receipts across 155 releases on 2026-10-30).
// Serially that was 551 s of 4.7.25's 908 s publish step and 392 s of its finalize step. The reads now run
// RECEIPT_READ_CONCURRENCY at a time and are folded in the original order. This drives the real
// liveReleaseProvider().discover() against a scripted GitHub with every child process faked (sync and
// async), so it measures overlap on the old serial code as well as the new one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const fake = vi.hoisted(() => ({ world: null }));
vi.mock('node:child_process', async (original) => {
  const real = await original();
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const answer = (name, args) => fake.world.answer(name, args);
  return {
    ...real,
    execFileSync: (name, args) => answer(name, args),
    execFile: (name, args, options, callback) => {
      setTimeout(() => {
        try { callback(null, answer(name, args), ''); } catch (error) { callback(error, '', String(error.message)); }
      }, 1);
      return new EventEmitter();
    },
    spawnSync: (name, args, options) => {
      fake.world.enter(); sleepSync(fake.world.readMs); fake.world.leave();
      fs.writeSync(options.stdio[1], fake.world.body(args[1]));
      return { status: 0, signal: null, stderr: Buffer.alloc(0) };
    },
    spawn: (name, args, options) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      fake.world.enter();
      setTimeout(() => {
        fs.writeSync(options.stdio[1], fake.world.body(args[1]));
        fake.world.leave();
        child.emit('close', 0, null);
      }, fake.world.readMs);
      return child;
    },
  };
});
const provider = await import('../../scripts/release-transaction-provider.mjs');

const REPO = 'stuinfla/ruvnet-brain';
function scriptedGithub({ releases = 8, receiptsEach = 5, readMs = 15 } = {}) {
  const list = [];
  const bodies = new Map();
  for (let r = 0; r < releases; r += 1) {
    const assets = [];
    for (let s = 0; s < receiptsEach; s += 1) {
      const url = `https://api.github.com/repos/${REPO}/releases/assets/${r * 100 + s}`;
      // Release r's transaction tx-r, receipts in sequence order; the last of release 0 is still pending.
      const state = s === receiptsEach - 1 ? (r === 0 ? 'npm-stage-intent' : 'install-verified') : 'prepared';
      bodies.set(url, JSON.stringify({ schemaVersion: 3, transactionId: `tx-${r}`, sequence: s, state }));
      assets.push({ id: r * 100 + s, name: `release-transaction-${String(s).padStart(4, '0')}.json`, url });
    }
    assets.push({ id: r * 100 + 99, name: 'ruvnet-brain.zip', url: `https://api.github.com/x/${r}` });
    list.push({ id: 1000 + r, tag_name: `v9.0.${r}`, draft: false, target_commitish: 'main', assets });
  }
  // An unrelated draft: never read (its assets 404 through the public API).
  list.push({ id: 5000, tag_name: 'v9.9.8', draft: true, target_commitish: 'x', assets: [{ id: 1, name: 'release-transaction-0000.json', url: 'draft' }] });
  let active = 0;
  const world = {
    readMs, maxActive: 0, reads: 0,
    enter() { active += 1; world.reads += 1; world.maxActive = Math.max(world.maxActive, active); },
    leave() { active -= 1; },
    body(url) { if (!bodies.has(url)) throw new Error(`unexpected asset read ${url}`); return bodies.get(url); },
    answer(name, args) {
      if (name === 'npm') return '9.0.7';
      if (name === 'git') return '';
      const endpoint = args[1];
      if (endpoint.startsWith(`repos/${REPO}/releases?per_page=100`)) return JSON.stringify([list]);
      if (endpoint.startsWith(`repos/${REPO}/releases?per_page=30`)) return JSON.stringify(list);
      const assets = /releases\/(\d+)\/assets/.exec(endpoint);
      if (assets) return JSON.stringify([list.find((release) => release.id === Number(assets[1])).assets]);
      throw new Error(`unexpected ${name} ${args.join(' ')}`);
    },
  };
  return world;
}

describe('release receipt history scan', () => {
  beforeEach(() => { fake.world = scriptedGithub(); });
  afterEach(() => { fake.world = null; });

  it('reads receipts side by side, bounded, and folds them exactly as the serial scan did', async () => {
    const started = Date.now();
    const result = await provider.liveReleaseProvider({ root: process.cwd() })
      .discover({ tag: 'v9.9.9', version: '9.9.9', candidateSha: '0'.repeat(40) });
    const elapsed = Date.now() - started;
    expect(fake.world.reads).toBe(8 * 5);
    expect(fake.world.maxActive).toBeGreaterThan(1);
    expect(fake.world.maxActive).toBeLessThanOrEqual(provider.RECEIPT_READ_CONCURRENCY);
    // 40 reads x 15 ms serial = 600 ms; five at a time is ~120 ms plus overhead.
    expect(elapsed).toBeLessThan(40 * 15 * 0.6);
    // Same verdicts: only tx-0 (last receipt npm-stage-intent) is pending; the rest are install-verified.
    expect(result.pending.map((receipt) => receipt.transactionId)).toEqual(['tx-0']);
    expect(result.pending[0].sequence).toBe(4);
    expect(result.legacySettled).toEqual([]);
    expect(result.prior.npmLatest).toBe('9.0.7');
    expect(result.prior.githubLatest).toMatch(/^v9\.0\.\d$/);
  });

  it('keeps input order whatever order the reads finish in', async () => {
    const out = await provider.mapConcurrent([30, 1, 20, 2, 10], 3, (ms, index) => new Promise((resolve) => setTimeout(() => resolve(index), ms)));
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(await provider.mapConcurrent([], 5, async () => 1)).toEqual([]);
  });

  it('a read that keeps failing still fails the scan with its cause (retries unchanged)', async () => {
    const waits = [];
    let calls = 0;
    const spawnChild = () => {
      calls += 1;
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      setTimeout(() => { child.stderr.emit('data', Buffer.from('HTTP 502')); child.emit('close', 1, null); }, 1);
      return child;
    };
    const dest = `${fs.mkdtempSync('/tmp/receipt-scan-')}/r.json`;
    await expect(provider.downloadAssetAsync({ name: 'release-transaction-0001.json', url: 'u' }, dest,
      { spawnChild, wait: async (ms) => { waits.push(ms); }, baseDelayMs: 1 }))
      .rejects.toThrow(`release-transaction-0001.json after ${provider.ASSET_DOWNLOAD_ATTEMPTS} attempts: exit 1 (HTTP 502)`);
    expect(calls).toBe(provider.ASSET_DOWNLOAD_ATTEMPTS);
    expect(waits).toEqual([1, 2, 4]);
  });
});
