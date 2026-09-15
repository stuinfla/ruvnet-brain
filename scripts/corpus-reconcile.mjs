#!/usr/bin/env node
// Build a corpus candidate from one immutable seed and exact upstream repository SHAs.
// This module deliberately has no publication capability. The protected-release workflow owns
// the only legal call to the canonical publisher, `scripts/release.mjs --corpus-seed`
// (release-authority.mjs's CANONICAL_PUBLISHERS) — see ADR-085.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../kb/zip-extract.mjs';
import { FULL_HINTS, KEEP_DIRS } from './full-hints.mjs';
import { buildCoverage, observeSourceUniverse, renderMarkdown } from './source-coverage.mjs';
import { promoteArtifactSet } from '../kb/incremental-refresh.mjs';
import { rebuildCorpusAggregates } from './corpus-aggregates.mjs';
import { fileIdentity } from '../plugin/scripts/coverage-integrity.mjs';
import { storeRoot } from '../kb/store-root.mjs';

export { rebuildCorpusAggregates };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_STORE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STORE_ARTIFACT_SUFFIXES = [
  '.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.big.passages.jsonl',
  '.big.meta.json', '.passages.jsonl', '.meta.json',
];
const REQUIRED_STORE_ARTIFACT_SUFFIXES = [
  '.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json',
];

function fail(message) {
  throw new Error(`[corpus-reconcile] ${message}`);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('reconciliation round aborted'), { name: 'AbortError' });
}

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Step 4, rule 7 (2026-09-13): reconciliation output must never land on -- or contain, or be
// contained by -- the checkout's own build workspace (<repo>/kb, never a second brain per
// kb/store-root.mjs), or the installed brain (~/.cache/ruvnet-brain/kb, or its env override --
// storeRoot()'s own answer). A caller that pointed reconciliation output at either would silently
// mutate a live tree mid-round instead of the disposable scratch area this loop assumes it owns.
export function forbiddenOutputRoots(root) {
  return [
    { label: 'the checkout kb build workspace', dir: path.join(path.resolve(root), 'kb') },
    { label: 'the installed brain', dir: storeRoot() },
  ];
}

export function assertPathNotOverlapping(label, targetDir, forbidden) {
  const resolved = path.resolve(targetDir || '');
  for (const entry of forbidden) {
    const forbiddenDir = path.resolve(entry.dir);
    if (containsPath(forbiddenDir, resolved) || containsPath(resolved, forbiddenDir)) {
      fail(`${label} must not be, or contain, or be contained by, ${entry.label} (${resolved})`);
    }
  }
}

function sha256File(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`seed archive missing (${file || 'no path supplied'})`);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function readJson(file, label) {
  if (!file || !fs.existsSync(file)) fail(`${label} missing (${file || 'no path supplied'})`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} unreadable (${error.message})`);
  }
}

export function assertBootstrapIdentity({ archiveFile, tag, sha256, allowPinnedTag = false }) {
  const expected = String(sha256 || '').toLowerCase();
  if (!HEX64.test(expected) || (!allowPinnedTag && tag !== `corpus-sha256-${expected}`) || !tag || tag === 'latest') {
    fail('bootstrap requires the exact digest-derived tag corpus-sha256-<configured sha256>; latest is forbidden');
  }
  const actual = sha256File(path.resolve(archiveFile || ''));
  if (actual !== expected) fail(`downloaded archive sha256 ${actual} differs from configured ${expected}`);
  return { tag, sha256: expected };
}

function filesNamed(root, wanted) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === wanted) found.push(file);
    }
  };
  visit(root);
  return found;
}

export function normalizeExtractedCorpus({ extractedDir, assetsDir }) {
  const extracted = path.resolve(extractedDir || '');
  const assets = path.resolve(assetsDir || '');
  if (!fs.existsSync(extracted) || !fs.statSync(extracted).isDirectory()) {
    fail(`extracted seed directory missing (${extracted})`);
  }
  if (fs.existsSync(assets) && fs.readdirSync(assets).length) fail(`bootstrap assets directory is not empty (${assets})`);
  const ledgers = filesNamed(extracted, 'RVF-GENERATIONS.json');
  if (ledgers.length !== 1) fail(`seed archive must contain exactly one RVF-GENERATIONS.json; found ${ledgers.length}`);
  const corpusRoot = path.dirname(ledgers[0]);
  // A published seed's own PRIVATE-STORES.json is AUTHENTICATED HISTORICAL EVIDENCE of what that
  // prior round excluded — never the current builder's live policy. Keep it under a distinct name
  // (SEED-PRIVATE-STORES.json) so it can never shadow, or be mistaken for, the canonical fence the
  // exact builder checkout copies in below (main()), and is never overwritten.
  const seedFence = path.join(corpusRoot, 'PRIVATE-STORES.json');
  const hasSeedFence = fs.existsSync(seedFence);
  fs.mkdirSync(assets, { recursive: true });
  for (const entry of fs.readdirSync(corpusRoot)) {
    if (hasSeedFence && entry === 'PRIVATE-STORES.json') continue;
    fs.renameSync(path.join(corpusRoot, entry), path.join(assets, entry));
  }
  if (hasSeedFence) fs.renameSync(seedFence, path.join(assets, 'SEED-PRIVATE-STORES.json'));
  return assets;
}

// Historical evidence only: the identity of the PRIOR seed's own private-store fence, if the seed
// archive shipped one. Never used to gate anything against the current builder's live policy.
export function seedPrivateFenceEvidence(assetsDir) {
  const file = path.join(path.resolve(assetsDir || ''), 'SEED-PRIVATE-STORES.json');
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('seed private-fence evidence is not a trusted regular file');
  return fileIdentity(file);
}

function repositorySlug(url) {
  const match = String(url || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function planReconciliation({ coverage, ledger, assetsDir = null }) {
  if (coverage?.schemaVersion !== 1 || !Array.isArray(coverage.rows) || !coverage.coverageGeneration) {
    fail('coverage policy is missing a supported complete generation');
  }
  if (!ledger?.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) {
    fail('RVF generation ledger has no stores object');
  }
  const eligible = coverage.rows.filter((row) => row?.kind === 'repository' && row?.disposition === 'eligible');
  const seen = new Set();
  const plan = [];
  for (const row of eligible) {
    const store = String(row?.artifact?.store || '');
    if (!SAFE_STORE.test(store)) fail(`${row?.name || row?.key || 'eligible repository'} has an unsafe or missing store name`);
    const folded = store.toLowerCase();
    if (seen.has(folded)) fail(`duplicate eligible store ${store} in coverage policy`);
    seen.add(folded);
    const upstreamSha = String(row?.upstream?.sha || '').toLowerCase();
    if (!HEX40.test(upstreamSha)) fail(`${row?.name || store} has a missing or malformed upstream SHA`);
    if (!repositorySlug(row.url)) fail(`${row?.name || store} has no exact GitHub repository URL`);
    const generation = Object.entries(ledger.stores).find(([name]) => name.toLowerCase() === folded)?.[1] || null;
    const current = String(generation?.sourceCommit || '').toLowerCase();
    let reason = generation?.sourceCommit ? 'sourceCommit differs' : 'missing ledger receipt';
    if (current === upstreamSha) {
      if (!assetsDir) continue;
      const expectedFile = `${store}.big.rvf`;
      const rvfFile = path.join(path.resolve(assetsDir), expectedFile);
      const receiptMatches = generation?.file === expectedFile
        && fs.existsSync(rvfFile)
        && generation?.bytes === fs.statSync(rvfFile).size
        && generation?.sha256 === sha256File(rvfFile);
      if (receiptMatches) continue;
      reason = 'generation receipt differs from seed bytes';
    }
    plan.push({
      name: String(row.name || store),
      store,
      url: row.url,
      upstreamSha,
      ledgerSourceCommit: generation?.sourceCommit || null,
      reason,
    });
  }
  return plan.sort((a, b) => a.store.localeCompare(b.store));
}

export const CONSISTENCY_MODEL = 'sealed-acquisition-manifest/1';

/**
 * Optional freshness telemetry. It NEVER throws and NEVER vetoes acceptance: a source moving after
 * the manifest was sealed is ordinary, and says nothing about whether this generation is complete
 * against its own pinned inputs. Absent or failed telemetry yields UNKNOWN, not failure.
 */
async function measureFreshness({ closingObservation, observation }) {
  if (typeof closingObservation !== 'function') {
    return { checkStatus: 'UNKNOWN', reason: 'no closing observation configured', closingObservationSha256: null };
  }
  try {
    const closing = await closingObservation();
    const moved = closing?.observationSha256 !== observation.observationSha256;
    return {
      checkStatus: moved ? 'NEWER_REVISION_OBSERVED' : 'NO_CHANGE_OBSERVED',
      closingObservationSha256: closing?.observationSha256 ?? null,
    };
  } catch (error) {
    return { checkStatus: 'UNKNOWN', reason: `closing observation failed: ${error.message}`, closingObservationSha256: null };
  }
}

/**
 * Acquire ONE SEALED GENERATION against a frozen discovery manifest.
 *
 * WHY THIS REPLACED THE ROUND-STABILITY LOOP (measured 2026-09-14/15, Dual verdict "choose A").
 * The previous loop only returned when a fresh observation of the ENTIRE live source universe hashed
 * identically to the one it started with, and failed the whole build after 3 rounds otherwise. A round
 * takes about an hour; the observation hash covers each repository's updatedAt, pushedAt, diskUsage and
 * head oid; and the org pushes continuously (8 repositories in 24h; 13 of 185 moved since the committed
 * coverage generation). So progress was unreliable under sustained churn -- a quiet hour could succeed,
 * but nothing guaranteed one -- and a local run died exactly there after refreshing 90 stores. Every
 * corpus-seed CI run in history has failed, none having reached even this far.
 *
 * The rule now: one bounded discovery pass freezes the identity set; every required source resolves to
 * immutable pinned inputs; movement elsewhere can never invalidate an already-resolved entry or restart
 * the generation. Acceptance is COMPLETENESS AGAINST THE SEALED MANIFEST -- every required source
 * validated against the inputs it was pinned to -- not equality with a live universe that never holds
 * still. A source that moves mid-run finishes at its pinned revision and is picked up by the NEXT
 * generation; `latest` is never substituted, and an exhausted partial generation is never accepted.
 */
export async function acquireSealedGeneration({ maxAttempts = 3, assetsDir = null, observe, build,
  readLedger: currentLedger, execute, prune, rebuild, closingObservation = null } = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
    || [observe, build, currentLedger, execute, prune, rebuild].some((fn) => typeof fn !== 'function')) {
    fail('bounded acquisition configuration is invalid');
  }
  // ONE discovery pass. This observation is the sealed manifest every later step consumes; it is never
  // re-taken, so upstream churn cannot restart or invalidate the generation.
  const observation = await observe();
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const coverage = await build(observation);
    const plan = planReconciliation({ coverage, ledger: currentLedger(), assetsDir });
    const reconciliation = await execute(plan, attempt);
    const pruning = await prune(coverage, attempt);
    let aggregates;
    try {
      aggregates = await rebuild(coverage, observation, attempt);
    } catch (error) {
      if (error?.code !== 'GIST_OBSERVATION_MOVED') throw error;
      // A gist moved between its list entry and its detail fetch. The remedy is to retry against the
      // SAME pinned inputs until one internally consistent revision is captured -- never to re-observe
      // the universe, which is what made the old loop unable to finish.
      attempts.push({ attempt, plan, ...reconciliation, ...pruning, rebuilt: [],
        retried: { reason: 'gist revision moved during exact detail fetch', gistId: error.gistId || null } });
      continue;
    }
    const remaining = planReconciliation({ coverage, ledger: currentLedger(), assetsDir });
    const unresolved = coverage.rows.filter((row) => row.disposition === 'eligible' && row.status !== 'CURRENT');
    attempts.push({ attempt, plan, ...reconciliation, ...pruning, ...aggregates,
      remainingArtifacts: remaining.length, unresolvedSources: unresolved.length });
    if (!remaining.length && !unresolved.length) {
      return {
        observation, coverage, attempts, consistencyModel: CONSISTENCY_MODEL,
        freshness: await measureFreshness({ closingObservation, observation }),
      };
    }
  }
  const last = attempts[attempts.length - 1] || {};
  fail(`sealed generation incomplete after ${maxAttempts} acquisition attempt(s): `
    + `${last.remainingArtifacts ?? 'unknown'} artifact(s) and ${last.unresolvedSources ?? 'unknown'} `
    + 'eligible source(s) remain unresolved against the sealed manifest');
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function checked(run, command, args, options = {}) {
  const result = run(command, args, options) || {};
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
    fail(`${command} ${args.join(' ')} failed${detail ? ` (${detail})` : ''}`);
  }
  return result;
}

function defaultRunAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const inherited = options.stdio === 'inherit';
    const child = spawn(command, args, { ...options, encoding: undefined,
      stdio: inherited ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    if (!inherited) {
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', (error) => resolve({ status: null, error, stdout, stderr }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function checkedAsync(run, command, args, options = {}) {
  const result = await run(command, args, options) || {};
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
    fail(`${command} ${args.join(' ')} failed${detail ? ` (${detail})` : ''}`);
  }
  return result;
}

const storeArtifacts = (store) => STORE_ARTIFACT_SUFFIXES.map((suffix) => `${store}${suffix}`);

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Step 4, rule 3 (2026-09-13): POSITIVE SELECTION for the generation ledger / SOURCE manifest --
// the old `prune` seam in the round-stability loop (now acquireSealedGeneration) was a hardcoded no-op (`() => ({ pruned: [] })`), so
// a repository removed from policy, made private, or deleted upstream simply lingered in
// RVF-GENERATIONS.json/SOURCE.json (and its .big.rvf family on disk) forever once ingested. This is
// the real prune: `eligibleStores` is the EXACT set this round's own coverage just measured as
// `kind: 'repository', disposition: 'eligible'` -- any OTHER repository store still present in the
// ledger no longer belongs, and its full artifact family plus its ledger/SOURCE rows are removed.
// `ruv-gists` and `concepts` are out of scope here: those are already fully regenerated from
// nothing every round (buildGistAggregate / materializePublicInputs+buildConceptAggregate), never
// overlaid, so nothing here ever needs to -- or may -- touch them.
export function pruneIneligibleStores({ assetsDir, eligibleStores }) {
  const assets = path.resolve(assetsDir || '');
  const ledgerFile = path.join(assets, 'RVF-GENERATIONS.json');
  if (!fs.existsSync(ledgerFile)) return { pruned: [] };
  const ledger = readJson(ledgerFile, 'RVF generation ledger');
  const sourceFile = path.join(assets, 'SOURCE.json');
  const source = fs.existsSync(sourceFile) ? readJson(sourceFile, 'SOURCE manifest') : { builder: 'rvf-kb-forge', stores: {} };
  const eligible = new Set([...(eligibleStores || [])].map((store) => String(store).toLowerCase()));
  const stale = Object.keys(ledger.stores || {})
    .filter((store) => !['ruv-gists', 'concepts'].includes(store.toLowerCase()) && !eligible.has(store.toLowerCase()))
    .sort();
  if (!stale.length) return { pruned: [] };
  for (const store of stale) {
    delete ledger.stores[store];
    if (source.stores) delete source.stores[store];
    for (const suffix of STORE_ARTIFACT_SUFFIXES) fs.rmSync(path.join(assets, `${store}${suffix}`), { force: true });
  }
  writeJsonAtomic(ledgerFile, ledger);
  writeJsonAtomic(sourceFile, source);
  return { pruned: stale };
}

function seedWorkerAssets({ assets, output, store, ledger, source }) {
  fs.mkdirSync(output, { recursive: true });
  for (const name of storeArtifacts(store)) {
    const input = path.join(assets, name);
    if (!fs.existsSync(input)) continue;
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${store}: canonical seed artifact is not a regular file (${name})`);
    fs.copyFileSync(input, path.join(output, name));
  }
  writeJsonAtomic(path.join(output, 'RVF-GENERATIONS.json'), {
    ...ledger, stores: ledger.stores?.[store] ? { [store]: ledger.stores[store] } : {},
  });
  writeJsonAtomic(path.join(output, 'SOURCE.json'), {
    ...(source || { builder: 'rvf-kb-forge' }), stores: source?.stores?.[store] ? { [store]: source.stores[store] } : {},
  });
}

function validateWorkerOutput({ output, item }) {
  const allowed = new Set([...storeArtifacts(item.store), 'RVF-GENERATIONS.json', 'SOURCE.json']);
  const names = fs.readdirSync(output).filter((name) => !name.startsWith('._')).sort();
  const unexpected = names.filter((name) => !allowed.has(name));
  if (unexpected.length) fail(`${item.store}: worker emitted unexpected artifact(s): ${unexpected.join(', ')}`);
  const caseFolded = names.map((name) => name.toLowerCase());
  if (new Set(caseFolded).size !== names.length) fail(`${item.store}: worker emitted case-fold aliases`);
  for (const name of names) {
    const stat = fs.lstatSync(path.join(output, name));
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${item.store}: worker artifact is not a regular file (${name})`);
  }
  for (const suffix of REQUIRED_STORE_ARTIFACT_SUFFIXES) {
    if (!names.includes(`${item.store}${suffix}`)) fail(`${item.store}: worker artifact family is incomplete (${suffix})`);
  }
  const ledger = readJson(path.join(output, 'RVF-GENERATIONS.json'), `${item.store} worker ledger`);
  const ledgerStores = Object.keys(ledger.stores || {});
  if (ledgerStores.length !== 1 || ledgerStores[0] !== item.store) fail(`${item.store}: worker ledger must contain exactly its own store`);
  const generation = ledger.stores[item.store];
  const expectedRvf = `${item.store}.big.rvf`;
  if (generation?.file !== expectedRvf || String(generation.sourceCommit || '').toLowerCase() !== item.upstreamSha
    || !fs.existsSync(path.join(output, expectedRvf))
    || generation.sha256 !== sha256File(path.join(output, expectedRvf))
    || generation.bytes !== fs.statSync(path.join(output, expectedRvf)).size) {
    fail(`${item.store}: worker generation does not bind exact source and RVF bytes`);
  }
  const source = readJson(path.join(output, 'SOURCE.json'), `${item.store} worker source manifest`);
  if (Object.keys(source.stores || {}).length !== 1 || !source.stores[item.store]
    || String(source.stores[item.store].sourceCommit || '').toLowerCase() !== item.upstreamSha) {
    fail(`${item.store}: worker SOURCE manifest does not bind exact source`);
  }
  const files = names.filter((name) => !['RVF-GENERATIONS.json', 'SOURCE.json'].includes(name))
    .map((name) => ({ name, sha256: sha256File(path.join(output, name)), bytes: fs.statSync(path.join(output, name)).size }));
  const payload = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-worker-result', store: item.store,
    sourceCommit: item.upstreamSha, generation, source: source.stores[item.store], files };
  return { ...payload, receiptSha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), output };
}

export async function executeReconciliation({
  plan,
  assetsDir,
  workspaceDir,
  root = DEFAULT_ROOT,
  run = defaultRunAsync,
  concurrency = 5,
  signal,
}) {
  if (!Array.isArray(plan) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    fail('reconciliation plan or worker concurrency is invalid');
  }
  const assets = path.resolve(assetsDir || '');
  const workspace = path.resolve(workspaceDir || '');
  const ledgerFile = path.join(assets, 'RVF-GENERATIONS.json');
  if (!fs.existsSync(ledgerFile)) fail(`RVF generation ledger missing (${ledgerFile})`);
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length) fail(`fresh-clone workspace is not empty (${workspace})`);
  fs.mkdirSync(workspace, { recursive: true });
  const forge = path.join(path.resolve(root), 'kb', 'forge-refresh.mjs');
  if (!fs.existsSync(forge)) fail(`forge-refresh missing (${forge})`);
  const canonicalLedger = readJson(ledgerFile, 'RVF generation ledger');
  const sourceFile = path.join(assets, 'SOURCE.json');
  const canonicalSource = fs.existsSync(sourceFile) ? readJson(sourceFile, 'SOURCE manifest') : { builder: 'rvf-kb-forge', stores: {} };
  const orderedPlan = [...plan].sort((a, b) => a.store.localeCompare(b.store));
  const lowerStores = orderedPlan.map(({ store }) => store.toLowerCase());
  if (new Set(lowerStores).size !== lowerStores.length) fail('reconciliation plan has duplicate or case-fold-colliding stores');

  // Step 4, required proof 4 (2026-09-13): every worker in this pool shares ONE internal
  // AbortController. Before this, `Promise.all` over the fixed-size worker pool below rejected as
  // soon as ANY lane's `worker()` threw -- but the OTHER lanes kept running their own `while` loop
  // completely unobserved: still cloning, still spawning forge-refresh, with nobody left awaiting
  // them once the outer Promise.all had already settled. A later failure (or success) in one of
  // those orphaned lanes could then surface as an unhandled rejection, or simply keep doing
  // unnecessary work after the round was already lost. Now: the first failure aborts the shared
  // signal, every lane observes it (both at its own loop-top and via the signal threaded into every
  // child-process spawn below) and returns promptly, and `Promise.all` -- which no lane's promise
  // ever rejects out of directly -- only resolves once every lane has actually stopped. Only then do
  // we throw the FIRST real error (an aborted sibling's own error is discarded, never overwrites it).
  // An externally supplied `signal` (a caller discarding this whole round) aborts the same
  // controller, so both cancellation paths join through the one place.
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  const worker = async (item) => {
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (!SAFE_STORE.test(item.store) || !HEX40.test(item.upstreamSha) || !repositorySlug(item.url)) {
      fail(`unsafe reconciliation item for ${item?.store || item?.name || 'unknown store'}`);
    }
    const workerRoot = path.join(workspace, 'workers', item.store);
    const cloneDir = path.join(workerRoot, 'clone');
    const output = path.join(workerRoot, 'assets');
    fs.mkdirSync(workerRoot, { recursive: true });
    seedWorkerAssets({ assets, output, store: item.store, ledger: canonicalLedger, source: canonicalSource });
    await checkedAsync(run, 'git', ['clone', '--no-checkout', '--filter=blob:none', item.url, cloneDir], { signal: controller.signal });
    await checkedAsync(run, 'git', ['-C', cloneDir, 'fetch', '--depth=1', 'origin', item.upstreamSha], { signal: controller.signal });
    await checkedAsync(run, 'git', ['-C', cloneDir, 'checkout', '--detach', 'FETCH_HEAD'], { signal: controller.signal });
    const head = await checkedAsync(run, 'git', ['-C', cloneDir, 'rev-parse', 'HEAD'], { signal: controller.signal });
    if (String(head.stdout || '').trim().toLowerCase() !== item.upstreamSha) {
      fail(`${item.store}: fresh clone did not resolve the exact upstream SHA`);
    }
    await checkedAsync(run, process.execPath, [forge, '--repo', cloneDir, '--out', output, '--name', item.store,
      ...(FULL_HINTS[item.store] ? ['--full', FULL_HINTS[item.store]] : []),
      ...(KEEP_DIRS[item.store] ? ['--keep', KEEP_DIRS[item.store]] : []),
    ], { stdio: 'inherit', env: { ...process.env, RUVNET_BIG_SHARDS: '1' }, signal: controller.signal });
    return validateWorkerOutput({ output, item });
  };

  const results = new Array(orderedPlan.length);
  let next = 0;
  let firstError = null;
  await Promise.all(Array.from({ length: Math.min(concurrency, orderedPlan.length) }, async () => {
    while (next < orderedPlan.length) {
      if (controller.signal.aborted) return;
      const index = next++;
      try {
        results[index] = await worker(orderedPlan[index]);
      } catch (error) {
        if (!firstError) firstError = error;
        controller.abort(error);
        return;
      }
    }
  }));
  if (!firstError && controller.signal.aborted) firstError = abortError(controller.signal);
  if (firstError) throw firstError;
  if (!results.length) return { refreshed: [], workers: [] };

  const merge = path.join(workspace, 'merge-candidate');
  fs.mkdirSync(merge);
  const mergedLedger = structuredClone(canonicalLedger);
  const mergedSource = structuredClone(canonicalSource);
  mergedLedger.stores ||= {};
  mergedSource.stores ||= {};
  const promotedFiles = [];
  for (const result of results) {
    for (const file of result.files) {
      fs.copyFileSync(path.join(result.output, file.name), path.join(merge, file.name), fs.constants.COPYFILE_EXCL);
      promotedFiles.push(file.name);
    }
    mergedLedger.stores[result.store] = result.generation;
    mergedSource.stores[result.store] = result.source;
  }
  mergedLedger.stores = Object.fromEntries(Object.entries(mergedLedger.stores).sort(([a], [b]) => a.localeCompare(b)));
  mergedSource.stores = Object.fromEntries(Object.entries(mergedSource.stores).sort(([a], [b]) => a.localeCompare(b)));
  writeJsonAtomic(path.join(merge, 'RVF-GENERATIONS.json'), mergedLedger);
  writeJsonAtomic(path.join(merge, 'SOURCE.json'), mergedSource);
  promotedFiles.push('RVF-GENERATIONS.json', 'SOURCE.json');
  promoteArtifactSet({ liveDir: assets, candidateDir: merge, files: promotedFiles.sort() });
  return { refreshed: results.map(({ store }) => store),
    workers: results.map(({ output: _output, ...receipt }) => receipt) };
}

// syncCorpusInputs — Step 3 (2026-09-13): this used to ALSO sync public-prose inputs
// (capability-cards.md, primers, l2/, l2-topics.*.json, public-store-classes.json), and did it by
// OVERLAY -- copying this round's files onto whatever a prior round's assets directory already had,
// so a primer or topics file removed from the checkout never disappeared from a long-lived assets
// tree. That selection is now owned entirely by materializePublicInputs (scripts/public-inputs.mjs),
// called fresh every round from rebuildCorpusAggregates -- it positively selects (and fences) every
// public-prose input from nothing, so a removed/newly-private input simply is not reproduced.
// public-store-classes.json is no longer synced as an input at all (rule 9): it is generated by
// buildConceptAggregate from the stores actually accepted that round, never read from a checkout copy.
//
// What remains here is a SEPARATE, deliberately smaller concern (rule 5): CODE-INGESTION eligibility
// policy (which repositories/gists may enter the corpus at all) -- needed before the reconciliation
// loop can even observe the source universe, and unrelated to what public prose ships.
export function syncCorpusInputs({ root = DEFAULT_ROOT, assetsDir }) {
  const sourceKb = path.join(path.resolve(root), 'kb');
  const assets = path.resolve(assetsDir || '');
  const required = ['external-sources.json', 'no-corpus-repos.json'];
  for (const name of required) {
    const source = path.join(sourceKb, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail(`canonical corpus input missing (${source})`);
    fs.copyFileSync(source, path.join(assets, name));
  }
  return { copied: required };
}

// A PURE, READ-ONLY observation of the live source universe -- lists repositories and gists but
// NEVER materializes/binds a gist receipt. This is exactly what structurally prevents the
// 2026-09-12 "observation resets passage binding" bug: previously `observe()` both listed the live
// universe AND re-sealed `ruv-gists.sources.json` against whatever it just saw, so calling it a
// second time within one round (to detect drift after the repository refresh + gist aggregate build
// below) clobbered the receipt `rebuild()` had just sealed with a bound `passagesSha256` back to an
// unbound one. Gist capture/render/seal now happens EXACTLY once per round, inside `rebuild` (via
// rebuildCorpusAggregates -> buildGistAggregate) -- `observe` can be called as many times as
// stability detection needs without ever touching what `rebuild` already sealed.
async function observeSourceOnly({ owner, assetsDir }) {
  const assets = path.resolve(assetsDir || '');
  const externalFile = path.join(assets, 'external-sources.json');
  const policy = fs.existsSync(externalFile) ? readJson(externalFile, 'external source policy') : { sources: [] };
  if (!Array.isArray(policy.sources)) fail('external source policy has no sources array');
  return observeSourceUniverse({ owner, externalSources: policy.sources });
}

export async function acquireCorpusGeneration({ owner = 'ruvnet', assetsDir, workspaceDir,
  root = DEFAULT_ROOT, maxAttempts = 3, closingObservation = null,
  observe = null,
  build = (observation) => buildCoverage({ owner, kbDir: assetsDir, policyDir: assetsDir, observation }),
  readLedger = () => readJson(path.join(path.resolve(assetsDir || ''), 'RVF-GENERATIONS.json'),
    'RVF generation ledger'),
  execute = executeReconciliation,
  // Step 4, rule 3: positive selection, not a no-op. `coverage` here is `preliminary` -- the FULL,
  // freshly-measured coverage for the round about to run (every row, not just the ones needing
  // rebuild) -- so the eligible set is always this round's own, never a stale snapshot.
  prune = (coverage) => pruneIneligibleStores({
    assetsDir,
    eligibleStores: coverage.rows.filter((row) => row.kind === 'repository' && row.disposition === 'eligible')
      .map((row) => row.artifact.store),
  }),
  // `coverage` is now threaded through (rule 8) rather than discarded: rebuildCorpusAggregates
  // asserts the concepts observation identity exactly equals coverage's own, instead of trusting an
  // accidental shared reference.
  rebuild = (coverage, observation) => rebuildCorpusAggregates({ assetsDir, observation, coverage, root }),
} = {}) {
  if (!assetsDir || !workspaceDir) fail('stable reconciliation requires explicit assets and workspace directories');
  const workspace = path.resolve(workspaceDir || '');
  const forbidden = forbiddenOutputRoots(root);
  assertPathNotOverlapping('reconciliation assets directory', assetsDir, forbidden);
  assertPathNotOverlapping('reconciliation workspace directory', workspace, forbidden);
  assertPathNotOverlapping('reconciliation workspace directory', workspace,
    [{ label: 'the assets directory', dir: assetsDir }]);
  return acquireSealedGeneration({
    maxAttempts,
    closingObservation,
    assetsDir,
    observe: () => (observe || observeSourceOnly)({ owner, assetsDir }),
    build,
    readLedger,
    execute: (plan, attempt) => execute({
      plan, assetsDir, workspaceDir: path.join(workspace, `attempt-${attempt}`), root,
    }),
    prune,
    rebuild,
  });
}

// Step 4, rule 4 (2026-09-13): this used to take an OPAQUE `plan`/`execute` pair, and main() below
// passed `plan: []` (an inert placeholder -- the real per-round plans are computed INSIDE the
// acquisition loop, never known up front) plus `execute: () => acquireCorpusGeneration(...)` (an
// override that threw the supplied `plan` away entirely and substituted the whole multi-round loop).
// That indirection existed only because this function's default (`executeReconciliation`) runs a
// SINGLE round against a caller-supplied plan, while production always needs the full
// round-until-stable loop -- so production always had to override the default just to get correct
// behavior. Now `reconcile` defaults directly to the stability loop itself: main() calls this with
// no override at all, and a caller that genuinely wants one-shot single-round execution (e.g. a
// test) can still supply its own `reconcile`.
export async function reconcileAndPrepareCorpusCandidate({ assetsDir, workspaceDir, root = DEFAULT_ROOT,
  owner = 'ruvnet', builderSha, candidateDir, receiptFile, coverageFile, bootstrapIdentity = null, maxRounds = 3,
  reconcile = (options) => acquireCorpusGeneration(options),
  accuracyOracleFile = null, accuracyStores = null, accuracySample = null, accuracyTimeoutMs = null,
  prepare = prepareCorpusCandidate } = {}) {
  const finalized = await reconcile({ owner, assetsDir, workspaceDir, root, maxRounds });
  const candidate = await prepare({
    root, assetsDir, builderSha, candidateDir, receiptFile, coverageFile, bootstrapIdentity,
    coverage: finalized.coverage,
    accuracyOracleFile, accuracyStores, accuracySample, accuracyTimeoutMs,
  });
  return { reconciliation: finalized, candidate };
}

export function prepareCorpusCandidate({
  root = DEFAULT_ROOT,
  assetsDir,
  builderSha,
  candidateDir,
  receiptFile,
  coverageFile,
  bootstrapIdentity = null,
  coverage,
  accuracyOracleFile = null,
  accuracyStores = null,
  accuracySample = null,
  accuracyTimeoutMs = null,
  run = defaultRun,
}) {
  const sourceRoot = path.resolve(root);
  const assets = path.resolve(assetsDir || '');
  const candidate = path.resolve(candidateDir || path.join(sourceRoot, 'dist', 'corpus-candidate'));
  const receipt = path.resolve(receiptFile || path.join(sourceRoot, 'dist', 'corpus-receipt.json'));
  const policy = path.resolve(coverageFile || path.join(sourceRoot, 'data', 'source-coverage.json'));
  if (!HEX40.test(String(builderSha || '').toLowerCase())) fail('builder SHA must be exact 40-character lowercase hex');
  const expectedPolicy = path.join(sourceRoot, 'data', 'source-coverage.json');
  if (policy !== expectedPolicy) fail(`coverage policy must be the generator's canonical projection (${expectedPolicy})`);
  // Step 4, rules 5-6 (2026-09-13): prepareCorpusCandidate performs NO live source observation of
  // its own. The old flow shelled out to `source-coverage.mjs --write` and then `--check --strict`
  // as two SEPARATE live re-observations of the real GitHub source universe, mutating the tracked
  // checkout's data/source-coverage.json and docs/RUVNET-COVERAGE.md a SECOND time, after
  // acquireCorpusGeneration had already captured and measured the sealed observation -- exactly
  // the "re-observes and mutates tracked checkout files after the stable observation was already
  // captured" bug flagged 2026-09-13. `coverage` here is that already-stabilized measurement
  // (FinalizedCorpus.coverage); both the committed JSON and the committed Markdown are now rendered
  // from that SAME in-memory object, so they can never independently disagree with each other or
  // with what the reconciliation loop actually verified.
  if (!coverage || coverage.kind !== 'ruvnet-brain-corpus-coverage' || !Array.isArray(coverage.rows)) {
    fail('prepareCorpusCandidate requires an already-measured coverage object; it never re-observes live sources');
  }
  const blockers = coverage.rows.filter((row) => row.disposition === 'eligible' && row.status !== 'CURRENT');
  if (blockers.length) fail(`strict coverage: ${blockers.length} eligible row(s) are not CURRENT`);
  assertPathNotOverlapping('candidate output directory', candidate, forbiddenOutputRoots(sourceRoot));
  const buildScript = path.join(sourceRoot, 'scripts', 'build-bundle.mjs');
  const receiptScript = path.join(sourceRoot, 'scripts', 'corpus-candidate.mjs');
  const accuracyScript = path.join(sourceRoot, 'scripts', 'oracle', 'retrieval-accuracy.mjs');
  for (const required of [buildScript, receiptScript, accuracyScript]) {
    if (!fs.existsSync(required)) fail(`required candidate builder missing (${required})`);
  }
  // ADR-086 Step 15 / C3. The oracle is a hard input, checked BEFORE the expensive single-pass
  // assembly so a missing one fails in seconds rather than after a full corpus build. Producing it
  // is Step 14's deliverable; this gate fails closed until it exists, which is the honest state —
  // a corpus nobody has measured must not be sealable.
  const accuracyOracle = path.resolve(accuracyOracleFile || path.join(sourceRoot, 'data', 'retrieval-accuracy-oracle.json'));
  if (!fs.existsSync(accuracyOracle) || !fs.statSync(accuracyOracle).isFile()) {
    fail(`retrieval-accuracy oracle missing (${accuracyOracle}); ADR-086 Step 15's C3 gate cannot seal an unmeasured corpus`);
  }
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  fs.writeFileSync(policy, `${JSON.stringify(coverage, null, 2)}\n`);
  const markdownPath = path.join(sourceRoot, 'docs', 'RUVNET-COVERAGE.md');
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, renderMarkdown(coverage));
  checked(run, process.execPath, [buildScript, '--assets', assets, '--out', candidate,
    '--coverage', policy], { stdio: 'inherit' });
  const bundleFile = path.join(path.dirname(candidate), `${path.basename(candidate)}.zip`);
  // ADR-086 Step 15: the benchmark runs HERE — after single-pass assembly and before the seal —
  // against the EXTRACTED final archive through the customer query path, never against `assets`.
  // The report is written detached, beside the archive, and the seal below binds its digest. A
  // bounded run (--stores/--sample) still writes a report, but it marks itself incomplete and the
  // seal refuses it, so a bounded measurement can never be presented as a corpus-wide pass.
  const accuracyReportFile = `${bundleFile}.accuracy.json`;
  checked(run, process.execPath, [accuracyScript, '--bundle', bundleFile,
    '--oracle', accuracyOracle, '--out', accuracyReportFile,
    ...(accuracyStores != null ? ['--stores', String(accuracyStores)] : []),
    ...(accuracySample != null ? ['--sample', String(accuracySample)] : []),
    ...(accuracyTimeoutMs != null ? ['--timeout-ms', String(accuracyTimeoutMs)] : [])],
  { stdio: 'inherit' });
  // The candidate receipt is derived ENTIRELY from the sealed bundle's own bytes plus the detached,
  // digest-bound accuracy report (schema 3) — the separate assets/policy directory used to build it
  // is no longer an alternate verification root.
  const bootstrapArgs = bootstrapIdentity?.tag && bootstrapIdentity?.sha256
    ? ['--bootstrap-tag', bootstrapIdentity.tag, '--bootstrap-sha256', bootstrapIdentity.sha256]
    : [];
  checked(run, process.execPath, [receiptScript, '--bundle', bundleFile,
    '--receipt', receipt, '--builder-source-sha', builderSha,
    '--accuracy-report', accuracyReportFile, ...bootstrapArgs], { stdio: 'inherit' });
  checked(run, process.execPath, [receiptScript, '--verify', '--bundle', bundleFile,
    '--receipt', receipt, '--accuracy-report', accuracyReportFile], { stdio: 'inherit' });
  return { bundleFile, receiptFile: receipt, coverageFile: policy, accuracyReportFile, accuracyOracleFile: accuracyOracle };
}

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(arg(argv, '--root', DEFAULT_ROOT));
  const archiveFile = path.resolve(arg(argv, '--seed-archive', ''));
  const seedTag = arg(argv, '--seed-tag');
  const seedSha256 = arg(argv, '--seed-sha256');
  const assetsDir = path.resolve(arg(argv, '--assets', ''));
  const workspaceDir = path.resolve(arg(argv, '--workspace', ''));
  const coverageFile = path.resolve(arg(argv, '--coverage', path.join(root, 'data', 'source-coverage.json')));
  const candidateDir = path.resolve(arg(argv, '--candidate-out', path.join(root, 'dist', 'corpus-candidate')));
  const receiptFile = path.resolve(arg(argv, '--receipt-out', path.join(root, 'dist', 'corpus-receipt.json')));
  const builderSha = String(arg(argv, '--builder-sha', '')).toLowerCase();
  const owner = arg(argv, '--owner', 'ruvnet');
  const accuracyOracleFile = path.resolve(arg(argv, '--accuracy-oracle', path.join(root, 'data', 'retrieval-accuracy-oracle.json')));
  // Bounded measurement is explicit and opt-in. It never yields a sealable candidate — the seal
  // refuses an incomplete report — so these flags exist for measuring, not for shipping.
  const accuracyStores = arg(argv, '--accuracy-stores') ? Number(arg(argv, '--accuracy-stores')) : null;
  const accuracySample = arg(argv, '--accuracy-sample') ? Number(arg(argv, '--accuracy-sample')) : null;
  const accuracyTimeoutMs = arg(argv, '--accuracy-timeout-ms') ? Number(arg(argv, '--accuracy-timeout-ms')) : null;

  const bootstrap = assertBootstrapIdentity({ archiveFile, tag: seedTag, sha256: seedSha256, allowPinnedTag: process.argv.includes('--allow-pinned-seed-tag') });
  if (fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).length) fail(`bootstrap assets directory is not empty (${assetsDir})`);
  fs.mkdirSync(path.dirname(assetsDir), { recursive: true });
  const extractParent = fs.mkdtempSync(path.join(path.dirname(assetsDir), '.corpus-seed-extract-'));
  await extractZip(archiveFile, extractParent);
  normalizeExtractedCorpus({ extractedDir: extractParent, assetsDir });
  const privateFence = path.join(root, 'kb', 'PRIVATE-STORES.json');
  if (!fs.existsSync(privateFence)) fail(`canonical private-store fence missing (${privateFence})`);
  fs.copyFileSync(privateFence, path.join(assetsDir, 'PRIVATE-STORES.json'), fs.constants.COPYFILE_EXCL);
  fs.rmSync(extractParent, { recursive: true, force: true });
  syncCorpusInputs({ root, assetsDir });
  const bootstrapIdentity = { tag: bootstrap.tag, sha256: bootstrap.sha256, privateFenceEvidence: seedPrivateFenceEvidence(assetsDir) };
  const { reconciliation, candidate } = await reconcileAndPrepareCorpusCandidate({
    assetsDir, workspaceDir, root, owner, builderSha, candidateDir, receiptFile, coverageFile, bootstrapIdentity,
    accuracyOracleFile, accuracyStores, accuracySample, accuracyTimeoutMs,
  });
  const plan = reconciliation.rounds.flatMap((round) => round.plan);
  process.stdout.write(`${JSON.stringify({ ok: true, seedTag, seedSha256, plan, reconciliation, ...candidate }, null, 2)}\n`);
  return 0;
}

// REALPATH BOTH SIDES, or this CLI silently no-ops. argv[1] is whatever the caller typed, symlinks
// and all, while node resolves a module URL THROUGH symlinks before it reaches import.meta.url — so a
// symlinked invocation compares a link path against a real path, decides it is not the entry point,
// runs nothing, and EXITS 0. On macOS every os.tmpdir() path is symlinked (/var/folders -> /private/
// var/folders), so any caller staging work in a temp directory hits this. Measured 2026-09-14:
// build-bundle.mjs and corpus-candidate.mjs both no-opped and prepareCorpusCandidate reported SUCCESS
// with no archive and no receipt on disk. Same defect, same fix as plugin/scripts/hook-input.mjs:518.
function isMain() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
