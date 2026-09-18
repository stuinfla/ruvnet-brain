// tests/helpers/corpus-seed-fixture.mjs — ONE real, sealed corpus bundle fixture shared by every
// test that has to get past scripts/corpus-candidate.mjs's deriveCorpusCandidate.
//
// Moved out of tests/unit/corpus-seed.test.mjs on 2026-09-13 (ADR-085, step 6) when
// scripts/release.mjs::runProtectedCorpusSeed took over the deep verifyCorpusReceipt re-derivation
// from the deleted scripts/corpus-seed-publish.mjs. From that point a synthetic "bundle" (a text file
// with a matching outer sha256) can no longer satisfy the publisher, so the release-authority tests
// need the same genuine fixture the receipt tests already used. Sharing it is deliberate: one
// fixture, no drift between what the sealer tests and what the publisher tests.
//
// deriveCorpusCandidate audits every shipped .big.rvf's HNSW index via scripts/rvf-index-audit.mjs's
// auditRvfIndexes, which opens the file with the real @ruvector/rvf runtime — a placeholder text
// file cannot stand in for an RVF store. writeMinimalRvf writes a genuine, minimal RVF (well under
// the 1,024-vector HNSW threshold, so no persisted index is required and the audit reports PASS).
import crypto from 'node:crypto';
import { currentAccuracyInstruments, readAccuracyOracle } from '../../scripts/oracle/retrieval-accuracy.mjs';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { beforeEach, afterEach } from 'vitest';
import { attestMeasurementReport } from '../../scripts/oracle/measurement-attestation.mjs';
let priorOracleFile; let fixtureOracleDir;
beforeEach(() => {
  priorOracleFile = process.env.RUVNET_ACCURACY_ORACLE_FILE;
  fixtureOracleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-fixture-oracle-'));
  const file = path.join(fixtureOracleDir, 'oracle.json');
  fs.writeFileSync(file, fixtureOracleBody());
  process.env.RUVNET_ACCURACY_ORACLE_FILE = file;
});
afterEach(() => {
  if (priorOracleFile === undefined) delete process.env.RUVNET_ACCURACY_ORACLE_FILE;
  else process.env.RUVNET_ACCURACY_ORACLE_FILE = priorOracleFile;
  fs.rmSync(fixtureOracleDir, { recursive: true, force: true });
});
const measurementKeys = crypto.generateKeyPairSync('ed25519');
let priorMeasurementKey;
beforeEach(()=>{ priorMeasurementKey=process.env.RUVNET_MEASUREMENT_PUBLIC_KEY; process.env.RUVNET_MEASUREMENT_PUBLIC_KEY=measurementKeys.publicKey.export({type:'spki',format:'pem'}); });
afterEach(()=>{ if(priorMeasurementKey===undefined)delete process.env.RUVNET_MEASUREMENT_PUBLIC_KEY; else process.env.RUVNET_MEASUREMENT_PUBLIC_KEY=priorMeasurementKey; });
export function attestFixtureRecall(report) { return {...report,attestation:attestMeasurementReport(report,measurementKeys.privateKey)}; }

import fs from 'node:fs';
import os from 'node:os';
import { ABSOLUTE_FLOOR, loadFixture, tally } from '../../scripts/oracle/repo-recall.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const requireFromKb = createRequire(new URL('../../kb/package.json', import.meta.url));
const { RvfDatabase } = requireFromKb('@ruvector/rvf');
export { RvfDatabase };

export const SOURCE_COMMIT = 'a'.repeat(40);

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export async function writeMinimalRvf(rvfPath) {
  const db = await RvfDatabase.create(rvfPath, { dimensions: 3, metric: 'cosine' });
  await db.ingestBatch([{ id: 'v-0', vector: [1, 0, 0] }, { id: 'v-1', vector: [0, 1, 0] }]);
  await db.close();
}

// Step 13 (2026-09-13): deriveCorpusCandidate now runs the deep C2 audit (auditCorpusStores), which
// reopens the store and proves id-map <-> vector <-> passage <-> source-mapping correspondence. A
// placeholder passages/meta pair no longer stands in for a store, so these sidecars describe the
// exact two vectors writeMinimalRvf ingests above, at the store's real dimension (3, not 384).
export const MINIMAL_PASSAGES = [
  { id: 'v-0', text: 'alpha passage zero', path: 'docs/zero.md', title: 'zero' },
  { id: 'v-1', text: 'alpha passage one', path: 'docs/one.md', title: 'one' },
];

export function minimalStoreSidecars() {
  return {
    passages: `${MINIMAL_PASSAGES.map((row) => JSON.stringify(row)).join('\n')}\n`,
    meta: JSON.stringify({
      dimensions: 3,
      incremental: {
        schemaVersion: 2,
        files: Object.fromEntries(MINIMAL_PASSAGES.map((row) => [row.path, { chunkIds: [row.id] }])),
      },
    }),
  };
}

export function createArchive(bundle, bundleRoot) {
  if (fs.existsSync(bundle)) fs.rmSync(bundle);
  if (process.platform === 'win32') {
    const escapedRoot = bundleRoot.replaceAll("'", "''");
    const escapedBundle = bundle.replaceAll("'", "''");
    return execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${escapedRoot}' -DestinationPath '${escapedBundle}' -Force`,
    ], { encoding: 'utf8' });
  }
  return execFileSync('zip', ['-qr', bundle, 'ruvnet-brain'], { cwd: path.dirname(bundleRoot), encoding: 'utf8' });
}

// Rebuild ARCHIVE-MANIFEST.json from the exact bytes present in bundleDir right now (mirrors
// scripts/build-bundle.mjs's own manifest assembly), then seal a fresh zip over it. Every mutation
// test mutates bundleDir *before* calling seal(), so the manifest and the zip it seals are always
// mutually consistent — exactly like the real builder. Returns the sealed bundle path
// (<root>/ruvnet-brain.zip for a bundleDir of <root>/bundle/ruvnet-brain).
// ADR-086 Step 15: a sealed corpus is now a TWO-artifact identity — the archive, and the detached
// retrieval-accuracy report bound to its digest. Every fixture that wants to get past
// deriveCorpusCandidate needs both, so seal() writes a complete, all-PASS report by default and the
// mutation tests break exactly one thing about it.
export const FIXTURE_ORACLE_PARTITION = 'alpha';
export const FIXTURE_UNITS = 10;

/**
 * An ADR-086:248-compliant (schema 2) oracle: U meaningful units, min(100, U) selected, and exactly one
 * direct plus one paraphrase question per selected unit, so N = 2 x min(100, U). `unproduced` marks
 * that many selected units as having no accepted pair — they keep their slots in N and must score as
 * misses, which is the whole point of deriving N from the inventory rather than from surviving labels.
 */
export function accuracyOracle({ units = FIXTURE_UNITS, unproduced = 0 } = {}) {
  const selectedUnits = Math.min(100, units);
  const unitId = (index) => `unit-${String(index).padStart(3, '0')}`;
  const produced = selectedUnits - unproduced;
  const partitions = [{
    partition: 'alpha', kind: 'repository', store: 'alpha', sourceCommit: SOURCE_COMMIT,
    U: units, selectedUnits, N: 2 * selectedUnits,
    inventorySha256: crypto.createHash('sha256').update(`inventory-${units}`).digest('hex'),
    rulesVersion: 'oracle-source-units/1',
    unproduced: Array.from({ length: unproduced }, (_, i) => ({
      unitId: unitId(produced + i), reason: 'fixture: no accepted pair',
    })),
  }];
  const rows = [];
  for (let index = 0; index < produced; index += 1) {
    const span = index % 2 === 0 ? 'alpha passage zero' : 'alpha passage one';
    const sourcePath = index % 2 === 0 ? 'docs/zero.md' : 'docs/one.md';
    const blobSha = crypto.createHash('sha1').update(`blob-${index}`).digest('hex');
    const unitSha256 = crypto.createHash('sha256').update(`unit-${index}`).digest('hex');
    for (const form of ['direct', 'paraphrase']) {
      rows.push({
        id: `alpha-${unitId(index)}-${form}`,
        partition: 'alpha',
        unit: unitId(index),
        form,
        question: form === 'direct'
          ? `What does alpha passage ${index} say?`
          : `Which statement is made by alpha unit number ${index}?`,
        span, sourcePath, blobSha, unitSha256,
      });
    }
  }
  return { partitions, labels: rows };
}

/**
 * A complete, all-PASS accuracy report bound to `bundle`'s exact bytes. `overrides` is merged last so
 * a test can break precisely one binding (archive digest, coverage completeness, a partition's
 * counters) and prove the gate refuses it.
 */
export function fixtureOracleBody() {
  const { partitions, labels } = accuracyOracle();
  return `${JSON.stringify({ schemaVersion: 2, kind: 'ruvnet-brain-retrieval-accuracy-oracle',
    oracleVersion: 'fixture/2', partitions, labels, emptySources: [],
    seal: { labelsSha256: digest(labels), partitionsSha256: digest(partitions) } }, null, 2)}\n`;
}

const FIXTURE_RUNTIME_FILES = {
  'forge-ask-all.mjs': 'export async function searchAll() { return {results: []}; }\n',
  'package.json': JSON.stringify({name: 'fixture-runtime', type: 'module', version: '1.0.0'}),
  'package-lock.json': JSON.stringify({name: 'fixture-runtime', lockfileVersion: 3, packages: {}}),
};

function fixtureRuntimeIdentity(bundle) {
  // seal() has already written this manifest. Arithmetic-only report tests deliberately
  // use a non-ZIP placeholder; they use the same explicit synthetic runtime bytes.
  const manifestFile = path.join(path.dirname(bundle), 'bundle', 'ruvnet-brain', 'ARCHIVE-MANIFEST.json');
  const rows = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).files
    : Object.entries(FIXTURE_RUNTIME_FILES).map(([path, body]) => ({path,
      sha256: crypto.createHash('sha256').update(body).digest('hex')}));
  const files = rows.filter(row => Object.hasOwn(FIXTURE_RUNTIME_FILES, row.path))
    .map(({path, sha256}) => ({path, sha256}));
  const dependencies = [];
  const payload = { files, dependencies, sha256: digest({files, dependencies}), installation: {method: 'npm-ci-ignore-scripts',
    lockSha256: files.find(row => row.path === 'package-lock.json')?.sha256, dependencies: []} };
  return {...payload, runtimeSha256: digest(payload)};
}

export function accuracyReportFor(bundle, {
  oracleSha256 = currentAccuracyInstruments().expectedOracleSha256, generatorSha256 = currentAccuracyInstruments().expectedGeneratorSha256, overrides = {}, n = 20, successes = 20, timeouts = 0,
} = {}) {
  // Schema 2: each row carries its ADR-086:248 denominator, N = 2 x min(100, U), and n must equal it.
  const U = Math.max(1, Math.ceil(n / 2));
  const selectedOracle = readAccuracyOracle(process.env.RUVNET_ACCURACY_ORACLE_FILE);
  const runtime = {kind:'controlled-archive',identity:fixtureRuntimeIdentity(bundle)};
  const partition = (mode) => ({
    partition: 'alpha', partitionKind: 'repository', store: 'alpha', sourceCommit: SOURCE_COMMIT,
    U, N: 2 * Math.min(100, U),
    mode, n, unproducedQuestions: 0, successes, failures: n - successes, errors: 0, timeouts, sampled: false, oracleRows: n,
    failedLabels: [], state: (20 * successes >= 19 * n && timeouts === 0) ? 'PASS' : 'FAIL',
  });
  const partitions = [partition('explicit-repository'), partition('full-corpus')];
  return {
    schemaVersion: 2,
    kind: 'ruvnet-brain-retrieval-accuracy',
    classification: 'c3-acceptance',
    c3Eligible: true,
    createdAt: '2026-09-14T00:00:00.000Z',
    archive: { file: path.basename(bundle), sha256: sha256(bundle), bytes: fs.statSync(bundle).size },
    oracle: {
      schemaVersion: 2,
      file: selectedOracle.file, sha256: oracleSha256, bytes: selectedOracle.bytes,
      oracleVersion: selectedOracle.oracleVersion, labelsSha256: selectedOracle.labelsSha256, partitionsSha256: selectedOracle.partitionsSha256,
    },
    generator: { retrievalAccuracySha256: generatorSha256 },
    runtime,
    metric: 'evidence-supporting-hit@5',
    k: 5,
    threshold: { numerator: 19, denominator: 20 },
    modes: ['explicit-repository', 'full-corpus'],
    queryTimeoutMs: 120000,
    coverage: {
      complete: true, bounded: null, archiveStores: ['alpha'], oraclePartitions: 1,
      measuredPartitions: 1, unmeasuredPartitions: [], uncoveredArchiveStores: [], emptySources: [],
    },
    totals: {
      n: n * 2, successes: successes * 2, failures: (n - successes) * 2, errors: 0, timeouts: timeouts * 2,
    },
    partitions,
    state: partitions.every((row) => row.state === 'PASS') ? 'PASS' : 'FAIL',
    ...overrides,
  };
}

export function writeAccuracyReport(bundle, options = {}) {
  const file = `${bundle}.accuracy.json`;
  fs.writeFileSync(file, `${JSON.stringify(accuracyReportFor(bundle, options), null, 2)}\n`);
  return file;
}

/**
 * The detached repo-recall report — the BLOCKING retrieval gate since the 2026-09-15 ADR-086
 * amendment. Synthesised at exactly the accepted floor over the real committed fixture, so a fixture
 * bundle exercises the same predicate a release does rather than a weakened stand-in.
 */
export function recallReportFor(bundle, overrides = {}) {
  const stat = fs.statSync(bundle);
  const fixture = loadFixture();
  const rows = fixture.questions.map((q, i) => ({
    store: q.store, query: q.query,
    expectedPath: q.expectedPath,
    repoCovered: true,
    exactFileRank: i < 139 ? 1 : i < 176 ? 4 : null,
    returnedPaths: i < 139 ? [`${q.store}/${q.expectedPath}`]
      : i < 176 ? [1,2,3].map(n=>`${q.store}/unrelated-${n}`).concat(`${q.store}/${q.expectedPath}`)
      : [`${q.store}/unrelated`],
  }));
  return attestFixtureRecall({
    schemaVersion: 1,
    kind: 'ruvnet-brain-repo-recall',
    state: 'PASS',
    failures: [],
    measuredUtc: '2026-09-15T00:00:00.000Z',
    archive: { file: path.basename(bundle), sha256: sha256(bundle), bytes: stat.size },
    fixture: { file: fixture.file, sha256: fixture.fixtureSha256, sourceCommit: fixture.sourceCommit, questionCount: rows.length },
    protocol: { runtimeIdentity: fixtureRuntimeIdentity(bundle), entryPoint: 'fixture', k: 5, repositoryScope: 'explicit', scoring: 'exact labeled file path within top-k' },
    floor: { value: ABSOLUTE_FLOOR, committed: ABSOLUTE_FLOOR, absolute: ABSOLUTE_FLOOR },
    gate: { floorValue: ABSOLUTE_FLOOR },
    totals: tally(rows),
    meaning: {},
    rows,
    ...overrides,
  });
}

export function writeRecallReport(bundle, options = {}) {
  const file = `${bundle}.recall.json`;
  fs.writeFileSync(file, `${JSON.stringify(recallReportFor(bundle, options), null, 2)}\n`);
  return file;
}

export function seal(root, bundleDir, { accuracy = {}, recall = {} } = {}) {
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === 'ARCHIVE-MANIFEST.json') continue;
      const full = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, relative);
      else files.push({ path: relative, sha256: sha256(full), bytes: stat.size });
    }
  };
  walk(bundleDir);
  const manifest = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-archive-manifest',
    version: '9.9.9',
    releaseTag: 'v9.9.9',
    retrievalRuntimeFiles: files.filter(row => Object.hasOwn(FIXTURE_RUNTIME_FILES, row.path)).map(row => row.path).sort(),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
  };
  fs.writeFileSync(path.join(bundleDir, 'ARCHIVE-MANIFEST.json'), JSON.stringify(manifest, null, 2));
  const bundle = path.join(path.dirname(path.dirname(bundleDir)), 'ruvnet-brain.zip');
  createArchive(bundle, bundleDir);
  // `accuracy: null` deliberately seals an archive with NO detached report — the "missing accuracy
  // report" case the Step 15 proof text requires to block.
  if (accuracy) writeAccuracyReport(bundle, accuracy);
  if (recall) writeRecallReport(bundle, recall);
  return bundle;
}

// Lay down one public store (alpha) with every sidecar the candidate derivation requires, plus the
// private-store fence, generation ledger, SOURCE manifest, and public-store-classes policy.
export async function buildAssets(root) {
  const bundleDir = path.join(root, 'bundle', 'ruvnet-brain');
  fs.mkdirSync(bundleDir, { recursive: true });
  // RvfDatabase.create() writes alpha.big.rvf AND its own alpha.big.rvf.idmap.json sidecar, so
  // that one must not be pre-written here — only the sidecars the real RVF runtime does not
  // generate itself.
  await writeMinimalRvf(path.join(bundleDir, 'alpha.big.rvf'));
  const sidecars = minimalStoreSidecars();
  const publicFiles = {
    ...FIXTURE_RUNTIME_FILES,
    'alpha.big.rvf.embed.json': '{"model":"local"}',
    'alpha.passages.jsonl': sidecars.passages,
    'alpha.meta.json': sidecars.meta,
  };
  for (const [name, body] of Object.entries(publicFiles)) fs.writeFileSync(path.join(bundleDir, name), body);
  fs.writeFileSync(path.join(bundleDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['secret'] }));
  fs.writeFileSync(path.join(bundleDir, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1,
    brainVersion: '9.9.9',
    releaseTag: 'v9.9.9',
    stores: {
      alpha: {
        file: 'alpha.big.rvf',
        sha256: sha256(path.join(bundleDir, 'alpha.big.rvf')),
        bytes: fs.statSync(path.join(bundleDir, 'alpha.big.rvf')).size,
        model: 'local',
        dimensions: 384,
        sourceCommit: SOURCE_COMMIT,
        builtUtc: '2026-08-21T12:00:00.000Z',
      },
    },
  }));
  fs.writeFileSync(path.join(bundleDir, 'SOURCE.json'), JSON.stringify({
    builder: 'rvf-kb-forge',
    stores: { alpha: { sourceCommit: SOURCE_COMMIT } },
  }));
  fs.writeFileSync(path.join(bundleDir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
  return bundleDir;
}

// Build and seal a complete, genuine bundle under `root`. The caller owns `root`'s lifetime.
export async function sealedCorpusBundle(root, options = {}) {
  const bundleDir = await buildAssets(root);
  const bundle = seal(root, bundleDir, options);
  return { bundleDir, bundle };
}

/**
 * A minimal repository root that runProtectedCorpusSeed can be pointed at in-process: it carries the
 * two committed generators the publication gate hashes, plus a committed retrieval-accuracy oracle.
 * The real repo deliberately has NO committed oracle yet (ADR-086 Step 14 owns producing it), so the
 * publication gate refuses against the real root — which is itself one of the RED proofs.
 */
export function fixtureReleaseRoot(root, { oracleBody = null } = {}) {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  fs.mkdirSync(root, { recursive: true });
  // scripts/kb/plugin/keys are symlinked to the real tree so the spawned release.mjs is the REAL
  // publisher with the REAL generator bytes (its generator-identity check hashes them); only `data`
  // is a private directory, which is what lets a test supply a committed oracle without ever writing
  // into the tracked checkout. Spawn with --preserve-symlinks --preserve-symlinks-main so
  // release.mjs's own ROOT resolves to THIS directory rather than the repo it is linked from.
  for (const dir of ['scripts', 'kb', 'plugin', 'keys', 'node_modules']) {
    fs.symlinkSync(path.join(repoRoot, dir), path.join(root, dir));
  }
  // The publisher resolves release HEAD with `git rev-parse HEAD` in its own root and requires it to
  // equal --target. Linking the real .git makes that the REAL head — a fixture cannot invent a SHA
  // and must not be able to.
  fs.symlinkSync(path.join(repoRoot, '.git'), path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const oracleFile = path.join(root, 'data', 'retrieval-accuracy-oracle.json');
  fs.writeFileSync(oracleFile, oracleBody ?? fixtureOracleBody());
  // The repo-recall gate's two committed inputs. `--preserve-symlinks` makes the publisher's ROOT
  // this directory, so it reads THESE — which is the point: a release checkout that has lost the
  // frozen fixture or the ratchet must refuse to publish, and that has to be reachable in a test.
  // They are COPIES of the real committed files, not invented ones, so the fixture exercises the
  // real fixture digest and the real floor rather than a weakened stand-in.
  for (const name of ['retrieval-query-evidence.json', 'repo-recall-floor.json']) {
    fs.copyFileSync(path.join(repoRoot, 'data', name), path.join(root, 'data', name));
  }
  return {
    root,
    release: path.join(root, 'scripts', 'release.mjs'),
    nodeArgs: ['--preserve-symlinks', '--preserve-symlinks-main'],
    oracleFile,
    oracleSha256: sha256(oracleFile),
    generatorSha256: sha256(path.join(repoRoot, 'scripts/oracle/retrieval-accuracy.mjs')),
  };
}
