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
export function seal(root, bundleDir) {
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
export async function sealedCorpusBundle(root) {
  const bundleDir = await buildAssets(root);
  const bundle = seal(root, bundleDir);
  return { bundleDir, bundle };
}
