#!/usr/bin/env node
// scripts/approved-runtime.mjs — the runtime pin for unattended corpus promotion (ADR-086 step 17).
//
// THE FAILURE THIS EXISTS TO STOP. A nightly corpus build runs at `main` HEAD. The archive it seals
// is not only vectors: scripts/build-bundle.mjs copies a whole executable surface into it — the
// forge-* module graph (:213-214), package.json/package-lock.json/package-owners.json (:215),
// scripts/verify-bundle.mjs (:645) and keys/ruvnet-brain-signing.pub.pem (:648) — and the customer
// updater extracts that archive straight into the user's Claude Code config. So an unattended corpus
// promotion built at HEAD would ship whatever unreleased executable bytes happen to be on main that
// night, to every installed client, with no owner approval anywhere in the path. That is a code
// release wearing a corpus release's clothes.
//
// The pin closes it by ENFORCED EQUALITY, not by a version string. Dual's correction is explicit:
// "Pinning survives only through enforced equality to the approved shipped runtime and its
// executable hashes. Copying current-main package.json or preserving a version string alone is
// insufficient." So this compares every executable/runtime file's sha256 AND byte length against a
// committed inventory produced from the owner-approved shipped code artifact — and, in the other
// direction, refuses any executable-shaped file in the archive that the inventory does not cover, so
// a NEW unpinned executable cannot ride along.
//
// builderSourceSha stays independent on purpose: the corpus content may be built from a newer main
// than the approved runtime. That is the whole point of separating the two identities.
//
// Usage:
//   node scripts/approved-runtime.mjs --emit   --archive-manifest <ARCHIVE-MANIFEST.json> \
//        --code-sha <40hex> --out data/approved-runtime.json      # owner, during a code release
//   node scripts/approved-runtime.mjs --verify --archive-manifest <ARCHIVE-MANIFEST.json> \
//        [--pin data/approved-runtime.json]                        # every corpus promotion

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APPROVED_RUNTIME_FILE = 'data/approved-runtime.json';
export const APPROVED_RUNTIME_KIND = 'ruvnet-brain-approved-runtime';

// Executable/runtime surface. Extensions cover every interpretable artifact; the three exact
// basenames are build-bundle.mjs's EXTRA_FILES, which are data-shaped but govern module resolution
// and ownership; .pem covers the installer's committed trust root. Everything else in the archive
// (*.big.rvf, the sidecars, SOURCE.json, COVERAGE.json, *.md) is corpus content that MUST change
// every round and is deliberately NOT pinned.
const RUNTIME_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.sh', '.bat', '.cmd', '.ps1', '.pem']);
const RUNTIME_EXACT_NAMES = new Set(['package.json', 'package-lock.json', 'package-owners.json']);

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function isRuntimeFile(archivePath) {
  const normalized = String(archivePath || '').split('\\').join('/');
  if (!normalized || normalized.includes('../')) return false;
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return RUNTIME_EXACT_NAMES.has(base) || RUNTIME_EXTENSIONS.has(path.extname(base).toLowerCase());
}

const identityOf = (row) => ({ path: String(row.path).split('\\').join('/'), sha256: row.sha256, bytes: row.bytes });
const validRow = (row) => row && typeof row.path === 'string' && row.path.length > 0
  && !row.path.startsWith('/') && !row.path.split('\\').join('/').includes('../')
  && HEX64.test(String(row.sha256 || '')) && Number.isSafeInteger(row.bytes) && row.bytes >= 0;

export function validateArchiveManifest(manifest) {
  const failures = [];
  if (!manifest || typeof manifest !== 'object') return ['archive manifest is not an object'];
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'ruvnet-brain-archive-manifest') {
    failures.push('archive manifest schema or kind is not ruvnet-brain-archive-manifest v1');
  }
  if (!SEMVER.test(String(manifest.version || ''))) failures.push('archive manifest version is not x.y.z');
  if (String(manifest.releaseTag || '') !== `v${manifest.version}`) failures.push('archive manifest releaseTag does not match its version');
  if (!Array.isArray(manifest.files) || !manifest.files.every(validRow)) failures.push('archive manifest file rows are malformed');
  return failures;
}

export function validateApprovedRuntime(pin) {
  const failures = [];
  if (!pin || typeof pin !== 'object') return ['approved runtime pin is not an object'];
  if (pin.schemaVersion !== 1 || pin.kind !== APPROVED_RUNTIME_KIND) {
    failures.push(`approved runtime pin schema or kind is not ${APPROVED_RUNTIME_KIND} v1`);
  }
  if (!SEMVER.test(String(pin.brainVersion || ''))) failures.push('approved runtime brainVersion is not x.y.z');
  if (String(pin.releaseTag || '') !== `v${pin.brainVersion}`) failures.push('approved runtime releaseTag does not match brainVersion');
  if (!HEX40.test(String(pin.approvedCodeSha || ''))) failures.push('approved runtime approvedCodeSha is not a 40-character source identity');
  if (!Array.isArray(pin.files) || pin.files.length === 0 || !pin.files.every(validRow)) {
    failures.push('approved runtime file rows are missing or malformed');
  } else {
    if (!pin.files.every((row) => isRuntimeFile(row.path))) failures.push('approved runtime pins a file that is not executable/runtime-shaped');
    const paths = pin.files.map((row) => row.path);
    if (new Set(paths).size !== paths.length) failures.push('approved runtime pins the same path twice');
  }
  return failures;
}

/**
 * Enforced equality in BOTH directions.
 *   forward  — every pinned executable exists in the archive with identical sha256 and byte length.
 *   backward — every executable-shaped file in the archive is covered by the pin.
 * The backward direction is the one that matters most: without it a nightly build could add a brand
 * new .mjs to the archive and satisfy a forward-only check trivially.
 */
export function verifyApprovedRuntime({ manifest, pin } = {}) {
  const failures = [...validateArchiveManifest(manifest), ...validateApprovedRuntime(pin)];
  if (failures.length) return { verdict: 'FAIL', failures, checked: 0 };

  if (manifest.version !== pin.brainVersion) {
    failures.push(`archive brainVersion ${manifest.version} is not the approved shipped runtime ${pin.brainVersion}`);
  }
  if (manifest.releaseTag !== pin.releaseTag) {
    failures.push(`archive releaseTag ${manifest.releaseTag} is not the approved shipped runtime tag ${pin.releaseTag}`);
  }

  const archiveByPath = new Map(manifest.files.map((row) => [identityOf(row).path, identityOf(row)]));
  const pinnedPaths = new Set();
  for (const row of pin.files.map(identityOf)) {
    pinnedPaths.add(row.path);
    const actual = archiveByPath.get(row.path);
    if (!actual) { failures.push(`approved runtime file absent from archive: ${row.path}`); continue; }
    if (actual.sha256 !== row.sha256) failures.push(`runtime bytes differ from the approved shipped code artifact: ${row.path}`);
    else if (actual.bytes !== row.bytes) failures.push(`runtime byte length differs from the approved shipped code artifact: ${row.path}`);
  }
  for (const row of manifest.files.map(identityOf)) {
    if (isRuntimeFile(row.path) && !pinnedPaths.has(row.path)) {
      failures.push(`archive ships an executable/runtime file no approved code release pinned: ${row.path}`);
    }
  }

  return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', failures, checked: pinnedPaths.size };
}

export function readApprovedRuntime(pinFile) {
  const resolved = path.resolve(pinFile || path.join(ROOT, APPROVED_RUNTIME_FILE));
  if (!fs.existsSync(resolved)) {
    throw new Error(`no approved runtime pin at ${resolved}. Unattended corpus promotion is refused until an `
      + `owner-gated code release emits it: node scripts/approved-runtime.mjs --emit --archive-manifest `
      + `<ARCHIVE-MANIFEST.json> --code-sha <sha> --out ${APPROVED_RUNTIME_FILE}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

export function emitApprovedRuntime({ manifest, approvedCodeSha } = {}) {
  const failures = validateArchiveManifest(manifest);
  if (!HEX40.test(String(approvedCodeSha || ''))) failures.push('--code-sha must be a 40-character lowercase source identity');
  if (failures.length) throw new Error(`cannot emit approved runtime pin: ${failures.join('; ')}`);
  const files = manifest.files
    .map(identityOf)
    .filter((row) => isRuntimeFile(row.path))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (files.length === 0) throw new Error('cannot emit approved runtime pin: archive manifest carries no executable/runtime files');
  return {
    schemaVersion: 1,
    kind: APPROVED_RUNTIME_KIND,
    brainVersion: manifest.version,
    releaseTag: manifest.releaseTag,
    approvedCodeSha: String(approvedCodeSha).toLowerCase(),
    fileCount: files.length,
    files,
  };
}

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

function main() {
  const manifestFile = arg('--archive-manifest');
  if (!manifestFile) { console.error('usage: approved-runtime.mjs --emit|--verify --archive-manifest <file> [...]'); return 2; }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.resolve(manifestFile), 'utf8')); }
  catch (error) { console.error(`[approved-runtime] cannot read archive manifest: ${error.message}`); return 1; }

  if (process.argv.includes('--emit')) {
    let pin;
    try { pin = emitApprovedRuntime({ manifest, approvedCodeSha: arg('--code-sha') }); }
    catch (error) { console.error(`[approved-runtime] ${error.message}`); return 1; }
    const out = path.resolve(arg('--out', path.join(ROOT, APPROVED_RUNTIME_FILE)));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`[approved-runtime] pinned ${pin.fileCount} executable/runtime file(s) at ${pin.releaseTag} → ${path.relative(ROOT, out)}`);
    return 0;
  }

  let pin;
  try { pin = readApprovedRuntime(arg('--pin')); }
  catch (error) { console.error(`[approved-runtime] ${error.message}`); return 1; }
  const result = verifyApprovedRuntime({ manifest, pin });
  if (result.verdict !== 'PASS') {
    console.error('[approved-runtime] FAIL: archive runtime is not the owner-approved shipped code artifact');
    for (const failure of result.failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log(`[approved-runtime] PASS: ${result.checked} executable/runtime file(s) equal ${pin.releaseTag} byte for byte`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
