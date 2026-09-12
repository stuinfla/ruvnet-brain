import { afterEach, beforeEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindAssembledReleaseProjection, createReleaseProjection } from '../../scripts/release-projection.mjs';
import { coverageGenerationFor, validateCoverageDirectory } from '../../plugin/scripts/coverage-integrity.mjs';
import { getVersion } from '../../scripts/version.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
let assetsDir;
const version = getVersion();
const sourceSnapshot = 'd'.repeat(40);
const bind = (overrides = {}) => bindAssembledReleaseProjection({ assetsDir, version, sourceSnapshot, ...overrides });
const project = (corpusCoverage) => createReleaseProjection({ corpusCoverage, assetsDir, outDir: assetsDir, version, sourceSnapshot,
  corpusSeed: { tag: `corpus-sha256-${'e'.repeat(64)}`, archiveSha256: 'e'.repeat(64), archiveBytes: 1 },
  baselineReceiptSha256: 'f'.repeat(64) });

// The projection reads the SEALED receipt from kb/ruv-gists.sources.json (no injection seam — the
// seed is not a parameter), so the fixture's seeded gist set is exactly that receipt's id set.
// Stage the aggregate store the seed ships and ledger it, the way the fixture builder does `fixture`.
function stageSeededGistAggregate() {
  const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, 'kb', 'ruv-gists.sources.json'), 'utf8'));
  const bytes = Buffer.alloc(768, 9);
  fs.writeFileSync(path.join(assetsDir, 'ruv-gists.big.rvf'), bytes);
  const ledgerFile = path.join(assetsDir, 'RVF-GENERATIONS.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  ledger.stores['ruv-gists'] = { file: 'ruv-gists.big.rvf', sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, sourceCommit: null, model: 'fixture-model', dimensions: 384, builtUtc: '2026-08-21T12:00:00.000Z' };
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger)}\n`);
  return Object.keys(receipt.gists);
}
const gistRow = (id) => ({ key: `gist:${id}`, kind: 'gist', name: id, url: `https://gist.github.com/ruvnet/${id}`,
  status: 'UNVERIFIED', disposition: 'eligible', upstream: { updatedAt: '2026-09-10T00:00:00Z' }, artifact: { store: 'ruv-gists' }, reasons: [] });
const repoRow = (name) => ({ key: `repo:${name}`, kind: 'repository', name, url: `https://github.com/ruvnet/${name}`,
  status: 'UNVERIFIED', disposition: 'eligible', upstream: {}, artifact: { store: name }, reasons: [] });
// An observed corpus ledger in the exact shape source-coverage.mjs emits and validateCoverageLedger accepts.
function observedCorpus(rows) {
  const count = (kind) => rows.filter((row) => row.kind === kind).length;
  const enumerationReceipt = { schemaVersion: 1, terminal: true, duplicateKeys: 0,
    repositories: { expected: count('repository'), pages: [] }, gists: { expected: count('gist'), pages: [] } };
  const identity = { generatorSourceSha: 'a'.repeat(64), snapshotRoot: 'b'.repeat(64), sourceObservationSha256: 'c'.repeat(64) };
  const byStatus = Object.fromEntries([...new Set(rows.map((row) => row.status))].sort()
    .map((status) => [status, rows.filter((row) => row.status === status).length]));
  const corpus = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', ...identity, rows, enumerationReceipt,
    policy: { policyDispositionDigests: [], exemptionDigests: [] },
    totals: { rows: rows.length, repositories: count('repository'), gists: count('gist'), byStatus } };
  corpus.coverageGeneration = coverageGenerationFor({ ...identity, rows, enumerationReceipt });
  return corpus;
}
beforeEach(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assembled-projection-'));
  execFileSync(process.execPath, ['scripts/ci/build-fixture-kb.mjs', '--out', assetsDir],
    { cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'pipe' });
});
afterEach(() => fs.rmSync(assetsDir, { recursive: true, force: true }));

it('repairs the legacy assembly omission without changing immutable public evidence', () => {
  const publicPath = path.join(assetsDir, 'PUBLIC-RVF-GENERATIONS.json');
  const immutable = fs.readFileSync(publicPath);
  const ledger = JSON.parse(immutable);
  fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1, brainVersion: version, releaseTag: `v${version}`, stores: ledger.stores,
  }));
  expect(validateCoverageDirectory(assetsDir).failures).toContain('runtime generation ledger release identity differs');
  expect(bind().valid).toBe(true);
  expect(fs.readFileSync(publicPath)).toEqual(immutable);
  expect(JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'))))
    .toEqual({ ...ledger, kind: 'ruvnet-brain-runtime-generation-ledger' });
});

it('rejects a projection for a different source before rewriting the runtime ledger', () => {
  const before = fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'));
  expect(() => bind({ sourceSnapshot: 'e'.repeat(40) })).toThrow('does not bind this release source');
  expect(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'))).toEqual(before);
});

it('rejects changed public bytes even when their release identity matches', () => {
  fs.appendFileSync(path.join(assetsDir, 'fixture.big.rvf'), 'tampered');
  expect(() => bind()).toThrow('assembled release projection rejected');
});

it('rejects modified coverage instead of treating ledger rebinding as qualification', () => {
  const file = path.join(assetsDir, 'COVERAGE.json');
  const coverage = JSON.parse(fs.readFileSync(file));
  coverage.releaseIdentity.version = '0.0.0-invalid';
  fs.writeFileSync(file, JSON.stringify(coverage));
  expect(() => bind()).toThrow('assembled release projection rejected');
});

// Measured 2026-09-12: the observation moved 479 → 492 gists (rUv published 13 between 2026-08-27
// and 2026-09-10) while the sealed v4.2.1 seed and its schema-2 receipt still carry 479. The
// projection scoped repositories to the seed (a repo whose store is absent is dropped) but scoped
// gists only by the aggregate store's presence, so all 492 were rewritten CURRENT and
// coverage-integrity rejected the receipt — `release-qe` red on 740752c5 and 7b472440. A gist the
// seed receipt does not carry is unseeded exactly like a repository whose store is absent.
it('scopes gist rows to the sealed seed receipt: unseeded gists are dropped, never rewritten CURRENT', () => {
  const seededIds = stageSeededGistAggregate();
  const unseeded = Array.from({ length: 13 }, (_, i) => `${'f'.repeat(24)}${String(i).padStart(8, '0')}`);
  const corpus = observedCorpus([repoRow('fixture'), repoRow('unseeded-repo'), ...seededIds.map(gistRow), ...unseeded.map(gistRow)]);
  expect(corpus.totals.gists).toBe(seededIds.length + unseeded.length);

  const release = project(corpus);

  const projectedGists = release.rows.filter((row) => row.kind === 'gist');
  expect(projectedGists.map((row) => row.key.replace(/^gist:/, '')).sort()).toEqual([...seededIds].sort());
  expect(projectedGists.every((row) => row.status === 'CURRENT')).toBe(true);
  expect(release.totals.gists).toBe(seededIds.length);
  expect(release.enumerationReceipt.gists.expected).toBe(seededIds.length);
  // Repository scoping is unchanged: the seeded repo ships, the unseeded one is dropped.
  expect(release.rows.map((row) => row.key)).toContain('repo:fixture');
  expect(release.rows.map((row) => row.key)).not.toContain('repo:unseeded-repo');
  // The complete observation is preserved untouched, unseeded gists and repo included, still UNVERIFIED.
  const observed = JSON.parse(fs.readFileSync(path.join(assetsDir, 'CORPUS-COVERAGE.json')));
  expect(observed.rows.filter((row) => row.kind === 'gist')).toHaveLength(seededIds.length + unseeded.length);
  expect(observed.rows.map((row) => row.key)).toContain('repo:unseeded-repo');
  for (const id of unseeded) expect(observed.rows.find((row) => row.key === `gist:${id}`)?.status).toBe('UNVERIFIED');
  // The receipt written into the assets is the sealed one — not regenerated to fit the observation.
  const written = JSON.parse(fs.readFileSync(path.join(assetsDir, 'ruv-gists.sources.json')));
  expect(written.schemaVersion).toBe(2);
  expect(Object.keys(written.gists).sort()).toEqual([...seededIds].sort());
  // And the assembled directory validates end to end, exactly as build-bundle --projection then binds it.
  expect(bind().valid).toBe(true);
});
