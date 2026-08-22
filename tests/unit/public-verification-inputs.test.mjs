import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  coverageGenerationFor,
  digest,
  releaseCoverageGenerationFor,
} from '../../scripts/coverage-integrity.mjs';
import { sealRetrievalQueryEvidence } from '../../scripts/retrieval-canary.mjs';
import {
  createPublicVerificationInputs,
  createObservedBaselineReceipt,
  createRetrospectiveBaselineVerification,
} from '../../scripts/public-verification-inputs.mjs';
import { validatePlanAgainstCoverage } from '../../scripts/retrieval-canary.mjs';
import { writeStoredZip } from '../helpers/zip-fixture.mjs';

const roots = [];
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileId = (file) => ({ file: path.basename(file), sha256: sha(fs.readFileSync(file)), bytes: fs.statSync(file).size });
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function filesUnder(root, prefix = '') {
  const rows = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (relative === 'ARCHIVE-MANIFEST.json') continue;
    if (entry.isDirectory()) rows.push(...filesUnder(root, relative));
    else if (entry.isFile()) {
      const file = path.join(root, relative);
      rows.push({ path: relative.split(path.sep).join('/'), sha256: sha(fs.readFileSync(file)), bytes: fs.statSync(file).size });
    }
  }
  return rows;
}

function sealDirectory(root, { version, releaseTag }) {
  const files = filesUnder(root);
  const manifest = { schemaVersion: 1, kind: 'ruvnet-brain-archive-manifest', version, releaseTag,
    fileCount: files.length, totalBytes: files.reduce((sum, row) => sum + row.bytes, 0), files };
  writeJson(path.join(root, 'ARCHIVE-MANIFEST.json'), manifest);
  return manifest;
}

function zipDirectory(root, archiveFile) {
  const manifestFile = path.join(root, 'ARCHIVE-MANIFEST.json');
  const rows = filesUnder(root).concat(fs.existsSync(manifestFile) ? [fileId(manifestFile)] : []);
  const entries = rows.map((row) => ({
    name: row.file === 'ARCHIVE-MANIFEST.json' ? row.file : row.path,
    data: fs.readFileSync(path.join(root, row.path || row.file)),
  }));
  writeStoredZip({ archiveFile, entries });
}

function retrospectiveProof(root, bundleFile, ledger) {
  const files = filesUnder(root);
  const archiveManifest = { schemaVersion: 1, kind: 'ruvnet-brain-retrospective-archive-manifest',
    fileCount: files.length, totalBytes: files.reduce((sum, row) => sum + row.bytes, 0), files };
  const stores = Object.keys(ledger.stores).sort().map((name) => {
    const row = ledger.stores[name];
    return { name, ...fileId(path.join(root, row.file)), model: row.model, dimensions: row.dimensions,
      sourceCommit: row.sourceCommit, builtUtc: row.builtUtc };
  });
  const payload = { schemaVersion: 1, kind: 'ruvnet-brain-retrospective-baseline-verification',
    verificationMode: 'retrospective-byte-verification', historicalCorpusReceipt: false,
    releaseTag: ledger.releaseTag, brainVersion: ledger.brainVersion, archive: fileId(bundleFile),
    archiveManifestSha256: digest(archiveManifest), generationLedger: fileId(path.join(root, 'RVF-GENERATIONS.json')),
    storeCount: stores.length, storeSetSha256: digest(stores.map(({ name }) => name)), stores,
    provenanceGaps: [],
    limitations: ['no historical corpus receipt was published with these bytes',
      'verification proves immutable archive, ledger, RVF bytes, and recorded provenance; it does not invent historical process evidence'] };
  const receipt = { ...payload, receiptSha256: digest(payload) };
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, bytes, fileSha256: sha(bytes), archiveManifest };
}

function generation(store, sourceCommit, file) {
  return { file: `${store}.big.rvf`, sha256: sha(fs.readFileSync(file)), bytes: fs.statSync(file).size,
    sourceCommit, builtUtc: '2026-08-22T00:00:00.000Z', model: 'fixture-model', dimensions: 8 };
}

function coverageRows(stores) {
  return stores.map((store) => ({ key: `repo:ruvnet/${store}`, kind: 'repository', name: store,
    url: `https://github.com/ruvnet/${store}`, disposition: 'eligible', status: 'CURRENT', reasons: [],
    upstream: { sha: 'b'.repeat(40) }, artifact: { store, rvfSha256: digest(`rvf:${store}`) } }));
}

function enumeration(count) {
  return { schemaVersion: 1, owner: 'ruvnet', observedAt: '2026-08-22T00:00:00.000Z', requestParameters: {},
    repositories: { expected: count, pages: [{ page: 1 }] }, gists: { expected: 0, pages: [] },
    duplicateKeys: 0, terminal: true };
}

function corpusCoverage(stores) {
  const rows = coverageRows(stores);
  const enumerationReceipt = enumeration(stores.length);
  const value = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', owner: 'ruvnet',
    observedAt: '2026-08-22T00:00:00.000Z', generatorSourceSha: '1'.repeat(64),
    sourceObservationSha256: '2'.repeat(64), snapshotRoot: '3'.repeat(64),
    policy: { policyDispositionDigests: [], exemptionDigests: [] }, enumerationReceipt, rows,
    totals: { repositories: stores.length, gists: 0, rows: stores.length, byStatus: { CURRENT: stores.length } } };
  value.coverageGeneration = coverageGenerationFor({ generatorSourceSha: value.generatorSourceSha,
    snapshotRoot: value.snapshotRoot, sourceObservationSha256: value.sourceObservationSha256, rows,
    enumerationReceipt, policyDispositionDigests: [], exemptionDigests: [] });
  return value;
}

function classPartition(root, stores) {
  const classes = path.join(root, 'public-store-classes.json');
  const evidenceFiles = [{ kind: 'class-registry', path: 'public-store-classes.json',
    sha256: sha(fs.readFileSync(classes)), bytes: fs.statSync(classes).size }];
  const ordered = [...stores].sort();
  return digest({ repositories: ordered, gistAggregate: null, derived: [], publicStores: ordered, evidenceFiles });
}

function writeStore(root, store) {
  const files = {
    rvf: `${store}.big.rvf`, idmap: `${store}.big.rvf.idmap.json`, embed: `${store}.big.rvf.embed.json`,
    passages: `${store}.passages.jsonl`, meta: `${store}.meta.json`,
  };
  fs.writeFileSync(path.join(root, files.rvf), `rvf:${store}`);
  writeJson(path.join(root, files.idmap), { store, ids: [1] });
  writeJson(path.join(root, files.embed), { store, dimensions: 8 });
  fs.writeFileSync(path.join(root, files.passages), `${JSON.stringify({ id: `${store}-1`, path: `src/${store}.mjs`,
    title: `${store} boundary`, text: `${store} owns a deterministic public runtime boundary whose exact source behavior is independently verified by this long fixture passage.` })}\n`);
  writeJson(path.join(root, files.meta), { store, chunks: 1 });
  return Object.values(files).map((name) => fileId(path.join(root, name)));
}

function makeGitOracle(root, stores) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'oracle@example.invalid');
  git(repo, 'config', 'user.name', 'Oracle Fixture');
  const queries = Object.fromEntries([...stores].sort().map((store) => {
    const query = `independently authored source behavior question for the ${store} public runtime boundary`;
    const sourceSha256 = digest(`query-source:${store}`);
    return [store, { query, sourceSha256, recordSha256: digest({ store, query, sourceSha256 }) }];
  }));
  const sourcePayload = { schemaVersion: 1, kind: 'ruvnet-brain-retrieval-query-evidence',
    queryStoreSetSha256: digest([...stores].sort()), queries };
  const sourcePath = 'data/retrieval-query-evidence.json';
  writeJson(path.join(repo, sourcePath), sourcePayload);
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'independent query oracle');
  const sourceCommit = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'candidate.txt'), 'candidate\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'candidate');
  const candidateSha = git(repo, 'rev-parse', 'HEAD');
  return { repo, candidateSha, evidence: sealRetrievalQueryEvidence({ ...sourcePayload, sourceCommit, sourcePath }) };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-verification-inputs-'));
  roots.push(root);
  const { repo, candidateSha, evidence } = makeGitOracle(root, ['new', 'old']);

  const baselineRoot = path.join(root, 'baseline');
  fs.mkdirSync(baselineRoot);
  writeJson(path.join(baselineRoot, 'PRIVATE-STORES.json'), { schemaVersion: 1, privateStores: [] });
  writeJson(path.join(baselineRoot, 'public-store-classes.json'), { schemaVersion: 1, derived: [] });
  writeStore(baselineRoot, 'old');
  const oldRvf = path.join(baselineRoot, 'old.big.rvf');
  const baselineLedger = { schemaVersion: 1, brainVersion: '4.2.1-dev', releaseTag: 'v4.2.1-dev',
    stores: { old: generation('old', 'd'.repeat(40), oldRvf) } };
  writeJson(path.join(baselineRoot, 'RVF-GENERATIONS.json'), baselineLedger);
  const corpus = corpusCoverage(['old']);
  writeJson(path.join(baselineRoot, 'CORPUS-COVERAGE.json'), corpus);
  const baselineBundle = path.join(root, 'baseline.zip');
  zipDirectory(baselineRoot, baselineBundle);
  const baselineProof = retrospectiveProof(baselineRoot, baselineBundle, baselineLedger);

  const candidateRoot = path.join(root, 'candidate');
  fs.mkdirSync(candidateRoot);
  writeJson(path.join(candidateRoot, 'PRIVATE-STORES.json'), { schemaVersion: 1, privateStores: [] });
  writeJson(path.join(candidateRoot, 'public-store-classes.json'), { schemaVersion: 1, derived: [] });
  for (const store of ['new', 'old']) writeStore(candidateRoot, store);
  const publicLedger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger', brainVersion: '9.9.9',
    releaseTag: 'v9.9.9', sourceSnapshot: candidateSha,
    stores: Object.fromEntries(['new', 'old'].map((store) => [store,
      generation(store, candidateSha, path.join(candidateRoot, `${store}.big.rvf`))])) };
  const publicLedgerFile = path.join(candidateRoot, 'PUBLIC-RVF-GENERATIONS.json');
  writeJson(publicLedgerFile, publicLedger);
  const rows = coverageRows(['new', 'old']);
  const enumerationReceipt = enumeration(2);
  const coverage = { schemaVersion: 1, kind: 'ruvnet-brain-release-coverage', owner: 'ruvnet',
    observedAt: '2026-08-22T00:00:00.000Z', generatorSourceSha: '4'.repeat(64),
    sourceObservationSha256: '5'.repeat(64), snapshotRoot: '6'.repeat(64),
    releaseIdentity: { version: '9.9.9', tag: 'v9.9.9', sourceSnapshot: candidateSha },
    corpusSeed: { tag: 'v4.2.1-dev', archiveSha256: fileId(baselineBundle).sha256,
      archiveBytes: fileId(baselineBundle).bytes, receiptSha256: baselineProof.fileSha256 },
    corpusCoverage: { sha256: fileId(path.join(baselineRoot, 'CORPUS-COVERAGE.json')).sha256,
      coverageGeneration: corpus.coverageGeneration },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: fileId(publicLedgerFile).sha256,
      bytes: fileId(publicLedgerFile).bytes, storeCount: 2 },
    publicInventoryPartitionSha256: classPartition(candidateRoot, ['new', 'old']), installedProjectionSchema: 2,
    policy: { policyDispositionDigests: [], exemptionDigests: [] }, enumerationReceipt, rows,
    totals: { repositories: 2, gists: 0, rows: 2, byStatus: { CURRENT: 2 } } };
  coverage.releaseCoverageGeneration = releaseCoverageGenerationFor(coverage);
  writeJson(path.join(candidateRoot, 'COVERAGE.json'), coverage);
  writeJson(path.join(candidateRoot, 'CORPUS-COVERAGE.json'), corpus);
  sealDirectory(candidateRoot, { version: '9.9.9', releaseTag: 'v9.9.9' });
  const candidateBundle = path.join(root, 'candidate.zip');
  zipDirectory(candidateRoot, candidateBundle);
  const candidatePackage = path.join(root, 'ruvnet-brain-9.9.9.tgz');
  fs.writeFileSync(candidatePackage, 'sealed package bytes\n');
  const oracleFile = path.join(root, 'retrieval-query-evidence.json');
  writeJson(oracleFile, evidence);
  return { root, repo, coverage, baselineProof, baselineBundle, baselineRoot, baselineLedger,
    candidateRoot, candidateBundle, candidatePackage, oracleFile, outDir: path.join(root, 'release-evidence') };
}

function resealCandidate(f) {
  f.coverage.releaseCoverageGeneration = releaseCoverageGenerationFor(f.coverage);
  writeJson(path.join(f.candidateRoot, 'COVERAGE.json'), f.coverage);
  fs.rmSync(path.join(f.candidateRoot, 'ARCHIVE-MANIFEST.json'));
  sealDirectory(f.candidateRoot, { version: '9.9.9', releaseTag: 'v9.9.9' });
  zipDirectory(f.candidateRoot, f.candidateBundle);
}

async function observedFixture() {
  const f = fixture();
  f.baselineLedger.stores.old.sha256 = '0'.repeat(64);
  f.baselineLedger.stores.old.sourceCommit = null;
  writeJson(path.join(f.baselineRoot, 'RVF-GENERATIONS.json'), f.baselineLedger);
  zipDirectory(f.baselineRoot, f.baselineBundle);
  const observation = await createObservedBaselineReceipt({ baselineBundle: f.baselineBundle,
    outFile: path.join(f.root, 'seed-observation.json'), expectedTag: 'v4.2.1-dev',
    expectedSha256: fileId(f.baselineBundle).sha256, expectedBytes: fileId(f.baselineBundle).bytes });
  f.coverage.corpusSeed = { tag: 'v4.2.1-dev', archiveSha256: fileId(f.baselineBundle).sha256,
    archiveBytes: fileId(f.baselineBundle).bytes, receiptSha256: observation.fileSha256 };
  resealCandidate(f);
  return { f, observation };
}

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('public verification input producer', () => {
  it('creates an explicitly retrospective byte receipt without inventing a historical corpus receipt', async () => {
    const f = fixture();
    const outFile = path.join(f.root, 'retrospective-baseline.json');
    const result = await createRetrospectiveBaselineVerification({ baselineBundle: f.baselineBundle, outFile,
      expectedTag: 'v4.2.1-dev', expectedSha256: fileId(f.baselineBundle).sha256,
      expectedBytes: fileId(f.baselineBundle).bytes });
    expect(result.receipt).toMatchObject({ kind: 'ruvnet-brain-retrospective-baseline-verification',
      historicalCorpusReceipt: false, releaseTag: 'v4.2.1-dev', storeCount: 1, stores: [{ name: 'old' }] });
    expect(result.receipt.limitations).toContain('no historical corpus receipt was published with these bytes');
    expect(result.fileSha256).toBe(fileId(outFile).sha256);
  });

  it.each([
    ['tag', { expectedTag: 'v9.9.9' }, /expected public release tag/i],
    ['SHA-256', { expectedSha256: '0'.repeat(64) }, /expected public archive SHA-256/i],
    ['byte length', { expectedBytes: 1 }, /expected public archive byte length/i],
  ])('rejects a retrospective baseline with the wrong external %s identity', async (_label, override, message) => {
    const f = fixture();
    await expect(createRetrospectiveBaselineVerification({ baselineBundle: f.baselineBundle,
      outFile: path.join(f.root, 'wrong.json'), expectedTag: 'v4.2.1-dev',
      expectedSha256: fileId(f.baselineBundle).sha256, expectedBytes: fileId(f.baselineBundle).bytes,
      ...override })).rejects.toThrow(message);
  });

  it.each([
    ['ledger RVF hash mismatch', (f) => { f.baselineLedger.stores.old.sha256 = '0'.repeat(64);
      writeJson(path.join(f.baselineRoot, 'RVF-GENERATIONS.json'), f.baselineLedger); }, /generation record/i],
    ['unexpected RVF', (f) => { fs.writeFileSync(path.join(f.baselineRoot, 'rogue.big.rvf'), 'rogue'); }, /RVF set/i],
  ])('rejects a retrospective baseline with %s', async (_label, mutate, message) => {
    const f = fixture(); mutate(f); zipDirectory(f.baselineRoot, f.baselineBundle);
    await expect(createRetrospectiveBaselineVerification({ baselineBundle: f.baselineBundle,
      outFile: path.join(f.root, 'invalid.json'), expectedTag: 'v4.2.1-dev',
      expectedSha256: fileId(f.baselineBundle).sha256,
      expectedBytes: fileId(f.baselineBundle).bytes })).rejects.toThrow(message);
  });

  it('preserves a null historical source commit as an explicit provenance gap', async () => {
    const f = fixture();
    f.baselineLedger.stores.old.sourceCommit = null;
    writeJson(path.join(f.baselineRoot, 'RVF-GENERATIONS.json'), f.baselineLedger);
    zipDirectory(f.baselineRoot, f.baselineBundle);
    const result = await createRetrospectiveBaselineVerification({ baselineBundle: f.baselineBundle,
      outFile: path.join(f.root, 'null-provenance.json'), expectedTag: 'v4.2.1-dev',
      expectedSha256: fileId(f.baselineBundle).sha256, expectedBytes: fileId(f.baselineBundle).bytes });
    expect(result.receipt.provenanceGaps).toEqual(['old']);
    expect(result.receipt.stores[0].sourceCommit).toBeNull();
    expect(result.receipt.limitations.join(' ')).toMatch(/null sourceCommit/i);
  });

  it('records a degraded observation of contradictory public bytes without making it verification-eligible', async () => {
    const f = fixture();
    f.baselineLedger.stores.old.sha256 = '0'.repeat(64);
    f.baselineLedger.stores.old.bytes = 1;
    f.baselineLedger.stores.old.sourceCommit = null;
    writeJson(path.join(f.baselineRoot, 'RVF-GENERATIONS.json'), f.baselineLedger);
    zipDirectory(f.baselineRoot, f.baselineBundle);
    const result = await createObservedBaselineReceipt({ baselineBundle: f.baselineBundle,
      outFile: path.join(f.root, 'observed.json'), expectedTag: 'v4.2.1-dev',
      expectedSha256: fileId(f.baselineBundle).sha256, expectedBytes: fileId(f.baselineBundle).bytes });
    expect(result.receipt).toMatchObject({ kind: 'ruvnet-brain-observed-failed-public-baseline',
      integrity: 'DEGRADED', historicalCorpusReceipt: false, candidateVerificationEligible: false,
      storeCount: 1, provenanceGaps: ['old'] });
    expect(result.receipt.ledgerDiscrepancies).toHaveLength(1);
    expect(result.receipt.ledgerDiscrepancies[0]).toMatchObject({ store: 'old', type: 'byte-identity-mismatch' });
    expect(result.receipt.discrepancyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes observation identity when contradictory bytes are repaired and repacked', async () => {
    const f = fixture();
    f.baselineLedger.stores.old.sha256 = '0'.repeat(64);
    writeJson(path.join(f.baselineRoot, 'RVF-GENERATIONS.json'), f.baselineLedger);
    zipDirectory(f.baselineRoot, f.baselineBundle);
    const first = await createObservedBaselineReceipt({ baselineBundle: f.baselineBundle,
      outFile: path.join(f.root, 'observed-before.json'), expectedTag: 'v4.2.1-dev',
      expectedSha256: fileId(f.baselineBundle).sha256, expectedBytes: fileId(f.baselineBundle).bytes });
    f.baselineLedger.stores.old = generation('old', 'd'.repeat(40), path.join(f.baselineRoot, 'old.big.rvf'));
    writeJson(path.join(f.baselineRoot, 'RVF-GENERATIONS.json'), f.baselineLedger);
    zipDirectory(f.baselineRoot, f.baselineBundle);
    const repaired = await createObservedBaselineReceipt({ baselineBundle: f.baselineBundle,
      outFile: path.join(f.root, 'observed-after.json'), expectedTag: 'v4.2.1-dev',
      expectedSha256: fileId(f.baselineBundle).sha256, expectedBytes: fileId(f.baselineBundle).bytes });
    expect(repaired.fileSha256).not.toBe(first.fileSha256);
    expect(repaired.receipt.archiveManifestSha256).not.toBe(first.receipt.archiveManifestSha256);
    expect(repaired.receipt.discrepancyDigest).not.toBe(first.receipt.discrepancyDigest);
  });

  it('binds an observed denominator into the retrieval plan but cannot satisfy candidate verification', async () => {
    const { f, observation } = await observedFixture();
    const result = await createPublicVerificationInputs({ ...f, baselineMode: 'observed' });
    expect(result.plan.baseline).toMatchObject({ integrity: 'DEGRADED', candidateVerificationEligible: false,
      discrepancyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      observationReceiptSha256: observation.fileSha256 });
    expect(() => validatePlanAgainstCoverage(result.plan, result.coverage)).toThrow(/not candidate-verification eligible/i);
    expect(validatePlanAgainstCoverage(result.plan, result.coverage, { allowObservedBaseline: true })).toBe(result.plan);
  });

  it('rejects release coverage bound to the wrong degraded observation receipt', async () => {
    const { f } = await observedFixture();
    f.coverage.corpusSeed.receiptSha256 = 'f'.repeat(64);
    resealCandidate(f);
    await expect(createPublicVerificationInputs({ ...f, baselineMode: 'observed' }))
      .rejects.toThrow(/baseline receipt differs from release coverage/i);
  });

  it('derives exact coverage, verified baseline, candidate identity, and strict-ancestor plan from artifact bytes', async () => {
    const f = fixture();
    const result = await createPublicVerificationInputs(f);
    expect(fs.readFileSync(path.join(f.outDir, 'COVERAGE.json')))
      .toEqual(fs.readFileSync(path.join(f.candidateRoot, 'COVERAGE.json')));
    expect(result.baseline).toMatchObject({ tag: f.coverage.corpusSeed.tag, stores: ['old'], storeCount: 1,
      archiveManifestSha256: f.baselineProof.receipt.archiveManifestSha256 });
    expect(result.candidate).toMatchObject({ sourceSha: f.coverage.releaseIdentity.sourceSnapshot,
      packageSha256: fileId(f.candidatePackage).sha256, archiveSha256: fileId(f.candidateBundle).sha256,
      publicStoreCount: 2 });
    expect(result.plan.denominator).toMatchObject({ deltaStores: ['new'], legacyPopulationStores: ['old'] });
    expect(result.plan.oracle.sourceCommit).not.toBe(result.candidate.sourceSha);
    expect(fs.readdirSync(f.outDir).sort()).toEqual([
      'COVERAGE.json', 'baseline-verification-receipt.json', 'retrieval-baseline.json',
      'retrieval-canary-plan.json', 'retrieval-candidate.json',
    ]);
  });

  it('refuses to synthesize a missing independent query oracle and writes no partial evidence', async () => {
    const f = fixture();
    fs.rmSync(f.oracleFile);
    await expect(createPublicVerificationInputs(f)).rejects.toThrow(/independent strict-ancestor query oracle is required.*refusing to synthesize/i);
    expect(fs.existsSync(f.outDir)).toBe(false);
  });

  it('rejects baseline archive bytes that differ from the release coverage identity', async () => {
    const f = fixture();
    fs.appendFileSync(f.baselineBundle, '\n');
    await expect(createPublicVerificationInputs(f)).rejects.toThrow(/expected public archive SHA-256/i);
    expect(fs.existsSync(f.outDir)).toBe(false);
  });

  it('rejects a candidate archive whose embedded corpus coverage breaks the release coverage link', async () => {
    const f = fixture();
    writeJson(path.join(f.candidateRoot, 'CORPUS-COVERAGE.json'), { schemaVersion: 1, kind: 'forged' });
    fs.rmSync(path.join(f.candidateRoot, 'ARCHIVE-MANIFEST.json'));
    sealDirectory(f.candidateRoot, { version: '9.9.9', releaseTag: 'v9.9.9' });
    zipDirectory(f.candidateRoot, f.candidateBundle);
    await expect(createPublicVerificationInputs(f)).rejects.toThrow(/candidate corpus coverage|coverage link/i);
    expect(fs.existsSync(f.outDir)).toBe(false);
  });

  it('rejects a self-authored oracle even when its internal digest is resealed', async () => {
    const f = fixture();
    const candidateSha = f.coverage.releaseIdentity.sourceSnapshot;
    const evidence = JSON.parse(fs.readFileSync(f.oracleFile, 'utf8'));
    writeJson(f.oracleFile, sealRetrievalQueryEvidence({ ...evidence, sourceCommit: candidateSha }));
    await expect(createPublicVerificationInputs(f)).rejects.toThrow(/query oracle source identity|strict candidate ancestor/i);
    expect(fs.existsSync(f.outDir)).toBe(false);
  });

  it('never overwrites divergent pre-existing evidence or writes the remaining outputs', async () => {
    const f = fixture();
    fs.mkdirSync(f.outDir);
    fs.writeFileSync(path.join(f.outDir, 'retrieval-candidate.json'), 'attacker bytes\n');
    await expect(createPublicVerificationInputs(f)).rejects.toThrow(/existing retrieval-candidate\.json differs/i);
    expect(fs.readFileSync(path.join(f.outDir, 'retrieval-candidate.json'), 'utf8')).toBe('attacker bytes\n');
    expect(fs.readdirSync(f.outDir)).toEqual(['retrieval-candidate.json']);
  });
});
