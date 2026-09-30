#!/usr/bin/env node
// scripts/release.mjs — the ONLY publisher, plus a local preview of the CI qualification gate.
//
// WHY (2026-07-17, Stuart): "You should be able to take the applied knowledge and build it into a set
// of criteria that you always use, not a bunch of suggestions you choose to ignore." Every failure
// this session was an ASSUMPTION that survived because the check was a suggestion, not a gate. This
// script turns the checklist into a gate: it runs the criteria in order and STOPS on the first
// failure. There is no "I think it's fine" — there is pass or fail.
//
// WHAT EACH MODE ACTUALLY DOES (rewritten 2026-09-26, consolidation/single-source — the previous
// header called check-only "the DEFINITION OF DONE" and claimed it alone decided "shipped"; that was
// never true and duplicated a second, drifting gate list alongside CI's real one). Publishing a
// release — creating the GitHub Release, moving the npm dist-tag — happens ONLY inside the
// reviewer-protected `protected-release.yml` workflow, against an exact-SHA CI-sealed candidate;
// `--publish` mode is that workflow's publisher (it validates the protected-invocation receipt before
// doing anything and refuses outside it), never rebuilds or retests source, and treats the immutable
// artifact as the evidence boundary. `--check` mode is a read-only LOCAL PREVIEW for a human on a dev
// branch: it runs the exact same release-qualification gate CI enforces
// (`scripts/release-qualification.mjs` + `scripts/release-qualification-contract.mjs`, invoked the
// same way `canonical-qa.yml`/`ci.yml` invoke it) plus the one-publisher check
// (`scripts/release-authority.mjs`). There is exactly ONE definition of "release-qualified" — the one
// CI enforces — and this is a preview of it, not a second, independent one.
//
// Usage:
//   node scripts/release.mjs --check          # preview the SAME qualification gate CI enforces
//   node scripts/release.mjs --publish        # the protected workflow's publisher; not for manual use
//   node scripts/release.mjs                   # same as --check
//
// The gates, in order (fail fast):
//   A. version single-source-of-truth agrees (sync-version --check) + one protected publisher
//   B. release qualification — scripts/release-qualification.mjs, invoked exactly as CI invokes it
//   D. [--publish only] stage and promote the exact package plus signed RVF bundle

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateProtectedPublishEnvironment, validateProtectedPublishInvocation } from './protected-release-invocation.mjs';
import { runReleaseTransaction } from './release-transaction.mjs';
import { materializePublicationHandoff, resolvePublicationHandoffPaths } from './release-publication-handoff.mjs';
import { liveReleaseProvider } from './release-transaction-provider.mjs';
import { stagedHostVerifier } from './staged-host-verifier.mjs';
import { verifyPayload } from './release-payload.mjs';
import { verifyCorpusReceipt } from './corpus-candidate.mjs';
import { readDiagnosticAccuracyReport } from './oracle/retrieval-accuracy.mjs';
import { loadFixture, readRecallReport } from './oracle/repo-recall.mjs';

/**
 * The measured retrieval numbers, stated in the release notes themselves rather than left behind a
 * digest. Both halves go in together on purpose: the number that qualified the release, and the one
 * it did NOT meet. A reader who sees only the first would reasonably assume the second was fine.
 */
const recallNotes = (receipt) => {
  const r = receipt.recallSummary;
  if (!r) return [];
  return [
    `Retrieval (blocking): ${r.repositoriesAnswering}/${r.questions} repositories answer a real question`
      + ` about themselves from their own content; ${r.exactFileTop5}/${r.questions} return the exact`
      + ` labeled file in the top 5 (floor ${r.floor}).`,
    'NOT measured: generated-answer correctness, citation support, or unscoped whole-corpus discovery.',
    `ADR-086 C3 was NOT met and is NOT claimed — its diagnostic measurement (a declared question sample`
      + ` when its coverage.bounded says so) ships as ${receipt.accuracyReport.file} for inspection.`,
  ];
};
import { verifyBundle } from './verify-bundle.mjs';
import {
  CORPUS_GENERATION_FIELD, CORPUS_TAG_PATTERN, evaluateCanaryVerdict, evaluateCorpusPromotion, parseCorpusGeneration,
} from './corpus-promotion.mjs';
import { bindCoverageToReceipt, writeCoverageAssets } from './corpus-coverage-sidecar.mjs';
import { degradedPublication } from './corpus-store-failure.mjs';
import { assertNoNewerCorpusGeneration } from './code-release-corpus.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLISH = process.argv.includes('--publish');
const CORPUS_SEED = process.argv.includes('--corpus-seed');
let protectedCandidate = null;
let sealedPackageArtifact = null;
let publicationReceiptPath = null;
let protectedReleaseMode = 'strict';
let verifiedPayload = null;
let aggregateEnvelope = null;
let publicationHandoffPaths = null;
const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };
const V = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')).version;

function step(n, label) { process.stdout.write(`\n${c.b('▸ ' + n)} ${label}\n`); }
function runOrDie(label, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.error || r.status !== 0) {
    console.error(`\n${c.r('✗ GATE FAILED: ' + label)} ${c.dim('(' + cmd + ' ' + args.join(' ') + ' → ' + (r.error ? r.error.message : 'exit ' + r.status) + ')')}`);
    console.error(`${c.r('  NOT shipped. Fix this, then re-run. No assumptions past a red gate.')}\n`);
    process.exit(1);
  }
}

const cliArg = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const isHex = (value, length) => new RegExp(`^[a-f0-9]{${length}}$`).test(String(value || ''));
const sha256File = (file) => {
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
};
const exactFileIdentity = (value) => value && typeof value.file === 'string'
  && isHex(value.sha256, 64) && Number.isSafeInteger(value.bytes) && value.bytes >= 0;

function corpusFailure(message) {
  throw new Error(`[corpus-seed] ${message}`);
}

/**
 * A newer code release was published after this corpus was built at its approved runtime. Promoting
 * it now would put an OLDER runtime on releases/latest over a newer live code release (fresh installs
 * then fail on a version mismatch). That is not a broken night -- the next night builds at the newer
 * runtime -- so it is a distinct, typed outcome: exit CORPUS_SUPERSEDED_EXIT, recorded as `superseded`.
 */
export const CORPUS_SUPERSEDED_EXIT = 4;
export class CorpusSuperseded extends Error {
  constructor(message) {
    super(`[corpus-seed] superseded: ${message}`);
    this.name = 'CorpusSuperseded';
    this.code = 'CORPUS_SUPERSEDED';
  }
}

const CODE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const compareCodeTags = (left, right) => {
  const a = CODE_TAG.exec(left).slice(1).map(Number);
  const b = CODE_TAG.exec(right).slice(1).map(Number);
  return Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
};

/** The one gh seam both corpus entry points use (RUVNET_GH_COMMAND / RUVNET_GH_SCRIPT for tests). */
function corpusGh(env, run) {
  const ghCommand = env.RUVNET_GH_COMMAND || 'gh';
  const ghPrefix = env.RUVNET_GH_SCRIPT ? [env.RUVNET_GH_SCRIPT] : [];
  const gh = (args) => run(ghCommand, [...ghPrefix, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ghJson = (args, label) => {
    const result = gh(args);
    if (result.error || result.status !== 0) {
      corpusFailure(`cannot read ${label} (${String(result.error?.message || result.stderr || result.stdout || '').trim() || `gh exited ${result.status}`})`);
    }
    try { return JSON.parse(String(result.stdout || 'null')); }
    catch (error) { corpusFailure(`cannot parse ${label} (${error.message})`); }
  };
  return { gh, ghJson };
}

/**
 * PUBLISH-TIME RE-RESOLVE, before anything is written. Preparation takes hours and the customer canary
 * adds more; a code release may have been published meanwhile. The newest code release is selected
 * exactly as scripts/approved-runtime.mjs selects it (non-draft, non-prerelease vX.Y.Z, highest).
 */
function assertApprovedRuntimeIsNewest({ ghJson, repo, approvedTag, target }) {
  const listed = ghJson(['release', 'list', '--repo', repo, '--limit', '200', '--json', 'tagName,isDraft,isPrerelease'], 'the code release list');
  const [newest] = (Array.isArray(listed) ? listed : [])
    .filter((row) => !row?.isDraft && !row?.isPrerelease && CODE_TAG.test(String(row?.tagName || '')))
    .map((row) => row.tagName).sort((a, b) => compareCodeTags(b, a));
  if (!newest) corpusFailure(`no published code release is listed on ${repo}; the approved runtime ${approvedTag} cannot be confirmed`);
  const order = compareCodeTags(newest, approvedTag);
  if (order > 0) {
    throw new CorpusSuperseded(`code release ${newest} was published after this corpus was built at ${approvedTag}; `
      + 'promoting it would put an older runtime over the live code release. The next night builds at the newer runtime.');
  }
  if (order < 0) corpusFailure(`approved runtime ${approvedTag} is newer than every published code release (newest ${newest})`);
  const commit = ghJson(['api', `repos/${repo}/commits/${approvedTag}`], `the commit of ${approvedTag}`);
  if (String(commit?.sha || '').toLowerCase() !== target) {
    corpusFailure(`target ${target} is not the source of the approved runtime ${approvedTag} (${commit?.sha || 'unknown'})`);
  }
}

/** What releases/latest is right now, or null when the repository has none. */
function readCurrentLatest(gh, repo) {
  const latestView = gh(['release', 'view', '--json', 'tagName,body', '--repo', repo]);
  if (!latestView.error && latestView.status === 0) {
    let currentLatest;
    try { currentLatest = JSON.parse(String(latestView.stdout || 'null')); }
    catch (error) { corpusFailure(`cannot read the current latest release (${error.message})`); }
    if (!currentLatest || typeof currentLatest.tagName !== 'string') corpusFailure('current latest release carries no tag name');
    return currentLatest;
  }
  const latestError = String(latestView.error?.message || latestView.stderr || latestView.stdout || '');
  if (!/(release not found|no release found)/i.test(latestError)) {
    corpusFailure(`cannot determine the current latest release (${latestError.trim() || `gh exited ${latestView.status}`})`);
  }
  return null;
}

function latestTagNow(gh, repo) {
  const latestNow = gh(['api', `repos/${repo}/releases/latest`]);
  if (latestNow.error || latestNow.status !== 0) return null;
  try { return JSON.parse(String(latestNow.stdout || 'null'))?.tag_name ?? null; } catch { return null; }
}

export async function runProtectedCorpusSeed({
  argv = process.argv.slice(2),
  env = process.env,
  root = ROOT,
  run = (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options }),
} = {}) {
  const environmentFailures = validateProtectedPublishEnvironment(env);
  if (environmentFailures.length) {
    corpusFailure(environmentFailures.join('; '));
  }

  // The corpus route may never enter product publication. This is belt to the workflow's braces: the
  // corpus job binds an environment that holds no NPM_TOKEN at all, so npm is unreachable from it by
  // construction; this refuses the combined invocation outright so the two modes can never share one
  // process even if a future workflow edit put them in the same job.
  if (argv.includes('--publish')) corpusFailure('--corpus-seed cannot be combined with --publish; corpus routing must never enter product publication');
  // THE PRODUCER CANNOT DECLARE SUCCESS UNLESS THE CONSUMER ACCEPTED (customer canary). There is no
  // longer any single invocation that both publishes a corpus and moves releases/latest: a customer
  // candidate is STAGED (--stage-candidate: a signed, public, non-latest prerelease), a clean customer
  // install applies it (scripts/corpus-canary.mjs), and only --promote-staged with that verdict moves
  // latest. The old one-shot flag is refused outright so no stale workflow text can bypass the canary.
  if (argv.includes('--promote-latest')) {
    corpusFailure('--promote-latest was removed: stage with --stage-candidate, then promote with --promote-staged and the customer canary verdict');
  }
  const customerCandidate = argv.includes('--stage-candidate');

  const tag = cliArg(argv, '--corpus-tag');
  const bundleFile = cliArg(argv, '--corpus-bundle');
  const receiptFile = cliArg(argv, '--corpus-receipt');
  // ADR-0091 D6.2: the generation's sealed coverage (the prepared artifact's source-coverage.json).
  const coverageFile = cliArg(argv, '--corpus-coverage');
  const target = cliArg(argv, '--target');
  const repo = cliArg(argv, '--repo') || env.GITHUB_REPOSITORY;
  const digestMatch = String(tag || '').match(/^corpus-sha256-([a-f0-9]{64})$/);
  if (!digestMatch) corpusFailure('corpus tag must be corpus-sha256- followed by 64 lowercase hex characters');
  if (repo !== env.GITHUB_REPOSITORY || repo !== 'stuinfla/ruvnet-brain') corpusFailure('repository does not match the protected workflow');

  for (const [label, file] of [['bundle', bundleFile], ['receipt', receiptFile], ['coverage', coverageFile]]) {
    if (!file || !path.isAbsolute(file)) corpusFailure(`${label} must be an absolute regular file`);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) corpusFailure(`${label} must be an absolute regular file`);
    } catch (error) {
      if (String(error.message).startsWith('[corpus-seed]')) throw error;
      corpusFailure(`${label} must be an absolute regular file (${error.message})`);
    }
  }

  const headResult = run('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (headResult.error || headResult.status !== 0) corpusFailure('cannot resolve release HEAD');
  const head = String(headResult.stdout || '').trim();

  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  } catch (error) {
    corpusFailure(`corpus receipt is unreadable/corrupt (${error.message})`);
  }
  // DECOUPLED FROM main HEAD (2026-09-29 nightly redesign). The corpus is built at the APPROVED
  // runtime -- the newest code release with a verified install aggregate -- whose source is on main's
  // history but is usually NOT main HEAD. The old rule (target === GITHUB_SHA) stood the nightly down
  // whenever main was ahead of the newest verified release. The guard that rule was protecting
  // (independent review of ADR-0091 D3: never promote an OLDER runtime over the live code release)
  // is now enforced directly: target must be the checkout, the receipt's builder, an ancestor of this
  // protected run's GITHUB_SHA, and -- for a customer promotion -- the commit of --approved-tag, which
  // must still be the NEWEST code release at publish time (below; otherwise CorpusSuperseded).
  // Format checks run first; no value reaches a subprocess unvalidated.
  if (!isHex(target, 40) || target !== head || target !== receipt.builderSourceSha || !isHex(env.GITHUB_SHA, 40)) {
    corpusFailure('target must exactly equal HEAD and the corpus receipt builderSourceSha (and GITHUB_SHA must be a commit)');
  }
  const ancestry = run('git', ['merge-base', '--is-ancestor', target, env.GITHUB_SHA], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (ancestry.error || ancestry.status !== 0) corpusFailure(`target ${target} is not an ancestor of this run's GITHUB_SHA ${env.GITHUB_SHA}`);
  const approvedTag = cliArg(argv, '--approved-tag');
  if (customerCandidate) {
    if (!CODE_TAG.test(String(approvedTag || ''))) corpusFailure('customer promotion requires --approved-tag vX.Y.Z (the approved runtime this corpus was built at)');
    if (receipt.archiveManifestReleaseTag !== approvedTag) {
      corpusFailure(`the archive ships runtime ${receipt.archiveManifestReleaseTag}, not the approved runtime ${approvedTag}`);
    }
  }

  // Schema 3 (ADR-086 Step 15 / A6): the receipt binds the full provenance closure shipped INSIDE
  // the sealed archive (ARCHIVE-MANIFEST.json, PRIVATE-STORES.json, RVF-GENERATIONS.json,
  // SOURCE.json) AND the detached, digest-bound retrieval-accuracy report that measured this exact
  // archive. Schema 2 is refused outright: a schema-2 seed carries no accuracy binding, so it is
  // UNPUBLISHABLE from here forward and data/corpus-seed.json must be re-pointed at a schema-3 seed
  // in the same change that publishes one.
  const boundaryIdentities = [receipt.privateFence, receipt.generationLedger, receipt.sourceManifest, receipt.archiveManifest];
  const storeBindingsValid = Number.isSafeInteger(receipt.storeCount) && receipt.storeCount > 0
    && Array.isArray(receipt.stores) && receipt.stores.length === receipt.storeCount
    && receipt.stores.every((store) => typeof store?.name === 'string' && store.name.length > 0
      && ['repository', 'gist-aggregate', 'derived'].includes(store.kind)
      && (store.kind === 'repository'
        ? /^[a-f0-9]{7,64}$/.test(String(store.sourceCommit || ''))
        : store.sourceCommit === null || /^[a-f0-9]{7,64}$/i.test(String(store.sourceCommit || '')))
      && typeof store.builtUtc === 'string' && Number.isFinite(Date.parse(store.builtUtc))
      && typeof store.model === 'string' && store.model.length > 0
      && Number.isSafeInteger(store.dimensions) && store.dimensions > 0
      && Array.isArray(store.files) && store.files.length > 0 && store.files.every(exactFileIdentity));
  const emptyFailureArrays = ['duplicateRvfDigests', 'unreceiptedRvfFiles', 'missingSidecars']
    .every((key) => Array.isArray(receipt[key]) && receipt[key].length === 0);
  const privateExclusionsValid = Array.isArray(receipt.excludedPrivateStores)
    && receipt.excludedPrivateStores.every((name) => typeof name === 'string' && name.length > 0);
  const generatorFile = path.join(root, 'scripts/corpus-candidate.mjs');
  const generatorValid = fs.existsSync(generatorFile)
    && receipt.generator?.corpusCandidateSha256 === sha256File(generatorFile);
  if (receipt.schemaVersion !== 3 || receipt.kind !== 'ruvnet-brain-corpus-candidate'
    || !receipt.createdAt || !storeBindingsValid || !emptyFailureArrays
    || !privateExclusionsValid || !boundaryIdentities.every(exactFileIdentity) || !exactFileIdentity(receipt.archive)
    || !exactFileIdentity(receipt.accuracyReport)
    || !generatorValid
    || receipt.archive.file !== path.basename(bundleFile)) {
    corpusFailure('corpus receipt bindings are incomplete or invalid');
  }

  const archiveSha256 = sha256File(bundleFile);
  if (archiveSha256 !== receipt.archive.sha256 || fs.statSync(bundleFile).size !== receipt.archive.bytes) {
    corpusFailure('archive bytes do not match the corpus receipt');
  }
  if (digestMatch[1] !== archiveSha256) corpusFailure('corpus tag digest does not match the receipt and archive');

  // ADR-086 Step 15's second binding. The detached accuracy report travels beside the archive; this
  // proves (a) the file the receipt names is the file present here, byte for byte, (b) the report
  // was measured against THESE archive bytes, and (c) it was produced by the committed benchmark
  // against the committed oracle — so a swapped oracle or a patched benchmark is caught here even
  // though the receipt itself carries only {file, sha256, bytes}. It does NOT check the score or
  // coverage completeness: C3 is a diagnostic (ADR-086 amendment 2026-09-15), and the corpus
  // pipeline measures a declared question sample of it (ADR-0091 D2).
  const accuracyReportFile = `${bundleFile}.accuracy.json`;
  if (receipt.accuracyReport.file !== path.basename(accuracyReportFile)) {
    corpusFailure('corpus receipt names an accuracy report that is not the one beside this archive');
  }
  if (!fs.existsSync(accuracyReportFile) || !fs.statSync(accuracyReportFile).isFile()) {
    corpusFailure(`detached retrieval-accuracy report missing beside the archive (${path.basename(accuracyReportFile)})`);
  }
  if (sha256File(accuracyReportFile) !== receipt.accuracyReport.sha256
    || fs.statSync(accuracyReportFile).size !== receipt.accuracyReport.bytes) {
    corpusFailure('detached retrieval-accuracy report bytes do not match the corpus receipt');
  }
  const committedOracleFile = path.join(root, 'data/retrieval-accuracy-oracle.json');
  const accuracyGeneratorFile = path.join(root, 'scripts/oracle/retrieval-accuracy.mjs');
  if (!fs.existsSync(committedOracleFile)) corpusFailure('committed retrieval-accuracy oracle is missing from the release checkout');
  if (!fs.existsSync(accuracyGeneratorFile)) corpusFailure('committed retrieval-accuracy benchmark is missing from the release checkout');
  // The BLOCKING retrieval predicate at publication is the frozen-fixture repo-recall gate, read
  // through the same module candidate acceptance used so the two can never drift apart. ADR-086's
  // C3 report still has to exist and still has to be bound to these exact archive bytes — an
  // unbound diagnostic looks like evidence and is worse than none — but its score no longer refuses
  // publication. That reduction is declared in docs/adr/0086 and in the published report itself.
  const archiveIdentity = { file: receipt.archive.file, sha256: archiveSha256, bytes: fs.statSync(bundleFile).size };
  try {
    readDiagnosticAccuracyReport({
      reportFile: accuracyReportFile,
      archive: archiveIdentity,
      expectedOracleSha256: sha256File(committedOracleFile),
      expectedGeneratorSha256: sha256File(accuracyGeneratorFile),
    });
  } catch (error) {
    corpusFailure(`the published C3 diagnostic is not bound to this archive (${error.message})`);
  }
  const recallReportFile = `${bundleFile}.recall.json`;
  if (!fs.existsSync(recallReportFile)) {
    corpusFailure(`detached repo-recall report missing beside the archive (${path.basename(recallReportFile)})`);
  }
  if (!receipt.recallReport
    || sha256File(recallReportFile) !== receipt.recallReport.sha256
    || fs.statSync(recallReportFile).size !== receipt.recallReport.bytes) {
    corpusFailure('detached repo-recall report bytes do not match the corpus receipt');
  }
  // ADR-0091 D7.3: a claimed retirement is recomputed from THIS generation's sealed coverage (the bytes
  // published beside the archive as CORPUS-COVERAGE.json), never taken from the report's own claim.
  const recallFixture = loadFixture();
  try {
    readRecallReport({
      reportFile: recallReportFile,
      archive: archiveIdentity,
      expectedFixtureSha256: recallFixture.fixtureSha256,
      coverageBytes: fs.readFileSync(coverageFile),
      fixtureStores: recallFixture.questions.map((question) => question.store),
    });
  } catch (error) {
    corpusFailure(`retrieval does not qualify this corpus for publication (${error.message})`);
  }

  // Deep re-verification — moved here 2026-09-13 from the deleted scripts/corpus-seed-publish.mjs
  // (ADR-085). Everything above proves the receipt is well-FORMED and that the archive's outer
  // digest matches it; none of it proves the receipt is TRUE. verifyCorpusReceipt re-extracts the
  // sealed archive and re-derives the entire candidate from its own bytes — per-store file digests,
  // private-store fence, generation ledger, RVF index audit — and requires canonical equality with
  // the receipt. A receipt with a single forged store digest passes every check above and fails
  // here. It runs before any `gh` call so an untrue candidate never reaches the network.
  try {
    await verifyCorpusReceipt({
      receiptFile, bundleFile, accuracyReportFile, recallReportFile, coverageFile, expectedBuilderSha: target, expectedArchiveSha256: archiveSha256,
    });
  } catch (error) {
    corpusFailure(`corpus receipt does not verify against the sealed archive (${error.message})`);
  }

  // ADR-0091 D6.2 + D10. The archive carries no coverage and the schema-3 receipt binds none, so this
  // is the one place the publisher can SEE whether the generation is degraded. The coverage must be
  // the coverage of THIS archive (bound store by store to the receipt), it is published beside the
  // archive as CORPUS-COVERAGE.json + coverage-receipt.json (no receipt schema bump), and a
  // generation with any carried or missing store is refused while D10 has recorded no soaked
  // tolerant-validator transition -- installed clients would reject it. Local, before any network.
  let coverageAssets;
  try {
    coverageAssets = writeCoverageAssets({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-coverage-assets-')),
      coverageFile, generationTag: tag, archiveSha256, archiveBytes: archiveIdentity.bytes,
    });
    const degraded = bindCoverageToReceipt({
      coverage: JSON.parse(fs.readFileSync(coverageAssets.coverageFile, 'utf8')), receipt,
    });
    if (degraded.carried.length + degraded.missing.length > 0) {
      const decision = degradedPublication();
      if (!decision.allowed) {
        corpusFailure(`degraded generation (${degraded.carried.length} carried, ${degraded.missing.length} missing) `
          + `must not be published: ${decision.reason}`);
      }
    }
  } catch (error) {
    if (String(error.message).startsWith('[corpus-seed]')) throw error;
    corpusFailure(`the generation's sealed coverage does not bind this archive (${error.message})`);
  }

  // EVERY local proof happens before the first network call. `gh` must never be reached by a
  // candidate that is already known to be unpublishable — that is the same discipline the deep
  // verifyCorpusReceipt above follows, and a customer release with an unusable signature is exactly
  // as unpublishable as an untrue receipt.
  const signatureFile = `${bundleFile}.sig`;
  const digestFile = `${bundleFile}.sha256`;
  const generation = String(receipt.createdAt || '');
  if (customerCandidate) {
    for (const [label, file] of [['detached signature', signatureFile], ['sha256 sidecar', digestFile]]) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        corpusFailure(`customer corpus promotion requires a ${label} beside the archive (${path.basename(file)} missing) — the updater fails closed without it`);
      }
    }
    // The real verifier, against the trust root that ships inside the npm package. Signing happens in
    // the workflow with the environment-scoped key; this proves the bytes about to be published
    // verify with the key kb/forge-update.mjs actually carries.
    const signature = verifyBundle(bundleFile, signatureFile);
    if (!signature.ok) corpusFailure(`detached signature does not verify against the shipped trust root (${signature.reason})`);
    if (!Number.isFinite(Date.parse(generation))) corpusFailure('corpus receipt createdAt is not a readable generation timestamp');
  }

  const { gh, ghJson } = corpusGh(env, run);

  // Its signed install aggregate was re-verified for --approved-tag by the workflow step that built the
  // runtime pin moments ago; what can change after that is only WHICH release is newest.
  if (customerCandidate) assertApprovedRuntimeIsNewest({ ghJson, repo, approvedTag, target });

  const viewArgs = ['release', 'view', tag, '--json', 'tagName', '--repo', repo];
  const view = gh(viewArgs);
  if (!view.error && view.status === 0) corpusFailure(`release ${tag} already exists; refusing to overwrite immutable corpus seed`);
  const viewError = String(view.error?.message || view.stderr || view.stdout || '');
  if (!/(release not found|no release found)/i.test(viewError)) corpusFailure(`cannot prove ${tag} is absent (${viewError.trim() || `gh exited ${view.status}`})`);

  const receiptSha256 = sha256File(receiptFile);

  if (!customerCandidate) {
    // BOOTSTRAP/RECOVERY seeds stay exactly as ADR-086's original contract left them: an immutable
    // prerelease that never touches releases/latest. Dual's C4 resolution (S1) narrows the change to
    // CUSTOMER releases — "Bootstrap-only releases may remain prereleases."
    const notes = [
      'Content-addressed RuvNet Brain corpus seed.',
      `Archive SHA-256: ${archiveSha256}`,
      `Receipt SHA-256: ${receiptSha256}`,
      `Accuracy report SHA-256: ${receipt.accuracyReport.sha256}`,
      `Recall report SHA-256: ${receipt.recallReport.sha256}`,
      ...recallNotes(receipt),
      `Stores: ${receipt.storeCount}`,
      `Builder source SHA: ${receipt.builderSourceSha}`,
      'This published prerelease is immutable and must never be replaced.',
    ].join('\n');
    // The detached accuracy report ships AS AN ASSET. Without it a downloader holds an archive it
    // cannot re-verify — "reverify the downloaded final artifact against the measured identity"
    // requires the measurement to travel with the artifact it measured.
    const createArgs = [
      'release', 'create', tag,
      '--prerelease', '--latest=false',
      '--target', target,
      '--repo', repo,
      '--title', `Immutable corpus seed ${archiveSha256.slice(0, 16)}`,
      '--notes', notes,
      bundleFile, receiptFile, accuracyReportFile, recallReportFile,
      coverageAssets.coverageFile, coverageAssets.receiptFile,
    ];
    const create = gh(createArgs);
    if (create.error || create.status !== 0) {
      corpusFailure(`protected corpus publication failed (${String(create.error?.message || create.stderr || create.stdout || '').trim()})`);
    }
    return { tag, target, repository: repo, archiveSha256, receiptSha256, promoted: false };
  }

  // ── CUSTOMER CORPUS RELEASE (ADR-086 step 17 / C4 resolution S1) ───────────────────────────────
  // The old path was invisible AND unusable to a customer, for two independent reasons, and fixing
  // only one leaves the channel dead. `--prerelease --latest=false` means kb/forge-update.mjs's
  // releases/latest poll never sees it; and with no detached .sig the updater fails closed anyway
  // (kb/forge-update.mjs:1275 fetches `${url}.sig`, :1284-1285 exits 4 when verification fails).
  // scripts/verify-channels.mjs checks exactly these two things (checks 3 and 4) against the live
  // endpoints, and is the owner's post-publish acceptance gate.
  //
  // STAGED, NOT PROMOTED (customer canary). This path ends with a signed, public PRERELEASE that
  // releases/latest cannot resolve to. The ordering check still runs here so a candidate that could
  // never be promoted is not staged at all; it runs again at promotion time.
  const currentLatest = readCurrentLatest(gh, repo);
  const promotion = evaluateCorpusPromotion({ tag, generation, currentLatest });
  if (!promotion.allowed) corpusFailure(promotion.reason);

  const notes = [
    'RuvNet Brain corpus generation — signed and content-addressed. Staged as a prerelease; promoted to latest only after a clean customer install applied it.',
    `${CORPUS_GENERATION_FIELD} ${generation}`,
    `Archive SHA-256: ${archiveSha256}`,
    `Receipt SHA-256: ${receiptSha256}`,
    `Stores: ${receipt.storeCount}`,
    `Builder source SHA: ${receipt.builderSourceSha}`,
    `Shipped runtime: ${receipt.archiveManifestReleaseTag}`,
    ...recallNotes(receipt),
    'Immutable: this tag is the archive digest and must never be replaced.',
  ].join('\n');

  // ASSETS COMPLETE BEFORE PROMOTION. `gh release create` uploads assets AFTER the release exists, so
  // creating a non-draft release directly opens a window in which releases/latest resolves to a
  // release with no archive — every polling client in that window fails or, worse, half-downloads.
  // Create as a draft (invisible to releases/latest), prove every asset landed, and only then flip
  // draft off AS A PRERELEASE — public, so an anonymous customer install can download it exactly as it
  // downloads latest, and never latest, so no customer receives it until the canary has applied it.
  // Both reports ride with every corpus release for the same reason they ride with a seed: a customer
  // (or the next night's dispatcher) that downloads the archive must be able to reverify it against
  // the identity it was actually measured under — the blocking recall gate AND the C3 diagnostic it
  // scored 59.0% on, so nobody has to take either number on trust.
  const assetFiles = [bundleFile, signatureFile, digestFile, receiptFile, accuracyReportFile, recallReportFile,
    coverageAssets.coverageFile, coverageAssets.receiptFile];
  const create = gh([
    'release', 'create', tag,
    '--draft',
    '--target', target,
    '--repo', repo,
    '--title', `RuvNet Brain corpus ${archiveSha256.slice(0, 16)}`,
    '--notes', notes,
    ...assetFiles,
  ]);
  if (create.error || create.status !== 0) {
    corpusFailure(`protected corpus publication failed (${String(create.error?.message || create.stderr || create.stdout || '').trim()})`);
  }

  const expectedAssets = assetFiles.map((file) => path.basename(file)).sort();
  const draftView = gh(['release', 'view', tag, '--json', 'isDraft,assets', '--repo', repo]);
  if (draftView.error || draftView.status !== 0) corpusFailure('cannot confirm the draft corpus release before promotion');
  let draft;
  try { draft = JSON.parse(String(draftView.stdout || 'null')); }
  catch (error) { corpusFailure(`cannot read the draft corpus release (${error.message})`); }
  const uploaded = (draft?.assets || []).filter((asset) => asset?.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0);
  if (draft?.isDraft !== true || JSON.stringify(uploaded.map((asset) => asset.name).sort()) !== JSON.stringify(expectedAssets)) {
    corpusFailure(`refusing to stage an incomplete corpus release; expected ${expectedAssets.join(', ')} fully uploaded on a draft`);
  }

  const stage = gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease', '--latest=false']);
  if (stage.error || stage.status !== 0) {
    corpusFailure(`corpus staging failed (${String(stage.error?.message || stage.stderr || stage.stdout || '').trim()})`);
  }

  // `isLatest` is NOT a `gh release view` field (gh 2.101.0: "Unknown JSON field"; it exists only on
  // `gh release list`), so latest-ness is read from the one authoritative endpoint: releases/latest
  // must NOT be this tag. tests/unit/gh-json-fields.test.mjs checks every --json field list.
  const finalView = gh(['release', 'view', tag, '--json', 'tagName,isDraft,isPrerelease,assets', '--repo', repo]);
  if (finalView.error || finalView.status !== 0) corpusFailure('cannot confirm the staged corpus release');
  let staged;
  try { staged = JSON.parse(String(finalView.stdout || 'null')); }
  catch (error) { corpusFailure(`cannot read the staged corpus release (${error.message})`); }
  const stagedAssets = (staged?.assets || []).map((asset) => asset?.name).sort();
  if (staged?.tagName !== tag || staged.isDraft !== false || staged.isPrerelease !== true
    || latestTagNow(gh, repo) === tag || JSON.stringify(stagedAssets) !== JSON.stringify(expectedAssets)) {
    corpusFailure('corpus release did not reach a complete, public, non-latest prerelease state');
  }

  return {
    tag, target, repository: repo, archiveSha256, receiptSha256, staged: true, promoted: false,
    generation, currentLatest: currentLatest?.tagName || null,
  };
}

/**
 * PROMOTION — the only code path that moves releases/latest to a corpus generation, and it requires
 * the consumer's consent: a PASS verdict from scripts/corpus-canary.mjs for THIS run, over exactly the
 * asset digests still on the staged prerelease. Everything that could have changed since staging is
 * re-proved: the protected environment, the checkout, the approved runtime still being the newest code
 * release (else CorpusSuperseded), the release still being the staged prerelease, and the ordering
 * against whatever is latest now.
 */
export async function runProtectedCorpusPromotion({
  argv = process.argv.slice(2),
  env = process.env,
  root = ROOT,
  run = (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options }),
} = {}) {
  const environmentFailures = validateProtectedPublishEnvironment(env);
  if (environmentFailures.length) corpusFailure(environmentFailures.join('; '));
  if (argv.includes('--publish')) corpusFailure('--corpus-seed cannot be combined with --publish; corpus routing must never enter product publication');
  const tag = cliArg(argv, '--corpus-tag');
  const verdictFile = cliArg(argv, '--canary-verdict');
  const target = cliArg(argv, '--target');
  const approvedTag = cliArg(argv, '--approved-tag');
  const repo = cliArg(argv, '--repo') || env.GITHUB_REPOSITORY;
  if (!CORPUS_TAG_PATTERN.test(String(tag || ''))) corpusFailure('corpus tag must be corpus-sha256- followed by 64 lowercase hex characters');
  if (repo !== env.GITHUB_REPOSITORY || repo !== 'stuinfla/ruvnet-brain') corpusFailure('repository does not match the protected workflow');
  if (!CODE_TAG.test(String(approvedTag || ''))) corpusFailure('promotion requires --approved-tag vX.Y.Z (the approved runtime this corpus was built at)');
  const head = String(run('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).stdout || '').trim();
  if (!isHex(target, 40) || target !== head || !isHex(env.GITHUB_SHA, 40)) corpusFailure('target must exactly equal HEAD (and GITHUB_SHA must be a commit)');
  const ancestry = run('git', ['merge-base', '--is-ancestor', target, env.GITHUB_SHA], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (ancestry.error || ancestry.status !== 0) corpusFailure(`target ${target} is not an ancestor of this run's GITHUB_SHA ${env.GITHUB_SHA}`);
  let verdict;
  try {
    if (!verdictFile || !path.isAbsolute(verdictFile)) throw new Error('--canary-verdict must be an absolute file');
    verdict = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
  } catch (error) {
    corpusFailure(`no customer consent: the canary verdict is unreadable (${error.message})`);
  }
  // Local refusal first: a FAIL verdict never reaches the network at all.
  if (verdict?.verdict !== 'PASS') corpusFailure(`no customer consent: the customer canary reported ${verdict?.verdict || '(no verdict)'}`);

  const { gh, ghJson } = corpusGh(env, run);
  assertApprovedRuntimeIsNewest({ ghJson, repo, approvedTag, target });
  const release = ghJson(['release', 'view', tag, '--json', 'tagName,isDraft,isPrerelease,assets,body', '--repo', repo], `the staged release ${tag}`);
  if (release?.tagName !== tag || release.isDraft !== false || release.isPrerelease !== true) {
    corpusFailure(`${tag} is not a staged (public, non-draft) prerelease; refusing to promote it`);
  }
  const consent = evaluateCanaryVerdict({ verdict, tag, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    approvedTag, releaseAssets: (release.assets || []).map((asset) => ({ name: asset?.name, digest: asset?.digest ?? null })) });
  if (!consent.allowed) corpusFailure(consent.reason);
  const generation = parseCorpusGeneration(release.body)?.value;
  if (!generation) corpusFailure(`${tag} carries no readable "${CORPUS_GENERATION_FIELD}" ordering key`);
  const currentLatest = readCurrentLatest(gh, repo);
  const promotion = evaluateCorpusPromotion({ tag, generation, currentLatest });
  if (!promotion.allowed) corpusFailure(promotion.reason);

  const promote = gh(['release', 'edit', tag, '--repo', repo, '--prerelease=false', '--latest']);
  if (promote.error || promote.status !== 0) {
    corpusFailure(`corpus promotion to latest failed (${String(promote.error?.message || promote.stderr || promote.stdout || '').trim()})`);
  }
  const finalView = gh(['release', 'view', tag, '--json', 'tagName,isDraft,isPrerelease,assets', '--repo', repo]);
  if (finalView.error || finalView.status !== 0) corpusFailure('cannot confirm the promoted corpus release');
  let promoted;
  try { promoted = JSON.parse(String(finalView.stdout || 'null')); }
  catch (error) { corpusFailure(`cannot read the promoted corpus release (${error.message})`); }
  const names = (assets) => (assets || []).map((asset) => asset?.name).sort();
  if (promoted?.tagName !== tag || promoted.isDraft !== false || promoted.isPrerelease !== false
    || latestTagNow(gh, repo) !== tag || JSON.stringify(names(promoted.assets)) !== JSON.stringify(names(release.assets))) {
    corpusFailure('corpus release did not reach a complete, non-draft, non-prerelease latest state');
  }
  return { tag, target, repository: repo, promoted: true, generation, consent: consent.reason,
    supersededLatest: currentLatest?.tagName || null };
}

if (CORPUS_SEED) {
  try {
    const result = process.argv.includes('--promote-staged') ? await runProtectedCorpusPromotion() : await runProtectedCorpusSeed();
    console.log(JSON.stringify({ ok: true, mode: 'corpus-seed', ...result }, null, 2));
  } catch (error) {
    console.error(error.message);
    if (error instanceof CorpusSuperseded) {
      // Typed, not red: stdout carries the outcome the workflow records.
      console.log(JSON.stringify({ ok: false, mode: 'corpus-seed', outcome: 'superseded', reason: error.message }));
      process.exitCode = CORPUS_SUPERSEDED_EXIT;
    } else {
      process.exitCode = 1;
    }
  }
} else {

console.log(`\n${c.b('RuvNet Brain — release / definition-of-done')} ${c.dim('· ' + (PUBLISH ? 'PUBLISH' : 'check-only') + ' · shipping ' + V())}\n`);

// The local CLI remains useful as a read-only preflight, but publication authority lives only in
// the reviewer-protected workflow. Validate the exact candidate receipt and artifact bytes before
// any command capable of pushing, tagging, releasing, or publishing can run.
if (PUBLISH) {
  const protectedInvocation = validateProtectedPublishInvocation({ root: ROOT });
  if (protectedInvocation.verdict !== 'PASS') {
    console.error(`\n${c.r('✗ PROTECTED RELEASE GATE FAILED')}`);
    for (const failure of protectedInvocation.failures) console.error(`  ${failure}`);
    console.error(`${c.r('  NOT shipped. Run the protected-release workflow with exact candidate evidence.')}\n`);
    process.exit(1);
  }
  protectedReleaseMode = protectedInvocation.mode;
  protectedCandidate = JSON.parse(fs.readFileSync(path.resolve(ROOT, process.env.RUVNET_CANDIDATE_RECEIPT), 'utf8'));
  sealedPackageArtifact = path.resolve(ROOT, protectedCandidate.artifact.path);
  publicationReceiptPath = path.resolve(ROOT, process.env.RUVNET_PUBLICATION_RECEIPT || '.missing-publication-receipt');
  const evidenceRoot = path.join(ROOT, 'release-evidence');
  if (!publicationReceiptPath.startsWith(`${evidenceRoot}${path.sep}`) || fs.existsSync(publicationReceiptPath)) {
    console.error(`\n${c.r('✗ PROTECTED RELEASE GATE FAILED')}\n  publication receipt output must be a new file inside release-evidence\n`);
    process.exit(1);
  }
  publicationHandoffPaths = resolvePublicationHandoffPaths({
    root: ROOT,
    identityPath: process.env.RUVNET_RELEASE_IDENTITY,
    receiptPath: process.env.RUVNET_CHANNEL_RECEIPT,
  });
  const payloadManifestPath = path.resolve(ROOT, process.env.RUVNET_CANDIDATE_PAYLOAD || '');
  const payloadSignaturePath = path.resolve(ROOT, process.env.RUVNET_CANDIDATE_PAYLOAD_SIGNATURE || '');
  const aggregatePath = path.resolve(ROOT, process.env.RUVNET_AGGREGATE_ENVELOPE || '');
  if (![payloadManifestPath, payloadSignaturePath, aggregatePath].every((file) => file.startsWith(`${evidenceRoot}${path.sep}`) && fs.existsSync(file))) {
    throw new Error('protected publication requires persisted payload manifest, signature, and aggregate envelope');
  }
  verifiedPayload = verifyPayload({
    manifest: JSON.parse(fs.readFileSync(payloadManifestPath, 'utf8')),
    signature: fs.readFileSync(payloadSignaturePath, 'utf8'),
    publicKey: crypto.createPublicKey(fs.readFileSync(path.join(ROOT, 'keys/ruvnet-brain-signing.pub.pem'), 'utf8')),
    root: path.dirname(payloadManifestPath),
  });
  aggregateEnvelope = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
  if (aggregateEnvelope.verdict !== 'PASS' || aggregateEnvelope.sha !== protectedCandidate.sha
    || aggregateEnvelope.payloadId !== verifiedPayload.payloadId) {
    throw new Error('aggregate envelope does not bind the protected candidate payload');
  }
}

// A verdict is only about the exact committed candidate. Check-only used to permit a dirty tree
// while publish checked cleanliness much later, so preflight could certify bytes that would never
// ship. Both modes now bind to the same committed tree before any expensive gate runs.
const initialDirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
if (initialDirty) {
  console.error(`\n${c.r('✗ GATE FAILED: working tree not clean')} ${c.dim('— preflight and publish both certify committed bytes only.')}`);
  console.error(initialDirty.split('\n').slice(0, 10).map((l) => '    ' + l).join('\n'));
  process.exit(1);
}

if (!PUBLISH) {
  // Source gates belong to candidate CI/check-only mode. The protected publisher has already
  // validated their exact-SHA receipt and the sealed bytes before reaching this process.
  step('A', 'version single-source-of-truth agrees across every surface');
  runOrDie('version sync', process.execPath, ['scripts/sync-version.mjs', '--check']);
  runOrDie('one protected publisher', process.execPath, ['scripts/release-authority.mjs']);

// RELEASE QUALIFICATION — ONE definition of "release-qualified", the one CI enforces.
//
// Rewritten 2026-09-26 (consolidation/single-source). Before this change, check-only mode ran its
// OWN separate gate list (npm test, vitest tests/unit, release-vector.mjs, top100-benchmark.mjs,
// wired-check.mjs, a Stable-Spine restart print, and a live verify-channels.mjs walk) that had
// drifted from — and duplicated — the actual contract CI enforces in
// scripts/release-qualification-contract.mjs. Two lists of "what counts as qualified" is exactly how
// a local PASS stops meaning what CI's PASS means. There is now one contract; this runs it locally,
// read-only, the same way canonical-qa.yml's `qualify-development` job runs it on every push/PR.
  step('B', 'release qualification — the same gate CI enforces (release-qualification.mjs)');
  {
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-brain-release-qualification-'));
    const reportPath = path.join(reportDir, 'source-qualification.json');
    runOrDie('release qualification (source)', process.execPath,
      ['scripts/release-qualification.mjs', '--suite', 'source', '--report', reportPath]);
  }
}

// D. One remotely durable, staged release transaction (ADR-062 / DDD-0015). GitHub remains a draft
// and npm remains on a non-default candidate tag until exact bytes and all host fixtures pass.
if (PUBLISH) {
  const v = V();
  const tag = `v${v}`;
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  step('D', 'verify, stage, promote, and reconcile one persisted signed payload');
  const payloadRoot = verifiedPayload.root;
  const byRole = new Map(verifiedPayload.manifest.members.map((member) => [member.role, path.join(payloadRoot, member.name)]));
  const assets = {
    bundlePath: byRole.get('bundle'),
    bundleSignaturePath: path.join(payloadRoot, 'ruvnet-brain.zip.sig'),
    bundleDigestPath: path.join(payloadRoot, 'ruvnet-brain.zip.sha256'),
    packagePath: byRole.get('npm'),
    corpusSeedPath: byRole.get('corpus-seed'),
    generationLedgerPath: byRole.get('generation-ledger'),
  };
  for (const asset of Object.values(assets)) {
    if (!fs.existsSync(asset)) {
      console.error(`\n${c.r('✗ GATE FAILED: signed release asset missing')} ${c.dim(asset)}`);
      process.exit(1);
    }
  }
  // ADR-0091 D6.6 — THE BACKWARD-MOVE RACE. Release QE sealed the corpus generation this bundle was
  // built from; publication happens later, after owner approval. Clients always accept a code release
  // and drop their corpusGeneration marker when they install one (kb/forge-update.mjs), so publishing
  // a bundle built from generation G after G+1 already shipped rolls every user back one night.
  // Re-resolve with the SAME resolver, before any asset upload, and refuse on any difference -- or on
  // any answer that could not prove there is no newer generation.
  try {
    const guard = await assertNoNewerCorpusGeneration({
      sealedFile: assets.corpusSeedPath, repo: 'stuinfla/ruvnet-brain', runtimeRoot: ROOT,
    });
    console.log(`  corpus seed still current at publish time: ${guard.origin} ${guard.tag}`);
  } catch (error) {
    console.error(`\n${c.r('✗ GATE FAILED: corpus generation moved after release QE')} ${c.dim(error.message)}`);
    console.error(`${c.r('  NOT shipped. Re-run release QE so this release is built from the newest generation.')}\n`);
    process.exit(1);
  }
  const bundleSha256 = fs.readFileSync(assets.bundleDigestPath, 'utf8').trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(bundleSha256)) {
    console.error(`\n${c.r('✗ GATE FAILED: release digest is not a SHA-256 value')}`);
    process.exit(1);
  }

  const packageIntegrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(sealedPackageArtifact)).digest('base64')}`;
  if (assets.packagePath !== sealedPackageArtifact
    && !fs.readFileSync(assets.packagePath).equals(fs.readFileSync(sealedPackageArtifact))) {
    throw new Error('candidate receipt package and payload package bytes differ');
  }
  const identity = {
    repository: 'stuinfla/ruvnet-brain', package: 'ruvnet-brain', version: v, tag,
    candidateSha: head,
    payloadId: verifiedPayload.payloadId,
    evidenceDigest: aggregateEnvelope.evidenceDigest,
    packageIntegrity,
    packageSha256: crypto.createHash('sha256').update(fs.readFileSync(assets.packagePath)).digest('hex'),
    packageAssetName: path.basename(assets.packagePath),
    bundleSha256,
    bundleSignatureSha256: crypto.createHash('sha256').update(fs.readFileSync(assets.bundleSignaturePath)).digest('hex'),
    bundleDigestSha256: crypto.createHash('sha256').update(fs.readFileSync(assets.bundleDigestPath)).digest('hex'),
    corpusSeedSha256: crypto.createHash('sha256').update(fs.readFileSync(assets.corpusSeedPath)).digest('hex'),
    generationLedgerSha256: crypto.createHash('sha256').update(fs.readFileSync(assets.generationLedgerPath)).digest('hex'),
  };
  const privatePem = process.env.RUVNET_SIGNING_KEY;
  if (!privatePem) throw new Error('RUVNET_SIGNING_KEY is required for signed transaction receipts');
  const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(ROOT, 'keys/ruvnet-brain-signing.pub.pem'), 'utf8'));
  const finalReceipt = await runReleaseTransaction({
    identity, assets, adapter: liveReleaseProvider({
      root: ROOT,
      candidateReceipt: process.env.RUVNET_CANDIDATE_RECEIPT,
      publicationReceipt: process.env.RUVNET_PUBLICATION_RECEIPT,
    }),
    privateKey: crypto.createPrivateKey(privatePem),
    publicKey,
    hostVerifier: stagedHostVerifier({ assets, identity }),
  });
  if (finalReceipt.state !== 'channels-converged') throw new Error(`release transaction stopped at ${finalReceipt.state}`);
  materializePublicationHandoff({ paths: publicationHandoffPaths, identity, receipt: finalReceipt, publicKey });
} else {
  step('D', 'remote staged release transaction — SKIPPED (check-only; pass --publish to publish)');
}

if (PUBLISH) {
  console.log(`\n${c.y(c.b('PUBLISHED, NOT VERIFIED'))}`);
} else {
  console.log(`\n${c.g(c.b('✓✓✓ PREFLIGHT PASS — NOT PUBLISHED'))} — the committed candidate passed every check-only gate.\n`);
}
}
