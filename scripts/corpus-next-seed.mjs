#!/usr/bin/env node
// scripts/corpus-next-seed.mjs — resolve night N+1's seed from night N's published generation.
//
// ADR-086 step 18, verbatim: "Resolve the previous compatible, verified corpus generation at runtime
// as the next seed; retain the committed exact seed as bootstrap/recovery input. Do not commit a new
// pointer every night."
//
// So this NEVER writes to the repository. It reads the published release list, picks the newest
// corpus generation that is genuinely usable as a seed, and prints a descriptor for the preparation
// workflow to consume. When nothing published qualifies — first run, an incompatible runtime, an
// unsigned or half-uploaded release — it falls back to the committed data/corpus-seed.json, which is
// the bootstrap/recovery input and is content-addressed independently.
//
// "Compatible" means THIS RUNTIME CAN CONSUME THE SEED (ADR-0091 D4). It is NOT "the generation
// shipped the same runtime version as the approved pin": that rule rejected every generation the
// moment a code release moved the approved runtime, so the seed chain reset to the weeks-stale
// bootstrap on every release (ADR-0091 section 3.4). The runtime's executables never come from a
// seed anyway -- build-bundle.mjs copies runtime modules from the checkout and only named store
// files from the seed, and verifyApprovedRuntime's backward check still refuses any unpinned
// executable in the candidate. So --pin is gone from this script entirely. What CAN make a seed
// unusable is judged here, from small files, BEFORE the ~500 MB archive is ever fetched:
//   1. the receipt (schema 3, as before) records every store's embedding model and dimensions, and
//      they must equal what this runtime's forge build produces (kb/forge-corpus.mjs
//      FORGE_BUILD_FINGERPRINT) -- vectors from another model are not searchable by this one;
//   2. the generation's detached .recall.json must be the one its receipt binds, must have been
//      measured against THIS runtime's frozen fixture digest, and must pass THIS runtime's
//      readRecallReport -- the same reader and arguments corpus-seed.yml's downstream seed
//      re-check uses, so that re-check (which has no fallback) only ever sees a generation that
//      already passed here.
// "This runtime" is --runtime-root: the source tree whose readers will consume the seed. On the
// nightly that is the approved runtime's own sourceSha (ADR-0091 D3), which usually trails main.
// It defaults to this checkout, which is right whenever the checkout IS the build source.
//
// A generation that fails any check is SKIPPED with its reason, never a failure: the walk moves to
// the next older one. At most SEARCH_BOUND (5) generations are judged, so one bad format change can
// never turn into an unbounded walk of release history; after that the committed bootstrap is used.
//
// "Verified" is decided by evidence that is checkable without downloading 500 MB here: the tag must
// be the content-addressed corpus-sha256-<digest> form, the release must not be a draft, and it must
// carry exactly one of each of ruvnet-brain.zip, its detached .sig, corpus-receipt.json and both
// detached reports, with the receipt's own archive digest equal to the digest in the tag. The full
// byte-level proof still happens downstream where the archive is actually fetched (corpus-seed.yml
// re-checks sha256 and byte length before reconciliation, corpus-reconcile.mjs checks the ledger
// schema after extraction, and corpus-candidate.mjs re-derives the whole candidate from the bytes).
//
// ADR-0091 D6: --require-coverage is the CODE-RELEASE mode (ci.yml's release-qe and warm-brain jobs,
// and release.mjs's publish-time re-check). A code release assembles single-pass from the
// generation's sealed coverage, so a generation that did not publish its coverage sidecar
// (CORPUS-COVERAGE.json + coverage-receipt.json, D6.2) -- every generation published before D6 --
// is skipped as incompatible FOR THAT PURPOSE, with its reason. It remains a valid nightly seed:
// without the flag nothing about the nightly's selection changes.
//
// Usage:
//   node scripts/corpus-next-seed.mjs --repo owner/name [--runtime-root <source tree>]
//                                     [--bootstrap data/corpus-seed.json] [--require-coverage] [--out <file>]

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COVERAGE_ASSET, COVERAGE_RECEIPT_ASSET, bindCoverageToReceipt, verifyCoverageSidecar } from './corpus-coverage-sidecar.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[0-9a-f]{64}$/;
const CORPUS_TAG = /^corpus-sha256-([0-9a-f]{64})$/;
const ARCHIVE_ASSET = 'ruvnet-brain.zip';
const SIGNATURE_ASSET = 'ruvnet-brain.zip.sig';
const RECEIPT_ASSET = 'corpus-receipt.json';
const RECALL_ASSET = 'ruvnet-brain.zip.recall.json';
const ACCURACY_ASSET = 'ruvnet-brain.zip.accuracy.json';
// Every asset corpus-seed.yml requires of a digest-derived seed, plus the two judged here. A release
// missing one would pass this resolver and then fail the downstream step that has no fallback.
const REQUIRED_ASSETS = [ARCHIVE_ASSET, SIGNATURE_ASSET, RECEIPT_ASSET, RECALL_ASSET, ACCURACY_ASSET];
/** ADR-0091 D4: judge at most this many of the newest generations, then use the committed bootstrap. */
export const SEARCH_BOUND = 5;

const defaultRun = (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options });

function ghJson(run, args) {
  const result = run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    throw new Error(String(result.error?.message || result.stderr || result.stdout || `gh exited ${result.status}`).trim());
  }
  return JSON.parse(String(result.stdout || 'null'));
}

export function validateBootstrapSeed(seed) {
  const failures = [];
  if (!seed || typeof seed !== 'object') return ['committed bootstrap seed is not an object'];
  if (seed.schemaVersion !== 1) failures.push('committed bootstrap seed schemaVersion must be 1');
  if (!seed.tag || seed.tag === 'latest') failures.push('committed bootstrap seed tag is missing or forbidden');
  if (seed.asset !== ARCHIVE_ASSET) failures.push(`committed bootstrap seed asset must be ${ARCHIVE_ASSET}`);
  if (!HEX64.test(String(seed.sha256 || ''))) failures.push('committed bootstrap seed sha256 is malformed');
  if (!Number.isSafeInteger(seed.bytes) || seed.bytes < 1) failures.push('committed bootstrap seed bytes is malformed');
  return failures;
}

/** "forge-corpus-v1|Xenova/bge-base-en-v1.5@<rev>:768:cls" -> { model, dimensions }. */
export function parseBuildFingerprint(fingerprint) {
  const match = /\|([^@|]+)@[^:|]+:(\d+):[^|]*$/.exec(String(fingerprint || ''));
  if (!match) throw new Error(`cannot read the embedding model from FORGE_BUILD_FINGERPRINT (${fingerprint})`);
  return { model: match[1], dimensions: Number(match[2]) };
}

/**
 * What the consuming runtime expects of a seed, read from THAT runtime's own source tree -- never
 * restated here. A tree that cannot answer is a code defect, so this throws (a loud red night)
 * rather than quietly seeding from the bootstrap every night, which would look exactly like "no new
 * generation yet".
 */
export async function loadCompatibilityProfile({ runtimeRoot = ROOT, fixtureFile = null } = {}) {
  const root = path.resolve(runtimeRoot);
  const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
  const [recall, forge] = await Promise.all([load('scripts/oracle/repo-recall.mjs'), load('kb/forge-corpus.mjs')]);
  if (typeof recall.readRecallReport !== 'function' || typeof recall.loadFixture !== 'function') {
    throw new Error(`${root} has no repo-recall reader to judge a seed with`);
  }
  const { model, dimensions } = parseBuildFingerprint(forge.FORGE_BUILD_FINGERPRINT);
  const fixture = recall.loadFixture(fixtureFile || path.join(root, recall.DEFAULT_FIXTURE_FILE));
  return {
    runtimeRoot: root,
    model,
    dimensions,
    fixtureSha256: fixture.fixtureSha256,
    fixtureStores: fixture.questions.map((question) => question.store),
    floorValue: recall.ABSOLUTE_FLOOR,
    readRecallReport: recall.readRecallReport,
  };
}

function download(run, { repo, tag, pattern, dir }) {
  const result = run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', pattern, '--dir', dir],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const file = path.join(dir, pattern);
  return !result.error && result.status === 0 && fs.existsSync(file) ? file : null;
}

// Small files only (a receipt, a recall report): read whole.
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * One published release, judged. Returns null when it cannot serve as a seed, with the reason
 * recorded on `rejected` so a no-op night is explainable rather than silent. Never downloads the
 * archive: every check below reads the release's asset list, its receipt, or its recall report.
 */
function judgeRelease({ run, repo, tag, digest, profile, rejected, requireCoverage = false }) {
  // `indeterminate` marks a rejection that says nothing about the release itself -- the network or
  // `gh` failed. A publish-time re-check (ADR-0091 D6.6) must not read one as "no newer generation".
  const reject = (reason, { indeterminate = false, kind = null } = {}) => {
    rejected.push({ tag, reason, ...(indeterminate ? { indeterminate: true } : {}), ...(kind ? { kind } : {}) });
    return null;
  };
  let view;
  try {
    view = ghJson(run, ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,assets']);
  } catch (error) {
    return reject(`release view failed (${error.message})`, { indeterminate: true });
  }
  if (view?.tagName !== tag || view.isDraft) return reject('release is a draft or names another tag');
  const assets = Array.isArray(view.assets) ? view.assets : [];
  const named = (name) => assets.filter((asset) => asset?.name === name);
  for (const name of REQUIRED_ASSETS) {
    if (named(name).length !== 1) return reject(`unverified: expected exactly one ${name} asset`);
  }
  if (requireCoverage && [COVERAGE_ASSET, COVERAGE_RECEIPT_ASSET].some((name) => named(name).length !== 1)) {
    return reject(`incompatible for a code release: no coverage sidecar (${COVERAGE_ASSET} + ${COVERAGE_RECEIPT_ASSET}; `
      + 'published before ADR-0091 D6.2)');
  }
  const archive = named(ARCHIVE_ASSET)[0];
  if (!Number.isSafeInteger(archive.size) || archive.size < 1) return reject('unverified: archive asset has no usable byte length');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-next-seed-'));
  try {
    const receiptFile = download(run, { repo, tag, pattern: RECEIPT_ASSET, dir: scratch });
    if (!receiptFile) return reject('unverified: corpus receipt could not be downloaded', { indeterminate: true });
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
    catch (error) { return reject(`unverified: corpus receipt unreadable (${error.message})`); }

    // ADR-086 Step 15 / A6 moved the corpus receipt to schemaVersion 3 (it now binds the detached
    // retrieval-accuracy report). This reader has to move with it: left at 2 it would reject every
    // schema-3 generation as unverified and silently fall back to the committed bootstrap seed every
    // night — a degradation that looks exactly like "no new generation yet".
    if (receipt.schemaVersion !== 3 || receipt.kind !== 'ruvnet-brain-corpus-candidate') {
      return reject('unverified: receipt schema or kind is not a schema-3 corpus candidate');
    }
    if (!receipt.accuracyReport?.file || !HEX64.test(String(receipt.accuracyReport.sha256 || ''))
      || !Number.isSafeInteger(receipt.accuracyReport.bytes)) {
      return reject('unverified: receipt carries no retrieval-accuracy binding');
    }
    if (receipt.archive?.sha256 !== digest || receipt.archive?.bytes !== archive.size) {
      return reject('unverified: receipt archive identity disagrees with the content-addressed tag');
    }
    if (receipt.recallReport?.file !== RECALL_ASSET || !HEX64.test(String(receipt.recallReport?.sha256 || ''))
      || !Number.isSafeInteger(receipt.recallReport?.bytes)) {
      return reject('unverified: receipt carries no repo-recall binding');
    }

    // D4 check 1 -- embedding model and dimensions, per store, from the receipt alone.
    const stores = Array.isArray(receipt.stores) ? receipt.stores : [];
    if (!stores.length) return reject('unverified: receipt lists no stores');
    const foreign = stores.filter((row) => row?.model !== profile.model || row?.dimensions !== profile.dimensions);
    if (foreign.length) {
      const first = foreign[0];
      return reject(`incompatible: ${foreign.length} store(s) embedded with a different model/dimensions `
        + `(e.g. ${first?.name}: ${first?.model}/${first?.dimensions}); this runtime builds ${profile.model}/${profile.dimensions}`);
    }

    // D4 check 2 -- the recall report, the one small file that decides whether the downstream seed
    // re-check can pass. Downloaded only now, after the receipt already qualified.
    const recallFile = download(run, { repo, tag, pattern: RECALL_ASSET, dir: scratch });
    if (!recallFile) return reject('unverified: repo-recall report could not be downloaded', { indeterminate: true });
    if (sha256Of(recallFile) !== receipt.recallReport.sha256 || fs.statSync(recallFile).size !== receipt.recallReport.bytes) {
      return reject('unverified: repo-recall report is not the one the receipt binds');
    }
    let claimed = null;
    try { claimed = JSON.parse(fs.readFileSync(recallFile, 'utf8')); } catch { /* the reader names it below */ }
    const claimedFixture = claimed?.fixture?.sha256 ?? null;
    if (claimedFixture !== profile.fixtureSha256) {
      return reject(`incompatible: recall report was measured against fixture ${String(claimedFixture).slice(0, 12)}, `
        + `this runtime's frozen fixture is ${profile.fixtureSha256.slice(0, 12)}`);
    }
    // ADR-0091 D7.3: a report that claims retired questions is verified against the generation's own
    // sealed coverage (its D6.2 sidecar), recomputed by the reader -- in the nightly mode too, or one
    // retirement would push every night onto the bootstrap. No sidecar means the claim is unverifiable,
    // and the generation is skipped.
    const claimsRetirement = claimed?.retirement !== undefined;
    if (claimsRetirement && !requireCoverage && [COVERAGE_ASSET, COVERAGE_RECEIPT_ASSET].some((name) => named(name).length !== 1)) {
      return reject('incompatible: recall report claims retired question(s) but the generation published no coverage sidecar '
        + `(${COVERAGE_ASSET} + ${COVERAGE_RECEIPT_ASSET}) to verify them against`);
    }

    // D6.2 -- the code-release mode's extra check, from two more small files: the sidecar must name
    // THIS generation, bind THESE coverage bytes, and the coverage must describe this receipt's stores.
    let coverage = null;
    let coverageBytes = null;
    if (requireCoverage || claimsRetirement) {
      const sidecarFile = download(run, { repo, tag, pattern: COVERAGE_RECEIPT_ASSET, dir: scratch });
      const coverageFile = sidecarFile && download(run, { repo, tag, pattern: COVERAGE_ASSET, dir: scratch });
      if (!sidecarFile || !coverageFile) return reject('unverified: coverage sidecar could not be downloaded', { indeterminate: true });
      try {
        coverageBytes = fs.readFileSync(coverageFile);
        const verified = verifyCoverageSidecar({ sidecar: JSON.parse(fs.readFileSync(sidecarFile, 'utf8')), coverageBytes,
          generationTag: tag, archiveSha256: digest, archiveBytes: archive.size });
        bindCoverageToReceipt({ coverage: verified.coverage, receipt });
        coverage = { asset: COVERAGE_ASSET, sha256: sha256Of(coverageFile), bytes: coverageBytes.length,
          receiptAsset: COVERAGE_RECEIPT_ASSET, receiptSha256: sha256Of(sidecarFile), degraded: verified.degraded };
      } catch (error) {
        return reject(`unverified: coverage sidecar does not bind this generation (${error.message})`);
      }
      // A CODE release ships only an all-CURRENT corpus. Its install verification
      // (scripts/public-verification-aggregate.mjs) requires coverage.eligibleCurrent === eligibleTotal on
      // every lane, so a release assembled from a degraded generation could never become install-verified
      // and the nightly would stand down on it. The nightly seed may be degraded: the next night re-plans
      // the carried stores. Decided 2026-10-17 with the D10 removal.
      const degradedCount = coverage.degraded.carried.length + coverage.degraded.missing.length;
      if (requireCoverage && degradedCount > 0) {
        return reject(`incompatible for a code release: degraded generation (${coverage.degraded.carried.length} carried: `
          + `${coverage.degraded.carried.join(', ') || 'none'}; ${coverage.degraded.missing.length} missing: `
          + `${coverage.degraded.missing.join(', ') || 'none'}); install verification requires every eligible store CURRENT`,
        { kind: 'degraded' });
      }
    }

    try {
      profile.readRecallReport({
        reportFile: recallFile,
        archive: { file: ARCHIVE_ASSET, sha256: digest, bytes: archive.size },
        expectedFixtureSha256: profile.fixtureSha256,
        // The same bar corpus-seed.yml's seed re-check uses: a published seed is graded against the
        // fixed ABSOLUTE_FLOOR, never re-judged by a later, higher committed floor.
        floorValue: profile.floorValue,
        // Ignored by a pre-D7 reader, which then fails closed on a retirement-bearing report's totals.
        coverageBytes,
        ...(profile.fixtureStores ? { fixtureStores: profile.fixtureStores } : {}),
      });
    } catch (error) {
      return reject(`incompatible: recall report fails this runtime's reader (${error.message})`);
    }

    return {
      origin: 'published-generation',
      tag,
      asset: ARCHIVE_ASSET,
      sha256: digest,
      bytes: archive.size,
      // The nightly descriptor keeps its pre-D7 shape even when a retirement claim fetched the coverage.
      ...(coverage && requireCoverage ? { coverage } : {}),
      sourceCommit: typeof receipt.builderSourceSha === 'string' ? receipt.builderSourceSha : null,
      // Informational only since D4: the runtime that BUILT the seed, which may be older than the
      // runtime about to consume it. Nothing gates on it.
      brainVersion: receipt.archiveManifestVersion ?? null,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function resolveNextCorpusSeed({
  repo, run = defaultRun, root = ROOT, runtimeRoot = null, fixtureFile = null, bootstrapFile,
  limit = 100, searchBound = SEARCH_BOUND, profile = null, requireCoverage = false,
} = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo || ''))) throw new Error('--repo must be owner/name');
  if (!Number.isSafeInteger(searchBound) || searchBound < 1) throw new Error('search bound must be a positive integer');

  const bootstrapPath = path.resolve(bootstrapFile || path.join(root, 'data/corpus-seed.json'));
  const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
  const bootstrapFailures = validateBootstrapSeed(bootstrap);
  if (bootstrapFailures.length) throw new Error(`committed bootstrap seed is invalid: ${bootstrapFailures.join('; ')}`);

  const compatibility = profile || await loadCompatibilityProfile({ runtimeRoot: runtimeRoot || root, fixtureFile });

  const rejected = [];
  let listed = [];
  try {
    listed = ghJson(run, ['release', 'list', '--repo', repo, '--limit', String(limit), '--json', 'tagName,isDraft,isPrerelease,createdAt']) || [];
  } catch (error) {
    rejected.push({ tag: null, reason: `release list failed (${error.message})`, indeterminate: true });
  }

  // Every corpus-shaped tag that is NOT usable gets an explicit reason. A silently skipped row is
  // indistinguishable from "there were none", and this project has already paid for one diagnostic
  // that reported a defect nobody read — a skip nobody can see is worse.
  const corpusShaped = (Array.isArray(listed) ? listed : [])
    .filter((row) => row && CORPUS_TAG.test(String(row.tagName || '')));
  const candidates = [];
  for (const row of corpusShaped) {
    if (row.isDraft) { rejected.push({ tag: row.tagName, reason: 'unverified: release is still a draft' }); continue; }
    // A corpus generation is STAGED as a prerelease and PROMOTED (prerelease flag cleared) only after the
    // customer canary applied it (protected-release.yml corpus-canary -> corpus-promote). A generation
    // still a prerelease was refused by that canary, superseded, or is mid-flight: no customer received
    // it, so no night and no code release may build on it (reviewer finding, 2026-10-17). The committed
    // bootstrap is a code-release tag, never corpus-shaped, so this never touches it.
    if (row.isPrerelease) { rejected.push({ tag: row.tagName, reason: 'unpromoted: still a prerelease (the customer canary never promoted it); not a seed' }); continue; }
    const createdAt = Date.parse(row.createdAt);
    if (!Number.isFinite(createdAt)) { rejected.push({ tag: row.tagName, reason: 'unverified: release has no readable publication time' }); continue; }
    candidates.push({ tag: row.tagName, digest: CORPUS_TAG.exec(row.tagName)[1], createdAt });
  }
  candidates.sort((left, right) => right.createdAt - left.createdAt);

  const expects = { model: compatibility.model, dimensions: compatibility.dimensions, fixtureSha256: compatibility.fixtureSha256 };
  // The bound counts generations JUDGED incompatible or unverifiable (ADR-0091 D4: one bad format change can
  // cost at most SEARCH_BOUND downloads). In code-release mode a DEGRADED promoted generation is skipped
  // without consuming it: a carried store is a transient state the next night re-plans, and if each such
  // night used up the bound, SEARCH_BOUND degraded nights in a row would walk every code release back to the
  // committed bootstrap (a pre-ADR-0091 corpus) with nothing paging (reviewer finding, 2026-10-17). The
  // release listing (`--limit`) remains the absolute cap on the walk.
  let judged = 0;
  let skippedDegraded = 0;
  for (const candidate of candidates) {
    if (judged >= searchBound) {
      rejected.push({ tag: candidate.tag, reason: `not judged: older than the ${searchBound} newest generations (ADR-0091 D4 search bound)` });
      continue;
    }
    const resolved = judgeRelease({ run, repo, tag: candidate.tag, digest: candidate.digest, profile: compatibility, rejected,
      requireCoverage });
    if (resolved) return { seed: resolved, rejected, judged: judged + 1, skippedDegraded, expects };
    if (requireCoverage && rejected[rejected.length - 1]?.tag === candidate.tag && rejected[rejected.length - 1]?.kind === 'degraded') {
      skippedDegraded += 1;
    } else judged += 1;
  }

  return {
    seed: {
      origin: 'committed-bootstrap',
      tag: bootstrap.tag,
      asset: bootstrap.asset,
      sha256: String(bootstrap.sha256).toLowerCase(),
      bytes: bootstrap.bytes,
      sourceCommit: typeof bootstrap.sourceCommit === 'string' ? bootstrap.sourceCommit : null,
      brainVersion: null,
    },
    rejected,
    judged,
    skippedDegraded,
    expects,
  };
}

const arg = (argv, name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

export async function main(argv = process.argv.slice(2), { run = defaultRun, stdout = process.stdout, stderr = process.stderr } = {}) {
  // Loud, not ignored: a caller still passing --pin is on the pre-D4 contract and should be told.
  if (argv.includes('--pin')) {
    stderr.write('[corpus-next-seed] --pin was removed by ADR-0091 D4: seed selection no longer depends on the approved runtime pin\n');
    return 2;
  }
  let result;
  try {
    result = await resolveNextCorpusSeed({
      repo: arg(argv, '--repo', process.env.GITHUB_REPOSITORY),
      runtimeRoot: arg(argv, '--runtime-root', null),
      fixtureFile: arg(argv, '--fixture', null),
      bootstrapFile: arg(argv, '--bootstrap', null),
      requireCoverage: argv.includes('--require-coverage'),
      run,
    });
  } catch (error) {
    stderr.write(`[corpus-next-seed] ${error.message}\n`);
    return 1;
  }
  for (const row of result.rejected) stderr.write(`[corpus-next-seed] skipped ${row.tag || '(list)'}: ${row.reason}\n`);
  const out = arg(argv, '--out', null);
  const serialized = `${JSON.stringify(result.seed, null, 2)}\n`;
  if (out) fs.writeFileSync(path.resolve(out), serialized);
  stdout.write(serialized);
  stderr.write(`[corpus-next-seed] ${result.seed.origin} ${result.seed.tag} (judged ${result.judged} generation(s) against `
    + `${result.expects.model}/${result.expects.dimensions}, fixture ${result.expects.fixtureSha256.slice(0, 12)})\n`);
  return 0;
}

// REALPATH BOTH SIDES (ADR-0091 D12.2, applied here because this file is rewritten anyway): a plain
// argv[1]-vs-import.meta.url comparison is false under a symlinked path such as macOS's /var/folders
// temp directories, and the CLI then exits 0 having done nothing.
function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[corpus-next-seed] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
