#!/usr/bin/env node
// Seal and independently verify the exact public corpus bytes used by a release.
//
// Schema 3 (2026-09-14, ADR-086 Step 15 / correction A6): the receipt additionally binds the
// DETACHED retrieval-accuracy report — `accuracyReport {file, sha256, bytes}` — that measured this
// exact archive through the customer query path. The report stays OUTSIDE the ZIP on purpose:
// inserting it into an already-measured archive would either change the archive's digest after it
// was measured or force a second assembly, and ADR-086 permits exactly one. Detached plus
// digest-bound preserves single assembly and exact-artifact identity at the same time.
//
// SCHEMA-2 CONSEQUENCE, stated plainly: a schema-2 seed carries no accuracy binding and is
// therefore UNPUBLISHABLE from this commit forward — verifyCorpusReceipt, runProtectedCorpusSeed
// and corpus-seed.yml's committed-seed loader all refuse it. data/corpus-seed.json must be
// re-pointed at a schema-3 seed in the same change that publishes one (ADR-086 Step 11's job).
//
// Schema 2 (2026-09-13): the receipt binds the FULL provenance/input closure that ships inside the
// sealed archive — ARCHIVE-MANIFEST.json, PRIVATE-STORES.json, RVF-GENERATIONS.json, SOURCE.json,
// the ruv-gists aggregate receipt, and every derived-store receipt (concepts, etc.) — instead of
// trusting a separate, unshipped assets/policy directory. Both createCorpusReceipt (writer) and
// verifyCorpusReceipt (reader) call the SAME deriveCorpusCandidate() so they can never drift from
// each other, and verification only ever trusts bytes actually extracted from the archive itself —
// there is no `--assets` escape hatch. The external, content-addressed corpus-sha256-<digest> tag is
// always derived OUTSIDE the archive from its own bytes; the archive's internal ARCHIVE-MANIFEST.json
// releaseTag/version is a completely separate identity domain and is never compared against it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../kb/zip-extract.mjs';
import { canonicalJson, digest, fileIdentity, sha256File, validateGistAggregateReceipt } from '../plugin/scripts/coverage-integrity.mjs';
import { auditCorpusStores, isPassingState } from './rvf-index-audit.mjs';
import { readDiagnosticAccuracyReport } from './oracle/retrieval-accuracy.mjs';
import { loadFixture, readRecallReport } from './oracle/repo-recall.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_SUFFIXES = [
  '.big.rvf',
  '.big.rvf.idmap.json',
  '.big.rvf.embed.json',
  '.passages.jsonl',
  '.meta.json',
];
const OPTIONAL_SHIPPED_SUFFIXES = ['.big.passages.jsonl', '.big.meta.json'];
const HEX64 = /^[a-f0-9]{64}$/;
const HEX_SOURCE = /^[a-f0-9]{40,64}$/i;
const HEX_COMMIT = /^[a-f0-9]{7,64}$/i;

function fail(message) {
  throw new Error(`[corpus-candidate] ${message}`);
}

function readJson(file, label) {
  if (!file || !fs.existsSync(file)) fail(`${label} missing (${file || 'no path supplied'})`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a trusted regular file`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} unreadable/corrupt (${error.message})`);
  }
}

function findExactlyOne(root, name) {
  const matches = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`extracted archive contains a symbolic link: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === name) matches.push(file);
    }
  };
  visit(root);
  if (matches.length !== 1) fail(`archive must contain exactly one ${name}; found ${matches.length}`);
  return matches[0];
}

function filesUnder(root, prefix = '') {
  const rows = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    const file = path.join(root, relative);
    if (entry.isSymbolicLink()) fail(`archive tree contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) rows.push(...filesUnder(root, relative));
    else if (entry.isFile()) rows.push({ path: relative.split(path.sep).join('/'), sha256: sha256File(file), bytes: fs.statSync(file).size });
    else fail(`archive tree contains an unsupported entry: ${relative}`);
  }
  return rows;
}

function containedFile(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    fail(`${label} path escapes the archive root`);
  }
  const resolved = path.resolve(root, relative);
  const within = path.relative(root, resolved);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) fail(`${label} path escapes the archive root`);
  if (!fs.existsSync(resolved)) fail(`${label} missing (${relative})`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a trusted regular file`);
  return resolved;
}

function normalizeBootstrapIdentity(bootstrapIdentity) {
  if (bootstrapIdentity === null || bootstrapIdentity === undefined) return null;
  const { tag, sha256, privateFenceEvidence = null } = bootstrapIdentity;
  if (typeof tag !== 'string' || !tag) fail('bootstrap identity tag is missing');
  if (!HEX64.test(String(sha256 || '').toLowerCase())) fail('bootstrap identity sha256 is missing or malformed');
  if (privateFenceEvidence !== null) {
    if (typeof privateFenceEvidence.file !== 'string' || !privateFenceEvidence.file
      || !HEX64.test(String(privateFenceEvidence.sha256 || '')) || !Number.isSafeInteger(privateFenceEvidence.bytes)) {
      fail('bootstrap private-fence evidence is malformed');
    }
  }
  return { tag, sha256: sha256.toLowerCase(), privateFenceEvidence };
}

// The single derivation shared by the writer (createCorpusReceipt) and the reader
// (verifyCorpusReceipt): every field is either re-derived directly from bytes actually extracted
// from bundleFile, or is one of the three inputs that are not archive-derived (builderSourceSha,
// bootstrapIdentity, createdAt) — verification supplies those from the receipt being checked, so a
// receipt can never claim archive contents that were not really shipped.
async function deriveCorpusCandidate({ bundleFile, builderSourceSha, bootstrapIdentity, createdAt, accuracyReportFile, recallReportFile }) {
  const bundle = path.resolve(bundleFile || '');
  if (!fs.existsSync(bundle) || !fs.statSync(bundle).isFile()) fail(`bundle missing (${bundle || 'no path supplied'})`);
  if (!HEX_SOURCE.test(builderSourceSha || '')) fail('builderSourceSha must be a 40-64 hex source identity');
  const bootstrap = normalizeBootstrapIdentity(bootstrapIdentity);
  const archive = fileIdentity(bundle);

  // THE BLOCKING RETRIEVAL GATE (ADR-086 amendment, 2026-09-15). Both reports travel BESIDE the
  // archive under fixed derived names, so any reader holding nothing but a downloaded release asset
  // resolves the same files without the receipt carrying a path.
  //
  // What blocks: the frozen-fixture repo-recall gate. Every one of the 194 pre-existing human
  // questions must complete without error, every repository must return content of its own, and the
  // exact-file Hit@5 count may never fall below the accepted floor.
  //
  // What NO LONGER blocks: ADR-086's original C3 predicate. Measured against the real 4.3.25 archive
  // it returns 680/1152 = 59.0% (diagnostic, c3Eligible:false) after both of its candidate
  // explanations were tested and disproved. Holding publication on it shipped nothing. That swap is
  // a DECLARED REDUCTION in release requirements, not a demonstration that C3 passed — so the C3
  // report is still required to exist and still bound to these exact archive bytes, and is published
  // alongside rather than quietly dropped.
  const recall = readRecallReport({
    reportFile: recallReportFile || `${bundle}.recall.json`,
    archive,
    expectedFixtureSha256: loadFixture().fixtureSha256,
  });
  const accuracyDiagnostic = readDiagnosticAccuracyReport({
    reportFile: accuracyReportFile || `${bundle}.accuracy.json`,
    archive,
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-candidate-'));
  try {
    try {
      await extractZip(bundle, tmp);
    } catch (error) {
      fail(`cannot extract archive (${error.message})`);
    }

    const manifestFile = findExactlyOne(tmp, 'ARCHIVE-MANIFEST.json');
    const root = path.dirname(manifestFile);
    const manifest = readJson(manifestFile, 'archive manifest');
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'ruvnet-brain-archive-manifest'
      || typeof manifest.version !== 'string' || !manifest.version
      || typeof manifest.releaseTag !== 'string' || !manifest.releaseTag
      || !Array.isArray(manifest.files)) fail('archive manifest schema is invalid');

    const actualFiles = filesUnder(root).filter((row) => row.path !== 'ARCHIVE-MANIFEST.json');
    const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (canonicalJson([...actualFiles].sort(byPath)) !== canonicalJson([...manifest.files].sort(byPath))) {
      fail('archive file set or bytes differ from ARCHIVE-MANIFEST.json');
    }
    if (manifest.fileCount !== actualFiles.length
      || manifest.totalBytes !== actualFiles.reduce((total, row) => total + row.bytes, 0)) {
      fail('archive manifest totals differ from its file rows');
    }

    const privateFenceFile = path.join(root, 'PRIVATE-STORES.json');
    const fence = readJson(privateFenceFile, 'private fence');
    if (!Array.isArray(fence.privateStores)) fail('private fence has no privateStores array');
    const privateStores = [...new Set(fence.privateStores.map((name) => String(name).toLowerCase()))].sort();
    const privateSet = new Set(privateStores);

    const ledgerFile = path.join(root, 'RVF-GENERATIONS.json');
    const ledger = readJson(ledgerFile, 'RVF generation ledger');
    if (!ledger.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) {
      fail('RVF generation ledger has no stores object');
    }

    const sourceFile = path.join(root, 'SOURCE.json');
    const source = readJson(sourceFile, 'source manifest');
    if (!source.stores || typeof source.stores !== 'object' || Array.isArray(source.stores)) {
      fail('source manifest has no stores object');
    }

    const rvfFiles = fs.readdirSync(root).filter((name) => /^.+\.big\.rvf$/.test(name)).sort();
    const rvfByStore = new Map(rvfFiles.map((file) => [file.slice(0, -'.big.rvf'.length), file]));
    const foldedStores = [...rvfByStore.keys()].map((store) => store.toLowerCase());
    if (new Set(foldedStores).size !== foldedStores.length) fail('archive RVF store names have case-fold aliases');

    const leaked = [...rvfByStore.keys()].filter((store) => privateSet.has(store.toLowerCase()));
    if (leaked.length) fail(`private store(s) present in archive: ${leaked.join(', ')}`);

    const unreceipted = [...rvfByStore.keys()].filter((store) => !ledger.stores[store]);
    if (unreceipted.length) fail(`unreceipted RVF files: ${unreceipted.join(', ')}`);
    const orphanLedger = Object.entries(ledger.stores)
      .filter(([store, generation]) => generation.file !== `${store}.big.rvf` || !rvfByStore.has(store))
      .map(([store]) => store);
    if (orphanLedger.length) fail(`ledger rows without RVFs: ${orphanLedger.join(', ')}`);

    const digestOwners = new Map();
    for (const [store, file] of rvfByStore) {
      const rvfDigest = sha256File(path.join(root, file));
      const owners = digestOwners.get(rvfDigest) || [];
      owners.push(store);
      digestOwners.set(rvfDigest, owners);
    }
    const duplicateRvfDigests = [...digestOwners.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([sha256, owners]) => ({ sha256, stores: owners.sort() }));
    if (duplicateRvfDigests.length) fail(`duplicate RVF bytes: ${duplicateRvfDigests.map((row) => row.stores.join('/')).join(', ')}`);

    // Derived-store receipts (concepts, etc.) — the "concepts inputs" closure. Optional: a fresh
    // bootstrap round may not have built any derived store yet.
    const derivedStores = [];
    const derivedNames = new Set();
    const classesFile = path.join(root, 'public-store-classes.json');
    if (fs.existsSync(classesFile)) {
      const classes = readJson(classesFile, 'public store classes');
      if (classes.schemaVersion !== 1 || !Array.isArray(classes.derived)) fail('derived store classes are malformed');
      for (const entry of classes.derived) {
        const store = String(entry?.store || '').toLowerCase();
        if (!store) fail('derived store class entry is missing a store name');
        derivedNames.add(store);
        const receiptFile = containedFile(root, entry.receipt, `derived ${store} receipt`);
        const dReceipt = readJson(receiptFile, `derived ${store} receipt`);
        const passagesFile = containedFile(root, `${store}.passages.jsonl`, `derived ${store} passages`);
        if (dReceipt.schemaVersion !== 1 || dReceipt.kind !== 'ruvnet-brain-derived-store-receipt'
          || String(dReceipt.store || '').toLowerCase() !== store || !Array.isArray(dReceipt.inputs) || !dReceipt.inputs.length
          || !HEX64.test(String(dReceipt.passagesSha256 || '')) || dReceipt.passagesSha256 !== sha256File(passagesFile)) {
          fail(`derived ${store} receipt does not bind its passage bytes`);
        }
        for (const input of dReceipt.inputs) {
          const inputFile = containedFile(root, input?.path, `derived ${store} input`);
          if (!HEX64.test(String(input.sha256 || '')) || input.sha256 !== sha256File(inputFile)) {
            fail(`derived ${store} input receipt differs from ${input?.path || '(missing)'}`);
          }
        }
        derivedStores.push({ store, receipt: fileIdentity(receiptFile) });
      }
    }

    // The ruv-gists aggregate — validated with the SAME reader every other consumer of this
    // receipt schema uses (plugin/scripts/coverage-integrity.mjs), so the "individual source
    // receipt digest, not the aggregate observation digest" contract lives in one place.
    let gistAggregate = null;
    if (rvfByStore.has('ruv-gists')) {
      const gistReceiptFile = path.join(root, 'ruv-gists.sources.json');
      const gistPassagesFile = path.join(root, 'ruv-gists.passages.jsonl');
      if (!fs.existsSync(gistReceiptFile)) fail('ruv-gists store is present without ruv-gists.sources.json');
      const gistReceipt = readJson(gistReceiptFile, 'gist aggregate receipt');
      validateGistAggregateReceipt({ receipt: gistReceipt, passagesFile: gistPassagesFile, expectedIds: null });
      gistAggregate = { name: 'ruv-gists', receipt: fileIdentity(gistReceiptFile) };
    }

    const missingSidecars = [];
    const stores = [];
    for (const [store, rvfFile] of [...rvfByStore].sort(([a], [b]) => a.localeCompare(b))) {
      const generation = ledger.stores[store];
      const rvfPath = path.join(root, rvfFile);
      if (generation.file !== rvfFile || generation.sha256 !== sha256File(rvfPath) || generation.bytes !== fs.statSync(rvfPath).size) {
        fail(`${store}: generation receipt does not match RVF bytes`);
      }
      if (typeof generation.builtUtc !== 'string' || !Number.isFinite(Date.parse(generation.builtUtc))
        || typeof generation.model !== 'string' || !generation.model || !Number.isInteger(generation.dimensions)
        || !(generation.sourceCommit === null || HEX_COMMIT.test(String(generation.sourceCommit || '')))) {
        fail(`${store}: generation receipt lacks builtUtc, model, dimensions, or sourceCommit provenance`);
      }
      const folded = store.toLowerCase();
      const kind = folded === 'ruv-gists' ? 'gist-aggregate' : derivedNames.has(folded) ? 'derived' : 'repository';
      if (kind === 'repository') {
        // The semantic cross-check: a repository store's ledger sourceCommit (the SELECTED
        // generation) must equal the exact upstream SHA the worker that built it actually cloned
        // and checked out (SOURCE.json) — never merely trusted from the ledger alone.
        const sourceRow = source.stores[store];
        const sourceCommit = String(sourceRow?.sourceCommit || '').toLowerCase();
        const ledgerCommit = String(generation.sourceCommit || '').toLowerCase();
        if (!sourceRow || !sourceCommit || sourceCommit !== ledgerCommit) {
          fail(`${store}: SOURCE manifest sourceCommit does not equal the selected generation sourceCommit`);
        }
      }
      const files = [];
      for (const suffix of REQUIRED_SUFFIXES) {
        const file = path.join(root, `${store}${suffix}`);
        if (!fs.existsSync(file)) missingSidecars.push(path.basename(file));
        else files.push(fileIdentity(file));
      }
      for (const suffix of OPTIONAL_SHIPPED_SUFFIXES) {
        const file = path.join(root, `${store}${suffix}`);
        if (fs.existsSync(file)) files.push(fileIdentity(file));
      }
      stores.push({
        name: store,
        kind,
        sourceCommit: generation.sourceCommit ?? null,
        builtUtc: generation.builtUtc,
        model: generation.model,
        dimensions: generation.dimensions,
        files,
      });
    }
    if (missingSidecars.length) fail(`missing sidecars: ${missingSidecars.join(', ')}`);
    if (!stores.length) fail('zero public corpus stores in the archive');

    // C2 gate (scripts/rvf-index-audit.mjs auditCorpusStores): every shipped RVF is reopened read-only
    // and must (1) carry a hash-verified persisted INDEX_SEG when it is large enough to need one,
    // (2) answer persisted k-NN queries with measured recall@10 >= 0.95 against exact neighbours
    // brute-forced from its own stored vectors, and (3) have an id map, passage rows and source
    // mapping that correspond one-to-one. Segment presence alone is not accepted; stores under the
    // engine's 1,024-vector HNSW threshold are reported as PASS-SMALL-STORE, never as PASS. The full
    // measured result is written next to the archive as <bundle>.rvf-audit.json — NOT into this
    // receipt: the receipt is schemaVersion 2 and any field addition is Step 15's coordinated bump.
    let rvfAudit;
    try {
      rvfAudit = await auditCorpusStores({
        dir: root,
        rvfPaths: [...rvfByStore.values()].map((file) => path.join(root, file)),
        privateStores: privateSet,
      });
    } catch (error) {
      fail(`RVF index audit could not run (${error.message})`);
    }
    fs.writeFileSync(`${bundle}.rvf-audit.json`, `${JSON.stringify(rvfAudit, null, 2)}\n`);
    const indexFailures = rvfAudit.stores.filter(({ state }) => !isPassingState(state));
    if (indexFailures.length || rvfAudit.privateExclusion.leaks.length) {
      fail(`RVF index audit failed: ${indexFailures
        .map((row) => `${path.basename(row.path)} (vectors=${row.totalVectors ?? '?'}, recall@${row.recall?.kEffective ?? '?'}=${row.recall?.recallAtK ?? '?'}: ${[...new Set(row.failures.map((failure) => failure.kind))].join('+')})`)
        .concat(rvfAudit.privateExclusion.leaks.map((name) => `${name} (private store present)`))
        .join(', ')}`);
    }

    const finalByteFiles = stores.flatMap((store) => store.files.map((file) => ({ store: store.name, ...file })))
      .sort((a, b) => a.file.localeCompare(b.file) || a.store.localeCompare(b.store));
    const finalBytePartitionSha256 = digest({
      archiveManifestSha256: digest(manifest),
      privateFenceSha256: sha256File(privateFenceFile),
      sourceManifestSha256: sha256File(sourceFile),
      gistAggregate,
      derivedStores,
      files: finalByteFiles,
    });

    return {
      schemaVersion: 3,
      kind: 'ruvnet-brain-corpus-candidate',
      builderSourceSha: builderSourceSha.toLowerCase(),
      createdAt,
      archive,
      archiveManifest: fileIdentity(manifestFile),
      archiveManifestVersion: manifest.version,
      archiveManifestReleaseTag: manifest.releaseTag,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      privateFence: fileIdentity(privateFenceFile),
      generationLedger: fileIdentity(ledgerFile),
      sourceManifest: fileIdentity(sourceFile),
      gistAggregate,
      derivedStores,
      storeCount: stores.length,
      stores,
      excludedPrivateStores: privateStores,
      duplicateRvfDigests: [],
      unreceiptedRvfFiles: [],
      missingSidecars: [],
      bootstrap,
      finalBytePartitionSha256,
      // A6, verbatim: "bump the corpus receipt to schemaVersion 3 with accuracyReport
      // {file, sha256, bytes}". Exactly those three fields — the oracle and generator identities
      // the publication gate needs are reached THROUGH this digest, by re-reading the bound report.
      // The field keeps its name and shape so existing seed readers are unaffected; what changed is
      // that this report is now a published DIAGNOSTIC, and `recallReport` is the blocking one.
      accuracyReport: accuracyDiagnostic.identity,
      accuracyDiagnostic: {
        state: accuracyDiagnostic.state,
        classification: accuracyDiagnostic.classification,
        c3Eligible: accuracyDiagnostic.c3Eligible,
        blocking: false,
        note: 'ADR-086 C3 was NOT met and is NOT demonstrated by this release. Published for inspection.',
      },
      recallReport: recall.identity,
      recallSummary: {
        fixtureSha256: recall.report.fixture.sha256,
        questions: recall.report.totals.questions,
        repositoriesAnswering: recall.report.totals.repoCoverage,
        exactFileTop1: recall.report.totals.hitTop1,
        exactFileTop5: recall.report.totals.hitTop5,
        floor: recall.report.floor.value,
        blocking: true,
      },
      generator: { corpusCandidateSha256: sha256File(fileURLToPath(import.meta.url)) },
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function currentGitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(HERE, '..'), encoding: 'utf8' });
  if (result.status !== 0) fail('cannot determine builder source SHA');
  return result.stdout.trim();
}

export async function createCorpusReceipt({
  bundleFile, builderSourceSha, bootstrapIdentity = null, receiptFile, createdAt, accuracyReportFile = null, recallReportFile = null,
} = {}) {
  const resolvedReceiptFile = path.resolve(receiptFile || 'dist/corpus-receipt.json');
  const receipt = await deriveCorpusCandidate({
    bundleFile,
    builderSourceSha: builderSourceSha || currentGitSha(),
    bootstrapIdentity,
    createdAt: createdAt || new Date().toISOString(),
    accuracyReportFile,
    recallReportFile,
  });
  fs.mkdirSync(path.dirname(resolvedReceiptFile), { recursive: true });
  fs.writeFileSync(resolvedReceiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function verifyCorpusReceipt({
  bundleFile, receiptFile, expectedBuilderSha, expectedArchiveSha256, expectedReceiptSha256, accuracyReportFile = null, recallReportFile = null,
} = {}) {
  const resolvedReceiptFile = path.resolve(receiptFile || '');
  const resolvedBundleFile = path.resolve(bundleFile || '');
  const receipt = readJson(resolvedReceiptFile, 'corpus receipt');
  // Schema 3 only. A schema-2 receipt has no accuracyReport binding, so accepting one here would
  // silently publish a corpus that was never measured — the exact hole A6 closes.
  if (receipt.schemaVersion !== 3 || receipt.kind !== 'ruvnet-brain-corpus-candidate') {
    fail('unsupported corpus receipt (schema downgrade or wrong kind)');
  }
  if (expectedReceiptSha256 != null && sha256File(resolvedReceiptFile) !== expectedReceiptSha256) {
    fail('receipt file bytes differ from the expected receipt sha256');
  }
  if (expectedBuilderSha != null && receipt.builderSourceSha !== String(expectedBuilderSha).toLowerCase()) {
    fail('receipt builderSourceSha differs from the expected builder SHA');
  }
  if (!fs.existsSync(resolvedBundleFile)) fail(`bundle missing (${resolvedBundleFile})`);
  const actualArchiveSha256 = sha256File(resolvedBundleFile);
  if (actualArchiveSha256 !== receipt.archive?.sha256 || fs.statSync(resolvedBundleFile).size !== receipt.archive?.bytes) {
    fail('archive sha256 or byte length differs from the corpus receipt');
  }
  if (expectedArchiveSha256 != null && actualArchiveSha256 !== expectedArchiveSha256) {
    fail('archive sha256 differs from the expected archive sha256');
  }
  const derived = await deriveCorpusCandidate({
    bundleFile: resolvedBundleFile,
    builderSourceSha: receipt.builderSourceSha,
    bootstrapIdentity: receipt.bootstrap,
    createdAt: receipt.createdAt,
    accuracyReportFile,
    recallReportFile,
  });
  if (canonicalJson(derived) !== canonicalJson(receipt)) fail('receipt does not match the exact corpus archive contents');
  return receipt;
}

// Verify a downloaded seed archive against its EXTERNAL, content-addressed descriptor
// (corpus-sha256-<digest>) and its accompanying schema-2 candidate receipt. This never compares
// the external tag against the archive's own internal ARCHIVE-MANIFEST releaseTag/version — those
// are two independent identity domains and conflating them was the historical bug this fixes.
export async function verifySeedBaseline({ seedDescriptor, bundleFile, receiptFile, accuracyReportFile = null, recallReportFile = null } = {}) {
  if (!seedDescriptor || typeof seedDescriptor !== 'object') fail('seed descriptor is required');
  const { tag, sha256, bytes, sourceCommit = null, allowPinnedTag = false } = seedDescriptor;
  const expectedSha256 = String(sha256 || '').toLowerCase();
  if (!HEX64.test(expectedSha256)) fail('seed descriptor sha256 is missing or malformed');
  if (!tag || tag === 'latest') fail('seed descriptor tag is missing or forbidden');
  const contentAddressed = tag === `corpus-sha256-${expectedSha256}`;
  if (!contentAddressed && !allowPinnedTag) {
    fail('seed descriptor tag must be the exact digest-derived tag corpus-sha256-<sha256> unless explicitly pinned');
  }
  const resolvedBundleFile = path.resolve(bundleFile || '');
  if (!fs.existsSync(resolvedBundleFile)) fail(`seed bundle missing (${resolvedBundleFile})`);
  const actualSha256 = sha256File(resolvedBundleFile);
  if (actualSha256 !== expectedSha256) fail(`seed bundle sha256 ${actualSha256} differs from configured ${expectedSha256}`);
  if (Number.isSafeInteger(bytes) && fs.statSync(resolvedBundleFile).size !== bytes) {
    fail('seed bundle byte length differs from the configured seed descriptor');
  }
  // "Reverify the downloaded final artifact against the measured identity" — a downloaded seed is
  // re-measured against its own detached accuracy report, which must have travelled with it.
  const receipt = await verifyCorpusReceipt({
    bundleFile: resolvedBundleFile,
    receiptFile,
    accuracyReportFile,
    recallReportFile,
    expectedArchiveSha256: expectedSha256,
    ...(sourceCommit ? { expectedBuilderSha: sourceCommit } : {}),
  });
  return { tag, sha256: expectedSha256, bytes: fs.statSync(resolvedBundleFile).size, receipt };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const mode = process.argv.includes('--verify') ? 'verify' : 'create';
  const bundleFile = arg('--bundle', 'dist/ruvnet-brain.zip');
  const receiptFile = arg('--receipt', arg('--out', 'dist/corpus-receipt.json'));
  const accuracyReportFile = arg('--accuracy-report');
  const recallReportFile = arg('--recall-report');
  if (mode === 'create') {
    const bootstrapTag = arg('--bootstrap-tag');
    const bootstrapSha256 = arg('--bootstrap-sha256');
    const bootstrapIdentity = bootstrapTag && bootstrapSha256 ? { tag: bootstrapTag, sha256: bootstrapSha256 } : null;
    const receipt = await createCorpusReceipt({
      bundleFile,
      builderSourceSha: arg('--builder-source-sha'),
      bootstrapIdentity,
      receiptFile,
      accuracyReportFile,
      recallReportFile,
    });
    console.log(JSON.stringify({
      ok: true, mode, archive: receipt.archive, stores: receipt.storeCount, accuracyReport: receipt.accuracyReport, recall: receipt.recallSummary,
    }, null, 2));
  } else {
    const receipt = await verifyCorpusReceipt({
      bundleFile,
      receiptFile,
      accuracyReportFile,
      recallReportFile,
      expectedBuilderSha: arg('--expected-builder-sha'),
      expectedArchiveSha256: arg('--expected-archive-sha256'),
      expectedReceiptSha256: arg('--expected-receipt-sha256'),
    });
    console.log(JSON.stringify({
      ok: true, mode, archive: receipt.archive, stores: receipt.storeCount, accuracyReport: receipt.accuracyReport, recall: receipt.recallSummary,
    }, null, 2));
  }
}

// REALPATH BOTH SIDES, or this CLI silently no-ops. argv[1] is whatever the caller typed, symlinks
// and all, while node resolves a module URL THROUGH symlinks before it reaches import.meta.url — so a
// symlinked invocation compares a link path against a real path, decides it is not the entry point,
// runs nothing, and EXITS 0. On macOS every os.tmpdir() path is symlinked (/var/folders -> /private/
// var/folders), so any caller staging work in a temp directory hits this. Measured 2026-09-14:
// build-bundle.mjs and corpus-candidate.mjs both no-opped and prepareCorpusCandidate reported SUCCESS
// with no archive and no receipt on disk. Same defect, same fix as plugin/scripts/hook-input.mjs:518.
function isMain() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
