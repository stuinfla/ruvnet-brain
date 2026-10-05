import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ algorithms: [], bytes: 0 }));
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual('node:crypto');
  return { ...actual, createHash(algorithm, options) {
    observed.algorithms.push(algorithm);
    const hash = actual.createHash(algorithm, options); const update = hash.update;
    hash.update = function(bytes, ...args) { observed.bytes += bytes.length; return update.call(this, bytes, ...args); };
    return hash;
  } };
});
import { createHash } from 'node:crypto';
import { createDownloadedArchiveVerifier, verifyLanded } from '../../kb/forge-update.mjs';

let dir;
const before = { builtUtc: 'old' };
const digest = (bytes, algorithm = 'sha256') => `${algorithm}:${createHash(algorithm).update(bytes).digest('hex')}`;
const reset = () => { observed.algorithms.length = 0; observed.bytes = 0; };
const check = (options) => verifyLanded({ kbDir: dir, kbName: 'store-0', before, ...options });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-digest-'));
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify({ stores:
    Object.fromEntries(Array.from({ length: 197 }, (_, index) => [`store-${index}`, { builtUtc: 'new' }])) }));
  reset();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('hashes one 64-byte archive once for 197 stores and both transaction phases', () => {
  const bytes = Buffer.alloc(64, 7); const expectedDigest = digest(bytes); reset();
  const archiveVerifier = createDownloadedArchiveVerifier(bytes, Array(197).fill(expectedDigest));
  for (const phase of ['candidate', 'live']) for (let index = 0; index < 197; index++) {
    expect(verifyLanded({ kbDir: dir, kbName: `store-${index}`, before, expectedDigest, archiveVerifier }).ok, phase).toBe(true);
  }
  expect(archiveVerifier.digest()).toBe(expectedDigest.slice('sha256:'.length));
  expect(observed).toEqual({ algorithms: ['sha256'], bytes: 64 });
});

it('captures each declared algorithm once and compares differing expected digests afresh', () => {
  const bytes = Buffer.alloc(64, 7); const sha256 = digest(bytes); const sha512 = digest(bytes, 'sha512');
  const wrong = digest(Buffer.alloc(64, 8)); reset();
  const archiveVerifier = createDownloadedArchiveVerifier(bytes, [sha256, sha512, wrong]);
  expect(check({ expectedDigest: sha256, archiveVerifier }).ok).toBe(true);
  expect(check({ expectedDigest: wrong, archiveVerifier })).toMatchObject({ ok: false, kind: 'damaged' });
  expect(check({ expectedDigest: sha512, archiveVerifier }).ok).toBe(true);
  expect(check({ expectedDigest: sha256, archiveVerifier }).ok).toBe(true);
  expect(check({ expectedDigest: `sha384:${'0'.repeat(96)}`, archiveVerifier })).toMatchObject({ ok: false, kind: 'damaged' });
  expect(observed).toEqual({ algorithms: ['sha256', 'sha512'], bytes: 128 });
});

it('refuses corrupted or subsequently mutated raw archives and a snapshot mixed with mutable bytes', () => {
  const bytes = Buffer.alloc(64, 7); const expectedDigest = digest(bytes);
  const archiveVerifier = createDownloadedArchiveVerifier(bytes, [expectedDigest]);
  expect(Object.isFrozen(archiveVerifier)).toBe(true);
  bytes[0] ^= 1;
  expect(check({ expectedDigest, downloadedBuffer: bytes })).toMatchObject({ ok: false, kind: 'damaged' });
  expect(check({ expectedDigest, archiveVerifier, downloadedBuffer: bytes })).toMatchObject({ ok: false, kind: 'damaged' });
  const corrupted = createDownloadedArchiveVerifier(bytes, [expectedDigest]);
  expect(check({ expectedDigest, archiveVerifier: corrupted })).toMatchObject({ ok: false, kind: 'damaged' });
  // This capability describes the captured original bytes, never the current caller-owned buffer.
  expect(archiveVerifier.digest()).toBe(expectedDigest.slice('sha256:'.length));
});

it.each([true, { verified: true }, { digest: () => 'forged' }])('rejects caller-forged verification authority: %j', archiveVerifier => {
  expect(check({ expectedDigest: 'sha256:forged', archiveVerifier })).toMatchObject({ ok: false, kind: 'damaged' });
});

it('retains per-store and SOURCE corruption refusals even with a genuine digest snapshot', () => {
  const bytes = Buffer.alloc(64, 7); const expectedDigest = digest(bytes);
  const archiveVerifier = createDownloadedArchiveVerifier(bytes, [expectedDigest]);
  expect(check({ kbName: 'absent-store', expectedDigest, archiveVerifier })).toMatchObject({ ok: false, kind: 'damaged' });
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), '{corrupt');
  expect(check({ expectedDigest, archiveVerifier })).toMatchObject({ ok: false, kind: 'damaged' });
});

it('does not reuse digests between transactions, even when bytes are identical', () => {
  const bytes = Buffer.alloc(64, 7); const expectedDigest = digest(bytes); reset();
  for (let index = 0; index < 2; index++) {
    const archiveVerifier = createDownloadedArchiveVerifier(bytes, [expectedDigest]);
    expect(check({ expectedDigest, archiveVerifier }).ok).toBe(true);
  }
  expect(observed).toEqual({ algorithms: ['sha256', 'sha256'], bytes: 128 });
});
