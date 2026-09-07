// Actual sign-bundle CLI producer and verifyBundle consumer with ephemeral keys and disposable bytes.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function sign(bundle, privateKey) {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/sign-bundle.mjs', import.meta.url)),
    '--bundle', bundle], { encoding: 'utf8', timeout: 10000, env: {
      ...process.env, RUVNET_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    } });
  expect(fs.readFileSync(`${bundle}.sha256`, 'utf8')).toBe(`${sha256(fs.readFileSync(bundle))}  ${path.basename(bundle)}\n`);
}

let tmp, pubPath, prevPubEnv, verifyBundle;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-verify-'));
  pubPath = path.join(tmp, 'ruvnet-brain-signing.pub.pem');
  prevPubEnv = process.env.RUVNET_SIGNING_PUB;
  // verify-bundle.mjs reads RUVNET_SIGNING_PUB into a top-level const at import time, so it MUST be
  // set before the (dynamic) import, with the module cache busted — same pattern as
  // forge-guard-passages.test.mjs's GUARD_INJECTION_LOG handling.
  process.env.RUVNET_SIGNING_PUB = pubPath;
  vi.resetModules();
  ({ verifyBundle } = await import('../../scripts/verify-bundle.mjs'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevPubEnv === undefined) delete process.env.RUVNET_SIGNING_PUB; else process.env.RUVNET_SIGNING_PUB = prevPubEnv;
});

describe('sign-bundle.mjs + verify-bundle.mjs — Ed25519 roundtrip', () => {
  it('a bundle signed with the trusted key verifies OK', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' })); // PUB_PATH is fixed to `pubPath` at import time; only the file CONTENTS need refreshing per test

    const bundle = path.join(tmp, 'bundle.zip');
    fs.writeFileSync(bundle, 'not-a-real-zip-just-bytes-to-hash');
    const sig = path.join(tmp, 'bundle.zip.sig');
    sign(bundle, privateKey);

    const r = verifyBundle(bundle, sig);
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/signature valid/);
  });

  it('fails closed when the bundle bytes are tampered with after signing', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' })); // PUB_PATH is fixed to `pubPath` at import time; only the file CONTENTS need refreshing per test

    const bundle = path.join(tmp, 'bundle2.zip');
    fs.writeFileSync(bundle, 'original bytes');
    const sig = path.join(tmp, 'bundle2.zip.sig');
    sign(bundle, privateKey);
    fs.writeFileSync(bundle, 'TAMPERED bytes'); // same length-ish, different content, post-signature

    const r = verifyBundle(bundle, sig);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does NOT match/);
  });

  it('fails closed when signed with a DIFFERENT key than the trusted public key', () => {
    const trusted = crypto.generateKeyPairSync('ed25519');
    const attacker = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(pubPath, trusted.publicKey.export({ type: 'spki', format: 'pem' }));
    process.env.RUVNET_SIGNING_PUB = pubPath;

    const bundle = path.join(tmp, 'bundle3.zip');
    fs.writeFileSync(bundle, 'bundle bytes');
    const sig = path.join(tmp, 'bundle3.zip.sig');
    sign(bundle, attacker.privateKey); // real producer, wrong trust root

    const r = verifyBundle(bundle, sig);
    expect(r.ok).toBe(false);
  });

  it('fails closed when the .sig file is missing entirely (never trust an unsigned bundle)', () => {
    process.env.RUVNET_SIGNING_PUB = pubPath; // any valid pub key on disk from a prior test is fine
    const bundle = path.join(tmp, 'bundle4.zip');
    fs.writeFileSync(bundle, 'bytes');
    const r = verifyBundle(bundle, path.join(tmp, 'does-not-exist.sig'));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/signature missing.*fail-closed/i);
  });
});
