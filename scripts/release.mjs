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
import { validateProtectedPublishInvocation } from './protected-release-invocation.mjs';
import { runReleaseTransaction } from './release-transaction.mjs';
import { liveReleaseProvider } from './release-transaction-provider.mjs';
import { verifyPayload } from './release-payload.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IS_MAIN = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
const PUBLISH = process.argv.includes('--publish');
const CORPUS_SEED = process.argv.includes('--corpus-seed');
let protectedCandidate = null;
let sealedPackageArtifact = null;
let publicationReceiptPath = null;
let protectedReleaseMode = 'strict';
let verifiedPayload = null;
let aggregateEnvelope = null;
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

export function runProtectedCorpusSeed({
  argv = process.argv.slice(2),
  env = process.env,
  root = ROOT,
  run = (command, args, options) => spawnSync(command, args, { encoding: 'utf8', ...options }),
} = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_WORKFLOW !== 'protected-release'
    || env.GITHUB_REPOSITORY !== 'stuinfla/ruvnet-brain') {
    corpusFailure('publication is allowed only inside the protected-release GitHub workflow for stuinfla/ruvnet-brain');
  }

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

  const boundaryIdentities = [receipt.privateFence, receipt.eligibilityPolicy, receipt.generationLedger];
  const storeBindingsValid = Number.isSafeInteger(receipt.storeCount) && receipt.storeCount > 0
    && Array.isArray(receipt.stores) && receipt.stores.length === receipt.storeCount
    && receipt.stores.every((store) => typeof store?.name === 'string' && store.name.length > 0
      && /^[a-f0-9]{7,64}$/.test(String(store.sourceCommit || ''))
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
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'ruvnet-brain-corpus-candidate'
    || !receipt.createdAt || !receipt.coverageGeneration || !storeBindingsValid || !emptyFailureArrays
    || !privateExclusionsValid || !boundaryIdentities.every(exactFileIdentity) || !exactFileIdentity(receipt.archive)
    || !generatorValid
    || receipt.archive.file !== path.basename(bundleFile)) {
    corpusFailure('corpus receipt bindings are incomplete or invalid');
  }

  const archiveSha256 = sha256File(bundleFile);
  if (archiveSha256 !== receipt.archive.sha256 || fs.statSync(bundleFile).size !== receipt.archive.bytes) {
    corpusFailure('archive bytes do not match the corpus receipt');
  }
  if (digestMatch[1] !== archiveSha256) corpusFailure('corpus tag digest does not match the receipt and archive');

  const viewArgs = ['release', 'view', tag, '--json', 'tagName', '--repo', repo];
  const view = run('gh', viewArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!view.error && view.status === 0) corpusFailure(`release ${tag} already exists; refusing to overwrite immutable corpus seed`);
  const viewError = String(view.error?.message || view.stderr || view.stdout || '');
  if (!/(release not found|no release found)/i.test(viewError)) corpusFailure(`cannot prove ${tag} is absent (${viewError.trim() || `gh exited ${view.status}`})`);

  const notes = [
    'Content-addressed RuvNet Brain corpus seed.',
    `Archive SHA-256: ${archiveSha256}`,
    `Receipt SHA-256: ${sha256File(receiptFile)}`,
    `Stores: ${receipt.storeCount}`,
    `Coverage generation: ${receipt.coverageGeneration}`,
    'This published prerelease is immutable and must never be replaced.',
  ].join('\n');
  const createArgs = [
    'release', 'create', tag,
    '--prerelease', '--latest=false',
    '--target', target,
    '--repo', repo,
    '--title', `Immutable corpus seed ${archiveSha256.slice(0, 16)}`,
    '--notes', notes,
    bundleFile, receiptFile,
  ];
  const create = run('gh', createArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (create.error || create.status !== 0) {
    corpusFailure(`protected corpus publication failed (${String(create.error?.message || create.stderr || create.stdout || '').trim()})`);
  }
  return { tag, target, repository: repo, archiveSha256, receiptSha256: sha256File(receiptFile) };
}

if (IS_MAIN && CORPUS_SEED) {
  try {
    const result = runProtectedCorpusSeed();
    console.log(JSON.stringify({ ok: true, mode: 'corpus-seed', ...result }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else if (IS_MAIN) {

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
  const identityPath = path.resolve(ROOT, process.env.RUVNET_RELEASE_IDENTITY || 'release-evidence/release-identity.json');
  if (fs.existsSync(identityPath)) throw new Error(`refusing to overwrite release identity: ${identityPath}`);
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const privatePem = process.env.RUVNET_SIGNING_KEY;
  if (!privatePem) throw new Error('RUVNET_SIGNING_KEY is required for signed transaction receipts');
  const finalReceipt = await runReleaseTransaction({
    identity, assets, adapter: liveReleaseProvider({
      root: ROOT,
      candidateReceipt: process.env.RUVNET_CANDIDATE_RECEIPT,
      publicationReceipt: process.env.RUVNET_PUBLICATION_RECEIPT,
    }),
    privateKey: crypto.createPrivateKey(privatePem),
    publicKey: crypto.createPublicKey(fs.readFileSync(path.join(ROOT, 'keys/ruvnet-brain-signing.pub.pem'), 'utf8')),
  });
  if (finalReceipt.state !== 'channels-converged') throw new Error(`release transaction stopped at ${finalReceipt.state}`);
  const channelReceiptPath = path.resolve(ROOT,
    process.env.RUVNET_CHANNEL_RECEIPT || 'release-evidence/channels-converged-receipt.json');
  if (fs.existsSync(channelReceiptPath)) throw new Error(`refusing to overwrite channel receipt: ${channelReceiptPath}`);
  fs.writeFileSync(channelReceiptPath, `${JSON.stringify(finalReceipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
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
  console.log(`\n${c.y(c.b('PUBLISHED, NOT VERIFIED'))} — npm and GitHub expose the sealed candidate; public install verification is still required.\n`);
} else {
  console.log(`\n${c.g(c.b('✓✓✓ PREFLIGHT PASS — NOT PUBLISHED'))} — the committed candidate passed every check-only gate.\n`);
}
}
