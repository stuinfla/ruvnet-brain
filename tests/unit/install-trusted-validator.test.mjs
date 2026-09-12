/**
 * The trusted coverage validator reaches the KB root through the INSTALLER — or it never arrives.
 *
 * Measured 2026-09-12: `kb/forge-update.mjs` (`loadTrustedCoverageValidator`) demands
 * `KB_DIR/coverage-integrity.mjs` and dies with "installed coverage validator is missing; re-run the
 * current installer before self-update" when it is absent. No production path placed that file:
 * `scripts/build-bundle.mjs` walks the static import graph and cannot see the updater's dynamic
 * `pathToFileURL(validatorPath)` load, and `bin/install.mjs` imported the module for its own use
 * without ever copying it beside the updater. Only a test fixture copied it — so every 4.3.21
 * `--update` (the nightly included) died in the updater and fell back to a fresh install, and on a
 * brain with a private overlay the fallback is refused and the nightly exits 1.
 *
 * "Trusted" is why the placement belongs to the installer: the validator judges the downloaded
 * bundle, so it must come from the signed npm package, never from the artifact it validates.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coverageGenerationFor, releaseCoverageGenerationFor } from '../../plugin/scripts/coverage-integrity.mjs';
import { validatePublicInventory } from '../../scripts/public-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRUSTED_SOURCE = path.join(ROOT, 'plugin', 'scripts', 'coverage-integrity.mjs');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const install = await import(`${pathToFileURL(path.join(ROOT, 'bin', 'install.mjs')).href}?trusted-validator=${Date.now()}`);
afterAll(() => { delete process.env.RUVNET_BRAIN_IMPORT_ONLY; });

let tmp;
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; });
const scratch = () => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-validator-'))); return tmp; };
const trustedBytes = () => fs.readFileSync(TRUSTED_SOURCE);
const VALIDATOR = 'coverage-integrity.mjs';

describe('placeTrustedCoverageValidator — the installer owns the copy beside the updater', () => {
  it('places the package validator, byte-identical, when the KB has none', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    const r = install.placeTrustedCoverageValidator(kb);
    expect(r).toMatchObject({ action: 'placed', path: path.join(kb, VALIDATOR) });
    expect(fs.readFileSync(path.join(kb, VALIDATOR)).equals(trustedBytes())).toBe(true);
  });

  it('replaces a stale copy so the updater never judges a release with yesterday\'s rules', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    fs.writeFileSync(path.join(kb, VALIDATOR), '// stale validator\n');
    expect(install.placeTrustedCoverageValidator(kb).action).toBe('replaced');
    expect(fs.readFileSync(path.join(kb, VALIDATOR)).equals(trustedBytes())).toBe(true);
  });

  it('is idempotent — an identical copy is reported unchanged and not rewritten', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    fs.copyFileSync(TRUSTED_SOURCE, path.join(kb, VALIDATOR));
    const before = fs.statSync(path.join(kb, VALIDATOR));
    expect(install.placeTrustedCoverageValidator(kb).action).toBe('unchanged');
    const after = fs.statSync(path.join(kb, VALIDATOR));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it('turns a symlinked validator into a real file — a link is not a trusted regular file', () => {
    const dir = scratch(); const kb = path.join(dir, 'kb'); fs.mkdirSync(kb);
    fs.writeFileSync(path.join(dir, 'elsewhere.mjs'), '// not ours\n');
    fs.symlinkSync(path.join(dir, 'elsewhere.mjs'), path.join(kb, VALIDATOR));
    expect(install.placeTrustedCoverageValidator(kb).action).toBe('replaced');
    const stat = fs.lstatSync(path.join(kb, VALIDATOR));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(fs.readFileSync(path.join(kb, VALIDATOR)).equals(trustedBytes())).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'elsewhere.mjs'), 'utf8'), 'the link target is not written through').toBe('// not ours\n');
  });

  it('refuses loudly when the package copy itself is missing rather than placing nothing silently', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    expect(() => install.placeTrustedCoverageValidator(kb, { source: path.join(tmp, 'absent.mjs') })).toThrow(/trusted coverage validator/);
    expect(fs.existsSync(path.join(kb, VALIDATOR))).toBe(false);
  });
});

describe('ensureUpdaterPrerequisites — placement happens only where an updater exists', () => {
  it('does nothing on a directory with no forge-update.mjs (missingUpdaterHelp keeps its meaning)', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    expect(install.ensureUpdaterPrerequisites(kb)).toEqual({ updater: false, validator: null });
    expect(fs.readdirSync(kb)).toEqual([]);
  });

  it('places the validator beside an existing updater', () => {
    const kb = path.join(scratch(), 'kb'); fs.mkdirSync(kb);
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// updater\n');
    const r = install.ensureUpdaterPrerequisites(kb);
    expect(r.updater).toBe(true);
    expect(r.validator.action).toBe('placed');
    expect(fs.readFileSync(path.join(kb, VALIDATOR)).equals(trustedBytes())).toBe(true);
  });

  it('runUpdate() calls it after the missing-updater check and BEFORE spawning the updater', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
    const start = source.indexOf('function runUpdate()');
    const end = source.indexOf('function enableNightly()', start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    const help = body.indexOf('missingUpdaterHelp(kbDir)');
    const ensure = body.indexOf('ensureUpdaterPrerequisites(kbDir)');
    const spawn = body.indexOf('spawnSync(process.execPath, updaterArgs');
    expect(help, 'the loud no-updater branch still exists').toBeGreaterThan(-1);
    expect(ensure, 'runUpdate must place the validator').toBeGreaterThan(help);
    expect(spawn, 'and must do so before the updater child starts').toBeGreaterThan(ensure);
  });
});

/**
 * A ReleaseCoverage tree the installer accepts at PACKAGE_VERSION — the same shape the apply/rollback
 * suite publishes — WITHOUT a validator, exactly as a production bundle arrives.
 */
function layDownRelease(dir, { stores = ['alpha'] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const version = PACKAGE_VERSION;
  const sourceSnapshot = 'd'.repeat(40);
  fs.writeFileSync(path.join(dir, 'forge-mcp-all.mjs'), '// fixture entry point\n');
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify({
    builder: 'rvf-kb-forge', builtUtc: '2026-08-21T12:00:00.000Z', brainVersion: version, releaseTag: `v${version}`,
    canonicalManifestUrl: 'http://127.0.0.1:9/releases/latest',
    stores: Object.fromEntries(stores.map((name) => [name, { kbName: name, sourceCommit: 'aaa111aaa111', builtUtc: '2026-08-21T12:00:00.000Z' }])),
  }, null, 2));
  const publicLedger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger', brainVersion: version, releaseTag: `v${version}`, sourceSnapshot, stores: {} };
  for (const name of stores) {
    const bytes = Buffer.alloc(512, 7);
    fs.writeFileSync(path.join(dir, `${name}.big.rvf`), bytes);
    publicLedger.stores[name] = { file: `${name}.big.rvf`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length, sourceCommit: 'aaa111aaa111', model: 'fixture-model', dimensions: 384, builtUtc: '2026-08-21T12:00:00.000Z' };
  }
  const publicLedgerBytes = Buffer.from(`${JSON.stringify(publicLedger)}\n`);
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), `${JSON.stringify({ ...publicLedger, kind: 'ruvnet-brain-runtime-generation-ledger' })}\n`);
  fs.writeFileSync(path.join(dir, 'PUBLIC-RVF-GENERATIONS.json'), publicLedgerBytes);
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  fs.writeFileSync(path.join(dir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
  const rows = stores.map((name) => ({ key: `repo:${name}`, kind: 'repository', name, url: `https://github.com/ruvnet/${name}`,
    status: 'CURRENT', disposition: 'eligible', upstream: {}, artifact: { store: name }, reasons: [] }));
  const enumerationReceipt = { schemaVersion: 1, terminal: true, duplicateKeys: 0, repositories: { expected: rows.length, pages: [] }, gists: { expected: 0, pages: [] } };
  const generatorSourceSha = 'a'.repeat(64); const snapshotRoot = 'b'.repeat(64); const sourceObservationSha256 = 'c'.repeat(64);
  const corpus = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', generatorSourceSha, snapshotRoot, sourceObservationSha256, rows,
    enumerationReceipt, policy: { policyDispositionDigests: [], exemptionDigests: [] },
    totals: { rows: rows.length, repositories: rows.length, gists: 0, byStatus: { CURRENT: rows.length } } };
  corpus.coverageGeneration = coverageGenerationFor({ generatorSourceSha, snapshotRoot, sourceObservationSha256, rows, enumerationReceipt,
    policyDispositionDigests: [], exemptionDigests: [] });
  const corpusBytes = `${JSON.stringify(corpus, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'CORPUS-COVERAGE.json'), corpusBytes);
  const publicInventory = validatePublicInventory({ assetsDir: dir, coverage: corpus, ledger: publicLedger });
  const release = { ...structuredClone(corpus), kind: 'ruvnet-brain-release-coverage',
    releaseIdentity: { version, tag: `v${version}`, sourceSnapshot },
    corpusSeed: { tag: `corpus-sha256-${'e'.repeat(64)}`, archiveSha256: 'e'.repeat(64), archiveBytes: 1, receiptSha256: 'f'.repeat(64) },
    corpusCoverage: { file: 'CORPUS-COVERAGE.json', sha256: crypto.createHash('sha256').update(corpusBytes).digest('hex'), coverageGeneration: corpus.coverageGeneration },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: crypto.createHash('sha256').update(publicLedgerBytes).digest('hex'),
      bytes: publicLedgerBytes.length, storeCount: stores.length },
    publicInventoryPartitionSha256: publicInventory.partitionSha256, installedProjectionSchema: 2 };
  delete release.coverageGeneration;
  release.releaseCoverageGeneration = releaseCoverageGenerationFor(release);
  fs.writeFileSync(path.join(dir, 'COVERAGE.json'), JSON.stringify(release));
}

describe('fresh install — the activated brain can self-update on its first night', () => {
  it('unzipInto() lands the trusted validator in the activated tree even though the bundle never shipped one', async () => {
    const dir = scratch();
    const bundle = path.join(dir, 'assembled'); layDownRelease(bundle);
    expect(fs.existsSync(path.join(bundle, VALIDATOR)), 'precondition: production bundles do not carry the validator').toBe(false);
    const cacheDir = path.join(dir, 'home', 'kb');
    const result = await install.unzipInto(null, cacheDir, bundle);
    expect(result.status).toBe('ACTIVATED');
    expect(fs.existsSync(path.join(cacheDir, 'forge-mcp-all.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, VALIDATOR)), 'installer must place the validator beside the brain').toBe(true);
    expect(fs.readFileSync(path.join(cacheDir, VALIDATOR)).equals(trustedBytes())).toBe(true);
    expect(fs.existsSync(path.join(bundle, VALIDATOR)), 'the assembled source directory is left untouched').toBe(false);
  });
});
