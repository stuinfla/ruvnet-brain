import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createObservedBaselineReceipt } from '../../scripts/public-verification-inputs.mjs';
import { verifyBundle } from '../../scripts/verify-bundle.mjs';
import { attestAccuracyReport } from '../../scripts/oracle/retrieval-accuracy.mjs';
import { attestMeasurementReport } from '../../scripts/oracle/measurement-attestation.mjs';
import { archiveSourceCensus } from '../../scripts/oracle/source-census.mjs';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { accuracyReportFor, buildAssets, recallReportFor, seal, SOURCE_COMMIT } from '../helpers/corpus-seed-fixture.mjs';
import { augmentSourceCoverage } from '../helpers/oracle-source-census-fixture.mjs';
import { createCorpusReceipt } from '../../scripts/corpus-candidate.mjs';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function archiveFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-baseline-workflow-'));
  roots.push(root);
  const tree = path.join(root, 'tree');
  fs.mkdirSync(tree);
  const rvf = path.join(tree, 'alpha.big.rvf');
  fs.writeFileSync(rvf, 'real archive member bytes');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(rvf)).digest('hex');
  fs.writeFileSync(path.join(tree, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1, brainVersion: '1.0.0', releaseTag: 'bootstrap-fixture',
    stores: { alpha: { file: 'alpha.big.rvf', sha256: sha, bytes: fs.statSync(rvf).size,
      model: 'fixture', dimensions: 1, builtUtc: '2026-09-17T00:00:00.000Z' } },
  }));
  const archive = path.join(root, 'ruvnet-brain.zip');
  execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: tree });
  return { root, archive, sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), bytes: fs.statSync(archive).size };
}

describe('corpus-seed workflow baseline transfer', () => {
  it('executes the pinned bootstrap observation and binds its computed receipt digest', async () => {
    const f = archiveFixture();
    const out = path.join(f.root, 'baseline-observation-receipt.json');
    const result = await createObservedBaselineReceipt({ baselineBundle: f.archive,
      expectedTag: 'bootstrap-fixture', expectedSha256: f.sha256, expectedBytes: f.bytes, outFile: out });
    expect(result.receipt).toMatchObject({ kind: 'ruvnet-brain-observed-failed-public-baseline', integrity: 'DEGRADED', candidateVerificationEligible: false });
    expect(result.fileSha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
    await expect(createObservedBaselineReceipt({ baselineBundle: f.archive,
      expectedTag: 'bootstrap-fixture', expectedSha256: '0'.repeat(64), expectedBytes: f.bytes,
      outFile: path.join(f.root, 'wrong.json') })).rejects.toThrow(/archive SHA-256/i);
  });

  it('accepts the real detached signature and rejects changed signature bytes', () => {
    const f = archiveFixture();
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const signature = path.join(f.root, 'ruvnet-brain.zip.sig');
    fs.writeFileSync(signature, crypto.sign(null, Buffer.from(f.sha256, 'hex'), privateKey));
    const pub = path.join(f.root, 'public.pem');
    fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
    expect(verifyBundle(f.archive, signature, pub).ok).toBe(true);
    fs.writeFileSync(signature, Buffer.from('forged'));
    expect(verifyBundle(f.archive, signature, pub).ok).toBe(false);
  });
  it('executes the strict workflow verifier with receipt-bound source evidence and rejects tampering', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-baseline-strict-'));
    roots.push(root);
    const download = path.join(root, 'corpus-seed-download');
    fs.mkdirSync(download);
    const bundleRoot = await buildAssets(root);
    augmentSourceCoverage(bundleRoot);
    const sourceCensus = archiveSourceCensus(bundleRoot);
    const sourceBundle = seal(root, bundleRoot, { accuracy: null });
    const bundle = path.join(download, 'ruvnet-brain.zip');
    fs.copyFileSync(sourceBundle, bundle);
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const sourceEvidence = path.join(root, 'source-evidence.json');
    fs.writeFileSync(sourceEvidence, JSON.stringify({ alpha: { commit: SOURCE_COMMIT, U: 10 } }, null, 2));
    const sourceEvidenceSha256 = digest(JSON.parse(fs.readFileSync(sourceEvidence, 'utf8')));
    const accuracyReport = accuracyReportFor(bundle, {
      oracleSha256: 'b'.repeat(64), generatorSha256: 'e'.repeat(64),
      overrides: { qualification: { schemaVersion: 1, kind: 'ruvnet-brain-oracle-source-qualification',
        trustedProductionKeyId: 'f'.repeat(64), sourceEvidenceSha256,
        partitions: [{ id: 'alpha', store: 'alpha', repo: 'ruvnet/alpha', commit: SOURCE_COMMIT,
          inventoryDigest: '1'.repeat(64), labelsDigest: '2'.repeat(64), keyId: 'f'.repeat(64), U: 10, selectedUnits: 10 }] } },
    });
    accuracyReport.coverage.sourceCensus = sourceCensus;
    const accuracy = attestAccuracyReport(accuracyReport, privateKey);
    fs.writeFileSync(`${bundle}.accuracy.json`, `${JSON.stringify(accuracy, null, 2)}\n`);
    const recall = { ...recallReportFor(bundle), attestation: null };
    recall.attestation = attestMeasurementReport(recall, keys.privateKey);
    fs.writeFileSync(`${bundle}.recall.json`, `${JSON.stringify(recall, null, 2)}\n`);
    const receiptFile = path.join(download, 'corpus-receipt.json');
    const receipt = await createCorpusReceipt({ bundleFile: bundle, receiptFile,
      accuracyReportFile: `${bundle}.accuracy.json`, recallReportFile: `${bundle}.recall.json`,
      builderSourceSha: 'c'.repeat(40), trustedReportPublicKey: publicKey,
      expectedSourceEvidenceSha256: sourceEvidenceSha256,
      expectedOracleSha256: 'b'.repeat(64), expectedGeneratorSha256: 'e'.repeat(64) });
    const signing = crypto.generateKeyPairSync('ed25519');
    const signingPublic = path.join(root, 'signing.pub.pem');
    fs.writeFileSync(signingPublic, signing.publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(`${bundle}.sig`, crypto.sign(null, Buffer.from(sha256File(bundle), 'hex'), signing.privateKey));
    const env = { ...process.env, RUNNER_TEMP: root, RUVNET_MEASUREMENT_PUBLIC_KEY: publicKey,
      RUVNET_SIGNING_PUB: signingPublic, SEED_TAG: `corpus-sha256-${sha256File(bundle)}`,
      SEED_SHA256: sha256File(bundle), SEED_BYTES: String(fs.statSync(bundle).size),
      SEED_RECEIPT_SHA256: sha256File(receiptFile) };
    const script = workflowBaselineVerifier();
    expect(executeWorkflowVerifier(script, env)).toMatch(/baseline receipt and detached signature verified/);
    expect(() => executeWorkflowVerifier(script, { ...env, SEED_RECEIPT_SHA256: '0'.repeat(64) })).toThrow(/receipt file bytes differ|receipt sha256/i);
    fs.writeFileSync(`${bundle}.sig`, Buffer.from('forged signature'));
    expect(() => executeWorkflowVerifier(script, env)).toThrow(/detached signature rejected|signature/i);
  });

  it('executes the workflow observation command and binds its receipt to the downloaded archive', () => {
    const f = archiveFixture();
    const out = path.join(f.root, 'corpus-seed-download', 'baseline-observation-receipt.json');
    fs.mkdirSync(path.dirname(out));
    execFileSync(process.execPath, ['scripts/public-verification-inputs.mjs', 'observe-baseline',
      '--baseline-bundle', f.archive, '--expected-tag', 'bootstrap-fixture',
      '--expected-sha256', f.sha256, '--expected-bytes', String(f.bytes), '--out', out],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: f.root } });
    const receipt = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(receipt).toMatchObject({ kind: 'ruvnet-brain-observed-failed-public-baseline', integrity: 'DEGRADED', candidateVerificationEligible: false });
    expect(receipt.archive.sha256).toBe(f.sha256);
    expect(() => execFileSync(process.execPath, ['scripts/public-verification-inputs.mjs', 'observe-baseline',
      '--baseline-bundle', f.archive, '--expected-tag', 'bootstrap-fixture',
      '--expected-sha256', '0'.repeat(64), '--expected-bytes', String(f.bytes), '--out', path.join(f.root, 'wrong.json')],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: f.root } })).toThrow(/archive SHA-256/i);
  });

});

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function workflowBaselineVerifier() {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/corpus-seed.yml'), 'utf8');
  const blocks = [...workflow.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/g)];
  const block = blocks.find((match) => match[1].includes('verifySeedBaseline'));
  if (!block) throw new Error('corpus-seed workflow has no baseline verifier block');
  return block[1];
}

function executeWorkflowVerifier(script, env) {
  return execFileSync(process.execPath, ['--input-type=module', '-'], {
    cwd: process.cwd(), input: script, encoding: 'utf8', env,
  });
}
