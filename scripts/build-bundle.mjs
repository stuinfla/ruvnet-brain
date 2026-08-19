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
//   node scripts/build-bundle.mjs [--assets /path/to/release-assets]
//                                 [--out dist/ruvnet-brain] [--version v0.2.0-dev]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getVersion, getVersionTag, stripTag } from './version.mjs';
import { auditRvfIndexes } from './rvf-index-audit.mjs';
// The org total is DERIVED, never a literal: it was hardcoded 248 in this file and in its
// sibling while the account actually had 200 — one stale fact, restated twice (2026-08-12).
import { orgRepoCount } from './org-repo-count.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, 'kb');
const DATA = path.join(ROOT, 'data');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
// RVF binaries are intentionally release assets, not Git blobs. A clean worktree therefore has
// zero stores unless the release operator supplies the canonical external asset directory. Keep
// source/runtime files rooted in this exact checkout; only generated RVF families come from ASSETS.
const ASSETS = path.resolve(ROOT, arg('--assets', 'kb'));
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

// ---- discover BUILT repos (those with <name>.big.rvf in kb/) ------------------------------------
function discoverBuilt() {
  const names = new Set();
  const excludedPrivate = [];
  if (!fs.existsSync(ASSETS)) return [];
  for (const f of fs.readdirSync(ASSETS)) {
    if (f.startsWith('._')) continue; // AppleDouble metadata is never a vector store.
    const m = f.match(/^(.+?)\.big\.rvf$/);
    if (!m) continue;
    if (/\.(idmap|embed)\b/.test(f)) continue;
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
function cp(src, destDir, { required = false, asset = false } = {}) {
  const s = path.isAbsolute(src) ? src : path.join(asset ? ASSETS : KB, src);
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
const ZIP = path.join(path.dirname(OUT), `${path.basename(OUT)}.zip`);
fs.rmSync(OUT, { recursive: true, force: true });
// A failed rebuild must not leave an older archive looking like this invocation's output.
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(OUT, { recursive: true });

const built = discoverBuilt();
if (built.length === 0) {
  console.error('[build-bundle] FATAL: zero public RVF stores are eligible for release. Refusing to publish an empty brain bundle.');
  process.exit(1);
}
const rvfIndexAudit = await auditRvfIndexes(
  built.map((name) => path.join(ASSETS, `${name}.big.rvf`)),
);
const missingIndexes = rvfIndexAudit.filter(({ state }) => state !== 'PASS');
if (missingIndexes.length) {
  console.error('[build-bundle] FATAL: eligible RVFs lack persisted HNSW indexes:');
  for (const result of missingIndexes) {
    console.error(`  ${path.basename(result.path)} vectors=${result.totalVectors}`);
  }
  console.error('[build-bundle] Repair with: node scripts/rvf-index-audit.mjs --repair');
  process.exit(1);
}
const builtRepos = [];
for (const name of built) {
  // One canonical computer-focused vector store per repository. The unsuffixed passages/meta
  // sidecars are shared with the .big RVF so source text and metadata are packaged once.
  cp(`${name}.big.rvf`, OUT, { required: true, asset: true });
  cp(`${name}.big.rvf.idmap.json`, OUT, { required: true, asset: true });
  cp(`${name}.big.rvf.embed.json`, OUT, { required: true, asset: true });
  cp(`${name}.passages.jsonl`, OUT, { required: true, asset: true });
  cp(`${name}.meta.json`, OUT, { required: true, asset: true });
  const hasSymbols = cp(`${name}.symbols.json`, OUT, { asset: true });
  const hasPrimer = cp(`${name}-primer.md`, OUT);
  // metadata
  let chunks = null, model = null, dims = null;
  try { const m = JSON.parse(fs.readFileSync(path.join(ASSETS, `${name}.meta.json`), 'utf8')); chunks = m.entries ? Object.keys(m.entries).length : null; model = m.model; dims = m.dimensions; } catch { /* */ }
  const reg = regByLower.get(name.toLowerCase()) || {};
  const grade = gradeFor(name);
  builtRepos.push({
    name, tier: reg.tier || '?', stars: reg.stars ?? null,
    chunks, baseModel: model, baseDims: dims,
    variants: ['big'],
    hasSymbols, hasPrimer, hasBig: true,
    gradeRealUse: grade ? grade.realUse : null,
    builtFromSha: priorSha[name.toLowerCase()] || 'unknown',
    status: 'built',
  });
}
// Publish only generation records for stores that passed the private-store fence above. Copying
// the machine-wide ledger wholesale would leak private store names/hashes even though their RVFs
// were correctly excluded.
{
  const generationsFile = path.join(ASSETS, 'RVF-GENERATIONS.json');
  if (!fs.existsSync(generationsFile)) {
    missing.push('RVF-GENERATIONS.json');
  } else {
    const source = JSON.parse(fs.readFileSync(generationsFile, 'utf8'));
    const stores = {};
    for (const { name } of builtRepos) {
      if (!source.stores?.[name]) missing.push(`RVF-GENERATIONS.json:${name}`);
      else stores[name] = source.stores[name];
    }
    fs.writeFileSync(path.join(OUT, 'RVF-GENERATIONS.json'), `${JSON.stringify({
      schemaVersion: source.schemaVersion,
      brainVersion: source.brainVersion,
      releaseTag: source.releaseTag,
      stores,
    }, null, 2)}\n`);
    copied++;
  }
}

// L2 articles (whole dir, fencing out private repos' raw .md) + master primer dir (the master
// ruvnet-primer overview — not per-repo, so nothing private to fence there).
cpDir(path.join(KB, 'l2'), path.join(OUT, 'l2'), PRIVATE_L2_SLUGS);
cpDir(path.join(ROOT, 'primer'), path.join(OUT, 'primer'));

// CONCEPTS store (L2 + primers embedded as prose; big-only) — the cross-repo tool unions it at query
// time so code-implemented capabilities are retrievable as high-confidence prose. discoverRepos in the
// bundle finds concepts.big.rvf automatically, so search_ruvnet searches it with no extra config.
const hasConcepts = fs.existsSync(path.join(ASSETS, 'concepts.big.rvf'));
if (hasConcepts) for (const suf of ['concepts.big.rvf', 'concepts.big.rvf.idmap.json', 'concepts.big.rvf.embed.json', 'concepts.big.passages.jsonl', 'concepts.big.meta.json', 'concepts.passages.jsonl', 'concepts.meta.json']) cp(suf, OUT, { asset: true });

// RUV-GISTS store (rUv's public gists — release notes / integration dossiers; big-only, same shape as
// concepts, unioned by search_ruvnet at query time). BUG FIX: only `concepts` was special-cased above,
// so ruv-gists — a PUBLIC store, not private-fenced — was silently omitted from EVERY bundle ever
// shipped. Include it, WITH .big.passages.jsonl (the big variant opens it by name, same as concepts).
const hasGists = fs.existsSync(path.join(ASSETS, 'ruv-gists.big.rvf'));
if (hasGists) for (const suf of ['ruv-gists.big.rvf', 'ruv-gists.big.rvf.idmap.json', 'ruv-gists.big.rvf.embed.json', 'ruv-gists.big.passages.jsonl', 'ruv-gists.big.meta.json', 'ruv-gists.passages.jsonl', 'ruv-gists.meta.json']) cp(suf, OUT, { asset: true });

// capability-cards.md — the FAST LANE's zero-ML answer source (kb/card-lane.mjs, the first
// responder search_ruvnet consults before the heavy cross-repo search). Ships as its own small
// text file, NOT only baked into concepts.big.rvf, so the fast lane can answer without opening
// any vector store or loading either ONNX model. Re-filtered by the SAME PRIVATE_STORES fence
// applied to every other shipped artifact above — reapplied here rather than trusted from the
// source file, because a raw-file copy is a NEW shipping path for this exact content
// (scripts/build-concepts.mjs already fences it into the concepts store; that fence must not be
// silently regained by a second path that copies the same source file without it).
{
  const cardsSrc = path.join(KB, 'capability-cards.md');
  if (fs.existsSync(cardsSrc)) {
    const raw = fs.readFileSync(cardsSrc, 'utf8');
    const parts = raw.split(/^##\s+/m);
    const kept = [];
    let filteredAny = false;
    for (const sec of parts.slice(1)) {
      const nl = sec.indexOf('\n');
      const repo = nl < 0 ? '' : sec.slice(0, nl).trim();
      if (repo && PRIVATE_STORES.has(repo.toLowerCase())) { filteredAny = true; continue; }
      kept.push(`## ${sec}`);
    }
    fs.writeFileSync(path.join(OUT, 'capability-cards.md'), parts[0] + kept.join(''));
    copied++;
    if (filteredAny) console.log('[build-bundle] filtered private repo card(s) out of shipped capability-cards.md');

    // repo-aliases.json TRAVELS WITH THE CARDS OR EVERY ALIAS IS DEAD ON ARRIVAL.
    //
    // card-lane.mjs reads it (REPO_ALIASES_FILE) to resolve a PRODUCT name to its installed store:
    // `agent-harness-generator -> metaharness`, `ruvnet-brain -> brain`, `ruvector -> rvf`,
    // `agentic-qe -> qe`. The bundle never copied it, so on every install those mappings were absent
    // and the fast lane could not route them. Measured 2026-08-19 against the live store root:
    // repo-aliases.json ABSENT, and `search_ruvnet("metaharness: what does Darwin mode mutate?")`
    // answered "card router was ambiguous" — the product cannot be found by its own name.
    //
    // `forge-update.mjs:505` already lists this file among the ones it manages, so the updater knew
    // about it and the builder did not — one fact, two shipping paths, only one of them told. Same
    // shape as the reader/writer store-root split and the ingest `--out` bug fixed this week.
    const aliasesSrc = path.join(KB, 'repo-aliases.json');
    if (fs.existsSync(aliasesSrc)) {
      fs.copyFileSync(aliasesSrc, path.join(OUT, 'repo-aliases.json'));
      copied++;
    } else {
      console.log('[build-bundle] note: kb/repo-aliases.json absent — product-name aliases will not resolve on install');
    }
  } else {
    console.log('[build-bundle] note: kb/capability-cards.md absent — the fast lane ships with no card source and will honestly fall through on every query');
  }
}

// shared runtime tools. forge-guard-injection.mjs is REQUIRED — forge-mcp-all.mjs imports it, so a
// bundle without it crashes the brain on startup (MODULE_NOT_FOUND). forge-update.mjs is the consumer
// self-updater (reads SOURCE.json, copied below).
// package-lock.json ships so the installer can `npm ci` (pinned, reproducible) instead of an
// unpinned `npm i` resolve (SEC-0010 #8).
// verify-citation.mjs ships WITH the KB because it verifies the KB: --doctor loads it from the
// installed bundle to prove an answer's citation resolves to a real passage on disk.
//
// DERIVED, NOT HAND-MAINTAINED (issue #32, Jan Lafko / @lafinak, 2026-07-20).
// This list used to be typed by hand, and twice a new required import fell out of it and shipped a
// bundle that crashed on startup with MODULE_NOT_FOUND — most recently `forge-hybrid.mjs`, which
// `forge-ask-all.mjs` imports unconditionally (commit 57354dd). The warning comment above was already
// there and did not prevent it, because a comment cannot know what a file imports. The build now does.
//
// We walk the real static import graph from the entry points that must be runnable out of the
// installed bundle, and ship every local module they transitively reach. A new import is therefore
// bundled the moment it is written, with no list to remember to update.
const ENTRYPOINTS = [
  'forge-ask.mjs', 'forge-ask-all.mjs', 'forge-mcp.mjs', 'forge-mcp-all.mjs',
  'forge-rerank.mjs', 'forge-guard.mjs', 'forge-update.mjs', 'verify-citation.mjs',
];
// Non-module assets, and modules reached only by a path the graph walk cannot see (e.g. a spawned
// child process). Kept explicit BECAUSE they are genuinely not derivable — not as a duplicate list.
const EXTRA_FILES = ['package.json', 'package-lock.json', 'package-owners.json'];

/** Local (relative) specifiers a module imports — static, side-effect, and literal dynamic. */
function localImportsOf(absFile) {
  const raw = fs.readFileSync(absFile, 'utf8');
  // STRIP COMMENTS BEFORE SCANNING. The static-import pattern below uses [^;'"]* to bridge the gap
  // between `import` and `from`, which cannot cross an apostrophe. This file's own house style is
  // dense commentary full of contractions, so a perfectly ordinary multi-line import —
  //     import {
  //       foo, // don't forget bar
  //       bar,
  //     } from './mod.mjs';
  // matched NOTHING: no throw, no escape warning, the walker never queued './mod.mjs', and the build
  // happily shipped a bundle missing it. That is strictly worse than the #32 bug it replaced, which
  // at least crashed loudly on startup. Comments carry no imports, so removing them first costs
  // nothing and closes the whole class.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');      // line comments (the [^:] guard spares "https://")
  const specs = new Set();
  for (const m of src.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  // `import(new URL('./x.mjs', import.meta.url).href)` — the computed-URL form. Missed by the plain
  // literal pattern above, and it is not hypothetical: forge-ask-all.mjs and forge-mcp-all.mjs both
  // load brain-alarm.mjs and telemetry-ping.mjs exactly this way. Neither was reaching the bundle,
  // and because both call sites are try/catch-guarded it failed SILENTLY — meaning the brain-down
  // "GONG" alarm, the thing whose entire job is to make a broken brain impossible to miss, has been
  // dead in every installed bundle. Found by adversarial review, not by any test.
  for (const m of src.matchAll(/\bimport\s*\(\s*new\s+URL\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  return [...specs].filter((s) => s.startsWith('./') || s.startsWith('../'));
}

/** Transitive closure of local modules reachable from the entry points, relative to KB. */
function resolveModuleGraph() {
  const seen = new Set();
  // `from` distinguishes the two absent-file cases, which are NOT the same failure:
  //   from === null  -> an entry point this kb/ simply does not contain (a minimal fixture, a
  //                     partial tree). Nothing to bundle; skip it.
  //   from !== null  -> a module that something ACTUALLY IMPORTS is missing. That is precisely the
  //                     MODULE_NOT_FOUND of #32, and it must stop the build.
  const queue = ENTRYPOINTS.map((rel) => ({ rel, from: null }));
  const escapes = [];
  while (queue.length) {
    const { rel, from } = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(KB, rel);
    if (!fs.existsSync(abs)) {
      if (from === null) { console.log(`[build-bundle] note: entry point ${rel} absent from kb/ — skipping`); continue; }
      throw new Error(
        `[build-bundle] ${from} imports ${rel}, which does not exist in kb/ — ` +
        `a bundle built from this tree would crash on startup (issue #32)`,
      );
    }
    seen.add(rel);
    for (const spec of localImportsOf(abs)) {
      const target = path.normalize(path.join(path.dirname(rel), spec));
      if (target.startsWith('..')) { escapes.push(`${rel} -> ${spec}`); continue; }
      queue.push({ rel: target, from: rel });
    }
  }
  if (escapes.length) {
    // A bundled module importing outside kb/ cannot work once installed — the file simply is not there.
    throw new Error(`[build-bundle] import escapes kb/ and would break the installed bundle:\n  ${escapes.join('\n  ')}`);
  }
  return [...seen].sort();
}

const derivedTools = resolveModuleGraph();
const tools = [...derivedTools, ...EXTRA_FILES];
console.log(`[build-bundle] module graph: ${derivedTools.length} modules from ${ENTRYPOINTS.length} entry points`);
for (const t of tools) cp(t, OUT, { required: true });
// self-update provenance (where this bundle came from + the canonical manifest URL). Optional: a build
// without it simply ships a brain whose `forge-update.mjs --check` reports "self-update not configured".
cp('SOURCE.json', OUT, { required: true });

// Rebind copied SOURCE.json to this build. The external RVFs may come from the previous release,
// but the installed product identity belongs to the source generation that assembled them.
try {
  const sj = path.join(OUT, 'SOURCE.json');
  const doc = JSON.parse(fs.readFileSync(sj, 'utf8'));
  doc.brainVersion = getVersion();
  doc.releaseTag = getVersionTag();
  fs.writeFileSync(sj, JSON.stringify(doc, null, 2));
} catch (e) {
  console.error(`[build-bundle] FATAL: could not stamp SOURCE.json identity (${e.message}).`);
  process.exit(1);
}

// SIGNED AUTO-APPLY trust root (SEC-0010 #6, 2026-07-17). The self-updater must VERIFY a downloaded
// bundle's Ed25519 signature before extracting executable code over the user's install. For that it
// needs the verifier AND the public key ON DISK — placed here by a trusted install, so the key the
// updater trusts is the one from the LAST good bundle, never one riding inside the (possibly tampered)
// download. verify-bundle.mjs lives in scripts/ and the key in keys/ — both outside kb/, so copy by
// absolute path. Required: shipping a bundle that can't verify its own successor re-opens the exact
// hole this closes.
cp(path.join(ROOT, 'scripts', 'verify-bundle.mjs'), OUT, { required: true });
fs.mkdirSync(path.join(OUT, 'keys'), { recursive: true });
cp(path.join(ROOT, 'keys', 'ruvnet-brain-signing.pub.pem'), path.join(OUT, 'keys'), { required: true });

// ---- manifest ----------------------------------------------------------------------------------
const builtLower = new Set(built.map((b) => b.toLowerCase()));
const pendingRepos = regFlat.filter((r) => !builtLower.has(r.name.toLowerCase())).map((r) => ({ name: r.name, tier: r.tier }));
const now = new Date();
const ORG = orgRepoCount();
const manifest = {
  brainVersion: stripTag(BRAIN_VERSION), // FIELD = bare literal; BRAIN_VERSION stays the v-prefixed Release tag
  generated: now.toISOString(),
  generatedHuman: now.toUTCString(),
  coverage: { built: builtRepos.length, catalogued: regFlat.length, orgTotalApprox: ORG.count, orgTotalSource: ORG.source, orgTotalAt: ORG.at, pending: pendingRepos.length },
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
- Each repo ships one canonical \`big\` store (bge-base-en-v1.5, 768 dimensions) plus one shared
  passages/meta sidecar set. \`RVF-GENERATIONS.json\` binds the exact RVF bytes to this release.
- ADR results surface shipped-vs-proposed **status** — a "Proposed" ADR is design intent, not shipped.
- Everything runs locally; no network calls at query time. DO NOT use @ruvector/rvf-mcp-server (stub).
- See \`manifest.json\` for per-repo chunk counts, variants, grades, and pinned source SHAs.
`);

if (missing.length) {
  const requiredMissing = [...new Set(missing)];
  console.error(`[build-bundle] FATAL: missing required bundle files:\n  ${requiredMissing.join('\n  ')}`);
  process.exit(1);
}

// ---- exact release artifact -------------------------------------------------------------------
// The release signer signs dist/ruvnet-brain.zip, not this assembly directory. Rebuilding only the
// directory can therefore sign stale bytes left by an older run—the source tree is green while
// users receive an old brain. Build the exact ZIP here, then extract it through the same safe
// extractor users run and audit the RVF indexes in those extracted bytes before signing is allowed.
const archiveFiles = [];
function collectArchiveFiles(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) collectArchiveFiles(path.join(dir, entry.name), relative);
    else if (entry.isFile()) archiveFiles.push(relative);
  }
}
collectArchiveFiles(OUT);
archiveFiles.sort();
const zipped = process.platform === 'win32'
  ? spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${OUT.replaceAll("'", "''")}\\*' -DestinationPath '${ZIP.replaceAll("'", "''")}' -Force`,
  ], { encoding: 'utf8' })
  : spawnSync('zip', ['-q', '-X', ZIP, ...archiveFiles], {
    cwd: OUT,
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
if (zipped.status !== 0 || !fs.existsSync(ZIP)) {
  console.error(`[build-bundle] FATAL: could not create exact release ZIP (${zipped.stderr || zipped.error?.message || `exit ${zipped.status}`})`);
  process.exit(1);
}

const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-release-audit-'));
try {
  const { extractZip } = await import('../kb/zip-extract.mjs');
  await extractZip(ZIP, extracted);
  const packagedRvfs = fs.readdirSync(extracted)
    .filter((name) => name.endsWith('.rvf'))
    .sort()
    .map((name) => path.join(extracted, name));
  const packagedAudit = await auditRvfIndexes(packagedRvfs);
  const packagedFailures = packagedAudit.filter(({ state }) => state !== 'PASS');
  if (packagedFailures.length) {
    console.error('[build-bundle] FATAL: extracted release artifact contains RVFs without persisted HNSW indexes:');
    for (const result of packagedFailures) {
      console.error(`  ${path.basename(result.path)} vectors=${result.totalVectors ?? '?'}`);
    }
    throw new Error('extracted release artifact failed the persisted HNSW index audit');
  }
  console.log(`[build-bundle] exact archive proof: ${packagedRvfs.length} RVFs audited after extraction; 0 index failures`);
} finally {
  fs.rmSync(extracted, { recursive: true, force: true });
}

// ---- report ------------------------------------------------------------------------------------
console.log(`\n=== build-bundle → ${path.relative(ROOT, OUT)} (${BRAIN_VERSION}) ===`);
console.log(`built repos: ${builtRepos.length}/${regFlat.length} | files copied: ${copied}`);
for (const b of builtRepos) console.log(`  ${b.tier} ${b.name.padEnd(10)} chunks=${String(b.chunks).padStart(6)} variants=${b.variants.join('+').padEnd(10)} symbols=${b.hasSymbols ? 'y' : '-'} primer=${b.hasPrimer ? 'y' : '-'} grade=${b.gradeRealUse ?? '-'} sha=${(b.builtFromSha || '').slice(0, 10)}`);
if (missing.length) console.log(`\n⚠ MISSING required files: ${[...new Set(missing)].join(', ')}`);
console.log(`\nmanifest: ${path.join(path.relative(ROOT, OUT), 'manifest.json')} | mcp snippet + README written.`);
console.log(missing.length ? 'STATUS: assembled WITH MISSING FILES (see above).' : 'STATUS: assembled OK.');
