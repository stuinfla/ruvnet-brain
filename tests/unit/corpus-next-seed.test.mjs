import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveNextCorpusSeed, validateBootstrapSeed } from '../../scripts/corpus-next-seed.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

const APPROVED_TAG = 'v4.3.25'; // sync-version-ignore: fixture approved runtime identity
const APPROVED_VERSION = '4.3.25'; // sync-version-ignore: fixture approved runtime identity
const digest = (seed) => seed.repeat(64).slice(0, 64);
const BOOTSTRAP_SHA = digest('9');

function workspace({ pin, bootstrap } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-next-seed-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/approved-runtime.json'), JSON.stringify(pin ?? {
    schemaVersion: 1,
    kind: 'ruvnet-brain-approved-runtime',
    brainVersion: APPROVED_VERSION,
    releaseTag: APPROVED_TAG,
    approvedCodeSha: 'a'.repeat(40),
    fileCount: 1,
    files: [{ path: 'forge-update.mjs', sha256: digest('1'), bytes: 12 }],
  }));
  fs.writeFileSync(path.join(root, 'data/corpus-seed.json'), JSON.stringify(bootstrap ?? {
    schemaVersion: 1,
    tag: 'v4.2.1-dev', // sync-version-ignore: the immutable committed bootstrap seed tag
    asset: 'ruvnet-brain.zip',
    sha256: BOOTSTRAP_SHA,
    bytes: 567832189,
    sourceCommit: 'b'.repeat(40),
  }));
  return root;
}

const ASSETS = (bytes) => [
  { name: 'ruvnet-brain.zip', size: bytes, state: 'uploaded' },
  { name: 'ruvnet-brain.zip.sig', size: 64, state: 'uploaded' },
  { name: 'corpus-receipt.json', size: 2048, state: 'uploaded' },
];

function generation(seed, overrides = {}) {
  const sha256 = digest(seed);
  return {
    tag: `corpus-sha256-${sha256}`,
    sha256,
    bytes: 600_000_000,
    isDraft: false,
    createdAt: overrides.createdAt || '2026-09-10T00:00:00Z',
    assets: overrides.assets || ASSETS(600_000_000),
    receipt: {
      // ADR-086 Step 15 / A6: schema 3, and the accuracy binding is part of what makes a published
      // generation seedable at all.
      schemaVersion: 3,
      kind: 'ruvnet-brain-corpus-candidate',
      builderSourceSha: 'c'.repeat(40),
      archive: { file: 'ruvnet-brain.zip', sha256, bytes: 600_000_000 },
      accuracyReport: { file: 'ruvnet-brain.zip.accuracy.json', sha256: 'a'.repeat(64), bytes: 2048 },
      archiveManifestVersion: APPROVED_VERSION,
      archiveManifestReleaseTag: APPROVED_TAG,
      ...(overrides.receipt || {}),
    },
    ...(overrides.release || {}),
  };
}

/** A fake `gh` that answers exactly the three calls the resolver makes, and nothing else. */
function ghFor(generations, { extraReleases = [], listFails = false } = {}) {
  const calls = [];
  return {
    calls,
    run(command, args) {
      expect(command).toBe('gh');
      calls.push(args.join(' '));
      if (args[0] === 'release' && args[1] === 'list') {
        if (listFails) return { status: 1, stderr: 'network down' };
        const rows = [
          ...generations.map((row) => ({ tagName: row.tag, isDraft: row.isDraft, createdAt: row.createdAt })),
          ...extraReleases,
        ];
        return { status: 0, stdout: JSON.stringify(rows) };
      }
      if (args[0] === 'release' && args[1] === 'view') {
        const found = generations.find((row) => row.tag === args[2]);
        if (!found) return { status: 1, stderr: 'release not found' };
        return { status: 0, stdout: JSON.stringify({ tagName: found.tag, isDraft: found.isDraft, assets: found.assets }) };
      }
      if (args[0] === 'release' && args[1] === 'download') {
        const found = generations.find((row) => row.tag === args[2]);
        if (!found || found.receipt === null) return { status: 1, stderr: 'asset not found' };
        fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'corpus-receipt.json'), JSON.stringify(found.receipt));
        return { status: 0, stdout: '' };
      }
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    },
  };
}

const resolve = (root, gh) => resolveNextCorpusSeed({ repo: 'stuinfla/ruvnet-brain', root, run: gh.run });

describe('corpus next-seed resolution (ADR-086 step 18)', () => {
  it('GREEN: night N+1 seeds from night N\'s verified compatible generation', () => {
    const latest = generation('7', { createdAt: '2026-09-13T00:00:00Z' });
    const older = generation('5', { createdAt: '2026-09-11T00:00:00Z' });
    const { seed } = resolve(workspace(), ghFor([older, latest]));
    expect(seed.origin).toBe('published-generation');
    expect(seed.tag).toBe(latest.tag);
    expect(seed.sha256).toBe(latest.sha256);
    expect(seed.bytes).toBe(600_000_000);
    expect(seed.brainVersion).toBe(APPROVED_VERSION);
  });

  it('orders by publication time, not by the order the API happened to list them', () => {
    const newest = generation('4', { createdAt: '2026-09-13T09:00:00Z' });
    const middle = generation('6', { createdAt: '2026-09-12T09:00:00Z' });
    const { seed } = resolve(workspace(), ghFor([middle, newest]));
    expect(seed.tag).toBe(newest.tag);
  });

  it('RED (incompatible runtime): a generation built against another shipped runtime is rejected', () => {
    const incompatible = generation('3', {
      createdAt: '2026-09-13T00:00:00Z',
      receipt: { archiveManifestVersion: '4.4.0', archiveManifestReleaseTag: 'v4.4.0' },
    });
    const compatible = generation('2', { createdAt: '2026-09-12T00:00:00Z' });
    const { seed, rejected } = resolve(workspace(), ghFor([incompatible, compatible]));
    expect(seed.tag).toBe(compatible.tag);
    expect(rejected.map((row) => row.reason).join('\n')).toMatch(/incompatible: generation shipped runtime v4\.4\.0, approved runtime is v4\.3\.25/);
  });

  it.each([
    ['a missing detached signature', {
      assets: [{ name: 'ruvnet-brain.zip', size: 1, state: 'uploaded' }, { name: 'corpus-receipt.json', size: 1, state: 'uploaded' }],
    }, /expected exactly one ruvnet-brain\.zip\.sig asset/],
    ['a missing corpus receipt asset', {
      assets: [{ name: 'ruvnet-brain.zip', size: 1, state: 'uploaded' }, { name: 'ruvnet-brain.zip.sig', size: 1, state: 'uploaded' }],
    }, /expected exactly one corpus-receipt\.json asset/],
    ['a half-uploaded duplicate archive', {
      assets: [...ASSETS(1), { name: 'ruvnet-brain.zip', size: 1, state: 'uploaded' }],
    }, /expected exactly one ruvnet-brain\.zip asset/],
    ['a draft release', { release: { isDraft: true } }, /draft/],
    ['a schema-downgraded receipt', { receipt: { schemaVersion: 2 } }, /not a schema-3 corpus candidate/],
    ['a receipt with no retrieval-accuracy binding', { receipt: { accuracyReport: undefined } },
      /carries no retrieval-accuracy binding/],
    ['a receipt whose archive digest is not the tag digest', {
      receipt: { archive: { file: 'ruvnet-brain.zip', sha256: digest('0'), bytes: 600_000_000 } },
    }, /disagrees with the content-addressed tag/],
    ['a receipt that cannot be downloaded', { receipt: null }, /corpus receipt could not be downloaded/],
  ])('RED (unverified): %s is rejected and the committed bootstrap is used instead', (_name, overrides, message) => {
    const broken = generation('8', { createdAt: '2026-09-13T00:00:00Z', ...overrides });
    if (overrides.receipt === null) broken.receipt = null;
    const { seed, rejected } = resolve(workspace(), ghFor([broken]));
    expect(seed.origin).toBe('committed-bootstrap');
    expect(seed.sha256).toBe(BOOTSTRAP_SHA);
    expect(rejected.map((row) => row.reason).join('\n')).toMatch(message);
  });

  it('never treats a code release or a mutable pointer as a corpus generation', () => {
    const gh = ghFor([], { extraReleases: [
      { tagName: 'v4.3.25', isDraft: false, createdAt: '2026-09-13T00:00:00Z' }, // sync-version-ignore: fixture code release
      { tagName: 'latest', isDraft: false, createdAt: '2026-09-13T00:00:00Z' },
      { tagName: 'corpus-sha256-TOOSHORT', isDraft: false, createdAt: '2026-09-13T00:00:00Z' },
    ] });
    const { seed } = resolve(workspace(), gh);
    expect(seed.origin).toBe('committed-bootstrap');
    // Not one of them was even looked up: the tag shape alone disqualifies them.
    expect(gh.calls.filter((call) => call.startsWith('release view'))).toEqual([]);
  });

  it('falls back to the committed bootstrap when the release list itself is unavailable', () => {
    const { seed, rejected } = resolve(workspace(), ghFor([], { listFails: true }));
    expect(seed.origin).toBe('committed-bootstrap');
    expect(seed.tag).toBe('v4.2.1-dev'); // sync-version-ignore: the immutable committed bootstrap seed tag
    expect(rejected[0].reason).toMatch(/release list failed/);
  });

  it('DOES NOT COMMIT A NEW POINTER: the committed bootstrap file is never rewritten', () => {
    const root = workspace();
    const before = fs.readFileSync(path.join(root, 'data/corpus-seed.json'), 'utf8');
    resolve(root, ghFor([generation('7', { createdAt: '2026-09-13T00:00:00Z' })]));
    expect(fs.readFileSync(path.join(root, 'data/corpus-seed.json'), 'utf8')).toBe(before);
  });

  it('refuses to run at all without an owner-approved runtime pin', () => {
    const root = workspace();
    fs.rmSync(path.join(root, 'data/approved-runtime.json'));
    expect(() => resolve(root, ghFor([]))).toThrow(/no approved runtime pin/);
  });

  it.each([
    ['a mutable latest pointer', { tag: 'latest' }, /tag is missing or forbidden/],
    ['a malformed digest', { sha256: 'nope' }, /sha256 is malformed/],
    ['a zero byte length', { bytes: 0 }, /bytes is malformed/],
    ['the wrong asset name', { asset: 'other.zip' }, /asset must be ruvnet-brain\.zip/],
  ])('rejects %s in the committed bootstrap descriptor', (_name, overrides, message) => {
    const failures = validateBootstrapSeed({
      schemaVersion: 1, tag: 'v4.2.1-dev', asset: 'ruvnet-brain.zip', sha256: BOOTSTRAP_SHA, bytes: 1, ...overrides, // sync-version-ignore: the immutable committed bootstrap seed tag
    });
    expect(failures.join('\n')).toMatch(message);
  });
});
