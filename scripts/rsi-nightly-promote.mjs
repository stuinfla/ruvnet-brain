#!/usr/bin/env node
/**
 * scripts/rsi-nightly-promote.mjs — Autonomous shadow-verified RSI retrieval promotion.
 *
 * Reads verified high-confidence real retrieval observations from
 * ~/.cache/ruvnet-brain/rsi-retrieval-ledger.jsonl and promotes them into
 * ~/.cache/ruvnet-brain/kb/rsi-learned.d2q.rvf ONLY after passing shadow-branch
 * openReadonly() round-trip ID + distance verification. Zero synthetic rows; 100% rollbackable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promoteVerifiedLedgerEntries } from '../kb/rsi-retrieval-loop.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_KB = path.resolve(HERE, '..', 'kb');

function resolveKbDir() {
  const idx = process.argv.indexOf('--dir');
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return path.resolve(process.argv[idx + 1]);
  }
  return path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');
}

const bgeCfg = {
  model: 'Xenova/bge-base-en-v1.5',
  dimensions: 768,
  pooling: 'cls',
  normalize: true,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
};

async function importFromKbOrRepo(kbDir, filename) {
  const inKb = path.join(kbDir, filename);
  const target = fs.existsSync(inKb) ? inKb : path.join(REPO_KB, filename);
  return import(pathToFileURL(target).href);
}

async function main() {
  const kbDir = resolveKbDir();
  const { __embedInternals } = await importFromKbOrRepo(kbDir, 'forge-ask.mjs');
  const { loadRvf } = await importFromKbOrRepo(kbDir, 'resolve-deps.mjs');
  let rvfMod = null;
  try { rvfMod = loadRvf()?.mod || null; } catch { rvfMod = null; }
  if (!rvfMod?.RvfDatabase || !__embedInternals?.embed) {
    console.error(JSON.stringify({ ok: false, reason: 'RvfDatabase or embedder unavailable', kbDir }));
    process.exit(1);
  }
  const res = await promoteVerifiedLedgerEntries({
    dir: kbDir,
    embedFn: (q) => __embedInternals.embed(q, bgeCfg),
    RvfDatabase: rvfMod.RvfDatabase,
  });
  const ok = res.shadowVerified !== false;
  console.log(JSON.stringify({ ok, kbDir, ...res }));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exit(1);
});
