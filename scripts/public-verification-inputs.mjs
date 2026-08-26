#!/usr/bin/env node
// Compile the exact public-verification inputs from immutable artifact bytes.
// Queries are an independent review input: this producer validates them but never invents them.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../kb/zip-extract.mjs';
import { canonicalJson, digest, validateCoverageLedger, validateCoverageLink } from './coverage-integrity.mjs';
import { validatePublicInventory } from './public-inventory.mjs';
import {
  buildRetrievalCanaryPlan,
  validateRetrievalQueryEvidence,
  verifyQueryOracleSource,
} from './retrieval-canary.mjs';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MANIFEST = 'ARCHIVE-MANIFEST.json';

function fail(message) {
  throw new Error(`[public-verification-inputs] ${message}`);
}

function trustedFile(file, label) {
  if (!file) fail(`${label} path is required`);
  const resolved = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { fail(`${label} is missing (${resolved})`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a trusted regular file`);
  return resolved;
}

function readJson(file, label) {
  const resolved = trustedFile(file, label);
  try { return { value: JSON.parse(fs.readFileSync(resolved, 'utf8')), file: resolved }; }
  catch (error) { fail(`${label} is unreadable: ${error.message}`); }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function identity(file) {
  return { sha256: sha256File(file), bytes: fs.statSync(file).size };
}

function namedIdentity(file) {
  return { file: path.basename(file), ...identity(file) };
}

function filesUnder(root, prefix = '', { includeManifest = false } = {}) {
  const rows = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (!includeManifest && relative === MANIFEST) continue;
    const file = path.join(root, relative);
    if (entry.isSymbolicLink()) fail(`archive tree contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) rows.push(...filesUnder(root, relative, { includeManifest }));
    else if (entry.isFile()) rows.push({ path: relative.split(path.sep).join('/'), ...identity(file) });
    else fail(`archive tree contains an unsupported entry: ${relative}`);
  }
  return rows;
}

function findNamed(root, name) {
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

function validateArchive(root) {
  const manifestFile = findNamed(root, MANIFEST);
  const archiveRoot = path.dirname(manifestFile);
  const { value: manifest } = readJson(manifestFile, 'archive manifest');
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'ruvnet-brain-archive-manifest'
    || typeof manifest.version !== 'string' || !manifest.version || typeof manifest.releaseTag !== 'string'
    || !manifest.releaseTag || !Array.isArray(manifest.files)) fail('archive manifest schema is invalid');
  const actual = filesUnder(archiveRoot);
  const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  if (canonicalJson([...actual].sort(byPath)) !== canonicalJson([...manifest.files].sort(byPath))) {
    fail('archive file set or bytes differ from ARCHIVE-MANIFEST.json');
  }
  if (manifest.fileCount !== actual.length
    || manifest.totalBytes !== actual.reduce((total, row) => total + row.bytes, 0)) {
    fail('archive manifest totals differ from its file rows');
  }
  return { root: archiveRoot, manifest };
}

function exactNamedFile(root, name, label) {
  if (typeof name !== 'string' || !name || path.basename(name) !== name) fail(`${label} file name is invalid`);
  return trustedFile(path.join(root, name), label);
}

function validateCandidate({ root, bundleFile, packageFile }) {
  const coverageFile = trustedFile(path.join(root, 'COVERAGE.json'), 'candidate release coverage');
  const coverageBytes = fs.readFileSync(coverageFile);
  let coverage;
  try { coverage = JSON.parse(coverageBytes); } catch (error) { fail(`candidate release coverage is unreadable: ${error.message}`); }
  const checked = validateCoverageLedger(coverage);
  const eligible = Array.isArray(coverage.rows) ? coverage.rows.filter((row) => row.disposition === 'eligible') : [];
  if (!checked.valid || coverage.kind !== 'ruvnet-brain-release-coverage'
    || !eligible.length || eligible.some((row) => row.status !== 'CURRENT')) {
    fail(`candidate release coverage is invalid or incomplete: ${checked.failures.join('; ')}`);
  }
  const corpusCoverageFile = trustedFile(path.join(root, 'CORPUS-COVERAGE.json'), 'candidate corpus coverage');
  const corpusCoverageBytes = fs.readFileSync(corpusCoverageFile);
  let corpusCoverage;
  try { corpusCoverage = JSON.parse(corpusCoverageBytes); }
  catch (error) { fail(`candidate corpus coverage is unreadable: ${error.message}`); }
  const linked = validateCoverageLink({ releaseCoverage: coverage, corpusCoverage,
    corpusCoverageSha256: crypto.createHash('sha256').update(corpusCoverageBytes).digest('hex') });
  if (!linked.valid) fail(`candidate corpus coverage link is invalid: ${linked.failures.join('; ')}`);
  const ledgerFile = trustedFile(path.join(root, 'PUBLIC-RVF-GENERATIONS.json'), 'candidate public generation ledger');
  const ledgerBytes = fs.readFileSync(ledgerFile);
  let ledger;
  try { ledger = JSON.parse(ledgerBytes); } catch (error) { fail(`candidate public generation ledger is unreadable: ${error.message}`); }
  const ledgerIdentity = identity(ledgerFile);
  const storeCount = Object.keys(ledger?.stores || {}).length;
  if (ledger.schemaVersion !== 2 || ledger.kind !== 'ruvnet-brain-public-generation-ledger'
    || ledger.brainVersion !== coverage.releaseIdentity.version || ledger.releaseTag !== coverage.releaseIdentity.tag
    || ledger.sourceSnapshot !== coverage.releaseIdentity.sourceSnapshot
    || coverage.generationLedger.file !== 'PUBLIC-RVF-GENERATIONS.json'
    || coverage.generationLedger.sha256 !== ledgerIdentity.sha256
    || coverage.generationLedger.bytes !== ledgerIdentity.bytes || coverage.generationLedger.storeCount !== storeCount) {
    fail('candidate public generation ledger differs from release coverage');
  }
  const inventory = validatePublicInventory({ assetsDir: root, coverage, ledger });
  if (inventory.publicStores.length !== storeCount
    || inventory.partitionSha256 !== coverage.publicInventoryPartitionSha256) {
    fail('candidate public inventory partition differs from release coverage');
  }
  const coverageIdentity = { sha256: crypto.createHash('sha256').update(coverageBytes).digest('hex'), bytes: coverageBytes.length };
  const candidate = {
    sourceSha: coverage.releaseIdentity.sourceSnapshot,
    packageSha256: sha256File(packageFile),
    archiveSha256: sha256File(bundleFile),
    coverageSha256: coverageIdentity.sha256,
    publicLedgerSha256: ledgerIdentity.sha256,
    publicLedgerBytes: ledgerIdentity.bytes,
    publicStoreCount: storeCount,
    publicInventoryPartitionSha256: inventory.partitionSha256,
  };
  if (!HEX40.test(candidate.sourceSha) || !Object.values(candidate).filter((value) => typeof value === 'string')
    .filter((value) => value.length === 64).every((value) => HEX64.test(value))) fail('candidate identity is malformed');
  return { coverage, coverageBytes, coverageIdentity, candidate };
}

function encoded(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function retrospectiveBaselineFromTree({ extractedRoot, bundleFile, expectedTag, expectedSha256, expectedBytes }) {
  const ledgerFile = findNamed(extractedRoot, 'RVF-GENERATIONS.json');
  const root = path.dirname(ledgerFile);
  const { value: ledger } = readJson(ledgerFile, 'historical baseline generation ledger');
  const names = Object.keys(ledger?.stores || {}).sort();
  if (ledger.schemaVersion !== 1 || typeof ledger.brainVersion !== 'string' || !ledger.brainVersion
    || typeof ledger.releaseTag !== 'string' || !ledger.releaseTag || !names.length
    || new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    fail('historical baseline generation ledger is malformed');
  }
  const archive = namedIdentity(bundleFile);
  if (typeof expectedTag !== 'string' || !expectedTag || ledger.releaseTag !== expectedTag) {
    fail('historical baseline differs from the expected public release tag');
  }
  if (!HEX64.test(String(expectedSha256 || '')) || archive.sha256 !== expectedSha256) {
    fail('historical baseline differs from the expected public archive SHA-256');
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || archive.bytes !== expectedBytes) {
    fail('historical baseline differs from the expected public archive byte length');
  }
  const archiveFiles = filesUnder(root, '', { includeManifest: true });
  const archiveManifest = { schemaVersion: 1, kind: 'ruvnet-brain-retrospective-archive-manifest',
    fileCount: archiveFiles.length, totalBytes: archiveFiles.reduce((total, row) => total + row.bytes, 0),
    files: archiveFiles };
  const actualRvfFiles = archiveFiles.filter(({ path: relative }) => relative.endsWith('.big.rvf'))
    .map(({ path: relative }) => path.posix.basename(relative)).sort();
  const expectedRvfFiles = names.map((name) => `${name}.big.rvf`).sort();
  if (canonicalJson(actualRvfFiles) !== canonicalJson(expectedRvfFiles)) {
    fail('historical baseline RVF set differs from its generation ledger');
  }
  const stores = names.map((name) => {
    const row = ledger.stores[name];
    const file = exactNamedFile(root, row?.file, `historical ${name} RVF`);
    const actual = namedIdentity(file);
    if (row.file !== `${name}.big.rvf` || row.sha256 !== actual.sha256 || row.bytes !== actual.bytes
      || typeof row.model !== 'string' || !row.model.trim() || !Number.isInteger(row.dimensions) || row.dimensions < 1
      || !(row.sourceCommit === null || /^[a-f0-9]{7,64}$/i.test(String(row.sourceCommit || '')))
      || typeof row.builtUtc !== 'string' || !Number.isFinite(Date.parse(row.builtUtc))) {
      fail(`historical ${name} generation record does not bind its RVF bytes and provenance`);
    }
    return { name: name.toLowerCase(), ...actual, model: row.model, dimensions: row.dimensions,
      sourceCommit: row.sourceCommit === null ? null : row.sourceCommit.toLowerCase(), builtUtc: row.builtUtc };
  });
  const provenanceGaps = stores.filter(({ sourceCommit }) => sourceCommit === null).map(({ name }) => name);
  const payload = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-retrospective-baseline-verification',
    verificationMode: 'retrospective-byte-verification',
    historicalCorpusReceipt: false,
    releaseTag: ledger.releaseTag,
    brainVersion: ledger.brainVersion,
    archive,
    archiveManifestSha256: digest(archiveManifest),
    generationLedger: namedIdentity(ledgerFile),
    storeCount: stores.length,
    storeSetSha256: digest(stores.map(({ name }) => name)),
    stores,
    provenanceGaps,
    limitations: [
      'no historical corpus receipt was published with these bytes',
      'verification proves immutable archive, ledger, RVF bytes, and recorded provenance; it does not invent historical process evidence',
      ...(provenanceGaps.length ? [`${provenanceGaps.length} store(s) have null sourceCommit in the historical ledger`] : []),
    ],
  };
  const receipt = { ...payload, receiptSha256: digest(payload) };
  const bytes = encoded(receipt);
  return { receipt, bytes, fileSha256: crypto.createHash('sha256').update(bytes).digest('hex'), root, archiveManifest };
}

function observedBaselineFromTree({ extractedRoot, bundleFile, expectedTag, expectedSha256, expectedBytes }) {
  const ledgerFile = findNamed(extractedRoot, 'RVF-GENERATIONS.json');
  const root = path.dirname(ledgerFile);
  const { value: ledger } = readJson(ledgerFile, 'historical baseline generation ledger');
  const ledgerNames = Object.keys(ledger?.stores || {}).sort();
  if (ledger.schemaVersion !== 1 || typeof ledger.brainVersion !== 'string' || !ledger.brainVersion
    || typeof ledger.releaseTag !== 'string' || !ledger.releaseTag || !ledgerNames.length
    || new Set(ledgerNames.map((name) => name.toLowerCase())).size !== ledgerNames.length) {
    fail('historical baseline generation ledger is malformed');
  }
  const archive = namedIdentity(bundleFile);
  if (ledger.releaseTag !== expectedTag) fail('historical baseline differs from the expected public release tag');
  if (!HEX64.test(String(expectedSha256 || '')) || archive.sha256 !== expectedSha256) {
    fail('historical baseline differs from the expected public archive SHA-256');
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || archive.bytes !== expectedBytes) {
    fail('historical baseline differs from the expected public archive byte length');
  }
  const archiveFiles = filesUnder(root, '', { includeManifest: true });
  const archiveManifest = { schemaVersion: 1, kind: 'ruvnet-brain-retrospective-archive-manifest',
    fileCount: archiveFiles.length, totalBytes: archiveFiles.reduce((total, row) => total + row.bytes, 0),
    files: archiveFiles };
  const actualRvfs = new Map(archiveFiles.filter(({ path: relative }) => relative.endsWith('.big.rvf')).map((row) => {
    const name = path.posix.basename(row.path).slice(0, -'.big.rvf'.length).toLowerCase();
    return [name, { file: path.posix.basename(row.path), sha256: row.sha256, bytes: row.bytes }];
  }));
  if (actualRvfs.size !== archiveFiles.filter(({ path: relative }) => relative.endsWith('.big.rvf')).length) {
    fail('historical baseline RVF names have case-fold aliases');
  }
  const ledgerByName = new Map(ledgerNames.map((name) => [name.toLowerCase(), ledger.stores[name]]));
  const allNames = [...new Set([...actualRvfs.keys(), ...ledgerByName.keys()])].sort();
  const ledgerDiscrepancies = [];
  for (const name of allNames) {
    const actual = actualRvfs.get(name);
    const expected = ledgerByName.get(name);
    if (!expected) ledgerDiscrepancies.push({ store: name, type: 'unreceipted-rvf', archive: actual });
    else if (!actual) ledgerDiscrepancies.push({ store: name, type: 'missing-rvf', ledger: {
      file: expected.file, sha256: expected.sha256, bytes: expected.bytes } });
    else if (expected.file !== actual.file || expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
      ledgerDiscrepancies.push({ store: name, type: 'byte-identity-mismatch',
        ledger: { file: expected.file, sha256: expected.sha256, bytes: expected.bytes }, archive: actual });
    }
  }
  const stores = [...actualRvfs].map(([name, actual]) => {
    const row = ledgerByName.get(name) || {};
    return { name, ...actual, model: typeof row.model === 'string' ? row.model : null,
      dimensions: Number.isInteger(row.dimensions) ? row.dimensions : null,
      sourceCommit: row.sourceCommit === null ? null : String(row.sourceCommit || '').toLowerCase() || null,
      builtUtc: typeof row.builtUtc === 'string' ? row.builtUtc : null };
  });
  const provenanceGaps = stores.filter(({ sourceCommit }) => sourceCommit === null).map(({ name }) => name);
  const discrepancyDigest = digest({ ledgerDiscrepancies, provenanceGaps });
  const payload = { schemaVersion: 1, kind: 'ruvnet-brain-observed-failed-public-baseline', integrity: 'DEGRADED',
    historicalCorpusReceipt: false, candidateVerificationEligible: false, releaseTag: ledger.releaseTag,
    brainVersion: ledger.brainVersion, archive, archiveManifestSha256: digest(archiveManifest),
    generationLedger: namedIdentity(ledgerFile), storeCount: stores.length,
    storeSetSha256: digest(stores.map(({ name }) => name)), stores, ledgerDiscrepancies, provenanceGaps,
    discrepancyDigest, limitations: [
      'no historical corpus receipt was published with these bytes',
      'observation binds actual public archive members but is not corpus, candidate, or release integrity proof',
    ] };
  const receipt = { ...payload, receiptSha256: digest(payload) };
  const bytes = encoded(receipt);
  return { receipt, bytes, fileSha256: crypto.createHash('sha256').update(bytes).digest('hex'), root, archiveManifest };
}

function writeExactFile(file, bytes, label) {
  const output = path.resolve(file);
  if (fs.existsSync(output)) {
    const existing = trustedFile(output, `existing ${label}`);
    if (!fs.readFileSync(existing).equals(bytes)) fail(`existing ${label} differs from the derived evidence`);
    return output;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
  return output;
}

export async function createRetrospectiveBaselineVerification({ baselineBundle,
  expectedTag, expectedSha256, expectedBytes,
  outFile = 'release-evidence/baseline-verification-receipt.json' } = {}) {
  const archive = trustedFile(baselineBundle, 'baseline archive');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'retrospective-baseline-'));
  try {
    try { await extractZip(archive, temp); }
    catch (error) { fail(`baseline archive extraction failed: ${error.message}`); }
    const result = retrospectiveBaselineFromTree({ extractedRoot: temp, bundleFile: archive,
      expectedTag, expectedSha256, expectedBytes });
    writeExactFile(outFile, result.bytes, 'baseline-verification-receipt.json');
    return result;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function createObservedBaselineReceipt({ baselineBundle, expectedTag, expectedSha256, expectedBytes,
  outFile = 'release-evidence/baseline-observation-receipt.json' } = {}) {
  const archive = trustedFile(baselineBundle, 'baseline archive');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-baseline-'));
  try {
    try { await extractZip(archive, temp); }
    catch (error) { fail(`baseline archive extraction failed: ${error.message}`); }
    const result = observedBaselineFromTree({ extractedRoot: temp, bundleFile: archive,
      expectedTag, expectedSha256, expectedBytes });
    writeExactFile(outFile, result.bytes, 'baseline-observation-receipt.json');
    return result;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function writeExactOutputs(outDir, outputs) {
  const root = path.resolve(outDir || 'release-evidence');
  for (const [name, bytes] of Object.entries(outputs)) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const existing = trustedFile(file, `existing ${name}`);
    if (!fs.readFileSync(existing).equals(bytes)) fail(`existing ${name} differs from the derived evidence`);
  }
  fs.mkdirSync(root, { recursive: true });
  for (const [name, bytes] of Object.entries(outputs)) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  }
  return root;
}

export async function createPublicVerificationInputs({ baselineBundle, candidateBundle,
  candidatePackage, oracleFile, repo = process.cwd(), outDir = 'release-evidence', baselineMode = 'verified' } = {}) {
  const baselineArchive = trustedFile(baselineBundle, 'baseline archive');
  const candidateArchive = trustedFile(candidateBundle, 'candidate archive');
  const packageFile = trustedFile(candidatePackage, 'candidate package');
  if (!oracleFile || !fs.existsSync(path.resolve(oracleFile))) {
    fail('independent strict-ancestor query oracle is required; refusing to synthesize queries');
  }
  const oraclePath = trustedFile(oracleFile, 'independent strict-ancestor query oracle');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-verification-inputs-'));
  try {
    const baselineExtracted = path.join(temp, 'baseline');
    const candidateExtracted = path.join(temp, 'candidate');
    try { await extractZip(baselineArchive, baselineExtracted); }
    catch (error) { fail(`baseline archive extraction failed: ${error.message}`); }
    try { await extractZip(candidateArchive, candidateExtracted); }
    catch (error) { fail(`candidate archive extraction failed: ${error.message}`); }
    const candidateTree = validateArchive(candidateExtracted);
    const candidateResult = validateCandidate({ root: candidateTree.root, bundleFile: candidateArchive, packageFile });
    const seed = candidateResult.coverage.corpusSeed;
    if (!['verified', 'observed'].includes(baselineMode)) fail('baseline mode must be verified or observed');
    const baselineProof = baselineMode === 'observed'
      ? observedBaselineFromTree({ extractedRoot: baselineExtracted, bundleFile: baselineArchive,
        expectedTag: seed.tag, expectedSha256: seed.archiveSha256, expectedBytes: seed.archiveBytes })
      : retrospectiveBaselineFromTree({ extractedRoot: baselineExtracted, bundleFile: baselineArchive,
        expectedTag: seed.tag, expectedSha256: seed.archiveSha256, expectedBytes: seed.archiveBytes });
    if (seed.archiveSha256 !== baselineProof.receipt.archive.sha256
      || seed.archiveBytes !== baselineProof.receipt.archive.bytes) {
      fail('baseline archive bytes differ from release coverage');
    }
    if (seed.receiptSha256 !== baselineProof.fileSha256) fail('baseline receipt differs from release coverage');
    if (seed.tag !== baselineProof.receipt.releaseTag) {
      fail('baseline release tag differs from release coverage');
    }
    const baselineStores = baselineProof.receipt.stores.map(({ name }) => name);
    const baseline = { schemaVersion: 1,
      kind: baselineMode === 'observed' ? 'ruvnet-brain-observed-failed-public-baseline' : 'ruvnet-brain-verified-public-baseline',
      ...(baselineMode === 'observed' ? { integrity: 'DEGRADED', historicalCorpusReceipt: false,
        candidateVerificationEligible: false, observationReceiptSha256: baselineProof.fileSha256,
        discrepancyDigest: baselineProof.receipt.discrepancyDigest,
        ledgerDiscrepancies: baselineProof.receipt.ledgerDiscrepancies,
        provenanceGaps: baselineProof.receipt.provenanceGaps } : {}), tag: seed.tag,
      archiveSha256: seed.archiveSha256, archiveBytes: seed.archiveBytes,
      archiveManifestSha256: baselineProof.receipt.archiveManifestSha256,
      ...(baselineMode === 'verified' ? { verificationReceiptSha256: baselineProof.fileSha256 } : {}),
      stores: baselineStores, storeCount: baselineStores.length };
    const { value: queryEvidence } = readJson(oraclePath, 'independent strict-ancestor query oracle');
    validateRetrievalQueryEvidence(queryEvidence);
    verifyQueryOracleSource(queryEvidence, candidateResult.candidate.sourceSha, { cwd: path.resolve(repo) });
    const plan = buildRetrievalCanaryPlan({ coverage: candidateResult.coverage, baseline,
      candidate: candidateResult.candidate, coverageIdentity: candidateResult.coverageIdentity,
      queryEvidence, assetsDir: candidateTree.root });
    writeExactOutputs(outDir, {
      [baselineMode === 'observed' ? 'baseline-observation-receipt.json' : 'baseline-verification-receipt.json']: baselineProof.bytes,
      'COVERAGE.json': candidateResult.coverageBytes,
      'retrieval-baseline.json': encoded(baseline),
      'retrieval-candidate.json': encoded(candidateResult.candidate),
      'retrieval-canary-plan.json': encoded(plan),
    });
    return { coverage: candidateResult.coverage, baseline, candidate: candidateResult.candidate, plan };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function arg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'baseline') {
    const result = await createRetrospectiveBaselineVerification({ baselineBundle: arg(argv, '--baseline-bundle'),
      expectedTag: arg(argv, '--expected-tag'), expectedSha256: arg(argv, '--expected-sha256'),
      expectedBytes: Number(arg(argv, '--expected-bytes')),
      outFile: arg(argv, '--out') || 'release-evidence/baseline-verification-receipt.json' });
    console.log(JSON.stringify({ ok: true, mode: 'baseline', releaseTag: result.receipt.releaseTag,
      stores: result.receipt.storeCount, receiptFileSha256: result.fileSha256 }));
    return result;
  }
  if (argv[0] === 'observe-baseline') {
    const result = await createObservedBaselineReceipt({ baselineBundle: arg(argv, '--baseline-bundle'),
      expectedTag: arg(argv, '--expected-tag'), expectedSha256: arg(argv, '--expected-sha256'),
      expectedBytes: Number(arg(argv, '--expected-bytes')),
      outFile: arg(argv, '--out') || 'release-evidence/baseline-observation-receipt.json' });
    console.log(JSON.stringify({ ok: true, mode: 'observe-baseline', releaseTag: result.receipt.releaseTag,
      stores: result.receipt.storeCount, discrepancies: result.receipt.ledgerDiscrepancies.length,
      provenanceGaps: result.receipt.provenanceGaps.length, receiptFileSha256: result.fileSha256 }));
    return result;
  }
  const result = await createPublicVerificationInputs({
    baselineBundle: arg(argv, '--baseline-bundle'),
    candidateBundle: arg(argv, '--candidate-bundle'),
    candidatePackage: arg(argv, '--candidate-package'),
    oracleFile: arg(argv, '--oracle'),
    repo: arg(argv, '--repo') || process.cwd(),
    outDir: arg(argv, '--out-dir') || 'release-evidence',
    baselineMode: argv.includes('--observed-baseline') ? 'observed' : 'verified',
  });
  console.log(JSON.stringify({ ok: true, sourceSha: result.candidate.sourceSha,
    coverageGeneration: result.coverage.releaseCoverageGeneration, cases: result.plan.cases.length }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
