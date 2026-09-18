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
// `--seed-tag`/`--seed-sha256`/`--seed-bytes`/`--baseline-receipt-sha256` are optional AS A SET. When
// all four are supplied, this run additionally produces and validates the release coverage
// projection (the real-release shape a step-11 consumer switch will call). When NONE is supplied,
// assembleBundle produces a complete, correctly-selected candidate archive with no release-
// projection files — the shape scripts/corpus-reconcile.mjs's prepareCorpusCandidate and
// scripts/self-update.mjs both need. A PARTIAL set is rejected loudly: a build is either a release
// build or it is not, never a silently downgraded one.
//
// assembleBundle is OFFLINE. It never calls GitHub: the org repo total in manifest.json comes from
// the committed record (data/org-repo-count.json, `source: 'recorded'`) or is honestly `unknown`.
// Assembling sealed bytes must not depend on network availability, and must not vary with it.
//
// CONSUMER STATUS (P1-c, 2026-09-14): the previous note here said ci.yml's release-qe job ran a
// sequence that "cannot pass this file's sealed-input checks, by design" — it invoked a
// release-projection.mjs CLI that could only `exit 1`, then passed --coverage/--projection flags this
// CLI rejected outright. Documenting an expected failure is not a release gate. The consumer and the
// scripts now AGREE: ci.yml declares the legacy rail with --legacy-seed-projection, and this file
// honours it as ONE explicitly-named, temporary mode (assembleBundle's `legacySeedProjection`) that
// runs the pre-consolidation two-pass semantics against the pinned pre-Step-3/4 seed — with the
// public-prose selection materialized fresh and FENCED (never the pre-Step-3 wholesale checkout copy)
// and WITHOUT the packaging-time receipt fabrication Step 3 deleted. Measured against the live
// v4.2.1-dev seed on 2026-09-14: 186 stores, no PUBLIC-INPUT-SELECTION.json, no
// public-store-classes.json, no ruv-gists.sources.json. Its unprovable aggregate stores are scoped
// out rather than shipped unproven. THE WHOLE MODE RETIRES AT PLAN STEP 11, when a Step-4-produced
// seed is published and data/corpus-seed.json is re-pinned to it.
import { isIngestibleDisposition } from './coverage-integrity.mjs';
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
import { materializePublicInputs, SELECTION_FILE, validateSelectionReceipt } from './public-inputs.mjs';
import { isPrivate, loadPrivateSlugs, shouldFenceL2 } from './private-fence.mjs';
import { validateCoverageArtifactBindings, validateCoverageLedger } from './coverage-integrity.mjs';
// The org total is DERIVED, never a literal: it was hardcoded 248 in this file and in its
// sibling while the account actually had 200 — one stale fact, restated twice (2026-08-12).
import { orgRepoCount } from './org-repo-count.mjs';
import { parse } from '@babel/parser';
import { RUNTIME_LOADING_CONTRACT } from './modulegraph-runtime-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

export function validateRequiredRuntimeFiles(runtimeRoot) {
  const runtime = path.resolve(runtimeRoot);
  const requiredFiles = [...new Map(Object.values(RUNTIME_LOADING_CONTRACT)
    .flatMap((entry) => entry.requiredFiles || [])
    .map((entry) => [entry.destination, entry])).values()];
  return requiredFiles.map((requiredFile) => {
    const source = path.join(runtime, requiredFile.source);
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) fail(`required runtime validator is missing: ${source}`);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    if (digest !== requiredFile.sha256) fail(`required runtime validator differs from the reviewed canonical source: ${source}`);
    return { ...requiredFile, source };
  });
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

/**
 * assertSelectionMatchesCurrentFence — P1-b (Dual's step-5 review, 2026-09-14).
 *
 * A public-input selection receipt proves what its PRODUCER decided, against the fence that existed
 * when it ran. This build ships a DIFFERENT artifact: `runtimeRoot/kb/PRIVATE-STORES.json`, the
 * CURRENT fence. When the two disagree, the archive ships prose for a store its own shipped fence
 * declares private. The four surfaces the producer filters (public-inputs.mjs:287-341) are checked
 * here, ALL FOUR — primers, per-repo topics files, L2 slugs, and capability-card sections. The card
 * sections were the surface a narrower check would have missed: a store with no selected RVF keeps
 * its card (and its primer and topics) because the store-inventory checks never look at prose.
 *
 * Fails LOUD — never silently filters. Derived concepts already embed this text
 * (scripts/corpus-aggregates.mjs:59-65 reads the same prose into concepts.passages.jsonl), so a
 * file-drop here would ship the private text anyway, inside the aggregate. Rejection forces the
 * corpus back to preparation, where the aggregates are rebuilt under the current fence.
 */
function assertSelectionMatchesCurrentFence({ selectionReceipt, privateStores, kbDir, corpusLabel }) {
  const slugFence = loadPrivateSlugs(kbDir, privateStores);
  if (!slugFence.ok) fail(`current private fence cannot be read (${slugFence.reason})`);
  const included = selectionReceipt.included || {};
  const ownership = selectionReceipt.ownership || {};
  const violations = [];
  for (const repo of included.primers || []) {
    if (isPrivate(privateStores, repo)) violations.push(`primer ${repo}-primer.md (repo "${repo}" is private now)`);
  }
  for (const repo of included.topics || []) {
    if (isPrivate(privateStores, repo)) violations.push(`topics l2-topics.${repo}.json (repo "${repo}" is private now)`);
  }
  for (const slug of included.l2 || []) {
    const repo = ownership[slug] || 'ruvnet';
    if (shouldFenceL2({ repo, slug }, privateStores, slugFence.slugs)) {
      violations.push(`l2/${slug}.md (owned by "${repo}", fenced now)`);
    }
  }
  for (const repo of included.cards || []) {
    if (isPrivate(privateStores, repo)) violations.push(`capability-cards.md section "## ${repo}" (repo "${repo}" is private now)`);
  }
  if (!violations.length) return;
  fail(`the sealed public-input selection is incompatible with the CURRENT private fence ` +
    `(${path.join(kbDir, 'PRIVATE-STORES.json')}) — it was sealed before ${violations.length} item(s) were fenced, ` +
    `and this build ships that fence alongside them:\n${violations.map((v) => `  ${v}`).join('\n')}\n` +
    `Selection: ${corpusLabel}. Rejected, not filtered: derived concepts already embed this prose, so the ` +
    `corpus returns to preparation and its aggregates are rebuilt under the current fence.`);
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
export function makeCopier() {
  let copied = 0;
  const missing = [];
  const destinations = new Map();
  /** cp(relativeName, destDir, { required, from }) — `from` is the exact source directory; every
   * call site names it explicitly (never an implicit ASSETS-vs-KB default) so "which root did this
   * file come from" is always visible at the call site, not inferred from a flag. */
  function cp(name, destDir, { required = false, from, destinationName = null } = {}) {
    const s = path.isAbsolute(name) ? name : path.join(from, name);
    const stat = fs.existsSync(s) ? fs.lstatSync(s) : null;
    if (stat?.isSymbolicLink()) fail(`refusing to copy a symbolic link into the bundle: ${s}`);
    if (!stat || !stat.isFile()) { if (required) missing.push(name); return false; }
    const relative = destinationName || (path.isAbsolute(name) ? path.basename(s) : name.split(path.sep).join('/'));
    const destination = path.resolve(destDir, relative);
    const within = path.relative(path.resolve(destDir), destination);
    if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      fail(`destination path escapes bundle root: ${relative}`);
    }
    const prior = destinations.get(destination);
    if (prior && prior !== path.resolve(s)) fail(`destination collision while copying ${s}: ${relative} already supplied by ${prior}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(s, destination);
    destinations.set(destination, path.resolve(s));
    copied++;
    return true;
  }
  function cpDir(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return false;
    const walk = (current, relative = '') => {
      for (const e of fs.readdirSync(current, { withFileTypes: true })) {
        const next = relative ? path.join(relative, e.name) : e.name;
        if (e.isSymbolicLink()) fail(`refusing to copy a symbolic link into the bundle: ${path.join(current, e.name)}`);
        if (e.isDirectory()) walk(path.join(current, e.name), next);
        else cp(next, destDir, { required: true, from: srcDir });
      }
    };
    walk(srcDir);
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

/** Local specifiers from the parsed graph; comments and strings cannot create false edges. */
export function localImportsOf(absFile) {
  const ast = parse(fs.readFileSync(absFile, "utf8"), { sourceType: "unambiguous", plugins: ["dynamicImport", "importMeta", "topLevelAwait"] });
  const bindings = new Map();
  const ambiguous = new Set();
  const requireAliases = new Set(['require']);
  const createRequireAliases = new Set(['createRequire']);
  const moduleNamespaces = new Set();
  const specs = new Set();
  const add = (value) => { if (value.startsWith("./") || value.startsWith("../")) specs.add(value); };
  const literal = (node, resolving = new Set()) => {
    if (!node) return null;
    if (node.type === "StringLiteral") return { known: true, value: node.value };
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return { known: true, value: node.quasis[0].value.cooked };
    if (node.type === "Identifier" && ambiguous.has(node.name)) return { known: false, value: null };
    if (node.type === "Identifier" && bindings.has(node.name)) {
      if (resolving.has(node.name)) return { known: false, value: null };
      const next = new Set(resolving);
      next.add(node.name);
      return literal(bindings.get(node.name), next);
    }
    return { known: false, value: null };
  };
  const collectBindings = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === 'ImportDeclaration' && ['node:module', 'module'].includes(node.source?.value)) {
      for (const specifier of node.specifiers || []) {
        if (specifier.type === 'ImportSpecifier' && specifier.imported?.name === 'createRequire') createRequireAliases.add(specifier.local.name);
        if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') moduleNamespaces.add(specifier.local.name);
      }
    }
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      const callee = node.init?.type === 'CallExpression' ? node.init.callee : null;
      const createsRequire = callee?.type === 'Identifier' && createRequireAliases.has(callee.name)
        || callee?.type === 'MemberExpression' && !callee.computed && callee.property?.name === 'createRequire'
          && callee.object?.type === 'Identifier' && moduleNamespaces.has(callee.object.name);
      if (createsRequire || node.init?.type === 'Identifier' && requireAliases.has(node.init.name)) requireAliases.add(node.id.name);
      if (node.init?.type === 'MemberExpression' && !node.init.computed && node.init.property?.name === 'createRequire'
        && node.init.object?.type === 'Identifier' && moduleNamespaces.has(node.init.object.name)) createRequireAliases.add(node.id.name);
      if (node.init?.type === 'Identifier' && createRequireAliases.has(node.init.name)) createRequireAliases.add(node.id.name);
      if (bindings.has(node.id.name)) ambiguous.add(node.id.name);
      else if (node.init) bindings.set(node.id.name, node.init);
    }
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern'
      && node.init?.type === 'Identifier' && moduleNamespaces.has(node.init.name)) {
      for (const property of node.id.properties || []) {
        if (property.type !== 'ObjectProperty' || property.computed || property.key?.name !== 'createRequire') continue;
        const alias = property.value?.type === 'Identifier' ? property.value.name : null;
        if (alias) createRequireAliases.add(alias);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(collectBindings); else if (value && typeof value === "object") collectBindings(value);
    }
  };
  collectBindings(ast.program);
  // Resolve alias chains after the complete program has been collected, so declaration order
  // cannot turn `const r = localRequire` into an accidentally untracked loader.
  let changed = true;
  while (changed) {
    changed = false;
    for (const init of bindings.entries()) {
      const [name, value] = init;
      if (value?.type === 'Identifier' && requireAliases.has(value.name) && !ambiguous.has(name) && !requireAliases.has(name)) {
        requireAliases.add(name); changed = true;
      }
      if (value?.type === 'Identifier' && createRequireAliases.has(value.name) && !ambiguous.has(name) && !createRequireAliases.has(name)) {
        createRequireAliases.add(name); changed = true;
      }
    }
  }
  const markPattern = (pattern) => {
    if (!pattern || typeof pattern !== 'object') return;
    if (pattern.type === 'Identifier') ambiguous.add(pattern.name);
    for (const [key, value] of Object.entries(pattern)) {
      if (['loc', 'comments', 'type', 'name'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(markPattern);
      else if (value && typeof value === 'object') markPattern(value);
    }
  };
  const markMutable = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclaration' && node.kind !== 'const') {
      node.declarations.forEach((decl) => markPattern(decl.id));
    }
    if (node.type === 'VariableDeclarator' && node.id?.type !== 'Identifier') markPattern(node.id);
    if (node.type === 'AssignmentExpression') markPattern(node.left);
    if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier') ambiguous.add(node.argument.name);
    if (Array.isArray(node.params)) for (const param of node.params) markPattern(param);
    if (node.type === 'CatchClause') markPattern(node.param);
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(markMutable); else if (value && typeof value === 'object') markMutable(value);
    }
  };
  markMutable(ast.program);
  const unresolved = [];
  const fileName = path.basename(absFile);
  const contract = RUNTIME_LOADING_CONTRACT[fileName];
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(absFile)).digest('hex');
  const contractSites = sourceHash === contract?.sha256 ? contract.sites : [];
  const siteMatches = (shape, identifier) => contractSites.some((site) => site.shape === shape
    && (site.identifier === undefined || site.identifier === identifier));
  const trustedOpaque = (argument, callee) => {
    const pathCall = argument?.type === 'MemberExpression' && argument.property?.type === 'Identifier'
      && argument.property.name === 'href' && argument.object?.type === 'CallExpression'
      && argument.object.callee?.type === 'Identifier' && argument.object.callee.name === 'pathToFileURL';
    const pathArgument = pathCall ? argument.object.arguments[0] : null;
    if (pathCall && pathArgument?.type === 'Identifier'
      && siteMatches('pathToFileURL(identifier).href', pathArgument.name)) return true;
    if (pathCall && pathArgument?.type === 'ConditionalExpression'
      && siteMatches('pathToFileURL(conditional).href')) return true;
    if (callee?.type === 'Identifier' && callee.name === 'localRequire' && argument?.type === 'Identifier'
      && siteMatches('require-alias', argument.name)) return true;
    return argument?.type === 'Identifier' && siteMatches('identifier', argument.name);
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source?.type === "StringLiteral") add(node.source.value);
    if (node.type === "CallExpression" && (node.callee?.type === "Import"
      || (node.callee?.type === "Identifier" && requireAliases.has(node.callee.name)))) {
      const argument = node.arguments[0];
      if (node.callee?.type === 'Identifier' && ambiguous.has(node.callee.name)) {
        if (argument) unresolved.push(argument);
      } else {
      const urlObject = argument?.type === 'NewExpression' ? argument : argument?.type === 'MemberExpression' && argument.object?.type === 'NewExpression' ? argument.object : null;
      const urlImportMeta = urlObject?.callee?.type === 'Identifier' && urlObject.callee.name === 'URL'
        && urlObject.arguments[1]?.type === 'MemberExpression' && urlObject.arguments[1].object?.type === 'MetaProperty';
      const result = urlImportMeta ? literal(urlObject.arguments[0]) : literal(argument);
      if (result?.known) add(result.value);
      else if (node.arguments[0] && !trustedOpaque(node.arguments[0], node.callee)) unresolved.push(node.arguments[0]);
      }
    }
    const recognizedFactory = node.callee?.type === 'Identifier' && createRequireAliases.has(node.callee.name)
      || node.callee?.type === 'MemberExpression' && !node.callee.computed
        && node.callee.property?.name === 'createRequire'
        && node.callee.object?.type === 'Identifier' && moduleNamespaces.has(node.callee.object.name);
    if (node.type === 'CallExpression' && !recognizedFactory && !requireAliases.has(node.callee?.name)
      && (node.callee?.type === 'Identifier' && node.callee.name === 'createRequire'
        || node.callee?.type === 'MemberExpression' && node.callee.property?.name === 'createRequire')) {
      unresolved.push(node.arguments[0] || node);
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast.program);
  if (unresolved.length) {
    fail(`${absFile} contains an unresolved or ambiguous dynamic module specifier; use a unique const literal relative path or a bound package name`);
  }
  return [...specs];
}

/** Transitive closure of local modules reachable from the entry points, relative to `kbDir`. */
export function resolveModuleGraph(kbDir, entrypoints = ENTRYPOINTS) {
  const seen = new Set();
  const queue = entrypoints.map((rel) => ({ rel, from: null }));
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
/** The single retrieval closure used by assembly and controlled measurement. */
export function retrievalRuntimeFiles(kbDir) {
  const modules = resolveModuleGraph(kbDir, ['forge-ask-all.mjs']);
  const requiredFiles = [...new Map(modules.flatMap(file =>
    (RUNTIME_LOADING_CONTRACT[path.basename(file)]?.requiredFiles || []).map(row => [row.destination, row]))).values()];
  return {files: [...new Set([...modules, ...requiredFiles.map(row => row.destination), 'package.json', 'package-lock.json'])].sort(), requiredFiles};
}

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
  const generationProvenance = (generation) => ({
    ...(generation.sourceMode === undefined ? {} : { sourceMode: generation.sourceMode }),
    ...(generation.forkDelta === undefined ? {} : { forkDelta: generation.forkDelta }),
  });
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
      ...generationProvenance(generation),
    };
    if (kind !== 'repository') continue; // SOURCE.json and manifest rows are repository-only, exactly as forge-refresh.mjs's own SOURCE.json has always been.
    const updater = (config.stores && config.stores[name]) || {};
    // Spread the corpus's own updater entry FIRST so every field kb/forge-update.mjs may read
    // (updateManaged, a per-store releaseTag, anything added later) survives; then bind the
    // identity fields from the selected generation, which always win.
    sourceStores[name] = {
      ...updater,
      kbName: updater.kbName || name,
      sourceRepo: updater.sourceRepo || null,
      sourceCommit: generation.sourceCommit ?? null,
      sourceDescribe: updater.sourceDescribe || null,
      builtUtc: generation.builtUtc,
      builder: updater.builder || config.builder || 'rvf-kb-forge',
      canonicalManifestUrl: updater.canonicalManifestUrl || null,
      canonicalBundleUrl: updater.canonicalBundleUrl || null,
      selfUpdate: updater.selfUpdate || `node forge-update.mjs ${name}`,
      ...generationProvenance(generation),
    };
    manifestEntries.push({
      name, tier: result.tier, stars: result.stars,
      chunks: result.chunks, baseModel: result.baseModel, baseDims: result.baseDims,
      variants: ['big'], hasSymbols: result.hasSymbols, hasPrimer: result.hasPrimer, hasBig: true,
      gradeRealUse: result.gradeRealUse,
      builtFromSha: generation.sourceCommit || 'unknown',
      status: 'built',
      ...generationProvenance(generation),
    });
  }
  // Top-level envelope: the corpus's own top-level updater fields survive (spread first); identity
  // fields and the store map are then bound from this assembly and always win.
  const { stores: _configStores, ...configTopLevel } = config;
  const source = {
    ...configTopLevel,
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
export async function assembleBundle(options = {}) {
  // Every temporary staging directory this pass creates is removed here, on success AND on failure.
  // P1-a: the public-prose staging directory lives in os.tmpdir(); the corpus checkout is never one.
  const scratchDirs = [];
  try {
    return await assembleBundleImpl(options, scratchDirs);
  } finally {
    for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function assembleBundleImpl({ corpusDir, runtimeRoot, outDir, identity = {}, seedIdentity = null,
  legacySeedProjection = null }, scratchDirs) {
  const runtime = path.resolve(runtimeRoot || ROOT);
  const corpus = path.resolve(corpusDir || '');
  const out = path.resolve(outDir || '');
  const kbDir = path.join(runtime, 'kb');
  const dataDir = path.join(runtime, 'data');
  const version = stripTag(identity.version || getVersionTag());
  const versionTag = `v${version}`;
  const sourceSnapshot = identity.sourceSnapshot || tryGitSha(runtime);

  // A build is a release build or it is not. A seedIdentity that is present but incomplete is
  // rejected HERE, before any work, never silently downgraded to a non-release candidate.
  if (seedIdentity !== null && seedIdentity !== undefined) {
    const { tag, archiveSha256, archiveBytes, baselineReceiptSha256 } = seedIdentity;
    if (typeof tag !== 'string' || !tag || !/^[a-f0-9]{64}$/.test(String(archiveSha256 || ''))
      || !Number.isSafeInteger(archiveBytes) || archiveBytes < 1
      || !/^[a-f0-9]{64}$/.test(String(baselineReceiptSha256 || ''))) {
      fail('seed identity is incomplete or malformed (tag, archiveSha256, archiveBytes, and baselineReceiptSha256 '
        + 'are all required together) — refusing to silently downgrade to a non-release build');
    }
  }

  // ---- LEGACY SEED PROJECTION (temporary; retires at plan step 11) --------------------------------
  // The ONE explicitly-declared compatibility mode for the pinned PRE-Step-3/4 corpus seed. See this
  // file's header. It is never inferred: a caller must pass it, and it is mutually exclusive with the
  // new in-process release path, so no run can accidentally be half of each.
  if (legacySeedProjection !== null && legacySeedProjection !== undefined) {
    if (seedIdentity !== null && seedIdentity !== undefined) {
      fail('legacySeedProjection and seedIdentity are mutually exclusive: the legacy two-pass seed path and the '
        + 'in-process single-pass release projection are two different release rails, never half of each');
    }
    // Pass 1 (no projection yet) produces the candidate the projection producer measures; pass 2
    // carries the produced projection back in. A HALF-supplied pass 2 is rejected, never silently
    // treated as pass 1 — that would publish an archive with no COVERAGE.json at all.
    const { coverageFile: legacyCoverage = null, projectionDir = null } = legacySeedProjection;
    if ((projectionDir === null) !== (legacyCoverage === null)) {
      fail('legacy seed projection needs BOTH --coverage and --projection together (pass 2), or NEITHER (pass 1)');
    }
    if (projectionDir !== null) {
      if (!fs.existsSync(path.resolve(projectionDir))) {
        fail(`legacy seed projection directory is missing (${projectionDir}) — run scripts/release-projection.mjs first`);
      }
      if (!fs.existsSync(path.resolve(legacyCoverage))) fail(`legacy seed projection coverage is missing (${legacyCoverage})`);
    }
  }

  // ---- algorithm step 1: validate the finalized corpus and derive one explicit corpus file allowlist
  const privateStores = loadPrivateStores(kbDir);

  // Public-prose selection (primers, L2, capability cards, repo aliases) happens EXACTLY ONCE per
  // corpus round, in materializePublicInputs (scripts/public-inputs.mjs) — a SEPARATE policy from the
  // per-repo CODE store fence above. PACKAGING MUST NEVER RE-DERIVE IT — and must never TRUST a seal
  // it has not verified, either. THREE cases, chosen by an EXPLICIT condition, never by whether a file
  // happens to exist:
  //
  //   STANDALONE — corpus IS runtimeRoot/kb (this CLI's own `--assets kb` default; self-update.mjs).
  //     Nothing reconciled can live here, so the selection is ALWAYS materialized fresh — into a
  //     PRIVATE TEMPORARY STAGING DIRECTORY, never into the tracked checkout (see below). A receipt
  //     already sitting in kb/ is never read, so a stale checkout receipt can never flip this toggle.
  //   EXTERNAL — any other corpus directory. It MUST carry the receipt reconciliation sealed there,
  //     and that receipt must VALIDATE (validateSelectionReceipt: kind, schemaVersion, recomputed
  //     receiptSha256, every sealed file present with exact bytes, every included name backed, and
  //     no unsealed managed prose on disk). No receipt, or a failing one, is a defect in the corpus:
  //     assembly stops and the seed returns to preparation. It is never self-materialized into (and
  //     thereby mutated) a directory this build does not own.
  //   LEGACY SEED — the operator explicitly declared `--legacy-seed-projection` (see this file's
  //     header). The corpus is the pinned PRE-Step-3/4 release seed, which carries stores but no
  //     sealed public-input selection at all. Prose is selected fresh from the checkout into the same
  //     private staging directory STANDALONE uses; the seed directory is read-only throughout.
  //     RETIRES AT PLAN STEP 11.
  //
  // P1-a (Dual, 2026-09-14): STANDALONE used to pass `corpus` (= the tracked kb/) as
  // materializePublicInputs' `outDir`, so a plain `node scripts/build-bundle.mjs` DELETED tracked
  // source files — public-inputs.mjs:363-366 removes every managed entry the round did not reproduce
  // and promotes `l2/` wholesale. That silently destroyed kb/cognitum-api-primer.md (fenced) and both
  // kb/l2/rejected/*.md during a test run on 2026-09-13. Materialization now always targets a private
  // staging directory under os.tmpdir(); the corpus checkout is never an output.
  const sameDirectory = (left, right) => {
    // FILESYSTEM IDENTITY, not a lexical string compare (P2, Dual 2026-09-14): `corpus === kbDir`
    // was bypassable in both directions — a runtimeRoot/kb symlinked to an external directory
    // satisfied it and got materialized into, while a symlink ALIAS of the same kb directory
    // compared unequal and took the external branch. dev+ino classifies both spellings correctly.
    try {
      const a = fs.statSync(left), b = fs.statSync(right);
      return a.dev === b.dev && a.ino === b.ino;
    } catch { return path.resolve(left) === path.resolve(right); }
  };
  const legacySeed = legacySeedProjection !== null && legacySeedProjection !== undefined;
  const standalone = !legacySeed && sameDirectory(corpus, kbDir);
  const sealedSelectionFile = path.join(corpus, SELECTION_FILE);
  let selectionReceipt;
  // Where the SEALED PROSE is read from. For a sealed external corpus that is the corpus itself; for
  // a freshly-materialized selection it is the staging directory, never the corpus.
  let proseDir = corpus;
  if (standalone || legacySeed) {
    proseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-public-inputs-'));
    scratchDirs.push(proseDir);
    try {
      ({ selectionReceipt } = materializePublicInputs({
        builderRoot: runtime, outDir: proseDir,
        policy: { allowNoFence: process.env.ALLOW_NO_PRIVATE_FENCE === '1' },
      }));
    } catch (error) {
      fail(`public-prose selection failed (${error.message})`);
    }
  } else {
    if (!fs.existsSync(sealedSelectionFile)) {
      fail(`external corpus ${corpus} carries no sealed public-input selection (${SELECTION_FILE}) — ` +
        'reconciliation never sealed this directory; it returns to preparation and is never self-materialized here');
    }
    try { selectionReceipt = JSON.parse(fs.readFileSync(sealedSelectionFile, 'utf8')); }
    catch (error) { fail(`sealed public-input selection (${sealedSelectionFile}) is present but unreadable (${error.message})`); }
  }
  // Verified on read in ALL cases (a fresh materialization is checked against its own output too):
  // the seal is a proof, not a toggle.
  try {
    validateSelectionReceipt({ receipt: selectionReceipt, dir: proseDir });
  } catch (error) {
    fail(`${error.message} (${proseDir === corpus ? sealedSelectionFile : 'freshly materialized selection'})`);
  }
  // P1-b (Dual, 2026-09-14): a VALID seal is not the same as a seal this build is allowed to ship.
  // The producer filtered with its THEN-current fence; assembly loads the CURRENT checkout fence at
  // the top of this function and SHIPS it (PRIVATE-STORES.json, below) — so a selection sealed while
  // a store was public, then fenced afterwards, used to ship that store's prose alongside a fence
  // declaring it private. Reject the selection outright rather than filter it: derived concepts
  // (scripts/corpus-aggregates.mjs:59-65) have ALREADY embedded this text into their passages, so
  // dropping files here would leave the private prose inside concepts.passages.jsonl. The corpus
  // returns to preparation and its aggregates are rebuilt under the current fence.
  assertSelectionMatchesCurrentFence({ selectionReceipt, privateStores, kbDir, corpusLabel: proseDir });
  if (!standalone && !legacySeed) {
    console.log(`[build-bundle] trusting already-reconciled public-input selection at ${sealedSelectionFile} (verified, never re-derived)`);
  }
  {
    const excluded = selectionReceipt.excluded || { primers: [], topics: [], l2: [], cards: [] };
    const excludedCount = excluded.primers.length + excluded.topics.length + excluded.l2.length + excluded.cards.length;
    if (excludedCount) console.log(`[build-bundle] public-input selection excluded ${excludedCount} private prose item(s)`);
  }

  let { built: discovered, excludedPrivate } = discoverBuilt(corpus, privateStores);
  // Stores the LEGACY SEED mode scopes out. The seed's own generation ledger is immutable evidence
  // and is never rewritten here, so they are declared to validateSelectedRvfGenerations as explicitly
  // EXCLUDED rather than left looking like unexplained extra generation records.
  const legacyExcluded = [];
  // LEGACY SEED pass 2 (retires at plan step 11): the externally-produced release projection is the
  // selection authority for this mode, exactly as it was before the step-5 consolidation. Scope the
  // discovered set to the stores that projection actually bound, so the assembled tree and
  // PUBLIC-RVF-GENERATIONS.json describe the same set (validateCoverageDirectory requires it).
  if (legacySeed) {
    // A store whose REQUIRED provenance sidecar the seed never carried is not publishable, and is
    // scoped out loudly rather than shipped unproven. Measured against v4.2.1-dev on 2026-09-14: the
    // seed carries ruv-gists.big.rvf with no ruv-gists.sources.json, and concepts.big.rvf with no
    // public-store-classes.json to classify it. The PRE-Step-3 build-bundle papered over exactly this
    // by SYNTHESIZING both files at packaging time — a receipt whose only declared input was its own
    // packaged output. Step 3 deleted that fabrication on purpose; this mode does not bring it back.
    const unprovable = discovered.filter((name) => {
      const folded = name.toLowerCase();
      if (folded === 'ruv-gists') return !fs.existsSync(path.join(corpus, 'ruv-gists.sources.json'));
      if (folded === 'concepts') return !fs.existsSync(path.join(corpus, 'public-store-classes.json'));
      return false;
    });
    if (unprovable.length) {
      discovered = discovered.filter((name) => !unprovable.includes(name));
      legacyExcluded.push(...unprovable);
      console.log(`[build-bundle] legacy seed carries no provenance receipt for ${unprovable.sort().join(', ')} — `
        + 'scoped out of this assembly rather than shipped unproven (fixed by the step-8..11 re-seed)');
    }
  }
  if (legacySeed && legacySeedProjection.projectionDir) {
    let legacyCoverage;
    try { legacyCoverage = JSON.parse(fs.readFileSync(path.resolve(legacySeedProjection.coverageFile), 'utf8')); }
    catch (error) { fail(`legacy release projection coverage is unreadable (${error.message})`); }
    if (legacyCoverage?.kind !== 'ruvnet-brain-release-coverage' || !Array.isArray(legacyCoverage.rows)) {
      fail('legacy release projection coverage is not a ruvnet-brain-release-coverage ledger');
    }
    const projectedClasses = path.join(path.resolve(legacySeedProjection.projectionDir), 'public-store-classes.json');
    const projectedDerived = fs.existsSync(projectedClasses)
      ? (JSON.parse(fs.readFileSync(projectedClasses, 'utf8')).derived || []).map((e) => String(e?.store || '').toLowerCase())
      : [];
    const projected = new Set([
      ...legacyCoverage.rows.filter((row) => isIngestibleDisposition(row.disposition))
        .map((row) => String(row?.artifact?.store || '').toLowerCase()),
      ...projectedDerived,
    ].filter(Boolean));
    const absent = [...projected].filter((store) => !discovered.some((name) => name.toLowerCase() === store));
    if (absent.length) fail(`legacy release projection names store(s) the seed does not carry: ${absent.sort().join(', ')}`);
    const dropped = discovered.filter((name) => !projected.has(name.toLowerCase()));
    discovered = discovered.filter((name) => projected.has(name.toLowerCase()));
    legacyExcluded.push(...dropped);
    if (dropped.length) console.log(`[build-bundle] legacy projection scoped out ${dropped.length} store(s): ${dropped.sort().join(', ')}`);
  }
  if (excludedPrivate.length) {
    console.log(`[build-bundle] EXCLUDED ${excludedPrivate.length} PRIVATE store(s): ${[...new Set(excludedPrivate)].sort().join(', ')}`);
  }
  if (discovered.length === 0) {
    fail('zero public RVF stores are eligible for release. Refusing to publish an empty brain bundle.');
  }
  const ledgerIn = readRvfGenerations(corpus);
  const generationValidation = validateSelectedRvfGenerations(corpus, {
    selectedStores: discovered, privateStores: [...privateStores], excludedStores: legacyExcluded,
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
  if (legacySeed) {
    // LEGACY SEED (retires at plan step 11): the pinned seed is an OLDER, immutable corpus and
    // data/source-coverage.json is the CURRENT observation of the source universe — two different
    // evidence planes, by design. Measured against the live v4.2.1-dev seed on 2026-09-14: the seed
    // carries 186 stores and no gist receipt, while the current coverage carries 195 eligible stores
    // and 492 eligible gists, so the equality cross-check above cannot hold and is not asserted here.
    // The projection producer (scripts/release-projection.mjs) does the scoping instead: it keeps
    // only rows the seed actually carries and preserves the complete observation in
    // CORPUS-COVERAGE.json. Step 11 re-pins a Step-4-produced seed and this branch is deleted.
    console.log('[build-bundle] LEGACY SEED MODE (retires at plan step 11): the sealed-coverage equality '
      + 'cross-check is not asserted against this pre-Step-3/4 seed; scoping comes from the release projection');
  } else if (fs.existsSync(coverageFile)) {
    try { corpusCoverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8')); }
    catch (error) { fail(`sealed corpus coverage is present but unreadable (${error.message})`); }
    // The coverage is itself a sealed ledger: its own digests (coverageGeneration, enumeration
    // receipt, policy digests) must recompute before anything here trusts a row in it.
    const ledgerCheck = validateCoverageLedger(corpusCoverage);
    if (corpusCoverage?.kind !== 'ruvnet-brain-corpus-coverage' || !ledgerCheck.valid) {
      fail(`sealed corpus coverage is invalid: ${ledgerCheck.failures.join('; ') || 'not a ruvnet-brain-corpus-coverage ledger'}`);
    }
    try {
      inventory = validatePublicInventory({ assetsDir: corpus, coverage: corpusCoverage, ledger: ledgerIn });
    } catch (error) {
      fail(`finalized corpus does not match its sealed coverage (${error.message}) — a deficient seed ` +
        'returns to preparation; packaging never repairs source evidence');
    }
    // Bind coverage to THIS corpus through the canonical validator shared by assembly and archive
    // consumers; every eligible artifact and repository source generation must match this ledger.
    try { validateCoverageArtifactBindings(corpusCoverage, ledgerIn); }
    catch (error) { fail(`coverage artifacts do not match this corpus's ledger (${error.message})`); }
    const discoveredLower = new Set(discovered.map((s) => s.toLowerCase()));
    const missingFromDisk = inventory.publicStores.filter((s) => !discoveredLower.has(s));
    if (missingFromDisk.length) fail(`classified public store(s) missing from the finalized corpus: ${missingFromDisk.join(', ')}`);
    const selected = new Set(inventory.publicStores);
    const extraOnDisk = discovered.filter((s) => !selected.has(s.toLowerCase()));
    if (extraOnDisk.length) fail(`finalized corpus carries unclassified public store(s) not present in sealed coverage: ${extraOnDisk.join(', ')}`);
  }

  // ---- classify each selected store + gather the facts every downstream view needs ---------------
  // public-store-classes.json is the derived-store registry (concepts). FAIL-LOUD: an unparseable or
  // malformed copy is never tolerated. A MISSING copy is tolerated only in the standalone case (a
  // local kb/ that has never built a derived store) — and even there never when a `concepts` store
  // is present, since misclassifying it as a repository would yield a wrong SOURCE.json row, a wrong
  // manifest row, a wrong grade lookup, and a wrong per-repo MCP entry. A sealed corpus always has
  // one (buildConceptAggregate writes it every reconciliation round), so its absence there is a defect.
  const classesFile = path.join(corpus, 'public-store-classes.json');
  const derivedNames = new Set();
  if (fs.existsSync(classesFile)) {
    let classes;
    try { classes = JSON.parse(fs.readFileSync(classesFile, 'utf8')); }
    catch (error) { fail(`public-store-classes.json is present but unreadable (${error.message})`); }
    if (classes?.schemaVersion !== 1 || !Array.isArray(classes.derived)) {
      fail('public-store-classes.json is malformed (expected schemaVersion 1 with a derived array)');
    }
    for (const entry of classes.derived) derivedNames.add(String(entry?.store || '').toLowerCase());
  } else if (legacySeed) {
    // The pinned pre-Step-3/4 seed predates the derived-store registry (measured 2026-09-14: absent
    // from v4.2.1-dev). The legacy projection producer already treated its absence as "no derived
    // stores", exactly as here. Retires at plan step 11 with the rest of this mode.
    console.log('[build-bundle] legacy seed carries no public-store-classes.json — no derived stores are classified');
  } else if (!standalone) {
    fail(`sealed corpus ${corpus} carries no public-store-classes.json — reconciliation always writes one; this corpus returns to preparation`);
  } else if (discovered.some((name) => name.toLowerCase() === 'concepts')) {
    fail('a concepts store is present but public-store-classes.json is missing — it cannot be classified, and will not be guessed');
  }
  // Unchanged from before this step: registry.tiers.json is a required checkout input (tier/star
  // labels for the manifest and README), never optional enrichment — a missing or corrupt copy
  // fails loudly here exactly as it always has, rather than silently shipping every store as tier '?'.
  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'registry.tiers.json'), 'utf8'));
  const regFlat = [];
  for (const [tier, t] of Object.entries(registry.tiers || {})) for (const r of (t.repos || [])) regFlat.push({ ...r, tier });
  const regByLower = new Map(regFlat.map((r) => [r.name.toLowerCase(), r]));

  // SOURCE.json is the installed self-updater's configuration: kb/forge-update.mjs reads its
  // top-level canonicalManifestUrl/releaseTag and every per-store entry (kbName, canonicalBundleUrl,
  // updateManaged). It is a REQUIRED corpus input, read through projectStoreViews as an explicit
  // adapter — never optional enrichment. A missing or corrupt copy used to be silently replaced by
  // `{ stores: {} }`, which shipped every installer with self-update UNCONFIGURED. Fail loud instead.
  const updaterFile = path.join(corpus, 'SOURCE.json');
  if (!fs.existsSync(updaterFile)) fail(`corpus SOURCE.json is missing (${updaterFile}) — self-update configuration is a required input`);
  let updaterConfig;
  try { updaterConfig = JSON.parse(fs.readFileSync(updaterFile, 'utf8')); }
  catch (error) { fail(`corpus SOURCE.json is unreadable (${error.message})`); }
  if (!updaterConfig || typeof updaterConfig !== 'object' || Array.isArray(updaterConfig)
    || (updaterConfig.stores !== undefined && (typeof updaterConfig.stores !== 'object' || Array.isArray(updaterConfig.stores)))) {
    fail('corpus SOURCE.json is malformed (expected an object with an optional stores object)');
  }

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
    // The primer that actually SHIPS is the one the verified selection sealed, so this reports the
    // staging directory when the selection was materialized fresh — never the unfenced checkout.
    const hasPrimer = fs.existsSync(path.join(proseDir, `${name}-primer.md`));
    const kind = folded === 'ruv-gists' ? 'gist-aggregate' : derivedNames.has(folded) ? 'derived' : 'repository';
    // A sealed corpus's SOURCE.json carries an updater entry for every repository store it holds
    // (corpus-reconcile.mjs's validateWorkerOutput requires it before a worker result is merged).
    // Its absence would ship that store with no canonicalBundleUrl/kbName for the installed updater
    // — refuse, rather than ship a half-configured self-update. A standalone kb/ may legitimately
    // predate that convention for some store, so it is noted there rather than fatal.
    if (kind === 'repository' && !(updaterConfig.stores && typeof updaterConfig.stores[name] === 'object' && updaterConfig.stores[name] !== null)) {
      if (!standalone && !legacySeed) fail(`${name}: sealed corpus SOURCE.json carries no updater entry for this repository store`);
      console.log(`[build-bundle] note: ${legacySeed ? 'legacy seed' : 'standalone kb'} SOURCE.json has no updater entry for `
        + `${name} — its per-store self-update fields ship null`);
    }
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

  // Runtime loaders may only rely on validator bytes that this assembly verifies and ships.
  for (const requiredFile of validateRequiredRuntimeFiles(runtime)) {
    cp(requiredFile.source, out, { required: true, from: runtime, destinationName: requiredFile.destination });
  }

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
    if (result.generation?.sourceMode === 'fork-delta') cp(`${name}.fork-delta.inventory.json`, out, { required: true, from: corpus });
    cp(`${name}.symbols.json`, out, { from: corpus });
    for (const extra of (EXTRA_SIDECARS_BY_KIND[result.kind]?.(name) || [])) {
      cp(extra.name, out, { required: extra.required, from: corpus });
    }
  }
  // The derived-store registry ships whenever the corpus has one (every sealed corpus does), not only
  // when a derived store happens to be selected: validateCoverageDirectory — the release-projection
  // proof bindAssembledReleaseProjection runs on the assembled tree — requires it unconditionally.
  if (fs.existsSync(classesFile)) cp('public-store-classes.json', out, { required: true, from: corpus });
  // The public prose: EXACTLY the files the (verified) selection receipt seals — the receipt IS the
  // allowlist — plus the receipt itself, so every assembled archive carries its own proof and can be
  // re-assembled from (round-tripped) without re-deriving anything. Per-repo primers, l2/ articles,
  // l2-topics files, capability-cards.md and repo-aliases.json all arrive through this one loop; no
  // per-store primer copy and no ad hoc directory copy exist beside it to disagree with it.
  // validateSelectionReceipt has already proven each row is a regular, non-symlink file inside
  // `corpus` with exactly these bytes; the only check left is that nothing else already claimed the
  // destination path.
  for (const row of selectionReceipt.files) {
    const dest = path.join(out, row.path);
    if (fs.existsSync(dest)) fail(`destination collision while copying sealed public prose: ${row.path}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(proseDir, row.path), dest);
  }
  cp(SELECTION_FILE, out, { required: true, from: proseDir });
  if (!selectionReceipt.files.some((row) => row.path === 'capability-cards.md')) {
    console.log('[build-bundle] note: no capability-cards.md in the sealed selection -- the fast lane ships with no card source and will honestly fall through on every query');
  }
  if (!selectionReceipt.included.aliases) {
    console.log('[build-bundle] note: no repo-aliases.json in the sealed selection -- product-name aliases will not resolve on install');
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

  // ---- LEGACY SEED pass 2: ship the externally-produced projection (retires at plan step 11) ------
  // scripts/release-projection.mjs's CLI produced these from the exact candidate this pass is
  // re-assembling. All three ledgers travel together — a partial projection is never publishable —
  // and any derived-store evidence the projection carried travels with them. NOTHING is fabricated
  // here when a file is absent: the pre-Step-3 build-bundle synthesized a concepts.sources.json whose
  // only declared input was its own packaged output, and Step 3 deleted that on purpose.
  if (legacySeed && legacySeedProjection.projectionDir) {
    const projectionDir = path.resolve(legacySeedProjection.projectionDir);
    for (const file of ['COVERAGE.json', 'CORPUS-COVERAGE.json', 'PUBLIC-RVF-GENERATIONS.json']) {
      cp(file, out, { required: true, from: projectionDir });
    }
    for (const file of ['ruv-gists.sources.json', 'public-store-classes.json', 'concepts.sources.json']) {
      cp(file, out, { from: projectionDir });
    }
  }
  // LEGACY SEED, either pass: the derived-store registry is a REQUIRED activation-boundary input
  // (plugin/scripts/coverage-integrity.mjs reads it unconditionally), and the pre-Step-3/4 seed has
  // none. What ships is the only statement that is true of this assembly — an EMPTY registry, because
  // every derived/aggregate store was scoped out above for want of a receipt. No digest, receipt, or
  // input list is invented. Retires at plan step 11 with the rest of this mode.
  if (legacySeed && !fs.existsSync(path.join(out, 'public-store-classes.json'))) {
    fs.writeFileSync(path.join(out, 'public-store-classes.json'),
      `${JSON.stringify({ schemaVersion: 1, derived: [] }, null, 2)}\n`);
  }

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
  // OFFLINE by construction: `fetch: () => null` disables orgRepoCount's live `gh api` probe, so the
  // total comes from the committed record (source 'recorded') or is honestly `unknown`. Assembly of
  // sealed bytes never depends on, or varies with, network availability.
  const ORG = orgRepoCount({ fetch: () => null });
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
  // seedIdentity was fully validated (or rejected) at the top of this function; a non-null value
  // here is a complete release identity.
  if (seedIdentity !== null && seedIdentity !== undefined) {
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
    // The binding is CARRIED IN THE RESULT, not merely performed: a caller (and
    // tests/unit/assemble-bundle.test.mjs) can then prove the assembled tree was re-validated by the
    // independent activation-boundary reader, rather than assuming it because the line is in the
    // source. Deleting the call makes `projection.binding` undefined, and the proof fails.
    projection = { ...result, binding: bindAssembledReleaseProjection({ assetsDir: out, version, sourceSnapshot }) };
  }
  // LEGACY SEED pass 2 (retires at plan step 11): the projection was produced OUT of process by
  // scripts/release-projection.mjs against this same candidate; the runtime ledger must describe the
  // set that projection bound, and the assembled tree is then proven by the same validator the
  // in-process path uses. Same proof, different producer — never a weaker one.
  if (legacySeed && legacySeedProjection.projectionDir) {
    const publicLedgerFile = path.join(out, 'PUBLIC-RVF-GENERATIONS.json');
    const publicLedger = JSON.parse(fs.readFileSync(publicLedgerFile, 'utf8'));
    if (publicLedger.schemaVersion !== 2 || publicLedger.kind !== 'ruvnet-brain-public-generation-ledger'
      || publicLedger.brainVersion !== version || publicLedger.releaseTag !== versionTag
      || publicLedger.sourceSnapshot !== sourceSnapshot) {
      fail('the legacy release projection\'s public ledger does not bind this release identity');
    }
    fs.writeFileSync(path.join(out, 'RVF-GENERATIONS.json'), `${JSON.stringify({
      ...publicLedger, kind: 'ruvnet-brain-runtime-generation-ledger',
    }, null, 2)}\n`);
    projection = { releaseCoverage: JSON.parse(fs.readFileSync(path.join(out, 'COVERAGE.json'), 'utf8')),
      binding: bindAssembledReleaseProjection({ assetsDir: out, version, sourceSnapshot }) };
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
    retrievalRuntimeFiles: retrievalRuntimeFiles(kbDir).files,
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
  console.log(`built repositories: ${manifestEntries.length} | catalogued repositories: ${regFlat.length} | selected stores: ${discovered.length}`);
  for (const b of manifestEntries) console.log(`  ${b.tier} ${b.name.padEnd(10)} chunks=${String(b.chunks).padStart(6)} variants=${b.variants.join('+').padEnd(10)} symbols=${b.hasSymbols ? 'y' : '-'} primer=${b.hasPrimer ? 'y' : '-'} grade=${b.gradeRealUse ?? '-'} sha=${(b.builtFromSha || '').slice(0, 10)}`);
  console.log(`\nmanifest: ${path.join(path.relative(runtime, out), 'manifest.json')} | mcp snippet + README written.`);
  console.log('STATUS: assembled OK.');

  return {
    outDir: out, zipFile: ZIP, archiveManifest,
    selectedStores: discovered, manifestEntries, projection,
  };
}

// ---- CLI -----------------------------------------------------------------------------------------
if (((() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })())) {
  const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  // Corpus content is a release asset, not a Git blob. A clean worktree has zero stores unless the
  // operator supplies the canonical external corpus directory (or has already built one into kb/,
  // the genuine local/self-update case — see public-inputs.mjs's own header for why that is safe).
  const corpusDir = path.resolve(ROOT, arg('--assets', 'kb'));
  const outDir = path.resolve(ROOT, arg('--out', 'dist/ruvnet-brain'));
  // Coverage is a SEALED INPUT, not a per-run argument: assembleBundle reads it from the one
  // canonical path prepareCorpusCandidate writes (runtimeRoot/data/source-coverage.json). A
  // `--coverage` that names any OTHER file is rejected loudly — accepting-and-ignoring it (as this
  // CLI briefly did) would let a caller believe a coverage it supplied was consumed when it was not.
  // `--projection` named the retired two-pass round-trip; it is rejected for the same reason.
  const canonicalCoverage = path.join(ROOT, 'data', 'source-coverage.json');
  const coverageFlag = process.argv.indexOf('--coverage');
  const coverageValue = coverageFlag >= 0 ? process.argv[coverageFlag + 1] : undefined;
  const coverageIsCanonical = coverageFlag < 0
    || (typeof coverageValue === 'string' && path.resolve(ROOT, coverageValue) === canonicalCoverage);
  // --legacy-seed-projection: the ONE explicit declaration that this run consumes the pinned
  // PRE-Step-3/4 corpus seed through the two-pass release-projection rail (P1-c, 2026-09-14). Without
  // it, --coverage/--projection keep the step-5 meanings below (canonical-coverage-only / retired).
  // RETIRES AT PLAN STEP 11, together with assembleBundle's legacySeedProjection branch.
  const legacyFlag = process.argv.includes('--legacy-seed-projection');
  const projectionValue = arg('--projection');
  const legacySeedProjection = legacyFlag
    ? { coverageFile: coverageValue === undefined ? null : path.resolve(ROOT, coverageValue),
      projectionDir: projectionValue === undefined ? null : path.resolve(ROOT, projectionValue) }
    : null;
  // Seed flags are an all-or-nothing SET: any present flag builds the object as given (possibly
  // partial), and assembleBundle rejects a partial one before doing any work.
  const seedTag = arg('--seed-tag');
  const seedSha256 = arg('--seed-sha256');
  const seedBytesArg = arg('--seed-bytes');
  const baselineReceiptSha256 = arg('--baseline-receipt-sha256');
  const seedIdentity = [seedTag, seedSha256, seedBytesArg, baselineReceiptSha256].some((value) => value !== undefined)
    ? { tag: seedTag, archiveSha256: seedSha256, archiveBytes: seedBytesArg === undefined ? undefined : Number(seedBytesArg), baselineReceiptSha256 }
    : null;
  try {
    if (!legacyFlag && !coverageIsCanonical) {
      fail(`--coverage must name the canonical sealed coverage (${canonicalCoverage}); got ` +
        `${coverageValue === undefined ? '(no value)' : path.resolve(ROOT, coverageValue)}. Coverage is a sealed input, not a per-run argument`);
    }
    if (!legacyFlag && process.argv.includes('--projection')) {
      fail('--projection was retired by the step-5 consolidation: the release coverage projection is produced ' +
        'in-process by assembleBundle (pass --seed-tag/--seed-sha256/--seed-bytes/--baseline-receipt-sha256 instead). ' +
        'The pinned pre-Step-3/4 seed still needs the two-pass rail: declare it with --legacy-seed-projection');
    }
    await assembleBundle({
      corpusDir, runtimeRoot: ROOT, outDir,
      identity: { version: arg('--version', getVersionTag()), sourceSnapshot: arg('--source-snapshot') },
      seedIdentity, legacySeedProjection,
    });
  } catch (error) {
    console.error(`[build-bundle] FATAL: ${error.message}`);
    process.exitCode = 1;
  }
}
