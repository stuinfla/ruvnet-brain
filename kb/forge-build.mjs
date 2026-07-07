#!/usr/bin/env node
// forge-build.mjs — GENERALIZED RVF knowledge-base builder (rvf-kb-forge skill).
//
// Walks the WHOLE source tree of any repo, categorizes every file, chunks text at ~4000
// chars, embeds with local MiniLM (Xenova/all-MiniLM-L6-v2, 384-dim, mean+normalize, cosine),
// ingests vectors into a <kb>.rvf store, AND — critically — writes the FULL chunk text to
// <kb>.passages.jsonl keyed by the SAME id used in the .rvf. The .rvf query() returns only
// {id, distance}; the human/AI-readable TEXT comes from the passages join. If you skip the
// passages sidecar you ship a teaser, not knowledge — that is the exact bug this skill exists
// to prevent.
//
// Usage:
//   node forge-build.mjs --repo <repo-path> --out <output-dir> --name <kb-name> [--full <glob,glob>]
//
//   --repo  absolute path to the repo (or subtree) to index
//   --out   directory to write <name>.rvf, <name>.passages.jsonl, <name>.meta.json
//   --name  KB name / filename prefix (e.g. "myrepo")
//   --full  comma-separated path prefixes (relative to repo) whose .rs/.ts/.py/.js source
//           files get indexed in FULL body (engines, CLIs, command handlers). Optional.
//
// Env: KB_REPO_ROOT (overrides --repo), KB_MODEL_CACHE (model cache dir), KB_DEBUG.
//
// Outputs (in --out):
//   <name>.rvf                 vector store (HNSW, cosine, 384-dim)
//   <name>.rvf.idmap.json      store-internal id map (written by @ruvector/rvf)
//   <name>.passages.jsonl      FULL TEXT per id  {id,text,path,title}  <- the join target
//   <name>.meta.json           { model, dimensions, metric, generated, entries:{id:{path,kind,title,chunk,preview}} }

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRvf, loadTransformers, configureModel } from './resolve-deps.mjs';

// Best-effort git provenance of the repo being indexed (for the evergreen SOURCE.json).
function gitInfo(repoDir) {
  const run = (args) => {
    try { return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' }).trim(); }
    catch { return null; }
  };
  return {
    sha: run(['rev-parse', 'HEAD']),
    describe: run(['describe', '--tags', '--always']),
    remote: run(['config', '--get', 'remote.origin.url']),
  };
}

// ---------- args ----------
function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const REPO = process.env.KB_REPO_ROOT || arg('--repo');
const OUT_DIR = arg('--out');
const NAME = arg('--name');
const FULL_PREFIXES = (arg('--full', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
// Canonical host where THIS deployment will serve the live manifest + bundle (for the EVERGREEN
// self-updater). Differs per deployment, so it's a flag. Trailing slash optional. When omitted,
// SOURCE.json is still written with null URLs (provenance only; self-update disabled until set).
const CANONICAL_URL = (arg('--canonical-url', '') || '').replace(/\/+$/, '');
if (!REPO || !OUT_DIR || !NAME) {
  console.error('Usage: node forge-build.mjs --repo <repo> --out <dir> --name <kb-name> [--full a,b] [--canonical-url https://host/path/to/kb]');
  process.exit(2);
}
const R = path.resolve(REPO);
if (!fs.existsSync(R)) { console.error(`repo not found: ${R}`); process.exit(2); }
fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT_RVF = path.join(OUT_DIR, `${NAME}.rvf`);
const OUT_PASSAGES = path.join(OUT_DIR, `${NAME}.passages.jsonl`);
const OUT_META = path.join(OUT_DIR, `${NAME}.meta.json`);

const { mod: rvfMod, via: rvfVia } = loadRvf();
const { RvfDatabase } = rvfMod;
console.log('[forge] repo:', R);
console.log('[forge] out :', OUT_DIR, '| name:', NAME);
console.log('[forge] @ruvector/rvf via:', rvfVia);

// ---------- enumeration ----------
// Excluded directories (noise, not knowledge) — reported so the census is honest.
const SKIP_DIRS = new Set([
  'node_modules', 'target', '.git', 'dist', 'build', '.next', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', '.vite', 'vendor', 'v2',
]);
const SKIP_NAME_RE = /\.(min\.js|min\.css|lock)$/;          // minified / lockfiles
const PLATFORM_STUB_RE = /\/npm\/[^/]+\/package\.json$/;     // per-platform prebuilt stub
const VENDORED_RE = /(^|\/)(stub|pkg|\.vite|dist)(\/|$)/;
const excluded = { dirs: new Set(), files: 0, reasons: {} };

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
  catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) { excluded.dirs.add(e.name); continue; }
      yield* walk(p);
    } else if (e.isFile()) {
      yield p;
    }
  }
}
const rel = (p) => path.relative(R, p);
const read = (p) => fs.readFileSync(p, 'utf8');
const tryRead = (p) => { try { return read(p); } catch { return null; } };
const firstLines = (s, n) => s.split('\n').slice(0, n).join('\n');
function titleOf(text, fallback) {
  const m = text.match(/^#\s+(.+)$/m);
  return (m ? m[1] : fallback).slice(0, 200).trim();
}
// leading //! (Rust) / """ (Python) / leading-comment doc block from first N lines
function docBlock(text, n = 30) {
  const lines = text.split('\n').slice(0, n);
  const rust = lines.filter((l) => /^\s*\/\/!/.test(l)).map((l) => l.replace(/^\s*\/\/!\s?/, ''));
  if (rust.length) return rust.join('\n').trim();
  // JS/TS/Py: capture a leading block comment or # docstring header
  const jsdoc = lines.filter((l) => /^\s*(\*|\/\*\*|\/\/|#)/.test(l)).map((l) => l.replace(/^\s*(\*|\/\*\*|\/\/|#)\s?/, ''));
  return jsdoc.join('\n').trim();
}
function htmlText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const SRC_EXT = new Set(['.rs', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.c', '.cpp', '.h', '.hpp', '.java', '.rb', '.swift', '.kt']);

// ---------- STEP 1: CENSUS (the whole tree) ----------
// Count every file by category. This census is the scoring denominator.
const allFiles = [...walk(R)];
const census = {};               // category -> count
const categoryFor = (p) => {
  const rp = rel(p);
  const base = path.basename(p);
  const ext = path.extname(p).toLowerCase();
  if (SKIP_NAME_RE.test(base)) return null;
  if (base === 'Cargo.toml') return 'manifest';
  if (base === 'package.json') {
    if (PLATFORM_STUB_RE.test(rp) || VENDORED_RE.test(rp)) return null;
    return 'manifest';
  }
  if (base === 'SKILL.md') return 'skill';
  if (ext === '.md') {
    if (/adr/i.test(rp)) return 'adr';
    if (/ddd|domain/i.test(rp)) return 'ddd';
    if (/research/i.test(rp)) return 'research';
    if (/tutorial|guide/i.test(rp)) return 'tutorial';
    return 'doc';
  }
  if (ext === '.txt' || ext === '.rst') return 'doc';
  if (ext === '.html') return 'ui';
  if (SRC_EXT.has(ext)) return 'source';
  if (['.json', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf'].includes(ext)) return 'config';
  return 'other';
};
for (const f of allFiles) {
  const c = categoryFor(f);
  if (c === null) { excluded.files++; continue; }
  census[c] = (census[c] || 0) + 1;
}

console.log('\n=== STEP 1: CENSUS (every file in the tree, by category) ===');
console.log(JSON.stringify(census, null, 2));
console.log('total files walked:', allFiles.length, '| excluded (stubs/minified/lockfiles):', excluded.files);
console.log('excluded dirs encountered:', [...excluded.dirs].join(', ') || '(none)');

// ---------- STEP 2: READ & INGEST (FULL TEXT) ----------
const docsFiles = [];   // {path, kind, title, text}
const counts = {};
const ingested = new Set(); // absolute paths already in corpus
function add(kind, relpath, title, text, absPath) {
  counts[kind] = (counts[kind] || 0) + 1;
  docsFiles.push({ path: relpath, kind, title, text });
  if (absPath) ingested.add(absPath);
}
const isFull = (p) => FULL_PREFIXES.some((pre) => rel(p).startsWith(pre));

// 2a. Every markdown / text / rst — FULL text, tagged.
for (const f of allFiles) {
  if (ingested.has(f)) continue;
  const ext = path.extname(f).toLowerCase();
  if (!['.md', '.txt', '.rst'].includes(ext)) continue;
  const rp = rel(f);
  const text = read(f);
  let kind = 'doc';
  if (/adr/i.test(rp)) kind = 'adr';
  else if (/ddd|domain/i.test(rp)) kind = 'ddd';
  else if (/research/i.test(rp)) kind = 'research';
  else if (/tutorial|guide/i.test(rp)) kind = 'tutorial';
  else if (path.basename(f) === 'SKILL.md') kind = 'skill';
  add(kind, rp, titleOf(text, path.basename(f)), text, f);
}

// 2b. Manifests — Cargo.toml + package.json summaries (name/desc/deps/scripts/members).
for (const f of allFiles) {
  if (ingested.has(f)) continue;
  const base = path.basename(f);
  const rp = rel(f);
  if (base === 'Cargo.toml') {
    const t = read(f);
    const pkg = t.match(/^\[package\]([\s\S]*?)(?=^\[|\s*$(?![\s\S]))/m);
    const sec = pkg ? pkg[1] : '';
    const g = (k) => { const m = sec.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm')); return m ? m[1] : ''; };
    const name = g('name') || `${path.basename(path.dirname(f))} (workspace manifest)`;
    const members = (t.match(/members\s*=\s*\[([\s\S]*?)\]/m) || [, ''])[1]
      .split(/[\s,]+/).map((s) => s.replace(/["']/g, '')).filter(Boolean).join(', ');
    let text = `Rust crate / manifest: ${name}\nPath: ${rp}\n`;
    if (g('description')) text += `Description: ${g('description')}\n`;
    const kw = (sec.match(/^keywords\s*=\s*\[([^\]]*)\]/m) || [, ''])[1].replace(/"/g, '');
    if (kw) text += `Keywords: ${kw}\n`;
    if (members) text += `Workspace members: ${members}\n`;
    text += `\n${t}`;
    add('manifest', rp, name, text, f);
  } else if (base === 'package.json') {
    if (PLATFORM_STUB_RE.test(rp) || VENDORED_RE.test(rp)) { excluded.files++; continue; }
    try {
      const j = JSON.parse(read(f));
      const scripts = j.scripts ? Object.entries(j.scripts).map(([k, v]) => `  ${k}: ${v}`).join('\n') : '';
      const bin = j.bin ? (typeof j.bin === 'string' ? j.bin : Object.keys(j.bin).join(', ')) : '';
      const text = `npm package: ${j.name || rp}\nVersion: ${j.version || ''}\nPath: ${rp}\n`
        + `Description: ${j.description || ''}\n`
        + (bin ? `Bin: ${bin}\n` : '')
        + (j.type ? `Module type: ${j.type}\n` : '')
        + (scripts ? `Scripts:\n${scripts}\n` : '')
        + (j.dependencies ? `Dependencies: ${Object.keys(j.dependencies).join(', ')}\n` : '')
        + (j.devDependencies ? `DevDependencies: ${Object.keys(j.devDependencies).join(', ')}\n` : '')
        + `Keywords: ${(j.keywords || []).join(', ')}`;
      add('manifest', rp, j.name || rp, text, f);
    } catch { add('manifest', rp, rp, `npm package manifest (unparseable JSON) at ${rp}`, f); }
  }
}

// 2c. Source files — FULL body for --full prefixes; lead doc-comment + first 100 lines for
//     a crate/module lead file; leading doc-comment (first 30 lines) for everything else.
const cargoDirs = new Set(
  allFiles.filter((p) => path.basename(p) === 'Cargo.toml').map((p) => path.dirname(p))
);
const leadFiles = new Set();
for (const cdir of cargoDirs) {
  const lead = ['src/lib.rs', 'src/main.rs'].map((f) => path.join(cdir, f)).find((p) => fs.existsSync(p));
  if (lead) leadFiles.add(lead);
}
// Source files deliberately NOT ingested (no doc comment, not a lead, not --full). Recorded so
// Step 7's census-diff can EXCLUDE them from the denominator transparently instead of docking
// coverage forever. To ingest one, add its prefix to --full.
const intentionallySkipped = [];
for (const p of allFiles) {
  if (ingested.has(p)) continue;
  const ext = path.extname(p).toLowerCase();
  if (!SRC_EXT.has(ext)) continue;
  const rp = rel(p);
  const text = read(p);
  if (isFull(p)) {
    add('source', rp, path.basename(p), `Source ${rp} (full body):\n${text}`, p);
  } else if (leadFiles.has(p)) {
    const doc = docBlock(text, 200);
    add('source', rp, `${path.basename(path.dirname(path.dirname(p)))} ${path.basename(p)}`,
      `Crate lead ${rp} — leading doc + first 100 lines:\n` + (doc ? `/* doc */\n${doc}\n\n` : '') + firstLines(text, 100), p);
  } else {
    const doc = docBlock(firstLines(text, 30));
    if (!doc) { intentionallySkipped.push(rp); continue; } // no doc comment -> low signal; record it
    add('source', rp, path.basename(p), `Module ${rp} — doc comment:\n${doc}`, p);
  }
}
// 2c-ii. Per-crate module-inventory entries (file names under src/).
for (const cdir of cargoDirs) {
  const srcDir = path.join(cdir, 'src');
  if (!fs.existsSync(srcDir)) continue;
  const mods = [...walk(srcDir)].filter((p) => SRC_EXT.has(path.extname(p))).map((p) => path.relative(srcDir, p)).sort();
  if (!mods.length) continue;
  const relDir = rel(cdir) || '.';
  add('source', `${relDir}/src`, `${path.basename(cdir)} modules`,
    `Crate ${path.basename(cdir)} (${relDir}) modules: ${mods.join(', ')}`);
}

// 2d. HTML UI pages — full visible text.
for (const p of allFiles) {
  if (ingested.has(p) || path.extname(p).toLowerCase() !== '.html') continue;
  const text = htmlText(read(p));
  if (text) add('ui', rel(p), path.basename(p), `UI page ${rel(p)} full text content:\n${text}`, p);
}

// 2e. Generic config files — the .json/.toml/.yaml/.yml/.ini/.cfg/.conf that the Step-1
//     census counts as 'config' but which are NOT manifests (Cargo.toml/package.json handled
//     in 2b). Ingest the full body (capped) so the corpus matches the census denominator —
//     otherwise Step 7's census-diff can never reach the threshold and loops forever.
//     Cap at CONFIG_MAX chars to avoid huge generated/lockfile-like configs dominating the index.
const CONFIG_EXT = new Set(['.json', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf']);
const CONFIG_MAX = 12000;
for (const p of allFiles) {
  if (ingested.has(p)) continue;
  const ext = path.extname(p).toLowerCase();
  if (!CONFIG_EXT.has(ext)) continue;
  const base = path.basename(p);
  const rp = rel(p);
  if (SKIP_NAME_RE.test(base)) continue;                 // lockfiles already excluded by census
  if (PLATFORM_STUB_RE.test(rp) || VENDORED_RE.test(rp)) continue; // per-platform stubs
  const raw = tryRead(p);
  if (raw == null) continue;
  const text = raw.length > CONFIG_MAX ? raw.slice(0, CONFIG_MAX) + '\n... [truncated config preview]' : raw;
  add('config', rp, base, `Config ${rp}:\n${text}`, p);
}

// ---------- chunking (~1000 tokens ~= 4000 chars, paragraph-aligned, 400-char overlap) ----------
const MAX = 4000;
const OVERLAP = 400;
function chunkText(text) {
  if (text.length <= MAX) return [text];
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + MAX, text.length);
    if (end < text.length) {
      const para = text.lastIndexOf('\n\n', end);
      if (para > i + MAX / 2) end = para;
    }
    out.push(text.slice(i, end));
    if (end >= text.length) break;
    i = end - OVERLAP;
  }
  return out;
}

const chunks = []; // {id, path, kind, title, chunk, of, embedText, text, preview}
let nextId = 1;
for (const d of docsFiles) {
  // Drop empty/whitespace-only chunks: an empty source file (e.g. a placeholder
  // .txt or an empty mod.rs) would otherwise emit a blank passage and trip
  // forge-guard's empty-text check. Filtering before the map keeps chunk/of numbering
  // consistent; a fully-empty file simply contributes zero chunks (not indexed).
  const parts = chunkText(d.text).filter((p) => p && p.trim());
  parts.forEach((p, i) => {
    chunks.push({
      id: String(nextId++),
      path: d.path, kind: d.kind, title: d.title, chunk: i + 1, of: parts.length,
      embedText: `${d.title} — ${d.path}\n${p}`.slice(0, MAX + 300),
      text: p,                                  // FULL untruncated chunk for the passages sidecar
      preview: p.trim().slice(0, 200).replace(/\s+/g, ' '),
    });
  });
}

console.log('\n=== STEP 2: CORPUS (files per kind ingested) ===');
console.log(JSON.stringify(counts, null, 2));
const coveredPaths = new Set(docsFiles.map((d) => d.path)).size;
console.log('distinct source paths covered:', coveredPaths, '| total chunks:', chunks.length);

// Guard against a vacuous build: 0 chunks means the repo path is wrong, empty, or fully
// excluded. Reporting "MATCH = true" on an empty KB would look like success — fail loudly.
if (chunks.length === 0) {
  console.error('\n[forge] ERROR: 0 chunks produced — nothing to index. Check --repo path, that '
    + 'the tree is not entirely excluded (node_modules/target/etc.), and that it contains '
    + 'docs/source/manifests/config. Aborting before writing an empty KB.');
  process.exit(3);
}

// ---------- embeddings + ingest ----------
const { T, modelCache: MODEL_CACHE, via: tVia } = await loadTransformers();
const { haveLocalModel } = configureModel(T, MODEL_CACHE);
console.log('\n[forge] transformers via:', tVia);
console.log('[forge] embedder:', haveLocalModel ? `local cache ${MODEL_CACHE}` : `remote download (cache ${MODEL_CACHE})`);
// MODEL-WEIGHT PIN: address MiniLM by an exact HuggingFace commit SHA rather than the floating
// `main` branch, so every rebuild yields byte-identical 384-dim vectors to the shipped corpus
// (verified live against the HF Hub API; main HEAD unchanged since 2025-07-22). Offline-first is
// preserved — configureModel() above resolves an already-cached model via env.localModelPath
// regardless of revision, so this never re-downloads a cached model, only pins the first fetch.
const MINILM_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const embed = await T.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true, revision: MINILM_REVISION });

fs.rmSync(OUT_RVF, { force: true });
fs.rmSync(OUT_RVF + '.idmap.json', { force: true });
const db = await RvfDatabase.create(OUT_RVF, { dimensions: 384, metric: 'cosine' });

// Full-text passages sidecar — one JSON object per line {id,text,path,title}. SAME id as the
// vector in the .rvf and in meta — so retrieval can JOIN. THIS is the non-negotiable file.
fs.rmSync(OUT_PASSAGES, { force: true });
const fd = fs.openSync(OUT_PASSAGES, 'w');
let passageLines = 0;
const meta = {};
const BATCH = 48;
let accepted = 0, rejected = 0;
const t0 = Date.now();
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const out = await embed(batch.map((c) => c.embedText), { pooling: 'mean', normalize: true });
  const dim = out.dims[1];
  const ingestBatch = batch.map((c, j) => {
    fs.writeSync(fd, JSON.stringify({ id: c.id, text: c.text, path: c.path, title: c.title }) + '\n');
    passageLines++;
    meta[c.id] = { path: c.path, kind: c.kind, title: c.title, chunk: `${c.chunk}/${c.of}`, preview: c.preview };
    return {
      id: c.id,
      vector: Array.from(out.data.slice(j * dim, (j + 1) * dim)),
      metadata: { path: c.path, kind: c.kind, title: c.title.slice(0, 120), chunk: c.chunk },
    };
  });
  const r = await db.ingestBatch(ingestBatch);
  accepted += r.accepted; rejected += r.rejected;
  if ((i / BATCH) % 20 === 0) {
    const rate = (i + batch.length) / ((Date.now() - t0) / 1000);
    console.log(`progress ${i + batch.length}/${chunks.length} (${rate.toFixed(1)}/s, accepted=${accepted}, rejected=${rejected})`);
  }
}
fs.closeSync(fd);
console.log(`\ningest done: accepted=${accepted} rejected=${rejected} in ${((Date.now() - t0) / 1000).toFixed(0)}s | passages lines: ${passageLines}`);

const status = await db.status();
console.log('RVF status:', JSON.stringify(status));
console.log('Reconcile: chunks =', chunks.length, '| vectors =', status.totalVectors,
  '| passages lines =', passageLines, '| meta ids =', Object.keys(meta).length,
  '| MATCH =', chunks.length === status.totalVectors && passageLines === chunks.length && Object.keys(meta).length === chunks.length);

// verification queries on the live handle (sanity only; the real proof is the 10-question test)
await db.close();

fs.writeFileSync(OUT_META, JSON.stringify({
  model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, metric: 'cosine',
  generated: new Date().toISOString(),
  repo: R, name: NAME,
  census, corpusCounts: counts, coveredPaths,
  intentionallySkipped,   // doc-comment-less source files Step 7 excludes from the denominator
  entries: meta,
}));
console.log('meta written:', OUT_META);

// Query-side embedder config for THIS .rvf — so forge-ask reads the SAME model the corpus used.
// The small (default) build is MiniLM: mean pooling, no query prefix (symmetric). The big build
// (forge-big.mjs) writes its own <name>.big.rvf.embed.json with the bge model + queryPrefix.
fs.writeFileSync(OUT_RVF + '.embed.json', JSON.stringify({
  model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, metric: 'cosine',
  pooling: 'mean', normalize: true, queryPrefix: '',
  note: 'Small (edge/Seed-compatible) variant. Symmetric: passages and queries embedded the same way.',
  builtFrom: path.basename(OUT_PASSAGES), generated: new Date().toISOString(),
}, null, 2) + '\n');
console.log('embed.json written:', OUT_RVF + '.embed.json');
console.log('rvf size:', fs.statSync(OUT_RVF).size, 'bytes');

// ---- EVERGREEN: write SOURCE.json (embedded provenance + canonical URLs) ----
// Ships in the bundle alongside forge-update.mjs so a copied KB can self-update later.
{
  const builtUtc = new Date().toISOString();
  const g = gitInfo(R);
  const base = CANONICAL_URL || null;
  const source = {
    builder: 'rvf-kb-forge',
    builtUtc,
    canonicalManifestUrl: base ? `${base}/.last-built.json` : null,
    selfUpdate: 'node forge-update.mjs',
    stores: {
      [NAME]: {
        kbName: NAME,
        sourceRepo: g.remote || R,
        sourceCommit: g.sha || null,
        sourceDescribe: g.describe || null,
        builtUtc,
        builder: 'rvf-kb-forge',
        canonicalManifestUrl: base ? `${base}/.last-built.json` : null,
        canonicalBundleUrl: base ? `${base}/${NAME}-kb-bundle.zip` : null,
        selfUpdate: `node forge-update.mjs ${NAME}`,
      },
    },
  };
  const OUT_SOURCE = path.join(OUT_DIR, 'SOURCE.json');
  fs.writeFileSync(OUT_SOURCE, JSON.stringify(source, null, 2) + '\n');
  console.log('SOURCE.json written:', OUT_SOURCE, base ? `(canonical: ${base})` : '(no --canonical-url; self-update disabled)');
}

console.log('\n=== STEP 2 COMPLETE — run forge-guard.mjs next ===');
