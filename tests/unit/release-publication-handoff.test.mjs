import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  materializePublicationHandoff,
  resolvePublicationHandoffPaths,
  validatePublicationHandoff,
} from '../../scripts/release-publication-handoff.mjs';
import { signReceipt, transactionIdFor } from '../../scripts/release-transaction.mjs';

const identity = () => ({
  repository: 'stuinfla/ruvnet-brain',
  package: 'ruvnet-brain',
  version: '9.8.7',
  tag: 'v9.8.7',
  candidateSha: 'a'.repeat(40),
  payloadId: 'b'.repeat(64),
  evidenceDigest: 'c'.repeat(64),
  packageIntegrity: 'sha512-fixture',
  packageSha256: 'd'.repeat(64),
  packageAssetName: 'ruvnet-brain-9.8.7.tgz',
  bundleSha256: 'e'.repeat(64),
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-handoff-'));
  fs.mkdirSync(path.join(root, 'release-evidence'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const releaseIdentity = identity();
  const receipt = signReceipt({
    schemaVersion: 3,
    transactionId: transactionIdFor(releaseIdentity),
    sequence: 13,
    state: 'channels-converged',
    previousReceiptDigest: 'f'.repeat(64),
    identity: releaseIdentity,
    observation: { verdict: 'PUBLISHED_NOT_VERIFIED' },
  }, keys.privateKey);
  const paths = resolvePublicationHandoffPaths({
    root,
    identityPath: 'release-evidence/release-identity.json',
    receiptPath: 'release-evidence/channels-converged-receipt.json',
  });
  return { root, keys, releaseIdentity, receipt, paths };
}

describe('protected publication handoff', () => {
  it('materializes the exact signed identity and convergence receipt as one new pair', () => {
    const f = fixture();
    materializePublicationHandoff({
      paths: f.paths, identity: f.releaseIdentity, receipt: f.receipt, publicKey: f.keys.publicKey,
    });
    expect(JSON.parse(fs.readFileSync(f.paths.identity, 'utf8'))).toEqual(f.releaseIdentity);
    expect(JSON.parse(fs.readFileSync(f.paths.receipt, 'utf8'))).toEqual(f.receipt);
    expect(fs.readdirSync(f.paths.evidenceRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects unsigned, wrong-state, and split-identity receipts before writing either file', () => {
    for (const receiptFor of [
      (f) => ({ ...f.receipt, signature: Buffer.from('forged').toString('base64') }),
      (f) => {
        const { signature: _signature, receiptDigest: _digest, ...payload } = f.receipt;
        return signReceipt({ ...payload, state: 'install-verified' }, f.keys.privateKey);
      },
      (f) => {
        const { signature: _signature, receiptDigest: _digest, ...payload } = f.receipt;
        return signReceipt({ ...payload, identity: { ...payload.identity, version: '9.8.8' } }, f.keys.privateKey);
      },
    ]) {
      const f = fixture();
      const receipt = receiptFor(f);
      expect(() => validatePublicationHandoff({
        identity: f.releaseIdentity, receipt, publicKey: f.keys.publicKey,
      })).toThrow();
      expect(fs.existsSync(f.paths.identity)).toBe(false);
      expect(fs.existsSync(f.paths.receipt)).toBe(false);
    }
  });

  it('never overwrites a destination and rolls back the first link if the second is claimed', () => {
    const f = fixture();
    fs.writeFileSync(f.paths.receipt, 'other writer');
    expect(() => materializePublicationHandoff({
      paths: f.paths, identity: f.releaseIdentity, receipt: f.receipt, publicKey: f.keys.publicKey,
    })).toThrow(/materialization failed/);
    expect(fs.existsSync(f.paths.identity)).toBe(false);
    expect(fs.readFileSync(f.paths.receipt, 'utf8')).toBe('other writer');
    expect(fs.readdirSync(f.paths.evidenceRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('validates both configured output paths before the remote transaction can start', () => {
    const f = fixture();
    expect(() => resolvePublicationHandoffPaths({
      root: f.root,
      identityPath: '../release-identity.json',
      receiptPath: 'release-evidence/channels-converged-receipt.json',
    })).toThrow(/inside release-evidence/);
    expect(() => resolvePublicationHandoffPaths({
      root: f.root,
      identityPath: 'release-evidence/same.json',
      receiptPath: 'release-evidence/same.json',
    })).toThrow(/must differ/);

    const source = fs.readFileSync(path.join(import.meta.dirname, '../../scripts/release.mjs'), 'utf8');
    expect(source.indexOf('resolvePublicationHandoffPaths({')).toBeLessThan(source.indexOf('await runReleaseTransaction({'));
    expect(source.indexOf('materializePublicationHandoff({')).toBeGreaterThan(source.indexOf('await runReleaseTransaction({'));
  });
});
