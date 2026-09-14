#!/usr/bin/env node
// build-bundle.mjs — assemble the shippable RuvNet Brain bundle from ONE finalized corpus directory.
//
// Step 5 of the corpus-seed/release pipeline consolidation (2026-09-13). Before this, assembly was
// two independent, ad hoc passes glued together by an external CLI round-trip: build-bundle.mjs
// discovered stores from disk, copied SOURCE.json from the maintainer's own checkout (a SECOND
// production point for the exact bug Step 3 already fixed for public inputs), stamped `builtFromSha`
// from a stale externally-tracked `data/manifest.json`, special-cased "concepts"/"ruv-gists" with
// near-duplicate `if` blocks, and — for a real release — had to be invoked TWICE around a separate
// `release-projection.mjs` subprocess just so the second invocation could see a coverage-scoped
// selection the first invocation's own output made possible. `assembleBundle` replaces all of that
// with ONE pass: selection is DISCOVERED directly from the finalized corpus directory, which Step 4's
// real pruning guarantees already equals the exact eligible set — no external coverage-filtering
// round-trip is needed to compute it, only (optionally) a fail-loud cross-check against the sealed
// corpus coverage, never a repair. SOURCE.json, the shipped generation ledger, and the manifest's
// per-repo rows are now generated ONCE, together, by `projectStoreViews`, from explicitly selected
// records — never re-derived independently or copied from the checkout. The release coverage
// projection (COVERAGE.json / CORPUS-COVERAGE.json / PUBLIC-RVF-GENERATIONS.json) is produced
// in-process, from the exact same selected records, and written alongside everything else before the
// ONE zip is created.
//
//   node scripts/build-bundle.mjs [--assets /path/to/finalized-corpus] [--out dist/ruvnet-brain]
//                                 [--version v0.2.0-dev] [--source-snapshot <40-hex>]
//                                 [--seed-tag <tag> --seed-sha256 <64-hex> --seed-bytes <n>
//                                  --baseline-receipt-sha256 <64-hex>]
//
// `--seed-tag`/`--seed-sha256`/`--seed-bytes`/`--baseline-receipt-sha256` are optional. When all four
// are supplied, this run additionally produces and validates the release coverage projection (the
// real-release shape ci.yml's release-qe job needs). When any is absent, assembleBundle still
// produces a complete, correctly-selected candidate archive with no release-projection files — the
// shape scripts/corpus-reconcile.mjs's prepareCorpusCandidate and scripts/self-update.mjs both need,
// and have always needed, without ever wanting a release coverage projection of their own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getVersionTag, stripTag } from './version.mjs';
import { auditRvfIndexes } from './rvf-index-audit.mjs';
import { readRvfGenerations, validateSelectedRvfGenerations } from './rvf-generation.mjs';
import { validatePublicInventory } from './public-inventory.mjs';
import { bindAssembledReleaseProjection, createReleaseProjection } from './release-projection.mjs';
import { materializePublicInputs, SELECTION_FILE } from './public-inputs.mjs';
// The org total is DERIVED, never a literal: it was hardcoded 248 in this file and in its
// sibling while the account actually had 200 — one stale fact, restated twice (2026-08-12).
import { orgRepoCount } from './org-repo-count.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

/** A directory must not be, contain, or be contained by any of `forbidden` (algorithm step 2: a
 * fresh output directory disjoint from all inputs). Deliberately self-contained (no import of
 * corpus-reconcile.mjs's equivalent) so this file's own dependency graph — walked by
 * tests/integration/build-bundle-fence.test.mjs's isolated subprocess fixture — never grows. */
function assertDisjoint(label, targetDir, forbidden) {
  const resolved = path.resolve(targetDir || '');
  const overlaps = (a, b) => {
    const relative = path.relative(a, b);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  for (const entry of forbidden) {
    const forbiddenDir = path.resolve(entry.dir);
    if (overlaps(forbiddenDir, resolved) || overlaps(resolved, forbiddenDir)) {
      fail(`${label} must not be, or contain, or be contained by, ${entry.label} (${resolved})`);
    }
  }
}

// Best-effort only: NOT every caller runs inside a real git checkout (an isolated subprocess-test
// fixture, deliberately, does not — see tests/integration/build-bundle-fence.test.mjs's own header on
// why it copies only a scoped dependency tree into a plain tmpdir). A source snapshot is genuinely
// required only when a release coverage projection is being produced (assembleBundle's `seedIdentity`
// branch, and createReleaseProjection's own validation) — everywhere else it is optional enrichment,
// so failure here must never abort assembly.
function tryGitSha(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sha = String(result.stdout || '').trim();
  return result.status === 0 && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

// ---- PRIVATE stores (excluded from any publishable bundle) --------------------------------------
// kb/PRIVATE-STORES.json (read from the exact code checkout, NEVER from the finalized corpus
// directory — corpus-reconcile.mjs's own SEED-PRIVATE-STORES.json comment states the reason: a
// seed's own fence is authenticated HISTORICAL evidence, never the current builder's live policy)
// lists store names built from PRIVATE source that MUST NOT ship. We read it here and drop those
// names during discovery so private code can never leak into dist/.
// FAIL-CLOSED (security-critical — SEC-0010 #4). A private-store fence that degrades to an EMPTY
// set on any error means a truncated/corrupt/missing PRIVATE-STORES.json silently ships EVERY store,
// including private cognitum source. So: a present-but-unparseable fence ALWAYS aborts the build; a
// missing fence aborts too, unless the operator explicitly opts out (ALLOW_NO_PRIVATE_FENCE=1) — the
// escape hatch a genuine no-private public fork needs, but never the silent default.
function loadPrivateStores(runtimeKbDir) {
  const p = path.join(runtimeKbDir, 'PRIVATE-STORES.json');
  if (!fs.existsSync(p)) {
    if (process.env.ALLOW_NO_PRIVATE_FENCE === '1') {
      console.warn('[build-bundle] no PRIVATE-STORES.json; ALLOW_NO_PRIVATE_FENCE=1 → proceeding with NO fence.');
      return new Set();
    }
    fail(`private-store fence missing (${p}). Refusing to build — a bundle ` +
      `without a verified fence could ship private source. Set ALLOW_NO_PRIVATE_FENCE=1 only for a genuine ` +
      `no-private fork.`);
  }
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`private-store fence is present but unreadable/corrupt (${e.message}). ` +
      `Refusing to build — cannot prove private stores are fenced out.`);
  }
  if (!Array.isArray(j.privateStores)) {
    fail('private-store fence has no valid "privateStores" array. Refusing to build.');
  }
  return new Set(j.privateStores.map((s) => String(s).toLowerCase()));
}

// ---- discover BUILT stores (those with <name>.big.rvf in the finalized corpus) ------------------
function discoverBuilt(corpusDir, privateStores) {
  const names = new Set();
  const excludedPrivate = [];
  if (!fs.existsSync(corpusDir)) return { built: [], excludedPrivate: [] };
  for (const f of fs.readdirSync(corpusDir)) {
    if (f.startsWith('._')) continue; // AppleDouble metadata is never a vector store.
    const m = f.match(/^(.+?)\.big\.rvf$/);
    if (!m) continue;
    if (/\.(idmap|embed)\b/.test(f)) continue;
    if (privateStores.has(m[1].toLowerCase())) { excludedPrivate.push(m[1]); continue; }
    names.add(m[1]);
  }
  return { built: [...names].sort(), excludedPrivate };
}

// ---- best-effort grade lookup (REAL-USE avg), bound to the SELECTED generation ------------------
// Algorithm step 8: omit historical grades lacking matching source/build evidence. A grade file only
// counts as evidence for the store's CURRENTLY selected generation if it names the exact sourceCommit
// or RVF digest it was measured against. Today's grading harness (scripts/build-l2.mjs,
// scripts/brain-grade-groundtruth.mjs — both human-run per CONTRIBUTING.md §5) does not yet stamp
// that binding into its output JSON, so no grade file can currently satisfy this and gradeRealUse is
// correctly omitted everywhere until the grading harness is updated to record it — a genuine, honest
// consequence of this rule, not a bug: a REAL-USE score with no way to prove which build it measured
// is exactly the kind of unproven historical claim this consolidation removes.
function gradeFor(dataDir, name, generation) {
  for (const f of [`grade-${name}-big.json`, `grade-${name}.json`, `grade-${name}-small.json`]) {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p)) continue;
    let g;
    try { g = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const evidenceSha = g.summary?.sourceCommit || g.sourceCommit || null;
    const evidenceRvfSha256 = g.summary?.rvfSha256 || g.rvfSha256 || null;
    const boundBySha = evidenceSha && generation?.sourceCommit
      && String(evidenceSha).toLowerCase() === String(generation.sourceCommit).toLowerCase();
    const boundByRvf = evidenceRvfSha256 && generation?.sha256
      && String(evidenceRvfSha256).toLowerCase() === String(generation.sha256).toLowerCase();
    if (!boundBySha && !boundByRvf) continue;
    if (typeof g.summary?.avgRealUse === 'number') return g.summary.avgRealUse;
    const qs = Array.isArray(g.questions) ? g.questions : Array.isArray(g) ? g : null;
    if (qs && qs.length) {
      const vals = qs.map((q) => q.realUse).filter((v) => typeof v === 'number');
      if (vals.length) return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
    }
  }
  return null;
}

// ---- file copy helper ---------------------------------------------------------------------------
function makeCopier() {
  let copied = 0;
  const missing = [];
  /** cp(relativeName, destDir, { required, from }) — `from` is the exact source directory; every
   * call site names it explicitly (never an implicit ASSETS-vs-KB default) so "which root did this
   * file come from" is always visible at the call site, not inferred from a flag. */
  function cp(name, destDir, { required = false, from } = {}) {
    const s = path.isAbsolute(name) ? name : path.join(from, name);
    const stat = fs.existsSync(s) ? fs.lstatSync(s) : null;
    if (!stat || !stat.isFile()) { if (required) missing.push(path.basename(name)); return false; }
    if (stat.isSymbolicLink()) fail(`refusing to copy a symbolic link into the bundle: ${s}`);
    fs.copyFileSync(s, path.join(destDir, path.basename(s)));
    copied++;
    return true;
  }
  function cpDir(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return false;
    fs.mkdirSync(destDir, { recursive: true });
    for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) fail(`refusing to copy a symbolic link into the bundle: ${path.join(srcDir, e.name)}`);
      if (e.isDirectory()) cpDir(path.join(srcDir, e.name), path.join(destDir, e.name));
      else { fs.copyFileSync(path.join(srcDir, e.name), path.join(destDir, e.name)); copied++; }
    }
    return true;
  }
  return { cp, cpDir, get copied() { return copied; }, get missing() { return missing; } };
}

// ---- runtime module graph (unchanged discipline from before this step; scoped to a `kbDir` arg) --
const ENTRYPOINTS = [
  'forge-ask.mjs', 'forge-ask-all.mjs', 'forge-mcp.mjs', 'forge-mcp-all.mjs',
  'forge-rerank.mjs', 'forge-guard.mjs', 'forge-update.mjs', 'verify-citation.mjs',
];
const EXTRA_FILES = ['package.json', 'package-lock.json', 'package-owners.json'];

/** Local (relative) specifiers a module imports — static, side-effect, and literal dynamic. */
function localImportsOf(absFile) {
  const raw = fs.readFileSync(absFile, 'utf8');
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');      // line comments (the [^:] guard spares "https://")
  const specs = new Set();
  for (const m of src.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*new\s+URL\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  return [...specs].filter((s) => s.startsWith('./') || s.startsWith('../'));
}

/** Transitive closure of local modules reachable from the entry points, relative to `kbDir`. */
function resolveModuleGraph(kbDir) {
  const seen = new Set();
  const queue = ENTRYPOINTS.map((rel) => ({ rel, from: null }));
  const escapes = [];
  while (queue.length) {
    const { rel, from } = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(kbDir, rel);
    if (!fs.existsSync(abs)) {
      if (from === null) { console.log(`[build-bundle] note: entry point ${rel} absent from kb/ — skipping`); continue; }
      fail(`${from} imports ${rel}, which does not exist in kb/ — ` +
        `a bundle built from this tree would crash on startup (issue #32)`);
    }
    seen.add(rel);
    for (const spec of localImportsOf(abs)) {
      const target = path.normalize(path.join(path.dirname(rel), spec));
      if (target.startsWith('..')) { escapes.push(`${rel} -> ${spec}`); continue; }
      queue.push({ rel: target, from: rel });
    }
  }
  if (escapes.length) {
    fail(`import escapes kb/ and would break the installed bundle:\n  ${escapes.join('\n  ')}`);
  }
  return [...seen].sort();
}

/**
 * projectStoreViews({ selectedResults, identity, updaterConfig }) -> { source, ledger, manifestEntries }
 *
 * Generates SOURCE, the product manifest rows, and the runtime/public generation ledger ONCE from
 * one explicit list of selected records and the explicit release identity (algorithm step 6) — never
 * three independently-derived copies. `updaterConfig` is the finalized corpus's OWN SOURCE.json
 * (produced fresh by reconciliation), read as an explicit configuration ADAPTER: only its non-identity
 * updater fields (canonicalManifestUrl/canonicalBundleUrl/selfUpdate/sourceRepo/sourceDescribe/kbName)
 * are borrowed per store; `sourceCommit`/`builtUtc` are always bound from that store's own selected
 * generation record, never independently trusted from `updaterConfig`'s own copy (algorithm step 5:
 * an adapter, never a checkout-`SOURCE.stores` copy). Every `manifestEntries[i].builtFromSha` is
 * likewise derived directly from the selected generation (algorithm step 7) — there is no external
 * "prior manifest" lookup left to drift from it.
 */
export function projectStoreViews({ selectedResults, identity, updaterConfig }) {
  if (!Array.isArray(selectedResults) || !selectedResults.length) {
    fail('projectStoreViews requires at least one selected record');
  }
  const version = identity?.version;
  const sourceSnapshot = identity?.sourceSnapshot ?? null;
  if (typeof version !== 'string' || !version) fail('projectStoreViews requires an explicit release version');
  // The source snapshot is optional here (see tryGitSha's own note) but, when supplied, must be a
  // genuine 40-hex commit — never a garbage value silently carried into the shipped ledger.
  if (sourceSnapshot !== null && !/^[a-f0-9]{40}$/.test(sourceSnapshot)) fail('projectStoreViews source snapshot, when supplied, must be exact 40-hex');
  const config = updaterConfig && typeof updaterConfig === 'object' ? updaterConfig : {};
  const ledgerStores = {};
  const sourceStores = {};
  const manifestEntries = [];
  for (const result of [...selectedResults].sort((a, b) => a.name.localeCompare(b.name))) {
    const { name, kind, generation } = result;
    if (!generation || typeof generation.sha256 !== 'string' || !generation.sha256) {
      fail(`${name}: selected record has no generation to project`);
    }
    ledgerStores[name] = {
      file: generation.file || `${name}.big.rvf`,
      sha256: generation.sha256,
      bytes: generation.bytes,
      model: generation.model,
      dimensions: generation.dimensions,
      sourceCommit: generation.sourceCommit ?? null,
      builtUtc: generation.builtUtc,
    };
    if (kind !== 'repository') continue; // SOURCE.json and manifest rows are repository-only, exactly as forge-refresh.mjs's own SOURCE.json has always been.
    const updater = (config.stores && config.stores[name]) || {};
    sourceStores[name] = {
      kbName: updater.kbName || name,
      sourceRepo: updater.sourceRepo || null,
      sourceCommit: generation.sourceCommit ?? null,
      sourceDescribe: updater.sourceDescribe || null,
      builtUtc: generation.builtUtc,
      builder: updater.builder || config.builder || 'rvf-kb-forge',
      canonicalManifestUrl: updater.canonicalManifestUrl || null,
      canonicalBundleUrl: updater.canonicalBundleUrl || null,
      selfUpdate: updater.selfUpdate || `node forge-update.mjs ${name}`,
    };
    manifestEntries.push({
      name, tier: result.tier, stars: result.stars,
      chunks: result.chunks, baseModel: result.baseModel, baseDims: result.baseDims,
      variants: ['big'], hasSymbols: result.hasSymbols, hasPrimer: result.hasPrimer, hasBig: true,
      gradeRealUse: result.gradeRealUse,
      builtFromSha: generation.sourceCommit || 'unknown',
      status: 'built',
    });
  }
  const source = {
    builder: config.builder || 'rvf-kb-forge',
    brainVersion: version,
    releaseTag: `v${version}`,
    builtUtc: new Date().toISOString(),
    canonicalManifestUrl: config.canonicalManifestUrl || null,
    selfUpdate: config.selfUpdate || 'node forge-update.mjs',
    stores: sourceStores,
  };
  const ledger = { schemaVersion: 2, brainVersion: version, releaseTag: `v${version}`, sourceSnapshot, stores: ledgerStores };
  return { source, ledger, manifestEntries };
}

// Extra sidecar families beyond the universal per-store family (big.rvf/idmap/embed/passages/meta,
// handled generically for every discovered store) — driven by KIND, from one explicit table, never
// by ad hoc `hasConcepts`/`hasGists` boolean special-casing.
const EXTRA_SIDECARS_BY_KIND = {
  'gist-aggregate': (name) => [{ name: `${name}.sources.json`, required: true }],
  derived: (name) => [{ name: `${name}.sources.json`, required: true }],
};

/**
 * assembleBundle({ corpusDir, runtimeRoot, outDir, identity, seedIdentity }) -> Promise<ArchiveResult>
 *
 * See this file's header for the full algorithm. `identity` = { version?, sourceSnapshot? } (both
 * optional; default to the checkout's own version/HEAD). `seedIdentity` = { tag, archiveSha256,
 * archiveBytes, baselineReceiptSha256 } — when every field is present, a release coverage projection
 * (COVERAGE.json / CORPUS-COVERAGE.json / PUBLIC-RVF-GENERATIONS.json) is additionally produced and
 * validated; when absent, assembleBundle still produces a complete, correctly-selected candidate.
 */
export async function assembleBundle({ corpusDir, runtimeRoot, outDir, identity = {}, seedIdentity = null }) {
  const runtime = path.resolve(runtimeRoot || ROOT);
  const corpus = path.resolve(corpusDir || '');
  const out = path.resolve(outDir || '');
  const kbDir = path.join(runtime, 'kb');
  const dataDir = path.join(runtime, 'data');
  const version = stripTag(identity.version || getVersionTag());
  const versionTag = `v${version}`;
  const sourceSnapshot = identity.sourceSnapshot || tryGitSha(runtime);

  // ---- algorithm step 1: validate the finalized corpus and derive one explicit corpus file allowlist
  const privateStores = loadPrivateStores(kbDir);

  // Public-prose selection (primers, L2, capability cards, repo aliases) happens EXACTLY ONCE per
  // corpus round, in materializePublicInputs (scripts/public-inputs.mjs) — a SEPARATE policy from the
  // per-repo CODE store fence above. PACKAGING MUST NEVER RE-DERIVE IT.
  //
  // Finalized corpus input is immutable: reconciliation seals the canonical public-prose tree into
  // `corpus` and writes SELECTION_FILE (PUBLIC-INPUT-SELECTION.json) as proof it did. If that file is
  // already present, reconciliation has already run and `corpus` already IS the canonical, sealed
  // result — trust it byte-for-byte and do NOT call materializePublicInputs again. Calling it a
  // second time here would re-derive from the checkout regardless of whether `corpus` had already
  // been reconciled from a different checkout/ref/commit.
  //
  // materializePublicInputs is called here ONLY when no sealed selection exists yet — the genuine
  // standalone/local-dev case this CLI's own default (`--assets kb`, i.e. corpusDir === runtimeRoot's
  // own kb/) exists for, where there is nothing reconciled to trust and self-materializing fresh is
  // correct and safe (public-inputs.mjs's own stage-before-delete ordering).
  const sealedSelectionFile = path.join(corpus, SELECTION_FILE);
  let publicInputs;
  if (fs.existsSync(sealedSelectionFile)) {
    let selectionReceipt;
    try { selectionReceipt = JSON.parse(fs.readFileSync(sealedSelectionFile, 'utf8')); }
    catch (error) { fail(`sealed public-input selection (${sealedSelectionFile}) is present but unreadable (${error.message})`); }
    publicInputs = { kind: 'public-input-set', dir: corpus, selectionReceipt,
      excluded: selectionReceipt.excluded || { primers: [], topics: [], l2: [], cards: [] } };
    console.log(`[build-bundle] trusting already-reconciled public-input selection at ${sealedSelectionFile} (never re-derived)`);
  } else {
    try {
      publicInputs = materializePublicInputs({
        builderRoot: runtime, outDir: corpus,
        policy: { allowNoFence: process.env.ALLOW_NO_PRIVATE_FENCE === '1' },
      });
    } catch (error) {
      fail(`public-prose selection failed (${error.message})`);
    }
  }
  {
    const excludedCount = publicInputs.excluded.primers.length + publicInputs.excluded.topics.length
      + publicInputs.excluded.l2.length + publicInputs.excluded.cards.length;
    if (excludedCount) console.log(`[build-bundle] public-input selection excluded ${excludedCount} private prose item(s)`);
  }

  const { built: discovered, excludedPrivate } = discoverBuilt(corpus, privateStores);
  if (excludedPrivate.length) {
    console.log(`[build-bundle] EXCLUDED ${excludedPrivate.length} PRIVATE store(s): ${[...new Set(excludedPrivate)].sort().join(', ')}`);
  }
  if (discovered.length === 0) {
    fail('zero public RVF stores are eligible for release. Refusing to publish an empty brain bundle.');
  }
  const ledgerIn = readRvfGenerations(corpus);
  const generationValidation = validateSelectedRvfGenerations(corpus, {
    selectedStores: discovered, privateStores: [...privateStores],
  });
  if (generationValidation.failures.length) {
    fail(`RVF generation ledger does not exactly bind selected roots:\n${generationValidation.failures.map((f) => `  ${f}`).join('\n')}`);
  }
  const rvfIndexAudit = await auditRvfIndexes(discovered.map((name) => path.join(corpus, `${name}.big.rvf`)));
  const missingIndexes = rvfIndexAudit.filter(({ state }) => state !== 'PASS');
  if (missingIndexes.length) {
    fail(`eligible RVFs lack persisted HNSW indexes:\n${missingIndexes.map((r) => `  ${path.basename(r.path)} vectors=${r.totalVectors}`).join('\n')}\nRepair with: node scripts/rvf-index-audit.mjs --repair`);
  }

  // A deficient seed returns to preparation; packaging does NOT repair its source evidence. When a
  // sealed corpus coverage measurement exists (prepareCorpusCandidate and ci.yml's release-qe job
  // both always write one to runtimeRoot/data/source-coverage.json before calling this), the
  // finalized corpus's own discovered store set must equal it EXACTLY — a mismatch means the corpus
  // directory drifted from what was sealed, and assembly fails loudly rather than silently adapting.
  const coverageFile = path.join(dataDir, 'source-coverage.json');
  let corpusCoverage = null;
  let inventory = null;
  if (fs.existsSync(coverageFile)) {
    try { corpusCoverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8')); }
    catch (error) { fail(`sealed corpus coverage is present but unreadable (${error.message})`); }
    try {
      inventory = validatePublicInventory({ assetsDir: corpus, coverage: corpusCoverage, ledger: ledgerIn });
    } catch (error) {
      fail(`finalized corpus does not match its sealed coverage (${error.message}) — a deficient seed ` +
        'returns to preparation; packaging never repairs source evidence');
    }
    const discoveredLower = new Set(discovered.map((s) => s.toLowerCase()));
    const missingFromDisk = inventory.publicStores.filter((s) => !discoveredLower.has(s));
    if (missingFromDisk.length) fail(`classified public store(s) missing from the finalized corpus: ${missingFromDisk.join(', ')}`);
    const selected = new Set(inventory.publicStores);
    const extraOnDisk = discovered.filter((s) => !selected.has(s.toLowerCase()));
    if (extraOnDisk.length) fail(`finalized corpus carries unclassified public store(s) not present in sealed coverage: ${extraOnDisk.join(', ')}`);
  }

  // ---- classify each selected store + gather the facts every downstream view needs ---------------
  const classesFile = path.join(corpus, 'public-store-classes.json');
  const derivedNames = new Set();
  if (fs.existsSync(classesFile)) {
    try {
      const classes = JSON.parse(fs.readFileSync(classesFile, 'utf8'));
      for (const entry of classes.derived || []) derivedNames.add(String(entry.store || '').toLowerCase());
    } catch { /* an unparseable classes file is reported later, when its bytes are actually required */ }
  }
  // Unchanged from before this step: registry.tiers.json is a required checkout input (tier/star
  // labels for the manifest and README), never optional enrichment — a missing or corrupt copy
  // fails loudly here exactly as it always has, rather than silently shipping every store as tier '?'.
  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'registry.tiers.json'), 'utf8'));
  const regFlat = [];
  for (const [tier, t] of Object.entries(registry.tiers || {})) for (const r of (t.repos || [])) regFlat.push({ ...r, tier });
  const regByLower = new Map(regFlat.map((r) => [r.name.toLowerCase(), r]));

  let updaterConfig = { stores: {} };
  try { updaterConfig = JSON.parse(fs.readFileSync(path.join(corpus, 'SOURCE.json'), 'utf8')); } catch { /* enrichment only; identity always comes from the ledger */ }

  const selectedResults = discovered.map((name) => {
    const folded = name.toLowerCase();
    const generation = ledgerIn.stores?.[name]
      || Object.entries(ledgerIn.stores || {}).find(([key]) => key.toLowerCase() === folded)?.[1];
    if (!generation) fail(`${name}: no generation record in the finalized corpus ledger`);
    let chunks = null, model = null, dims = null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(corpus, `${name}.meta.json`), 'utf8'));
      chunks = m.entries ? Object.keys(m.entries).length : null; model = m.model; dims = m.dimensions;
    } catch { /* meta.json missing is reported later, as a missing required bundle file */ }
    const hasSymbols = fs.existsSync(path.join(corpus, `${name}.symbols.json`));
    const hasPrimer = fs.existsSync(path.join(corpus, `${name}-primer.md`));
    const kind = folded === 'ruv-gists' ? 'gist-aggregate' : derivedNames.has(folded) ? 'derived' : 'repository';
    const reg = regByLower.get(folded) || {};
    return {
      name, kind, tier: reg.tier || '?', stars: reg.stars ?? null,
      chunks, baseModel: model, baseDims: dims, hasSymbols, hasPrimer,
      gradeRealUse: kind === 'repository' ? gradeFor(dataDir, name, generation) : null,
      generation,
    };
  });

  // ---- algorithm step 2: fresh output directory, disjoint from all inputs ------------------------
  const ZIP = path.join(path.dirname(out), `${path.basename(out)}.zip`);
  assertDisjoint('the candidate output directory', out, [
    { label: 'the finalized corpus', dir: corpus },
    { label: 'the runtime kb build workspace', dir: kbDir },
  ]);
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true }); // a failed rebuild must not leave an older archive looking like this invocation's output
  fs.mkdirSync(out, { recursive: true });

  const { cp, cpDir, missing } = makeCopier();

  // The shipped bundle must carry the exact policy boundary used during assembly.
  cp('PRIVATE-STORES.json', out, { required: true, from: kbDir });

  // ---- algorithm step 3: copy corpus content EXCLUSIVELY from corpusDir ---------------------------
  for (const result of selectedResults) {
    const { name } = result;
    cp(`${name}.big.rvf`, out, { required: true, from: corpus });
    cp(`${name}.big.rvf.idmap.json`, out, { required: true, from: corpus });
    cp(`${name}.big.rvf.embed.json`, out, { required: true, from: corpus });
    cp(`${name}.passages.jsonl`, out, { required: true, from: corpus });
    cp(`${name}.meta.json`, out, { required: true, from: corpus });
    cp(`${name}.symbols.json`, out, { from: corpus });
    cp(`${name}-primer.md`, out, { from: corpus });
    for (const extra of (EXTRA_SIDECARS_BY_KIND[result.kind]?.(name) || [])) {
      cp(extra.name, out, { required: extra.required, from: corpus });
    }
  }
  if (selectedResults.some((r) => r.kind === 'derived')) {
    if (!cp('public-store-classes.json', out, { from: corpus })) {
      console.log('[build-bundle] note: derived store selected but public-store-classes.json is absent from the finalized corpus');
    }
  }
  cpDir(path.join(corpus, 'l2'), path.join(out, 'l2'));
  if (!cp('capability-cards.md', out, { from: corpus })) {
    console.log('[build-bundle] note: no capability-cards.md in the finalized corpus -- the fast lane ships with no card source and will honestly fall through on every query');
  }
  if (!cp('repo-aliases.json', out, { from: corpus })) {
    console.log('[build-bundle] note: no repo-aliases.json in the finalized corpus -- product-name aliases will not resolve on install');
  }
  // The master ruvnet-primer overview is a single static runtime doc, not per-repo corpus content —
  // nothing private to fence, so (unlike everything above) it ships from the exact code checkout.
  cpDir(path.join(runtime, 'primer'), path.join(out, 'primer'));

  // ---- algorithm step 4: copy runtime modules from the exact code checkout, retained module graph
  const derivedTools = resolveModuleGraph(kbDir);
  const tools = [...derivedTools, ...EXTRA_FILES];
  console.log(`[build-bundle] module graph: ${derivedTools.length} modules from ${ENTRYPOINTS.length} entry points`);
  for (const t of tools) cp(t, out, { required: true, from: kbDir });
  cp(path.join(runtime, 'scripts', 'verify-bundle.mjs'), out, { required: true, from: runtime });
  fs.mkdirSync(path.join(out, 'keys'), { recursive: true });
  cp(path.join(runtime, 'keys', 'ruvnet-brain-signing.pub.pem'), path.join(out, 'keys'), { required: true, from: runtime });

  // ---- algorithm steps 5-7: SOURCE, manifest, and generation ledger — generated ONCE ---------------
  const { source, ledger, manifestEntries } = projectStoreViews({
    selectedResults, identity: { version, sourceSnapshot }, updaterConfig,
  });
  fs.writeFileSync(path.join(out, 'SOURCE.json'), `${JSON.stringify(source, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'RVF-GENERATIONS.json'), `${JSON.stringify({
    ...ledger, kind: 'ruvnet-brain-runtime-generation-ledger',
  }, null, 2)}\n`);

  // ---- manifest.json -------------------------------------------------------------------------------
  const builtLower = new Set(discovered.map((b) => b.toLowerCase()));
  const pendingRepos = regFlat.filter((r) => !builtLower.has(r.name.toLowerCase())).map((r) => ({ name: r.name, tier: r.tier }));
  const now = new Date();
  const ORG = orgRepoCount();
  const hasConcepts = selectedResults.some((r) => r.kind === 'derived' && r.name.toLowerCase() === 'concepts');
  const manifest = {
    brainVersion: version, // FIELD = bare literal; versionTag stays the v-prefixed Release tag
    generated: now.toISOString(),
    generatedHuman: now.toUTCString(),
    coverage: { built: manifestEntries.length, catalogued: regFlat.length, orgTotalApprox: ORG.count, orgTotalSource: ORG.source, orgTotalAt: ORG.at, pending: pendingRepos.length },
    crossRepoTool: { mcp: 'forge-mcp-all.mjs', cli: 'forge-ask-all.mjs', tool: 'search_ruvnet' },
    conceptsStore: hasConcepts ? { store: 'concepts.big.rvf', note: 'L2 synthesis + per-repo primers embedded as prose; unioned by search_ruvnet so code-implemented capabilities are retrievable as high-confidence prose.' } : null,
    builtRepos: manifestEntries,
    pendingRepos,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ---- mcp.snippet.json: cross-repo entry + one per-repo entry -----------------------------------
  const mcpServers = {
    'ruvnet-brain': { command: 'node', args: [path.join(out, 'forge-mcp-all.mjs')],
      env: { KB_DIR: out, KB_MODEL_CACHE: '/ABSOLUTE/PATH/TO/models-cache (optional; speeds first run)' } },
  };
  for (const b of manifestEntries) {
    mcpServers[`ruvnet-${b.name}`] = { command: 'node', args: [path.join(out, 'forge-mcp.mjs')],
      env: { KB_DIR: out, KB_NAME: b.name } };
  }
  fs.writeFileSync(path.join(out, 'mcp.snippet.json'), JSON.stringify({
    '//': 'Add the "ruvnet-brain" entry (one tool, searches ALL repos) to your .mcp.json under "mcpServers". The per-repo "ruvnet-<name>" entries are optional (scope to one repo). Replace KB_MODEL_CACHE or remove it. DO NOT use @ruvector/rvf-mcp-server.',
    mcpServers,
  }, null, 2));

  // ---- README --------------------------------------------------------------------------------------
  const repoLines = manifestEntries.map((b) => `- **${b.name}** (${b.tier}) — ${b.chunks ?? '?'} chunks · variants: ${b.variants.join('+')}${b.gradeRealUse != null ? ` · REAL-USE ${b.gradeRealUse}` : ''}${b.hasPrimer ? ' · primer' : ''}`).join('\n');
  fs.writeFileSync(path.join(out, 'README.md'), `# RuvNet Brain — ${versionTag}

The source-grounded knowledge base for the RuvNet ecosystem. One question → the best answer from
rUv's REAL source code, across every built repo, with the file path it came from.

## Built repos (${manifestEntries.length}/${regFlat.length})
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
    fail(`missing required bundle files:\n  ${requiredMissing.join('\n  ')}`);
  }

  // ---- algorithm step 9: release coverage projection, only when a seed identity is supplied -------
  let projection = null;
  const seedComplete = seedIdentity?.tag && seedIdentity?.archiveSha256 != null
    && seedIdentity?.archiveBytes != null && seedIdentity?.baselineReceiptSha256;
  if (seedComplete) {
    if (!corpusCoverage || !inventory) {
      fail('a release coverage projection was requested (seedIdentity supplied) but no sealed corpus ' +
        `coverage was found at ${coverageFile}`);
    }
    const publicLedger = { ...ledger, kind: 'ruvnet-brain-public-generation-ledger' };
    const result = createReleaseProjection({
      corpusCoverage, selectedLedger: publicLedger, identity: { version, sourceSnapshot },
      seedIdentity, inventory,
    });
    fs.writeFileSync(path.join(out, 'COVERAGE.json'), `${JSON.stringify(result.releaseCoverage, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'CORPUS-COVERAGE.json'), result.corpusCoverageBytes);
    fs.writeFileSync(path.join(out, 'PUBLIC-RVF-GENERATIONS.json'), result.publicGenerationLedgerBytes);
    projection = result;
    bindAssembledReleaseProjection({ assetsDir: out, version, sourceSnapshot });
  }

  // ---- algorithm step 10: validate the assembled tree, write ARCHIVE-MANIFEST.json, ONE zip --------
  const archiveFiles = [];
  function collectArchiveFiles(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) collectArchiveFiles(path.join(dir, entry.name), relative);
      else if (entry.isFile()) archiveFiles.push(relative);
    }
  }
  collectArchiveFiles(out);
  archiveFiles.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  function archiveIdentity(relative) {
    const file = path.join(out, relative);
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let bytes;
      while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    } finally { fs.closeSync(fd); }
    return { path: relative.split(path.sep).join('/'), sha256: hash.digest('hex'), bytes: fs.statSync(file).size };
  }
  const archiveManifest = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-archive-manifest',
    version, releaseTag: versionTag,
    fileCount: archiveFiles.length,
    totalBytes: archiveFiles.reduce((total, file) => total + fs.statSync(path.join(out, file)).size, 0),
    files: archiveFiles.map(archiveIdentity),
  };
  fs.writeFileSync(path.join(out, 'ARCHIVE-MANIFEST.json'), `${JSON.stringify(archiveManifest, null, 2)}\n`);
  archiveFiles.push('ARCHIVE-MANIFEST.json');
  archiveFiles.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  // Required proof 5: exactly ONE zip-creation call per assembly — no repeated build/project/build.
  const zipped = process.platform === 'win32'
    ? spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${out.replaceAll("'", "''")}\\*' -DestinationPath '${ZIP.replaceAll("'", "''")}' -Force`,
    ], { encoding: 'utf8' })
    : spawnSync('zip', ['-q', '-X', ZIP, ...archiveFiles], {
      cwd: out, encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
  if (zipped.status !== 0 || !fs.existsSync(ZIP)) {
    fail(`could not create exact release ZIP (${zipped.stderr || zipped.error?.message || `exit ${zipped.status}`})`);
  }

  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-release-audit-'));
  try {
    const { extractZip } = await import('../kb/zip-extract.mjs');
    await extractZip(ZIP, extracted);
    const packagedRvfs = fs.readdirSync(extracted)
      .filter((name) => name.endsWith('.rvf')).sort().map((name) => path.join(extracted, name));
    const packagedAudit = await auditRvfIndexes(packagedRvfs);
    const packagedFailures = packagedAudit.filter(({ state }) => state !== 'PASS');
    if (packagedFailures.length) {
      fail(`extracted release artifact contains RVFs without persisted HNSW indexes:\n${packagedFailures
        .map((r) => `  ${path.basename(r.path)} vectors=${r.totalVectors ?? '?'}`).join('\n')}`);
    }
    console.log(`[build-bundle] exact archive proof: ${packagedRvfs.length} RVFs audited after extraction; 0 index failures`);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }

  console.log(`\n=== build-bundle → ${path.relative(runtime, out)} (${versionTag}) ===`);
  console.log(`built repos: ${manifestEntries.length}/${regFlat.length} | selected stores: ${discovered.length}`);
  for (const b of manifestEntries) console.log(`  ${b.tier} ${b.name.padEnd(10)} chunks=${String(b.chunks).padStart(6)} variants=${b.variants.join('+').padEnd(10)} symbols=${b.hasSymbols ? 'y' : '-'} primer=${b.hasPrimer ? 'y' : '-'} grade=${b.gradeRealUse ?? '-'} sha=${(b.builtFromSha || '').slice(0, 10)}`);
  console.log(`\nmanifest: ${path.join(path.relative(runtime, out), 'manifest.json')} | mcp snippet + README written.`);
  console.log('STATUS: assembled OK.');

  return {
    outDir: out, zipFile: ZIP, archiveManifest,
    selectedStores: discovered, manifestEntries, projection,
  };
}

// ---- CLI -----------------------------------------------------------------------------------------
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  // Corpus content is a release asset, not a Git blob. A clean worktree has zero stores unless the
  // operator supplies the canonical external corpus directory (or has already built one into kb/,
  // the genuine local/self-update case — see public-inputs.mjs's own header for why that is safe).
  const corpusDir = path.resolve(ROOT, arg('--assets', 'kb'));
  const outDir = path.resolve(ROOT, arg('--out', 'dist/ruvnet-brain'));
  // `--coverage`/`--projection` are accepted and ignored: scripts/corpus-reconcile.mjs's
  // prepareCorpusCandidate always points `--coverage` at the SAME conventional path this CLI now
  // reads directly (runtimeRoot/data/source-coverage.json), and `--projection` names the now-retired
  // two-pass round-trip this consolidation replaces with one in-process assembly.
  const seedTag = arg('--seed-tag');
  const seedSha256 = arg('--seed-sha256');
  const seedBytesArg = arg('--seed-bytes');
  const baselineReceiptSha256 = arg('--baseline-receipt-sha256');
  const seedIdentity = seedTag && seedSha256 && seedBytesArg && baselineReceiptSha256
    ? { tag: seedTag, archiveSha256: seedSha256, archiveBytes: Number(seedBytesArg), baselineReceiptSha256 }
    : null;
  try {
    await assembleBundle({
      corpusDir, runtimeRoot: ROOT, outDir,
      identity: { version: arg('--version', getVersionTag()), sourceSnapshot: arg('--source-snapshot') },
      seedIdentity,
    });
  } catch (error) {
    console.error(`[build-bundle] FATAL: ${error.message}`);
    process.exitCode = 1;
  }
}
