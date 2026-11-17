// Signing and checking release.json (contract 4.4). The signature covers the whole file except the
// signature itself, so the version, the generation and the release number cannot be replayed.
// There is no switch that skips the check.
import crypto from 'node:crypto';
import fs from 'node:fs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function keyId(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function sign(body, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const value = crypto.sign(null, Buffer.from(canonical(body)), key).toString('base64');
  return { ...body, signature: { alg: 'ed25519', keyId: keyId(pub), value } };
}

/** True only when `release` is signed, unchanged, by the holder of `publicKeyPem`. */
export function verify(release, publicKeyPem) {
  const { signature, ...body } = release || {};
  if (!signature || signature.alg !== 'ed25519' || typeof signature.value !== 'string') return false;
  try {
    return crypto.verify(null, Buffer.from(canonical(body)), crypto.createPublicKey(publicKeyPem), Buffer.from(signature.value, 'base64'));
  } catch {
    return false;
  }
}

/** The release public key this build trusts. It ships in the shim and the installer. */
export function trustedPublicKey() {
  const file = new URL('./keys/release-public.pem', import.meta.url);
  if (!fs.existsSync(file)) {
    throw new Error('This build carries no trusted release key, so it cannot install anything.');
  }
  return fs.readFileSync(file, 'utf8');
}
