// tests/helpers/assemble-bundle-fixture.mjs — shared REAL fixtures for scripts/build-bundle.mjs's
// assembleBundle (Step 5 remediation, 2026-09-13).
//
// Every fixture here is built with the PRODUCT's own producers, never a hand-typed shape:
//   - stores are genuine .big.rvf files written by the real @ruvector/rvf runtime (RvfDatabase.create),
//     2 vectors each — far below the 1,024-vector HNSW threshold, so auditRvfIndexes reports PASS
//     without a persisted index;
//   - the public-input selection is sealed by the REAL materializePublicInputs, so the receipt is a
//     genuine schema-2 seal (byte-bound `files[]`, recomputable receiptSha256), never a fake one the
//     consumer's validator could not tell from a real one;
//   - the corpus coverage ledger is sealed with the same coverageGenerationFor the product uses, so
//     validateCoverageLedger recomputes it exactly.
// A test that wants to prove REJECTION tampers with one of these real artifacts afterwards.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { materializePublicInputs } from '../../scripts/public-inputs.mjs';
import { sealGistReceiptSet } from '../../scripts/gist-receipts.mjs';
import { coverageGenerationFor } from '../../plugin/scripts/coverage-integrity.mjs';

const requireFromKb = createRequire(new URL('../../kb/package.json', import.meta.url));
const { RvfDatabase } = requireFromKb('@ruvector/rvf');

export const ENTRYPOINTS = [
  'forge-ask.mjs', 'forge-ask-all.mjs', 'forge-mcp.mjs', 'forge-mcp-all.mjs',
  'forge-rerank.mjs', 'forge-guard.mjs', 'forge-update.mjs', 'verify-citation.mjs',
];

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Deterministic hex of `length` chars (<= 64) derived from a seed string. */
export const hex = (seed, length) => crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, length);
export const commitFor = (name) => hex(`commit:${name}`, 40);
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export async function writeMinimalRvf(rvfPath) {
  const db = await RvfDatabase.create(rvfPath, { dimensions: 3, metric: 'cosine' });
  await db.ingestBatch([{ id: 'v-0', vector: [1, 0, 0] }, { id: 'v-1', vector: [0, 1, 0] }]);
  await db.close();
}

/** Every regular file under `dir`, as `relative path -> sha256:bytes`. Used to prove a directory is
 * an INPUT: byte-identical before and after, with nothing added and nothing pruned. */
export function treeIdentity(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child, childRel);
      else out[childRel] = `${sha256File(child)}:${fs.statSync(child).size}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

export function tempDir(dirs, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `assemble-bundle-${label}-`));
  dirs.push(dir);
  return dir;
}

/** Write public prose into a kb/ directory: primers, l2 articles, topics files, cards, aliases. */
export function writeProse(kb, { primers = {}, l2 = {}, topics = {}, cards = null, aliases = null } = {}) {
  for (const [repo, body] of Object.entries(primers)) fs.writeFileSync(path.join(kb, `${repo}-primer.md`), body);
  if (Object.keys(l2).length) fs.mkdirSync(path.join(kb, 'l2'), { recursive: true });
  for (const [slug, body] of Object.entries(l2)) fs.writeFileSync(path.join(kb, 'l2', `${slug}.md`), body);
  for (const [repo, list] of Object.entries(topics)) fs.writeFileSync(path.join(kb, `l2-topics.${repo}.json`), JSON.stringify(list));
  if (cards !== null) fs.writeFileSync(path.join(kb, 'capability-cards.md'), cards);
  if (aliases !== null) fs.writeFileSync(path.join(kb, 'repo-aliases.json'), JSON.stringify(aliases));
}

/** A minimal but REAL code checkout: a kb/ with trivial (zero-import) entry points so the module-graph
 * walk terminates immediately, plus everything else assembleBundle reads from `runtimeRoot`. */
export function buildRuntimeRoot(dirs, { privateStores = [], prose = {} } = {}) {
  const root = tempDir(dirs, 'runtime');
  const kb = path.join(root, 'kb');
  for (const dir of ['kb', 'data', 'keys', 'scripts', 'primer']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(kb, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores }));
  for (const name of ENTRYPOINTS) fs.writeFileSync(path.join(kb, name), `// fixture entry point: ${name}\nexport const ok = true;\n`);
  fs.writeFileSync(path.join(kb, 'package.json'), JSON.stringify({ name: 'fixture-kb', version: '0.0.0' }));
  fs.writeFileSync(path.join(kb, 'package-lock.json'), JSON.stringify({ name: 'fixture-kb', lockfileVersion: 3 }));
  fs.writeFileSync(path.join(kb, 'package-owners.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(root, 'data', 'registry.tiers.json'), JSON.stringify({ tiers: {} }));
  fs.writeFileSync(path.join(root, 'scripts', 'verify-bundle.mjs'), '// fixture verify-bundle.mjs\n');
  fs.writeFileSync(path.join(root, 'keys', 'ruvnet-brain-signing.pub.pem'), '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n');
  // The actual validator is a required runtime dependency, even in minimal bundle fixtures.
  fs.mkdirSync(path.join(root, 'plugin/scripts'), { recursive: true });
  fs.copyFileSync(new URL('../../plugin/scripts/coverage-integrity.mjs', import.meta.url),
    path.join(root, 'plugin/scripts/coverage-integrity.mjs'));
  writeProse(kb, prose);
  return root;
}

/** Write one store's full artifact family (real RVF + sidecars) into `dir`; returns its ledger row. */
export async function writeStore(dir, name) {
  const rvfPath = path.join(dir, `${name}.big.rvf`);
  await writeMinimalRvf(rvfPath);
  fs.writeFileSync(`${rvfPath}.embed.json`, JSON.stringify({ model: 'fixture-model', dimensions: 3 }));
  fs.writeFileSync(path.join(dir, `${name}.passages.jsonl`), `${JSON.stringify({ id: '0', text: name, path: name })}\n`);
  fs.writeFileSync(path.join(dir, `${name}.meta.json`), JSON.stringify({ model: 'fixture-model', dimensions: 3, entries: { 0: { path: name } } }));
  return {
    file: `${name}.big.rvf`, sha256: sha256File(rvfPath), bytes: fs.statSync(rvfPath).size,
    model: 'fixture-model', dimensions: 3,
    sourceCommit: name === 'ruv-gists' ? null : commitFor(name),
    builtUtc: '2026-09-13T00:00:00.000Z',
  };
}

export function updaterEntryFor(name) {
  return {
    kbName: name, sourceRepo: `https://github.com/ruvnet/${name}`, sourceCommit: commitFor(name),
    sourceDescribe: name, builtUtc: '2026-09-13T00:00:00.000Z', builder: 'rvf-kb-forge',
    canonicalManifestUrl: `https://example.invalid/${name}/manifest.json`,
    canonicalBundleUrl: `https://example.invalid/${name}/bundle.zip`, selfUpdate: `node forge-update.mjs ${name}`,
  };
}

/**
 * A minimal but REAL finalized corpus directory (the shape reconciliation leaves behind).
 *   stores        store names to build (real RVFs + every required sidecar)
 *   derived       subset of `stores` that are derived stores (get a derived-store receipt + registry row)
 *   gistReceipt   a schema-3 aggregate receipt to reseal around a fixture passages file (requires
 *                 'ruv-gists' in `stores`)
 *   seal          seal the public-input selection with the REAL producer (from runtimeRoot/kb)
 *   overrides     { relativePath: string|Buffer } written LAST, verbatim (fixture-only receipts, etc.)
 */
export async function buildCorpus(dirs, { runtimeRoot, stores, derived = [], gistReceipt = null, seal = true, overrides = {} }) {
  const root = tempDir(dirs, 'corpus');
  const ledgerStores = {};
  const updaterStores = {};
  for (const name of stores) {
    ledgerStores[name] = await writeStore(root, name);
    if (name !== 'ruv-gists' && !derived.includes(name)) updaterStores[name] = updaterEntryFor(name);
  }
  for (const name of derived) {
    const passages = path.join(root, `${name}.passages.jsonl`);
    const input = `${name}.meta.json`;
    fs.writeFileSync(path.join(root, `${name}.sources.json`), `${JSON.stringify({
      schemaVersion: 1, kind: 'ruvnet-brain-derived-store-receipt', store: name,
      observationSha256: hex('observation', 64), selectionReceiptSha256: null,
      inputs: [{ path: input, sha256: sha256File(path.join(root, input)) }],
      passagesSha256: sha256File(passages),
    }, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(root, 'public-store-classes.json'), `${JSON.stringify({
    schemaVersion: 1, derived: derived.map((store) => ({ store, receipt: `${store}.sources.json` })),
  }, null, 2)}\n`);
  if (gistReceipt) {
    const passageBody = 'fixture ruv-gists passages\n';
    const passagesFile = path.join(root, 'ruv-gists.passages.jsonl');
    fs.writeFileSync(passagesFile, passageBody);
    const resealed = sealGistReceiptSet({ ...gistReceipt, passagesSha256: sha256File(passagesFile) });
    fs.writeFileSync(path.join(root, 'ruv-gists.sources.json'), `${JSON.stringify(resealed, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(root, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1, brainVersion: '0.0.0', releaseTag: 'v0.0.0', stores: ledgerStores,
  }));
  fs.writeFileSync(path.join(root, 'SOURCE.json'), JSON.stringify({
    builder: 'rvf-kb-forge', canonicalManifestUrl: 'https://example.invalid/manifest.json',
    selfUpdate: 'node forge-update.mjs', stores: updaterStores,
  }));
  // validatePublicInventory reads the corpus's own fence copy (corpus-reconcile.mjs's main() copies
  // the checkout fence in exactly like this).
  fs.copyFileSync(path.join(runtimeRoot, 'kb', 'PRIVATE-STORES.json'), path.join(root, 'PRIVATE-STORES.json'));
  if (seal) materializePublicInputs({ builderRoot: runtimeRoot, outDir: root });
  for (const [relative, body] of Object.entries(overrides)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), body);
  }
  return root;
}

/**
 * Seal a VALID ruvnet-brain-corpus-coverage ledger for `corpusDir` (every repository store CURRENT
 * and eligible, every sealed gist CURRENT), write it to runtimeRoot/data/source-coverage.json, and
 * return it. `unseededGistIds` adds gist rows the corpus's receipt does NOT carry — the exact
 * production condition (observation moved past the seal) that must now REJECT, never be scoped.
 * `mutate` may edit the row set before sealing so digest-consistent drift can be expressed.
 */
export function writeCoverage(runtimeRoot, corpusDir, { unseededGistIds = [], sourceObservationSha256 = null, mutate = null } = {}) {
  const ledger = readJson(path.join(corpusDir, 'RVF-GENERATIONS.json'));
  const classes = fs.existsSync(path.join(corpusDir, 'public-store-classes.json'))
    ? readJson(path.join(corpusDir, 'public-store-classes.json')) : { derived: [] };
  const derived = new Set(classes.derived.map((entry) => String(entry.store).toLowerCase()));
  const gistReceiptFile = path.join(corpusDir, 'ruv-gists.sources.json');
  const gistReceipt = fs.existsSync(gistReceiptFile) ? readJson(gistReceiptFile) : null;
  const rows = [];
  for (const [store, generation] of Object.entries(ledger.stores)) {
    if (store === 'ruv-gists' || derived.has(store.toLowerCase())) continue;
    rows.push({
      key: `repo:ruvnet/${store}`, kind: 'repository', name: store, url: `https://github.com/ruvnet/${store}`,
      routing: { description: null, homepageUrl: null, capabilityCardPresent: false },
      disposition: 'eligible',
      upstream: { sha: generation.sourceCommit, committedAt: null, pushedAt: null, updatedAt: null },
      artifact: { store, sourceCommit: generation.sourceCommit, ingestedAt: generation.builtUtc, rvfSha256: generation.sha256,
        bytesVerified: true, passagesPresent: true, cardPresent: false },
      status: 'CURRENT', reasons: [],
    });
  }
  if (gistReceipt) {
    const gistGeneration = ledger.stores['ruv-gists'];
    const seededIds = Object.keys(gistReceipt.gists);
    for (const id of [...seededIds, ...unseededGistIds]) {
      const record = gistReceipt.gists[id] || null;
      rows.push({
        key: `gist:${id}`, kind: 'gist', name: id, url: `https://gist.github.com/ruvnet/${id}`, disposition: 'eligible',
        upstream: { sha: record?.versionSha || null, updatedAt: record?.updatedAt || '2026-09-10T00:00:00Z', fileCount: record?.fileCount || 0, files: [] },
        artifact: { store: 'ruv-gists', sourceCommit: record?.versionSha || null, ingestedAt: record?.ingestedAt || null,
          contentDigest: record?.contentDigest || null, fileCount: record?.fileCount || null,
          rvfSha256: gistGeneration.sha256, bytesVerified: true },
        status: 'CURRENT', reasons: [],
      });
    }
  }
  if (mutate) mutate(rows);
  const orderedRows = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  const repositories = orderedRows.filter((row) => row.kind === 'repository').length;
  const gists = orderedRows.filter((row) => row.kind === 'gist').length;
  const enumerationReceipt = { schemaVersion: 1, owner: 'ruvnet', observedAt: '2026-09-13T00:00:00.000Z',
    requestParameters: { repositoryPageSize: 100, gistPageSize: 100 },
    repositories: { expected: repositories, pages: [] }, gists: { expected: gists, pages: [] },
    duplicateKeys: 0, terminal: true };
  const identity = {
    generatorSourceSha: hex('generator', 64), snapshotRoot: hex('snapshot', 64),
    sourceObservationSha256: sourceObservationSha256 ?? gistReceipt?.sourceObservationSha256 ?? hex('observation', 64),
  };
  const byStatus = Object.fromEntries([...new Set(orderedRows.map((row) => row.status))].sort()
    .map((status) => [status, orderedRows.filter((row) => row.status === status).length]));
  const coverage = {
    schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', owner: 'ruvnet', observedAt: '2026-09-13T00:00:00.000Z',
    ...identity, policy: { policyDispositionDigests: [], exemptionDigests: [] },
    coverageGeneration: coverageGenerationFor({ ...identity, rows: orderedRows, enumerationReceipt }),
    enumerationReceipt, rows: orderedRows,
    totals: { repositories, gists, rows: orderedRows.length, byStatus },
  };
  fs.mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'data', 'source-coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);
  return coverage;
}

export const SEED_IDENTITY = {
  tag: `corpus-sha256-${'e'.repeat(64)}`, archiveSha256: 'e'.repeat(64), archiveBytes: 1, baselineReceiptSha256: 'f'.repeat(64),
};
