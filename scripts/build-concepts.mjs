#!/usr/bin/env node
// build-concepts.mjs — assemble the CONCEPTS store: all accepted L2 articles + every per-repo primer,
// chunked into kb/concepts.passages.jsonl (+ concepts.meta.json) so `forge-big both --name concepts`
// can embed it into concepts.big.rvf. The cross-repo tool (forge-ask-all / search_ruvnet) then unions
// this prose layer with the deep-source repos at query time — making code-implemented capabilities
// retrievable as high-confidence PROSE without re-embedding the 40K-chunk source stores.
//
// Each passage path is "<repo>/<kind>/<slug>#<chunk>" so a consumer (and the capability gate) can
// attribute a concept hit back to its source repo.
//
//   node scripts/build-concepts.mjs   → writes kb/concepts.passages.jsonl + kb/concepts.meta.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, 'kb');

// PRIVATE fence (SEC-0010 #5) — the concepts store folds in primers + L2 PROSE, so it must honor the
// same fence as the raw .rvf stores, or a private repo's write-up could ship even though its vectors
// are excluded. FAIL-CLOSED, same contract as build-bundle.mjs: a present-but-corrupt fence aborts.
function loadPrivate() {
  const p = path.join(KB, 'PRIVATE-STORES.json');
  if (!fs.existsSync(p)) {
    if (process.env.ALLOW_NO_PRIVATE_FENCE === '1') return new Set();
    console.error(`[build-concepts] FATAL: private fence missing (${p}). Refusing to build the shipped ` +
      `concepts store without a verified fence. Set ALLOW_NO_PRIVATE_FENCE=1 only for a no-private fork.`);
    process.exit(1);
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(j.privateStores)) throw new Error('no privateStores array');
    return new Set(j.privateStores.map((s) => String(s).toLowerCase()));
  } catch (e) {
    console.error(`[build-concepts] FATAL: PRIVATE-STORES.json unreadable/corrupt (${e.message}). Refusing to build.`);
    process.exit(1);
  }
}
const PRIVATE = loadPrivate();
const isPrivate = (repo) => PRIVATE.has(String(repo).toLowerCase());

// PRIVATE SLUG set (QE-0011 security#1) — a private repo's L2 article is keyed by SLUG, not repo, and
// an unknown slug used to default to 'ruvnet' (fail-OPEN → it shipped). Read each private repo's own
// l2-topics.<repo>.json to learn its slugs, so an L2 article whose slug belongs to a private repo is
// fenced out even when its repo attribution is unknown. Fail-closed: if a private topics file exists
// but can't be parsed, abort rather than ship.
const PRIVATE_SLUGS = new Set();
for (const p of PRIVATE) {
  const tf = path.join(KB, `l2-topics.${p}.json`);
  if (!fs.existsSync(tf)) continue;
  try {
    for (const t of JSON.parse(fs.readFileSync(tf, 'utf8'))) if (t.slug) PRIVATE_SLUGS.add(t.slug);
  } catch (e) {
    console.error(`[build-concepts] FATAL: private topics file ${tf} is corrupt (${e.message}). Refusing to build.`);
    process.exit(1);
  }
}

// Auto-discover every repo that has a primer (skip PRIVATE ones — their prose must not ship).
const REPOS = fs.readdirSync(KB)
  .filter((f) => f.endsWith('-primer.md'))
  .map((f) => f.replace(/-primer\.md$/, ''))
  .filter((r) => !isPrivate(r))
  .sort();

// slug -> repo, from the per-repo l2-topics files (+ ruflo defaults that predate them)
const slugRepo = new Map([['guidance-mechanism', 'ruflo'], ['memory-end-to-end', 'ruflo'], ['adr-coverage', 'ruflo']]);
for (const r of REPOS) {
  const tf = path.join(KB, `l2-topics.${r}.json`);
  if (fs.existsSync(tf)) for (const t of JSON.parse(fs.readFileSync(tf, 'utf8'))) slugRepo.set(t.slug, r);
}

// ~3200-char paragraph-aligned chunks
function chunk(text, size = 3200) {
  const out = []; const paras = text.split(/\n\n+/); let buf = '';
  for (const p of paras) {
    if (buf && (buf.length + p.length + 2) > size) { out.push(buf); buf = ''; }
    buf += (buf ? '\n\n' : '') + p;
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [text];
}

const passages = [];           // {id, text, path, title}
const entries = {};            // id -> {path, kind, title, chunk, preview}
let id = 0;
function add(repo, kind, slug, title, text) {
  const chunks = chunk(text);
  chunks.forEach((c, i) => {
    const sid = String(id++);
    const p = `${repo}/${kind}/${slug}${chunks.length > 1 ? `#${i}` : ''}`;
    passages.push({ id: sid, text: c, path: p, title });
    entries[sid] = { path: p, kind: kind === 'PRIMER' ? 'doc' : 'doc', title, chunk: i, preview: c.slice(0, 200) };
  });
}

// 1) accepted L2 articles (skip kb/l2/rejected/)
let l2n = 0;
for (const f of fs.readdirSync(path.join(KB, 'l2'))) {
  if (!f.endsWith('.md')) continue;
  const slug = f.replace(/\.md$/, '');
  const repo = slugRepo.get(slug) || 'ruvnet';
  // Fence a private repo's L2 prose whether it's attributed by repo OR only recognizable by slug
  // (QE-0011 security#1 — closes the fail-open 'ruvnet' default for unknown attribution).
  if (isPrivate(repo) || PRIVATE_SLUGS.has(slug)) continue;
  const text = fs.readFileSync(path.join(KB, 'l2', f), 'utf8');
  const title = (text.match(/^#\s+(.+)/m) || [, slug])[1];
  add(repo, 'L2', slug, title, text); l2n++;
}

// 2) per-repo primers
let pn = 0;
for (const r of REPOS) {
  const pf = path.join(KB, `${r}-primer.md`);
  if (!fs.existsSync(pf)) { console.log(`  (no primer for ${r})`); continue; }
  add(r, 'PRIMER', `${r}-primer`, `${r} — Primer`, fs.readFileSync(pf, 'utf8')); pn++;
}

// 3) capability cards — short, capability-phrased, one per building block. These are the high-signal
// passages that let a BY-DESCRIPTION query ("what caches vector queries?") rerank to the right repo
// even when the user never names it. Each card is attributed to its repo via the path prefix.
let cn = 0;
const cardsFile = path.join(KB, 'capability-cards.md');
if (fs.existsSync(cardsFile)) {
  const raw = fs.readFileSync(cardsFile, 'utf8');
  for (const sec of raw.split(/^##\s+/m).slice(1)) {
    const nl = sec.indexOf('\n');
    if (nl < 0) continue;
    const repo = sec.slice(0, nl).trim();
    const body = sec.slice(nl + 1).trim();
    if (!repo || !body) continue;
    if (isPrivate(repo)) continue; // QE-0011 security#1: fence a private repo's capability card too
    add(repo, 'CARD', `${repo}-card`, `${repo} — Capability`, `${repo} — ${body}`);
    cn++;
  }
}

fs.writeFileSync(path.join(KB, 'concepts.passages.jsonl'), passages.map((p) => JSON.stringify(p)).join('\n') + '\n');
fs.writeFileSync(path.join(KB, 'concepts.meta.json'), JSON.stringify({
  model: 'concepts', dimensions: 0, metric: 'cosine', name: 'concepts',
  generated: new Date().toISOString(), repo: 'ruvnet-concepts',
  note: 'L2 synthesis + per-repo primers; embedded into concepts.big.rvf via forge-big.',
  entries,
}, null, 2));
console.log(`concepts: ${l2n} L2 articles + ${pn} primers + ${cn} capability cards → ${passages.length} passages → kb/concepts.passages.jsonl`);
console.log('next: node kb/forge-big.mjs both --dir kb --name concepts   (builds concepts.big.rvf)');
