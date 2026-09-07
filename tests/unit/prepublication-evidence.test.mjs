import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrepublicationEvidence } from '../../scripts/prepublication-evidence.mjs';
import { getVersion } from '../../scripts/version.mjs';

const sha = 'a'.repeat(40);
const version = getVersion();
const runId = 438;
let dir;

const write = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepublication-evidence-'));
  const manifestFile = write('manifest.json', { candidateSha: sha, version, tag: `v${version}`, members: [
    { role: 'npm', sha256: candidate.artifactSha256, size: 100 }, { role: 'bundle', sha256: candidate.candidateArchiveSha256, size: 200 },
  ] });
  const planFile = write('plan.json', candidate.plan);
  const coverageFile = path.join(dir, 'COVERAGE.json'); fs.writeFileSync(coverageFile, candidate.coverageBytes);
  const payloadId = payloadIdFor(JSON.parse(fs.readFileSync(manifestFile)));
  const payloadProofFile = write('payload.json', { payloadId });
  const artifactSha256 = 'c'.repeat(64);
  const hostNames = ['claude-only', 'codex-only', 'dual-host'];
  const grounding = { repo: 'ruvnet-brain', path: 'README.md', file: 'concepts.passages.jsonl', storedPath: 'README.md' };
  const hostFile = write('hosts.json', {
    schemaVersion: 1, sha, payloadId, artifactSha256,
    leaves: hostNames.map((name) => ({
      name, sha, payloadId, status: 'completed', conclusion: 'success', verdict: 'PASS',
      source: 'candidate-host-evidence', functionalSearch: true, searchExit: 0, grounding, artifactSha256, retrieval,
    })),
  });
  const runtimeCensusFile = write('runtime-census.json', {
    schemaVersion: 1, kind: 'ruvnet-brain-runtime-census-evidence', sourceSha: sha, version, runId,
    payloadId, payloadManifestSha256: digest(manifestFile),
    result: { status: 'PASS', diagnostic: false, qualification: 'staged-candidate', provenance: {
      projectionVerified: true, candidate: { sourceSha: sha, version, coverageSha256: digest(coverageFile) },
      artifacts: { payloadId, claimSourceSha: sha, packageSha256: candidate.artifactSha256,
        bundleSha256: candidate.candidateArchiveSha256, sidecarsVerified: 1, surfacesVerified: 1 },
    } },
  });
  const ciFile = write('ci.json', {
    schemaVersion: 1, kind: 'ruvnet-brain-candidate-ci-evidence', sourceSha: sha, version, payloadId,
    payloadManifestSha256: digest(manifestFile), workflow: 'ci', runId, runAttempt: 1,
    acceptanceReceipts: ['linux', 'macos', 'windows'].map(platform => ({ platform, sourceSha: sha, passed: 12, receiptSha256: 'c'.repeat(64) })),
    jobs: ['candidate-preflight', 'release-acceptance-linux', 'release-acceptance-windows', 'release-acceptance-macos', 'release-qe']
      .map((name) => ({ name, conclusion: 'success' })),
    verdict: 'PASS', skipped: 0, unknown: 0,
  });
  const integrationFile = write('integration.json', {
    schemaVersion: 1, kind: 'ruvnet-brain-integration-evidence', sourceSha: sha,
    workflow: 'integration-linux', runId, runAttempt: 1, total: 12, passed: 12,
    failed: 0, skipped: 0, skippedTests: [], todo: 0, todoTests: [],
    exclusionPolicy: 'reviewed-release-integration-v1', qualificationReceiptSha256: 'b'.repeat(64), exclusionsSha256: 'a'.repeat(64), verdict: 'PASS',
  });
  const uxFiles = ['darwin', 'linux', 'win32'].map((platform) => write(`ux-${platform}.json`, {
    schemaVersion: 1, suite: 'ruvnet-brain-ux-qe', gitSha: sha, platform,
    hardFailures: [], pass: true,
  }));
  const strangerFile = write('stranger.json', {
    schemaVersion: 1, sha, payloadId, sourceCiRunId: String(runId), strangerRunId: String(runId),
    verdict: 'PASS', jobs: ['ubuntu', 'macos', 'windows-gitbash', 'windows-powershell', 'hostile'],
  });
  return { sha, version, runId, manifestFile, payloadProofFile, hostFile, runtimeCensusFile, ciFile, integrationFile, uxFiles, strangerFile, planFile, coverageFile };
}

afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe('prepublication evidence', () => {
  it('builds the release envelope only from exact same-run typed receipts', () => {
    const result = buildPrepublicationEvidence(fixture());
    expect(result.envelope.verdict).toBe('PASS');
    expect(result.leaves).toHaveLength(10);
    expect(result.leaves.every((leaf) => /^[a-f0-9]{64}$/.test(leaf.receiptSha256))).toBe(true);
  });

  it('requires a runtime census receipt', () => {
    const f = fixture(); fs.unlinkSync(f.runtimeCensusFile);
    expect(() => buildPrepublicationEvidence(f)).toThrow();
  });

  it.each([
    ['different run', (r) => { r.runId += 1; }],
    ['different source', (r) => { r.sourceSha = 'b'.repeat(40); }],
    ['different payload', (r) => { r.payloadId = 'b'.repeat(64); }],
    ['diagnostic only', (r) => { r.result.diagnostic = true; }],
    ['unknown census', (r) => { r.result.status = 'SKIP'; }],
    ['unbound census', (r) => { delete r.result.provenance.artifacts; }],
    ['different bundle', (r) => { r.result.provenance.artifacts.bundleSha256 = 'b'.repeat(64); }],
    ['different coverage', (r) => { r.result.provenance.candidate.coverageSha256 = 'b'.repeat(64); }],
  ])('rejects runtime census: %s', (_name, mutate) => {
    const f = fixture(); const receipt = JSON.parse(fs.readFileSync(f.runtimeCensusFile));
    mutate(receipt); fs.writeFileSync(f.runtimeCensusFile, JSON.stringify(receipt));
    expect(() => buildPrepublicationEvidence(f)).toThrow(/runtime census receipt/);
  });

  it('rejects a successful receipt imported from another run', () => {
    const f = fixture();
    const receipt = JSON.parse(fs.readFileSync(f.ciFile));
    receipt.runId += 1;
    fs.writeFileSync(f.ciFile, JSON.stringify(receipt));
    expect(() => buildPrepublicationEvidence(f)).toThrow(/candidate CI receipt identity/);
  });

  it('rejects a green integration wrapper with unaccounted tests', () => {
    const f = fixture();
    const receipt = JSON.parse(fs.readFileSync(f.integrationFile));
    receipt.passed -= 1;
    receipt.skipped = 1;
    fs.writeFileSync(f.integrationFile, JSON.stringify(receipt));
    expect(() => buildPrepublicationEvidence(f)).toThrow(/fully accounted PASS/);
  });

  it('rejects integration exclusions without the governed policy receipt', () => {
    const f = fixture();
    const receipt = JSON.parse(fs.readFileSync(f.integrationFile));
    delete receipt.exclusionPolicy;
    fs.writeFileSync(f.integrationFile, JSON.stringify(receipt));
    expect(() => buildPrepublicationEvidence(f)).toThrow(/exclusions are not governed/);
  });

  it('rejects candidate host evidence that claims success without source-bound grounding', () => {
    const f = fixture();
    const receipt = JSON.parse(fs.readFileSync(f.hostFile));
    delete receipt.leaves[0].grounding;
    fs.writeFileSync(f.hostFile, JSON.stringify(receipt));
    expect(() => buildPrepublicationEvidence(f)).toThrow(/candidate host leaf is not an exact PASS/);
  });
});
import { candidateRetrievalFixture } from '../fixtures/candidate-retrieval-fixture.mjs';
import { runRetrievalCanaries } from '../../scripts/retrieval-canary.mjs';
import { payloadIdFor } from '../../scripts/release-payload.mjs';
const candidate = candidateRetrievalFixture({ version, packageSha256: 'c'.repeat(64) });
const retrieval = await runRetrievalCanaries({ ...candidate,
  search: async ({ query }) => [candidate.plan.cases.find((c) => c.query === query).expected],
  citationResolver: async (_matched, expected) => ({ resolved: true,
    evidence: { passageSha256: expected.passageSha256, passageFileSha256: 'd'.repeat(64) } }),
});
  it.each(['missing', 'skipped', 'unknown', 'citation', 'source', 'artifact', 'plan'])('rejects %s canary evidence behind a green host wrapper', (mutant) => {
    const f = fixture(); const host = JSON.parse(fs.readFileSync(f.hostFile));
    const receipt = host.leaves[0].retrieval;
    if (mutant === 'missing') delete host.leaves[0].retrieval;
    if (mutant === 'skipped') receipt.cases[0].status = 'SKIPPED';
    if (mutant === 'unknown') receipt.cases[0].status = 'UNKNOWN';
    if (mutant === 'citation') receipt.cases[0].citation = null;
    if (mutant === 'source') receipt.sourceSha = 'e'.repeat(40);
    if (mutant === 'artifact') receipt.artifactSha256 = 'e'.repeat(64);
    if (mutant === 'plan') receipt.planSha256 = 'e'.repeat(64);
    fs.writeFileSync(f.hostFile, JSON.stringify(host));
    expect(() => buildPrepublicationEvidence(f)).toThrow();
  });
  it('rejects missing plan even with a green host receipt', () => {
    const f = fixture(); delete f.planFile;
    expect(() => buildPrepublicationEvidence(f)).toThrow(/sealed plan/);
  });
