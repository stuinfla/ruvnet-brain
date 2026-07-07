#!/usr/bin/env node
// build-bundle.mjs — assemble the shippable RuvNet Brain bundle from every BUILT per-repo KB.
//
// Collects, into dist/ruvnet-brain/: each built repo's vector store(s) + passages + meta + symbols
// (+ the sharp `big` variant, per-repo primer, and L2 articles when present), the shared runtime
// tools (forge-ask / forge-ask-all / forge-mcp / forge-mcp-all / forge-rerank / forge-guard /
// resolve-deps / package.json), a manifest.json (coverage + per-repo chunks/variants/grade/SHA),
// an mcp.snippet.json (a cross-repo "ruvnet-brain" entry + one per-repo entry), and a README.
//
// Idempotent: re-run any time as new variants/primers/grades land — it copies whatever exists now
// and records honestly what is still missing. Does NOT embed or grade; pure assembly.
//
//   node scripts/build-bundle.mjs [--out dist/ruvnet-brain] [--version v0.2.0-dev]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getVersionTag } from './version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, 'kb');
const DATA = path.join(ROOT, 'data');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('--out', 'dist/ruvnet-brain'));
const BRAIN_VERSION = arg('--version', getVersionTag()); // inherits the single source of truth

// ---- registry: tier + the full 169-repo pending list -------------------------------------------
const registry = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.tiers.json'), 'utf8'));
const regFlat = [];
for (const [tier, t] of Object.entries(registry.tiers || {})) for (const r of (t.repos || [])) regFlat.push({ ...r, tier });
const regByLower = new Map(regFlat.map((r) => [r.name.toLowerCase(), r]));

// ---- prior manifest (for builtFromSha continuity if brain-stamp already ran) --------------------
let priorSha = {};
try {
  const prev = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
  for (const b of (prev.builtRepos || [])) if (b.builtFromSha) priorSha[b.name.toLowerCase()] = b.builtFromSha;
} catch { /* none yet */ }

// ---- PRIVATE stores (excluded from any publishable bundle) --------------------------------------
// kb/PRIVATE-STORES.json lists store names built from PRIVATE source that MUST NOT ship. We read it
// here and drop those names during discovery so private code can never leak into dist/.
// FAIL-CLOSED (security-critical — SEC-0010 #4). A private-store fence that degrades to an EMPTY
// set on any error means a truncated/corrupt/missing PRIVATE-STORES.json silently ships EVERY store,
// including private cognitum source. So: a present-but-unparseable fence ALWAYS aborts the build; a
// missing fence aborts too, unless the operator explicitly opts out (ALLOW_NO_PRIVATE_FENCE=1) — the
// escape hatch a genuine no-private public fork needs, but never the silent default.
function loadPrivateStores() {
  const p = path.join(KB, 'PRIVATE-STORES.json');
  if (!fs.existsSync(p)) {
    if (process.env.ALLOW_NO_PRIVATE_FENCE === '1') {
      console.warn('[build-bundle] no PRIVATE-STORES.json; ALLOW_NO_PRIVATE_FENCE=1 → proceeding with NO fence.');
      return new Set();
    }
    console.error(`[build-bundle] FATAL: private-store fence missing (${p}). Refusing to build — a bundle ` +
      `without a verified fence could ship private source. Set ALLOW_NO_PRIVATE_FENCE=1 only for a genuine ` +
      `no-private fork.`);
    process.exit(1);
  }
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[build-bundle] FATAL: PRIVATE-STORES.json is present but unreadable/corrupt (${e.message}). ` +
      `Refusing to build — cannot prove private stores are fenced out.`);
    process.exit(1);
  }
  if (!Array.isArray(j.privateStores)) {
    console.error('[build-bundle] FATAL: PRIVATE-STORES.json has no valid "privateStores" array. Refusing to build.');
    process.exit(1);
  }
  return new Set(j.privateStores.map((s) => String(s).toLowerCase()));
}
const PRIVATE_STORES = loadPrivateStores();

// ---- discover BUILT repos (those with <name>.rvf in kb/) ----------------------------------------
function discoverBuilt() {
  const names = new Set();
  const excludedPrivate = [];
  for (const f of fs.readdirSync(KB)) {
    const m = f.match(/^(.+?)\.rvf$/);                       // base store only (skip .big.rvf via the .big match below)
    if (!m) continue;
    if (/\.(idmap|embed)\b/.test(f)) continue;
    if (m[1].endsWith('.big')) continue;
    if (PRIVATE_STORES.has(m[1].toLowerCase())) { excludedPrivate.push(m[1]); continue; }
    names.add(m[1]);
  }
  if (excludedPrivate.length) console.log(`[build-bundle] EXCLUDED ${excludedPrivate.length} PRIVATE store(s): ${[...new Set(excludedPrivate)].sort().join(', ')}`);
  return [...names].sort();
}

// ---- best-effort grade lookup (REAL-USE avg) from data/grade-<name>-big.json -------------------
function gradeFor(name) {
  for (const f of [`grade-${name}-big.json`, `grade-${name}.json`, `grade-${name}-small.json`]) {
    const p = path.join(DATA, f);
    if (!fs.existsSync(p)) continue;
    try {
      const g = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof g.avgRealUse === 'number') return { realUse: g.avgRealUse, src: f };
      if (g.summary && typeof g.summary.avgRealUse === 'number') return { realUse: g.summary.avgRealUse, src: f };
      const qs = Array.isArray(g.questions) ? g.questions : Array.isArray(g) ? g : null;
      if (qs && qs.length) {
        const vals = qs.map((q) => q.realUse).filter((v) => typeof v === 'number');
        if (vals.length) return { realUse: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1), src: f };
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ---- file copy helper ---------------------------------------------------------------------------
let copied = 0, missing = [];
function cp(src, destDir, { required = false } = {}) {
  const s = path.isAbsolute(src) ? src : path.join(KB, src);
  if (!fs.existsSync(s)) { if (required) missing.push(path.basename(src)); return false; }
  fs.copyFileSync(s, path.join(destDir, path.basename(s)));
  copied++;
  return true;
}
// Private SLUG set (QE-0011 security#1) — kb/l2/ is copied wholesale below; a private repo's raw L2
// .md would ship as a file even though the vector store fences it. Read each private repo's own
// l2-topics.<repo>.json to learn its slugs and skip those .md files. Fail-closed on a corrupt file.
const PRIVATE_L2_SLUGS = new Set();
for (const p of PRIVATE_STORES) {
  const tf = path.join(KB, `l2-topics.${p}.json`);
  if (!fs.existsSync(tf)) continue;
  try { for (const t of JSON.parse(fs.readFileSync(tf, 'utf8'))) if (t.slug) PRIVATE_L2_SLUGS.add(`${t.slug}.md`); }
  catch (e) { console.error(`[build-bundle] FATAL: private topics ${tf} corrupt (${e.message}). Refusing to build.`); process.exit(1); }
}
// skipNames: an optional Set of filenames to exclude (used to fence private L2 .md out of the l2/ copy).
function cpDir(srcDir, destDir, skipNames) {
  if (!fs.existsSync(srcDir)) return false;
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames && skipNames.has(e.name)) continue;
    if (e.isDirectory()) cpDir(path.join(srcDir, e.name), path.join(destDir, e.name), skipNames);
    else { fs.copyFileSync(path.join(srcDir, e.name), path.join(destDir, e.name)); copied++; }
  }
  return true;
}

// ---- assemble ----------------------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const built = discoverBuilt();
const builtRepos = [];
for (const name of built) {
  // per-repo stores + sidecars (base required; big optional)
  cp(`${name}.rvf`, OUT, { required: true });
  cp(`${name}.rvf.idmap.json`, OUT);
  cp(`${name}.rvf.embed.json`, OUT, { required: true });
  cp(`${name}.passages.jsonl`, OUT, { required: true });
  cp(`${name}.meta.json`, OUT, { required: true });
  const hasSymbols = cp(`${name}.symbols.json`, OUT);
  const hasBig = fs.existsSync(path.join(KB, `${name}.big.rvf`));
  if (hasBig) {
    for (const suf of ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.big.passages.jsonl', '.big.meta.json']) cp(`${name}${suf}`, OUT);
  }
  const hasPrimer = cp(`${name}-primer.md`, OUT);
  // metadata
  let chunks = null, model = null, dims = null;
  try { const m = JSON.parse(fs.readFileSync(path.join(KB, `${name}.meta.json`), 'utf8')); chunks = m.entries ? Object.keys(m.entries).length : null; model = m.model; dims = m.dimensions; } catch { /* */ }
  const reg = regByLower.get(name.toLowerCase()) || {};
  const grade = gradeFor(name);
  builtRepos.push({
    name, tier: reg.tier || '?', stars: reg.stars ?? null,
    chunks, baseModel: model, baseDims: dims,
    variants: ['small'].concat(hasBig ? ['big'] : []),
    hasSymbols, hasPrimer, hasBig,
    gradeRealUse: grade ? grade.realUse : null,
    builtFromSha: priorSha[name.toLowerCase()] || 'unknown',
    status: 'built',
  });
}

// L2 articles (whole dir, fencing out private repos' raw .md) + master primer dir (the master
// ruvnet-primer overview — not per-repo, so nothing private to fence there).
cpDir(path.join(KB, 'l2'), path.join(OUT, 'l2'), PRIVATE_L2_SLUGS);
cpDir(path.join(ROOT, 'primer'), path.join(OUT, 'primer'));

// CONCEPTS store (L2 + primers embedded as prose; big-only) — the cross-repo tool unions it at query
// time so code-implemented capabilities are retrievable as high-confidence prose. discoverRepos in the
// bundle finds concepts.big.rvf automatically, so search_ruvnet searches it with no extra config.
const hasConcepts = fs.existsSync(path.join(KB, 'concepts.big.rvf'));
if (hasConcepts) for (const suf of ['concepts.big.rvf', 'concepts.big.rvf.idmap.json', 'concepts.big.rvf.embed.json', 'concepts.big.passages.jsonl', 'concepts.big.meta.json', 'concepts.passages.jsonl', 'concepts.meta.json']) cp(suf, OUT);

// shared runtime tools. forge-guard-injection.mjs is REQUIRED — forge-mcp-all.mjs imports it, so a
// bundle without it crashes the brain on startup (MODULE_NOT_FOUND). forge-update.mjs is the consumer
// self-updater (reads SOURCE.json, copied below).
// package-lock.json ships so the installer can `npm ci` (pinned, reproducible) instead of an
// unpinned `npm i` resolve (SEC-0010 #8).
const tools = ['forge-ask.mjs', 'forge-ask-all.mjs', 'forge-mcp.mjs', 'forge-mcp-all.mjs', 'forge-rerank.mjs', 'forge-guard.mjs', 'forge-guard-injection.mjs', 'forge-update.mjs', 'resolve-deps.mjs', 'package.json', 'package-lock.json'];
for (const t of tools) cp(t, OUT, { required: true });
// self-update provenance (where this bundle came from + the canonical manifest URL). Optional: a build
// without it simply ships a brain whose `forge-update.mjs --check` reports "self-update not configured".
cp('SOURCE.json', OUT);

// ---- manifest ----------------------------------------------------------------------------------
const builtLower = new Set(built.map((b) => b.toLowerCase()));
const pendingRepos = regFlat.filter((r) => !builtLower.has(r.name.toLowerCase())).map((r) => ({ name: r.name, tier: r.tier }));
const now = new Date();
const manifest = {
  brainVersion: BRAIN_VERSION,
  generated: now.toISOString(),
  generatedHuman: now.toUTCString(),
  coverage: { built: builtRepos.length, catalogued: regFlat.length, orgTotalApprox: 248, pending: pendingRepos.length },
  crossRepoTool: { mcp: 'forge-mcp-all.mjs', cli: 'forge-ask-all.mjs', tool: 'search_ruvnet' },
  conceptsStore: hasConcepts ? { store: 'concepts.big.rvf', note: 'L2 synthesis + per-repo primers embedded as prose; unioned by search_ruvnet so code-implemented capabilities are retrievable as high-confidence prose.' } : null,
  builtRepos,
  pendingRepos,
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ---- mcp.snippet.json: cross-repo entry + one per-repo entry -----------------------------------
const mcpServers = {
  'ruvnet-brain': {
    command: 'node',
    args: [path.join(OUT, 'forge-mcp-all.mjs')],
    env: { KB_DIR: OUT, KB_MODEL_CACHE: '/ABSOLUTE/PATH/TO/models-cache (optional; speeds first run)' },
  },
};
for (const b of builtRepos) {
  mcpServers[`ruvnet-${b.name}`] = {
    command: 'node', args: [path.join(OUT, 'forge-mcp.mjs')],
    env: { KB_DIR: OUT, KB_NAME: b.name },
  };
}
fs.writeFileSync(path.join(OUT, 'mcp.snippet.json'), JSON.stringify({
  '//': 'Add the "ruvnet-brain" entry (one tool, searches ALL repos) to your .mcp.json under "mcpServers". The per-repo "ruvnet-<name>" entries are optional (scope to one repo). Replace KB_MODEL_CACHE or remove it. DO NOT use @ruvector/rvf-mcp-server.',
  mcpServers,
}, null, 2));

// ---- README ------------------------------------------------------------------------------------
const repoLines = builtRepos.map((b) => `- **${b.name}** (${b.tier}) — ${b.chunks ?? '?'} chunks · variants: ${b.variants.join('+')}${b.gradeRealUse != null ? ` · REAL-USE ${b.gradeRealUse}` : ''}${b.hasPrimer ? ' · primer' : ''}`).join('\n');
fs.writeFileSync(path.join(OUT, 'README.md'), `# RuvNet Brain — ${BRAIN_VERSION}

The source-grounded knowledge base for the RuvNet ecosystem. One question → the best answer from
rUv's REAL source code, across every built repo, with the file path it came from.

## Built repos (${builtRepos.length}/${regFlat.length})
${repoLines}

## Install
\`\`\`
unzip ruvnet-brain.zip -d kb/
cd kb && npm i          # installs @ruvector/rvf + @xenova/transformers
\`\`\`

## Ask across ALL of RuvNet (recommended)
\`\`\`
node forge-ask-all.mjs --dir . --q "how does RVF store vectors and run HNSW search?"
\`\`\`
Or wire the cross-repo MCP tool \`search_ruvnet\` into your assistant — see \`mcp.snippet.json\`
(add the \`ruvnet-brain\` entry). It searches every repo and returns whole documents labeled by repo.

## Ask one repo
\`\`\`
node forge-ask.mjs --dir . --name ruvector --variant big --q "what is the RVF cognitive container?"
\`\`\`

## Notes
- Each repo ships a \`small\` (MiniLM-384, edge-compatible) store; \`big\` (bge-768) when present is
  sharper and auto-selected.
- ADR results surface shipped-vs-proposed **status** — a "Proposed" ADR is design intent, not shipped.
- Everything runs locally; no network calls at query time. DO NOT use @ruvector/rvf-mcp-server (stub).
- See \`manifest.json\` for per-repo chunk counts, variants, grades, and pinned source SHAs.
`);

// ---- report ------------------------------------------------------------------------------------
console.log(`\n=== build-bundle → ${path.relative(ROOT, OUT)} (${BRAIN_VERSION}) ===`);
console.log(`built repos: ${builtRepos.length}/${regFlat.length} | files copied: ${copied}`);
for (const b of builtRepos) console.log(`  ${b.tier} ${b.name.padEnd(10)} chunks=${String(b.chunks).padStart(6)} variants=${b.variants.join('+').padEnd(10)} symbols=${b.hasSymbols ? 'y' : '-'} primer=${b.hasPrimer ? 'y' : '-'} grade=${b.gradeRealUse ?? '-'} sha=${(b.builtFromSha || '').slice(0, 10)}`);
if (missing.length) console.log(`\n⚠ MISSING required files: ${[...new Set(missing)].join(', ')}`);
console.log(`\nmanifest: ${path.join(path.relative(ROOT, OUT), 'manifest.json')} | mcp snippet + README written.`);
console.log(missing.length ? 'STATUS: assembled WITH MISSING FILES (see above).' : 'STATUS: assembled OK.');
