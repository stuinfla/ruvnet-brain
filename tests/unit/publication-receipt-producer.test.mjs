import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REQUIRED_CHECKS } from '../../scripts/release-proof.mjs';
import { assertInstalledPayload, generatePublicationReceipt } from '../../scripts/publication-receipt.mjs';
import { createPayloadManifest, signPayloadManifest } from '../../scripts/release-payload.mjs';
import { getVersion } from '../../scripts/version.mjs';

const SHA = 'a'.repeat(40);
const VERSION = getVersion();
const BYTES = Buffer.from('one immutable public artifact');
const DIGEST = crypto.createHash('sha256').update(BYTES).digest('hex');

function candidate(root) {
  const evidence = path.join(root, 'release-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const artifactPath = path.join(evidence, `ruvnet-brain-${VERSION}.tgz`);
  fs.writeFileSync(artifactPath, BYTES);
  const bundlePath = path.join(evidence, 'ruvnet-brain.zip');
  fs.writeFileSync(bundlePath, 'one immutable public bundle');
  const manifest = createPayloadManifest({
    version: VERSION, tag: `v${VERSION}`, candidateSha: SHA, producer: { runId: 'test' },
    members: [
      { role: 'npm', name: path.basename(artifactPath), file: artifactPath },
      { role: 'bundle', name: path.basename(bundlePath), file: bundlePath },
    ],
  });
  const keys = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.join(root, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(root, 'keys', 'ruvnet-brain-signing.pub.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(path.join(evidence, 'payload-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(evidence, 'payload-manifest.sig'), signPayloadManifest(manifest, keys.privateKey));
  const receipt = {
    schemaVersion: 1, phase: 'candidate', sha: SHA, tree: 'b'.repeat(40), dirty: false,
    version: VERSION, tag: `v${VERSION}`,
    sourceVersions: { package: VERSION, claudePlugin: VERSION, codexPlugin: VERSION },
    artifact: {
      path: `release-evidence/ruvnet-brain-${VERSION}.tgz`, sha256: DIGEST, sourceSha: SHA,
      version: VERSION, bundle: { brainVersion: VERSION, releaseTag: `v${VERSION}` },
    },
    releaseVector: { verdict: 'PASS', sha: SHA, unknown: 0, skipped: 0 },
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
    coverage: { status: 'PASS', lines: 95, requiredLines: 80 },
    security: { status: 'PASS', critical: 0, high: 0 },
    issues: { open: [] },
    github: { sha: SHA, checks: REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })) },
    hosts: {
      claude: { status: 'PASS', version: VERSION, artifactSha256: DIGEST },
      codex: { status: 'PASS', version: VERSION, artifactSha256: DIGEST },
    },
    brain: { status: 'PASS', selfStore: true, citedSelfSource: true, narrowMs: 10, broadMs: 20, concurrentMs: 15, deadlineMs: 100 },
    qe: { status: 'PASS', total: 1, passed: 1, failed: 0, skipped: 0 },
    graders: [
      { id: 'a', independent: true, score: 95, sha: SHA, artifactSha256: DIGEST },
      { id: 'b', independent: true, score: 96, sha: SHA, artifactSha256: DIGEST },
    ],
  };
  const receiptPath = path.join(evidence, 'candidate-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  return { receiptPath, artifactPath };
}

function adapter(overrides = {}) {
  const write = (destination, bytes = BYTES) => { fs.writeFileSync(destination, bytes); return destination; };
  return {
    async downloadNpm({ destination }) { return { path: write(destination), version: VERSION, sha: SHA }; },
    async downloadGithub({ destination, assetName }) {
      const bytes = assetName.endsWith('.zip') ? Buffer.from('one immutable public bundle') : BYTES;
      return { path: write(destination, bytes), tag: `v${VERSION}`, sha: SHA };
    },
    async installHosts() {
      return {
        claudeOnly: { status: 'PASS', doctorExit: 0, version: VERSION, artifactSha256: DIGEST, functionalSearch: true, searchMs: 10 },
        codexOnly: { status: 'PASS', doctorExit: 0, version: VERSION, artifactSha256: DIGEST, functionalSearch: true, searchMs: 10 },
        dual: { status: 'PASS', doctorExit: 0, version: VERSION, artifactSha256: DIGEST, functionalSearch: true, searchMs: 10 },
        bundle: { brainVersion: VERSION, releaseTag: `v${VERSION}` },
      };
    },
    async probeBrain() { return { status: 'PASS', selfStore: true, broadMs: 40, deadlineMs: 100 }; },
    async probePublishedSurface() {
      return { name: 'published-surface-probe', status: 'completed', conclusion: 'success', sha: SHA };
    },
    ...overrides,
  };
}

async function run(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-receipt-'));
  const files = candidate(root);
  const outPath = path.join(root, 'release-evidence', 'publication-receipt.json');
  const result = await generatePublicationReceipt({
    root, candidatePath: files.receiptPath, outPath,
    adapter: adapter(overrides),
  });
  return { root, outPath, result };
}

describe('publication receipt producer', () => {
  it('requires installed host payload bytes to match every sealed plugin file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-payload-'));
    const sealed = path.join(root, 'sealed');
    const installed = path.join(root, 'installed');
    fs.mkdirSync(path.join(sealed, 'commands'), { recursive: true });
    fs.mkdirSync(path.join(installed, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(sealed, 'commands', 'rvbc.md'), 'sealed bytes');
    fs.writeFileSync(path.join(installed, 'commands', 'rvbc.md'), 'sealed bytes');
    expect(assertInstalledPayload(sealed, installed)).toBe(1);
    fs.writeFileSync(path.join(installed, 'commands', 'rvbc.md'), 'mutated bytes');
    expect(() => assertInstalledPayload(sealed, installed)).toThrow(/byte mismatch/);
  });

  it('writes one append-only receipt only after all public evidence matches the candidate', async () => {
    const { outPath, result } = await run();
    expect(result.verdict).toBe('PASS');
    const receipt = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(receipt).toMatchObject({
      schemaVersion: 2, phase: 'publication', sha: SHA, artifactSha256: DIGEST, version: VERSION,
      npm: { version: VERSION, sha: SHA, artifactSha256: DIGEST },
      githubRelease: { tag: `v${VERSION}`, sha: SHA, artifactSha256: DIGEST },
      installed: {
        claudeOnly: { status: 'PASS', doctorExit: 0, version: VERSION, artifactSha256: DIGEST },
        codexOnly: { status: 'PASS', doctorExit: 0, version: VERSION, artifactSha256: DIGEST },
        dual: { status: 'PASS', doctorExit: 0, version: VERSION, artifactSha256: DIGEST },
      },
    });
  });

  it('binds npm identity through exact sealed bytes when the registry omits gitHead', async () => {
    const { outPath } = await run({
      downloadNpm: async ({ destination }) => ({ path: (fs.writeFileSync(destination, BYTES), destination), version: VERSION, sha: null }),
    });
    expect(JSON.parse(fs.readFileSync(outPath, 'utf8')).npm.sha).toBe(SHA);
  });

  it.each([
    ['npm byte drift', { downloadNpm: async ({ destination }) => ({ path: (fs.writeFileSync(destination, 'wrong'), destination), version: VERSION, sha: SHA }) }],
    ['GitHub byte drift', { downloadGithub: async ({ destination }) => ({ path: (fs.writeFileSync(destination, 'wrong'), destination), tag: `v${VERSION}`, sha: SHA }) }],
    ['split npm SHA', { downloadNpm: async ({ destination }) => ({ path: (fs.writeFileSync(destination, BYTES), destination), version: VERSION, sha: 'c'.repeat(40) }) }],
    ['split GitHub SHA', { downloadGithub: async ({ destination }) => ({ path: (fs.writeFileSync(destination, BYTES), destination), tag: `v${VERSION}`, sha: 'c'.repeat(40) }) }],
    ['failed Claude-only install', { installHosts: async () => ({ claudeOnly: { status: 'FAIL', doctorExit: 1, version: VERSION, artifactSha256: DIGEST }, codexOnly: { status: 'PASS', doctorExit: 0, version: VERSION, artifactSha256: DIGEST }, dual: { status: 'PASS', doctorExit: 0, version: VERSION, artifactSha256: DIGEST }, bundle: { brainVersion: VERSION, releaseTag: `v${VERSION}` } }) }],
    ['missing self store', { probeBrain: async () => ({ status: 'PASS', selfStore: false, broadMs: 40, deadlineMs: 100 }) }],
    ['slow Brain', { probeBrain: async () => ({ status: 'PASS', selfStore: true, broadMs: 81, deadlineMs: 100 }) }],
    ['red surface probe', { probePublishedSurface: async () => ({ name: 'published-surface-probe', status: 'completed', conclusion: 'failure', sha: SHA }) }],
    ['probe SHA split', { probePublishedSurface: async () => ({ name: 'published-surface-probe', status: 'completed', conclusion: 'success', sha: 'd'.repeat(40) }) }],
  ])('fails closed and writes no receipt on %s', async (_name, overrides) => {
    await expect(run(overrides)).rejects.toThrow();
  });

  it('refuses to overwrite an existing publication receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-receipt-'));
    const files = candidate(root);
    const outPath = path.join(root, 'release-evidence', 'publication-receipt.json');
    fs.writeFileSync(outPath, 'immutable\n');
    await expect(generatePublicationReceipt({ root, candidatePath: files.receiptPath, outPath, adapter: adapter() }))
      .rejects.toThrow(/refus.*overwrite|already exists/i);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('immutable\n');
  });
});
