#!/usr/bin/env node
// scripts/sign-bundle.mjs — Ed25519 signing for the shipped brain bundle (SEC-0010 #6).
//
// WHY: the installer downloads a ~512 MB zip over the network and extracts it into the user's
// Claude Code config. Unsigned, a MITM or a compromised release host could swap the bundle for a
// poisoned one and the installer would extract it blindly. Signing closes that: publish emits a
// detached signature over the bundle's SHA-256; the installer verifies it against a PUBLIC key that
// ships INSIDE the npm package (so the trust root travels with the installer, not the download).
//
// Design rules (match the rest of the repo): dependency-free (node:crypto only), and the private key
// NEVER lives in the repo — it's read from $RUVNET_SIGNING_KEY (PEM) or a gitignored key file.
//
// Usage:
//   node scripts/sign-bundle.mjs --gen-key         # one-time: make a keypair (pub → repo, priv → gitignored)
//   node scripts/sign-bundle.mjs [--bundle <zip>]  # sign the bundle → <zip>.sha256 + <zip>.sig

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(f);

// The PUBLIC key ships in the package (committed) — it is the installer's trust root.
const PUB_PATH = path.join(ROOT, 'keys', 'ruvnet-brain-signing.pub.pem');
// The PRIVATE key is a secret: env first, then a gitignored file. NEVER committed.
const PRIV_ENV = 'RUVNET_SIGNING_KEY';
const PRIV_FILE = process.env.RUVNET_SIGNING_KEY_FILE || path.join(ROOT, '.secrets', 'ruvnet-brain-signing.key.pem');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function genKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(path.dirname(PUB_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(PRIV_FILE), { recursive: true });
  fs.writeFileSync(PUB_PATH, pub);
  fs.writeFileSync(PRIV_FILE, priv, { mode: 0o600 });
  console.log(`✓ public key  → ${path.relative(ROOT, PUB_PATH)} (COMMIT this — it's the installer's trust root)`);
  console.log(`✓ private key → ${path.relative(ROOT, PRIV_FILE)} (gitignored; keep secret, or set $${PRIV_ENV})`);
  console.log(`  Rotate by re-running --gen-key and re-signing; the old public key stops verifying.`);
}

function loadPrivateKey() {
  if (process.env[PRIV_ENV]) return crypto.createPrivateKey(process.env[PRIV_ENV]);
  if (fs.existsSync(PRIV_FILE)) return crypto.createPrivateKey(fs.readFileSync(PRIV_FILE, 'utf8'));
  console.error(`✗ no signing key: set $${PRIV_ENV} (PEM) or create ${path.relative(ROOT, PRIV_FILE)} (run --gen-key).`);
  process.exit(2);
}

function signBundle() {
  const bundle = arg('--bundle', path.join(ROOT, 'dist', 'ruvnet-brain.zip'));
  if (!fs.existsSync(bundle)) { console.error(`✗ bundle not found: ${bundle}`); process.exit(2); }
  const buf = fs.readFileSync(bundle);
  const digest = sha256(buf);
  fs.writeFileSync(`${bundle}.sha256`, `${digest}  ${path.basename(bundle)}\n`);
  // Sign the RAW digest bytes (Ed25519 takes the message directly; no pre-hash algo arg).
  const sig = crypto.sign(null, Buffer.from(digest, 'hex'), loadPrivateKey());
  fs.writeFileSync(`${bundle}.sig`, sig);
  console.log(`✓ signed ${path.basename(bundle)}`);
  console.log(`   sha256: ${digest}`);
  console.log(`   → ${path.basename(bundle)}.sha256 + ${path.basename(bundle)}.sig (publish these alongside the zip)`);
}

if (has('--gen-key')) genKey();
else signBundle();
