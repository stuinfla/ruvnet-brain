#!/usr/bin/env node
// forge-update.mjs — GENERALIZED EVERGREEN self-updater for any rvf-kb-forge bundle.
//
// Ships INSIDE the bundle next to SOURCE.json (written by forge-build.mjs with --canonical-url).
// A consumer who copied the bundle runs it in that dir. It reads the embedded provenance
// (SOURCE.json — "where I came from"), fetches the LIVE canonical build manifest, and reports
// whether their copy is current; --apply downloads + extracts + re-verifies with forge-guard.mjs.
//
//   node forge-update.mjs            (== --check)  report only: UP TO DATE / BEHIND
//   node forge-update.mjs --check    same as above
//   node forge-update.mjs --apply    download canonical bundle, back up, extract over local,
//                                    re-verify with forge-guard.mjs, print DONE
//   node forge-update.mjs <name>     limit to one store when SOURCE.json carries several
//
// Cron example (Mon 09:00, log result):
//   0 9 * * 1  cd /path/to/kb && /usr/bin/node forge-update.mjs --check >> forge-update.log 2>&1
//
// Zero dependencies. Node 18+ (global fetch). Network failures fail LOUD and CLEAN: clear
// message, non-zero exit, NO partial clobber. If --canonical-url was not set at build time the
// URLs are null and this prints a clear "self-update not configured for this build" message.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { extractZip } from './zip-extract.mjs';
import { applyBrainProfile, discoverStoreFamilies, readBrainProfile } from './brain-profile.mjs';
import { acquireRefreshLock, releaseRefreshLock } from './refresh-run.mjs';
import { runStorageTransaction, treeIdentity, managedStorageInventory, storageDelta } from './update-storage-transaction.mjs';
import { pruneLifecycleEvidence } from './lifecycle-evidence-retention.mjs';
import {
  isCorpusReleaseTag, assertCorpusReleaseCompatible, readInstalledRuntime,
  recordCorpusTransportIdentity, recordCorpusGenerationIdentity,
  readRejectedRelease, writeRejectedRelease, clearRejectedRelease,
  releaseKind, parseCorpusGeneration,
} from './corpus-release-identity.mjs';

const KB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(KB_DIR, 'SOURCE.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const RESTORE_COMPLETE = argv.includes('--restore-complete');
// `--staged-release <descriptor.json>` is the private-overlay recovery rail's own entry point
// (applyVerifiedStagedRelease, invoked by bin/install.mjs when the normal --apply flow above cannot
// complete). It bypasses main() and this module's own SOURCE.json/canonicalManifestUrl bootstrap
// entirely — discovery is supplied by the descriptor, not read from this KB tree.
const stagedReleaseIndex = argv.indexOf('--staged-release');
const STAGED_RELEASE_FILE = stagedReleaseIndex >= 0 && argv[stagedReleaseIndex + 1]
  ? path.resolve(argv[stagedReleaseIndex + 1]) : null;
const resultFileIndex = argv.indexOf('--result-file');
const RESULT_FILE = resultFileIndex >= 0 && argv[resultFileIndex + 1]
  ? path.resolve(argv[resultFileIndex + 1]) : (process.env.RUVNET_UPDATE_RESULT ? path.resolve(process.env.RUVNET_UPDATE_RESULT) : null);
const optionValueIndexes = new Set([
  ...(resultFileIndex >= 0 ? [resultFileIndex + 1] : []),
  ...(stagedReleaseIndex >= 0 ? [stagedReleaseIndex + 1] : []),
]);
const ONLY = argv.find((a, index) => !a.startsWith('--') && !optionValueIndexes.has(index));

/**
 * EXIT CODES — anything scripting this (a cron line, a LaunchAgent, `npx ruvnet-brain --update`)
 * reads only this number, so each one means exactly one thing:
 *
 *    0  --check: current  ·  --apply: explicit applied or byte-exact noop result receipt
 *    1  configuration/verification error; local copy may need the rollback beside it
 *    2  network / canonical manifest unreachable — nothing was touched
 *    3  the signature could not be fetched — refused to apply
 *    4  signature verification FAILED — refused to apply
 *   10  --check: a newer build exists
 */

// The updater's trust root is part of the executable, not part of either the currently installed KB
// or the downloaded candidate. A missing auxiliary verifier/key must therefore never create a
// bootstrap bypass. Keep this byte-identical to keys/ruvnet-brain-signing.pub.pem; the release gate
// checks that identity.
const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgse9TAtehXUvUfTrJFY2CCHiCbmelR8yCgS//sen5/w=
-----END PUBLIC KEY-----`;

export function verifyDownloadedBundle(bundlePath, signaturePath) {
  try {
    if (!fs.existsSync(bundlePath)) return { ok: false, reason: `bundle not found: ${bundlePath}` };
    if (!fs.existsSync(signaturePath)) return { ok: false, reason: 'signature missing (fail-closed)' };
    const digest = createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
    const ok = verifySignature(null, Buffer.from(digest, 'hex'), createPublicKey(SIGNING_PUBKEY_PEM), fs.readFileSync(signaturePath));
    return ok ? { ok: true, reason: `signature valid (sha256 ${digest.slice(0, 12)}…)` }
      : { ok: false, reason: 'signature does NOT match — bundle may be tampered' };
  } catch (error) { return { ok: false, reason: `verify error: ${error.message}` }; }
}

// ── ROLLBACK COPIES — ONE settlement point, on EVERY exit path ────────────────────────────────
// `process.exit()` does NOT run `finally` blocks, so a die() anywhere below the directory swap used
// to leave a multi-gigabyte rollback copy behind with nothing to release it. Issue #108 measured
// exactly that: ~1.6 GB stranded per night, ten copies (~16 GB) before the owner noticed — and the
// run that stranded them had actually SUCCEEDED. Every exit now passes through settleRollback(), so
// the copy is either RELEASED or deliberately KEPT and named. Never silently stranded.
const backupsMade = [];
let rollbackSettled = false;
let updateLock = null;
let updateOutcomeWritten = false;
let lifecycleRetention = null;
let legacyBackupRetention = null;

function writeUpdateOutcome(outcome) {
  if (updateOutcomeWritten) return outcome;
  if (legacyBackupRetention) outcome = { ...outcome, legacyBackupRetention };
  if (!lifecycleRetention) {
    try {
      lifecycleRetention = pruneLifecycleEvidence({ brainHome: path.dirname(KB_DIR), kbDir: KB_DIR,
        preserveRefreshRunIds: updateLock?.runId ? [updateLock.runId] : [],
        preserveTransactionPaths: outcome.transactionReceipts ? [outcome.transactionReceipts] : [] });
    } catch (error) {
      lifecycleRetention = { schemaVersion: 1, kind: 'ruvnet-brain-lifecycle-evidence-retention',
        withinBudget: false, unsafe: [{ path: path.dirname(KB_DIR), reason: error.message }] };
    }
  }
  const finalOutcome = lifecycleRetention.withinBudget === true ? { ...outcome, lifecycleRetention }
    : { ...outcome, terminalVerdict: 'recovery-required', exitCode: 1,
      reason: `lifecycle evidence retention failed: ${lifecycleRetention.unsafe?.map(({ reason }) => reason).join('; ') || 'budget exceeded'}`,
      lifecycleRetention };
  if (!RESULT_FILE) return finalOutcome;
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  atomicJson(RESULT_FILE, { schemaVersion: 1, kind: 'ruvnet-brain-update-result',
    recordedAt: new Date().toISOString(), ...finalOutcome });
  updateOutcomeWritten = true;
  return finalOutcome;
}

// `--check` is a deliberately lightweight, side-effect-free poll: no lock, no rollback preflight, no
// candidate ever built. writeUpdateOutcome() cannot be reused for it — that function always runs
// pruneLifecycleEvidence() (a real filesystem GC pass) and references updateLock/legacyBackupRetention,
// both of which are apply-only concepts. This records ONLY the currency verdict, and only when the
// caller actually asked for a result (--result-file / RUVNET_UPDATE_RESULT) — matching --check's
// existing "does nothing unless asked" contract. S2: this is what lets --apply, bin/install.mjs, and
// the session-start banner read the SAME recorded verdict a --check run (e.g. the SessionStart
// heartbeat's detached poll) already produced, instead of each re-deriving their own comparison.
function writeCheckOutcome(outcome) {
  const finalOutcome = { schemaVersion: 1, kind: 'ruvnet-brain-check-result', mode: 'check',
    recordedAt: new Date().toISOString(), ...outcome };
  if (!RESULT_FILE) return finalOutcome;
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  atomicJson(RESULT_FILE, finalOutcome);
  return finalOutcome;
}

export function acquireUpdateLock({ kbDir = KB_DIR, pid = process.pid, isAlive } = {}) {
  return acquireRefreshLock({ kbDir, brainHome: path.dirname(path.resolve(kbDir)), action: 'update', pid,
    ...(isAlive === undefined ? {} : { isAlive }) });
}

export function releaseUpdateLock(lock = updateLock) {
  if (!lock) return false;
  const released = releaseRefreshLock(lock);
  if (released && lock === updateLock) updateLock = null;
  return released;
}

process.on('exit', () => { releaseUpdateLock(); });
function settleRollback({ reclaimable, keepReason = null, intentionallyRemovedStores = [] }) {
  if (rollbackSettled) return;
  rollbackSettled = true;
  if (!reclaimable) {
    // A rollback copy is only dead weight once the copy in place is known good. When it is NOT,
    // this directory is the user's recovery — deleting it to "not strand resources" would be the
    // far worse bug. Keep it, and say where it is and why.
    for (const b of backupsMade) {
      try { writeSnapshotReceipt(b, { state: 'RETAINED', reason: keepReason || 'live KB could not be verified' }); }
      catch { /* the original update failure remains authoritative */ }
      console.error(`\n  ROLLBACK COPY KEPT: ${b}`);
      console.error(`    ${keepReason || 'the copy now in place could not be verified — restore this directory if the KB is broken,'}`);
      console.error(`    then remove it once you are satisfied (or re-run this updater after fixing the cause).`);
    }
    return;
  }
  const { removed, kept, freed } = reclaimBackups({ kbDir: KB_DIR, backupsMade, intentionallyRemovedStores });
  if (removed.length) {
    console.log(`\nreleased ${removed.length} rollback ${removed.length === 1 ? 'copy' : 'copies'} — ${(freed / 1e9).toFixed(2)} GB reclaimed`);
    console.log(`  (the copy in place is intact; this exact build is re-downloadable at any time)`);
  }
  for (const [b, why] of kept) console.log(`\n  KEPT ${b}\n    ${why}`);
}

function die(msg, code = 1) {
  console.error(`\n[forge-update] ERROR: ${msg}`);
  try { writeUpdateOutcome({ terminalVerdict: 'failed', exitCode: code, reason: msg }); } catch { /* primary error wins */ }
  // Cleanup must never mask the error that caused it.
  try { settleRollback({ reclaimable: false }); } catch { /* ignore */ }
  process.exit(code);
}

if (!fs.existsSync(SOURCE_PATH) && !STAGED_RELEASE_FILE) {
  die(`no SOURCE.json next to this script (${SOURCE_PATH}). This bundle predates the evergreen ` +
      `mechanism or SOURCE.json was removed. Re-download a current bundle to gain self-update.`);
}
let source;
try { source = fs.existsSync(SOURCE_PATH) ? JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf8')) : {}; }
catch (e) {
  // --staged-release never reads this module-level `source` (its own descriptor supplies liveDir/
  // stagedDir explicitly); a corrupt SOURCE.json in whatever directory happens to be current when
  // this script is invoked as a plain recovery executable must not block that rail.
  if (!STAGED_RELEASE_FILE) die(`SOURCE.json is unreadable/corrupt: ${e.message}`);
  source = {};
}

// The RELEASE TAG IS A PROPERTY OF THE BUNDLE, and every store inside it shares that tag (issue
// #108 bug 2). It is written once, at the top level of SOURCE.json; the per-store entries never
// carry it. isBehind() short-circuits on `canon.releaseTag && local.releaseTag`, so with the local
// side always undefined that branch could never fire — every store fell through to a timestamp
// compare against the RELEASE's publish time, which is always later than the forge time of the KB
// inside it. Result: all 15 stores read BEHIND on every run, forever, immediately after a
// successful update. `--check` exited 10 permanently and was useless as a monitoring signal, and
// `--apply` re-downloaded half a gigabyte every night to change nothing. Inheriting the tag the
// bundle already records is the whole fix; a store that carries its own still wins.
// The CORPUS transport tag is a bundle property in exactly the same way, and for the same reason:
// every store in a corpus release arrived in the same archive. It lives in its own field because it
// is a different identity domain from `releaseTag` — see kb/corpus-release-identity.mjs.
const withBundleTag = (s) => {
  if (!s) return s;
  let out = s;
  if (out.releaseTag == null && source.releaseTag != null) out = { ...out, releaseTag: source.releaseTag };
  if (out.corpusReleaseTag == null && source.corpusReleaseTag != null) {
    out = { ...out, corpusReleaseTag: source.corpusReleaseTag };
  }
  return out;
};
const stores = (Array.isArray(source.stores)
  ? source.stores
  : (source.stores && typeof source.stores === 'object')
    ? Object.entries(source.stores).map(([kbName, v]) => ({ kbName, ...v }))
    : [source]).map(withBundleTag);

/**
 * Return only stores the public evergreen updater is allowed to replace.
 *
 * Private deployment overlays still belong in SOURCE.json for provenance, but they do not have a
 * public release asset. `updateManaged: false` keeps those entries visible while preventing a
 * public bundle update from treating them as downloadable targets.
 */
export function selectUpdateManagedStores(allStores, activeProfile = 'complete') {
  const managed = (Array.isArray(allStores) ? allStores : [])
    .filter((store) => store?.updateManaged !== false);
  return activeProfile === 'ruvector'
    ? managed.filter((store) => store.kbName === 'ruvector')
    : managed;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function cardSections(markdown) {
  const sections = new Map();
  const matches = [...String(markdown || '').matchAll(/^## ([^\n]+)\n/gm)];
  for (let index = 0; index < matches.length; index++) {
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? markdown.length;
    sections.set(matches[index][1].trim(), markdown.slice(start, end).trimEnd());
  }
  return sections;
}

function mergePrivateEntries(publicEntries, privateEntries, label) {
  const merged = { ...(publicEntries || {}) };
  for (const [name, entry] of Object.entries(privateEntries || {})) {
    if (Object.hasOwn(merged, name) && !sameJson(merged[name], entry)) {
      throw new Error(`${label} collision for private store ${name}`);
    }
    merged[name] = entry;
  }
  return merged;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function loadTrustedCoverageValidator() {
  // The recovery rail (applyVerifiedStagedRelease) can run from the installer's OWN repo checkout
  // (bin/install.mjs's `REPO_ROOT/kb/forge-update.mjs`) rather than an installed KB tree, where the
  // validator lives at its source location (plugin/scripts/) instead of beside this script.
  const validatorPath = fs.existsSync(path.join(KB_DIR, 'coverage-integrity.mjs'))
    ? path.join(KB_DIR, 'coverage-integrity.mjs')
    : path.join(path.dirname(KB_DIR), 'plugin', 'scripts', 'coverage-integrity.mjs');
  if (!fs.existsSync(validatorPath)) {
    throw new Error('installed coverage validator is missing; re-run the current installer before self-update');
  }
  const validator = await import(pathToFileURL(validatorPath).href);
  if (typeof validator.validateCoverageDirectory !== 'function') {
    throw new Error('installed coverage validator has no validateCoverageDirectory export');
  }
  return validator.validateCoverageDirectory;
}

/**
 * `expectedVersionOverride` is how "never silently install incompatible code" is actually enforced.
 *
 * Read from the tree's OWN SOURCE.json, `expectedVersion` is self-referential: a bundle asserting
 * its own version proves nothing, which is exactly Dual's "preserving a version string alone is
 * insufficient". For a CORPUS release the caller passes the version of the approved runtime this
 * machine is measurably running (kb/corpus-release-identity.mjs re-hashes its executables), so the
 * staged tree is judged against the client, not against itself.
 */
function validateReleaseCoverageTree(root, validateCoverageDirectory, expectedVersionOverride = null) {
  let expectedVersion = expectedVersionOverride;
  if (expectedVersion == null) {
    try { expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE.json'), 'utf8')).brainVersion || null; }
    catch (error) { return { valid: false, failures: [`SOURCE.json is unreadable: ${error.message}`] }; }
  }
  return validateCoverageDirectory(root, { expectedVersion });
}

/**
 * THE PRIVATE-OVERLAY RECOVERY RAIL. Apply an already-authenticated release staged by the installer
 * (bin/install.mjs's stageBundleForRecovery), for installations whose embedded canonicalManifestUrl
 * is dead/missing or whose own updater otherwise cannot complete `main()`'s normal --apply flow.
 * Discovery (which release, which bytes) is supplied by the caller; trust and activation remain
 * owned by this package.
 *
 * ONE APPLY PATH (S1/S2): this reuses the exact same primitives main() uses for a normal apply —
 * runStorageTransaction for the atomic candidate/rollback swap, restorePrivateFilesIntoCandidate for
 * copying the private overlay onto the candidate, and recordCorpusTransportIdentity/
 * recordCorpusGenerationIdentity for the currency stamps — rather than a second, parallel
 * implementation of "how a private overlay survives an apply." It exists as a SEPARATE ENTRY POINT
 * because it solves a different problem (recovery when the normal polling path cannot run at all,
 * not a routine currency check), not because it needs its own apply mechanics.
 */
export async function applyVerifiedStagedRelease({
  stagedDir, liveDir, bundlePath, signaturePath, transactionId = `${Date.now()}-${process.pid}`,
  trustedRuntimeDir = KB_DIR, expectedRuntimeVersion = null, releaseTag = null, corpusGeneration = null,
  bundleSha256 = null, packageIdentity = null, stageReceiptPath = `${stagedDir}.staged-release.json`,
  validateCoverageDirectory = null,
}) {
  const staged = path.resolve(stagedDir);
  const live = path.resolve(liveDir);
  if (!bundlePath || !signaturePath) throw new Error('staged recovery requires bundle and detached signature paths');
  const signature = verifyDownloadedBundle(path.resolve(bundlePath), path.resolve(signaturePath));
  if (!signature.ok) throw new Error(`staged release signature verification failed: ${signature.reason}`);
  const actualBundleSha256 = sha256File(path.resolve(bundlePath));
  if (bundleSha256 && actualBundleSha256 !== bundleSha256) {
    throw new Error(`staged release bundle digest ${actualBundleSha256} differs from sealed identity ${bundleSha256}`);
  }
  if (packageIdentity != null && typeof packageIdentity !== 'string') {
    throw new Error('staged recovery packageIdentity must be an immutable string');
  }
  if (!expectedRuntimeVersion || typeof expectedRuntimeVersion !== 'string') {
    throw new Error('staged recovery requires the expected approved runtime version');
  }
  if (path.resolve(trustedRuntimeDir) !== KB_DIR) {
    throw new Error('staged recovery trust root must be the executing package root');
  }
  const stageReceiptFile = path.resolve(stageReceiptPath);
  if (!fs.existsSync(stageReceiptFile)) throw new Error('staged recovery authentication receipt is missing');
  const stageReceipt = JSON.parse(fs.readFileSync(stageReceiptFile, 'utf8'));
  if (stageReceipt.bundleSha256 !== actualBundleSha256) {
    throw new Error('staged recovery directory is not bound to the signed bundle');
  }
  // The receipt is diagnostic only: bind the candidate cryptographically by independently
  // extracting the authenticated archive and comparing the complete staged tree identity.
  const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-staged-proof-'));
  try {
    await extractZip(path.resolve(bundlePath), proofRoot);
    const nested = path.join(proofRoot, 'ruvnet-brain');
    if (fs.existsSync(path.join(nested, 'forge-mcp-all.mjs'))) {
      for (const entry of fs.readdirSync(nested)) fs.renameSync(path.join(nested, entry), path.join(proofRoot, entry));
      fs.rmdirSync(nested);
    }
    const trustedValidator = fs.existsSync(path.join(KB_DIR, 'coverage-integrity.mjs')) ? path.join(KB_DIR, 'coverage-integrity.mjs')
      : path.join(path.dirname(KB_DIR), 'plugin', 'scripts', 'coverage-integrity.mjs');
    fs.copyFileSync(trustedValidator, path.join(proofRoot, 'coverage-integrity.mjs'));
    const runtimeIdentity = path.join(live, 'RUNTIME-IDENTITY.json');
    if (fs.existsSync(runtimeIdentity)) fs.copyFileSync(runtimeIdentity, path.join(proofRoot, 'RUNTIME-IDENTITY.json'));
    if (releaseTag) recordCorpusTransportIdentity(proofRoot, { releaseTag });
    // Validator/runtime identity are installer-owned bindings added after extraction. Compare the
    // authenticated archive projection while excluding those two local files.
    const archiveIdentity = (root) => {
      const identity = treeIdentity(root);
      const entries = identity.entries.filter((entry) => !['coverage-integrity.mjs', 'RUNTIME-IDENTITY.json'].includes(entry.path));
      return { sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
        bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0), fileCount: entries.filter((e) => e.type === 'file').length };
    };
    const stagedIdentity = archiveIdentity(staged);
    const proofIdentity = archiveIdentity(proofRoot);
    if (stagedIdentity.sha256 !== proofIdentity.sha256 || stagedIdentity.bytes !== proofIdentity.bytes || stagedIdentity.fileCount !== proofIdentity.fileCount) {
      throw new Error('staged recovery directory bytes differ from independently extracted signed bundle');
    }
  } finally { fs.rmSync(proofRoot, { recursive: true, force: true }); }
  for (const [dir, label] of [[staged, 'staged release'], [live, 'live KB']]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a trusted directory: ${dir}`);
  }
  const validator = validateCoverageDirectory || await loadTrustedCoverageValidator();
  const stagedCoverage = validateReleaseCoverageTree(staged, validator, expectedRuntimeVersion);
  if (!stagedCoverage.valid) throw new Error(`staged ReleaseCoverage failed integrity: ${stagedCoverage.failures.join('; ')}`);
  const liveSource = JSON.parse(fs.readFileSync(path.join(live, 'SOURCE.json'), 'utf8'));
  const liveStores = Array.isArray(liveSource.stores)
    ? liveSource.stores
    : Object.entries(liveSource.stores || {}).map(([kbName, value]) => ({ kbName, ...value }));
  const overlay = capturePrivateOverlayState({ kbDir: live, allStores: liveStores });
  const prepareCandidate = ({ candidateDir, liveDir }) => {
    for (const name of ['coverage-integrity.mjs']) {
      const trusted = fs.existsSync(path.join(KB_DIR, name)) ? path.join(KB_DIR, name)
        : path.join(path.dirname(KB_DIR), 'plugin', 'scripts', name);
      if (!fs.existsSync(trusted)) throw new Error(`trusted staged recovery runtime file is missing: ${name}`);
      const trustedStat = fs.lstatSync(trusted);
      if (!trustedStat.isFile() || trustedStat.isSymbolicLink()) throw new Error(`trusted staged recovery runtime file is not a regular package file: ${name}`);
      fs.copyFileSync(trusted,
        assertNoFollowPath(candidateDir, path.join(candidateDir, name)));
    }
    const runtimeIdentity = path.join(liveDir, 'RUNTIME-IDENTITY.json');
    if (!fs.existsSync(runtimeIdentity)) throw new Error('trusted staged recovery runtime file is missing: RUNTIME-IDENTITY.json');
    const runtime = JSON.parse(fs.readFileSync(runtimeIdentity, 'utf8'));
    if (runtime.brainVersion !== expectedRuntimeVersion) throw new Error('installed runtime identity differs from the approved recovery runtime');
    fs.copyFileSync(assertNoFollowPath(liveDir, runtimeIdentity),
      assertNoFollowPath(candidateDir, path.join(candidateDir, 'RUNTIME-IDENTITY.json')));
    // The candidate keeps the BUNDLE's fence; restorePrivateOverlayState adds the restored private
    // names to it. Copying the LIVE fence over it imported every stale entry: measured 2026-09-30, the
    // owner's live fence listed 108 stores, 100 of them public in 4.3.39, so the rail could only fail
    // with "private/public store collision".
    // Same carry main() does: without it the exact-tree swap deleted the live node_modules, and the
    // recovered brain could no longer load its embedder (measured 2026-09-30 on the owner's copy).
    carryLiveNodeModules({ candidateDir, liveDir });
    // S1: ONE APPLY PATH — the same helper main()'s normal apply uses, not a second, duplicated
    // copy-loop. It also adds the collision refusal main() previously lacked.
    restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: liveDir, overlay });
    if (releaseTag) {
      recordCorpusTransportIdentity(candidateDir, { releaseTag });
      // S2: stamped atomically alongside the transport tag, exactly as main()'s prepareCandidate
      // does. This recovery rail's caller does not currently thread a parsed corpus-generation value
      // through (bin/install.mjs's resolveRelease() does not expose the release body it would come
      // from) — passing null here is not a loss of safety: recordCorpusGenerationIdentity's own
      // no-generation branch clears any stale stamp, so the NEXT ordinary --check/--apply reads
      // UNKNOWN (apply allowed, never wrongly REFUSED, never wrongly CURRENT) rather than comparing
      // against a generation this recovered tree does not actually carry.
      recordCorpusGenerationIdentity(candidateDir, { corpusReleaseTag: releaseTag, generation: corpusGeneration });
    }
    const result = validateReleaseCoverageTree(candidateDir, validator, expectedRuntimeVersion);
    if (!result.valid) throw new Error(`candidate public/private convergence failed: ${result.failures.join('; ')}`);
  };
  const validate = ({ dir }) => {
    const result = validateReleaseCoverageTree(dir, validator, expectedRuntimeVersion);
    return result.valid ? { valid: true, failures: [] } : result;
  };
  const lock = acquireUpdateLock({ kbDir: live });
  try {
    const transaction = runStorageTransaction({ liveDir: live, sourceDir: staged, transactionId,
      prepareCandidate, validateCandidate: validate, validateLive: validate });
    return { ...transaction, stagedRelease: { bundleSha256: actualBundleSha256,
      packageIdentity, expectedRuntimeVersion, releaseTag } };
  } finally { releaseUpdateLock(lock); }
}

function validateProfiledReleaseTree(root, profile, overlay) {
  const failures = [];
  try {
    const coverage = JSON.parse(fs.readFileSync(path.join(root, 'COVERAGE.json'), 'utf8'));
    const publicFile = path.join(root, 'PUBLIC-RVF-GENERATIONS.json');
    const publicBytes = fs.readFileSync(publicFile);
    const publicLedger = JSON.parse(publicBytes);
    const runtimeLedger = JSON.parse(fs.readFileSync(path.join(root, 'RVF-GENERATIONS.json'), 'utf8'));
    if (coverage.generationLedger?.file !== 'PUBLIC-RVF-GENERATIONS.json'
      || coverage.generationLedger.sha256 !== createHash('sha256').update(publicBytes).digest('hex')
      || coverage.generationLedger.bytes !== publicBytes.length) failures.push('immutable public ledger differs from ReleaseCoverage');
    const privateNames = new Set(Object.keys(overlay?.sourceStores || {}));
    const expectedPublic = profile === 'ruvector' ? new Set(['ruvector']) : new Set(Object.keys(publicLedger.stores || {}));
    const actualFamilies = new Set(discoverStoreFamilies(root));
    const runtimeNames = Object.keys(runtimeLedger.stores || {}).sort();
    const expectedRuntime = [...expectedPublic, ...privateNames].sort();
    if (JSON.stringify(runtimeNames) !== JSON.stringify(expectedRuntime)) failures.push('profiled runtime ledger store set differs');
    for (const name of expectedPublic) {
      if (JSON.stringify(runtimeLedger.stores?.[name]) !== JSON.stringify(publicLedger.stores?.[name])) {
        failures.push(`profiled runtime public generation differs for ${name}`);
        continue;
      }
      const generation = publicLedger.stores[name];
      const file = path.join(root, String(generation?.file || ''));
      if (!fs.existsSync(file) || fs.statSync(file).size !== generation.bytes || sha256File(file) !== generation.sha256) {
        failures.push(`profiled public RVF differs for ${name}`);
      }
    }
    for (const name of expectedRuntime) if (!actualFamilies.has(name)) failures.push(`profiled store family is missing: ${name}`);
    for (const name of actualFamilies) if (!expectedRuntime.includes(name)) failures.push(`profiled tree has an unselected store family: ${name}`);
  } catch (error) { failures.push(error.message); }
  return { valid: failures.length === 0, failures };
}

function phaseEvidenceFor({ root, terminalVerdict, bundleSha256 = null, transactionReceipts = null,
  overlay = null, storageDelta = null }) {
  const coverage = JSON.parse(fs.readFileSync(path.join(root, 'COVERAGE.json'), 'utf8'));
  const ledgerBytes = fs.readFileSync(path.join(root, 'PUBLIC-RVF-GENERATIONS.json'));
  const currentRows = (coverage.rows || []).filter((row) => row.disposition === 'eligible' && row.status === 'CURRENT');
  const evidence = {
    'source-enumeration': { sourceObservationSha256: coverage.sourceObservationSha256,
      rows: coverage.totals?.rows, terminal: coverage.enumerationReceipt?.terminal === true },
    ingestion: { eligibleCurrent: currentRows.length, storeCount: coverage.generationLedger?.storeCount },
    'local-overlay-restoration': { restoredStores: Object.keys(overlay?.sourceStores || {}).length },
    'generation-ledger-reconciliation': { file: 'PUBLIC-RVF-GENERATIONS.json',
      sha256: createHash('sha256').update(ledgerBytes).digest('hex'), bytes: ledgerBytes.length },
    'coverage-generation': { releaseCoverageGeneration: coverage.releaseCoverageGeneration,
      coverageSha256: sha256File(path.join(root, 'COVERAGE.json')) },
    'bundle-assembly': { bundleSha256, version: coverage.releaseIdentity?.version,
      sourceSnapshot: coverage.releaseIdentity?.sourceSnapshot },
    update: { terminalVerdict, transactionReceipts, storageDelta },
  };
  // A consumer validates a published release; it does not rerun its upstream
  // enumeration, ingestion, or assembly. A recent update cannot freshen that evidence.
  return Object.fromEntries(Object.entries(evidence).map(([phase, detail]) => [phase, { ...detail,
    execution: phase === 'update' || (phase === 'local-overlay-restoration' && overlay !== null)
      ? { kind: 'executed', runId: updateLock?.runId || null }
      : phase === 'local-overlay-restoration'
        ? { kind: 'not-executed' }
        : { kind: 'imported-release', sourceSnapshot: coverage.releaseIdentity?.sourceSnapshot || null,
          upstreamFreshness: 'UNKNOWN' },
  }]));
}

// SYMLINK POLICY IS PER-CALLER (issues #130/#131, fixed 2026-08-10).
//
// This threw on ANY symlink anywhere in the tree. That is exactly right when validating a governed
// store payload — a store file that is a symlink is an attack surface, and PR #124 hardened it for
// good reason. It is exactly WRONG when merely inventorying a backup, because a KB backup contains
// node_modules, and npm's `.bin` entries are ALWAYS symlinks. So the first `.bin/semver` link made
// every backup inventory "incomplete", reclaimBackups() fail closed, and the refusal was permanent
// rather than incidental:
//
//     KEPT kb.bak-… — inventory is incomplete; refusing destructive reclaim
//       (unreadable inventory tree: symbolic link is not a governed regular file: node_modules/…)
//
// Measured consequence on this machine: 63 backups, ~72 GB, every one refused for the same reason,
// growing by ~1.2 GB per nightly run. The refusal was safe and the scope was wrong — a guard that
// can never pass is not protecting anything, it is just leaking disk.
//
// `strict` (the default) keeps the original behaviour for every governed-payload caller. The
// inventory walk opts out — but ONLY for symlinks that cannot be a store file; a symlinked `.rvf`
// still throws, because that is the case the hardening exists for.
function relativeFiles(dir, prefix = '', { strict = true } = {}) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) {
      // A symlinked store file is never acceptable, in either mode.
      if (strict || /\.rvf$/i.test(entry.name)) {
        throw new Error(`symbolic link is not a governed regular file: ${relative}`);
      }
      continue; // ordinary tooling symlink (npm .bin, etc.) — not ours to govern, not ours to follow
    }
    if (entry.isDirectory()) files.push(...relativeFiles(dir, relative, { strict }));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** Snapshot private deployment metadata before a public bundle overwrites shared registry files. */
export function capturePrivateOverlayState({ kbDir, allStores }) {
  const privateSource = Object.fromEntries((Array.isArray(allStores) ? allStores : [])
    .filter((store) => store?.updateManaged === false && store.kbName)
    .map((store) => [store.kbName, { ...store }]));
  const privateNames = new Set(Object.keys(privateSource));
  if (!privateNames.size) return null;

  const generations = JSON.parse(fs.readFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), 'utf8'));
  const aliases = JSON.parse(fs.readFileSync(path.join(kbDir, 'repo-aliases.json'), 'utf8'));
  const privateGenerations = {};
  const privateArtifactFiles = new Set();
  const privateArtifactPrefixes = [];
  for (const name of privateNames) {
    if (!generations.stores?.[name]) throw new Error(`private store ${name} has no RVF generation record`);
    const generation = generations.stores[name];
    if (typeof generation.file !== 'string' || !generation.file.trim()) {
      throw new Error(`private store ${name} has no RVF generation file`);
    }
    const relative = path.normalize(generation.file);
    const resolved = path.resolve(kbDir, relative);
    if (path.isAbsolute(generation.file) || resolved === path.resolve(kbDir)
      || !resolved.startsWith(`${path.resolve(kbDir)}${path.sep}`)) {
      throw new Error(`private store ${name} has unsafe RVF generation file: ${generation.file}`);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`private store ${name} RVF generation file is missing: ${generation.file}`);
    }
    const artifactStat = fs.lstatSync(resolved);
    if (artifactStat.isSymbolicLink()) {
      throw new Error(`private store ${name} RVF generation file is a symbolic link: ${generation.file}`);
    }
    if (!artifactStat.isFile()) {
      throw new Error(`private store ${name} RVF generation file is not a regular file: ${generation.file}`);
    }
    const realKbDir = fs.realpathSync(kbDir);
    const realArtifact = fs.realpathSync(resolved);
    if (!realArtifact.startsWith(`${realKbDir}${path.sep}`)) {
      throw new Error(`private store ${name} RVF generation file resolves outside the KB: ${generation.file}`);
    }
    privateGenerations[name] = generation;
    privateArtifactFiles.add(relative);
    const directory = path.dirname(relative);
    const basename = path.basename(relative);
    const stem = basename.replace(/(?:\.big)?\.rvf$/i, '');
    privateArtifactPrefixes.push({ directory, basename, stem });
  }
  const privateAliases = Object.fromEntries(Object.entries(aliases).filter(([name, values]) =>
    privateNames.has(name)
    || (Array.isArray(values) && values.some((value) => privateNames.has(value)))));
  const privateCardNames = new Set([...privateNames, ...Object.keys(privateAliases)]);
  const cardsFile = path.join(kbDir, 'capability-cards.md');
  const cards = fs.existsSync(cardsFile) ? cardSections(fs.readFileSync(cardsFile, 'utf8')) : new Map();
  const privateCards = Object.fromEntries([...cards].filter(([name]) => privateCardNames.has(name)));
  // INVENTORY walk, not a governed-payload walk (policy above, :319-337): the live root carries the
  // installer's own node_modules/.bin/* symlinks, and the first flagged private store (2026-09-12)
  // turned that into "private overlay preflight failed" on a symlink no store owns. A symlinked
  // `.rvf` still throws inside relativeFiles, and :383-386 re-checks every private artifact.
  const privateFiles = Object.fromEntries(relativeFiles(kbDir, '', { strict: false })
    .filter((relative) => privateArtifactFiles.has(relative)
      || [...privateNames].some((name) => {
      const basename = path.basename(relative);
      return basename === name || basename.startsWith(`${name}.`) || basename.startsWith(`${name}-`);
      })
      || privateArtifactPrefixes.some((artifact) => {
        if (path.dirname(relative) !== artifact.directory) return false;
        const basename = path.basename(relative);
        return basename === artifact.basename
          || basename.startsWith(`${artifact.basename}.`)
          || basename.startsWith(`${artifact.stem}.`)
          || basename.startsWith(`${artifact.stem}-`);
      }))
    .map((relative) => {
      const file = path.join(kbDir, relative);
      return [relative, { bytes: fs.statSync(file).size, sha256: sha256File(file) }];
    }));
  for (const relative of privateArtifactFiles) {
    if (!Object.hasOwn(privateFiles, relative)) {
      throw new Error(`private RVF generation file was not captured: ${relative}`);
    }
  }
  return { sourceStores: privateSource, generationStores: privateGenerations, aliases: privateAliases, cards: privateCards, files: privateFiles };
}

/** Restore private metadata after public extraction, refusing collisions before writing anything. */
export function restorePrivateOverlayState({ kbDir, overlay }) {
  if (!overlay) return { restored: 0 };
  const sourceFile = path.join(kbDir, 'SOURCE.json');
  const generationsFile = path.join(kbDir, 'RVF-GENERATIONS.json');
  const aliasesFile = path.join(kbDir, 'repo-aliases.json');
  const cardsFile = path.join(kbDir, 'capability-cards.md');
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const generations = JSON.parse(fs.readFileSync(generationsFile, 'utf8'));
  // A public bundle may ship no repo-aliases.json at all (build-bundle: "aliases will not resolve"); the
  // private aliases then start from an empty map instead of failing the whole update on ENOENT.
  const aliases = fs.existsSync(aliasesFile) ? JSON.parse(fs.readFileSync(aliasesFile, 'utf8')) : {};
  const mergedSource = mergePrivateEntries(source.stores, overlay.sourceStores, 'SOURCE.json');
  const mergedGenerations = mergePrivateEntries(generations.stores, overlay.generationStores, 'RVF-GENERATIONS.json');
  const mergedAliases = mergePrivateEntries(aliases, overlay.aliases, 'repo-aliases.json');
  for (const [relative, expected] of Object.entries(overlay.files || {})) {
    const file = path.join(kbDir, relative);
    if (!fs.existsSync(file)) throw new Error(`private file missing after update: ${relative}`);
    if (fs.statSync(file).size !== expected.bytes || sha256File(file) !== expected.sha256) {
      throw new Error(`private file changed during public update: ${relative}`);
    }
  }

  // The published capability-cards.md is a sealed input of the derived `concepts` store: its digest
  // is in the release's concepts receipt, and the trusted validator re-hashes it on every candidate and
  // live tree. So the public bytes are kept EXACTLY as extracted and private cards are APPENDED as
  // whole sections after them — never re-serialized in between. Rejoining every section used to put
  // private cards inside the hashed bytes, and every overlay install refused its own update with
  // "derived concepts input receipt differs from capability-cards.md" (measured 2026-09-30).
  const publicCardsText = fs.existsSync(cardsFile) ? fs.readFileSync(cardsFile, 'utf8') : '';
  const publicCards = cardSections(publicCardsText);
  const appendedCards = [];
  // Case-folded, like the trusted validator (coverage-integrity derivedInputIdentity): an appended
  // card whose heading folds onto a published one would fail the sealed-input check, so refuse it here
  // with the collision named instead of writing a tree that cannot validate.
  const publicFolded = new Set([...publicCards.keys()].map((name) => name.toLowerCase()));
  for (const [name, section] of Object.entries(overlay.cards || {})) {
    if (publicCards.has(name)) {
      if (publicCards.get(name) !== section) throw new Error(`capability-cards.md collision for private store ${name}`);
      continue; // already published verbatim
    }
    if (publicFolded.has(name.toLowerCase())) throw new Error(`capability-cards.md collision for private store ${name}`);
    appendedCards.push(section);
  }
  const separator = !publicCardsText ? '' : publicCardsText.endsWith('\n') ? '\n' : '\n\n';
  const mergedCards = appendedCards.length
    ? `${publicCardsText}${separator}${appendedCards.join('\n\n')}\n` : publicCardsText;

  // The candidate's PRIVATE-STORES.json is the PUBLIC bundle's fence. A restored private store the
  // bundle does not fence (a local ingest, or a store the bundle never knew) would leave the runtime
  // ledger with "unclassified stores", so the restored names are added — never removed, and the file
  // is untouched when the bundle already fences them all (a byte-identical re-apply stays a no-op).
  const fenceFile = path.join(kbDir, 'PRIVATE-STORES.json');
  const fence = fs.existsSync(fenceFile) ? JSON.parse(fs.readFileSync(fenceFile, 'utf8')) : { privateStores: [] };
  const fenced = new Set((Array.isArray(fence.privateStores) ? fence.privateStores : []).map((name) => String(name).toLowerCase()));
  const unfenced = Object.keys(overlay.sourceStores || {}).filter((name) => !fenced.has(name.toLowerCase()));

  atomicJson(sourceFile, { ...source, stores: mergedSource });
  atomicJson(generationsFile, { ...generations, stores: mergedGenerations });
  atomicJson(aliasesFile, mergedAliases);
  if (unfenced.length) atomicJson(fenceFile, { ...fence, privateStores: [...(fence.privateStores || []), ...unfenced] });
  if (mergedCards !== publicCardsText) {
    fs.writeFileSync(`${cardsFile}.tmp-${process.pid}`, mergedCards);
    fs.renameSync(`${cardsFile}.tmp-${process.pid}`, cardsFile);
  }
  return { restored: Object.keys(overlay.sourceStores).length };
}

/**
 * ONE APPLY PATH (S1): copy the captured private overlay's artifact files from `sourceDir` (the
 * live tree, still untouched at this point) onto `candidateDir` (the sibling tree
 * `runStorageTransaction` builds from the freshly extracted public bundle), then restore the
 * private registry entries with `restorePrivateOverlayState`.
 *
 * This is the ONLY place production code copies private files into a tree that is about to become
 * live — `bin/install.mjs` and `kb/forge-update.mjs`'s `main()` both call this from inside
 * `prepareCandidate`, before `runStorageTransaction` ever renames anything into place. There used to
 * be a second, parallel implementation (`applyPublicBundlePreservingPrivate`) that operated on a
 * full-tree copy-then-restore-from-backup model; it was never wired into `main()` — the real apply
 * path already used `runStorageTransaction`'s rename-based candidate/rollback machinery — so it was
 * exercised only by its own tests. Deleted rather than kept "for coverage": a second apply path that
 * production code never calls is not a safety net, it is a second implementation to keep in sync
 * (and the one place it silently diverged from the real path is the collision check below, which
 * the real path had NOT been enforcing).
 *
 * Collision detection matters here specifically because it did not previously exist on the real
 * path: `candidateDir` already holds the extracted public bundle's files (built by
 * `fs.cpSync(sourceDir=extractDir, candidateDir, ...)` before `prepareCandidate` runs), so copying a
 * private file over a same-named public one would silently discard the public bytes. Refusing BEFORE
 * copying anything is the assertion `applyPublicBundlePreservingPrivate` had and the real path did
 * not; it is preserved here rather than dropped.
 */
/**
 * node_modules (the ONNX embedder and RVF readers) is installer-placed and never ships inside a
 * bundle. The candidate is validated in a SIBLING directory with no parent node_modules, and the
 * exact-tree swap would delete it from the live KB, so both apply paths carry the LIVE copy across.
 * Reflink clone where the filesystem supports it (APFS/btrfs), plain copy otherwise.
 */
export function carryLiveNodeModules({ candidateDir, liveDir }) {
  const liveModules = path.join(liveDir, 'node_modules');
  if (!fs.existsSync(liveModules) || fs.existsSync(path.join(candidateDir, 'node_modules'))) return false;
  fs.cpSync(assertNoFollowPath(liveDir, liveModules), path.join(candidateDir, 'node_modules'),
    { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  return true;
}

export function restorePrivateFilesIntoCandidate({ candidateDir, sourceDir, overlay }) {
  if (!overlay) return { restored: 0 };
  for (const relative of Object.keys(overlay.files || {})) {
    const target = assertNoFollowPath(candidateDir, path.join(candidateDir, relative));
    if (fs.existsSync(target)) {
      throw new Error(`public bundle collides with private file ${relative}; refusing to copy`);
    }
    const source = assertNoFollowPath(sourceDir, path.join(sourceDir, relative));
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
      throw new Error(`private source file is missing or not regular: ${relative}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return restorePrivateOverlayState({ kbDir: candidateDir, overlay });
}

const manifestUrl = source.canonicalManifestUrl || stores.find((s) => s.canonicalManifestUrl)?.canonicalManifestUrl;
// The recovery rail runs from the npm package's kb/forge-update.mjs, and the package ships no
// kb/SOURCE.json (verified in ruvnet-brain-4.3.39.tgz), so this die() stopped the rail before it began.
if (!manifestUrl && !STAGED_RELEASE_FILE) {
  die(`self-update not configured for this build — SOURCE.json has no canonicalManifestUrl ` +
      `(forge-build.mjs was run without --canonical-url). Provenance is still in SOURCE.json.`);
}

async function fetchJson(url) {
  let res;
  try { res = await fetch(url, { redirect: 'follow' }); }
  catch (e) { die(`network failure fetching ${url}\n  ${e.message} — nothing changed locally.`, 2); }
  if (!res.ok) die(`canonical manifest returned HTTP ${res.status} for ${url} — nothing changed.`, 2);
  try { return await res.json(); } catch (e) { die(`canonical manifest was not valid JSON: ${e.message}`, 2); }
}
async function fetchBuffer(url, { failureCode = 2, kind = 'bundle' } = {}) {
  let res;
  try { res = await fetch(url, { redirect: 'follow' }); }
  catch (e) { die(`network failure downloading ${kind} ${url}\n  ${e.message} — nothing changed locally.`, failureCode); }
  if (!res.ok) die(`${kind} download returned HTTP ${res.status} for ${url} — nothing changed.`, failureCode);
  return Buffer.from(await res.arrayBuffer());
}

// The canonical manifest can be ONE of three shapes — handle all three:
//   1. a forge .last-built.json            ({ generated, stores:{name:{sha,describe}} })
//   2. a SOURCE.json-shaped file           ({ builtUtc, stores:{name:{builtUtc,sourceCommit,...}} })
//   3. a GitHub "releases/latest" payload  ({ tag_name, published_at, target_commitish })
// Shape 3 is what this project actually publishes (the brain ships as a GitHub Release, not as
// committed files), so we detect it by the presence of tag_name and map its fields across.
function isGithubReleasePayload(canon) {
  return Boolean(canon && typeof canon === 'object' && canon.tag_name);
}
function canonicalFor(canon, kbName) {
  if (isGithubReleasePayload(canon)) {
    // The whole Release advances together — every store shares the Release tag + publish time.
    //
    // WHICH IDENTITY DOMAIN the tag belongs to is decided here, once. A `corpus-sha256-<64 hex>`
    // tag is a CONTENT address of a corpus archive; a `vX.Y.Z` tag is the version of a code
    // release. Putting a corpus tag in `releaseTag` makes isBehind() compare a content address
    // against a semver, which can never converge — that is the measured redownload loop
    // (kb/corpus-release-identity.mjs's header records the four-download measurement).
    const corpus = isCorpusReleaseTag(canon.tag_name);
    return {
      builtUtc: canon.published_at || canon.created_at || null,
      // No per-store git sha in a Release payload; use the tag as the version identity instead.
      sourceCommit: null,
      sourceDescribe: canon.tag_name,
      releaseTag: corpus ? null : canon.tag_name,
      corpusReleaseTag: corpus ? canon.tag_name : null,
    };
  }
  const cs = (canon.stores && canon.stores[kbName]) || {};
  return {
    builtUtc: cs.builtUtc || canon.generated || canon.builtUtc || null,
    sourceCommit: cs.sha || cs.sourceCommit || null,
    sourceDescribe: cs.describe || cs.sourceDescribe || null,
    releaseTag: null,
    corpusReleaseTag: null,
  };
}
/** The installed tree's own currency identity, read from its top-level SOURCE.json (`source`). */
export function installedCurrencyIdentity(src) {
  return {
    releaseTag: (src && typeof src.releaseTag === 'string' && src.releaseTag) || null,
    corpusReleaseTag: (src && typeof src.corpusReleaseTag === 'string' && src.corpusReleaseTag) || null,
    corpusGeneration: (src && typeof src.corpusGeneration === 'string' && src.corpusGeneration) || null,
  };
}

/**
 * The CANDIDATE's currency identity, derived from the live manifest/Release payload `main()` already
 * fetched — BEFORE any download. `--check` never downloads, so this is the only data a verdict can
 * ever be computed from pre-download; `--apply` deliberately reuses this exact same decision rather
 * than a second, download-time comparison (the same "decide once, from the live fetch" discipline
 * `resolveBundleUrl`/`verifyLanded` already apply elsewhere in this file).
 */
export function candidateCurrencyIdentity(canon) {
  if (!isGithubReleasePayload(canon)) {
    // A forge `.last-built.json` or SOURCE.json-shaped manifest (shapes 1/2 — see the comment above
    // `isGithubReleasePayload`). Neither carries a code or corpus release tag, so there is no ordering
    // key to compare by. This project in practice ships shape 3 only.
    return { kind: 'other', tag: null, corpusReleaseTag: null, corpusGeneration: null, corpusGenerationEpoch: null };
  }
  const tag = canon.tag_name;
  const kind = releaseKind(tag);
  // The generation ordering key travels in the release's own body/notes — the same
  // `Corpus generation:` line scripts/corpus-promotion.mjs already treats as the sole author-side
  // ordering key for `releases/latest` promotion (never a locally-observed timestamp). `canon` is
  // already the live, freshly-fetched Release payload from GitHub's API, the same trust boundary this
  // file already extends to `canon.tag_name`/`canon.assets[]` — reusing its `body` field costs no
  // extra network round trip and is available to `--check`, which never downloads the archive itself.
  const parsed = kind === 'corpus' ? parseCorpusGeneration(canon.body) : null;
  return {
    kind,
    tag: tag || null,
    corpusReleaseTag: kind === 'corpus' ? tag : null,
    corpusGeneration: parsed ? parsed.value : null,
    corpusGenerationEpoch: parsed ? parsed.epoch : null,
  };
}

/**
 * ONE CURRENCY VERDICT (S2). Replaces isBehind()'s three ad hoc fallback tiers (releaseTag ->
 * builtUtc -> sourceCommit) with one explicit decision per release channel, made from an ordering key
 * — NEVER a locally-observed timestamp. isBehind()'s builtUtc/sourceCommit tiers compared the
 * candidate's PRE-FETCH manifest timestamp (a Release's publish time, always later than the KB inside
 * it was forged) against the installed copy's own forge time — the exact redownload loop measured in
 * this file's header and in kb/corpus-release-identity.mjs's header. That comparison is deleted
 * outright here, not preserved as a fallback tier.
 *
 * @param {{releaseTag: string|null, corpusReleaseTag: string|null, corpusGeneration: string|null}} installed
 * @param {{kind: 'code'|'corpus'|'other', tag: string|null, corpusReleaseTag: string|null, corpusGeneration: string|null, corpusGenerationEpoch: number|null}} candidate
 * @returns {{verdict: 'CURRENT'|'UPDATE_AVAILABLE'|'UNKNOWN'|'REFUSED', reason: string}}
 *
 *   CURRENT           the candidate is exactly what is already installed.
 *   UPDATE_AVAILABLE  the candidate genuinely supersedes what is installed.
 *   UNKNOWN           no ordering key can be verified in either direction — e.g. today's 4.3.22-era
 *                     installs, which carry no corpus generation stamp at all. NEVER refused, NEVER
 *                     reported current: apply is allowed to proceed (main() treats it exactly like
 *                     UPDATE_AVAILABLE for control flow; only the RECORDED verdict differs).
 *   REFUSED           the candidate is a corpus generation strictly OLDER than the one installed —
 *                     rollback protection. main() leaves the live tree untouched and exits 0.
 */
export function currencyVerdict(installed, candidate) {
  if (candidate.kind === 'code') {
    if (candidate.tag && candidate.tag === installed.releaseTag) {
      return { verdict: 'CURRENT', reason: `code release ${candidate.tag} is already installed` };
    }
    // A code release supersedes whatever is installed, corpus or code — its bundle IS the corpus
    // (recordCorpusTransportIdentity's own rationale). Code tags are owner-sequenced semver, not a
    // content address, so there is no "candidate is older" ambiguity to protect against here.
    return { verdict: 'UPDATE_AVAILABLE',
      reason: `code release ${candidate.tag || '(unknown)'} supersedes ${installed.releaseTag || '(none)'}` };
  }
  if (candidate.kind === 'corpus') {
    if (candidate.tag && candidate.tag === installed.corpusReleaseTag) {
      return { verdict: 'CURRENT', reason: `corpus generation ${candidate.tag} is already installed` };
    }
    if (installed.corpusGeneration == null) {
      return { verdict: 'UNKNOWN',
        reason: 'installed tree carries no verifiable corpus generation stamp; cannot prove direction' };
    }
    const installedEpoch = Date.parse(installed.corpusGeneration);
    if (!Number.isFinite(installedEpoch)) {
      return { verdict: 'UNKNOWN', reason: 'installed corpus generation stamp is unparseable' };
    }
    if (candidate.corpusGeneration == null) {
      // The candidate's own published record carries no readable ordering key — fall back to
      // transport identity. Tag equality was already ruled out above, so a differing tag is still
      // real evidence that something changed.
      return { verdict: 'UPDATE_AVAILABLE',
        reason: `candidate ${candidate.tag} carries no generation identity; falling back to transport tag (differs from installed ${installed.corpusReleaseTag || '(none)'})` };
    }
    if (candidate.corpusGenerationEpoch < installedEpoch) {
      return { verdict: 'REFUSED',
        reason: `candidate corpus generation ${candidate.corpusGeneration} predates installed generation ${installed.corpusGeneration} — refusing to move backward` };
    }
    return { verdict: 'UPDATE_AVAILABLE',
      reason: `corpus generation ${candidate.corpusGeneration} supersedes installed ${installed.corpusGeneration}` };
  }
  // No recognizable release identity at all — never fall back to a locally-observed builtUtc/
  // sourceCommit timestamp (the exact bug this function replaces).
  return { verdict: 'UNKNOWN', reason: 'candidate carries no recognizable release identity (neither a code tag nor a corpus tag)' };
}
function short(s) { return s ? String(s).slice(0, 12) : '(none)'; }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function assertNoFollowPath(root, target) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  const relative = path.relative(rootPath, targetPath);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`path escapes KB root: ${target}`);
  }
  const rootStat = fs.lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`KB root is not a real directory: ${root}`);
  let current = rootPath;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`symlink destination is not allowed: ${path.relative(rootPath, current)}`);
  }
  return targetPath;
}

function copyTree(srcDir, dstDir, root = dstDir, prefix = '') {
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) throw new Error(`source bundle contains a symbolic link: ${path.join(prefix, ent.name)}`);
    const relative = path.join(prefix, ent.name);
    const s = path.join(srcDir, ent.name), d = assertNoFollowPath(root, path.join(dstDir, ent.name));
    if (ent.isDirectory()) { if (!fs.existsSync(d)) fs.mkdirSync(d); copyTree(s, d, root, relative); }
    else { if (!fs.existsSync(path.dirname(d))) fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
  }
}

/** Authoritative store identities in a directory, with recursive `.rvf` fallback for old backups. */
function storeInventory(dir) {
  const stores = new Map();
  const logical = new Map();
  const declaredFiles = new Set();
  let complete = true;
  let reason = null;
  const generationFile = path.join(dir, 'RVF-GENERATIONS.json');
  const hasGenerationFile = fs.existsSync(generationFile);
  try {
    const generations = JSON.parse(fs.readFileSync(generationFile, 'utf8'));
    for (const [name, generation] of Object.entries(generations.stores || {})) {
      if (typeof generation?.file !== 'string' || !generation.file.trim() || path.isAbsolute(generation.file)) {
        complete = false; reason = `invalid generation path for ${name}`; continue;
      }
      const root = path.resolve(dir);
      const file = path.resolve(root, path.normalize(generation.file));
      if (file === root || !file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) {
        complete = false; reason = `missing or escaping generation file for ${name}`; continue;
      }
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        complete = false; reason = `non-regular generation file for ${name}`; continue;
      }
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(file);
      if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
        complete = false; reason = `generation file escapes root for ${name}`; continue;
      }
      // Key by the governed artifact path, not by whether this particular generation metadata
      // happened to declare it. Older backups can contain a valid local RVF as an undeclared
      // fallback while the live KB declares the same bytes under a logical store name. Treating
      // those as `file:<path>` versus `store:<name>` made one physical artifact look missing and
      // permanently retained every full-KB rollback copy.
      stores.set(path.normalize(generation.file), generation.file);
      logical.set(name, path.normalize(generation.file));
      declaredFiles.add(generation.file);
    }
  } catch (error) {
    if (hasGenerationFile) { complete = false; reason = `unreadable RVF-GENERATIONS.json: ${error.message}`; }
  }
  try {
    // Inventory only: tolerate ordinary tooling symlinks (npm .bin). A symlinked .rvf still throws.
    const files = relativeFiles(dir, '', { strict: false });
    for (const relative of files.filter((name) => name.endsWith('.rvf'))) {
      if (!declaredFiles.has(relative)) {
        stores.set(path.normalize(relative), relative);
      }
    }
    const legacyMetadata = new Set([
      'SOURCE.json', 'repo-aliases.json', 'capability-cards.md', 'package.json', 'package-lock.json',
      'forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
      'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'manifest.json',
      'coverage-integrity.mjs', 'COVERAGE.json', 'CORPUS-COVERAGE.json', 'COVERAGE.md',
      '.refresh-snapshot.json',
      // ADR-086 step 16: the updater's own module graph grew one file, and the installer now writes
      // one record beside the validator it already wrote. Both are metadata, not user stores —
      // omitting them here would make a legacy KB read as "unclassified non-RVF files" and refuse.
      'corpus-release-identity.mjs', 'RUNTIME-IDENTITY.json',
    ]);
    if (!hasGenerationFile && files.some((name) => !name.endsWith('.rvf') && !legacyMetadata.has(path.basename(name)))) {
      complete = false; reason = 'legacy inventory contains unclassified non-RVF files';
    }
  } catch (error) {
    complete = false; reason = `unreadable inventory tree: ${error.message}`;
  }
  return { stores, logical, complete, reason };
}

/** Recursive byte size, for honestly reporting how much was actually reclaimed. */
function dirSize(dir) {
  try { if (fs.lstatSync(dir).isSymbolicLink()) return fs.lstatSync(dir).size; }
  catch { return 0; }
  let total = 0;
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { total += fs.lstatSync(p).size; } catch { /* vanished mid-walk */ } }
    }
  };
  walk(dir);
  return total;
}

// A backup-looking name and matching RVF paths are not evidence that its other
// bytes are disposable. Legacy backups have no authenticated complete ownership
// receipt: reclaim only a tree whose every entry survives identically in live.
function assertRedundantBackup(backup, live) {
  const compare = (prior, current) => {
    const a = fs.lstatSync(prior);
    const b = fs.lstatSync(current);
    if (a.isSymbolicLink() || b.isSymbolicLink()) {
      // Compare links themselves, never dereference them. Store symlinks are
      // already rejected by storeInventory; identical tooling links are safe.
      if (!a.isSymbolicLink() || !b.isSymbolicLink() || fs.readlinkSync(prior) !== fs.readlinkSync(current)) {
        throw new Error(`unclassified or different symbolic link: ${prior}`);
      }
    } else if (a.isDirectory() && b.isDirectory()) {
      for (const name of fs.readdirSync(prior)) compare(path.join(prior, name), path.join(current, name));
    } else if (a.isFile() && b.isFile()) {
      if (a.size !== b.size || sha256File(prior) !== sha256File(current)) {
        throw new Error(`different bytes: ${prior}`);
      }
    } else throw new Error(`unclassified or different entry type: ${prior}`);
  };
  compare(backup, live);
}

function rollbackRetentionPolicy(kbDir, env = process.env) {
  const liveBytes = dirSize(kbDir);
  const configuredSnapshots = Number(env.RUVNET_MAX_ROLLBACK_SNAPSHOTS || 1);
  const configuredBytes = Number(env.RUVNET_MAX_ROLLBACK_BYTES || liveBytes);
  if (!Number.isSafeInteger(configuredSnapshots) || configuredSnapshots < 0
      || !Number.isSafeInteger(configuredBytes) || configuredBytes < 0) {
    throw new Error('rollback retention limits must be non-negative safe integers');
  }
  return { maxSnapshots: configuredSnapshots, maxBytes: configuredBytes, requiredSnapshotBytes: liveBytes };
}

function snapshotInventoryDigest(dir) {
  const inventory = storeInventory(dir);
  if (!inventory.complete) throw new Error(`snapshot inventory is incomplete (${inventory.reason || 'unknown'})`);
  const rows = [...inventory.stores].sort(([left], [right]) => left.localeCompare(right)).map(([identity, file]) => {
    const absolute = path.join(dir, file);
    return { identity, file, bytes: fs.statSync(absolute).size, sha256: sha256File(absolute) };
  });
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function writeSnapshotReceipt(backupPath, { state, reason = null, recoveryCommand = null }) {
  const file = path.join(backupPath, '.refresh-snapshot.json');
  const receipt = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-rollback-snapshot',
    snapshot: path.basename(backupPath),
    bytes: dirSize(backupPath),
    inventorySha256: snapshotInventoryDigest(backupPath),
    state,
    reason,
    recoveryCommand: recoveryCommand || `restore ${backupPath} to ${KB_DIR}`,
    updatedAt: new Date().toISOString(),
  };
  atomicJson(file, receipt);
  return receipt;
}

/**
 * Release rollback copies after the new KB has verified (issue #35, Dr. Mark Allen).
 *
 * Exported and pure-ish because it DELETES MULTI-GIGABYTE DIRECTORIES — a bug here destroys user
 * data, so it is tested directly rather than exercised only through a full update run.
 *
 * Refuses to delete any backup holding a `.rvf` store the live KB does not have. That is the
 * private/local-store case: the public bundle does not ship those, the update replaces the directory,
 * and forge-guard still passes because it verifies the store it was asked about — not what went
 * missing. In that situation the backup is the only surviving copy, so it is kept and reported.
 *
 * @returns {{removed: string[], kept: [string, string][], freed: number}}
 */
/**
 * WHY a guard run failed. forge-guard prints its `[FAIL] ...` lines to STDOUT, and execFileSync puts only
 * STDERR in error.message, so a refused store used to read "Command failed: node .../forge-guard.mjs --name X"
 * with the cause dropped (measured 2026-09-30: the customer canary refused a generation and its log did not
 * say why). Keep the command line, then append the guard's own FAIL lines.
 */
export function describeGuardFailure(error) {
  const text = (value) => (value == null ? '' : Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
  const fails = `${text(error?.stdout)}\n${text(error?.stderr)}`.split('\n')
    .map((line) => line.trim()).filter((line) => /\[FAIL\]|Error:/.test(line));
  // Keep the WHOLE message: execFileSync appends the child's stderr on the lines after the command line.
  const message = String(error?.message || error);
  const extra = fails.filter((line) => !message.includes(line));
  const cause = extra.length ? ` -- ${extra.join(' | ').slice(0, 800)}` : '';
  return `${message.slice(0, 1600)}${cause}`;
}

export function reclaimBackups({
  kbDir,
  backupsMade = [],
  env = process.env,
  intentionallyRemovedStores = [],
  dryRun = false,
}) {
  const parent = path.dirname(kbDir);
  // Older updater and recovery paths used three different names for the same full-KB rollback
  // copy. Sweeping only `kb.bak-*` left those copies outside retention, which is how issue #235
  // accumulated 74 directories / 129 GiB. Keep the allowlist narrow: these are exact historical
  // names owned by this updater, and unrelated siblings must remain untouched.
  //
  // `.install-preserved-` (bin/install.mjs) is the installer's copy of the whole prior generation.
  // It was "not eligible for automatic cleanup" by name alone, so it outlived every proof that could
  // have released it — measured 2026-09-11: a 1.2 GB brain held three times on one machine. It is a
  // candidate under EXACTLY the same redundancy proof as every other copy: never deleted unless
  // every byte survives in the live brain.
  const base = path.basename(kbDir);
  const prefixes = [
    `${base}.bak-`,
    `${base}.pre-reset-backup-`,
    `${base}.agent-harness-generator-backup-`,
    `${base}-pre-gap-rebuild-backup-`,
    `${base}.install-preserved-`,
  ];
  const prefixFor = (entry) => prefixes.find((prefix) => entry.startsWith(prefix)) || null;
  let stranded = [];
  try { stranded = fs.readdirSync(parent).filter((n) => prefixFor(n)).map((n) => path.join(parent, n)); }
  catch { /* unreadable parent — nothing to sweep */ }

  const all = [...new Set([...backupsMade, ...stranded])];
  const removed = []; const wouldRemove = []; const kept = []; let freed = 0;
  const safePreserved = new Map();
  const retentionPolicy = rollbackRetentionPolicy(kbDir, env);
  const liveInventory = storeInventory(kbDir);

  // A store the live release's own COVERAGE.json marks ineligible is absent from live BY POLICY
  // (excluded-no-corpus, fork, archived…), not lost by an update; its presence in a backup must not
  // pin that backup forever. Only rows with a non-eligible disposition qualify — an eligible row that
  // merely has no artifact (MISSING) is not a decision to drop the store.
  const readJsonQuietly = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const coverageRows = readJsonQuietly(path.join(kbDir, 'COVERAGE.json'))?.rows;
  const policyExcluded = (Array.isArray(coverageRows) ? coverageRows : [])
    .filter((row) => row && row.kind === 'repository' && row.disposition && row.disposition !== 'eligible')
    .map((row) => String(row.artifact?.store || row.name || '').toLowerCase()).filter(Boolean);
  // PRIVATE-fenced stores (PRIVATE-STORES.json, read from live AND from the backup itself, since a
  // backup knows what was private when it was made) are never disposable: a backup holding one the
  // live brain lacks is the only copy outside the fence. It is pinned and reported by name, and no
  // caller can authorize it away through `intentionallyRemovedStores`.
  const fencedNames = (dirs) => new Set(dirs.flatMap((dir) => {
    const list = readJsonQuietly(path.join(dir, 'PRIVATE-STORES.json'))?.privateStores;
    return Array.isArray(list) ? list.map((name) => String(name).toLowerCase()) : [];
  }));
  const storeStem = (file) => path.basename(String(file)).replace(/(?:\.big)?\.rvf$/i, '').toLowerCase();
  // Retaining a copy is safe for the NEXT update only when every entry is measured: regular files,
  // plus symlinks that cannot be a store file AND stay inside the copy (npm's `.bin` links — the
  // installed brain always carries `node_modules/.bin/semver -> ../semver/bin/semver.js`). A link
  // that escapes the tree is not measured — its target is what a receipt would silently be counting
  // — and stays a blocker, exactly as before. A symlinked `.rvf` already fails the inventory above.
  const pinnedPrivate = new Set();
  const markMeasured = (b) => {
    try {
      const identity = treeIdentity(b);
      const root = path.resolve(b);
      const measured = identity.entries.every((entry) => {
        if (entry.type === 'file') return true;
        if (entry.type !== 'symlink' || /\.rvf$/i.test(entry.path) || path.isAbsolute(entry.target)) return false;
        const relative = entry.path.split('/').join(path.sep);
        return path.resolve(root, path.dirname(relative), entry.target).startsWith(`${root}${path.sep}`);
      });
      if (measured) safePreserved.set(b, identity.bytes);
    } catch { /* retained, but not safe to proceed past recovery preflight */ }
  };

  for (const b of all) {
    if (!fs.existsSync(b)) continue;
    if (env.RUVNET_KEEP_BACKUP === '1') { kept.push([b, 'RUVNET_KEEP_BACKUP=1 is set']); continue; }
    try {
      if (path.dirname(path.resolve(b)) !== path.resolve(parent) || !prefixFor(path.basename(b))) {
        throw new Error('target is not an exact backup sibling');
      }
      for (const dir of [parent, kbDir, b]) {
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`not a real directory: ${dir}`);
      }
    } catch (error) { kept.push([b, `unsafe reclaim target: ${error.message}`]); continue; }
    const backupInventory = storeInventory(b);
    if (!liveInventory.complete || !backupInventory.complete) {
      kept.push([b, `inventory is incomplete; refusing destructive reclaim (${backupInventory.reason || liveInventory.reason || 'unknown'})`]);
      continue;
    }
    const privateNames = fencedNames([kbDir, b]);
    const removedStores = [...new Set([...intentionallyRemovedStores, ...policyExcluded])]
      .filter((store) => !privateNames.has(String(store).toLowerCase()));
    const allowedMissing = new Set(removedStores.flatMap((store) => [`${store}.rvf`, `${store}.big.rvf`])
      .map((file) => path.normalize(file)));
    for (const store of removedStores) {
      const governedPath = backupInventory.logical.get(store);
      if (governedPath) allowedMissing.add(governedPath);
    }
    const lost = [...backupInventory.stores].filter(([identity]) => !liveInventory.stores.has(identity) && !allowedMissing.has(identity));
    const identityNames = new Map();
    for (const [name, identity] of backupInventory.logical) {
      identityNames.set(identity, [...(identityNames.get(identity) || []), String(name).toLowerCase()]);
    }
    const isFenced = ([identity, file]) => (identityNames.get(identity) || []).some((name) => privateNames.has(name))
      || privateNames.has(storeStem(file));
    const lostOther = lost.filter((entry) => !isFenced(entry));
    const lostPrivate = lost.filter(isFenced);
    if (lostOther.length) {
      const labels = lostOther.map(([, file]) => file);
      const privateNote = lostPrivate.length ? `; also pins PRIVATE: ${lostPrivate.map(([, file]) => file).join(', ')}` : '';
      kept.push([b, `it holds ${lostOther.length} store(s) the new copy does NOT have: ${labels.slice(0, 3).join(', ')}${lostOther.length > 3 ? '…' : ''}${privateNote}`]);
      continue;
    }
    if (lostPrivate.length) {
      const labels = lostPrivate.map(([, file]) => file);
      kept.push([b, `PRIVATE store(s) pinned — the only copy outside the fence: ${labels.join(', ')}; retained, never reclaimed automatically`]);
      pinnedPrivate.add(b);
      markMeasured(b);
      continue;
    }
    try { assertRedundantBackup(b, kbDir); }
    catch (error) {
      kept.push([b, `PRESERVED_UNCLASSIFIED: complete byte redundancy is not proven; ${error.message}`]);
      // Preservation does not itself require blocking an isolated transaction. Only a measured
      // inventory establishes safe retention; missing stores, unsafe roots and unreadable bytes
      // remain blockers.
      markMeasured(b);
      continue;
    }
    const size = dirSize(b);
    if (dryRun) { wouldRemove.push(b); freed += size; continue; }
    try { fs.rmSync(b, { recursive: true, force: true }); removed.push(b); freed += size; }
    catch (e) { kept.push([b, `could not remove: ${e.message}`]); }
  }
  const retained = all.filter((backup) => fs.existsSync(backup) && !wouldRemove.includes(backup)).map((backup) => {
    let inventorySha256 = null;
    let inventoryError = null;
    try {
      if (fs.lstatSync(backup).isSymbolicLink()) throw new Error('backup root is a symbolic link');
      inventorySha256 = snapshotInventoryDigest(backup);
    }
    catch (error) { inventoryError = error.message; }
    return { path: backup, bytes: safePreserved.get(backup) ?? dirSize(backup), inventorySha256, inventoryError,
      safeToRetainDuringUpdate: safePreserved.has(backup), automaticCleanupEligible: false,
      retention: pinnedPrivate.has(backup) ? 'private-pinned' : safePreserved.has(backup) ? 'unclassified' : 'unmeasured' };
  });
  const retainedBytes = retained.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  const retention = { ...retentionPolicy, observedSnapshots: retained.length, observedBytes: retainedBytes,
    withinBudget: retained.length <= retentionPolicy.maxSnapshots && retainedBytes <= retentionPolicy.maxBytes };
  // Two facts, kept apart. `blockingRetained` is what an update must not proceed past: a copy that is
  // unmeasured or holds a store nothing accounts for — and, over budget, any copy retained for no
  // stated reason (an unclassified one), which is the existing contract (data-safety tests) and stays.
  // The ONE exemption is a copy pinned for an accounted reason — a fenced PRIVATE store the live
  // brain lacks: it is user data, measured, and named; exceeding the budget with it is reported as
  // `overBudget`, not treated as unresolved rollback state, because this update adds no persistent
  // copy of its own.
  const blockingRetained = retained.filter((entry) => !entry.safeToRetainDuringUpdate
    || (!retention.withinBudget && entry.retention !== 'private-pinned'));
  const overBudget = retention.withinBudget ? null : { snapshots: retained.length, maxSnapshots: retentionPolicy.maxSnapshots,
    bytes: retainedBytes, maxBytes: retentionPolicy.maxBytes };
  return { removed, wouldRemove, dryRun, kept, freed, retained, blockingRetained, overBudget,
    retentionPolicy: retention, withinBudget: retention.withinBudget,
    updateMayProceed: retention.withinBudget && retained.every((entry) => entry.safeToRetainDuringUpdate) };
}

/**
 * Decide which URL to actually download the replacement bundle from (issue #35 item 1, Dr. Mark
 * Allen / @mamd69).
 *
 * The OLD code (line 218 before this fix) always used `local.canonicalBundleUrl` — the URL
 * literally written into the copy of SOURCE.json that is BEING REPLACED. That value can only ever
 * point BACKWARD: it was correct on the day this copy was forged, and every day after is a day it
 * could go stale. Mark's machine re-downloaded the same June v0.5.0-dev asset for three weeks
 * because that pinned URL never moved even though newer releases existed on GitHub the whole time.
 *
 * This resolves the URL from `canon` — the live "latest release" (or manifest) payload `main()`
 * already fetched fresh, moments ago, over the network — instead of the stale local copy:
 *   - Shape 3 (a GitHub `releases/latest` payload — what this project actually publishes): the
 *     release carries real `assets[]` with `browser_download_url`s that GitHub resolves NOW, not
 *     whatever was true when this local copy was built. Prefer the asset whose name matches the
 *     pinned URL's basename; this project in practice ships ONE combined zip per release (not one
 *     per KB store, despite forge-build.mjs's per-store naming convention — the two drifted apart),
 *     so if there's exactly one `.zip` asset and no name match, that unambiguous single zip IS it.
 *   - Shape 1/2 (a forge `.last-built.json` or SOURCE.json-shaped manifest): these can carry the
 *     same `canonicalBundleUrl` field per store, but THIS copy was just fetched fresh over the
 *     network, so it reflects the manifest's CURRENT contents — still a live resolution, not a
 *     pinned local guess.
 *   - Only when neither live source resolves an asset does this fall back to the URL pinned in the
 *     local SOURCE.json — and it says so. Falling back to that value SILENTLY is issue #35 item 3
 *     (the "known-good" bundle applied with zero warning); callers MUST surface `warning` when set.
 *
 * @returns {{ url: string|null, origin: 'latest-release-asset'|'live-manifest'|'pinned-fallback'|'none', assetName: string|null, digest: string|null, warning: string|null }}
 */
export function resolveBundleUrl({ canon, local, source }) {
  const pinned = (local && local.canonicalBundleUrl) || (source && source.canonicalBundleUrl) || null;

  if (canon && Array.isArray(canon.assets) && canon.assets.length) {
    const wantName = pinned ? path.basename(pinned) : null;
    let asset = wantName ? canon.assets.find((a) => a && a.name === wantName) : null;
    if (!asset) {
      const zips = canon.assets.filter((a) => a && typeof a.name === 'string' && a.name.endsWith('.zip'));
      if (zips.length === 1) asset = zips[0];
    }
    if (asset && (asset.browser_download_url || asset.url)) {
      return {
        url: asset.browser_download_url || asset.url,
        origin: 'latest-release-asset',
        assetName: asset.name,
        digest: asset.digest || null,
        warning: null,
      };
    }
  }

  if (canon && canon.stores && typeof canon.stores === 'object' && !Array.isArray(canon.stores) && local) {
    const cs = canon.stores[local.kbName];
    if (cs && cs.canonicalBundleUrl) {
      return { url: cs.canonicalBundleUrl, origin: 'live-manifest', assetName: path.basename(cs.canonicalBundleUrl), digest: null, warning: null };
    }
  }

  if (pinned) {
    const staleness = local
      ? `this copy's own record (built ${local.builtUtc || '?'}${local.sourceDescribe ? `, ${local.sourceDescribe}` : local.sourceCommit ? `, ${short(local.sourceCommit)}` : ''})`
      : `this copy's own record`;
    return {
      url: pinned,
      origin: 'pinned-fallback',
      assetName: path.basename(pinned),
      digest: null,
      warning: `could not resolve a bundle asset from the LIVE manifest ` +
        `(${canon && canon.tag_name ? `release ${canon.tag_name} has no matching/unambiguous .zip asset` : 'the manifest is not a GitHub Release payload and carries no live canonicalBundleUrl'}); ` +
        `falling back to the URL PINNED inside ${staleness}: ${pinned} — this can only point BACKWARD (issue #35) and may be stale.`,
    };
  }

  return { url: null, origin: 'none', assetName: null, digest: null, warning: null };
}

/**
 * The identity of a WHOLE bundle, as recorded at the top level of its SOURCE.json.
 *
 * This is what advances when a new bundle is published, regardless of which individual stores were
 * re-forged into it — which is precisely why the "did anything land" question belongs here and not
 * on a single store (issue #108). Returns null when a SOURCE.json carries no such identity at all
 * (bundles predating `releaseTag`/`brainVersion`, or a plain forge manifest), so callers can tell
 * "identical" apart from "no signal to compare".
 */
export function bundleIdentity(src) {
  if (!src || typeof src !== 'object') return null;
  // `corpusReleaseTag` is part of bundle identity for the same reason the other three are: it is the
  // one field that advances when a corpus-only release lands. Without it, two corpus generations
  // that happened to share a builtUtc would read as "nothing landed" on a genuinely new corpus.
  const parts = [src.releaseTag, src.brainVersion, src.builtUtc, src.corpusReleaseTag].map((v) => (v == null ? '' : String(v)));
  return parts.some(Boolean) ? parts.join('|') : null;
}

/**
 * Confirm the download+extraction actually changed what is on disk (issue #35 item 2, Dr. Mark
 * Allen / @mamd69).
 *
 * The OLD code's final "DONE" message (line 296 before this fix) was built from `canon.tag_name` —
 * a lookup made BEFORE anything was downloaded — regardless of what the download actually
 * contained. Mark's run printed "KB updated to the canonical build (v3.4.21-dev)" while his
 * SOURCE.json on disk still read v0.5.0-dev, because nothing ever re-read it afterward.
 *
 * This deliberately does NOT reuse `isBehind()` for the pass/fail decision: `isBehind()` compares
 * against `canon.builtUtc`, which for a GitHub Release is the RELEASE's publish timestamp — always
 * a few minutes AFTER the KB inside it was actually forged. Confirmed LIVE against this repo's own
 * kb/SOURCE.json (2026-07-20): running `--check` against a store forged 2 minutes before its own
 * release was published already reads BEHIND. Reusing that comparison here would make EVERY
 * successful update fail this guard too — crying wolf on success is as dishonest as silence on
 * failure. Instead this checks something isBehind() cannot: does the on-disk identity now differ
 * from what it was immediately BEFORE this update ran? `builtUtc` is regenerated at every forge
 * build, so a genuine new build always changes it — an unchanged fingerprint after a "successful"
 * download IS the bug (identical bytes re-fetched, exactly Mark's report). When the resolved asset
 * carried a real digest, this also verifies the downloaded bytes against it — the one place a
 * directly comparable "resolved vs. landed" fact actually exists in a GitHub Release payload.
 *
 * THE QUESTION IS ASKED OF THE BUNDLE, NOT OF ONE STORE (issue #108). The first version compared a
 * PER-STORE fingerprint and treated equality as fatal — but stores are forged INDEPENDENTLY, and a
 * store whose upstream repo did not move is re-shipped byte-identical inside a genuinely new
 * bundle. On the reporter's copy 8 of 15 stores shared one stamp, so the first unchanged store in
 * iteration order aborted the entire run: nightly updates "failed" for three weeks while actually
 * succeeding, and the abort skipped the rollback release, stranding ~1.6 GB a night. Whitelisting
 * the store would not have helped — the next unchanged one simply takes its place.
 *
 * So the fatal question is the one issue #35 actually asked: did ANYTHING land? That is bundle
 * identity (releaseTag / brainVersion / top-level builtUtc), which advances whenever a new bundle
 * is published. Per-store equality is now what it always was in reality — ordinary, and reported
 * as `storeUnchanged` rather than raised as a failure. A bundle whose identity did NOT move AND
 * whose store did not move either is the real no-op, and is still refused (issue #106).
 *
 * `kind` says what a caller may do about a failure: 'noop' means the KB in place is intact and the
 * rollback copy is redundant; 'damaged' means the copy in place is suspect and the rollback must
 * be kept.
 *
 * @returns {{ok: boolean, reason: string|null, landed: object|null, kind: 'noop'|'damaged'|null,
 *            storeUnchanged: boolean, bundleChanged: boolean|null}}
 */
export function verifyLanded({ kbDir, kbName, before, beforeBundle = null, expectedDigest = null, downloadedBuffer = null }) {
  const damaged = (reason, landed = null) => ({ ok: false, kind: 'damaged', reason, landed, storeUnchanged: false, bundleChanged: null });
  const p = path.join(kbDir, 'SOURCE.json');
  if (!fs.existsSync(p)) {
    return damaged(`no SOURCE.json found at ${p} after extraction — cannot confirm what actually landed`);
  }
  let landedSource;
  try { landedSource = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return damaged(`SOURCE.json on disk after extraction is unreadable/corrupt: ${e.message}`); }

  const list = Array.isArray(landedSource.stores)
    ? landedSource.stores
    : (landedSource.stores && typeof landedSource.stores === 'object')
      ? Object.entries(landedSource.stores).map(([n, v]) => ({ kbName: n, ...v }))
      : [landedSource];
  // The single-item, no-kbName-field fallback exists ONLY for the legacy flat schema (a SOURCE.json
  // predating the multi-store `stores` object — see the identical pattern at the top of this file,
  // lines 46-50). It must NOT swallow a genuine name mismatch: if the one store present names
  // itself something else, that is a real "wrong store landed" error, not a format quirk.
  // THE UPGRADE DIRECTION MATTERS TOO. The lookup above assumes the CALLER knows its store name —
  // but a legacy flat SOURCE.json has no `stores` object at all, so `stores = [source]` (lines 46-50)
  // yields an entry whose kbName is undefined, and `kbName` arrives here as undefined. Landing a
  // modern multi-store bundle over it then matched neither branch, and main() turned that into
  // "UPDATE MISMATCH — REFUSING to report success" on an update that had genuinely worked.
  //
  // That is the worst possible false failure: it permanently blocks self-update for people still on
  // an OLD bundle — precisely the stale installs this whole issue exists to rescue, and precisely the
  // users reporting "I'm still on 0.5". A guard that bricks the upgrade path is worse than the bug.
  const legacyCaller = kbName == null || kbName === 'undefined';
  const landed = list.find((s) => s.kbName === kbName)
    || (list.length === 1 && list[0].kbName == null ? { kbName, ...list[0] } : null)
    // Legacy caller upgrading into the modern schema: any single landed store is unambiguous.
    || (legacyCaller && list.length === 1 ? { kbName: list[0].kbName, ...list[0] } : null);
  if (!landed) {
    return damaged(`SOURCE.json on disk after extraction has no entry for store "${kbName}"`);
  }

  // Bytes that do not match what the release declared are a HARD failure whatever the identities
  // say, and the copy now in place is suspect — so this is checked before anything else.
  if (expectedDigest && downloadedBuffer) {
    const algo = expectedDigest.includes(':') ? expectedDigest.split(':')[0] : 'sha256';
    const actual = `${algo}:${createHash(algo).update(downloadedBuffer).digest('hex')}`;
    if (actual !== expectedDigest) {
      return damaged(`downloaded bundle digest ${actual} does not match the release-declared digest ${expectedDigest}`, landed);
    }
  }

  const fingerprint = (r) => `${r.builtUtc || ''}|${r.sourceCommit || ''}|${r.sourceDescribe || ''}`;
  const storeUnchanged = Boolean(before) && fingerprint(landed) === fingerprint(before);

  const landedBundle = bundleIdentity(landedSource);
  const priorBundle = bundleIdentity(beforeBundle);
  // null = one side carries no bundle identity at all (a pre-releaseTag bundle, or a plain forge
  // manifest). There is then nothing to compare, so the per-store fingerprint is the ONLY signal
  // available and the original behaviour stands — a fallback, never the primary test.
  const bundleChanged = (landedBundle && priorBundle) ? landedBundle !== priorBundle : null;

  const nothingMoved = bundleChanged === null ? storeUnchanged : (!bundleChanged && storeUnchanged);
  if (nothingMoved) {
    const detail = bundleChanged === null
      ? `store "${kbName}" on disk is IDENTICAL to before the update (built ${landed.builtUtc || '?'}` +
        `${landed.sourceDescribe ? `, ${landed.sourceDescribe}` : ''}), and this bundle carries no top-level identity to cross-check`
      : `the BUNDLE on disk is IDENTICAL to before the update (${landedBundle}) and store "${kbName}" did not move either`;
    return {
      ok: false,
      kind: 'noop',
      reason: `${detail} — nothing actually changed. Bytes were replaced with an identical copy while the ` +
        `download reported success: issue #35, and the reason issue #106 must not exit 0.`,
      landed,
      storeUnchanged,
      bundleChanged,
    };
  }

  return { ok: true, kind: null, reason: null, landed, storeUnchanged, bundleChanged };
}

async function main() {
  if (APPLY) {
    try { updateLock = acquireUpdateLock(); }
    catch (error) { die(`update lock refused this run: ${error.message}`); }

    // Cleanup is part of every apply, including an already-current run. Otherwise a redundant
    // multi-GB rollback can survive forever simply because there is no newer release to trigger
    // the old behind-only preflight.
    const preflightRollbacks = reclaimBackups({ kbDir: KB_DIR });
    legacyBackupRetention = preflightRollbacks;
    if (preflightRollbacks.removed.length) {
      console.log(`\nreleased ${preflightRollbacks.removed.length} redundant rollback ${preflightRollbacks.removed.length === 1 ? 'copy' : 'copies'} before update check`);
    }
    // Only an UNMEASURED or genuinely lost copy is recovery state. Being over the retention budget
    // with copies that are measured and pinned for a stated reason (a fenced private store, bytes
    // the proof could not match) is reported, not fatal — this update adds no persistent copy of
    // its own, and a refusal here was what kept --apply from ever running (measured 2026-09-11).
    const reasonFor = (backup) => preflightRollbacks.kept.find(([b]) => b === backup)?.[1] || 'not measured';
    if (preflightRollbacks.blockingRetained.length) {
      const detail = preflightRollbacks.blockingRetained.map(({ path: backup }) => `  ${backup}: ${reasonFor(backup)}`).join('\n');
      die(`unresolved rollback state exists; refusing to create another full-KB copy.\n${detail}\n  Restore or reconcile that copy first, then re-run.`);
    }
    if (preflightRollbacks.overBudget) {
      const { snapshots, maxSnapshots, bytes, maxBytes } = preflightRollbacks.overBudget;
      console.log(`\nOVER_BUDGET: ${snapshots} retained full-KB ${snapshots === 1 ? 'copy' : 'copies'} (${bytes} bytes) exceed the budget of ${maxSnapshots} (${maxBytes} bytes). Each is measured and pinned for the reason below; this update proceeds without adding a persistent copy.`);
    }
    for (const retained of preflightRollbacks.retained) {
      console.log(`\nRETAINED: ${retained.path} (${retained.bytes} bytes) — ${reasonFor(retained.path)}`);
    }
  }
  const canon = await fetchJson(manifestUrl);

  // ── CORPUS-RELEASE COMPATIBILITY GATE (ADR-086 step 16) ────────────────────────────────────────
  // Runs BEFORE the behind/current report, so `--check` refuses on exactly the same terms `--apply`
  // does, and before a single byte of bundle is fetched. Two tiers:
  //   1. this brain cannot prove which approved runtime it is running -> refuse, zero bandwidth;
  //   2. this exact tag was already refused and nothing has changed -> refuse, zero bandwidth.
  // The third tier (the staged bundle was built by a different runtime) can only be decided from
  // the downloaded bytes, and is enforced after extraction — where it also writes the ledger tier 2
  // reads, so a refusal costs one download ONCE rather than one download a night.
  const canonTag = isGithubReleasePayload(canon) ? canon.tag_name : null;
  const corpusRelease = isCorpusReleaseTag(canonTag);
  let installedRuntimeVersion = null;
  if (corpusRelease) {
    const runtime = readInstalledRuntime(KB_DIR);
    if (!runtime.ok) {
      die(`INCOMPATIBLE corpus release ${canonTag}\n`
        + `  ${runtime.reason}\n`
        + `  A corpus release carries knowledge for ONE approved runtime. This brain cannot prove which\n`
        + `  runtime it is running, so nothing was downloaded and nothing on disk was changed.\n`
        + `  Fix it with:  npx ruvnet-brain   (re-runs the installer, which re-stamps the approved runtime)`, 5);
    }
    installedRuntimeVersion = runtime.brainVersion;
    const remembered = readRejectedRelease(KB_DIR);
    if (remembered && remembered.tag === canonTag && remembered.installedRuntime === installedRuntimeVersion) {
      die(`corpus release ${canonTag} was already rejected by this brain (${remembered.rejectedUtc})\n`
        + `  ${remembered.reason}\n`
        + `  Nothing was downloaded. This refusal is remembered on purpose: rediscovering it every night\n`
        + `  would be a download loop with extra steps. It clears itself when a compatible release is\n`
        + `  published, or when this brain moves to a different runtime.\n`
        + `  Fix it with:  npx ruvnet-brain   (installs the code release that corpus was built for)`, 5);
    }
  }

  const activeProfile = RESTORE_COMPLETE ? 'complete' : readBrainProfile();
  const profileStores = selectUpdateManagedStores(stores, activeProfile);
  if (activeProfile === 'ruvector' && profileStores.length === 0) {
    die(`SOURCE.json has no ruvector store, so the selected RuVector Only profile cannot update safely.`);
  }
  const targets = ONLY ? profileStores.filter((s) => s.kbName === ONLY) : profileStores;
  if (ONLY && targets.length === 0) die(`SOURCE.json has no store named "${ONLY}". Known: ${stores.map((s) => s.kbName).join(', ')}`);

  const canonLabel = canon.tag_name
    ? `${canon.tag_name} (published ${canon.published_at || canon.created_at || '?'})`
    : canon.generated || canon.builtUtc || '(unknown)';
  console.log(`\n=== rvf-kb-forge evergreen check ===`);
  console.log(`canonical manifest: ${manifestUrl}`);
  console.log(`canonical built:    ${canonLabel}\n`);

  // ── ONE CURRENCY VERDICT (S2) ──────────────────────────────────────────────────────────────────
  // Computed ONCE for the whole bundle, from data already fetched — before a single byte of the
  // archive is downloaded. --check, --apply, and every store within a single run share this exact
  // decision (bundleIdentity() already established that every store in a release shares its identity;
  // the mixed-generation refusal a few lines below enforces that the resolved download target agrees).
  const installedIdentity = installedCurrencyIdentity(source);
  const candidateIdentity = candidateCurrencyIdentity(canon);
  const verdict = RESTORE_COMPLETE
    ? { verdict: 'UPDATE_AVAILABLE', reason: '--restore-complete forces a full profile restore' }
    : currencyVerdict(installedIdentity, candidateIdentity);
  console.log(`currency verdict:   ${verdict.verdict} — ${verdict.reason}\n`);

  // REFUSED is rollback protection: the candidate is a corpus generation strictly OLDER than what is
  // installed. Nothing is downloaded, the live tree is untouched, and this is a clean success (exit
  // 0) in BOTH modes — never exit 10, which would invite --apply into refusing again.
  if (verdict.verdict === 'REFUSED') {
    console.log(`REFUSED — ${verdict.reason}`);
    console.log('Nothing was downloaded; the live brain is untouched.');
    const refusedOutcome = APPLY
      ? writeUpdateOutcome({ terminalVerdict: 'refused', reason: verdict.reason,
        currencyVerdict: verdict.verdict, currencyReason: verdict.reason, candidateKind: candidateIdentity.kind,
        storeCount: targets.length })
      : writeCheckOutcome({ currencyVerdict: verdict.verdict, currencyReason: verdict.reason,
        candidateKind: candidateIdentity.kind, storeCount: targets.length });
    if (refusedOutcome?.terminalVerdict === 'recovery-required') die(refusedOutcome.reason);
    process.exit(0);
  }

  let anyBehind = false; const behindStores = [];
  for (const local of targets) {
    const c = canonicalFor(canon, local.kbName);
    const behind = verdict.verdict !== 'CURRENT';
    anyBehind = anyBehind || behind;
    if (behind) {
      behindStores.push({ local });
      console.log(`[${local.kbName}] BEHIND`);
      console.log(`    canonical: built ${c.builtUtc} from ${short(c.sourceCommit)}${c.sourceDescribe ? ` (${c.sourceDescribe})` : ''}`);
      console.log(`    yours:     built ${local.builtUtc} from ${short(local.sourceCommit)}${local.sourceDescribe ? ` (${local.sourceDescribe})` : ''}`);
    } else {
      console.log(`[${local.kbName}] UP TO DATE (built ${local.builtUtc || '?'} from ${short(local.sourceCommit)})`);
    }
  }

  if (!APPLY) {
    writeCheckOutcome({ currencyVerdict: verdict.verdict, currencyReason: verdict.reason,
      candidateKind: candidateIdentity.kind, storeCount: targets.length });
    // The npx door upgrades this updater before applying; an old installed updater run directly can fail
    // the guard on a newer bundle (customer-state-matrix D8, 2026-09-30).
    if (anyBehind) { console.log(`\nA newer build exists. Run:  npx ruvnet-brain@latest --update`); process.exit(10); }
    console.log(`\nAll stores current. Nothing to do.`); process.exit(0);
  }

  if (!anyBehind) {
    const inventoryBefore = managedStorageInventory(KB_DIR);
    let validateCoverageDirectory;
    try { validateCoverageDirectory = await loadTrustedCoverageValidator(); }
    catch (error) { die(`${error.message}. The live KB is untouched.`); }
    const installed = activeProfile === 'complete'
      ? validateReleaseCoverageTree(KB_DIR, validateCoverageDirectory)
      : validateProfiledReleaseTree(KB_DIR, activeProfile, capturePrivateOverlayState({ kbDir: KB_DIR, allStores: stores }));
    if (!installed.valid) die(`already-current KB failed integrity: ${installed.failures.join('; ')}`);
    // No transaction paths are created: the inventory still counts every retained managed copy.
    const measuredDelta = storageDelta({ live: KB_DIR }, { prior: inventoryBefore.active, inventoryBefore });
    const noopOutcome = writeUpdateOutcome({ terminalVerdict: 'noop', reason: 'already-current', storeCount: targets.length,
      currencyVerdict: verdict.verdict, currencyReason: verdict.reason, candidateKind: candidateIdentity.kind,
      storageDelta: measuredDelta,
      phaseEvidence: phaseEvidenceFor({ root: KB_DIR, terminalVerdict: 'noop', storageDelta: measuredDelta }) });
    if (noopOutcome?.terminalVerdict === 'recovery-required') die(noopOutcome.reason);
    console.log(`\nNothing to apply — already current.`); process.exit(0);
  }

  let validateCoverageDirectory;
  try { validateCoverageDirectory = await loadTrustedCoverageValidator(); }
  catch (error) { die(`${error.message}. The live KB is untouched.`); }

  // What actually landed for each store, so the final message (below RECLAIM) can be built from
  // the real on-disk artifact instead of the `canon` lookup made at the top of this run — issue
  // #35 item 2. Populated by verifyLanded() as each store is applied; main() dies loudly before
  // reaching the summary if any store's landed copy does not check out.
  const landedByStore = new Map();
  // Stores that landed byte-identical because their upstream repo did not move. ORDINARY, and named
  // in the summary so "unchanged" never has to be inferred from silence (issue #108).
  const unchangedStores = [];
  // Stores whose bundle demonstrably did not move at all. Non-zero exit, counted in the summary
  // rather than only in the mid-log line a cron job never reads (issue #106).
  let privateOverlay;
  try { privateOverlay = capturePrivateOverlayState({ kbDir: KB_DIR, allStores: stores }); }
  catch (e) { die(`private overlay preflight failed: ${e.message} — refusing to update.`); }
  const resolvedTargets = behindStores.map(({ local }) => ({ local, resolved: resolveBundleUrl({ canon, local, source }) }));
  for (const { local, resolved } of resolvedTargets) {
    if (!resolved.url) die(`[${local.kbName}] no canonical bundle URL is resolvable from the live manifest.`);
    if (resolved.warning) console.warn(`\n  ⚠ ${resolved.warning}`);
  }
  const bundleIdentities = new Set(resolvedTargets.map(({ resolved }) => JSON.stringify({ url: resolved.url, digest: resolved.digest || null })));
  if (bundleIdentities.size !== 1) {
    die(`selected stores resolve to divergent combined bundle identities; refusing a mixed-generation update.`);
  }
  const resolved = resolvedTargets[0].resolved;
  const originLabel = resolved.origin === 'latest-release-asset' ? `live release asset "${resolved.assetName}"`
    : resolved.origin === 'live-manifest' ? 'live manifest' : 'PINNED FALLBACK (see warning above)';
  console.log(`\n[${behindStores.length} store(s)] downloading ${resolved.url}\n  (source: ${originLabel}) ...`);
  const buf = await fetchBuffer(resolved.url);
  const sigBuf = await fetchBuffer(`${resolved.url}.sig`, { failureCode: 3, kind: 'signature' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-release-'));
  const zipPath = path.join(tmp, 'bundle.zip');
  const sigPath = path.join(tmp, 'bundle.zip.sig');
  const extractDir = path.join(tmp, 'extracted');
  fs.writeFileSync(zipPath, buf);
  fs.writeFileSync(sigPath, sigBuf);
  fs.mkdirSync(extractDir);
  console.log(`  downloaded ${(buf.length / 1e6).toFixed(1)} MB.`);
  const signature = verifyDownloadedBundle(zipPath, sigPath);
  if (!signature.ok) { fs.rmSync(tmp, { recursive: true, force: true }); die(`✗ SIGNATURE VERIFICATION FAILED: ${signature.reason}`, 4); }
  console.log(`  ✓ signature verified — ${signature.reason}`);
  try { await extractZip(zipPath, extractDir); }
  catch (error) { fs.rmSync(tmp, { recursive: true, force: true }); die(`extraction failed: ${error.message} — local files untouched.`); }
  // ── TIER 3: the staged bundle names the runtime that built it; this client names the runtime it
  // measurably runs. They must be equal, or this corpus is not for this brain. Refused BEFORE the
  // storage transaction, so the live tree is never touched, and REMEMBERED so the next run refuses
  // without downloading again.
  if (corpusRelease) {
    let stagedRuntimeVersion = null;
    try { stagedRuntimeVersion = JSON.parse(fs.readFileSync(path.join(extractDir, 'SOURCE.json'), 'utf8')).brainVersion || null; }
    catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true });
      die(`corpus release ${canonTag} has no readable SOURCE.json: ${error.message} — local files untouched.`);
    }
    const compatible = assertCorpusReleaseCompatible({ kbDir: KB_DIR, offeredRuntimeVersion: stagedRuntimeVersion });
    if (!compatible.ok) {
      writeRejectedRelease(KB_DIR, { tag: canonTag, reason: compatible.reason, installedRuntime: installedRuntimeVersion });
      fs.rmSync(tmp, { recursive: true, force: true });
      die(`INCOMPATIBLE corpus release ${canonTag}\n`
        + `  ${compatible.reason}\n`
        + `  Nothing was installed and the live brain is untouched. Installing it would have put knowledge\n`
        + `  built for a different runtime behind this one's reader.\n`
        + `  This refusal is now remembered, so tonight's check will not download it again.\n`
        + `  Fix it with:  npx ruvnet-brain   (installs the code release that corpus was built for)`, 5);
    }
  }
  const stagedCoverage = validateReleaseCoverageTree(extractDir, validateCoverageDirectory, installedRuntimeVersion);
  if (!stagedCoverage.valid) {
    fs.rmSync(tmp, { recursive: true, force: true });
    die(`staged ReleaseCoverage failed integrity: ${stagedCoverage.failures.join('; ')} — local files untouched.`);
  }

  // A release may RETIRE a store this brain still lists. Measured 2026-09-30: 4.3.39 no longer ships
  // agentic-flows/agentic-music (excluded-no-corpus) or cogs/support under those names, and guarding
  // them could only fail ("[FAIL] MISSING file: agentic-flows.rvf"), so no brain listing them could
  // ever update. The release coverage validated above is the authority on what ships; only the stores
  // the staged bundle declares are guarded and read back, and the retired ones are named, not dropped
  // silently. (A legacy flat SOURCE.json has no store name to compare and is always guarded.)
  let stagedStoreNames;
  try {
    const staged = JSON.parse(fs.readFileSync(path.join(extractDir, 'SOURCE.json'), 'utf8')).stores || {};
    stagedStoreNames = new Set(Array.isArray(staged) ? staged.map((s) => s?.kbName) : Object.keys(staged));
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    die(`staged SOURCE.json is unreadable: ${error.message} — local files untouched.`);
  }
  const landingTargets = resolvedTargets.filter(({ local }) => local.kbName == null || stagedStoreNames.has(local.kbName));
  const retiredStores = resolvedTargets.filter((target) => !landingTargets.includes(target)).map(({ local }) => local.kbName);
  if (!landingTargets.length) {
    fs.rmSync(tmp, { recursive: true, force: true });
    die(`release ${canonTag || canonLabel} ships none of the selected stores (${retiredStores.join(', ')}) — local files untouched.`);
  }
  if (retiredStores.length) console.log(`\n  retired by this release (no longer shipped): ${retiredStores.join(', ')}`);

  const privateNames = Object.keys(privateOverlay?.sourceStores || {});
  let profileResult = null;
  const finalVerificationByStore = new Map();
  const validateFinalTree = ({ dir, phase }) => {
    const coverageResult = activeProfile === 'complete'
      ? validateReleaseCoverageTree(dir, validateCoverageDirectory, installedRuntimeVersion)
      : validateProfiledReleaseTree(dir, activeProfile, privateOverlay);
    if (!coverageResult.valid) return coverageResult;
    const guard = path.join(dir, 'forge-guard.mjs');
    if (!fs.existsSync(guard)) return { valid: false, failures: ['forge-guard.mjs is missing'] };
    try {
      for (const { local, resolved: storeResolution } of landingTargets) {
        execFileSync(process.execPath, [guard, '--dir', dir, '--name', local.kbName], { cwd: dir, stdio: 'pipe' });
        const verified = verifyLanded({ kbDir: dir, kbName: local.kbName, before: local, beforeBundle: source,
          expectedDigest: storeResolution.digest, downloadedBuffer: buf });
        if (!verified.ok && verified.kind !== 'noop') return { valid: false, failures: [verified.reason] };
        if (phase === 'live') finalVerificationByStore.set(local.kbName, verified);
      }
      return { valid: true, failures: [] };
    } catch (error) { return { valid: false, failures: [`forge-guard failed: ${describeGuardFailure(error)}`] }; }
  };
  let transaction;
  try {
    // The installer starts this child inside KB_DIR. Windows holds that directory open
    // until cwd leaves it, preventing the atomic swap. Inputs (including RESULT_FILE)
    // are already resolved; all transaction and recovery paths remain absolute.
    const cwdWithinKb = path.relative(KB_DIR, process.cwd());
    if (cwdWithinKb === '' || (!path.isAbsolute(cwdWithinKb)
      && cwdWithinKb !== '..' && !cwdWithinKb.startsWith(`..${path.sep}`))) {
      process.chdir(path.dirname(KB_DIR));
    }
    transaction = runStorageTransaction({ liveDir: KB_DIR, sourceDir: extractDir,
      transactionId: `${Date.now()}-${process.pid}`,
      prepareCandidate: ({ candidateDir, liveDir }) => {
        // The trusted coverage validator is installer-provided and never ships inside the bundle it
        // judges (build-bundle cannot see this file's dynamic load). Carry the LIVE copy into the
        // candidate — never the bundle's: a promoted generation without it strands the next --apply
        // on "installed coverage validator is missing", and a byte-identical bundle would stop
        // reading as a no-op merely because live holds the one file the bundle cannot. Measured
        // 2026-09-12: every 4.3.21 brain lacked it, so this branch had never once run to completion.
        const liveValidator = path.join(liveDir, 'coverage-integrity.mjs');
        if (fs.existsSync(liveValidator)) {
          fs.copyFileSync(assertNoFollowPath(liveDir, liveValidator),
            assertNoFollowPath(candidateDir, path.join(candidateDir, 'coverage-integrity.mjs')));
        }
        // RUNTIME-IDENTITY.json is installer-written and, like the validator above, never ships
        // inside a bundle — so an exact-tree promotion would DELETE it and the very next corpus
        // check would refuse with "no installed runtime identity". Same lesson, same fix: carry the
        // LIVE copy into the candidate. (It pins coverage-integrity.mjs, which was just carried
        // across unchanged, so the pin still verifies on the promoted tree.)
        const liveRuntimeIdentity = path.join(liveDir, 'RUNTIME-IDENTITY.json');
        if (fs.existsSync(liveRuntimeIdentity)) {
          fs.copyFileSync(assertNoFollowPath(liveDir, liveRuntimeIdentity),
            assertNoFollowPath(candidateDir, path.join(candidateDir, 'RUNTIME-IDENTITY.json')));
        }
        // node_modules: the same installer-owned class as the two files above (see carryLiveNodeModules).
        carryLiveNodeModules({ candidateDir, liveDir });
        restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: liveDir, overlay: privateOverlay });
        // ATOMIC WITH INSTALLATION, not after it. The transport identity is written INTO the
        // candidate, so the storage transaction's single rename either promotes the bytes AND the
        // record of where they came from, or promotes neither. A crash here cannot leave a tree
        // whose contents and whose declared provenance disagree — which is the whole reason this is
        // not a second write against the live tree once the swap has happened.
        if (canonTag) {
          recordCorpusTransportIdentity(candidateDir, { releaseTag: canonTag });
          // S2: the generation ordering key is stamped ATOMICALLY alongside the transport tag — same
          // candidate directory, same single rename into place. A crash between the two can never
          // leave a tree whose transport tag and generation ordering key disagree.
          recordCorpusGenerationIdentity(candidateDir, { corpusReleaseTag: canonTag,
            generation: candidateIdentity.corpusGeneration });
        }
        const fullCoverage = validateReleaseCoverageTree(candidateDir, validateCoverageDirectory, installedRuntimeVersion);
        if (!fullCoverage.valid) throw new Error(`candidate public/private convergence failed: ${fullCoverage.failures.join('; ')}`);
        if (activeProfile !== 'complete') profileResult = applyBrainProfile(candidateDir, activeProfile, { preserveStores: privateNames });
      },
      validateCandidate: validateFinalTree,
      validateLive: validateFinalTree,
    });
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    die(`storage transaction failed: ${error.message}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  storage transaction: ${transaction.terminalVerdict}`);
  if (transaction.terminalVerdict === 'cleanup-pending') {
    const bundleSha256 = createHash('sha256').update(buf).digest('hex');
    const cleanupOutcome = writeUpdateOutcome({ terminalVerdict: 'cleanup-pending', storageDelta: transaction.storageDelta,
      transactionReceipts: transaction.paths.receipts, bundleSha256,
      phaseEvidence: phaseEvidenceFor({ root: KB_DIR, terminalVerdict: 'cleanup-pending', bundleSha256,
        transactionReceipts: transaction.paths.receipts, overlay: privateOverlay,
        storageDelta: transaction.storageDelta }) });
    if (cleanupOutcome?.terminalVerdict === 'recovery-required') die(cleanupOutcome.reason);
    console.error('\nVerified live generation is active, but redundant rollback cleanup is pending.');
    process.exitCode = 12;
    return;
  }
  for (const { local, resolved: storeResolution } of landingTargets) {
    const verified = finalVerificationByStore.get(local.kbName)
      || verifyLanded({ kbDir: KB_DIR, kbName: local.kbName, before: local, beforeBundle: source,
        expectedDigest: storeResolution.digest, downloadedBuffer: buf });
    if (verified.storeUnchanged || verified.kind === 'noop') unchangedStores.push(local.kbName);
    landedByStore.set(local.kbName, { landed: verified.landed, origin: storeResolution.origin, assetName: storeResolution.assetName });
  }

  const intentionallyRemovedStores = profileResult?.removedStores || [];
  if (profileResult) {
    console.log(`\nprofile ${activeProfile}: kept ${profileResult.stores.join(', ')}; removed ${profileResult.removed.length} unselected artifact(s).`);
  }

  // ── RECLAIM THE ROLLBACK COPY (issue #35, Dr. Mark Allen) ──────────────────────────────────────
  // The rollback copy exists to survive the SWAP, not to live on disk forever. Every update used to
  // leave a full ~2.5 GB copy behind and never remove it; Mark accumulated SEVEN (~14 GB) before
  // noticing. By this point forge-guard has PROVEN the new copy answers, and the bundle it came from
  // is a signed, versioned, re-downloadable artifact — so the old copy is dead weight. Released here,
  // and any copies stranded by earlier runs are swept with it.
  //
  // THE ONE CASE WHERE IT IS NOT DEAD WEIGHT, and why this is a check and not an `rm`: a KB can hold
  // stores the public bundle does not ship (private/local ones). The update replaces the directory, so
  // if such a store is absent from the new copy, the backup is its ONLY remaining copy — and
  // forge-guard would still pass, because it verifies the store it was asked about, not whatever went
  // missing. Deleting there would destroy the only copy of a user's private data. So: compare store
  // inventories first, and keep any backup holding something the new copy lost.
  //
  // Routed through settleRollback() so this is the SAME release the failure paths use, rather than a
  // happy-path-only call that a die() can step over — that step-over is issue #108.
  settleRollback({ reclaimable: true, intentionallyRemovedStores });

  // A release actually landed, so any remembered refusal is spent history — never a permanent
  // blocklist. Clearing it here (and only here) means the ledger can only ever suppress a repeat of
  // the exact refusal that produced it.
  clearRejectedRelease(KB_DIR);

  // ── FINAL MESSAGE — DERIVED FROM WHAT LANDED, NOT FROM THE TAG LOOKUP (issue #35 item 2) ────────
  // The old line above printed `canon.tag_name` regardless of what the download actually contained
  // — that is verbatim the bug: "printed 'KB updated to the canonical build (v3.4.21-dev)' [...]
  // SOURCE.json still said v0.5.0-dev afterward." Every store reaching this line already passed
  // verifyLanded() above (main() dies before this point otherwise), so what follows is read back
  // from the real file on disk, not asserted.
  console.log(transaction.terminalVerdict === 'noop'
    ? `\n=== DONE — exact no-op; installed bytes already equal the validated candidate ===`
    : `\n=== DONE — ${behindStores.length} store(s) updated ===`);
  console.log(`resolved target (live manifest, checked BEFORE downloading): ${canonLabel}`);
  if (retiredStores.length) console.log(`retired by this release (no longer shipped): ${retiredStores.join(', ')}`);
  for (const { local } of landingTargets) {
    const r = landedByStore.get(local.kbName);
    const l = r.landed;
    console.log(`[${local.kbName}] SOURCE.json on disk now reads: built ${l.builtUtc || '?'} from ${short(l.sourceCommit)}${l.sourceDescribe ? ` (${l.sourceDescribe})` : ''}`);
    console.log(`  fetched from: ${r.origin === 'latest-release-asset' ? `release asset "${r.assetName}"` : r.origin === 'live-manifest' ? 'live manifest entry' : 'PINNED FALLBACK — see warning above'}`);
  }
  if (unchangedStores.length) {
    // NAMED, not silent. Stores are forged independently, so a store whose upstream repo did not
    // move is re-shipped byte-identical inside a genuinely new bundle — normal, and the thing that
    // used to abort the whole run (issue #108).
    console.log(`\n${unchangedStores.length} of ${behindStores.length} store(s) were already at the canonical build and did not change: ${unchangedStores.join(', ')}`);
    console.log(`  (stores are forged independently — an unchanged store means its upstream repo did not move, not a failed update.)`);
  }
  const finalOutcome = writeUpdateOutcome({ terminalVerdict: transaction.terminalVerdict, storeCount: behindStores.length, retiredStores,
    currencyVerdict: verdict.verdict, currencyReason: verdict.reason, candidateKind: candidateIdentity.kind,
    storageDelta: transaction.storageDelta,
    transactionReceipts: transaction.paths.receipts,
    bundleSha256: createHash('sha256').update(buf).digest('hex'),
    coverageSha256: sha256File(path.join(KB_DIR, 'COVERAGE.json')),
    phaseEvidence: phaseEvidenceFor({ root: KB_DIR, terminalVerdict: transaction.terminalVerdict,
      bundleSha256: createHash('sha256').update(buf).digest('hex'),
      transactionReceipts: transaction.paths.receipts, overlay: privateOverlay,
      storageDelta: transaction.storageDelta }) });
  if (finalOutcome?.terminalVerdict === 'recovery-required') die(finalOutcome.reason);
  console.log(`\n(the above is read back from disk, verified — not a tag lookup)`);
  process.exit(0);
}

// Run ONLY when executed directly. `reclaimBackups` is exported for its own tests, and without this
// guard merely importing this file would start a live update — a network fetch, a directory swap, and
// a process.exit() inside whatever imported it. (Found exactly that way: the reclaim test's import
// began racing a real update against the test run.)
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly && STAGED_RELEASE_FILE) {
  (async () => {
    const input = JSON.parse(fs.readFileSync(STAGED_RELEASE_FILE, 'utf8'));
    const result = await applyVerifiedStagedRelease(input);
    console.log(JSON.stringify({ schemaVersion: 1, kind: 'ruvnet-brain-staged-recovery', ...result }));
  })().catch((e) => die(`staged recovery failed: ${e.message}`));
} else if (invokedDirectly) main().catch((e) => die(`unexpected: ${e.message}`));
