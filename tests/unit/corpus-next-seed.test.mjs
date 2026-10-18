import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCompatibilityProfile, main, parseBuildFingerprint, resolveNextCorpusSeed, SEARCH_BOUND, validateBootstrapSeed,
} from '../../scripts/corpus-next-seed.mjs';
import { readRecallReport, tally } from '../../scripts/oracle/repo-recall.mjs';
import { createCoverageReceipt } from '../../scripts/corpus-coverage-sidecar.mjs';
import { ineligibleRepositoryRow, writeCoverageFor } from '../helpers/corpus-seed-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

const digest = (seed) => seed.repeat(64).slice(0, 64);
const BOOTSTRAP_SHA = digest('9');
const FIXTURE_SHA = digest('f');
const MODEL = 'Xenova/bge-base-en-v1.5';
// A runtime OLDER than anything a consumer would pin. Since ADR-0091 D4 nothing gates on it.
const OLD_RUNTIME = { archiveManifestVersion: '4.3.26', archiveManifestReleaseTag: 'v4.3.26' }; // sync-version-ignore: fixture older runtime identity

// The REAL repo-recall reader, with a fixed expectation, so the recall check is exercised end to end.
const PROFILE = { model: MODEL, dimensions: 768, fixtureSha256: FIXTURE_SHA, floorValue: 0, readRecallReport };

function workspace({ bootstrap } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-next-seed-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/corpus-seed.json'), JSON.stringify(bootstrap ?? {
    schemaVersion: 1,
    tag: 'v4.3.26', // sync-version-ignore: the committed bootstrap seed tag
    asset: 'ruvnet-brain.zip',
    sha256: BOOTSTRAP_SHA,
    bytes: 555545135,
    sourceCommit: 'b'.repeat(40),
  }));
  return root;
}

const ASSETS = (bytes) => [
  { name: 'ruvnet-brain.zip', size: bytes, state: 'uploaded' },
  { name: 'ruvnet-brain.zip.sig', size: 64, state: 'uploaded' },
  { name: 'corpus-receipt.json', size: 2048, state: 'uploaded' },
  { name: 'ruvnet-brain.zip.recall.json', size: 900, state: 'uploaded' },
  { name: 'ruvnet-brain.zip.accuracy.json', size: 900, state: 'uploaded' },
];

/** A real-shaped repo-recall report bound to one archive and one fixture digest. */
function recallReport({ sha256, bytes, fixtureSha256 = FIXTURE_SHA, rowOverrides = {} }) {
  const rows = [{ store: 'alpha', expectedPath: 'README.md', repoCovered: true, exactFileRank: 1, returnedPaths: ['alpha/README.md'], ...rowOverrides }];
  return {
    schemaVersion: 1, kind: 'ruvnet-brain-repo-recall', state: 'PASS', failures: [],
    archive: { file: 'ruvnet-brain.zip', sha256, bytes },
    fixture: { file: 'data/retrieval-query-evidence.json', sha256: fixtureSha256, sourceCommit: null, questionCount: rows.length },
    floor: { value: 0, committed: null, absolute: 0, acceptedForRelease: null },
    totals: tally(rows),
    rows,
  };
}

function generation(seed, overrides = {}) {
  const sha256 = digest(seed);
  const bytes = 600_000_000;
  const recallText = JSON.stringify(overrides.recall ?? recallReport({ sha256, bytes, ...(overrides.recallOptions || {}) }));
  const recallSha = crypto.createHash('sha256').update(recallText).digest('hex');
  return {
    tag: `corpus-sha256-${sha256}`,
    sha256,
    bytes,
    isDraft: false,
    createdAt: overrides.createdAt || '2026-09-10T00:00:00Z',
    assets: overrides.assets || ASSETS(bytes),
    recallText,
    receipt: {
      // ADR-086 Step 15 / A6: schema 3, and the accuracy binding is part of what makes a published
      // generation seedable at all.
      schemaVersion: 3,
      kind: 'ruvnet-brain-corpus-candidate',
      builderSourceSha: 'c'.repeat(40),
      archive: { file: 'ruvnet-brain.zip', sha256, bytes },
      accuracyReport: { file: 'ruvnet-brain.zip.accuracy.json', sha256: 'a'.repeat(64), bytes: 2048 },
      recallReport: { file: 'ruvnet-brain.zip.recall.json', sha256: recallSha, bytes: Buffer.byteLength(recallText) },
      stores: [
        { name: 'alpha', kind: 'repository', model: MODEL, dimensions: 768 },
        { name: 'beta', kind: 'repository', model: MODEL, dimensions: 768 },
      ],
      ...OLD_RUNTIME,
      ...(overrides.receipt || {}),
    },
    ...(overrides.release || {}),
  };
}

/**
 * A fake `gh` that answers only list/view/download, records every call, and writes the requested
 * asset. It NEVER serves the archive: a download of ruvnet-brain.zip itself throws, so a test passes
 * only if the resolver judges every generation from small files.
 */
function ghFor(generations, { extraReleases = [], listFails = false } = {}) {
  const calls = [];
  return {
    calls,
    downloads: () => calls.filter((call) => call.startsWith('release download')),
    run(command, args) {
      expect(command).toBe('gh');
      calls.push(args.join(' '));
      if (args[0] === 'release' && args[1] === 'list') {
        if (listFails) return { status: 1, stderr: 'network down' };
        // Like real gh: only the fields named after --json come back. A resolver that stops asking for
        // isPrerelease gets rows without it, and its prerelease rule goes blind -- caught here, not in CI.
        const fields = String(args[args.indexOf('--json') + 1] || '').split(',');
        const project = (full) => Object.fromEntries(fields.map((field) => [field, full[field]]));
        const rows = [
          ...generations.map((row) => project({ tagName: row.tag, isDraft: row.isDraft, isPrerelease: row.isPrerelease === true,
            createdAt: row.createdAt, publishedAt: row.createdAt })),
          ...extraReleases.map((row) => project({ isPrerelease: false, ...row })),
        ];
        return { status: 0, stdout: JSON.stringify(rows) };
      }
      if (args[0] === 'release' && args[1] === 'view') {
        const found = generations.find((row) => row.tag === args[2]);
        if (!found) return { status: 1, stderr: 'release not found' };
        return { status: 0, stdout: JSON.stringify({ tagName: found.tag, isDraft: found.isDraft, assets: found.assets }) };
      }
      if (args[0] === 'release' && args[1] === 'download') {
        const pattern = args[args.indexOf('--pattern') + 1];
        if (pattern === 'ruvnet-brain.zip') throw new Error('the resolver downloaded a ~500 MB archive; it must judge from small files only');
        const found = generations.find((row) => row.tag === args[2]);
        const dir = args[args.indexOf('--dir') + 1];
        if (pattern === 'corpus-receipt.json') {
          if (!found || found.receipt === null) return { status: 1, stderr: 'asset not found' };
          fs.writeFileSync(path.join(dir, pattern), JSON.stringify(found.receipt));
          return { status: 0, stdout: '' };
        }
        if (pattern === 'ruvnet-brain.zip.recall.json') {
          if (!found || found.recallText === null) return { status: 1, stderr: 'asset not found' };
          fs.writeFileSync(path.join(dir, pattern), found.recallText);
          return { status: 0, stdout: '' };
        }
        if (pattern === 'CORPUS-COVERAGE.json' || pattern === 'coverage-receipt.json') {
          const text = found?.coverageAssets?.[pattern];
          if (text == null) return { status: 1, stderr: 'asset not found' };
          fs.writeFileSync(path.join(dir, pattern), text);
          return { status: 0, stdout: '' };
        }
      }
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    },
  };
}

const resolve = (root, gh, extra = {}) => resolveNextCorpusSeed({
  repo: 'stuinfla/ruvnet-brain', root, run: gh.run, profile: PROFILE, ...extra });
const reasons = (rejected) => rejected.map((row) => `${row.tag}: ${row.reason}`).join('\n');

describe('corpus next-seed resolution (ADR-086 step 18, ADR-0091 D4)', () => {
  it('GREEN: night N+1 seeds from night N\'s verified compatible generation, judged from small files only', async () => {
    const latest = generation('7', { createdAt: '2026-09-13T00:00:00Z' });
    const older = generation('5', { createdAt: '2026-09-11T00:00:00Z' });
    const gh = ghFor([older, latest]);
    const { seed, judged } = await resolve(workspace(), gh);
    expect(seed.origin).toBe('published-generation');
    expect(seed.tag).toBe(latest.tag);
    expect(seed.sha256).toBe(latest.sha256);
    expect(seed.bytes).toBe(600_000_000);
    // `judged` counts generations actually judged until one resolved: the newest resolved first, so one.
    // (Before 2026-10-17 it reported min(candidates, SEARCH_BOUND) regardless of where the walk stopped.)
    expect(judged).toBe(1);
    // Exactly the receipt and the recall report were fetched, and nothing else.
    expect(gh.downloads()).toEqual([
      `release download ${latest.tag} --repo stuinfla/ruvnet-brain --pattern corpus-receipt.json --dir ${gh.downloads()[0].split('--dir ')[1]}`,
      `release download ${latest.tag} --repo stuinfla/ruvnet-brain --pattern ruvnet-brain.zip.recall.json --dir ${gh.downloads()[1].split('--dir ')[1]}`,
    ]);
  });

  it('ACCEPTS a generation built under an OLDER runtime (the pre-D4 rule rejected it and reset the chain)', async () => {
    const built = generation('3', { createdAt: '2026-09-13T00:00:00Z' });
    expect(built.receipt.archiveManifestVersion).toBe('4.3.26'); // sync-version-ignore: fixture older runtime identity
    const { seed, rejected } = await resolve(workspace(), ghFor([built]));
    expect(seed.origin).toBe('published-generation');
    expect(seed.tag).toBe(built.tag);
    expect(seed.brainVersion).toBe('4.3.26'); // sync-version-ignore: informational only
    expect(reasons(rejected)).not.toMatch(/runtime/);
  });

  it('orders by publication time, not by the order the API happened to list them', async () => {
    const newest = generation('4', { createdAt: '2026-09-13T09:00:00Z' });
    const middle = generation('6', { createdAt: '2026-09-12T09:00:00Z' });
    const { seed } = await resolve(workspace(), ghFor([middle, newest]));
    expect(seed.tag).toBe(newest.tag);
  });

  describe('compatibility is judged BEFORE any archive download', () => {
    it('RED (model): a store embedded with another model is rejected from the receipt alone -- not even the recall report is fetched', async () => {
      const foreign = generation('3', {
        createdAt: '2026-09-13T00:00:00Z',
        receipt: { stores: [{ name: 'alpha', model: MODEL, dimensions: 768 }, { name: 'beta', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 768 }] },
      });
      const gh = ghFor([foreign]);
      const { seed, rejected } = await resolve(workspace(), gh);
      expect(seed.origin).toBe('committed-bootstrap');
      expect(reasons(rejected)).toMatch(/incompatible: 1 store\(s\) embedded with a different model\/dimensions \(e\.g\. beta: Xenova\/all-MiniLM-L6-v2\/768\)/);
      expect(gh.downloads()).toHaveLength(1);
      expect(gh.downloads()[0]).toMatch(/--pattern corpus-receipt\.json /);
    });

    it('RED (dimensions): same model, different dimensions, is rejected from the receipt alone', async () => {
      const foreign = generation('3', { receipt: { stores: [{ name: 'alpha', model: MODEL, dimensions: 384 }] } });
      const gh = ghFor([foreign]);
      const { seed, rejected } = await resolve(workspace(), gh);
      expect(seed.origin).toBe('committed-bootstrap');
      expect(reasons(rejected)).toMatch(/alpha: Xenova\/bge-base-en-v1\.5\/384\); this runtime builds Xenova\/bge-base-en-v1\.5\/768/);
      expect(gh.downloads().some((call) => /recall\.json/.test(call))).toBe(false);
    });

    it('RED (fixture digest): a generation measured against another frozen fixture is SKIPPED and the next older one chosen', async () => {
      const mismatched = generation('8', { createdAt: '2026-09-13T00:00:00Z', recallOptions: { fixtureSha256: digest('e') } });
      const compatible = generation('2', { createdAt: '2026-09-12T00:00:00Z' });
      const gh = ghFor([mismatched, compatible]);
      const { seed, rejected } = await resolve(workspace(), gh);
      expect(seed.origin).toBe('published-generation');
      expect(seed.tag).toBe(compatible.tag);
      expect(reasons(rejected)).toMatch(new RegExp(`${mismatched.tag}: incompatible: recall report was measured against fixture eeeeeeeeeeee, this runtime's frozen fixture is ffffffffffff`));
      // No archive was fetched for either (ghFor throws if one is); only small files.
      expect(gh.downloads().every((call) => /--pattern (corpus-receipt\.json|ruvnet-brain\.zip\.recall\.json) /.test(call))).toBe(true);
    });

    it('RED (reader): a recall report this runtime\'s own reader refuses is skipped (e.g. a repository that answered nothing)', async () => {
      const failing = generation('8', { createdAt: '2026-09-13T00:00:00Z', recallOptions: { rowOverrides: { repoCovered: false, exactFileRank: null } } });
      const compatible = generation('2', { createdAt: '2026-09-12T00:00:00Z' });
      const { seed, rejected } = await resolve(workspace(), ghFor([failing, compatible]));
      expect(seed.tag).toBe(compatible.tag);
      expect(reasons(rejected)).toMatch(/incompatible: recall report fails this runtime's reader \(repo-recall integrity FAILED: 1 repository\(ies\) returned nothing of their own\)/);
    });

    it('RED (binding): a recall report that is not the one the receipt binds is rejected', async () => {
      const swapped = generation('8');
      swapped.recallText = JSON.stringify(recallReport({ sha256: swapped.sha256, bytes: swapped.bytes, rowOverrides: { exactFileRank: 2 } }));
      const { seed, rejected } = await resolve(workspace(), ghFor([swapped]));
      expect(seed.origin).toBe('committed-bootstrap');
      expect(reasons(rejected)).toMatch(/repo-recall report is not the one the receipt binds/);
    });

    it('RED (archive binding): a recall report measured on other archive bytes fails the reader', async () => {
      const other = generation('8', { recallOptions: { sha256: digest('1'), bytes: 600_000_000 } });
      const { seed, rejected } = await resolve(workspace(), ghFor([other]));
      expect(seed.origin).toBe('committed-bootstrap');
      expect(reasons(rejected)).toMatch(/repo-recall report does not describe this archive/);
    });
  });

  it(`walks at most ${SEARCH_BOUND} generations, then falls back to the committed bootstrap`, async () => {
    const all = Array.from({ length: 7 }, (_, index) => generation(String(index + 1), {
      createdAt: `2026-09-${String(20 - index).padStart(2, '0')}T00:00:00Z`,
      recallOptions: { fixtureSha256: digest('e') }, // every one incompatible
    }));
    // The 6th and 7th newest would be COMPATIBLE -- and must still never be judged.
    for (const late of all.slice(5)) Object.assign(late, generation(late.sha256[0], { createdAt: late.createdAt }));
    const gh = ghFor(all);
    const { seed, rejected, judged } = await resolve(workspace(), gh);
    expect(SEARCH_BOUND).toBe(5);
    expect(judged).toBe(5);
    expect(seed.origin).toBe('committed-bootstrap');
    expect(gh.calls.filter((call) => call.startsWith('release view'))).toHaveLength(5);
    for (const late of all.slice(5)) {
      expect(gh.calls.some((call) => call.includes(late.tag))).toBe(false);
      expect(reasons(rejected)).toMatch(new RegExp(`${late.tag}: not judged: older than the 5 newest generations`));
    }
  });

  it('falls back within the bound: the 5th newest is accepted when the 4 newer are incompatible', async () => {
    const all = Array.from({ length: 5 }, (_, index) => generation(String(index + 1), {
      createdAt: `2026-09-${String(20 - index).padStart(2, '0')}T00:00:00Z`,
      ...(index < 4 ? { receipt: { stores: [{ name: 'alpha', model: 'other/model', dimensions: 768 }] } } : {}),
    }));
    const { seed, rejected } = await resolve(workspace(), ghFor(all));
    expect(seed.tag).toBe(all[4].tag);
    expect(rejected.filter((row) => /^incompatible/.test(row.reason))).toHaveLength(4);
  });

  it.each([
    ['a missing detached signature', { assets: ASSETS(1).filter(({ name }) => name !== 'ruvnet-brain.zip.sig') },
      /expected exactly one ruvnet-brain\.zip\.sig asset/],
    ['a missing corpus receipt asset', { assets: ASSETS(1).filter(({ name }) => name !== 'corpus-receipt.json') },
      /expected exactly one corpus-receipt\.json asset/],
    ['a missing recall report asset', { assets: ASSETS(1).filter(({ name }) => name !== 'ruvnet-brain.zip.recall.json') },
      /expected exactly one ruvnet-brain\.zip\.recall\.json asset/],
    ['a missing accuracy report asset (corpus-seed.yml requires it downstream)',
      { assets: ASSETS(1).filter(({ name }) => name !== 'ruvnet-brain.zip.accuracy.json') },
      /expected exactly one ruvnet-brain\.zip\.accuracy\.json asset/],
    ['a half-uploaded duplicate archive', { assets: [...ASSETS(1), { name: 'ruvnet-brain.zip', size: 1, state: 'uploaded' }] },
      /expected exactly one ruvnet-brain\.zip asset/],
    ['a draft release', { release: { isDraft: true } }, /draft/],
    ['a schema-downgraded receipt', { receipt: { schemaVersion: 2 } }, /not a schema-3 corpus candidate/],
    ['a receipt with no retrieval-accuracy binding', { receipt: { accuracyReport: undefined } },
      /carries no retrieval-accuracy binding/],
    ['a receipt with no repo-recall binding', { receipt: { recallReport: undefined } }, /carries no repo-recall binding/],
    ['a receipt that lists no stores', { receipt: { stores: [] } }, /receipt lists no stores/],
    ['a receipt whose archive digest is not the tag digest', {
      receipt: { archive: { file: 'ruvnet-brain.zip', sha256: digest('0'), bytes: 600_000_000 } },
    }, /disagrees with the content-addressed tag/],
    ['a receipt that cannot be downloaded', { receipt: null }, /corpus receipt could not be downloaded/],
  ])('RED (unverified): %s is rejected and the committed bootstrap is used instead', async (_name, overrides, message) => {
    const broken = generation('8', { createdAt: '2026-09-13T00:00:00Z', ...overrides });
    if (overrides.receipt === null) broken.receipt = null;
    const { seed, rejected } = await resolve(workspace(), ghFor([broken]));
    expect(seed.origin).toBe('committed-bootstrap');
    expect(seed.sha256).toBe(BOOTSTRAP_SHA);
    expect(reasons(rejected)).toMatch(message);
  });

  it('never treats a code release or a mutable pointer as a corpus generation', async () => {
    const gh = ghFor([], { extraReleases: [
      { tagName: 'v4.3.25', isDraft: false, createdAt: '2026-09-13T00:00:00Z' }, // sync-version-ignore: fixture code release
      { tagName: 'latest', isDraft: false, createdAt: '2026-09-13T00:00:00Z' },
      { tagName: 'corpus-sha256-TOOSHORT', isDraft: false, createdAt: '2026-09-13T00:00:00Z' },
    ] });
    const { seed } = await resolve(workspace(), gh);
    expect(seed.origin).toBe('committed-bootstrap');
    // Not one of them was even looked up: the tag shape alone disqualifies them.
    expect(gh.calls.filter((call) => call.startsWith('release view'))).toEqual([]);
  });

  it('falls back to the committed bootstrap when the release list itself is unavailable', async () => {
    const { seed, rejected } = await resolve(workspace(), ghFor([], { listFails: true }));
    expect(seed.origin).toBe('committed-bootstrap');
    expect(seed.tag).toBe('v4.3.26'); // sync-version-ignore: the committed bootstrap seed tag
    expect(rejected[0].reason).toMatch(/release list failed/);
  });

  it('DOES NOT COMMIT A NEW POINTER: the committed bootstrap file is never rewritten', async () => {
    const root = workspace();
    const before = fs.readFileSync(path.join(root, 'data/corpus-seed.json'), 'utf8');
    await resolve(root, ghFor([generation('7', { createdAt: '2026-09-13T00:00:00Z' })]));
    expect(fs.readFileSync(path.join(root, 'data/corpus-seed.json'), 'utf8')).toBe(before);
  });

  it.each([
    ['a mutable latest pointer', { tag: 'latest' }, /tag is missing or forbidden/],
    ['a malformed digest', { sha256: 'nope' }, /sha256 is malformed/],
    ['a zero byte length', { bytes: 0 }, /bytes is malformed/],
    ['the wrong asset name', { asset: 'other.zip' }, /asset must be ruvnet-brain\.zip/],
  ])('rejects %s in the committed bootstrap descriptor', (_name, overrides, message) => {
    const failures = validateBootstrapSeed({
      schemaVersion: 1, tag: 'v4.3.26', asset: 'ruvnet-brain.zip', sha256: BOOTSTRAP_SHA, bytes: 1, ...overrides, // sync-version-ignore: the committed bootstrap seed tag
    });
    expect(failures.join('\n')).toMatch(message);
  });
});

describe('the compatibility profile is read from the consuming runtime, never restated', () => {
  it('reads model/dimensions from FORGE_BUILD_FINGERPRINT and the fixture digest from that tree\'s loadFixture', async () => {
    const profile = await loadCompatibilityProfile({ runtimeRoot: ROOT });
    const { FORGE_BUILD_FINGERPRINT } = await import('../../kb/forge-corpus.mjs');
    const { loadFixture } = await import('../../scripts/oracle/repo-recall.mjs');
    expect(profile).toMatchObject({ ...parseBuildFingerprint(FORGE_BUILD_FINGERPRINT), fixtureSha256: loadFixture().fixtureSha256, floorValue: 0 });
    expect(profile.model).toBe(MODEL);
    expect(profile.dimensions).toBe(768);
  });

  it('judges against --runtime-root, so an approved runtime older than main is what decides', async () => {
    // A stand-in "approved runtime" tree whose fixture differs from this checkout's.
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-next-seed-runtime-'));
    dirs.push(runtimeRoot);
    // repo-recall's import closure (ADR-0091 D7 added the shared retirement rule and the coverage ledger validator).
    for (const relative of ['scripts/oracle/repo-recall.mjs', 'kb/forge-corpus.mjs', 'kb/incremental-refresh.mjs', 'kb/rvf-index.mjs', 'kb/zip-extract.mjs',
      'scripts/fixture-denominator.mjs', 'scripts/coverage-integrity.mjs', 'plugin/scripts/coverage-integrity.mjs']) {
      fs.mkdirSync(path.dirname(path.join(runtimeRoot, relative)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, relative), path.join(runtimeRoot, relative));
    }
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/retrieval-query-evidence.json'), 'utf8'));
    const [firstStore] = Object.keys(fixture.queries);
    fixture.queries = { [firstStore]: fixture.queries[firstStore] };
    fs.mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'data/retrieval-query-evidence.json'), JSON.stringify(fixture));

    const here = await loadCompatibilityProfile({ runtimeRoot: ROOT });
    const there = await loadCompatibilityProfile({ runtimeRoot });
    expect(there.fixtureSha256).not.toBe(here.fixtureSha256);

    // A generation measured against THIS checkout's fixture is incompatible with that runtime.
    const built = generation('7', { recallOptions: { fixtureSha256: here.fixtureSha256 } });
    const root = workspace();
    const underThere = await resolveNextCorpusSeed({ repo: 'o/r', root, run: ghFor([built]).run, runtimeRoot });
    expect(underThere.seed.origin).toBe('committed-bootstrap');
    const underHere = await resolveNextCorpusSeed({ repo: 'o/r', root, run: ghFor([built]).run, runtimeRoot: ROOT });
    expect(underHere.seed.tag).toBe(built.tag);
  });

  it('parses the fingerprint and refuses one it cannot read', () => {
    expect(parseBuildFingerprint('forge-corpus-v1|Xenova/bge-base-en-v1.5@abc:768:cls')).toEqual({ model: MODEL, dimensions: 768 });
    expect(() => parseBuildFingerprint('garbage')).toThrow(/cannot read the embedding model/);
  });
});

describe('--pin is gone (ADR-0091 D4)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/corpus-next-seed.mjs'), 'utf8');
  const code = source.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

  it('the resolver neither imports the approved-runtime module nor reads a pin', () => {
    expect(code).not.toMatch(/approved-runtime/);
    expect(code).not.toMatch(/readApprovedRuntime|validateApprovedRuntime|pinFile|approved\./);
    expect(code).not.toMatch(/arg\([^)]*'--pin'/);
  });

  it('resolves with no pin at all, even when a stray committed pin file sits in the checkout', async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, 'data/approved-runtime.json'), '{"not":"read"}');
    const { seed } = await resolve(root, ghFor([generation('7')]));
    expect(seed.origin).toBe('published-generation');
  });

  it('the CLI refuses --pin loudly instead of silently ignoring it', async () => {
    let err = '';
    const code = await main(['--repo', 'o/r', '--pin', '/tmp/x.json'], { stderr: { write: (text) => { err += text; } } });
    expect(code).toBe(2);
    expect(err).toMatch(/--pin was removed by ADR-0091 D4/);
  });

  it('the CLI resolves and writes the descriptor without --pin', async () => {
    const root = workspace();
    const out = path.join(root, 'next-seed.json');
    let printed = ''; let err = '';
    const { loadFixture } = await import('../../scripts/oracle/repo-recall.mjs');
    const fixtureSha256 = loadFixture().fixtureSha256;
    const real = generation('7', { recallOptions: { fixtureSha256 } });
    const code = await main(['--repo', 'o/r', '--bootstrap', path.join(root, 'data/corpus-seed.json'), '--out', out],
      { run: ghFor([real]).run, stdout: { write: (text) => { printed += text; } }, stderr: { write: (text) => { err += text; } } });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toEqual(JSON.parse(printed));
    expect(JSON.parse(printed).tag).toBe(real.tag);
    expect(err).toContain(`(judged 1 generation(s) against ${MODEL}/768, fixture ${fixtureSha256.slice(0, 12)})`);
  });
});

// ---------------------------------------------------------------------------------------------
// ADR-0091 D6.2: the code-release mode (--require-coverage)
// ---------------------------------------------------------------------------------------------

/** A generation that published its sealed coverage sidecar, bound to its own receipt. */
async function coveredGeneration(seed, overrides = {}) {
  const alphaRvf = { file: 'alpha.big.rvf', sha256: '1'.repeat(64), bytes: 10 };
  const stores = [{ name: 'alpha', kind: 'repository', model: MODEL, dimensions: 768, sourceCommit: 'a'.repeat(40), files: [alphaRvf] }];
  const row = generation(seed, { ...overrides, receipt: { stores, ...(overrides.receipt || {}) } });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'covered-generation-'));
  dirs.push(scratch);
  const coverageFile = path.join(scratch, 'coverage.json');
  await writeCoverageFor(row.receipt, coverageFile, overrides.coverageOptions || {});
  const coverageText = fs.readFileSync(coverageFile, 'utf8');
  const sidecar = createCoverageReceipt({ generationTag: row.tag, archiveSha256: row.sha256, archiveBytes: row.bytes,
    coverageBytes: Buffer.from(coverageText) });
  row.coverageAssets = { 'CORPUS-COVERAGE.json': coverageText, 'coverage-receipt.json': JSON.stringify(overrides.sidecar?.(sidecar) ?? sidecar) };
  row.assets = [...row.assets, { name: 'CORPUS-COVERAGE.json', size: coverageText.length, state: 'uploaded' },
    { name: 'coverage-receipt.json', size: 300, state: 'uploaded' }];
  return row;
}

describe('code-release resolution requires the D6.2 coverage sidecar (ADR-0091 D6)', () => {
  it('GREEN: resolves a generation that published its coverage, and seals the coverage identity into the descriptor', async () => {
    const covered = await coveredGeneration('7', { createdAt: '2026-09-13T00:00:00Z' });
    const gh = ghFor([covered]);
    const { seed, rejected } = await resolve(workspace(), gh, { requireCoverage: true });
    expect(reasons(rejected)).toBe('');
    expect(seed).toMatchObject({ origin: 'published-generation', tag: covered.tag,
      coverage: { asset: 'CORPUS-COVERAGE.json', receiptAsset: 'coverage-receipt.json', degraded: { carried: [], missing: [] } } });
    expect(seed.coverage.sha256).toBe(crypto.createHash('sha256').update(covered.coverageAssets['CORPUS-COVERAGE.json']).digest('hex'));
    expect(gh.downloads().some((call) => call.includes('--pattern ruvnet-brain.zip '))).toBe(false);
  });

  it('a pre-D6.2 generation (no sidecar) is skipped for a code release but stays a valid NIGHTLY seed', async () => {
    const older = await coveredGeneration('5', { createdAt: '2026-09-11T00:00:00Z' });
    const bare = generation('7', { createdAt: '2026-09-13T00:00:00Z' });
    const codeRelease = await resolve(workspace(), ghFor([older, bare]), { requireCoverage: true });
    expect(codeRelease.seed.tag).toBe(older.tag);
    expect(reasons(codeRelease.rejected)).toMatch(new RegExp(`${bare.tag}: incompatible for a code release: no coverage sidecar`));
    const nightly = await resolve(workspace(), ghFor([older, bare]));
    expect(nightly.seed.tag).toBe(bare.tag);
    expect(nightly.seed.coverage).toBeUndefined();
  });

  // 2026-10-17 (reviewer finding): a generation that is still a PRERELEASE was staged but never promoted --
  // the customer canary refused it, or a newer code release superseded it. No customer received it, so
  // neither a night nor a code release may build on it. The prerelease flag is the promotion state
  // protected-release.yml corpus-promote clears (release.mjs --promote-staged).
  it('REFUSES an unpromoted prerelease as a seed, for a code release AND for the nightly, with its reason named', async () => {
    const refused = await coveredGeneration('9', { createdAt: '2026-09-14T00:00:00Z', release: { isPrerelease: true } });
    const promoted = await coveredGeneration('7', { createdAt: '2026-09-13T00:00:00Z' });
    const code = await resolve(workspace(), ghFor([refused, promoted]), { requireCoverage: true });
    expect(code.seed.tag).toBe(promoted.tag);
    expect(reasons(code.rejected)).toMatch(new RegExp(`${refused.tag}: unpromoted: still a prerelease \\(the customer canary never promoted it\\)`));
    const nightly = await resolve(workspace(), ghFor([refused, promoted]));
    expect(nightly.seed.tag).toBe(promoted.tag);
    expect(reasons(nightly.rejected)).toMatch(/unpromoted: still a prerelease/);
    // Only prereleases -> the committed bootstrap, never a canary-rejected candidate.
    const only = await resolve(workspace(), ghFor([refused]), { requireCoverage: true });
    expect(only.seed.origin).toBe('committed-bootstrap');
  });

  // 2026-10-17 (with the ADR-0091 D10 removal): a promoted generation MAY carry a store at its last verified
  // bytes, and the nightly seeds from it so the next night re-plans that store. A CODE release may not ship
  // it: scripts/public-verification-aggregate.mjs requires coverage.eligibleCurrent === eligibleTotal on
  // every install lane, so such a release could never become install-verified.
  it('a degraded (carried) promoted generation is a valid NIGHTLY seed but is REFUSED for a code release, naming the store', async () => {
    const carried = await coveredGeneration('9', { createdAt: '2026-09-14T00:00:00Z', coverageOptions: { carried: true } });
    const clean = await coveredGeneration('7', { createdAt: '2026-09-13T00:00:00Z' });
    const code = await resolve(workspace(), ghFor([carried, clean]), { requireCoverage: true });
    expect(code.seed.tag).toBe(clean.tag);
    expect(reasons(code.rejected)).toMatch(new RegExp(`${carried.tag}: incompatible for a code release: degraded generation \\(1 carried: alpha; 0 missing: none\\); install verification requires every eligible store CURRENT`));
    const nightly = await resolve(workspace(), ghFor([carried, clean]));
    expect(nightly.seed.tag).toBe(carried.tag);
    expect(reasons(nightly.rejected)).toBe('');
  });

  // Reviewer finding 2026-10-17: a degraded promoted generation is a transient state (the next night re-plans
  // the carried store). If each one consumed the search bound, five degraded nights in a row would walk every
  // code release back to the committed bootstrap -- a pre-ADR-0091 corpus from 2026-09 -- with nothing paging.
  it(`code-release mode: degraded generations are skipped WITHOUT consuming the ${SEARCH_BOUND}-generation bound; incompatible ones still consume it`, async () => {
    const degraded = await Promise.all(Array.from({ length: SEARCH_BOUND + 1 }, (_, index) => coveredGeneration(String(index + 1), {
      createdAt: `2026-09-${String(20 - index).padStart(2, '0')}T00:00:00Z`, coverageOptions: { carried: true } })));
    const clean = await coveredGeneration('9', { createdAt: '2026-09-01T00:00:00Z' });
    const result = await resolve(workspace(), ghFor([...degraded, clean]), { requireCoverage: true });
    expect(result.seed.tag).toBe(clean.tag);
    expect(result.skippedDegraded).toBe(SEARCH_BOUND + 1);
    expect(result.judged).toBe(1);
    expect(reasons(result.rejected).match(/degraded generation/g)).toHaveLength(SEARCH_BOUND + 1);
    expect(reasons(result.rejected)).not.toMatch(/not judged/);
    // The bound itself is intact: incompatible (not degraded) generations still consume it, and an all-degraded
    // walk ends at the committed bootstrap exactly as before -- named, never silent.
    const incompatible = Array.from({ length: SEARCH_BOUND + 1 }, (_, index) => generation(String(index + 1), {
      createdAt: `2026-09-${String(20 - index).padStart(2, '0')}T00:00:00Z`, recallOptions: { fixtureSha256: digest('e') } }));
    const bounded = await resolve(workspace(), ghFor(incompatible), { requireCoverage: true });
    expect(bounded.judged).toBe(SEARCH_BOUND);
    expect(bounded.seed.origin).toBe('committed-bootstrap');
    expect(reasons(bounded.rejected)).toMatch(new RegExp(`${incompatible[SEARCH_BOUND].tag}: not judged`));
    const allDegraded = await resolve(workspace(), ghFor(degraded), { requireCoverage: true });
    expect(allDegraded.seed.origin).toBe('committed-bootstrap');
    expect(allDegraded.skippedDegraded).toBe(SEARCH_BOUND + 1);
  });

  it('only pre-D6.2 generations -> the committed bootstrap (the legacy two-pass path)', async () => {
    const { seed } = await resolve(workspace(), ghFor([generation('7')]), { requireCoverage: true });
    expect(seed).toMatchObject({ origin: 'committed-bootstrap', tag: 'v4.3.26' }); // sync-version-ignore: bootstrap tag
  });

  it.each([
    ['names another generation', { sidecar: (s) => ({ ...s, generationTag: `corpus-sha256-${'0'.repeat(64)}` }) }, /coverage receipt names/],
    ['binds other coverage bytes', { sidecar: (s) => ({ ...s, coverageSha256: '0'.repeat(64) }) }, /not the ones the coverage receipt binds/],
    ['understates degradation', { coverageOptions: { carried: true }, sidecar: (s) => ({ ...s, degraded: { carried: [], missing: [] } }) },
      /degraded summary disagrees/],
    ['describes other RVF bytes than the receipt', { coverageOptions: { rvfSha256: '2'.repeat(64) } }, /different alpha RVF bytes/],
  ])('RED: a sidecar that %s is rejected and the walk moves on', async (_label, overrides, pattern) => {
    const bad = await coveredGeneration('7', { createdAt: '2026-09-13T00:00:00Z', ...overrides });
    const { seed, rejected } = await resolve(workspace(), ghFor([bad]), { requireCoverage: true });
    expect(seed.origin).toBe('committed-bootstrap');
    expect(reasons(rejected)).toMatch(pattern);
  });

  it('marks network failures indeterminate so the publish-time guard cannot mistake them for "nothing newer"', async () => {
    const listFailed = await resolve(workspace(), ghFor([], { listFails: true }), { requireCoverage: true });
    expect(listFailed.rejected).toEqual([expect.objectContaining({ tag: null, indeterminate: true })]);
    const covered = await coveredGeneration('7');
    delete covered.coverageAssets['coverage-receipt.json'];
    const downloadFailed = await resolve(workspace(), ghFor([covered]), { requireCoverage: true });
    expect(downloadFailed.rejected).toEqual([expect.objectContaining({ tag: covered.tag, indeterminate: true })]);
    const incompatible = await resolve(workspace(), ghFor([generation('7')]), { requireCoverage: true });
    expect(incompatible.rejected.some((row) => row.indeterminate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// ADR-0091 D7.3: a recall report that claims retired questions is verified against the generation's
// own sealed coverage -- in the NIGHTLY mode too, or one retirement would strand every night on the
// bootstrap. The claim is recomputed by the reader, never trusted.
// ---------------------------------------------------------------------------------------------

/** Rebind `row`'s recall report to one where `retired` stores are claimed retired against its coverage. */
function claimRetirement(row, retired) {
  const coverageText = row.coverageAssets?.['CORPUS-COVERAGE.json'] ?? '{}';
  const rows = [
    { store: 'alpha', expectedPath: 'README.md', repoCovered: true, exactFileRank: 1, returnedPaths: ['alpha/README.md'] },
    ...retired.map((store) => ({ store, expectedPath: 'README.md', retired: true, repoCovered: false, exactFileRank: null, returnedPaths: [] })),
  ];
  const report = {
    schemaVersion: 1, kind: 'ruvnet-brain-repo-recall', state: 'PASS', failures: [],
    archive: { file: 'ruvnet-brain.zip', sha256: row.sha256, bytes: row.bytes },
    fixture: { file: 'data/retrieval-query-evidence.json', sha256: FIXTURE_SHA, sourceCommit: null, questionCount: rows.length },
    retirement: { coverageSha256: crypto.createHash('sha256').update(coverageText).digest('hex'), stores: [...retired].sort() },
    floor: { value: 0, committed: null, absolute: 0, acceptedForRelease: null },
    totals: tally(rows),
    rows,
  };
  row.recallText = JSON.stringify(report);
  row.receipt.recallReport = { file: 'ruvnet-brain.zip.recall.json',
    sha256: crypto.createHash('sha256').update(row.recallText).digest('hex'), bytes: Buffer.byteLength(row.recallText) };
  return row;
}

describe('seed selection verifies a claimed repo-recall retirement from the generation\'s coverage (ADR-0091 D7.3)', () => {
  it('GREEN (nightly mode): a retirement the sidecar coverage proves is accepted, and the nightly descriptor keeps its shape', async () => {
    // writeCoverageFor observes exactly one repository (alpha), completely: beta has no row -> retired.
    const covered = claimRetirement(await coveredGeneration('7'), ['beta']);
    const gh = ghFor([covered]);
    const { seed, rejected } = await resolve(workspace(), gh);
    expect(reasons(rejected)).toBe('');
    expect(seed).toMatchObject({ origin: 'published-generation', tag: covered.tag });
    expect(seed.coverage).toBeUndefined();
    expect(gh.downloads().some((call) => call.includes('--pattern CORPUS-COVERAGE.json'))).toBe(true);
  });

  it('RED: a FALSE retirement (the repository has a coverage row) is skipped with its reason; the walk falls back', async () => {
    // The coverage gives alpha-twin a row (ineligible): the repository exists, so it is NOT retired.
    const lying = claimRetirement(await coveredGeneration('7', { coverageOptions: { extraRows: [ineligibleRepositoryRow('alpha-twin')] } }),
      ['alpha-twin']);
    const { seed, rejected } = await resolve(workspace(), ghFor([lying]));
    expect(seed.origin).toBe('committed-bootstrap');
    expect(reasons(rejected)).toMatch(/incompatible: recall report fails this runtime's reader .*claims \[alpha-twin\] retired, but the coverage it names does not retire them/);
  });

  it('RED: a claimed retirement from a generation that published no coverage sidecar is unverifiable, so it is skipped', async () => {
    const bare = claimRetirement(generation('7'), ['beta']);
    const { seed, rejected } = await resolve(workspace(), ghFor([bare]));
    expect(seed.origin).toBe('committed-bootstrap');
    expect(reasons(rejected)).toMatch(/claims retired question\(s\) but the generation published no coverage sidecar/);
  });
});
