// disk-space-preflight.test.mjs — 4.5: an install/update measures the room it needs before unpacking
// anything (measured ~3.3 GB growth / ~5 GB peak per apply on a 1.3 GB brain) and refuses with the exact
// shortfall and the one fix, instead of failing half-way with ENOSPC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { availableBytes, checkDiskSpace, directoryBytes, DISK_HEADROOM_BYTES } from '../../kb/update-storage-transaction.mjs';
import { zipDeclaredBytes } from '../../kb/zip-extract.mjs';
import { writeStoredZip } from '../helpers/zip-fixture.mjs';

const GB = 1024 ** 3;
const temps = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-preflight-')); temps.push(dir); return dir; };
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });
let install;
beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  install = await import('../../bin/install.mjs');
});

describe('checkDiskSpace', () => {
  it('adds up requirements that share a filesystem and refuses with the exact shortfall and the one fix', () => {
    const result = checkDiskSpace([
      { dir: '/vol/tmp/x', bytes: 1 * GB, purpose: 'unpacked bundle' },
      { dir: '/vol/home/kb', bytes: 2 * GB, purpose: 'new generation' },
    ], { deviceOf: () => 1, available: () => 2 * GB });
    expect(result.ok).toBe(false);
    expect(result.shortfalls).toEqual([expect.objectContaining({ needBytes: 3 * GB + DISK_HEADROOM_BYTES, freeBytes: 2 * GB,
      shortBytes: 1 * GB + DISK_HEADROOM_BYTES })]);
    // The one supported way to a bigger disk is --move-brain (CONTRIBUTING.md); RUVNET_BRAIN_HOME never reaches
    // GUI hosts or launchd and the installer ignores it while the MCP server honours it (review S4).
    expect(result.message).toBe('not enough free disk space to apply this update: / has 2.00 GB free and needs 3.25 GB (unpacked bundle 1.00 GB + new generation 2.00 GB + 0.25 GB headroom). Free 1.25 GB on that disk, or move the Brain to a bigger disk with  npx ruvnet-brain --move-brain <folder on that disk>. Nothing was changed.');
    expect(result.message).not.toMatch(/RUVNET_BRAIN_HOME/);
  });

  it('offers the move only where the Brain lives: a short temp disk is told to free space, nothing else', () => {
    const root = temp();
    const tmpDisk = path.join(root, 'tmpdisk'); const brainDisk = path.join(root, 'braindisk');
    fs.mkdirSync(tmpDisk); fs.mkdirSync(brainDisk);
    const requirements = [{ dir: path.join(tmpDisk, 'x'), bytes: 1 * GB, purpose: 'unpacked bundle', brain: false },
      { dir: path.join(brainDisk, 'kb'), bytes: 1 * GB, purpose: 'new generation' }];
    const deviceOf = (dir) => (dir.startsWith(tmpDisk) ? 1 : 2);
    const tempShort = checkDiskSpace(requirements, { deviceOf, available: (dir) => (deviceOf(dir) === 1 ? 0 : 10 * GB) });
    expect(tempShort.message).toBe(`not enough free disk space to apply this update: ${tmpDisk} has 0.00 GB free and needs 1.25 GB `
      + '(unpacked bundle 1.00 GB + 0.25 GB headroom). Free 1.25 GB on that disk. Nothing was changed.');
    const brainShort = checkDiskSpace(requirements, { deviceOf, available: (dir) => (deviceOf(dir) === 2 ? 0 : 10 * GB) });
    expect(brainShort.message).toMatch(/on that disk, or move the Brain to a bigger disk with {2}npx ruvnet-brain --move-brain <folder on that disk>\. Nothing was changed\.$/);
  });

  it('a Node without fs.statfsSync (< 18.15) gets a plain sentence, not "statfsSync is not a function"', () => {
    expect(() => availableBytes(os.tmpdir(), {}, null)).toThrow(/^this Node \(v[\d.]+\) cannot measure free disk space \(no fs\.statfsSync; needs 18\.15\+\)$/);
  });

  it('checks separate filesystems separately, and passes when each has room', () => {
    const free = { 1: 1.5 * GB, 2: 4 * GB };
    const requirements = [{ dir: '/a', bytes: 1 * GB, purpose: 'unpacked bundle' }, { dir: '/b', bytes: 3 * GB, purpose: 'new generation' }];
    const deviceOf = (dir) => (dir === '/a' ? 1 : 2);
    const available = (dir) => free[deviceOf(dir)];
    expect(checkDiskSpace(requirements, { deviceOf, available })).toMatchObject({ ok: true, shortfalls: [] });
    free[2] = 3 * GB; // the generation's disk is now short; the temp disk is still fine
    const result = checkDiskSpace(requirements, { deviceOf, available });
    expect(result.shortfalls.map((s) => s.purposes)).toEqual([['new generation 3.00 GB']]);
  });

  it('measures real disks: real free space, real directory bytes, the zip\'s declared unpacked size', () => {
    const dir = temp();
    expect(availableBytes(dir)).toBeGreaterThan(0);
    expect(availableBytes(dir, { RUVNET_BRAIN_TEST: '1', RUVNET_TEST_FREE_BYTES: '42' })).toBe(42);
    expect(availableBytes(dir, { RUVNET_TEST_FREE_BYTES: '42' })).not.toBe(42); // the seam needs test mode
    fs.mkdirSync(path.join(dir, 'nm', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nm', 'pkg', 'a.js'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(dir, 'nm', 'b.js'), 'y'.repeat(234));
    expect(directoryBytes(path.join(dir, 'nm'))).toBe(1234);
    expect(directoryBytes(path.join(dir, 'absent'))).toBe(0);
    const archiveFile = path.join(dir, 'b.zip');
    writeStoredZip({ archiveFile, entries: [{ name: 'a.rvf', data: Buffer.alloc(5000, 1) }, { name: 'b/c.json', data: '{}' }] });
    expect(zipDeclaredBytes(archiveFile)).toBe(5002);
  });
});

describe('installer behaviour on a full disk', () => {
  it('an updater refused for disk space is never answered with a fresh-install fallback', () => {
    expect(install.classifyUpdaterExit(6, { result: { terminalVerdict: 'failed', reason: 'not enough free disk space to apply this update: …' } }))
      .toEqual({ verdict: 'refused-disk-space', fallback: false, exitCode: 6 });
    expect(install.classifyUpdaterExit(1, { result: { terminalVerdict: 'failed', reason: 'network failure' } }))
      .toMatchObject({ fallback: true });
  });

  it('a fresh install refuses before staging anything when the brain\'s disk is too small', () => {
    const home = temp();
    const cacheDir = path.join(home, 'brain', 'kb');
    const archiveFile = path.join(home, 'bundle.zip');
    writeStoredZip({ archiveFile, entries: [{ name: 'store.rvf', data: Buffer.alloc(4096, 2) }] });
    const run = spawnSyncInstaller(home, cacheDir, archiveFile);
    expect(run.status, run.stdout + run.stderr).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toMatch(/not enough free disk space to install the brain: .* Nothing was changed\./);
    expect(fs.existsSync(path.join(home, 'brain')) ? fs.readdirSync(path.join(home, 'brain')) : []).toEqual([]);
  });
});

function spawnSyncInstaller(home, cacheDir, archiveFile) {
  // Run unzipInto in a child: die() exits the process, which must not end this test worker.
  const code = `process.env.RUVNET_BRAIN_IMPORT_ONLY='1'; const m = await import(${JSON.stringify(path.resolve('bin/install.mjs'))});
await m.unzipInto(${JSON.stringify(archiveFile)}, ${JSON.stringify(cacheDir)});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, HOME: home, RUVNET_BRAIN_TEST: '1', RUVNET_TEST_FREE_BYTES: '1000' } });
}
