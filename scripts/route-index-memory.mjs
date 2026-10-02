#!/usr/bin/env node
/**
 * scripts/route-index-memory.mjs — how much memory the router metadata index keeps alive in a
 * long-lived process (the warm MCP worker), and how long the cold build takes.
 *
 * Builds the index for every store by routing one question, forces GC, and reports the retained
 * delta of heapUsed and arrayBuffers. Needs --expose-gc.
 *
 *   node --expose-gc scripts/route-index-memory.mjs --kb <kbDir> [--impl <forge-ask-all.mjs>]
 *
 * Prints JSON with no local paths (the KB is named by its build stamp).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

export function retained(before, after) {
  const mb = (x) => +(x / 1048576).toFixed(1);
  return { heapUsedMB: mb(after.heapUsed - before.heapUsed), arrayBuffersMB: mb(after.arrayBuffers - before.arrayBuffers),
    totalMB: mb(after.heapUsed - before.heapUsed + after.arrayBuffers - before.arrayBuffers) };
}

async function main() {
  if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');
  const kbDir = arg('--kb');
  if (!kbDir || !fs.existsSync(kbDir)) throw new Error('--kb <dir> is required and must exist');
  const impl = path.resolve(arg('--impl') || path.join(ROOT, 'kb/forge-ask-all.mjs'));
  const { metadataSourceRoute, discoverRepos } = await import(pathToFileURL(impl).href);
  const repos = discoverRepos(kbDir);
  const query = 'keep embeddings searchable offline on a laptop without a database server';
  metadataSourceRoute('warm up the tokenizer and module state only', path.join(kbDir, '__none__'), []);
  globalThis.gc(); globalThis.gc();
  const before = process.memoryUsage();
  const t0 = performance.now();
  metadataSourceRoute(query, kbDir, repos);
  const coldMs = Math.round(performance.now() - t0);
  globalThis.gc(); globalThis.gc();
  const after = process.memoryUsage();
  const t1 = performance.now();
  metadataSourceRoute(query, kbDir, repos);
  const warmMs = Math.round(performance.now() - t1);
  let kbBuild = null;
  try { const m = JSON.parse(fs.readFileSync(path.join(kbDir, 'manifest.json'), 'utf8')); kbBuild = { brainVersion: m.brainVersion, generated: m.generated }; } catch { /* none */ }
  const rel = path.relative(ROOT, impl);
  console.log(JSON.stringify({ impl: rel.startsWith('..') ? '<impl>' : rel, kbBuild, stores: repos.length, coldMs, warmMs, retained: retained(before, after) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
