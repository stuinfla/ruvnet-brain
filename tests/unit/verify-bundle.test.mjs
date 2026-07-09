// tests/unit/verify-bundle.test.mjs — the bundle-signature verifier is security-critical (it gates
// what gets extracted into the user's config), so it earns real tests. Drafted by agentic-qe
// (`aqe test generate scripts/verify-bundle.mjs`, 35 assertions); made runnable + fail-closed-focused.
// It used to shell out to `sign-bundle.mjs` with the repo's REAL private key. That key must never
// exist in CI, so this file failed on every push — "no signing key: set $RUVNET_SIGNING_KEY" — and
// took the whole pipeline red with it, for days, unnoticed. A security test that only runs on one
// laptop guards nothing.
//
// Now the test mints its own ephemeral Ed25519 keypair, signs through the REAL sign-bundle.mjs
// (via its documented $RUVNET_SIGNING_KEY env path), and verifies through the REAL verifyBundle
// against that ephemeral public key. Same code under test, zero secrets, runs anywhere.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../../scripts/verify-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir, zip, pubPath;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-'));
  zip = path.join(dir, 'b.zip');
  fs.writeFileSync(zip, 'REAL-BUNDLE-BYTES');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  pubPath = path.join(dir, 'test.pub.pem');
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));

  execFileSync('node', ['scripts/sign-bundle.mjs', '--bundle', zip], {
    cwd: ROOT,
    env: { ...process.env, RUVNET_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
  });
});

describe('verifyBundle — fail-closed signature gate', () => {
  it('accepts a correctly-signed bundle', () => {
    const r = verifyBundle(zip, `${zip}.sig`, pubPath);
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/valid/i);
  });
  it('REJECTS a tampered bundle (signature no longer matches)', () => {
    const t = path.join(dir, 't.zip');
    fs.writeFileSync(t, 'TAMPERED-BYTES');
    fs.copyFileSync(`${zip}.sig`, `${t}.sig`);
    const r = verifyBundle(t, `${t}.sig`, pubPath);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does NOT match|tamper/i);
  });
  it('REJECTS a bundle signed by a DIFFERENT key (the trust root actually matters)', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const otherPub = path.join(dir, 'other.pub.pem');
    fs.writeFileSync(otherPub, other.publicKey.export({ type: 'spki', format: 'pem' }));
    const r = verifyBundle(zip, `${zip}.sig`, otherPub);
    expect(r.ok).toBe(false);
  });
  it('FAILS CLOSED when the signature is missing (never trusts an unsigned bundle)', () => {
    const r = verifyBundle(zip, path.join(dir, 'nope.sig'), pubPath);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing|fail-closed/i);
  });
  it('FAILS CLOSED when the bundle itself is absent', () => {
    const r = verifyBundle(path.join(dir, 'ghost.zip'), undefined, pubPath);
    expect(r.ok).toBe(false);
  });
  it('FAILS CLOSED when the public key is absent', () => {
    const r = verifyBundle(zip, `${zip}.sig`, path.join(dir, 'no-such.pub.pem'));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no public key/i);
  });
});
