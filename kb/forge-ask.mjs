#!/usr/bin/env node
// forge-ask.mjs — self-contained CLI to query an rvf-kb-forge knowledge base and print the
// FULL top-k passages (not previews). Joins .rvf vector hits to the full-text passages
// sidecar (<name>.passages.jsonl) by id.
//
// Usage:
//   node forge-ask.mjs --dir <kb-dir> --name <kb-name> --q "your question" [--k 6]
//   node forge-ask.mjs <kb-dir> <kb-name> "your question" [k]        (positional form)
//
// Deps: @ruvector/rvf + @xenova/transformers, resolved PORTABLY (see resolve-deps.mjs:
// KB node_modules first, then env, then author paths) + the bundled <name>.rvf and
// <name>.passages.jsonl. So `cd <kb-dir> && npm i` then run. Model cache configurable via
// KB_MODEL_CACHE (offline if cached, else downloads MiniLM from HuggingFace).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadRvf, loadTransformers, configureModel } from './resolve-deps.mjs';

const { mod: rvfMod, via: rvfVia } = loadRvf();
const { RvfDatabase } = rvfMod;
if (process.env.KB_DEBUG) console.error(`[forge-ask] @ruvector/rvf via: ${rvfVia}`);

// ---------- TWO-VARIANT store resolution (mirrors Cognitum ask-kb resolveConf/variantPaths) ----------
// A forged KB may ship TWO builds from the SAME passages (identical content, different embedder):
//   small (384-dim MiniLM)  — the default; edge/Seed-compatible; files: <name>.rvf
//   big   (768-dim bge)     — sharper, Mac/PC;                    files: <name>.big.rvf
// One tool serves both: the embedder for a query is read from the <rvf>.embed.json sidecar the
// build wrote next to each .rvf, so a query is ALWAYS embedded with the SAME model the corpus was.
// Absent that sidecar we fall back to MiniLM (the small build). Variant defaults to 'big' when a
// big build is present (best answers), else 'small' — so a small-only checkout still works and a
// Mac bundle auto-uses the sharp one.
const MINILM_CFG = { model: 'Xenova/all-MiniLM-L6-v2', pooling: 'mean', normalize: true, queryPrefix: '' };

// ---------- MODEL-WEIGHT PIN (supply-chain / reproducibility) ----------
// @xenova/transformers loads ONNX model weights from HuggingFace addressed by git `revision`. The
// library DEFAULT is the floating `main` branch, so an upstream re-publish could silently ship
// different weights and thereby shift EVERY query embedding — de-aligning queries from the pre-built
// corpus and quietly degrading answers with no error. We therefore pin each embedder to the EXACT
// commit SHA the shipped corpus was built against (verified live against the HF Hub API).
//   Xenova/all-MiniLM-L6-v2  384-dim (small build)  main HEAD unchanged since 2025-07-22
//   Xenova/bge-base-en-v1.5  768-dim (big build)    main HEAD unchanged since 2025-07-29
// Offline-first is fully preserved: transformers.js resolves an already-cached model from
// `env.localModelPath` WITHOUT consulting the revision (hub.js builds localPath from repo/filename
// only), so a pinned SHA never forces a re-download of a model that is already local — it only makes
// the FIRST remote download on a fresh machine deterministic. A model not in this map falls back to
// `main` (unpinned) rather than failing, so custom/extra embedders still load.
const PINNED_REVISIONS = {
  'Xenova/all-MiniLM-L6-v2': '751bff37182d3f1213fa05d7196b954e230abad9',
  'Xenova/bge-base-en-v1.5': '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
};

function variantPaths(dir, name, variant) {
  const tag = variant === 'big' ? '.big' : '';
  const rvf = path.join(dir, `${name}${tag}.rvf`);
  return {
    rvf,
    passages: path.join(dir, `${name}${tag}.passages.jsonl`),
    embedCfgPath: `${rvf}.embed.json`,
  };
}
function resolveConf(dir, name, variant) {
  if (variant !== 'big' && variant !== 'small') {
    variant = fs.existsSync(path.join(dir, `${name}.big.rvf`)) ? 'big' : 'small';
  }
  const p = variantPaths(dir, name, variant);
  let embedCfg = { ...MINILM_CFG };
  if (fs.existsSync(p.embedCfgPath)) {
    try { embedCfg = { ...MINILM_CFG, ...JSON.parse(fs.readFileSync(p.embedCfgPath, 'utf8')) }; }
    catch (e) { if (process.env.KB_DEBUG) console.error(`[forge-ask] bad embed.json (${p.embedCfgPath}): ${e.message}`); }
  }
  return { ...p, embedCfg, variant };
}

// ---------- embedder (lazy, per-model, offline-first with remote fallback) ----------
// Cached PER MODEL NAME so one process can serve both the small (MiniLM) and big (bge) builds
// without reloading. Remote download is allowed only when THAT model isn't already cached.
const _feCache = new Map();
async function getEmbedder(model) {
  if (_feCache.has(model)) return _feCache.get(model);
  const { T, modelCache, via } = await loadTransformers();
  T.env.localModelPath = modelCache;
  // Local-first network guard: a remote fetch is permitted ONLY when THIS model is not already
  // cached locally (offline once cached). When a fetch does happen it is pinned to the exact
  // revision below, so the weights can never silently change under us.
  T.env.allowRemoteModels = !fs.existsSync(path.join(modelCache, model));
  const revision = PINNED_REVISIONS[model] || 'main';
  if (process.env.KB_DEBUG) console.error(`[forge-ask] transformers via: ${via} | model ${model}@${revision} | cache: ${modelCache} (${T.env.allowRemoteModels ? 'remote' : 'local'})`);
  const fe = await T.pipeline('feature-extraction', model, { quantized: true, revision });
  _feCache.set(model, fe);
  return fe;
}
// Embed a QUERY with the build's embedder config. bge-style builds carry a queryPrefix (asymmetric
// retrieval — passages embedded with NO prefix at build time, queries get the instruction prefix
// here); MiniLM uses no prefix + mean pooling.
async function embed(text, cfg = MINILM_CFG) {
  const fe = await getEmbedder(cfg.model || MINILM_CFG.model);
  const out = await fe([(cfg.queryPrefix || '') + text], {
    pooling: cfg.pooling || 'mean',
    normalize: cfg.normalize !== false,
  });
  return Float32Array.from(out.data);
}

// ---------- passages sidecar loader ----------
// byId  : Map id(str) -> { id(num), text, path, title }
// byPath: Map path     -> [records] sorted by numeric id (== document chunk order)
function loadPassages(file) {
  return new Promise((resolve, reject) => {
    const byId = new Map();
    const byPath = new Map();
    if (!fs.existsSync(file)) return reject(new Error(`passages sidecar not found: ${file}`));
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const o = JSON.parse(line);
        const rec = { id: Number(o.id), text: o.text || '', path: o.path || '(unknown path)', title: o.title || '(unknown title)' };
        byId.set(String(o.id), rec);
        if (!byPath.has(rec.path)) byPath.set(rec.path, []);
        byPath.get(rec.path).push(rec);
      } catch { /* skip malformed line */ }
    });
    rl.on('close', () => { for (const arr of byPath.values()) arr.sort((a, b) => a.id - b.id); resolve({ byId, byPath }); });
    rl.on('error', reject);
  });
}

// ---------- kind metadata sidecar loader ----------
// The passages sidecar carries only {id,text,path,title}. The per-chunk `kind`
// (source / crate-src / adr / doc / doc-deep / primer-orientation / …) lives in the build
// metadata sidecar (<name>.ids.json or <name>.meta.json) keyed by the same numeric id. The
// intent layer (code-vs-doc routing, ADR-vs-code pairing, PRIMER discovery) needs `kind`, so we
// load it once and fold it to a per-PATH kind. Missing sidecar -> empty map -> graceful degrade
// (no kind-based adjustments; vector+rerank still works).
function findMetaFile(dir, name, variant) {
  const tag = variant === 'big' ? '.big' : '';
  const cands = [
    path.join(dir, `${name}${tag}.ids.json`), path.join(dir, `${name}${tag}.meta.json`),
    path.join(dir, `${name}.ids.json`), path.join(dir, `${name}.meta.json`), // fall back to small's
  ];
  for (const f of cands) if (fs.existsSync(f)) return f;
  return null;
}
function loadKinds(file) {
  const byPathKind = new Map(); // path -> dominant kind
  try {
    if (!file || !fs.existsSync(file)) return byPathKind;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = j.entries || {};
    const counts = new Map();
    for (const v of Object.values(entries)) {
      if (!v || !v.path || !v.kind) continue;
      if (!counts.has(v.path)) counts.set(v.path, new Map());
      const m = counts.get(v.path);
      m.set(v.kind, (m.get(v.kind) || 0) + 1);
    }
    for (const [p, m] of counts) {
      let best = null, bestN = -1;
      for (const [kind, n] of m) { if (n > bestN) { best = kind; bestN = n; } }
      byPathKind.set(p, best);
    }
  } catch { /* unreadable -> empty map */ }
  return byPathKind;
}
const SOURCE_KINDS = new Set(['source', 'crate-src', 'example']);
function isSourceKind(kind) { return SOURCE_KINDS.has(kind); }

// ---------- per-KB cache (passages, kind metadata, crate tokens, the open HNSW handle) ----------
// The KB on disk is immutable for the life of a long-lived MCP server process, but searchKb() re-read
// + re-parsed the passages/meta sidecars AND reopened the .rvf on every single call. Cached PER
// `dir|name|variant` (same keying style as _feCache/_symCache above) so a hot KB is loaded once and
// every subsequent query in this process reuses it. The db handle is intentionally left open for the
// life of the process (never closed) — same lifetime assumption as the embedder cache above.
const _kbCache = new Map();
function getKb(dir, name, conf) {
  const key = `${dir}|${name}|${conf.variant}`;
  if (_kbCache.has(key)) return _kbCache.get(key);
  const entry = (async () => {
    const [{ byId, byPath }, db] = await Promise.all([
      loadPassages(conf.passages),
      RvfDatabase.openReadonly(conf.rvf),
    ]);
    const byPathKind = loadKinds(findMetaFile(dir, name, conf.variant));
    const crateTokens = crateTokenSet(byPath);
    return { byId, byPath, byPathKind, crateTokens, db };
  })();
  entry.catch(() => _kbCache.delete(key)); // don't let a failed load poison the cache permanently
  _kbCache.set(key, entry);
  return entry;
}

// ===================================================================================
// Retrieval-quality layer (retrieval-only; the KB is NOT rebuilt). Returns whole, self-
// contained DOCUMENTS instead of single chunk fragments, demotes low-signal files, and
// boosts exact ADR-id / title-token matches. Mirrors the Cognitum KB tuning.
// ===================================================================================
const MAX_DOC_CHARS = 12000;
const RAW_HITS = 24;
const PRIMER_PATH_RE = /^PRIMER#/;

// ---------- SPECIFIC-ENTITY DETECTION (mirrors Cognitum ask-kb FIX 1) ----------
// A query that names a SPECIFIC entity (a crate, an ADR id, a filename/.rs token, or a Capitalized
// multiword proper noun) is NOT a generic product-orientation question even if it starts "what
// does …". For such a query we suppress the generic PRIMER-orientation lift / force-route AND demote
// primer-orientation docs so a vector-closer deep doc wins. The crate-INVENTORY archetype
// ("which crates…") is exempt (no hyphen-crate token). Crate tokens are discovered from the KB so
// the detector never fires on generic words like "end-to-end".
function crateTokenSet(byPath) {
  const set = new Set();
  for (const p of byPath.keys()) {
    const m = p.match(/(?:^|\/)(?:v\d+\/)?crates\/([a-z0-9][a-z0-9-]+)/i);
    if (m) set.add(m[1].toLowerCase());
  }
  return set;
}
const PROPER_NOUN_RE = /\b([A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,})\b/g;
const FILE_TOKEN_RE = /\b[a-z0-9_]+\.(rs|toml|md|ts|js|mjs|py|json|yaml|yml)\b/i;
// Common English / orientation words that may appear Title-Cased ("How Complete Is RuVector",
// "Getting Started Guide") — a proper-noun candidate built ONLY from these is NOT a named entity, so
// Title-Cased orientation queries still route correctly.
const COMMON_TITLE_WORDS = new Set(['how','what','when','where','why','which','who','is','are','the','a','an',
  'and','or','of','to','in','for','on','with','do','does','complete','mature','maturity','production',
  'ready','overview','introduction','getting','started','start','guide','setup','install','use','using',
  'core','capabilities','capability','feature','features','concept','concepts','docs','documentation',
  'tutorial','tutorials','example','examples','crate','crates','inventory','about','it','this','that',
  'playbook','quickstart','end','reference']);
function specificEntity(query, crateTokens, productBase = '') {
  const hyphenTokens = (query.match(/\b[a-z][a-z0-9]+-[a-z0-9][a-z0-9-]*\b/gi) || []).map((t) => t.toLowerCase());
  const crates = hyphenTokens.filter((t) =>
    crateTokens.has(t) || [...crateTokens].some((c) => c.startsWith(t + '-') || t.startsWith(c)));
  // The KB's own product name is a "common word" too, so a Title-Cased product-only orientation
  // query ("What Is RuView") doesn't misfire as a named entity.
  const commonOf = (w) => COMMON_TITLE_WORDS.has(w) || (productBase && w === productBase);
  let hasProperNoun = false;
  for (const m of query.matchAll(PROPER_NOUN_RE)) {
    if (m[1].split(/\s+/).some((w) => !commonOf(w.toLowerCase()))) { hasProperNoun = true; break; }
  }
  const named = crates.length > 0 || /\badr[-\s_]?\d{1,4}\b/i.test(query) || FILE_TOKEN_RE.test(query) || hasProperNoun;
  return { named, crates };
}
const PRIMER_DEMOTE_WHEN_SPECIFIC = 0.60;

// FIX 2 — crate-overview / metric intent: "what does crate X do" / "X compression ratio /
// throughput / benchmark" should surface the crate's README/BENCHMARK/docs above its harness.
const CRATE_METRIC_RE = /\b(compression(\s+ratio)?|throughput|benchmark|latency|qps|recall|speed ?up|ops\/s|ratio|perf(ormance)?)\b/i;
const CRATE_OVERVIEW_RE = /\b(what (does|is)|overview of|tell me about|describe)\b/i;
function crateOverviewTarget(query, entityCrates) {
  if (!entityCrates || !entityCrates.length) return null;
  if (CRATE_METRIC_RE.test(query) || CRATE_OVERVIEW_RE.test(query)) return entityCrates[0];
  return null;
}
function crateOverviewAdjust(crateTok, p) {
  if (!crateTok) return 0;
  if (!new RegExp(`(?:^|/)(?:v\\d+/)?crates/${crateTok}(?:-[a-z0-9-]+)?/`, 'i').test(p)) return 0;
  let adj = 0;
  if (/\/(readme|benchmark)\.md$/i.test(p) || /\/docs\//i.test(p)) adj -= 0.45;
  if (/\/benches?\//i.test(p) || /\/main\.rs$/i.test(p)) adj += 0.20;
  if (/\/cargo\.toml$/i.test(p)) adj += 0.18;
  return adj;
}

// ---------- INTENT ROUTING LAYER (mirrors Cognitum ask-kb.mjs) ----------
// Deterministic intent classification on top of vector+rerank: (a) detect an orientation
// archetype and force-route to the matching PRIMER#<slug> — discovered AT RUNTIME from this KB's
// metadata sidecar so it works for any forged KB, not just Cognitum; (b) hard-route an exact
// "ADR-NNN" query to the real ADR doc (beating the index table); (c) tilt code-vs-doc ranking by
// intent; (d) pair an ADR proposal with its implementing source. Layered as effective-distance
// adjustments / rank overrides — no rebuild.

// Each archetype: a query detector + the regex that matches the corresponding PRIMER section's
// path/title (used to PICK the right discovered PRIMER slug). Ordered most-specific-first.
// `sec` matchers are ORDERED preference lists: the first that matches a discovered PRIMER picks it.
// They are intentionally narrow (e.g. maturity = "maturity/gotchas/graded honestly", NOT the word
// "complete" which collides with "complete crate inventory" / "complete REST API").
const ARCHETYPES = [
  { name: 'maturity',     q: /\b(mature|maturity|production[- ]?ready|production\b|how (good|solid|reliable|complete)|how complete|is it (ready|done|complete)|works?\b.*\b(experiment|stub|today|yet)|battle[- ]?tested|graded honestly)\b/i, sec: [/matur/i, /gotcha/i, /graded\s+honestly/i, /graded/i, /honest/i] },
  { name: 'capabilities', q: /\b(capabilit(y|ies)|what can it do|what can \w+ do|features?\b|what does it (do|offer)|big (capabilities|features))\b/i, sec: [/\bbig capabilit/i, /capabilit/i, /graded\s+honestly/i, /\bfeature/i] },
  { name: 'adr',          q: /\b(where (are|is|can i find|do i find).*adr|list of adrs?|adr index|complete adr)\b/i, sec: [/adr[- ]?index/i, /complete adr/i, /\badr\b.*\bindex\b/i] },
  { name: 'docs',         q: /\b(where (are|is|can i find|do i find).*(doc|documentation|tutorial|example|guide|find|live)|documentation\b|tutorials?\b|where everything lives|where.*\b(docs?|guides?)\b)\b/i, sec: [/where everything lives/i, /docs?,? tutorial/i, /\bdoc\b.*tutorial/i, /tutorial/i, /\bdocs\b/i] },
  // hardware / boards / devices — enumeration of supported physical hardware (KB may have no such
  // section -> routePrimer returns null and the query falls through to the vector pipeline).
  { name: 'hardware',     q: /\b(hardware|boards?|devices?|which (chip|board|sensor)|supported (hardware|board|device))\b/i, sec: [/hardware[- ]?matrix/i, /\bhardware\b/i, /\bboards?\b/i, /bill of materials/i] },
  // crate inventory — enumeration of the crates that make up the workspace / a domain. The section
  // matcher prefers the inventory PRIMER so it out-ranks individual source files for enumeration.
  { name: 'crates',       q: /\b(which crates|crate inventory|what crates|crates (that |which )?(make up|in|for|comprise)|list of crates|\w+ domain crates)\b/i, sec: [/crate[s]?[- ]?inventory/i, /the crates\b/i, /\bcrates\b.*\bworkspace\b/i, /\bcrates\b/i] },
  { name: 'playbook',     q: /\b(how (do i |to )?(use|set ?up|onboard|get started|getting started|start|deploy|build|run)|end[- ]to[- ]end|end to end|quick ?start|playbook|walkthrough|step[- ]by[- ]step|get up and running)\b/i, sec: [/instant playbook/i, /playbook/i, /executive summary/i, /quickstart/i, /get(ting)? started/i, /install/i] },
  { name: 'whatis',       q: /\b(what is|what'?s |overview of|introduce|introduction to|tell me about|difference between|role of)\b/i, sec: [/what .{0,12} is\b/i, /\bwhat is\b/i, /overview/i, /introduction/i] },
];
const SPECIFIC_SIGNAL_RE = /(\badr[-\s_]?\d|[a-z_]+\.[a-z]{1,4}\b|\bfn\b|\bstruct\b|\bimpl\b|::|\/|\b[a-z_]+\(\)|\bcrate::|\bsrc\b)/i;
// Strong playbook verbs — when present, the playbook route fires even for a long query (the
// word-count cap is bypassed). They signal an end-to-end "do this from scratch" walkthrough.
const STRONG_PLAYBOOK_RE = /\b(set ?up|end[- ]to[- ]end|get started|getting started|from scratch|walk ?through|unbox|first time|step by step)\b/i;
function isOrientationQuery(query) {
  if (!STRONG_PLAYBOOK_RE.test(query)) {       // bypass the cap for end-to-end playbook requests
    const words = (query.trim().match(/\S+/g) || []).length;
    if (words > 14) return false;
  }
  if (SPECIFIC_SIGNAL_RE.test(query)) return false;
  return true;
}
// Discover this KB's PRIMER section paths from the metadata kinds map.
function primerPaths(byPathKind) {
  const out = [];
  for (const [p, kind] of byPathKind) {
    if (kind === 'primer-orientation' || PRIMER_PATH_RE.test(p)) out.push(p);
  }
  return out;
}
// The KB's product name, inferred from the KB `name` (e.g. "ruvector-kb" -> /ruvector/). A what-is/
// concept query that names ONLY the product (no other concrete concept noun) is a product overview;
// one that names a concrete concept noun is a concept query (handled by routePrimer returning a
// non-routing flag below).
function productNameRe(name) {
  const base = String(name || '').replace(/[-_]?kb$/i, '').replace(/[^a-z0-9]+/gi, '');
  if (!base) return null;
  try { return new RegExp(`\\b${base}\\b`, 'i'); } catch { return null; }
}
// Is a what-is/concept query about the PRODUCT ITSELF (route to "what X is" PRIMER#1) vs about a
// CONCRETE concept noun (let vector+rerank find the defining doc)? Product-only: names the product
// with no other meaningful concept term, or is literally "what is this/it". (FIX 1, mirrors ask-kb)
function isProductOverviewQuery(query, prodRe) {
  const stripped = prodRe ? query.replace(prodRe, ' ') : query;
  const rest = queryTerms(stripped).filter((t) => t !== 'product' && t !== 'overview');
  if (prodRe && prodRe.test(query) && rest.length === 0) return true;
  if (/\bwhat'?s?\s+(is\s+)?(this|it)\b/i.test(query) && rest.length === 0) return true;
  return false;
}
// Concept nouns from a concept what-is query: meaningful terms MINUS the product name MINUS generic
// question/comparison words. A doc whose title/path overlaps one gets a mild boost (below). (FIX 1)
const CONCEPT_STOP = new Set(['what','difference','between','role','format','file','files','does',
  'store','stores','support','supported','index','indices','chain','segment','detection','counting',
  'augmented','work','works']);
function conceptNouns(query, prodRe) {
  const stripped = prodRe ? query.replace(prodRe, ' ') : query;
  return queryTerms(stripped).filter((t) => !CONCEPT_STOP.has(t));
}
// Pick the discovered PRIMER slug that best fits the classified archetype (by title/path keyword).
// Returns: a PRIMER path to force-route to, OR the sentinel { conceptQuery:true } when the query is
// a CONCEPT what-is (no force-route — let the vector pipeline find the defining doc), OR null.
function routePrimer(query, primers, titleOf, prodRe) {
  if (!isOrientationQuery(query) || !primers.length) return null;
  for (const a of ARCHETYPES) {
    if (!a.q.test(query)) continue;
    // what-is splits: product-overview -> PRIMER#1; concept query -> no force-route + concept boost.
    if (a.name === 'whatis' && !isProductOverviewQuery(query, prodRe)) return { conceptQuery: true };
    // Try each section matcher in preference order; first PRIMER that matches wins.
    for (const re of a.sec) {
      const hit = primers.find((p) => re.test(`${p} ${titleOf(p) || ''}`));
      if (hit) return hit;
    }
    // hardware (and other) archetypes: if no matching PRIMER section exists, fall through to vector.
    return null;
  }
  return null;
}
// Discover a glossary PRIMER section (concept queries may softly boost it). (FIX 1)
function glossaryPath(primers, titleOf) {
  return primers.find((p) => /glossary/i.test(`${p} ${titleOf(p) || ''}`)) || null;
}
// Concept boost: SUBTRACT from a doc that names a concept noun. FIX 3 — the DEFINING doc must beat
// an ADJACENT one. A concept noun in the doc's FILENAME SLUG or TITLE is a strong "this doc DEFINES
// the concept" signal, weighted FAR above a bare path-substring hit, so the title/slug-exact
// defining doc out-ranks an adjacent doc that merely mentions it. The "what X is" product PRIMER is
// excluded so the thin blurb never benefits. NON-NEGATIVE.
function conceptBoost(nouns, p, title) {
  if (!nouns || !nouns.length) return 0;
  if (PRIMER_PATH_RE.test(p) && /what\b.*\bis\b|#1-/i.test(`${p} ${title}`)) return 0;
  const slug = (p.split('/').pop() || '').toLowerCase();
  const titleL = String(title || '').toLowerCase();
  const hay = `${p} ${title}`.toLowerCase();
  let strong = 0, weak = 0;
  for (const t of nouns) {
    if (slug.includes(t) || titleL.includes(t)) strong += 1;
    else if (hay.includes(t)) weak += 1;
  }
  if (strong === 0 && weak === 0) return 0;
  return Math.min(0.62, 0.30 * strong + 0.06 * weak);
}
const CODE_INTENT_RE = /\b(in (the )?code|in source|source code|actual code|implementation|implements?|code path|storage backend|\bbackend\b|which algorithms?|which file|\bfunction\b|\bstruct\b|signature|how (is|does|do|are) [\w@/.\- ]*?(implemented|computed|calculated|coded|done|persists?|persisted|stores?|stored|recalls?|recalled|saved?|loaded?|initiali[sz]ed?|registers?|registered|spawns?|spawned|coordinate[sd]?|searche?[sd]?|works?)|where is [\w@/.\- ]*?(coded|implemented|defined|registered)|the mechanism)\b/i;
const DESIGN_INTENT_RE = /\b(why\b|rationale|design decision|design choice|proposed\b|proposal\b|trade[- ]?off|tradeoff|motivation|reasoning behind|the decision to)\b/i;
function codeDocIntent(query) {
  if (CODE_INTENT_RE.test(query)) return 'code';
  if (DESIGN_INTENT_RE.test(query)) return 'design';
  return null;
}

// FIX A — "how-works-in-code" / implementation intent. A query asking how something is
// IMPLEMENTED/coded wants the REAL algorithm source in the crate's own src/ — NOT a vendored/copied
// dependency, NOT the CLI entrypoint, NOT the manifest. DEMOTE patches/** + hnsw_rs-style copied
// deps, **/main.rs, **/bin/**, Cargo.toml; PROMOTE the named crate's own src/**/*.rs (non-main),
// extra for a filename token-matching the named operation. Vendored-dep demotion is global.
const IMPL_INTENT_RE = new RegExp([
  '\\bimplement(ed|ation)?\\b',
  '\\bhow\\s+(is|does)\\b.*\\b(work|works|coded|done)\\b.*\\bin\\s+(the\\s+)?(code|source)\\b',
  '\\bhow\\s+\\w+\\s+(is|works?)\\s+coded\\b',
  '\\bwhere\\s+is\\s+\\w+\\s+(coded|implemented)\\b',
].join('|'), 'i');
function isImplIntent(query) { return IMPL_INTENT_RE.test(query); }

// ADR-0003 — point-deeper symbol routing. Resolve query identifiers / package names to the SOURCE
// paths that DEFINE them (from <name>.symbols.json), so an implementation question hard-routes to the
// real file instead of losing to a prose doc. The index contains source paths only by construction.
const _symCache = new Map();
function loadSymbols(dir, name) {
  const key = dir + '|' + name;
  if (_symCache.has(key)) return _symCache.get(key);
  let s = null;
  try { s = JSON.parse(fs.readFileSync(path.join(dir, `${name}.symbols.json`), 'utf8')); } catch { s = null; }
  _symCache.set(key, s);
  return s;
}
const SYM_STOP = new Set(['does','data','code','what','where','which','this','that','with','from','into','your','their','how','the','and','for','project','package','implement','implemented','implementation','source','file','files','work','works','used','uses','using','support','system','store','stores','recall','persist']);
function symbolRoute(query, sym) {
  const out = new Set();
  if (!sym) return out;
  const q = query.toLowerCase();
  const ids = q.match(/[a-z][a-z0-9_]+/g) || [];
  const snake = ids.filter((t) => t.includes('_') && t.length >= 5);
  const words = ids.filter((t) => !t.includes('_') && t.length >= 4 && !SYM_STOP.has(t));
  const pkgs = (q.match(/@[\w-]+\/([\w-]+)/g) || []).map((s) => s.split('/')[1].toLowerCase());
  const push = (m) => { if (m) for (const p of m) out.add(p); };
  for (const t of snake) push(sym.bySymbol[t]);
  for (const t of pkgs) { push(sym.byPackage[t]); push(sym.bySymbol[t]); }
  for (const t of words) { push(sym.bySymbol[t]); push(sym.byStem[t]); }
  return out;
}
const VENDORED_DEP_RE = /(^|\/)(patches)\/|(^|\/)hnsw_rs\//i;
const IMPL_STOP = new Set(['how','does','work','works','implement','implemented','implementation',
  'code','coded','source','where','the','rust','module','crate','function','method','logic']);
function implOperationNouns(query, crates) {
  const crateSet = new Set((crates || []).map((c) => c.toLowerCase()));
  return queryTerms(query)
    .filter((t) => !crateSet.has(t) && !IMPL_STOP.has(t)
      && !(crates || []).some((c) => t === c || c.includes(t)));
}
function implAdjust(path, crateTok, opNouns) {
  let adj = 0;
  if (VENDORED_DEP_RE.test(path)) adj += 0.55;                 // copied dep is never the real impl
  const slug = (path.split('/').pop() || '').toLowerCase();
  const isMain = /(^|\/)main\.rs$/i.test(path);
  if (isMain || /(^|\/)bin\//i.test(path)) adj += 0.30;        // entrypoint, not the algorithm
  if (/(^|\/)cargo\.toml$/i.test(path)) adj += 0.30;           // manifest
  if (crateTok) {
    const inCrate = new RegExp(`(?:^|/)(?:v\\d+/)?crates/${crateTok}(?:-[a-z0-9-]+)?/`, 'i').test(path);
    if (inCrate && /(?:^|\/)src\/.+\.rs$/i.test(path) && !isMain) {
      adj -= 0.40;                                             // promote crate's own source
      if (opNouns && opNouns.some((t) => t.length >= 3 && slug.includes(t))) adj -= 0.30;
    }
  }
  return adj;
}

// FIX B — targeted off-topic-magnet down-weight. A specific doc that keeps surfacing off-topic
// (ADR-096, rvCSI crate layout) gets a mild penalty UNLESS the query is about its subject.
const OFFTOPIC_MAGNETS = [
  { re: /(^|\/)adr[-_]?0*96\b/i, pen: 0.22,
    allow: /\b(rvcsi|rv[-_]?csi|crate\s+layout|crate\s+structure|crate\s+organi|workspace\s+layout|adr[-\s_]?0*96)\b/i },
  { re: /(^|\/)adr[-_]?0*46\b|ruflo[-_]?rebrand/i, pen: 0.40,
    allow: /\b(rebrand|rename|renamed|naming|adr[-\s_]?0*46)\b/i },
];
function offtopicMagnetPenalty(query, path) {
  let pen = 0;
  for (const m of OFFTOPIC_MAGNETS) { if (m.re.test(path) && !m.allow.test(query)) pen += m.pen; }
  return pen;
}

// FIX C — crate-specific maturity → the crate's OWN README/BENCHMARK (not the global primer).
const MATURITY_QUERY_RE = /\b(production[- ]?ready|production\b|experimental|prototype|complete|completeness|mature|maturity|stable|ready\s+for\s+production|battle[- ]?tested|is\s+it\s+(done|ready))\b/i;
function crateMaturityTarget(query, entityCrates) {
  if (!entityCrates || !entityCrates.length) return null;
  return MATURITY_QUERY_RE.test(query) ? entityCrates[0] : null;
}
function crateMaturityAdjust(crateTok, path) {
  if (!crateTok) return 0;
  const own = new RegExp(`(?:^|/)(?:v\\d+/)?crates/${crateTok}(?:-[a-z0-9-]+)?/(readme|benchmark)\\.md$`, 'i');
  return own.test(path) ? -0.50 : 0;
}

function adrNumbers(query) {
  return (query.match(/\badr[-\s_]?(\d{1,4})\b/gi) || []).map((m) => m.replace(/[^0-9]/g, '').padStart(3, '0'));
}
function pathIsAdrDoc(p, num) {
  return new RegExp(`(^|/)adr[-_]?0*${num}\\b`, 'i').test(p) || new RegExp(`adr[-_]?0*${num}[-_]`, 'i').test(p);
}
// FIX 4 — parse + surface an ADR's Status (Proposed/Accepted/Implemented/Superseded/…). ADRs carry
// it as a table row ( | **Status** | Proposed | ), an inline header ( **Status**: Proposed /
// Status: Proposed ), or a section ( ## Status\n**Proposed** ). Returns the normalized UPPERCASE
// status, or null. Scans the doc's first chunk(s).
const ADR_STATUS_WORDS = '(proposed|accepted|implemented|superseded|rejected|deprecated|draft|in[\\s-]?progress)';
function parseAdrStatus(chunks) {
  if (!chunks || !chunks.length) return null;
  const head = chunks.slice(0, 2).map((c) => c.text).join('\n');
  const patterns = [
    new RegExp(`\\|\\s*\\**\\s*status\\s*\\**\\s*\\|\\s*\\**\\s*${ADR_STATUS_WORDS}`, 'i'),
    new RegExp(`\\**status\\**\\s*:\\s*\\**\\s*${ADR_STATUS_WORDS}`, 'i'),
    new RegExp(`#+\\s*status\\b[^\\n]*\\n+\\s*\\**\\s*${ADR_STATUS_WORDS}`, 'i'),
  ];
  for (const re of patterns) { const m = head.match(re); if (m && m[1]) return m[1].toUpperCase().replace(/[\s-]+/g, '-'); }
  return null;
}
function statusIsProposed(status) {
  return !!status && /^(PROPOSED|DRAFT|IN-PROGRESS|REJECTED|DEPRECATED|SUPERSEDED)$/i.test(status);
}
function adrHasStatus(chunks) {
  if (!chunks || !chunks.length) return false;
  const head = chunks.slice(0, 2).map((c) => c.text).join('\n');
  return parseAdrStatus(chunks) !== null
    || /(^|\n)\s*(#+\s*status\b|\*\*status\*\*\s*:|status\s*:|\|\s*\**status)/i.test(head);
}

const LOW_SIGNAL = [
  { re: /(^|\/)readme[^/]*$/i,                            pen: 0.18, allow: /\breadme\b/i },
  { re: /-checklist\.md$/i,                               pen: 0.15, allow: /\bchecklist\b/i },
  { re: /overview[^/]*\.md$/i,                            pen: 0.10, allow: /\boverview\b/i },
  { re: /(^|\/)(index|toc|table-of-contents)[^/]*\.md$/i, pen: 0.10, allow: /\b(index|toc|contents)\b/i },
  { re: /(^|\/)archive\//i,                               pen: 0.20, allow: /\barchiv/i },
  { re: /(^|\/)examples?\/.*\.rs$/i,                      pen: 0.18, allow: /\bexamples?\b/i },
  { re: /(^|\/)benches?\//i,                              pen: 0.22, allow: /\b(bench|benchmark)/i },
  { re: /(^|\/)tests?\//i,                                pen: 0.16, allow: /\btest/i },
  { re: /(_test\.rs|\.test\.[jt]s|_spec\.rb)$/i,          pen: 0.16, allow: /\btest/i },
];

const STOPWORDS = new Set(['the','a','an','and','or','of','to','in','for','on','with','how','do','i','is','are',
  'what','when','where','why','it','this','that','kb','query','question','search','find','show','me','please','about']);
function queryTerms(q) {
  return (q.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || []).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}
function lexicalBoost(query, terms, p, title) {
  let boost = 0;
  const hay = `${p} ${title}`.toLowerCase();
  const adrIds = (query.match(/adr[-\s_]?(\d{1,4})/gi) || []).map((m) => m.replace(/[^0-9]/g, '').padStart(3, '0'));
  for (const num of adrIds) { if (new RegExp(`adr[-_]?0*${num}\\b`, 'i').test(hay)) { boost += 0.30; break; } }
  let overlap = 0;
  for (const t of terms) if (hay.includes(t)) overlap += 1;
  if (overlap > 0) boost += Math.min(0.18, 0.06 * overlap);
  return boost;
}
function demotionPenalty(query, p) {
  let pen = 0;
  for (const ls of LOW_SIGNAL) if (ls.re.test(p) && !ls.allow.test(query)) pen += ls.pen;
  return pen;
}
function substanceBoost(chunks) {
  if (!chunks || !chunks.length) return 0;
  const totalChars = chunks.reduce((s, c) => s + c.text.length, 0);
  let b = 0;
  if (chunks.length >= 2) b += 0.06;
  if (chunks.length >= 4) b += 0.06;
  if (totalChars >= 4000) b += 0.06;
  if (totalChars < 400) b -= 0.06;
  return Math.max(-0.06, Math.min(0.18, b));
}
// The builder emits OVERLAPPING chunks; stitch() drops the duplicated overlap so a reassembled
// document reads cleanly as one piece.
function stitch(prevTail, next) {
  const maxOv = Math.min(prevTail.length, next.length, 2000);
  for (let len = maxOv; len >= 24; len--) {
    if (prevTail.slice(prevTail.length - len) === next.slice(0, len)) return next.slice(len);
  }
  return next;
}
// When a document exceeds MAX_DOC_CHARS, CENTER the kept window on the matched chunk (the one
// that scored the hit) and expand outward, so the answer-bearing region is always included —
// instead of counting from chunk 0 and truncating a late answer. De-overlap stitching preserved.
function assembleDocument(chunks, matchedId) {
  const SEP = '\n\n';
  if (!chunks.length) return { fullText: '', chunksJoined: 0, truncated: false };

  let center = 0;
  if (matchedId != null) { const idx = chunks.findIndex((c) => c.id === matchedId); if (idx >= 0) center = idx; }

  // Grow a contiguous [lo, hi] window outward from center while under the cap (forward first, then back).
  let lo = center, hi = center, budget = chunks[center].text.length;
  let nextLo = center - 1, nextHi = center + 1, toggle = 1;
  while (nextLo >= 0 || nextHi < chunks.length) {
    let extended = false;
    const tryHi = () => {
      if (nextHi < chunks.length) {
        const cost = SEP.length + chunks[nextHi].text.length;
        if (budget + cost <= MAX_DOC_CHARS) { budget += cost; hi = nextHi; nextHi++; return true; }
        nextHi = chunks.length;
      }
      return false;
    };
    const tryLo = () => {
      if (nextLo >= 0) {
        const cost = SEP.length + chunks[nextLo].text.length;
        if (budget + cost <= MAX_DOC_CHARS) { budget += cost; lo = nextLo; nextLo--; return true; }
        nextLo = -1;
      }
      return false;
    };
    if (toggle === 1) extended = tryHi() || tryLo(); else extended = tryLo() || tryHi();
    toggle ^= 1;
    if (!extended) break;
  }

  let out = '', joined = 0;
  for (let i = lo; i <= hi; i++) {
    const piece = out ? stitch(out.slice(-2000), chunks[i].text) : chunks[i].text;
    out = out ? out + (piece ? SEP + piece : '') : piece;
    joined++;
  }
  const omitted = chunks.length - joined;
  if (omitted > 0) {
    const before = lo, after = chunks.length - 1 - hi, parts = [];
    if (before > 0) parts.push(`${before} earlier`);
    if (after > 0) parts.push(`${after} later`);
    const note = `${SEP}${SEP}[... ${parts.join(' + ')} chunk(s) omitted; window centered on the matched section, capped at ${MAX_DOC_CHARS} chars ...]`;
    return { fullText: out + note, chunksJoined: joined, truncated: true };
  }
  return { fullText: out, chunksJoined: joined, truncated: false };
}

// ---------- core search: returns whole-document results ----------
// Each result: { path, title, fullText, bestDistance, effDistance, chunksJoined, truncated,
//                distance (alias of bestDistance), text (alias of fullText) }.
export async function searchKb({ dir, name, query, k = 6, n, variant }) {
  const conf = resolveConf(dir, name, variant);
  if (!fs.existsSync(conf.rvf)) throw new Error(`rvf not found: ${conf.rvf} (variant=${conf.variant}; build it, or copy the bundle in)`);
  const topN = Math.max(1, n || 5);
  const [qv, { byId, byPath, byPathKind, crateTokens, db }] = await Promise.all([embed(query, conf.embedCfg), getKb(dir, name, conf)]);
  const terms = queryTerms(query);

  // ---- INTENT CLASSIFICATION (deterministic, once per query) ----
  const titleOf = (p) => { const c = byPath.get(p); return c && c.length ? c[0].title : ''; };
  const primers = primerPaths(byPathKind);
  const prodRe = productNameRe(name);
  // FIX 1 — specific-entity detection: a crate/ADR/file/proper-noun query is NOT a generic product
  // orientation question, so suppress its PRIMER force-route + lift and demote primer-orientation.
  const productBase = String(name || '').replace(/[-_]?kb$/i, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
  const entity = specificEntity(query, crateTokens, productBase);
  let routed = routePrimer(query, primers, titleOf, prodRe);    // PRIMER path | {conceptQuery} | null
  // Suppress a PRIMER force-route (string target) when a specific entity is named; concept-query and
  // null routes are untouched (concept boost still applies; crate-inventory carries no hyphen token).
  if (entity.named && routed && typeof routed === 'string') routed = null;
  // A concept what-is query is NON-routing: no force-route to a PRIMER; instead a mild concept boost
  // (below) lets the vector pipeline surface the true defining doc, and the glossary may softly win.
  const conceptQuery = !!(routed && routed.conceptQuery);
  const targetPrimerSlug = (routed && typeof routed === 'string') ? routed : null;
  // FIX 2 — crate-overview / metric target: the crate whose README/BENCHMARK/docs should win.
  const crateOverviewTok = crateOverviewTarget(query, entity.crates);
  const concepts = conceptQuery ? conceptNouns(query, prodRe) : [];
  // FIX 3 — DEFINING-DOC nouns: a concept/topic query that is NOT a product-overview, NOT a
  // force-routed orientation archetype, and NOT a specific-entity query should still surface the
  // DEFINING doc (slug/title-exact) — e.g. "multistatic vs monostatic sensing". These drive the
  // slug/title boost AND pull a slug-named defining doc into the candidate pool.
  const definingNouns = concepts.length
    ? concepts
    : (!entity.named && !targetPrimerSlug ? conceptNouns(query, prodRe) : []);
  const glossarySlug = conceptQuery ? glossaryPath(primers, titleOf) : null;
  const adrNums = adrNumbers(query);
  const intent = codeDocIntent(query);                     // 'code' | 'design' | null
  // FIX A — implementation ("how is X coded") intent: demote wrong-file types, promote crate src.
  const implIntent = isImplIntent(query);
  const implCrateTok = (implIntent && entity.crates.length) ? entity.crates[0] : null;
  const implOpNouns = implIntent ? implOperationNouns(query, entity.crates) : [];
  // ADR-0003 — symbol routing (only for code/impl intent, so concept/what-is queries are untouched).
  const symRouted = (intent === 'code' || implIntent) ? symbolRoute(query, loadSymbols(dir, name)) : new Set();
  // FIX C — crate-scoped maturity question: prefer the crate's OWN README/BENCHMARK.
  const crateMaturityTok = crateMaturityTarget(query, entity.crates);

  const hits = await db.query(qv, Math.max(RAW_HITS, k * 4));

  // FIX 1 — collapse chunk hits into documents keyed by path (doc score = min distance).
  const docs = new Map();
  for (const h of hits) {
    const rec = byId.get(String(h.id));
    if (!rec) continue;
    const cur = docs.get(rec.path);
    if (!cur || h.distance < cur.bestDistance) docs.set(rec.path, { path: rec.path, title: rec.title, bestDistance: h.distance, matchedId: rec.id });
  }

  // INTENT: ensure force-routed targets are IN the candidate pool even if MiniLM ranked them out.
  const ensureDoc = (p) => {
    if (!p || docs.has(p)) return;
    const chunks = byPath.get(p);
    if (!chunks || !chunks.length) return;
    docs.set(p, { path: p, title: chunks[0].title, bestDistance: 1.0, matchedId: chunks[0].id });
  };
  if (targetPrimerSlug) ensureDoc(targetPrimerSlug);
  if (glossarySlug) ensureDoc(glossarySlug);   // concept query: glossary may softly win
  const adrDocPaths = [];
  if (adrNums.length) {
    for (const num of adrNums) {
      for (const p of byPath.keys()) {
        if (pathIsAdrDoc(p, num) && !PRIMER_PATH_RE.test(p)) { adrDocPaths.push(p); ensureDoc(p); }
      }
    }
  }
  // FIX 3 — pull any doc whose FILENAME SLUG names a concept noun into the pool (the defining doc may
  // sit outside the raw vector window). The strengthened concept boost — not a hard route — ranks it.
  if (definingNouns.length) {
    let added = 0;
    for (const p of byPath.keys()) {
      if (docs.has(p) || PRIMER_PATH_RE.test(p)) continue;
      const slug = (p.split('/').pop() || '').toLowerCase();
      if (definingNouns.some((t) => slug.includes(t))) { ensureDoc(p); if (++added >= 40) break; }
    }
  }
  // FIX 2 — ensure the targeted crate's README/BENCHMARK are in the pool even if MiniLM ranked them out.
  if (crateOverviewTok) {
    const cre = new RegExp(`(?:^|/)(?:v\\d+/)?crates/${crateOverviewTok}(?:-[a-z0-9-]+)?/(readme|benchmark)\\.md$`, 'i');
    for (const p of byPath.keys()) { if (cre.test(p)) ensureDoc(p); }
  }
  // FIX A — pull the named crate's own src/**/*.rs (non-main) into the pool for an impl query.
  if (implCrateTok) {
    const srcRe = new RegExp(`(?:^|/)(?:v\\d+/)?crates/${implCrateTok}(?:-[a-z0-9-]+)?/src/.+\\.rs$`, 'i');
    let added = 0;
    for (const p of byPath.keys()) {
      if (docs.has(p) || /(?:^|\/)main\.rs$/i.test(p)) continue;
      if (srcRe.test(p)) { ensureDoc(p); if (++added >= 40) break; }
    }
  }
  // FIX C — ensure the named crate's own README/BENCHMARK are in the pool for a maturity query.
  if (crateMaturityTok) {
    const cre = new RegExp(`(?:^|/)(?:v\\d+/)?crates/${crateMaturityTok}(?:-[a-z0-9-]+)?/(readme|benchmark)\\.md$`, 'i');
    for (const p of byPath.keys()) { if (cre.test(p)) ensureDoc(p); }
  }
  // ADR-0003 — pull symbol-routed source files into the candidate pool (point-deeper).
  for (const p of symRouted) ensureDoc(p);

  // FIXes 1/2/3 + substance + INTENT — rerank by effective distance.
  const HARD_WIN = 5.0;   // dominates any plausible distance + penalty (force #1)
  const ranked = [...docs.values()].map((d) => {
    const dkind = byPathKind.get(d.path) || null;
    let intentAdj = 0;
    if (targetPrimerSlug && d.path === targetPrimerSlug) intentAdj += HARD_WIN;   // orientation route
    if (adrDocPaths.includes(d.path)) intentAdj += HARD_WIN;                       // exact-ADR route
    if (intent) {
      const isTestFile = /\.(test|spec|d)\.[tj]sx?$|\/(tests?|__tests__|fixtures?|testing)\//i.test(d.path);
      if (intent === 'code' && isSourceKind(dkind) && !isTestFile) intentAdj += 0.60;   // promote real source (TS/JS/Rust)
      else if (intent === 'code' && (isTestFile || dkind === 'manifest' || /\/\.claude\/|\/commands?\/|\/skills?\/|SKILL\.md$/i.test(d.path))) intentAdj -= 0.70;  // demote tests / agent / command / manifest noise
      if (intent === 'design' && dkind === 'adr')     intentAdj += 0.22;
    }
    // ADR-0003 — point-deeper: the query's symbol/package is DEFINED in this source file → strong promote.
    if (symRouted.has(d.path)) intentAdj += 1.5;
    // FIX 1/3 — concept boost (slug/title defining doc beats adjacent); glossary nudge for whatis-concept.
    let concept = conceptBoost(definingNouns, d.path, d.title);
    if (glossarySlug && d.path === glossarySlug && concepts.length) concept += 0.06;
    // FIX 1 — demote primer-orientation when a specific entity is named.
    const primerDemote = (entity.named && dkind === 'primer-orientation') ? PRIMER_DEMOTE_WHEN_SPECIFIC : 0;
    // FIX 2 — crate-overview: boost the crate's README/BENCHMARK/docs, demote its harness.
    const crateAdj = crateOverviewAdjust(crateOverviewTok, d.path);
    // FIX A — impl intent: demote vendored deps / entrypoints / manifest, promote the named crate's src.
    const implAdj = implIntent ? implAdjust(d.path, implCrateTok, implOpNouns) : 0;
    // FIX B — targeted off-topic-magnet down-weight (ADR-096 unless query is about rvCSI layout).
    const magnetPen = offtopicMagnetPenalty(query, d.path);
    // FIX C — crate-maturity: boost the named crate's OWN README/BENCHMARK.
    const matAdj = crateMaturityAdjust(crateMaturityTok, d.path);
    const eff = d.bestDistance + demotionPenalty(query, d.path) - lexicalBoost(query, terms, d.path, d.title)
      - substanceBoost(byPath.get(d.path)) - concept - intentAdj + primerDemote + crateAdj
      + implAdj + magnetPen + matAdj;
    return { ...d, effDistance: eff, kind: dkind };
  }).sort((a, b) => a.effDistance - b.effDistance);

  // INTENT (4) — ADR-vs-code pairing: if #1 is a Status-bearing ADR and no source doc is in top-N,
  // append the best-matching source so proposal-vs-built-reality is visible. We only ADD + label.
  let pairedSource = null;
  if (ranked.length) {
    const top = ranked[0];
    if ((top.kind || byPathKind.get(top.path)) === 'adr' && adrHasStatus(byPath.get(top.path))) {
      if (!ranked.slice(0, topN).some((d) => isSourceKind(d.kind))) {
        pairedSource = ranked.find((d) => isSourceKind(d.kind)) || null;
      }
    }
  }

  // FIX 1 — assemble the FULL document for each top-N distinct document.
  const assemble = (d, label) => {
    const chunks = byPath.get(d.path) || [];
    const { fullText, chunksJoined, truncated } = chunks.length
      ? assembleDocument(chunks, d.matchedId)
      : { fullText: '(NO PASSAGE TEXT — path not found in sidecar)', chunksJoined: 0, truncated: false };
    // FIX 4 — parse + surface the ADR Status; `adrStatus` rides the object so MCP carries it too.
    const kind = d.kind || byPathKind.get(d.path) || null;
    const adrStatus = (kind === 'adr' || adrHasStatus(chunks)) ? parseAdrStatus(chunks) : null;
    const statusLabel = adrStatus
      ? `ADR STATUS: ${adrStatus}${statusIsProposed(adrStatus) ? ' — design intent, NOT confirmed shipped' : ' — accepted/implemented'}`
      : null;
    return { path: d.path, title: d.title, fullText, bestDistance: d.bestDistance, effDistance: d.effDistance,
      kind, adrStatus, statusLabel, label: label || null,
      chunksJoined, truncated, text: fullText, distance: d.bestDistance };
  };
  const out = ranked.slice(0, topN).map((d) => assemble(d));
  if (pairedSource && !out.some((r) => r.path === pairedSource.path)) {
    out.push(assemble(pairedSource, 'paired-source (implements the ADR above)'));
  }
  // FIX 4 — proposal-as-reality guard: if #1 is a Proposed/not-yet-Implemented ADR (or a design/DDD
  // doc with no parseable status) AND no implementing source is in the set, attach a design-intent warning.
  if (out.length) {
    const top = out[0];
    const isDesignTop = top.kind === 'adr' || top.kind === 'doc' || top.kind === 'doc-deep' || top.kind === 'ddd';
    const proposed = top.adrStatus ? statusIsProposed(top.adrStatus) : (top.kind !== 'source' && top.kind !== 'crate-src');
    if (isDesignTop && proposed && !out.some((r) => isSourceKind(r.kind))) {
      const st = top.adrStatus || 'unstated (design/DDD doc)';
      top.designIntentWarning = `⚠ This is design intent (ADR status: ${st}); no implementing source was retrieved — treat as proposed, not confirmed built.`;
    }
  }
  return out;
}

// ---------- CLI ----------
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('--dir') || a.includes('--name') || a.includes('--q')) {
    return { dir: get('--dir'), name: get('--name'), query: get('--q'),
      k: parseInt(get('--k') || '6', 10), variant: get('--variant') };
  }
  // positional: <dir> <name> "question" [k] [big|small]
  let variant;
  const vIdx = a.findIndex((x) => x === 'big' || x === 'small');
  if (vIdx !== -1) variant = a.splice(vIdx, 1)[0];
  return { dir: a[0], name: a[1], query: a[2], k: parseInt(a[3] || '6', 10), variant };
}

async function main() {
  const { dir, name, query, k, variant } = parseArgs();
  if (!dir || !name || !query) {
    console.error('Usage: node forge-ask.mjs --dir <kb-dir> --name <kb-name> --q "question" [--k 6] [--variant big|small]');
    process.exit(2);
  }
  const conf = resolveConf(dir, name, variant);
  const results = await searchKb({ dir, name, query, k: Math.max(1, k || 6), variant });
  console.log(`\n=== ${name} KB (${conf.variant} · ${conf.embedCfg.model}) — "${query}" — top ${results.length} documents ===\n`);
  results.forEach((r, i) => {
    console.log(`#${i + 1}  distance=${r.bestDistance.toFixed(4)} (eff=${r.effDistance.toFixed(4)})`
      + `${r.kind ? `  kind=${r.kind}` : ''}${r.label ? `  [${r.label}]` : ''}`
      + `${r.statusLabel ? `  [${r.statusLabel}]` : ''}`);   // FIX 4 — surface ADR status in the header
    console.log(`path : ${r.path}`);
    console.log(`title: ${r.title}`);
    if (r.designIntentWarning) console.log(r.designIntentWarning);   // FIX 4 — proposal-as-reality guard
    console.log(`chars: ${r.fullText.length} | chunks: ${r.chunksJoined}${r.truncated ? ' (truncated)' : ''}`);
    console.log('----- full document -----');
    console.log(r.fullText);
    console.log('===================================================================\n');
  });
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
