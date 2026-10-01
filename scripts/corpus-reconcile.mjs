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
import { normalizeUpdaterManifest } from './updater-manifest.mjs';
import { FULL_HINTS, KEEP_DIRS } from './full-hints.mjs';
import { buildCoverage, observeSourceUniverse, renderMarkdown } from './source-coverage.mjs';
import { promoteArtifactSet } from '../kb/incremental-refresh.mjs';
import { rebuildCorpusAggregates } from './corpus-aggregates.mjs';
import { assertCapabilityOnlyStore, isCapabilityOnly, CAPABILITY_RETIRED_SUFFIXES } from '../kb/capability-only.mjs';
import { eligibleRepositoryStanding, fileIdentity, validateCoverageLedger } from '../plugin/scripts/coverage-integrity.mjs';
import {
  CORPUS_QA_FAILED_EXIT, FAILURE_CLASS, StoreWorkerError, degradedBound, degradedPublication, failureReason, isRetryable,
} from './corpus-store-failure.mjs';
import { readDiagnosticAccuracyReport } from './oracle/retrieval-accuracy.mjs';
import { storeRoot } from '../kb/store-root.mjs';
import { captureGistSources } from './gist-receipts.mjs';
import { projectSourceStore, RUNTIME_LEDGER_KIND } from './rvf-generation.mjs';
import { compareKnowledgeInputs, fromCoverage as knowledgeFromCoverage, fromSeed as knowledgeFromSeed } from './knowledge-input-digest.mjs';

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

// ADR-0091 D4 -- the ONE seed property that cannot be judged before download. corpus-next-seed.mjs
// judges a published generation's embedding model and recall report from small files, but the
// generation ledger lives only inside the archive, so its schema is checked here, right after
// extraction and BEFORE anything is moved. A mismatch is not a corrupt seed: it is a seed this runtime
// cannot consume (a ledger-schema change is a code-release event). It is thrown as a distinct error
// and main() exits SEED_LEDGER_INCOMPATIBLE_EXIT with the assets directory untouched, so
// corpus-seed.yml can re-run seed extraction ONCE from the committed bootstrap in the same job.
export const SEED_LEDGER_SCHEMA_VERSION = 2;
export const SEED_LEDGER_INCOMPATIBLE_EXIT = 3;
// ADR-0091 D5 + D10: the generation was built and SEALED with carried/missing stores, but degraded
// publication is not yet allowed (no soaked tolerant-validator transition). It must not be published;
// the next night re-plans the carried stores automatically because their sourceCommit still differs.
export const DEGRADED_UNPUBLISHED_EXIT = 4;

export class SeedLedgerIncompatibleError extends Error {
  constructor(reason) {
    super(`[corpus-reconcile] seed ledger is incompatible with this runtime: ${reason}`);
    this.name = 'SeedLedgerIncompatibleError';
    this.reason = reason;
  }
}

/** null when this runtime can consume the ledger, else the reason it cannot. */
export function seedLedgerIncompatibility(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return 'RVF-GENERATIONS.json is not an object';
  if (ledger.schemaVersion !== SEED_LEDGER_SCHEMA_VERSION || ledger.kind !== RUNTIME_LEDGER_KIND) {
    return `RVF-GENERATIONS.json is schemaVersion ${JSON.stringify(ledger.schemaVersion ?? null)} kind ${JSON.stringify(ledger.kind ?? null)}; `
      + `this runtime reads schemaVersion ${SEED_LEDGER_SCHEMA_VERSION} kind ${RUNTIME_LEDGER_KIND}`;
  }
  if (!ledger.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) return 'RVF-GENERATIONS.json has no stores object';
  return null;
}

// Moves the corpus root's TOP-LEVEL entries only (directories such as keys/, primer/ and l2/ move
// whole). Nothing is filtered out: a seed's own runtime files (.mjs, package.json) are harmless here,
// because build-bundle.mjs copies only named store files and the sealed prose from --assets and takes
// every runtime module from the checkout (ADR-0091 D4 withdrew the 0.1.0 "strip" step for that reason,
// and because source-coverage.mjs hard-reads capability-cards.md from these assets).
export function normalizeExtractedCorpus({ extractedDir, assetsDir }) {
  const extracted = path.resolve(extractedDir || '');
  const assets = path.resolve(assetsDir || '');
  if (!fs.existsSync(extracted) || !fs.statSync(extracted).isDirectory()) {
    fail(`extracted seed directory missing (${extracted})`);
  }
  if (fs.existsSync(assets) && fs.readdirSync(assets).length) fail(`bootstrap assets directory is not empty (${assets})`);
  const ledgers = filesNamed(extracted, 'RVF-GENERATIONS.json');
  if (ledgers.length !== 1) fail(`seed archive must contain exactly one RVF-GENERATIONS.json; found ${ledgers.length}`);
  let seedLedger;
  try { seedLedger = JSON.parse(fs.readFileSync(ledgers[0], 'utf8')); }
  catch (error) { throw new SeedLedgerIncompatibleError(`RVF-GENERATIONS.json is unreadable (${error.message})`); }
  const incompatibility = seedLedgerIncompatibility(seedLedger);
  if (incompatibility) throw new SeedLedgerIncompatibleError(incompatibility);
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
    let capabilityPolicyCurrent = !isCapabilityOnly(store);
    if (!capabilityPolicyCurrent && assetsDir) {
      try { assertCapabilityOnlyStore(assetsDir, store); capabilityPolicyCurrent = true; }
      catch { reason = 'capability-only policy requires a clean rebuild'; }
    }
    if (current === upstreamSha && capabilityPolicyCurrent) {
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
  readLedger: currentLedger, execute, prune, rebuild, preflight = null, closingObservation = null, unchanged = null } = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
    || [observe, build, currentLedger, execute, prune, rebuild].some((fn) => typeof fn !== 'function')) {
    fail('bounded acquisition configuration is invalid');
  }
  // ONE discovery pass. This observation is the sealed manifest every later step consumes; it is never
  // re-taken, so upstream churn cannot restart or invalidate the generation.
  const observation = await observe();
  // NO-CHANGE, DECIDED BEFORE ANYTHING IS BUILT (2026-09-29 nightly redesign). When every knowledge
  // input equals the seed's (scripts/knowledge-input-digest.mjs), the night ends here: no gist
  // preflight, no clone, no embedding, no aggregate rebuild, nothing sealed or published.
  if (typeof unchanged === 'function') {
    const knowledgeInput = await unchanged(observation);
    if (knowledgeInput?.unchanged === true) {
      return { noChange: true, observation, attempts: [], consistencyModel: CONSISTENCY_MODEL, knowledgeInput };
    }
  }
  // Validate/fetch the source most likely to fail late (gist detail/raw access) before any expensive
  // repository clone and embedding work. Its verified bodies are the existing capture cache consumed
  // by the later aggregate build, so preflight does not double-fetch or weaken source binding.
  const preflightResult = typeof preflight === 'function' ? await preflight(observation) : null;
  const attempts = [];
  // ADR-0091 D5: stores whose refresh FAILED this generation, keyed by folded store name, with what
  // they became -- { carry } | { failure } | { integrity }. They are never re-executed by a later
  // attempt of this loop and never count as remaining/unresolved: before D5 one stuck store cost all
  // three attempts (each re-running a ~22-minute aggregate rebuild) and then failed the night anyway.
  // The loop now re-attempts only for what it was built for: a gist revision that moved mid-fetch.
  const storeOutcomes = {};
  const recorded = (store) => Object.hasOwn(storeOutcomes, String(store || '').toLowerCase());
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const coverage = await build(observation, storeOutcomes);
    const plan = planReconciliation({ coverage, ledger: currentLedger(), assetsDir }).filter((item) => !recorded(item.store));
    const reconciliation = await execute(plan, attempt);
    recordStoreOutcomes(storeOutcomes, reconciliation);
    assertIsolatedFailures({ coverage, storeOutcomes });
    const pruning = await prune(coverage, attempt);
    let aggregates;
    try {
      aggregates = await rebuild(coverage, observation, attempt, preflightResult);
    } catch (error) {
      if (error?.code !== 'GIST_OBSERVATION_MOVED') throw error;
      // A gist moved between its list entry and its detail fetch. The remedy is to retry against the
      // SAME pinned inputs until one internally consistent revision is captured -- never to re-observe
      // the universe, which is what made the old loop unable to finish.
      attempts.push({ attempt, plan, ...reconciliation, ...pruning, rebuilt: [],
        retried: { reason: 'gist revision moved during exact detail fetch', gistId: error.gistId || null } });
      continue;
    }
    // Re-derive coverage from the SAME sealed observation after the aggregates were rebuilt. This is
    // NOT re-observation -- the manifest is untouched -- it recomputes each row's artifact digests
    // against the bytes this corpus now actually carries. Measured 2026-09-15: without it, a coverage
    // row still pinned the PRE-rebuild ruv-gists digest and build-bundle refused the candidate with
    // "coverage row gist:... was measured against different ruv-gists RVF bytes than this corpus
    // carries", 56 minutes into an otherwise complete run.
    const settled = await build(observation, storeOutcomes);
    const remaining = planReconciliation({ coverage: settled, ledger: currentLedger(), assetsDir })
      .filter((item) => !recorded(item.store));
    const unresolved = settled.rows.filter((row) => row.disposition === 'eligible' && row.status !== 'CURRENT'
      && !(row.kind === 'repository' && recorded(row.artifact?.store)));
    attempts.push({ attempt, plan, ...reconciliation, ...pruning, ...aggregates,
      remainingArtifacts: remaining.length, unresolvedSources: unresolved.length });
    if (!remaining.length && !unresolved.length) {
      return {
        observation, coverage: settled, attempts, consistencyModel: CONSISTENCY_MODEL,
        degraded: degradedSummary(storeOutcomes),
        freshness: await measureFreshness({ closingObservation, observation }),
      };
    }
  }
  const last = attempts[attempts.length - 1] || {};
  fail(`sealed generation incomplete after ${maxAttempts} acquisition attempt(s): `
    + `${last.remainingArtifacts ?? 'unknown'} artifact(s) and ${last.unresolvedSources ?? 'unknown'} `
    + 'eligible source(s) remain unresolved against the sealed manifest');
}

function recordStoreOutcomes(storeOutcomes, reconciliation) {
  for (const { store, carry } of reconciliation?.carried || []) storeOutcomes[store.toLowerCase()] = { carry };
  for (const { store, failure } of reconciliation?.missing || []) storeOutcomes[store.toLowerCase()] = { failure };
  for (const { store, integrity } of reconciliation?.integrityFailures || []) storeOutcomes[store.toLowerCase()] = { integrity };
}

export function degradedSummary(storeOutcomes) {
  const entries = Object.entries(storeOutcomes || {}).sort(([a], [b]) => a.localeCompare(b));
  return {
    carried: entries.filter(([, outcome]) => outcome.carry).map(([store, outcome]) => ({ store, ...outcome.carry })),
    missing: entries.filter(([, outcome]) => outcome.failure).map(([store, outcome]) => ({ store, ...outcome.failure })),
  };
}

/**
 * Fail the generation the moment isolation stops being the right answer, BEFORE pruning and the
 * ~22-minute aggregate rebuild are spent on it:
 *  - any integrity failure (carried bytes that no longer match the seed ledger, or a same-commit
 *    rebuild that failed) -- such a row is FAILED, and FAILED is never shippable, so no bound can
 *    admit it;
 *  - more carried + missing stores than max(3, 5% of eligible) -- the failure is systemic, and
 *    publishing around it would hide a forge or network regression.
 */
export function assertIsolatedFailures({ coverage, storeOutcomes }) {
  const outcomes = Object.entries(storeOutcomes || {});
  const integrity = outcomes.filter(([, outcome]) => outcome.integrity);
  if (integrity.length) {
    fail(`integrity failure in ${integrity.length} store(s): `
      + `${integrity.map(([store, outcome]) => `${store} (${outcome.integrity})`).join('; ')} -- the generation fails`);
  }
  const eligible = (coverage?.rows || []).filter((row) => row.kind === 'repository' && row.disposition === 'eligible').length;
  const isolated = outcomes.length;
  const bound = degradedBound(eligible);
  if (isolated > bound) {
    fail(`systemic failure: ${isolated} of ${eligible} eligible store(s) failed to refresh `
      + `(${outcomes.map(([store]) => store).join(', ')}); the bound is max(3, 5% of eligible) = ${bound} -- the generation fails`);
  }
}

/**
 * The ONE reader of an acquisition result's per-attempt history (ADR-0091 D1).
 *
 * WHY THIS EXISTS. cd0f032f renamed the loop's history from `rounds` to `attempts` but left two
 * independent readers behind: main() (`reconciliation.rounds.flatMap(...)`) and the local rehearsal
 * (scripts/rehearse-corpus-pipeline.mjs). Both threw "Cannot read properties of undefined (reading
 * 'flatMap')" AFTER the whole generation had been acquired, so every corpus-publish run died at its
 * last line and the rehearsal meant to catch that died at the same place. Every reader now goes
 * through here, and a result without an `attempts` array fails by name instead of by TypeError.
 */
export function summarizeReconciliation(reconciliation) {
  const attempts = reconciliation?.attempts;
  if (!Array.isArray(attempts)) {
    fail(`reconciliation result has no attempts array (keys: ${Object.keys(reconciliation || {}).join(', ') || 'none'}); `
      + 'acquireSealedGeneration returns { observation, coverage, attempts, ... }');
  }
  const across = (field) => attempts.flatMap((attempt) => attempt?.[field] || []);
  return {
    attempts: attempts.length,
    observationSha256: reconciliation.observation?.observationSha256 ?? null,
    plan: across('plan'),
    refreshed: across('refreshed'),
    pruned: across('pruned'),
    rebuilt: across('rebuilt'),
    // ADR-0091 D5: the stores this generation carries (STALE) or lacks (MISSING) after an isolated
    // refresh failure. Empty lists on an all-CURRENT generation.
    degraded: {
      carried: reconciliation.degraded?.carried || [],
      missing: reconciliation.degraded?.missing || [],
    },
  };
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

export function defaultRunAsync(command, args, options = {}) {
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
  assertCapabilityOnlyStore(output, item.store);
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

// ADR-0091 D5: the commit date of the bytes a carried store keeps, when the PREVIOUS generation's
// sealed coverage proves it. A row whose observed upstream SHA IS the carried commit dates that exact
// commit; a row that was itself carried passes its own carriedCommittedAt on. Anything else -- no
// prior coverage (the bootstrap lineage), an invalid one, a different commit -- is null, never
// estimated (D7.1 reads this for `oldestCarried`).
export function readPriorCoverage(assetsDir) {
  const file = path.join(path.resolve(assetsDir || ''), 'CORPUS-COVERAGE.json');
  if (!fs.existsSync(file)) return null;
  try {
    const coverage = JSON.parse(fs.readFileSync(file, 'utf8'));
    return coverage?.kind === 'ruvnet-brain-corpus-coverage' && validateCoverageLedger(coverage).valid ? coverage : null;
  } catch {
    return null;
  }
}

export function carriedCommittedAt({ priorCoverage, store, sourceCommit }) {
  const folded = String(store || '').toLowerCase();
  const commit = String(sourceCommit || '').toLowerCase();
  const row = (priorCoverage?.rows || []).find((candidate) => candidate?.kind === 'repository'
    && String(candidate?.artifact?.store || '').toLowerCase() === folded);
  const iso = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
  if (!row || !HEX40.test(commit)) return null;
  if (String(row.upstream?.sha || '').toLowerCase() === commit) return iso(row.upstream?.committedAt);
  if (String(row.carry?.carriedSourceCommit || '').toLowerCase() === commit) return iso(row.carry?.carriedCommittedAt);
  return null;
}

// ADR-0091 D5: what a store whose refresh FAILED becomes. planReconciliation's byte check never
// covers a store it plans (it runs only when sourceCommit already equals upstream), so the seed
// bytes are re-hashed HERE before they may stand in for the missed refresh. The ledger binds one file
// per store (the .big.rvf: file, bytes, sha256); the rest of the family must be present as regular
// files. The seed archive itself was digest-verified on download (assertBootstrapIdentity).
export function dispositionForFailedStore({ assetsDir, ledger, item, attempts, reason, priorCoverage = null }) {
  const assets = path.resolve(assetsDir || '');
  const generation = Object.entries(ledger?.stores || {})
    .find(([name]) => name.toLowerCase() === item.store.toLowerCase())?.[1] || null;
  if (!generation) return { store: item.store, failure: { reason, attempts } };
  const carried = String(generation.sourceCommit || '').toLowerCase();
  if (!HEX40.test(carried)) {
    return { store: item.store, integrity: 'carried bytes have no exact 40-hex ledger sourceCommit to carry' };
  }
  if (carried === item.upstreamSha) {
    // Planned for a policy or receipt reason at the SAME commit (a capability-only clean rebuild, or
    // seed bytes that already failed the receipt check): the seed bytes are exactly what the rebuild
    // was meant to replace, so they cannot stand in for it.
    return { store: item.store, integrity: 'the refresh was a same-commit rebuild the seed bytes cannot stand in for' };
  }
  const regular = (name) => {
    try { const stat = fs.lstatSync(path.join(assets, name)); return stat.isFile() && !stat.isSymbolicLink(); }
    catch { return false; }
  };
  const rvf = `${item.store}.big.rvf`;
  const bound = generation.file === rvf && regular(rvf)
    && generation.bytes === fs.statSync(path.join(assets, rvf)).size
    && generation.sha256 === sha256File(path.join(assets, rvf))
    && REQUIRED_STORE_ARTIFACT_SUFFIXES.every((suffix) => regular(`${item.store}${suffix}`));
  if (!bound) return { store: item.store, integrity: 'carried bytes differ from the seed generation ledger' };
  return { store: item.store, carry: {
    reason,
    carriedSourceCommit: carried,
    missedUpstream: item.upstreamSha,
    attempts,
    carriedCommittedAt: carriedCommittedAt({ priorCoverage, store: item.store, sourceCommit: carried }),
  } };
}

// Only a TRANSIENT failure is retried, exactly once, in a fresh directory: `<store>-retry1`. The first
// attempt's directory is never reused -- a clone or a half-written worker output from the failed
// attempt must not be mistaken for the retry's own (the pre-D5 path collided).
export function workerRootFor(workspace, store, retry) {
  return path.join(workspace, 'workers', retry === 0 ? store : `${store}-retry${retry}`);
}
export const MAX_TRANSIENT_RETRIES = 1;

export async function executeReconciliation({
  plan,
  assetsDir,
  workspaceDir,
  root = DEFAULT_ROOT,
  run = defaultRunAsync,
  concurrency = 5,
  signal,
  priorCoverage = null,
  log = (line) => console.log(line),
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

  // ADR-0091 D5: ONE store failing no longer aborts the round. Before D5 the first worker error
  // aborted every sibling (2 of 9 corpus runs died that way: one deterministic `ruvector` QA miss
  // threw away 93 other stores' refreshes). Now each store's failure is recorded and its lane moves
  // on; the shared AbortController below exists ONLY for an externally supplied `signal` -- a caller
  // discarding the whole round -- which still stops and joins every lane (required proof 4).
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  const stage = async (item, name, classify, command, args, options = {}) => {
    const result = await run(command, args, { ...options, signal: controller.signal }) || {};
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (result.error || result.status !== 0) {
      const detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim().slice(0, 400);
      throw new StoreWorkerError({ store: item.store, stage: name, failureClass: classify(result), detail });
    }
    return result;
  };
  const transient = () => FAILURE_CLASS.TRANSIENT;
  // forge-refresh's exit status is the structured reason: CORPUS_QA_FAILED_EXIT means corpus-qa refused
  // the candidate (deterministic, never retried); a spawn error is runner I/O (transient); any other
  // non-zero exit is a build failure (not retried: a retry is a full re-embed with no reason to differ).
  const forgeClass = (result) => (result.status === CORPUS_QA_FAILED_EXIT ? FAILURE_CLASS.QA
    : result.error ? FAILURE_CLASS.TRANSIENT : FAILURE_CLASS.BUILD);

  const worker = async (item, retry) => {
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (!SAFE_STORE.test(item.store) || !HEX40.test(item.upstreamSha) || !repositorySlug(item.url)) {
      throw new StoreWorkerError({ store: item?.store || item?.name || 'unknown store', stage: 'plan item',
        failureClass: FAILURE_CLASS.INTEGRITY, detail: 'unsafe reconciliation item' });
    }
    const workerRoot = workerRootFor(workspace, item.store, retry);
    if (fs.existsSync(workerRoot)) {
      throw new StoreWorkerError({ store: item.store, stage: 'worker directory', failureClass: FAILURE_CLASS.INTEGRITY,
        detail: 'a fresh worker directory already exists' });
    }
    const cloneDir = path.join(workerRoot, 'clone');
    const output = path.join(workerRoot, 'assets');
    try {
      fs.mkdirSync(workerRoot, { recursive: true });
      seedWorkerAssets({ assets, output, store: item.store, ledger: canonicalLedger, source: canonicalSource });
    } catch (error) {
      // An errno (disk, file table) is runner I/O; our own refusal is an integrity failure.
      throw new StoreWorkerError({ store: item.store, stage: 'worker seed copy',
        failureClass: typeof error?.code === 'string' ? FAILURE_CLASS.TRANSIENT : FAILURE_CLASS.INTEGRITY, detail: error.message });
    }
    await stage(item, 'git clone', transient, 'git', ['clone', '--no-checkout', '--filter=blob:none', item.url, cloneDir]);
    await stage(item, 'git fetch', transient, 'git', ['-C', cloneDir, 'fetch', '--depth=1', 'origin', item.upstreamSha]);
    await stage(item, 'git checkout', transient, 'git', ['-C', cloneDir, 'checkout', '--detach', 'FETCH_HEAD']);
    const head = await stage(item, 'git rev-parse', transient, 'git', ['-C', cloneDir, 'rev-parse', 'HEAD']);
    if (String(head.stdout || '').trim().toLowerCase() !== item.upstreamSha) {
      throw new StoreWorkerError({ store: item.store, stage: 'exact-sha checkout', failureClass: FAILURE_CLASS.INTEGRITY,
        detail: 'fresh clone did not resolve the exact upstream SHA' });
    }
    await stage(item, 'forge-refresh', forgeClass, process.execPath, [forge, '--repo', cloneDir, '--out', output, '--name', item.store,
      ...(FULL_HINTS[item.store] ? ['--full', FULL_HINTS[item.store]] : []),
      ...(KEEP_DIRS[item.store] ? ['--keep', KEEP_DIRS[item.store]] : []),
    ], { stdio: 'inherit', env: { ...process.env, RUVNET_BIG_SHARDS: '1' } });
    try {
      return validateWorkerOutput({ output, item });
    } catch (error) {
      throw new StoreWorkerError({ store: item.store, stage: 'worker output validation', failureClass: FAILURE_CLASS.INTEGRITY,
        detail: error.message });
    }
  };

  const runStore = async (item) => {
    let lastError = null;
    let attempts = 0;
    for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry += 1) {
      attempts += 1;
      try {
        return { ok: true, attempts, result: await worker(item, retry) };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        lastError = error;
        const retrying = isRetryable(error) && retry < MAX_TRANSIENT_RETRIES;
        log(`[corpus-reconcile] ${item.store}: attempt ${attempts} failed -- ${error.message}`
          + (retrying ? '; retrying once in a fresh worker directory' : '; not retried'));
        if (!retrying) break;
      }
    }
    return { ok: false, attempts, error: lastError };
  };

  const outcomes = new Array(orderedPlan.length);
  let next = 0;
  let firstError = null;
  await Promise.all(Array.from({ length: Math.min(concurrency, orderedPlan.length) }, async () => {
    while (next < orderedPlan.length) {
      if (controller.signal.aborted) return;
      const index = next++;
      try {
        outcomes[index] = await runStore(orderedPlan[index]);
      } catch (error) {
        // Only an external cancellation reaches here; every lane is already observing the same signal.
        if (!firstError) firstError = error;
        return;
      }
    }
  }));
  if (!firstError && controller.signal.aborted) firstError = abortError(controller.signal);
  if (firstError) throw firstError;

  const carried = [];
  const missing = [];
  const integrityFailures = [];
  outcomes.forEach((outcome, index) => {
    if (!outcome || outcome.ok) return;
    const disposition = dispositionForFailedStore({ assetsDir: assets, ledger: canonicalLedger, item: orderedPlan[index],
      attempts: outcome.attempts, reason: failureReason(outcome.error), priorCoverage });
    if (disposition.carry) carried.push(disposition);
    else if (disposition.failure) missing.push(disposition);
    else integrityFailures.push(disposition);
    log(`[corpus-reconcile] ${orderedPlan[index].store}: ${disposition.carry ? 'CARRIED at its verified seed bytes (STALE)'
      : disposition.failure ? 'MISSING (no prior bytes)' : `INTEGRITY FAILURE (${disposition.integrity})`}`);
  });
  // The merge reads SUCCESSFUL results only. `outcomes` is indexed by plan position, so a failed
  // store leaves a slot with no worker result; the pre-D5 merge read `result.files` off every slot.
  const results = outcomes.filter((outcome) => outcome?.ok).map((outcome) => outcome.result);
  const failed = { carried, missing, integrityFailures };
  if (!results.length) return { refreshed: [], workers: [], ...failed };

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
    // S4 (ONE PROVENANCE RECORD): re-project the merged SOURCE.json entry FROM the merged ledger
    // row rather than trusting the worker's own already-written SOURCE.json fragment verbatim —
    // the merge boundary is where multiple workers' results combine, so it is the right place to
    // assert "the ledger is the source of truth" rather than assume every worker upheld it.
    // `result.source` (validateWorkerOutput's read of the worker's own output, already checked
    // there to bind the exact upstream SHA) supplies the non-identity updater fields unchanged.
    mergedSource.stores[result.store] = projectSourceStore(result.store, result.generation, result.source);
  }
  mergedLedger.stores = Object.fromEntries(Object.entries(mergedLedger.stores).sort(([a], [b]) => a.localeCompare(b)));
  mergedSource.stores = Object.fromEntries(Object.entries(mergedSource.stores).sort(([a], [b]) => a.localeCompare(b)));
  writeJsonAtomic(path.join(merge, 'RVF-GENERATIONS.json'), mergedLedger);
  writeJsonAtomic(path.join(merge, 'SOURCE.json'), mergedSource);
  promotedFiles.push('RVF-GENERATIONS.json', 'SOURCE.json');
  promoteArtifactSet({ liveDir: assets, candidateDir: merge, files: promotedFiles.sort() });
  // Worker output replaces selected files, so explicitly retire old seed sidecars
  // that are intentionally absent from a capability-only worker's output.
  for (const { store } of results) if (isCapabilityOnly(store)) {
    for (const suffix of CAPABILITY_RETIRED_SUFFIXES) fs.rmSync(path.join(assets, `${store}${suffix}`), { force: true });
    assertCapabilityOnlyStore(assets, store);
  }
  return { refreshed: results.map(({ store }) => store),
    workers: results.map(({ output: _output, ...receipt }) => receipt), ...failed };
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
  build = (observation, storeOutcomes = null) => buildCoverage({ owner, kbDir: assetsDir, policyDir: assetsDir, observation,
    storeOutcomes }),
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
  preflight = (observation) => captureGistSources({ observation }),
  rebuild = (coverage, observation, _attempt, capturedGists) => rebuildCorpusAggregates({
    assetsDir, observation, coverage, root, cache: capturedGists,
  }),
  // The seed's knowledge inputs come from the evidence it carries (read FIRST: a seed without it --
  // the pre-contract bootstrap -- always builds, and costs no second coverage measurement); tonight's
  // from the coverage `build` measures off the sealed observation, plus this checkout's public prose.
  unchanged = async (observation) => {
    const seed = knowledgeFromSeed(assetsDir);
    if (!seed) return { unchanged: false, reason: 'the seed carries no knowledge-input evidence' };
    return compareKnowledgeInputs({ seed, tonight: await knowledgeFromCoverage(await build(observation, {}), root) });
  },
} = {}) {
  if (!assetsDir || !workspaceDir) fail('stable reconciliation requires explicit assets and workspace directories');
  const workspace = path.resolve(workspaceDir || '');
  const forbidden = forbiddenOutputRoots(root);
  assertPathNotOverlapping('reconciliation assets directory', assetsDir, forbidden);
  assertPathNotOverlapping('reconciliation workspace directory', workspace, forbidden);
  assertPathNotOverlapping('reconciliation workspace directory', workspace,
    [{ label: 'the assets directory', dir: assetsDir }]);
  // Read ONCE, before anything is rebuilt: the seed's own sealed coverage dates a carried store's bytes.
  const priorCoverage = readPriorCoverage(assetsDir);
  return acquireSealedGeneration({
    maxAttempts,
    closingObservation,
    assetsDir,
    observe: () => (observe || observeSourceOnly)({ owner, assetsDir }),
    build,
    readLedger,
    execute: (plan, attempt) => execute({
      plan, assetsDir, workspaceDir: path.join(workspace, `attempt-${attempt}`), root, priorCoverage,
    }),
    prune,
    rebuild,
    preflight,
    unchanged,
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
  owner = 'ruvnet', builderSha, candidateDir, receiptFile, coverageFile, bootstrapIdentity = null, maxAttempts = 3,
  reconcile = (options) => acquireCorpusGeneration(options),
  normalizeUpdaters = normalizeUpdaterManifest,
  accuracyOracleFile = null, accuracyStores = null, accuracySample = null, accuracySamplePerPartition = null,
  accuracyTimeoutMs = null, seedArchive = null,
  prepare = prepareCorpusCandidate } = {}) {
  const finalized = await reconcile({ owner, assetsDir, workspaceDir, root, maxAttempts });
  // Nothing the corpus is built from changed since the seed: nothing to normalize, seal or measure.
  if (finalized?.noChange === true) return { reconciliation: finalized, noChange: true, updaters: null, candidate: null };
  // Every shipped repository store needs a complete updater entry, and a seed that predates the
  // convention leaves inherited stores without one -- measured 2026-09-15: 100 of 194 repository
  // stores, none of them refreshed that run, which build-bundle rightly refused to ship. Normalize
  // AFTER reconciliation and aggregate rebuild, BEFORE anything seals or assembles this corpus, and
  // run even when nothing was refreshed. A store whose artifact cannot be verified against the ledger
  // is never synthesized -- it is reported here and fails the build, because it needs a real rebuild.
  const updaters = normalizeUpdaters({
    assetsDir,
    coverage: finalized.coverage,
    refreshedStores: summarizeReconciliation(finalized).refreshed.map((r) => r?.store || r).filter(Boolean),
    seedIdentity: bootstrapIdentity,
  });
  if (updaters.missing?.length) {
    fail(`${updaters.missing.length} repository store(s) still carry no updater entry after normalization `
      + `(${updaters.missing.slice(0, 5).join(', ')}${updaters.missing.length > 5 ? ', ...' : ''}); `
      + `unverified: ${JSON.stringify(updaters.unverified?.slice(0, 5) || [])}`);
  }
  const candidate = await prepare({
    root, assetsDir, builderSha, candidateDir, receiptFile, coverageFile, bootstrapIdentity,
    coverage: finalized.coverage,
    accuracyOracleFile, accuracyStores, accuracySample, accuracySamplePerPartition, accuracyTimeoutMs, seedArchive,
  });
  return { reconciliation: finalized, updaters, candidate };
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
  // ADR-0091 D2: a whole-oracle, deterministic question sample (retrieval-accuracy.mjs
  // --sample-questions). `accuracySamplePerPartition` is the older first-k-per-partition bound; its
  // floor is one question per partition (196 x 2 queries, ~27 min hosted), so it cannot meet D2.
  accuracySample = null,
  accuracySamplePerPartition = null,
  accuracyTimeoutMs = null,
  // { file, tag, sha256 } of the seed archive this generation was reconciled from. When present, the
  // archive is assembled WITH its release coverage projection (COVERAGE.json + CORPUS-COVERAGE.json +
  // PUBLIC-RVF-GENERATIONS.json), exactly as scripts/code-release-corpus.mjs's single-pass path does:
  // kb/forge-update.mjs refuses any staged tree without it, so a nightly archive lacking it can never
  // reach an installed customer (measured 2026-09-30: "COVERAGE.json is missing").
  seedArchive = null,
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
  const degraded = assessCandidateCoverage(coverage);
  assertPathNotOverlapping('candidate output directory', candidate, forbiddenOutputRoots(sourceRoot));
  const buildScript = path.join(sourceRoot, 'scripts', 'build-bundle.mjs');
  const receiptScript = path.join(sourceRoot, 'scripts', 'corpus-candidate.mjs');
  const accuracyScript = path.join(sourceRoot, 'scripts', 'oracle', 'retrieval-accuracy.mjs');
  const recallScript = path.join(sourceRoot, 'scripts', 'oracle', 'repo-recall.mjs');
  for (const required of [buildScript, receiptScript, accuracyScript, recallScript]) {
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
  // The recall gate's two inputs are hard inputs, checked BEFORE the expensive assembly for the same
  // reason the oracle is: a missing ratchet must fail in seconds, not after an hour of building.
  for (const required of [
    path.join(sourceRoot, 'data', 'retrieval-query-evidence.json'),
    path.join(sourceRoot, 'data', 'repo-recall-floor.json'),
  ]) {
    if (!fs.existsSync(required)) fail(`repo-recall gate input missing (${required}); a corpus cannot be sealed without the frozen fixture and the ratchet it must not regress below`);
  }
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  fs.writeFileSync(policy, `${JSON.stringify(coverage, null, 2)}\n`);
  const markdownPath = path.join(sourceRoot, 'docs', 'RUVNET-COVERAGE.md');
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, renderMarkdown(coverage));
  // The seed's baseline observation, then the SAME build-bundle seed flags the code release passes.
  // The release identity is the runtime this corpus is built at: package.json's version (build-bundle's
  // default) and the builder checkout's exact commit.
  let seedArgs = [];
  if (seedArchive) {
    const seedFile = path.resolve(seedArchive.file || '');
    if (!fs.existsSync(seedFile) || !HEX64.test(String(seedArchive.sha256 || '')) || !seedArchive.tag) {
      fail('seed archive identity is incomplete (file, tag and sha256 are required together)');
    }
    const seedBytes = fs.statSync(seedFile).size;
    const baselineReceipt = path.join(path.dirname(receipt), `baseline-observation-receipt-${seedArchive.sha256}.json`);
    checked(run, process.execPath, [path.join(sourceRoot, 'scripts', 'public-verification-inputs.mjs'), 'observe-baseline',
      '--baseline-bundle', seedFile, '--expected-tag', seedArchive.tag, '--expected-sha256', seedArchive.sha256,
      '--expected-bytes', String(seedBytes), '--out', baselineReceipt], { stdio: 'inherit' });
    seedArgs = ['--seed-tag', seedArchive.tag, '--seed-sha256', seedArchive.sha256, '--seed-bytes', String(seedBytes),
      '--baseline-receipt-sha256', sha256File(baselineReceipt), '--source-snapshot', String(builderSha).toLowerCase()];
  }
  checked(run, process.execPath, [buildScript, '--assets', assets, '--out', candidate,
    '--coverage', policy, ...seedArgs], { stdio: 'inherit' });
  const bundleFile = path.join(path.dirname(candidate), `${path.basename(candidate)}.zip`);
  // ADR-086 Step 15: the benchmark runs HERE — after single-pass assembly and before the seal —
  // against the EXTRACTED final archive through the customer query path, never against `assets`.
  // The report is written detached, beside the archive, and the receipt below binds its digest.
  // C3 is a non-blocking diagnostic (ADR-086 amendment 2026-09-15): every reader of this report
  // (corpus-candidate.mjs, release.mjs, corpus-seed.yml) uses readDiagnosticAccuracyReport, which
  // checks only its schema and its binding to this archive, oracle and generator -- never whether
  // coverage is complete. So a bounded run (--stores/--sample/--sample-questions) seals exactly like
  // a full one; it marks itself `coverage.complete: false`, and only the retained strict reader
  // (validateAccuracyReport, the re-arm path) would refuse it. corpus-seed.yml runs a question
  // sample (ADR-0091 D2) because the full run cost 82 minutes on a hosted runner.
  const accuracyReportFile = `${bundleFile}.accuracy.json`;
  // A stale leftover report from a prior run must never be mistaken for a fresh measurement of
  // THIS bundle -- delete it before invoking the script so only a report the script just wrote
  // (or none at all) can be found below.
  fs.rmSync(accuracyReportFile, { force: true });
  const accuracyResult = run(process.execPath, [accuracyScript, '--bundle', bundleFile,
    '--oracle', accuracyOracle, '--out', accuracyReportFile,
    ...(accuracyStores != null ? ['--stores', String(accuracyStores)] : []),
    ...(accuracySample != null ? ['--sample-questions', String(accuracySample)] : []),
    ...(accuracySamplePerPartition != null ? ['--sample', String(accuracySamplePerPartition)] : []),
    ...(accuracyTimeoutMs != null ? ['--timeout-ms', String(accuracyTimeoutMs)] : [])],
  { stdio: 'inherit' }) || {};
  // C3 was demoted to a non-blocking diagnostic on 2026-09-15 (commit a20727b7, ADR-086
  // amendment) -- every other caller (corpus-candidate.mjs, release.mjs, corpus-seed.yml) reads
  // it through readDiagnosticAccuracyReport, which checks the report's integrity/archive binding,
  // never its score. A nonzero exit here is therefore NOT immediately fatal: it may just mean the
  // measured score fell below the (no-longer-enforced) threshold. What stays fatal is a CRASHED
  // measurement -- no valid report bound to this exact archive was produced at all.
  if (accuracyResult.error || accuracyResult.status !== 0) {
    let diagnostic;
    try {
      diagnostic = readDiagnosticAccuracyReport({ reportFile: accuracyReportFile, archive: fileIdentity(bundleFile) });
    } catch (error) {
      fail(`retrieval-accuracy diagnostic (C3) crashed with no valid report to show for it: ${error.message}`);
    }
    console.log(`[corpus-reconcile] C3 retrieval-accuracy diagnostic scored below its (non-blocking) `
      + `threshold: state=${diagnostic.state} classification=${diagnostic.classification} `
      + `totals=${JSON.stringify(diagnostic.totals)} -- continuing, C3 is advisory only.`);
  }
  // THE BLOCKING RETRIEVAL GATE (ADR-086 amendment 2026-09-15). Same placement and same discipline
  // as the C3 run above — the EXTRACTED final archive through the customer query path — but this is
  // the measurement that can refuse a candidate. It asks the 194 frozen human questions, one per
  // repository, and fails on any error or any repository that returns nothing of its own. The
  // exact-file Hit@5 floor is RECORDED in the report and never fails the CLI (ADR-0091 D7.6).
  // `--coverage` is this candidate's sealed observation: a fixture repository with no row in it is
  // retired (D7.2) instead of asked a question it has no store to answer.
  const recallReportFile = `${bundleFile}.recall.json`;
  checked(run, process.execPath, [recallScript, '--bundle', bundleFile, '--out', recallReportFile, '--coverage', policy],
    { stdio: 'inherit' });
  // The candidate receipt is derived ENTIRELY from the sealed bundle's own bytes plus the detached,
  // digest-bound reports — the separate assets/policy directory used to build it is no longer an
  // alternate verification root.
  const bootstrapArgs = bootstrapIdentity?.tag && bootstrapIdentity?.sha256
    ? ['--bootstrap-tag', bootstrapIdentity.tag, '--bootstrap-sha256', bootstrapIdentity.sha256]
    : [];
  checked(run, process.execPath, [receiptScript, '--bundle', bundleFile,
    '--receipt', receipt, '--builder-source-sha', builderSha,
    '--accuracy-report', accuracyReportFile, '--recall-report', recallReportFile, '--coverage', policy,
    ...bootstrapArgs], { stdio: 'inherit' });
  checked(run, process.execPath, [receiptScript, '--verify', '--bundle', bundleFile,
    '--receipt', receipt, '--accuracy-report', accuracyReportFile,
    '--recall-report', recallReportFile, '--coverage', policy], { stdio: 'inherit' });
  return {
    bundleFile, receiptFile: receipt, coverageFile: policy,
    accuracyReportFile, accuracyOracleFile: accuracyOracle, recallReportFile, degraded,
  };
}

/**
 * ADR-0091 D5 -- the gate that replaced "every eligible row is CURRENT". An eligible row passes when
 * it is CURRENT, or when it is a repository row the shipped validator itself accepts
 * (eligibleRepositoryStanding: STALE with a verified `carry`, MISSING with a `failure`). Everything
 * else -- a STALE/MISSING row with no record, FAILED, UNVERIFIED, any non-CURRENT gist -- still fails
 * closed, and so does a count of carried + missing stores above max(3, 5% of eligible).
 */
export function assessCandidateCoverage(coverage) {
  const eligible = coverage.rows.filter((row) => row.disposition === 'eligible');
  const carried = [];
  const missing = [];
  const blockers = [];
  for (const row of eligible) {
    const standing = row.kind === 'repository' ? eligibleRepositoryStanding(row)
      : row.status === 'CURRENT' && row.carry === undefined && row.failure === undefined ? 'shipped' : null;
    if (standing === null) blockers.push(row);
    else if (row.carry) carried.push({ store: row.artifact.store, ...row.carry });
    else if (row.failure) missing.push({ store: row.artifact.store, ...row.failure });
  }
  if (blockers.length) {
    fail(`strict coverage: ${blockers.length} eligible row(s) are not CURRENT and carry no verified carry/failure record `
      + `(${blockers.slice(0, 5).map((row) => `${row.artifact?.store || row.key}:${row.status}`).join(', ')}`
      + `${blockers.length > 5 ? ', ...' : ''})`);
  }
  const repositories = eligible.filter((row) => row.kind === 'repository').length;
  const bound = degradedBound(repositories);
  if (carried.length + missing.length > bound) {
    fail(`degraded coverage: ${carried.length} carried + ${missing.length} missing store(s) exceed `
      + `max(3, 5% of ${repositories} eligible) = ${bound}`);
  }
  return { carried, missing, bound, eligibleRepositories: repositories };
}

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

// The two injectable seams exist so a test can drive main() end to end (ADR-0091 D1): nothing
// called main() before, which is how its last line stayed broken for weeks. Production passes neither.
export async function main(argv = process.argv.slice(2), {
  reconcileAndPrepare = reconcileAndPrepareCorpusCandidate, stdout = process.stdout, stderr = process.stderr } = {}) {
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
  // Bounded measurement is explicit and opt-in; omit every flag below for the full C3 audit.
  // `--accuracy-sample <n>` measures n oracle questions in total (both query modes), chosen
  // deterministically -- what corpus-seed.yml passes (ADR-0091 D2). A bounded report still seals,
  // because C3 is a diagnostic and its readers check binding, not completeness.
  const accuracyStores = arg(argv, '--accuracy-stores') ? Number(arg(argv, '--accuracy-stores')) : null;
  const accuracySample = arg(argv, '--accuracy-sample') ? Number(arg(argv, '--accuracy-sample')) : null;
  const accuracySamplePerPartition = arg(argv, '--accuracy-sample-per-partition')
    ? Number(arg(argv, '--accuracy-sample-per-partition')) : null;
  const accuracyTimeoutMs = arg(argv, '--accuracy-timeout-ms') ? Number(arg(argv, '--accuracy-timeout-ms')) : null;

  // `--no-change-out <file>`: always written (true or false) once reconciliation returns, so
  // corpus-seed.yml never has to infer a no-change night from a missing file.
  const noChangeOut = arg(argv, '--no-change-out');
  // The argv this main() was HANDED, never process.argv: an injected invocation must mean what it says.
  const bootstrap = assertBootstrapIdentity({ archiveFile, tag: seedTag, sha256: seedSha256, allowPinnedTag: argv.includes('--allow-pinned-seed-tag') });
  if (fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).length) fail(`bootstrap assets directory is not empty (${assetsDir})`);
  fs.mkdirSync(path.dirname(assetsDir), { recursive: true });
  const extractParent = fs.mkdtempSync(path.join(path.dirname(assetsDir), '.corpus-seed-extract-'));
  await extractZip(archiveFile, extractParent);
  try {
    normalizeExtractedCorpus({ extractedDir: extractParent, assetsDir });
  } catch (error) {
    if (!(error instanceof SeedLedgerIncompatibleError)) throw error;
    // Nothing was moved; leave --assets exactly as absent/empty as it was so the one bootstrap retry
    // in corpus-seed.yml can reuse the same path. A distinct exit code, never a generic failure.
    fs.rmSync(extractParent, { recursive: true, force: true });
    stderr.write(`${error.message}\n[corpus-reconcile] seed ${seedTag} cannot be consumed by this runtime; `
      + `exiting ${SEED_LEDGER_INCOMPATIBLE_EXIT} so the caller can fall back to the committed bootstrap seed\n`);
    return SEED_LEDGER_INCOMPATIBLE_EXIT;
  }
  const privateFence = path.join(root, 'kb', 'PRIVATE-STORES.json');
  if (!fs.existsSync(privateFence)) fail(`canonical private-store fence missing (${privateFence})`);
  fs.copyFileSync(privateFence, path.join(assetsDir, 'PRIVATE-STORES.json'), fs.constants.COPYFILE_EXCL);
  fs.rmSync(extractParent, { recursive: true, force: true });
  syncCorpusInputs({ root, assetsDir });
  const bootstrapIdentity = { tag: bootstrap.tag, sha256: bootstrap.sha256, privateFenceEvidence: seedPrivateFenceEvidence(assetsDir) };
  const { reconciliation, candidate, noChange = false } = await reconcileAndPrepare({
    assetsDir, workspaceDir, root, owner, builderSha, candidateDir, receiptFile, coverageFile, bootstrapIdentity,
    accuracyOracleFile, accuracyStores, accuracySample, accuracySamplePerPartition, accuracyTimeoutMs,
    seedArchive: { file: archiveFile, tag: bootstrap.tag, sha256: bootstrap.sha256 },
  });
  if (noChangeOut) {
    fs.mkdirSync(path.dirname(path.resolve(noChangeOut)), { recursive: true });
    fs.writeFileSync(path.resolve(noChangeOut), `${JSON.stringify({
      noChange: noChange === true,
      knowledgeInputSha256: noChange === true ? reconciliation?.knowledgeInput?.tonightSha256 ?? null : null,
      observationSha256: reconciliation?.observation?.observationSha256 ?? null,
    })}\n`);
  }
  if (noChange === true) {
    stdout.write(`${JSON.stringify({ ok: true, noChange: true, seedTag, seedSha256,
      knowledgeInput: reconciliation?.knowledgeInput ?? null }, null, 2)}\n`);
    return 0;
  }
  const { plan } = summarizeReconciliation(reconciliation);
  const degraded = candidate.degraded || { carried: [], missing: [] };
  const isDegraded = degraded.carried.length + degraded.missing.length > 0;
  const publication = isDegraded ? degradedPublication() : { allowed: true, reason: 'every eligible row is CURRENT' };
  stdout.write(`${JSON.stringify({ ok: publication.allowed, seedTag, seedSha256, plan, reconciliation, ...candidate,
    degraded: { ...degraded, publishable: publication.allowed, reason: publication.reason } }, null, 2)}\n`);
  if (!publication.allowed) {
    stderr.write(`::warning title=Degraded corpus generation sealed, not published::${degraded.carried.length} carried `
      + `(${degraded.carried.map((row) => row.store).join(', ') || 'none'}), ${degraded.missing.length} missing `
      + `(${degraded.missing.map((row) => row.store).join(', ') || 'none'}); ${publication.reason}\n`);
    return DEGRADED_UNPUBLISHED_EXIT;
  }
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
