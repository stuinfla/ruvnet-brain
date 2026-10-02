#!/usr/bin/env node
/**
 * scripts/oracle/doc2query-reach.mjs — ADR-099 arm A, measurement: do generated entry points bring
 * the gold file into the pool?
 *
 * Builds one RVF "entry" index per store from doc2query-generate output (every question embedded with
 * the production query embedder, so a newcomer's question is matched question-to-question), then, for
 * every need, asks the gold store's entry index for its top --k questions and collapses them to files.
 * Pool reach is reported against the existing pool (dense 64 + keyword lane, from an abstain-trace
 * run's poolRanks), on the TRAIN and HELD-OUT splits separately, with Wilson intervals:
 *   baselineReach  gold already pooled by dense + keyword
 *   entryReach     gold among the entry lane's files
 *   unionReach     either
 * Restricted to needs whose gold repository the router searched (the trace's eligible set); over all
 * needs only entryReach is reported (store-level, independent of routing).
 *
 *   node scripts/oracle/doc2query-reach.mjs --runtime <kbDir with forge-ask.mjs + node_modules>
 *     --d2q <generated.jsonl> --set <need-set.json> --split <split.json> --trace <abstain-trace.json>
 *     [--k 24] [--files 8] [--index-dir <dir>] [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wilson } from '../eval-brain.mjs';

/** Collapse ranked entry hits (each pointing at a file) to the first `files` distinct files. */
export function filesFromEntries(hits, pathOfId, files) {
  const out = [];
  for (const h of hits) {
    const p = pathOfId(h.id);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= files) break;
  }
  return out;
}

export function reachSummary(rows) {
  const r = (pred) => { const k = rows.filter(pred).length; const w = wilson(k, rows.length); return { k, n: rows.length, lo: +w.lo.toFixed(4), hi: +w.hi.toFixed(4) }; };
  return { baselineReach: r((x) => x.baseline), entryReach: r((x) => x.entry), unionReach: r((x) => x.baseline || x.entry),
    gained: rows.filter((x) => x.entry && !x.baseline).length };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const runtime = path.resolve(arg('--runtime'));
  const { __embedInternals } = await import(pathToFileURL(path.join(runtime, 'forge-ask.mjs')).href);
  const { loadRvf } = await import(pathToFileURL(path.join(runtime, 'resolve-deps.mjs')).href);
  const { RvfDatabase } = loadRvf().mod;
  const embed = __embedInternals.embed;
  const k = Number(arg('--k', 24));
  const nFiles = Number(arg('--files', 8));
  const indexDir = arg('--index-dir', fs.mkdtempSync(path.join(runtime, '..', 'd2q-index-')));
  fs.mkdirSync(indexDir, { recursive: true });
  const gen = fs.readFileSync(arg('--d2q'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stores = [...new Set(gen.map((g) => g.store))];
  const indexes = new Map();
  // The entry index uses the store's own query embedder (big variant when present: bge + query prefix),
  // exactly what searchKb computes for the question, so production needs one query embedding.
  const cfgFor = (store) => {
    for (const v of [`${store}.big.rvf.embed.json`, `${store}.rvf.embed.json`]) {
      try { return JSON.parse(fs.readFileSync(path.join(runtime, v), 'utf8')); } catch { /* next */ }
    }
    return undefined;
  };
  for (const store of stores) {
    const cfg = cfgFor(store);
    const dims = cfg?.dimensions || 384;
    const rows = gen.filter((g) => g.store === store).flatMap((g) => g.questions.map((q) => ({ q, path: g.path })));
    const file = path.join(indexDir, `${store}.entry.rvf`);
    fs.rmSync(file, { force: true });
    const db = await RvfDatabase.create(file, { dimensions: dims, metric: 'cosine' });
    const batch = [];
    for (let i = 0; i < rows.length; i++) {
      batch.push({ id: i + 1, vector: Array.from(await embed(rows[i].q, cfg)) });
      if (batch.length === 64 || i === rows.length - 1) { await db.ingestBatch(batch.splice(0)); }
      if (i % 500 === 0) process.stderr.write(`\r[d2q-reach] ${store} ${i}/${rows.length}`);
    }
    indexes.set(store, { db, cfg, paths: rows.map((r) => r.path), questions: rows.length, model: cfg?.model || 'default' });
  }
  const set = JSON.parse(fs.readFileSync(arg('--set'), 'utf8')).questions;
  const split = JSON.parse(fs.readFileSync(arg('--split'), 'utf8'));
  const trace = JSON.parse(fs.readFileSync(arg('--trace'), 'utf8'));
  const pooled = new Map(trace.poolRanks.map((p) => [p.id, p.poolRank != null]));
  const rows = [];
  for (const q of set) {
    const store = q.repo.toLowerCase();
    const idx = indexes.get(store);
    if (!idx) continue;
    const hits = await idx.db.query(Array.from(await embed(q.need, idx.cfg)), k);
    const files = filesFromEntries(hits, (id) => idx.paths[Number(id) - 1], nFiles);
    rows.push({ id: q.id, split: split.train.includes(q.id) ? 'train' : 'heldout', routed: pooled.has(q.id),
      baseline: pooled.get(q.id) === true, entry: files.includes(q.path), entryRank: files.indexOf(q.path) + 1 || null });
  }
  const report = { kind: 'ruvnet-brain-doc2query-reach', k, files: nFiles,
    indexes: Object.fromEntries([...indexes].map(([s, v]) => [s, { questions: v.questions, model: v.model }])),
    generatedFiles: gen.length, keptQuestions: gen.reduce((s, g) => s + g.questions.length, 0),
    rejectedQuestions: gen.reduce((s, g) => s + (g.rejected?.length || 0), 0), results: {} };
  for (const sp of ['train', 'heldout']) {
    report.results[sp] = { routedNeeds: reachSummary(rows.filter((r) => r.split === sp && r.routed)),
      // the trace covers only routed needs, so over all needs only the entry lane itself is known
      allNeedsEntryReach: reachSummary(rows.filter((r) => r.split === sp)).entryReach };
  }
  report.rows = rows;
  if (arg('--out')) fs.writeFileSync(arg('--out'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 1));
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
