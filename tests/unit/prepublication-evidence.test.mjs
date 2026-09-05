import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrepublicationEvidence } from '../../scripts/prepublication-evidence.mjs';
import { getVersion } from '../../scripts/version.mjs';

const sha = 'a'.repeat(40);
const payloadId = 'b'.repeat(64);
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
  const manifestFile = write('manifest.json', { candidateSha: sha, version, tag: `v${version}` });
  const payloadProofFile = write('payload.json', { payloadId });
  const artifactSha256 = 'c'.repeat(64);
  const hostNames = ['claude-only', 'codex-only', 'dual-host'];
  const grounding = { repo: 'ruvnet-brain', path: 'README.md', file: 'concepts.passages.jsonl', storedPath: 'README.md' };
  const hostFile = write('hosts.json', {
    schemaVersion: 1, sha, payloadId, artifactSha256,
    leaves: hostNames.map((name) => ({
      name, sha, payloadId, status: 'completed', conclusion: 'success', verdict: 'PASS',
      source: 'candidate-host-evidence', functionalSearch: true, searchExit: 0, grounding, artifactSha256,
    })),
  });
  const ciFile = write('ci.json', {
    schemaVersion: 1, kind: 'ruvnet-brain-candidate-ci-evidence', sourceSha: sha, version, payloadId,
    payloadManifestSha256: digest(manifestFile), workflow: 'ci', runId, runAttempt: 1,
    jobs: ['candidate-preflight', 'check', 'windows-unit', 'warm-brain', 'release-qe']
      .map((name) => ({ name, conclusion: 'success' })),
    verdict: 'PASS', skipped: 0, unknown: 0,
  });
  const integrationFile = write('integration.json', {
    schemaVersion: 1, kind: 'ruvnet-brain-integration-evidence', sourceSha: sha,
    workflow: 'integration-linux', runId, runAttempt: 1, total: 12, passed: 12,
    failed: 0, skipped: 0, skippedTests: [], todo: 0, todoTests: [],
    exclusionPolicy: 'release-linux-v1', exclusionsSha256: 'a'.repeat(64), verdict: 'PASS',
  });
  const uxFiles = ['darwin', 'linux', 'win32'].map((platform) => write(`ux-${platform}.json`, {
    schemaVersion: 1, suite: 'ruvnet-brain-ux-qe', gitSha: sha, platform,
    hardFailures: [], pass: true,
  }));
  const strangerFile = write('stranger.json', {
    schemaVersion: 1, sha, payloadId, sourceCiRunId: String(runId), strangerRunId: String(runId),
    verdict: 'PASS', jobs: ['ubuntu', 'macos', 'windows-gitbash', 'windows-powershell', 'hostile'],
  });
  return { sha, version, runId, manifestFile, payloadProofFile, hostFile, ciFile, integrationFile, uxFiles, strangerFile };
}

afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

describe('prepublication evidence', () => {
  it('builds the release envelope only from exact same-run typed receipts', () => {
    const result = buildPrepublicationEvidence(fixture());
    expect(result.envelope.verdict).toBe('PASS');
    expect(result.leaves).toHaveLength(10);
    expect(result.leaves.every((leaf) => /^[a-f0-9]{64}$/.test(leaf.receiptSha256))).toBe(true);
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
