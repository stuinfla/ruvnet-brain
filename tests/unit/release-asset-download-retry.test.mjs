import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadAsset, ASSET_DOWNLOAD_ATTEMPTS } from '../../scripts/release-transaction-provider.mjs';

// 2026-09-29: the 4.3.36 publish died on ONE failed receipt download out of ~411 ("exit 1", the stderr
// discarded); the same asset downloaded fine a minute later. A transient fetch failure must be retried,
// a persistent one must still fail, and the failure must say WHY.
const asset = { name: 'release-transaction-0009.json', url: 'https://api.github.com/repos/x/y/releases/assets/1' };
const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-retry-')), 'asset.bin');
const fakeSpawn = (script, calls = []) => (cmd, args, opts) => {
  const step = script[Math.min(calls.length, script.length - 1)];
  calls.push({ cmd, args });
  if (step.ok) fs.writeSync(opts.stdio[1], step.body);
  else fs.writeSync(opts.stdio[1], 'PARTIAL-GARBAGE');
  return { status: step.ok ? 0 : 1, stderr: Buffer.from(step.stderr || ''), signal: null, error: undefined };
};

describe('downloadAsset retries a flaky release-asset download', () => {
  it('succeeds on the first try without waiting', () => {
    const calls = []; const waits = []; const dest = scratch();
    expect(downloadAsset(asset, dest, { spawn: fakeSpawn([{ ok: true, body: 'A' }], calls), wait: (ms) => waits.push(ms) })).toBe(dest);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('recovers from two transient failures, backs off exponentially, and discards partial bytes', () => {
    const calls = []; const waits = []; const dest = scratch();
    downloadAsset(asset, dest, {
      spawn: fakeSpawn([{ ok: false, stderr: 'HTTP 502' }, { ok: false, stderr: 'HTTP 502' }, { ok: true, body: '{"sequence":9}' }], calls),
      wait: (ms) => waits.push(ms), baseDelayMs: 100,
    });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([100, 200]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('{"sequence":9}'); // no PARTIAL-GARBAGE left behind
  });

  it('still fails when the asset is persistently unavailable, after exactly the attempt budget, naming the cause', () => {
    const calls = []; const waits = []; const dest = scratch();
    expect(() => downloadAsset(asset, dest, { spawn: fakeSpawn([{ ok: false, stderr: 'HTTP 404 Not Found' }], calls), wait: (ms) => waits.push(ms), baseDelayMs: 1 }))
      .toThrow(new RegExp(`release-transaction-0009\\.json after ${ASSET_DOWNLOAD_ATTEMPTS} attempts: exit 1 \\(HTTP 404 Not Found\\)`));
    expect(calls).toHaveLength(ASSET_DOWNLOAD_ATTEMPTS);
    expect(waits).toHaveLength(ASSET_DOWNLOAD_ATTEMPTS - 1); // no sleep after the last failure
  });

  it('does not leak file descriptors across retries', () => {
    const before = fs.readdirSync('/dev/fd').length; const dest = scratch();
    try { downloadAsset(asset, dest, { spawn: fakeSpawn([{ ok: false }], []), wait: () => {}, attempts: 4 }); } catch { /* expected */ }
    expect(fs.readdirSync('/dev/fd').length).toBeLessThanOrEqual(before);
  });
});
