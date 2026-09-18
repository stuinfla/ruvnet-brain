import crypto from 'node:crypto';
import { canonicalJson as canonical } from '../coverage-integrity.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const keyId = (key) => crypto.createHash('sha256').update((key.type === 'public' ? key : crypto.createPublicKey(key)).export({ type: 'spki', format: 'der' })).digest('hex');
const digest = (value) => { const { attestation: _attestation, ...body } = value || {}; return crypto.createHash('sha256').update(canonical(body)).digest('hex'); };

export function attestMeasurementReport(report, privateKey) {
  if (!report || report.kind !== 'ruvnet-brain-repo-recall') throw new Error('measurement report kind is invalid');
  const key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('measurement attestation requires Ed25519');
  const body = { schemaVersion: 1, kind: 'ruvnet-brain-measurement-attestation', reportKind: report.kind,
    reportSha256: digest(report), keyId: keyId(key) };
  return { ...body, signature: crypto.sign(null, Buffer.from(canonical(body)), key).toString('base64') };
}

export function verifyMeasurementReport(report, attestation, trustedPublicKey) {
  if (!trustedPublicKey) throw new Error('trusted measurement public key is missing');
  const key = trustedPublicKey?.type === 'public' ? trustedPublicKey : crypto.createPublicKey(trustedPublicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('measurement attestation requires Ed25519');
  if (!attestation || attestation.schemaVersion !== 1 || attestation.kind !== 'ruvnet-brain-measurement-attestation'
    || attestation.reportKind !== report?.kind || !HEX64.test(String(attestation.reportSha256 || ''))
    || attestation.reportSha256 !== digest(report) || attestation.keyId !== keyId(key)) throw new Error('measurement attestation identity mismatch');
  const { signature, ...body } = attestation;
  if (typeof signature !== 'string' || !crypto.verify(null, Buffer.from(canonical(body)), key, Buffer.from(signature, 'base64'))) throw new Error('measurement attestation signature mismatch');
  return report;
}

/** Fail before expensive work when the externally configured measurement authority is unusable. */
export function validateMeasurementKeyPair({ privateKey = process.env.RUVNET_MEASUREMENT_SIGNING_KEY,
  publicKey = process.env.RUVNET_MEASUREMENT_PUBLIC_KEY } = {}) {
  if (!privateKey || !publicKey) throw new Error('measurement signing and trusted public keys are required before candidate preparation');
  const privateObject = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  const publicObject = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  if (privateObject.asymmetricKeyType !== 'ed25519' || publicObject.asymmetricKeyType !== 'ed25519') throw new Error('measurement authority requires Ed25519');
  if (keyId(privateObject) !== keyId(publicObject)) throw new Error('measurement signing key does not match the trusted public key');
  return { keyId: keyId(publicObject), algorithm: 'Ed25519' };
}
