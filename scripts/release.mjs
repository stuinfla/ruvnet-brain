#!/usr/bin/env node
// scripts/release.mjs — the DEFINITION OF DONE. The only path to the word "shipped."
//
// WHY (2026-07-17, Stuart): "You should be able to take the applied knowledge and build it into a set
// of criteria that you always use, not a bunch of suggestions you choose to ignore." Every failure
// this session was an ASSUMPTION that survived because the check was a suggestion, not a gate. This
// script turns the checklist into a gate: it runs the criteria in order, STOPS on the first failure,
// and only prints "SHIPPED" when every channel a user touches is proven current and working. There is
// no "I think it's fine" — there is pass or fail.
//
// Check-only mode evaluates source. Publish mode consumes a CI-sealed package and receipt, then
// performs only the staged transaction and public verification. It never rebuilds or retests the
// source: the immutable artifact is the evidence boundary.
//
// Usage:
//   node scripts/release.mjs --check          # run every gate READ-ONLY (no publish) — the pre-flight
//   node scripts/release.mjs --publish        # publish the exact CI-sealed artifact
//   node scripts/release.mjs                   # same as --check
//
// The gates, in order (fail fast):
//   A. version single-source-of-truth agrees (sync-version --check)
//   B. full test suite green (npm test — the 60/60)
//   C. narrative + unit gates (vitest) incl. the tag/entity-aware "What's new" check
//   D. [--publish only] stage and promote the exact package plus signed RVF bundle
//   E. [--check only] verify current public channels; publish verifies them inside transaction finalization

import path from 'node:path';
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
    `ADR-086 C3 was NOT met and is NOT claimed — its measurement ships as ${receipt.accuracyReport.file}`
      + ' for inspection.',
  ];
};
import { verifyBundle } from './verify-bundle.mjs';
import { CORPUS_GENERATION_FIELD, evaluateCorpusPromotion } from './corpus-promotion.mjs';

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
  const promoteLatest = argv.includes('--promote-latest');

  const tag = cliArg(argv, '--corpus-tag');
  const bundleFile = cliArg(argv, '--corpus-bundle');
  const receiptFile = cliArg(argv, '--corpus-receipt');
  const target = cliArg(argv, '--target');
  const repo = cliArg(argv, '--repo') || env.GITHUB_REPOSITORY;
  const digestMatch = String(tag || '').match(/^corpus-sha256-([a-f0-9]{64})$/);
  if (!digestMatch) corpusFailure('corpus tag must be corpus-sha256- followed by 64 lowercase hex characters');
  if (repo !== env.GITHUB_REPOSITORY || repo !== 'stuinfla/ruvnet-brain') corpusFailure('repository does not match the protected workflow');

  for (const [label, file] of [['bundle', bundleFile], ['receipt', receiptFile]]) {
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
  if (!isHex(target, 40) || target !== head || target !== env.GITHUB_SHA || target !== receipt.builderSourceSha) {
    corpusFailure('target must exactly equal HEAD, GITHUB_SHA, and the corpus receipt builderSourceSha');
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
  // was measured against THESE archive bytes, (c) every partition in both query modes passed
  // 20x>=19x with no timeouts and no bounded sampling, and (d) it was produced by the committed
  // benchmark against the committed oracle — so a swapped oracle or a patched benchmark is caught
  // here even though the receipt itself carries only {file, sha256, bytes}.
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
  try {
    readRecallReport({
      reportFile: recallReportFile,
      archive: archiveIdentity,
      expectedFixtureSha256: loadFixture().fixtureSha256,
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
      receiptFile, bundleFile, accuracyReportFile, recallReportFile, expectedBuilderSha: target, expectedArchiveSha256: archiveSha256,
    });
  } catch (error) {
    corpusFailure(`corpus receipt does not verify against the sealed archive (${error.message})`);
  }

  // EVERY local proof happens before the first network call. `gh` must never be reached by a
  // candidate that is already known to be unpublishable — that is the same discipline the deep
  // verifyCorpusReceipt above follows, and a customer release with an unusable signature is exactly
  // as unpublishable as an untrue receipt.
  const signatureFile = `${bundleFile}.sig`;
  const digestFile = `${bundleFile}.sha256`;
  const generation = String(receipt.createdAt || '');
  if (promoteLatest) {
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

  const viewArgs = ['release', 'view', tag, '--json', 'tagName', '--repo', repo];
  const ghCommand = env.RUVNET_GH_COMMAND || 'gh';
  const ghPrefix = env.RUVNET_GH_SCRIPT ? [env.RUVNET_GH_SCRIPT] : [];
  const view = run(ghCommand, [...ghPrefix, ...viewArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!view.error && view.status === 0) corpusFailure(`release ${tag} already exists; refusing to overwrite immutable corpus seed`);
  const viewError = String(view.error?.message || view.stderr || view.stdout || '');
  if (!/(release not found|no release found)/i.test(viewError)) corpusFailure(`cannot prove ${tag} is absent (${viewError.trim() || `gh exited ${view.status}`})`);

  const receiptSha256 = sha256File(receiptFile);
  const gh = (args) => run(ghCommand, [...ghPrefix, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  if (!promoteLatest) {
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
  const latestView = gh(['release', 'view', '--json', 'tagName,body', '--repo', repo]);
  let currentLatest = null;
  if (!latestView.error && latestView.status === 0) {
    try { currentLatest = JSON.parse(String(latestView.stdout || 'null')); }
    catch (error) { corpusFailure(`cannot read the current latest release (${error.message})`); }
    if (!currentLatest || typeof currentLatest.tagName !== 'string') corpusFailure('current latest release carries no tag name');
  } else {
    const latestError = String(latestView.error?.message || latestView.stderr || latestView.stdout || '');
    if (!/(release not found|no release found)/i.test(latestError)) {
      corpusFailure(`cannot determine the current latest release (${latestError.trim() || `gh exited ${latestView.status}`})`);
    }
  }
  const promotion = evaluateCorpusPromotion({ tag, generation, currentLatest });
  if (!promotion.allowed) corpusFailure(promotion.reason);

  const notes = [
    'RuvNet Brain corpus generation — signed, content-addressed, and promoted to latest.',
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
  // Create as a draft (invisible to releases/latest), prove all four assets landed, and only then
  // flip draft off and claim latest in one edit.
  // Both reports ride with every corpus release for the same reason they ride with a seed: a customer
  // (or the next night's dispatcher) that downloads the archive must be able to reverify it against
  // the identity it was actually measured under — the blocking recall gate AND the C3 diagnostic it
  // scored 59.0% on, so nobody has to take either number on trust.
  const assetFiles = [bundleFile, signatureFile, digestFile, receiptFile, accuracyReportFile, recallReportFile];
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
    corpusFailure(`refusing to promote an incomplete corpus release; expected ${expectedAssets.join(', ')} fully uploaded on a draft`);
  }

  const promote = gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest', '--prerelease=false']);
  if (promote.error || promote.status !== 0) {
    corpusFailure(`corpus promotion to latest failed (${String(promote.error?.message || promote.stderr || promote.stdout || '').trim()})`);
  }

  const finalView = gh(['release', 'view', tag, '--json', 'tagName,isDraft,isLatest,isPrerelease,assets', '--repo', repo]);
  if (finalView.error || finalView.status !== 0) corpusFailure('cannot confirm the promoted corpus release');
  let promoted;
  try { promoted = JSON.parse(String(finalView.stdout || 'null')); }
  catch (error) { corpusFailure(`cannot read the promoted corpus release (${error.message})`); }
  const promotedAssets = (promoted?.assets || []).map((asset) => asset?.name).sort();
  if (promoted?.tagName !== tag || promoted.isDraft !== false || promoted.isLatest !== true
    || promoted.isPrerelease !== false || JSON.stringify(promotedAssets) !== JSON.stringify(expectedAssets)) {
    corpusFailure('corpus release did not reach a complete, non-draft, non-prerelease latest state');
  }

  return {
    tag, target, repository: repo, archiveSha256, receiptSha256, promoted: true,
    generation, supersededLatest: currentLatest?.tagName || null,
  };
}

if (CORPUS_SEED) {
  try {
    const result = await runProtectedCorpusSeed();
    console.log(JSON.stringify({ ok: true, mode: 'corpus-seed', ...result }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
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

// WIRED-CHECK — refuses to ship a module with zero callers.
//
// Added 2026-07-22 after this project shipped built-tested-unwired code SEVEN times in one session
// (capability-registry, capability-audit, lesson-gate's five triggers, anticipate.sh,
// advocacy-outcomes, lesson-promote's demotion, continuation-gate's global path). Every one had
// passing tests, because a test imports the module directly — the one caller that proves nothing
// about whether the product uses it. Every one was found by a human running grep, hours later.
//
// Seven repetitions of one mistake is not a discipline problem; discipline is what failed. So it
// becomes a gate, on the ship path, where this repo's gates run 8/8 against prose's 0/6.
  runOrDie('wired (no orphan modules)', process.execPath, ['scripts/wired-check.mjs', '--check']);

// THE NORTH-STAR PROMOTION VECTOR — strict/check-only releases may not average one broken or
// unknown invariant into a pass. The separately authorized stabilization class makes no 95 claim;
// it retains every safety, test, artifact, publication, and post-publication gate below while the
// promotion program remains open. Derive this only from the already-validated sealed receipt, never
// from a free-standing environment toggle.
  if (protectedReleaseMode === 'strict') {
    runOrDie('release vector (all critical invariants PASS)', process.execPath, ['scripts/release-vector.mjs']);

  // The Top-100 corpus spans naive through expert prompts and grades semantic clauses, citations,
  // abstention, and latency. A manual-only benchmark is a report; a strict release-path benchmark
  // is a guarantee. The benchmark itself fails closed unless all 100 canonical questions run.
    runOrDie('Top-100 source-grounded recall contract', process.execPath, ['scripts/top100-benchmark.mjs', '--no-write']);
  } else {
    console.log(c.y('  strict >=95 promotion gates: NOT CLAIMED (sealed stabilization; scoreClaimed:false)'));
  }

// A2. Stable Spine restart classifier (ADR-023, red-team finding 18): diff the boot-frozen SHELL
// (hooks.json, hook-shim, MCP server, .mcp.json, skills/, commands/) against the previous release
// tag and SAY OUT LOUD whether this release needs a restart. The classification is computed, never
// remembered — the same shellDiff logic runs client-side in update-apply.mjs at every flip, so the
// user-facing nag stays honest even if this print is ignored. Informational at ship time; the
// releasing human sees exactly which shell files changed.
  step('A2', 'Stable Spine — does this release change the boot-frozen shell? (requiresRestart classifier)');
  {
  const { execFileSync } = await import('node:child_process');
  const SHELL = ['plugin/hooks/hooks.json', 'plugin/scripts/hook-shim.mjs', 'plugin/mcp/server.mjs', 'plugin/.mcp.json', 'plugin/skills', 'plugin/commands'];
  let prevTag = '';
  try { prevTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).trim(); } catch { /* no tags yet */ }
  if (!prevTag) {
    console.log(c.dim('  no previous release tag — classifier has no baseline (first spine release: requiresRestart=true by definition)'));
  } else {
    let changed = [];
    try {
      const out = execFileSync('git', ['diff', '--name-only', `${prevTag}..HEAD`, '--', ...SHELL], { encoding: 'utf8' }).trim();
      changed = out ? out.split('\n') : [];
    } catch { /* diff failure = unknown; say so, never guess green */ changed = ['(diff failed — treat as changed)']; }
    if (changed.length) {
      console.log(`  ${c.y('requiresRestart: TRUE')} — shell changed vs ${prevTag}:`);
      for (const f of changed) console.log(`    · ${f}`);
      console.log(c.dim('  users get ONE honest restart notice (session-start reads active.json.shellChanged); everything else is live.'));
    } else {
      console.log(`  ${c.g('requiresRestart: false')} — no shell change vs ${prevTag}; this release goes fully live with zero restarts.`);
    }
  }
  }

// B. the full brain test suite (the 60/60)
  step('B', 'full test suite (npm test)');
  runOrDie('npm test', 'npm', ['test']);

// C. unit gates — narrative-version (tag/entity aware), claims, etc.
  step('C', 'unit gates (vitest) — narrative version, claims, guards');
  runOrDie('vitest unit', 'npx', ['vitest', 'run', 'tests/unit']);
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

// Check-only diagnoses the currently public channels. During publication, transaction finalization
// performs this walk once, then creates and verifies the publication receipt before convergence.
if (!PUBLISH) {
  step('E', 'verify-channels — the live walk of every user path');
  runOrDie('verify-channels', process.execPath, ['scripts/verify-channels.mjs']);
}

if (PUBLISH) {
  console.log(`\n${c.y(c.b('PUBLISHED, NOT VERIFIED'))}`);
} else {
  console.log(`\n${c.g(c.b('✓✓✓ PREFLIGHT PASS — NOT PUBLISHED'))} — the committed candidate passed every check-only gate.\n`);
}
}
