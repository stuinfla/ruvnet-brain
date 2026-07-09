#!/usr/bin/env node
// scripts/verify-bundle.mjs — verify a downloaded bundle against the shipped Ed25519 public key.
//
// The installer calls this BEFORE extracting the ~512 MB zip into the user's Claude Code config.
// Trust root = keys/ruvnet-brain-signing.pub.pem, which ships INSIDE the npm package — so the key
// the installer trusts travels with the installer, not with the (possibly-tampered) download.
//
// Dependency-free (node:crypto). Exit 0 = verified; non-zero = fail-closed (caller must NOT extract).
//
// Usage (also importable): node scripts/verify-bundle.mjs <bundle.zip> <bundle.zip.sig>
//   Returns/echoes { ok, reason }. If the .sig is absent, ok:false with a clear reason (fail-closed).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB_PATH = process.env.RUVNET_SIGNING_PUB || path.join(ROOT, 'keys', 'ruvnet-brain-signing.pub.pem');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * `pubPath` defaults to the repo's committed trust root and should stay that way in production.
 * It is overridable ONLY so the test can bring an ephemeral keypair: signing requires the private
 * key, which CI must never hold, and a test that can't run in CI is a test that stops protecting
 * anything. (CI was red for days on exactly this: `sign-bundle.mjs` → "no signing key".)
 */
export function verifyBundle(bundlePath, sigPath = `${bundlePath}.sig`, pubPath = PUB_PATH) {
  try {
    if (!fs.existsSync(pubPath)) return { ok: false, reason: `no public key at ${path.relative(ROOT, pubPath)}` };
    if (!fs.existsSync(bundlePath)) return { ok: false, reason: `bundle not found: ${bundlePath}` };
    if (!fs.existsSync(sigPath)) return { ok: false, reason: `signature missing: ${path.basename(sigPath)} (fail-closed — refusing to trust an unsigned bundle)` };
    const digest = sha256(fs.readFileSync(bundlePath));
    const sig = fs.readFileSync(sigPath);
    const pub = crypto.createPublicKey(fs.readFileSync(pubPath, 'utf8'));
    const ok = crypto.verify(null, Buffer.from(digest, 'hex'), pub, sig);
    return ok ? { ok: true, reason: `signature valid (sha256 ${digest.slice(0, 12)}…)` } : { ok: false, reason: 'signature does NOT match — bundle may be tampered' };
  } catch (e) {
    return { ok: false, reason: `verify error: ${e.message}` };
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [bundle, sig] = process.argv.slice(2);
  if (!bundle) { console.error('Usage: node scripts/verify-bundle.mjs <bundle.zip> [<bundle.zip.sig>]'); process.exit(2); }
  const r = verifyBundle(bundle, sig);
  console.log(`${r.ok ? '✓' : '✗'} ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
