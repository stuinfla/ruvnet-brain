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

const KB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(KB_DIR, 'SOURCE.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const RESTORE_COMPLETE = argv.includes('--restore-complete');
const resultFileIndex = argv.indexOf('--result-file');
const RESULT_FILE = resultFileIndex >= 0 && argv[resultFileIndex + 1]
  ? path.resolve(argv[resultFileIndex + 1]) : (process.env.RUVNET_UPDATE_RESULT ? path.resolve(process.env.RUVNET_UPDATE_RESULT) : null);
const optionValueIndexes = new Set(resultFileIndex >= 0 ? [resultFileIndex + 1] : []);
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

if (!fs.existsSync(SOURCE_PATH)) {
  die(`no SOURCE.json next to this script (${SOURCE_PATH}). This bundle predates the evergreen ` +
      `mechanism or SOURCE.json was removed. Re-download a current bundle to gain self-update.`);
}
let source;
try { source = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf8')); }
catch (e) { die(`SOURCE.json is unreadable/corrupt: ${e.message}`); }

// The RELEASE TAG IS A PROPERTY OF THE BUNDLE, and every store inside it shares that tag (issue
// #108 bug 2). It is written once, at the top level of SOURCE.json; the per-store entries never
// carry it. isBehind() short-circuits on `canon.releaseTag && local.releaseTag`, so with the local
// side always undefined that branch could never fire — every store fell through to a timestamp
// compare against the RELEASE's publish time, which is always later than the forge time of the KB
// inside it. Result: all 15 stores read BEHIND on every run, forever, immediately after a
// successful update. `--check` exited 10 permanently and was useless as a monitoring signal, and
// `--apply` re-downloaded half a gigabyte every night to change nothing. Inheriting the tag the
// bundle already records is the whole fix; a store that carries its own still wins.
const withBundleTag = (s) => (s && s.releaseTag == null && source.releaseTag != null
  ? { ...s, releaseTag: source.releaseTag } : s);
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
  const validatorPath = path.join(KB_DIR, 'coverage-integrity.mjs');
  if (!fs.existsSync(validatorPath)) {
    throw new Error('installed coverage validator is missing; re-run the current installer before self-update');
  }
  const validator = await import(pathToFileURL(validatorPath).href);
  if (typeof validator.validateCoverageDirectory !== 'function') {
    throw new Error('installed coverage validator has no validateCoverageDirectory export');
  }
  return validator.validateCoverageDirectory;
}

function validateReleaseCoverageTree(root, validateCoverageDirectory) {
  let expectedVersion = null;
  try { expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE.json'), 'utf8')).brainVersion || null; }
  catch (error) { return { valid: false, failures: [`SOURCE.json is unreadable: ${error.message}`] }; }
  return validateCoverageDirectory(root, { expectedVersion });
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
  const privateFiles = Object.fromEntries(relativeFiles(kbDir)
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
  const aliases = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
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

  const publicCardsText = fs.existsSync(cardsFile) ? fs.readFileSync(cardsFile, 'utf8') : '';
  const publicCards = cardSections(publicCardsText);
  for (const [name, section] of Object.entries(overlay.cards || {})) {
    if (publicCards.has(name) && publicCards.get(name) !== section) {
      throw new Error(`capability-cards.md collision for private store ${name}`);
    }
    publicCards.set(name, section);
  }
  const preambleEnd = publicCardsText.search(/^## /m);
  const preamble = preambleEnd >= 0 ? publicCardsText.slice(0, preambleEnd).trimEnd() : publicCardsText.trimEnd();
  const mergedCards = `${preamble}${preamble ? '\n\n' : ''}${[...publicCards.values()].join('\n\n')}\n`;

  atomicJson(sourceFile, { ...source, stores: mergedSource });
  atomicJson(generationsFile, { ...generations, stores: mergedGenerations });
  atomicJson(aliasesFile, mergedAliases);
  fs.writeFileSync(`${cardsFile}.tmp-${process.pid}`, mergedCards);
  fs.renameSync(`${cardsFile}.tmp-${process.pid}`, cardsFile);
  return { restored: Object.keys(overlay.sourceStores).length };
}

const manifestUrl = source.canonicalManifestUrl || stores.find((s) => s.canonicalManifestUrl)?.canonicalManifestUrl;
if (!manifestUrl) {
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
    return {
      builtUtc: canon.published_at || canon.created_at || null,
      // No per-store git sha in a Release payload; use the tag as the version identity instead.
      sourceCommit: null,
      sourceDescribe: canon.tag_name,
      releaseTag: canon.tag_name,
    };
  }
  const cs = (canon.stores && canon.stores[kbName]) || {};
  return {
    builtUtc: cs.builtUtc || canon.generated || canon.builtUtc || null,
    sourceCommit: cs.sha || cs.sourceCommit || null,
    sourceDescribe: cs.describe || cs.sourceDescribe || null,
    releaseTag: null,
  };
}
function isBehind(local, canon) {
  // Release-tag identity is AUTHORITATIVE when both sides carry a tag. The publish time of a
  // Release is later than when the store was forged, so timestamps would always (falsely) read
  // "behind" — the tag is the truth: same tag = up to date, different tag = behind.
  if (canon.releaseTag && local.releaseTag) {
    return canon.releaseTag !== local.releaseTag;
  }
  const lt = local.builtUtc ? Date.parse(local.builtUtc) : NaN;
  const ct = canon.builtUtc ? Date.parse(canon.builtUtc) : NaN;
  if (!Number.isNaN(lt) && !Number.isNaN(ct) && ct > lt) return true;
  if (local.sourceCommit && canon.sourceCommit && local.sourceCommit !== canon.sourceCommit) return true;
  return false;
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

function restoreTreeExact(srcDir, dstDir, root = dstDir, prefix = '') {
  assertNoFollowPath(root, dstDir);
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir);
  const sourceNames = new Set(fs.readdirSync(srcDir));
  for (const name of fs.readdirSync(dstDir)) {
    const target = assertNoFollowPath(root, path.join(dstDir, name));
    if (!sourceNames.has(name)) fs.rmSync(target, { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`backup contains a symbolic link: ${path.join(prefix, entry.name)}`);
    const source = path.join(srcDir, entry.name);
    const target = assertNoFollowPath(root, path.join(dstDir, entry.name));
    if (entry.isDirectory()) {
      if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) fs.rmSync(target, { force: true });
      if (!fs.existsSync(target)) fs.mkdirSync(target);
      restoreTreeExact(source, target, root, path.join(prefix, entry.name));
    } else {
      if (fs.existsSync(target) && fs.lstatSync(target).isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      fs.copyFileSync(source, target);
    }
  }
}

/** Apply a public bundle while preserving private metadata; restore the full backup on failure. */
export function applyPublicBundlePreservingPrivate({ extractDir, kbDir, backupPath, overlay }) {
  const privateFiles = new Set(Object.keys(overlay?.files || {}));
  const collision = relativeFiles(extractDir).find((relative) => privateFiles.has(relative));
  if (collision) throw new Error(`public bundle collides with private file ${collision}; refusing to copy`);
  try {
    // The public bundle is an exact tree, not an overlay. Overlay copies kept retired scripts,
    // stale policies, and removed RVFs alive indefinitely. Replace the governed tree exactly,
    // then restore only the explicitly captured private overlay from the pre-update snapshot.
    restoreTreeExact(extractDir, kbDir);
    for (const relative of privateFiles) {
      const source = assertNoFollowPath(backupPath, path.join(backupPath, relative));
      const target = assertNoFollowPath(kbDir, path.join(kbDir, relative));
      if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
        throw new Error(`private backup file is missing or not regular: ${relative}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    return restorePrivateOverlayState({ kbDir, overlay });
  } catch (error) {
    try {
      restoreTreeExact(backupPath, kbDir);
    } catch (rollbackError) {
      throw new Error(`${error.message}; automatic rollback also failed: ${rollbackError.message}`);
    }
    throw new Error(`${error.message}; restored pre-update bytes from ${backupPath}`);
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
export function reclaimBackups({
  kbDir,
  backupsMade = [],
  env = process.env,
  intentionallyRemovedStores = [],
}) {
  const parent = path.dirname(kbDir);
  const prefix = `${path.basename(kbDir)}.bak-`;
  let stranded = [];
  try { stranded = fs.readdirSync(parent).filter((n) => n.startsWith(prefix)).map((n) => path.join(parent, n)); }
  catch { /* unreadable parent — nothing to sweep */ }

  const all = [...new Set([...backupsMade, ...stranded])];
  const removed = []; const kept = []; let freed = 0;
  const safePreserved = new Map();
  const retentionPolicy = rollbackRetentionPolicy(kbDir, env);
  const liveInventory = storeInventory(kbDir);
  const conventionalAllowedMissing = new Set(intentionallyRemovedStores.flatMap((store) => [
    `${store}.rvf`,
    `${store}.big.rvf`,
  ]).map((file) => path.normalize(file)));

  for (const b of all) {
    if (!fs.existsSync(b)) continue;
    if (env.RUVNET_KEEP_BACKUP === '1') { kept.push([b, 'RUVNET_KEEP_BACKUP=1 is set']); continue; }
    try {
      if (path.dirname(path.resolve(b)) !== path.resolve(parent) || !path.basename(b).startsWith(prefix)) {
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
    const allowedMissing = new Set(conventionalAllowedMissing);
    for (const store of intentionallyRemovedStores) {
      const governedPath = backupInventory.logical.get(store);
      if (governedPath) allowedMissing.add(governedPath);
    }
    const lost = [...backupInventory.stores].filter(([identity]) => !liveInventory.stores.has(identity) && !allowedMissing.has(identity));
    if (lost.length) {
      const labels = lost.map(([, file]) => file);
      kept.push([b, `it holds ${lost.length} store(s) the new copy does NOT have: ${labels.slice(0, 3).join(', ')}${lost.length > 3 ? '…' : ''}`]);
      continue;
    }
    try { assertRedundantBackup(b, kbDir); }
    catch (error) {
      kept.push([b, `PRESERVED_UNCLASSIFIED: complete byte redundancy is not proven; ${error.message}`]);
      // Preservation does not itself require blocking an isolated transaction.
      // Only a complete regular-file inventory can establish measured retention;
      // missing stores, unsafe roots, unreadable bytes and symlinks remain blockers.
      try {
        const identity = treeIdentity(b);
        if (identity.entries.every((entry) => entry.type === 'file')) safePreserved.set(b, identity.bytes);
      } catch { /* retained, but not safe to proceed past recovery preflight */ }
      continue;
    }
    const size = dirSize(b);
    try { fs.rmSync(b, { recursive: true, force: true }); removed.push(b); freed += size; }
    catch (e) { kept.push([b, `could not remove: ${e.message}`]); }
  }
  const retained = all.filter((backup) => fs.existsSync(backup)).map((backup) => {
    let inventorySha256 = null;
    let inventoryError = null;
    try {
      if (fs.lstatSync(backup).isSymbolicLink()) throw new Error('backup root is a symbolic link');
      inventorySha256 = snapshotInventoryDigest(backup);
    }
    catch (error) { inventoryError = error.message; }
    return { path: backup, bytes: safePreserved.get(backup) ?? dirSize(backup), inventorySha256, inventoryError,
      safeToRetainDuringUpdate: safePreserved.has(backup), automaticCleanupEligible: false };
  });
  const retainedBytes = retained.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  const retention = { ...retentionPolicy, observedSnapshots: retained.length, observedBytes: retainedBytes,
    withinBudget: retained.length <= retentionPolicy.maxSnapshots && retainedBytes <= retentionPolicy.maxBytes };
  return { removed, kept, freed, retained, retentionPolicy: retention, withinBudget: retention.withinBudget,
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
  const parts = [src.releaseTag, src.brainVersion, src.builtUtc].map((v) => (v == null ? '' : String(v)));
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
    if (preflightRollbacks.kept.length && !preflightRollbacks.updateMayProceed) {
      const detail = preflightRollbacks.kept.map(([backup, reason]) => `  ${backup}: ${reason}`).join('\n');
      die(`unresolved rollback state exists; refusing to create another full-KB copy.\n${detail}\n  Restore or reconcile that copy first, then re-run.`);
    }
    for (const retained of preflightRollbacks.retained) {
      console.log(`\nPRESERVED_UNCLASSIFIED: ${retained.path} (${retained.bytes} bytes); retained within configured budget, not reclaimed.`);
    }
  }
  const canon = await fetchJson(manifestUrl);
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

  let anyBehind = false; const behindStores = [];
  for (const local of targets) {
    const c = canonicalFor(canon, local.kbName);
    const behind = RESTORE_COMPLETE || isBehind(local, c);
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
    if (anyBehind) { console.log(`\nA newer build exists. Run:  node forge-update.mjs --apply`); process.exit(10); }
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
  const stagedCoverage = validateReleaseCoverageTree(extractDir, validateCoverageDirectory);
  if (!stagedCoverage.valid) {
    fs.rmSync(tmp, { recursive: true, force: true });
    die(`staged ReleaseCoverage failed integrity: ${stagedCoverage.failures.join('; ')} — local files untouched.`);
  }

  const privateNames = Object.keys(privateOverlay?.sourceStores || {});
  let profileResult = null;
  const finalVerificationByStore = new Map();
  const validateFinalTree = ({ dir, phase }) => {
    const coverageResult = activeProfile === 'complete'
      ? validateReleaseCoverageTree(dir, validateCoverageDirectory)
      : validateProfiledReleaseTree(dir, activeProfile, privateOverlay);
    if (!coverageResult.valid) return coverageResult;
    const guard = path.join(dir, 'forge-guard.mjs');
    if (!fs.existsSync(guard)) return { valid: false, failures: ['forge-guard.mjs is missing'] };
    try {
      for (const { local, resolved: storeResolution } of resolvedTargets) {
        execFileSync(process.execPath, [guard, '--dir', dir, '--name', local.kbName], { cwd: dir, stdio: 'pipe' });
        const verified = verifyLanded({ kbDir: dir, kbName: local.kbName, before: local, beforeBundle: source,
          expectedDigest: storeResolution.digest, downloadedBuffer: buf });
        if (!verified.ok && verified.kind !== 'noop') return { valid: false, failures: [verified.reason] };
        if (phase === 'live') finalVerificationByStore.set(local.kbName, verified);
      }
      return { valid: true, failures: [] };
    } catch (error) { return { valid: false, failures: [`forge-guard failed: ${error.message}`] }; }
  };
  let transaction;
  try {
    transaction = runStorageTransaction({ liveDir: KB_DIR, sourceDir: extractDir,
      transactionId: `${Date.now()}-${process.pid}`,
      prepareCandidate: ({ candidateDir, liveDir }) => {
        for (const relative of Object.keys(privateOverlay?.files || {})) {
          const sourceFile = assertNoFollowPath(liveDir, path.join(liveDir, relative));
          const targetFile = assertNoFollowPath(candidateDir, path.join(candidateDir, relative));
          fs.mkdirSync(path.dirname(targetFile), { recursive: true });
          fs.copyFileSync(sourceFile, targetFile);
        }
        restorePrivateOverlayState({ kbDir: candidateDir, overlay: privateOverlay });
        const fullCoverage = validateReleaseCoverageTree(candidateDir, validateCoverageDirectory);
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
  for (const { local, resolved: storeResolution } of resolvedTargets) {
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
  for (const { local } of behindStores) {
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
  const finalOutcome = writeUpdateOutcome({ terminalVerdict: transaction.terminalVerdict, storeCount: behindStores.length,
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
if (invokedDirectly) main().catch((e) => die(`unexpected: ${e.message}`));
