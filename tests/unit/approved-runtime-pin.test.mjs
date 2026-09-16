import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  emitApprovedRuntime, isRuntimeFile, readApprovedRuntime, verifyApprovedRuntime,
} from '../../scripts/approved-runtime.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/approved-runtime.mjs');
const CODE_SHA = 'b'.repeat(40);
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmpdir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-runtime-')); dirs.push(dir); return dir; };
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const row = (file, content) => ({ path: file, sha256: digest(content), bytes: Buffer.byteLength(content) });

// A realistic slice of what scripts/build-bundle.mjs actually copies into the archive: the forge-*
// module graph (:213-214), the package manifests (:215), scripts/verify-bundle.mjs (:645) and the
// signing trust root (:648) — plus corpus content, which MUST be free to change every round.
function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'ruvnet-brain-archive-manifest',
    version: '4.3.25', // sync-version-ignore: fixture archive identity, not a shipped manifest
    releaseTag: 'v4.3.25', // sync-version-ignore: fixture archive identity, not a shipped manifest
    fileCount: 7,
    totalBytes: 0,
    files: [
      row('forge-update.mjs', 'export const update = 1;'),
      row('forge-ask-all.mjs', 'export const ask = 1;'),
      row('verify-bundle.mjs', 'export const verify = 1;'),
      row('package.json', '{"name":"kb"}'),
      row('keys/ruvnet-brain-signing.pub.pem', '-----BEGIN PUBLIC KEY-----'),
      row('ruvector.big.rvf', 'vector bytes'),
      row('SOURCE.json', '{"stores":{}}'),
    ],
    ...overrides,
  };
}
const pinFor = (source = manifest()) => emitApprovedRuntime({ manifest: source, approvedCodeSha: CODE_SHA });
const mutate = (source, file, content) => ({
  ...source,
  files: source.files.map((entry) => (entry.path === file ? row(file, content) : entry)),
});

describe('approved runtime pin — classification', () => {
  it.each([
    ['forge-update.mjs', true], ['kb/forge-mcp.mjs', true], ['tool.cjs', true], ['tool.js', true],
    ['install.sh', true], ['run.ps1', true], ['keys/ruvnet-brain-signing.pub.pem', true],
    ['package.json', true], ['package-lock.json', true], ['package-owners.json', true],
    ['ruvector.big.rvf', false], ['SOURCE.json', false], ['COVERAGE.json', false],
    ['primer/ruvector-primer.md', false], ['assets/l2/l2-topics.ruvector.json', false],
  ])('classifies %s as runtime=%s', (file, expected) => {
    expect(isRuntimeFile(file)).toBe(expected);
  });
});

describe('approved runtime pin — enforced equality (ADR-086 step 17)', () => {
  it('GREEN: an archive whose executables equal the approved shipped artifact passes', () => {
    const result = verifyApprovedRuntime({ manifest: manifest(), pin: pinFor() });
    expect(result.failures).toEqual([]);
    expect(result.verdict).toBe('PASS');
    expect(result.checked).toBe(5);
  });

  it('GREEN: corpus content is free to change every round — only executables are pinned', () => {
    // This is the whole reason the pin is not "the archive did not change": a nightly corpus round
    // MUST produce different vectors, SOURCE.json and coverage. A pin that failed on those would be
    // unusable, and the pressure would be to delete it.
    const changed = mutate(mutate(manifest(), 'ruvector.big.rvf', 'NEW vector bytes'), 'SOURCE.json', '{"stores":{"a":1}}');
    expect(verifyApprovedRuntime({ manifest: changed, pin: pinFor() }).verdict).toBe('PASS');
  });

  it.each([
    ['forge-update.mjs', 'export const update = 2; // unreleased change'],
    ['forge-ask-all.mjs', 'export const ask = 999;'],
    ['verify-bundle.mjs', 'export const verify = () => ({ ok: true });'],
    ['package.json', '{"name":"kb","version":"9.9.9"}'],
    ['keys/ruvnet-brain-signing.pub.pem', '-----BEGIN PUBLIC KEY-----ATTACKER'],
  ])('RED (wrong runtime bytes): a changed %s is refused', (file, content) => {
    const result = verifyApprovedRuntime({ manifest: mutate(manifest(), file, content), pin: pinFor() });
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.join('\n')).toContain(`runtime bytes differ from the approved shipped code artifact: ${file}`);
  });

  it('RED (wrong runtime bytes): a same-digest different-length claim is refused', () => {
    const pin = pinFor();
    const tampered = { ...pin, files: pin.files.map((entry) => (entry.path === 'forge-update.mjs' ? { ...entry, bytes: entry.bytes + 1 } : entry)) };
    const result = verifyApprovedRuntime({ manifest: manifest(), pin: tampered });
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.join('\n')).toMatch(/byte length differs/);
  });

  it('RED (unpinned executable): a new .mjs that no code release approved is refused', () => {
    // The backward direction. Without it, a nightly build could add a brand new executable to the
    // archive and satisfy a forward-only check trivially — the archive would ship code no owner saw.
    const smuggled = manifest();
    smuggled.files = [...smuggled.files, row('forge-backdoor.mjs', 'process.exit(0);')];
    const result = verifyApprovedRuntime({ manifest: smuggled, pin: pinFor() });
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.join('\n')).toContain('archive ships an executable/runtime file no approved code release pinned: forge-backdoor.mjs');
  });

  it('RED (missing executable): a pinned file dropped from the archive is refused', () => {
    const stripped = { ...manifest(), files: manifest().files.filter((entry) => entry.path !== 'verify-bundle.mjs') };
    const result = verifyApprovedRuntime({ manifest: stripped, pin: pinFor() });
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.join('\n')).toContain('approved runtime file absent from archive: verify-bundle.mjs');
  });

  it.each([
    // An impossible version, on purpose. This fixture used to say 4.3.26 as "some future generation" and
    // collided with sync-version's stray-literal scan the day 4.3.26 became the real version — a fixture
    // pinned to a plausible future is a stale literal waiting to happen.
    ['brainVersion', { version: '9.9.9', releaseTag: 'v9.9.9' }, /is not the approved shipped runtime/],
    ['releaseTag', { releaseTag: 'v4.3.25-dev' }, /releaseTag does not match its version/], // sync-version-ignore: fixture drift value, not a shipped manifest
  ])('RED (wrong %s): a different shipped generation is refused', (_name, overrides, message) => {
    const result = verifyApprovedRuntime({ manifest: manifest(overrides), pin: pinFor() });
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.join('\n')).toMatch(message);
  });

  it.each([
    ['schema downgrade', (pin) => { pin.schemaVersion = 0; }, /schema or kind/],
    ['wrong kind', (pin) => { pin.kind = 'forged'; }, /schema or kind/],
    ['non-semver brainVersion', (pin) => { pin.brainVersion = '4.3'; }, /brainVersion is not x\.y\.z/],
    ['missing approved code SHA', (pin) => { delete pin.approvedCodeSha; }, /approvedCodeSha/],
    ['empty file inventory', (pin) => { pin.files = []; }, /file rows are missing or malformed/],
    ['a pinned corpus data file', (pin) => { pin.files = [...pin.files, { path: 'SOURCE.json', sha256: 'a'.repeat(64), bytes: 1 }]; }, /not executable\/runtime-shaped/],
    ['a duplicated path', (pin) => { pin.files = [...pin.files, pin.files[0]]; }, /same path twice/],
  ])('RED (invalid pin): %s is refused before any comparison', (_name, tamper, message) => {
    const pin = pinFor();
    tamper(pin);
    const result = verifyApprovedRuntime({ manifest: manifest(), pin });
    expect(result.verdict).toBe('FAIL');
    expect(result.failures.join('\n')).toMatch(message);
  });

  it('RED (absent pin): refuses with the exact owner remediation rather than defaulting open', () => {
    const dir = tmpdir();
    expect(() => readApprovedRuntime(path.join(dir, 'approved-runtime.json')))
      .toThrow(/no approved runtime pin[\s\S]*approved-runtime\.mjs --emit/);
  });
});

describe('approved runtime pin — CLI round trip', () => {
  it('emits only executables, then verifies the archive it was emitted from', () => {
    const dir = tmpdir();
    const manifestFile = path.join(dir, 'ARCHIVE-MANIFEST.json');
    const pinFile = path.join(dir, 'approved-runtime.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest(), null, 2));

    execFileSync(process.execPath, [SCRIPT, '--emit', '--archive-manifest', manifestFile, '--code-sha', CODE_SHA, '--out', pinFile],
      { encoding: 'utf8', timeout: 20_000 });
    const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
    expect(pin.files.map((entry) => entry.path)).toEqual([
      'forge-ask-all.mjs', 'forge-update.mjs', 'keys/ruvnet-brain-signing.pub.pem', 'package.json', 'verify-bundle.mjs',
    ]);
    expect(pin.approvedCodeSha).toBe(CODE_SHA);

    const pass = execFileSync(process.execPath, [SCRIPT, '--verify', '--archive-manifest', manifestFile, '--pin', pinFile],
      { encoding: 'utf8', timeout: 20_000 });
    expect(pass).toMatch(/PASS: 5 executable\/runtime file\(s\) equal v4\.3\.25 byte for byte/);
  });

  it('exits non-zero when the archive runtime drifted from the pin', () => {
    const dir = tmpdir();
    const manifestFile = path.join(dir, 'ARCHIVE-MANIFEST.json');
    const driftedFile = path.join(dir, 'DRIFTED-MANIFEST.json');
    const pinFile = path.join(dir, 'approved-runtime.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest(), null, 2));
    fs.writeFileSync(driftedFile, JSON.stringify(mutate(manifest(), 'forge-update.mjs', 'unreleased'), null, 2));
    fs.writeFileSync(pinFile, JSON.stringify(pinFor(), null, 2));

    const drifted = spawnSync(process.execPath, [SCRIPT, '--verify', '--archive-manifest', driftedFile, '--pin', pinFile],
      { encoding: 'utf8', timeout: 20_000 });
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain('runtime bytes differ from the approved shipped code artifact: forge-update.mjs');

    // Same pin, undrifted manifest: exit 0. Without this pair the failure above could be a broken CLI
    // rather than a working guard.
    const clean = spawnSync(process.execPath, [SCRIPT, '--verify', '--archive-manifest', manifestFile, '--pin', pinFile],
      { encoding: 'utf8', timeout: 20_000 });
    expect(clean.status).toBe(0);
  });
});
