#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './release-transaction.mjs';

export const REQUIRED_RELEASE_LEAVES = Object.freeze([
  'source-quality',
  'ux-qe',
  'release-qe',
  'integration-linux',
  'stranger-linux',
  'stranger-macos',
  'stranger-windows',
  'claude-only',
  'codex-only',
  'dual-host',
]);

export function aggregateEvidence({ sha, payloadId, leaves }) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !/^[a-f0-9]{64}$/.test(payloadId || '')) {
    throw new Error('aggregate identity is malformed');
  }
  const byName = new Map();
  for (const leaf of leaves || []) {
    if (!leaf?.name || byName.has(leaf.name)) throw new Error(`duplicate or unnamed evidence leaf: ${leaf?.name || '(missing)'}`);
    if (leaf.sha !== sha || leaf.payloadId !== payloadId) throw new Error(`evidence identity mismatch: ${leaf.name}`);
    if (leaf.status !== 'completed' || leaf.conclusion !== 'success' || leaf.verdict !== 'PASS') {
      throw new Error(`evidence leaf is not fail-closed PASS: ${leaf.name}`);
    }
    byName.set(leaf.name, leaf);
  }
  const missing = REQUIRED_RELEASE_LEAVES.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`required evidence leaves missing: ${missing.join(', ')}`);
  const normalized = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const envelope = { schemaVersion: 1, sha, payloadId, verdict: 'PASS', leaves: normalized };
  return { ...envelope, evidenceDigest: crypto.createHash('sha256').update(canonicalJson(envelope)).digest('hex') };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
  };
  const out = path.resolve(arg('--out') || 'release-evidence/aggregate-envelope.json');
  const envelope = aggregateEvidence({
    sha: arg('--sha'),
    payloadId: arg('--payload-id'),
    leaves: JSON.parse(fs.readFileSync(path.resolve(arg('--leaves')), 'utf8')),
  });
  fs.writeFileSync(out, `${canonicalJson(envelope)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ verdict: 'PASS', evidenceDigest: envelope.evidenceDigest, out })}\n`);
}
