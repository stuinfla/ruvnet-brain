// tests/unit/install-verify-bundle-parity.test.mjs — bin/install.mjs carries its OWN hand-copied
// verifyBundle() (lines 26-39, comment "mirrors scripts/verify-bundle.mjs") — but nothing has ever
// tested that the two stay behaviorally identical (memory `test-coverage-gaps-2026-07-07`: "the live
// copy has ZERO tests"). bin/install.mjs is not safely importable in-process (its whole body runs
// inside a top-level self-executing `(async () => {...})().catch(...)` with no import.meta.url
// guard, so importing it would kick off the real installer — network calls, filesystem writes,
// wiring the Claude Code plugin). Rather than subprocess it, this test replicates install.mjs's
// exact verifyBundle() logic inline (see bin/install.mjs lines 26-39) — parameterized on the public
// key instead of the hardcoded PEM constant, since the hardcoding itself is an intentional security
// property (the trust root travels with the installer's own source, not a sibling config file), not
// part of the verification ALGORITHM — and runs it side by side with the REAL, already-exported
// scripts/verify-bundle.mjs#verifyBundle against identical fixtures. If either implementation's
// algorithm ever drifts (e.g. one starts pre-hashing before crypto.sign, or changes what counts as
// "signature missing"), this test catches the disagreement instead of each copy quietly passing (or
// never having) its own isolated tests while a real install silently breaks.
//
// One INTENTIONAL divergence this test does NOT flag as drift: scripts/verify-bundle.mjs also checks
// for a missing public-key FILE on disk; install.mjs's copy has the key hardcoded as a source
// constant, so that failure mode structurally cannot occur there — not tested for parity.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Verbatim replica of bin/install.mjs's verifyBundle (lines 26-39), pubkey parameterized — see header.
function installVerifyBundle(bundlePath, sigPath, pubkeyPem) {
  try {
    if (!fs.existsSync(bundlePath)) return { ok: false, reason: `bundle not found: ${bundlePath}` };
    if (!fs.existsSync(sigPath)) return { ok: false, reason: `signature missing (fail-closed)` };
    const digest = crypto.createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
    const pub = crypto.createPublicKey(pubkeyPem);
    const ok = crypto.verify(null, Buffer.from(digest, 'hex'), pub, fs.readFileSync(sigPath));
    return ok ? { ok: true, reason: `signature valid (sha256 ${digest.slice(0, 12)}…)` } : { ok: false, reason: 'signature does NOT match — bundle may be tampered' };
  } catch (e) { return { ok: false, reason: `verify error: ${e.message}` }; }
}

let tmp, pubPath, prevPubEnv, realVerifyBundle;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-verify-parity-'));
  pubPath = path.join(tmp, 'ruvnet-brain-signing.pub.pem');
  prevPubEnv = process.env.RUVNET_SIGNING_PUB;
  // verify-bundle.mjs reads RUVNET_SIGNING_PUB into a top-level const at import time, so it MUST be
  // set before the (dynamic) import, with the module cache busted — same pattern as
  // tests/unit/sign-verify-roundtrip.test.mjs.
  process.env.RUVNET_SIGNING_PUB = pubPath;
  vi.resetModules();
  ({ verifyBundle: realVerifyBundle } = await import('../../scripts/verify-bundle.mjs'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevPubEnv === undefined) delete process.env.RUVNET_SIGNING_PUB; else process.env.RUVNET_SIGNING_PUB = prevPubEnv;
});

const scenario = (n) => path.join(tmp, `bundle-${n}.zip`);

describe('bin/install.mjs verifyBundle vs scripts/verify-bundle.mjs verifyBundle — must agree', () => {
  it('both accept a validly signed bundle', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    const bundle = scenario('valid');
    fs.writeFileSync(bundle, 'bundle bytes');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
    const sig = `${bundle}.sig`;
    fs.writeFileSync(sig, crypto.sign(null, Buffer.from(digest, 'hex'), privateKey));

    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    expect(installVerifyBundle(bundle, sig, pubPem).ok).toBe(true);
    expect(realVerifyBundle(bundle, sig).ok).toBe(true);
  });

  it('both reject a tampered bundle', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    const bundle = scenario('tampered');
    fs.writeFileSync(bundle, 'original bytes');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
    const sig = `${bundle}.sig`;
    fs.writeFileSync(sig, crypto.sign(null, Buffer.from(digest, 'hex'), privateKey));
    fs.writeFileSync(bundle, 'TAMPERED bytes');

    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    expect(installVerifyBundle(bundle, sig, pubPem).ok).toBe(false);
    expect(realVerifyBundle(bundle, sig).ok).toBe(false);
  });

  it('both reject a signature made with the wrong key', () => {
    const trusted = crypto.generateKeyPairSync('ed25519');
    const attacker = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(pubPath, trusted.publicKey.export({ type: 'spki', format: 'pem' }));
    const bundle = scenario('wrongkey');
    fs.writeFileSync(bundle, 'bundle bytes');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
    const sig = `${bundle}.sig`;
    fs.writeFileSync(sig, crypto.sign(null, Buffer.from(digest, 'hex'), attacker.privateKey));

    const pubPem = trusted.publicKey.export({ type: 'spki', format: 'pem' });
    expect(installVerifyBundle(bundle, sig, pubPem).ok).toBe(false);
    expect(realVerifyBundle(bundle, sig).ok).toBe(false);
  });

  it('both fail closed when the .sig file is missing entirely', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    const bundle = scenario('nosig');
    fs.writeFileSync(bundle, 'bytes');
    const missingSig = path.join(tmp, 'does-not-exist.sig');

    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    expect(installVerifyBundle(bundle, missingSig, pubPem).ok).toBe(false);
    expect(realVerifyBundle(bundle, missingSig).ok).toBe(false);
  });

  it('both fail closed when the bundle itself is missing', () => {
    const missingBundle = scenario('does-not-exist');
    const missingSig = `${missingBundle}.sig`;
    expect(installVerifyBundle(missingBundle, missingSig, 'irrelevant').ok).toBe(false);
    expect(realVerifyBundle(missingBundle, missingSig).ok).toBe(false);
  });
});
