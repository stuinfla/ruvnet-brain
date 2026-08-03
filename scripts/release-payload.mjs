#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const digestFile = (file) => sha256(fs.readFileSync(file));

export function createPayloadManifest({ version, tag, candidateSha, producer, members }) {
  const normalized = members.map(({ name, file, role }) => {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) throw new Error(`payload member is absent or empty: ${file}`);
    return { name, role, size: stat.size, sha256: digestFile(file) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(normalized.map(({ name }) => name));
  if (names.size !== normalized.length) throw new Error('payload member names must be unique');
  return { schemaVersion: 1, version, tag, candidateSha, producer, members: normalized };
}

export const payloadIdFor = (manifest) => sha256(Buffer.from(canonicalJson(manifest)));

export function signPayloadManifest(manifest, privateKey) {
  return crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64');
}

export function verifyPayloadMembers({ manifest, root }) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.members)) {
    throw new Error('invalid payload manifest');
  }
  for (const member of manifest.members) {
    if (!member.name || path.basename(member.name) !== member.name) throw new Error(`unsafe payload member name: ${member.name}`);
    const file = path.join(root, member.name);
    const stat = fs.statSync(file);
    if (stat.size !== member.size || digestFile(file) !== member.sha256) {
      throw new Error(`payload member mismatch: ${member.name}`);
    }
  }
  return { payloadId: payloadIdFor(manifest), manifest, root };
}

export function verifyPayload({ manifest, signature, publicKey, root }) {
  if (!crypto.verify(null, Buffer.from(canonicalJson(manifest)), publicKey, Buffer.from(signature.trim(), 'base64'))) {
    throw new Error('payload manifest signature mismatch');
  }
  return verifyPayloadMembers({ manifest, root });
}

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const command = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  ? process.argv[2]
  : null;

if (command === 'create') {
  const out = path.resolve(arg('--out') || 'release-evidence/payload-manifest.json');
  const memberArgs = process.argv.filter((value, index) => process.argv[index - 1] === '--member');
  const members = memberArgs.map((entry) => {
    const [role, file] = entry.split('=', 2);
    if (!role || !file) throw new Error(`invalid --member ${entry}; expected role=path`);
    return { role, file: path.resolve(file), name: path.basename(file) };
  });
  const manifest = createPayloadManifest({
    version: arg('--version'),
    tag: arg('--tag'),
    candidateSha: arg('--sha'),
    producer: {
      workflow: process.env.GITHUB_WORKFLOW || 'local',
      runId: process.env.GITHUB_RUN_ID || 'local',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    },
    members,
  });
  fs.writeFileSync(out, `${canonicalJson(manifest)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ payloadId: payloadIdFor(manifest), manifest: out })}\n`);
} else if (command === 'sign') {
  const manifestPath = path.resolve(arg('--manifest'));
  const out = path.resolve(arg('--out'));
  if (fs.existsSync(out)) throw new Error(`refusing to overwrite persisted payload signature: ${out}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const pem = process.env.RUVNET_SIGNING_KEY;
  if (!pem) throw new Error('RUVNET_SIGNING_KEY is required');
  fs.writeFileSync(out, `${signPayloadManifest(manifest, crypto.createPrivateKey(pem))}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ payloadId: payloadIdFor(manifest), signature: out })}\n`);
} else if (command === 'verify' || command === 'verify-members') {
  const manifestPath = path.resolve(arg('--manifest'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = command === 'verify'
    ? verifyPayload({
      manifest,
      signature: fs.readFileSync(path.resolve(arg('--signature')), 'utf8'),
      publicKey: crypto.createPublicKey(fs.readFileSync(path.resolve(arg('--public-key')), 'utf8')),
      root: path.dirname(manifestPath),
    })
    : verifyPayloadMembers({ manifest, root: path.dirname(manifestPath) });
  process.stdout.write(`${JSON.stringify({ verdict: 'PASS', payloadId: result.payloadId })}\n`);
}
