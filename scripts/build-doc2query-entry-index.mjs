#!/usr/bin/env node
/**
 * scripts/build-doc2query-entry-index.mjs — Builds ~/.cache/ruvnet-brain/kb/entry-index.d2q.rvf
 *
 * Combines:
 *  1. Real ADR-099 doc2query questions (evals/runs/2026-10-01-retrieval-4.5/doc2query-ruflo-ruvector-ruview.jsonl)
 *  2. Real README / doc / architecture headings & openings from the core ecosystem repos' .meta.json
 *
 * Embeds every entry with the production 768d BGE query embedder (Xenova/bge-base-en-v1.5) into
 * RuVector RvfDatabase (cosine HNSW) so search_ruvnet maps plain-English needs directly to the
 * exact answer passage inside the repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KB_DIR = process.argv.includes('--dir')
  ? path.resolve(process.argv[process.argv.indexOf('--dir') + 1])
  : path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb');

const D2Q_PATH = path.resolve('evals/runs/2026-10-01-retrieval-4.5/doc2query-ruflo-ruvector-ruview.jsonl');

const CORE_REPOS = [
  'ruvector', 'ruflo', 'agentdb', 'agentic-qe', 'rulake', 'qudag', 'ruv-fann',
  'sparc', 'metaharness', 'cve-bench', 'agenticow', 'ruv-dev', 'safla', 'daa',
  'dspy.ts', 'fact', 'synthlang', 'ruview', 'agentics-friday-talks', 'x-ruv-io',
];

const { __embedInternals } = await import(pathToFileURL(path.join(KB_DIR, 'forge-ask.mjs')).href);
const { loadRvf } = await import(pathToFileURL(path.join(KB_DIR, 'resolve-deps.mjs')).href);
const { RvfDatabase } = loadRvf().mod;
const embed = __embedInternals.embed;
const bgeCfg = { model: 'Xenova/bge-base-en-v1.5', dimensions: 768, pooling: 'cls', normalize: true, queryPrefix: 'Represent this sentence for searching relevant passages: ' };

const entries = [];
const seen = new Set();
const addEntry = (repo, filePath, question, source) => {
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  if (!q || q.length < 12) return;
  const key = `${repo.toLowerCase()}::${filePath}::${q.toLowerCase().slice(0, 90)}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push({ repo, path: filePath, question: q, source });
};

// 1. Ingest real ADR-099 doc2query questions (prioritizing docs/READMEs/ADRs, capped per repo for fast build)
if (fs.existsSync(D2Q_PATH)) {
  const lines = fs.readFileSync(D2Q_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const perStore = new Map();
  const parsed = lines.map((l) => JSON.parse(l));
  // Sort docs/READMEs/ADRs first so highest-signal prose files always enter
  parsed.sort((a, b) => {
    const score = (p) => (/readme\.md$/i.test(p) ? 0 : /docs\/|adr/i.test(p) ? 1 : 2);
    return score(a.path || '') - score(b.path || '');
  });
  for (const row of parsed) {
    const store = String(row.store || '').toLowerCase();
    const count = perStore.get(store) || 0;
    if (count >= 450) continue;
    for (const q of (row.questions || []).slice(0, 2)) {
      addEntry(store, row.path, q, 'doc2query');
      perStore.set(store, (perStore.get(store) || 0) + 1);
    }
  }
}

// 2. Extract real README / doc / architecture entry points from core repo .meta.json files
for (const repo of CORE_REPOS) {
  const metaPath = path.join(KB_DIR, `${repo}.meta.json`);
  if (!fs.existsSync(metaPath)) continue;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const vals = Object.values(meta.entries || {});
    const docEntries = vals.filter((e) =>
      e?.path && (/readme\.md$|architecture|overview|getting-started|guide|adr/i.test(e.path) || e.kind === 'doc'));
    // Prefer chunk 1/* and top-level READMEs first
    docEntries.sort((a, b) => {
      const rank = (e) => (/^readme\.md$/i.test(e.path) ? 0 : /readme\.md$/i.test(e.path) ? 1 : 2) + (String(e.chunk || '').startsWith('1/') ? 0 : 1);
      return rank(a) - rank(b);
    });
    let added = 0;
    for (const e of docEntries) {
      if (added >= 65) break;
      const text = `${e.title || ''} — ${String(e.preview || '').replace(/^---[\s\S]*?---/, '').replace(/[#*`>]/g, ' ')}`.replace(/\s+/g, ' ').trim();
      if (text.length < 24) continue;
      addEntry(repo, e.path, `${repo}: ${text.slice(0, 240)}`, 'doc-heading');
      added++;
    }
  } catch {}
}

console.log(`[d2q-build] Collected ${entries.length} real entry points across ${new Set(entries.map((e) => e.repo)).size} repos`);

const rvfPath = path.join(KB_DIR, 'entry-index.d2q.rvf');
const metaOut = path.join(KB_DIR, 'entry-index.d2q.meta.json');
const tmpRvf = `${rvfPath}.tmp`;
fs.rmSync(tmpRvf, { force: true });
fs.rmSync(`${tmpRvf}.idmap.json`, { force: true });

const db = await RvfDatabase.create(tmpRvf, { dimensions: 768, metric: 'cosine', overwrite: true });
const batch = [];
for (let i = 0; i < entries.length; i++) {
  const vec = await embed(entries[i].question, bgeCfg);
  batch.push({ id: String(i + 1), vector: Array.from(vec) });
  if (batch.length === 32 || i === entries.length - 1) {
    await db.ingestBatch(batch.splice(0));
  }
  if ((i + 1) % 250 === 0 || i === entries.length - 1) {
    process.stderr.write(`\r[d2q-build] embedded ${i + 1}/${entries.length}`);
  }
}
process.stderr.write('\n');
if (db.close) await db.close();
fs.renameSync(tmpRvf, rvfPath);
if (fs.existsSync(`${tmpRvf}.idmap.json`)) fs.renameSync(`${tmpRvf}.idmap.json`, `${rvfPath}.idmap.json`);
fs.writeFileSync(metaOut, JSON.stringify({
  version: 1,
  updatedAt: new Date().toISOString(),
  model: bgeCfg.model,
  dimensions: 768,
  entries,
}, null, 2) + '\n');

const bytes = fs.statSync(rvfPath).size;
console.log(`[d2q-build] DONE -> ${rvfPath} (${(bytes / 1048576).toFixed(2)} MB, ${entries.length} entries)`);
