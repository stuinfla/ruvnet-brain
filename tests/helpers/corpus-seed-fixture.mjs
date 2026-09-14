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
import fs from 'node:fs';
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

export function accuracyOracle({ labels = 20 } = {}) {
  const partitions = [{ partition: 'alpha', kind: 'repository', store: 'alpha', sourceCommit: SOURCE_COMMIT }];
  const rows = [];
  for (let index = 0; index < labels; index += 1) {
    rows.push({
      id: `alpha-${String(index).padStart(3, '0')}`,
      partition: 'alpha',
      question: `What does alpha passage ${index} say?`,
      span: index % 2 === 0 ? 'alpha passage zero' : 'alpha passage one',
      sourcePath: index % 2 === 0 ? 'docs/zero.md' : 'docs/one.md',
      blobSha: crypto.createHash('sha1').update(`blob-${index}`).digest('hex'),
      unitSha256: crypto.createHash('sha256').update(`unit-${index}`).digest('hex'),
    });
  }
  return { partitions, labels: rows };
}

/**
 * A complete, all-PASS accuracy report bound to `bundle`'s exact bytes. `overrides` is merged last so
 * a test can break precisely one binding (archive digest, coverage completeness, a partition's
 * counters) and prove the gate refuses it.
 */
export function accuracyReportFor(bundle, {
  oracleSha256 = 'b'.repeat(64), generatorSha256 = 'e'.repeat(64), overrides = {}, n = 20, successes = 20, timeouts = 0,
} = {}) {
  const partition = (mode) => ({
    partition: 'alpha', partitionKind: 'repository', store: 'alpha', sourceCommit: SOURCE_COMMIT,
    mode, n, successes, failures: n - successes, errors: 0, timeouts, sampled: false, oracleRows: n,
    failedLabels: [], state: (20 * successes >= 19 * n && timeouts === 0) ? 'PASS' : 'FAIL',
  });
  const partitions = [partition('explicit-repository'), partition('full-corpus')];
  return {
    schemaVersion: 1,
    kind: 'ruvnet-brain-retrieval-accuracy',
    createdAt: '2026-09-14T00:00:00.000Z',
    archive: { file: path.basename(bundle), sha256: sha256(bundle), bytes: fs.statSync(bundle).size },
    oracle: {
      file: 'data/retrieval-accuracy-oracle.json', sha256: oracleSha256, bytes: 1234,
      oracleVersion: 'fixture/1', labelsSha256: 'c'.repeat(64), partitionsSha256: 'd'.repeat(64),
    },
    generator: { retrievalAccuracySha256: generatorSha256 },
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

export function seal(root, bundleDir, { accuracy = {} } = {}) {
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
  for (const dir of ['scripts', 'kb', 'plugin', 'keys']) {
    fs.symlinkSync(path.join(repoRoot, dir), path.join(root, dir));
  }
  // The publisher resolves release HEAD with `git rev-parse HEAD` in its own root and requires it to
  // equal --target. Linking the real .git makes that the REAL head — a fixture cannot invent a SHA
  // and must not be able to.
  fs.symlinkSync(path.join(repoRoot, '.git'), path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const oracleFile = path.join(root, 'data', 'retrieval-accuracy-oracle.json');
  fs.writeFileSync(oracleFile, oracleBody ?? `${JSON.stringify({ fixture: 'oracle' }, null, 2)}\n`);
  return {
    root,
    release: path.join(root, 'scripts', 'release.mjs'),
    nodeArgs: ['--preserve-symlinks', '--preserve-symlinks-main'],
    oracleFile,
    oracleSha256: sha256(oracleFile),
    generatorSha256: sha256(path.join(repoRoot, 'scripts/oracle/retrieval-accuracy.mjs')),
  };
}
