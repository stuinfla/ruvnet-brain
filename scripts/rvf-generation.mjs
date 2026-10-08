// rvf-generation.mjs — bind each canonical RVF byte generation to the Brain product version.
//
// @ruvector/rvf's Node API does not currently expose a supported custom-manifest writer for an
// existing store. This checksum-bound companion is therefore the fail-closed identity record:
// changing even one RVF byte changes sha256, while brainVersion/releaseTag identify the npm and
// GitHub release that owns those exact bytes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getVersion, getVersionTag } from './version.mjs';

export const RVF_GENERATIONS_FILE = 'RVF-GENERATIONS.json';
export const RUNTIME_LEDGER_KIND = 'ruvnet-brain-runtime-generation-ledger';

// S4 (ONE PROVENANCE RECORD) — RECONCILING THE TWO "schemaVersion 2" MEANINGS.
//
// Two independent writers had drifted into calling different shapes "schemaVersion 2":
//   "Schema A" — THIS module's writeRvfGeneration wrote schemaVersion 1, no `kind`, no
//     `sourceSnapshot`, one store touched per call (the dev-time incremental refresh ledger).
//   "Schema B" — scripts/build-bundle.mjs's projectStoreViews independently writes
//     `{ schemaVersion: 2, kind: 'ruvnet-brain-runtime-generation-ledger', brainVersion,
//     releaseTag, sourceSnapshot, stores }` (the release-time ledger) — and
//     plugin/scripts/coverage-integrity.mjs's release validation ALREADY requires exactly this
//     shape (`schemaVersion !== 2` / `kind !== 'ruvnet-brain-runtime-generation-ledger'` are hard
//     failures there, confirmed by reading it directly) for the tree an installed brain carries.
// Schema B is the one kept: it is a strict superset (Schema A's per-store row shape is a subset
// of Schema B's), and it is what the release-time validator already enforces on every installed
// tree. Schema A is retired: writeRvfGeneration below now emits Schema B's envelope, carrying
// `sourceSnapshot` forward from whatever the ledger already had (null until a release build sets
// it — build-bundle.mjs's own construction is untouched and still wins at release time; this
// module's schemaVersion bump changes nothing downstream, since nothing reads the dev-time
// ledger's schemaVersion — verified against every consumer: validateSelectedRvfGenerations/
// verifyRvfGenerations below check individual fields, never schemaVersion; build-bundle.mjs
// reads the dev-time ledger via readRvfGenerations only to look up per-store rows by name, then
// constructs ITS OWN new ledger object from scratch).

export function canonicalRvfStores(dir) {
  return fs.readdirSync(dir)
    .map((file) => file.match(/^(.+)\.big\.rvf$/)?.[1])
    .filter(Boolean)
    .sort();
}

export function hasCanonicalRvfStore(dir, name) {
  const wanted = String(name).toLowerCase();
  return canonicalRvfStores(dir).some((store) => store.toLowerCase() === wanted);
}

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function readRvfGenerations(dir) {
  const file = path.join(dir, RVF_GENERATIONS_FILE);
  if (!fs.existsSync(file)) {
    return { schemaVersion: 2, kind: RUNTIME_LEDGER_KIND, brainVersion: getVersion(),
      releaseTag: getVersionTag(), sourceSnapshot: null, stores: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  parsed.stores ||= {};
  return parsed;
}

export function writeRvfGeneration({
  dir,
  store,
  rvfFile = `${store}.big.rvf`,
  model,
  dimensions,
  sourceCommit = null,
  sourceRepo = null,
  sourceDescribe = null,
  builtUtc = new Date().toISOString(),
  previousDir = dir,
}) {
  const rvfPath = path.join(dir, rvfFile);
  if (!fs.existsSync(rvfPath)) throw new Error(`cannot stamp missing RVF: ${rvfPath}`);
  const manifest = readRvfGenerations(previousDir);
  manifest.schemaVersion = 2;
  manifest.kind = RUNTIME_LEDGER_KIND;
  manifest.brainVersion = getVersion();
  manifest.releaseTag = getVersionTag();
  // Carried forward, never invented here: this is the git sha of the CODE checkout that
  // assembles a release (build-bundle.mjs's projectStoreViews sets it fresh at release time).
  // The dev-time incremental refresh this function serves does not know that value yet.
  manifest.sourceSnapshot = manifest.sourceSnapshot ?? null;
  manifest.stores[store] = {
    file: rvfFile,
    sha256: sha256File(rvfPath),
    bytes: fs.statSync(rvfPath).size,
    model,
    dimensions,
    sourceCommit,
    // S4 (ONE PROVENANCE RECORD): the repo identity a SOURCE.json entry needs, carried alongside
    // the byte identity this ledger has always recorded, so SOURCE.json can be projected entirely
    // FROM this ledger (projectSourceStore below) rather than a caller's own second copy of the
    // same facts. Optional and omitted (not written as null) so a caller that does not pass them
    // gets a ledger row with no dangling nulls.
    ...(sourceRepo !== null ? { sourceRepo } : {}),
    ...(sourceDescribe !== null ? { sourceDescribe } : {}),
    builtUtc,
  };
  fs.writeFileSync(path.join(dir, RVF_GENERATIONS_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.stores[store];
}

/**
 * Project ONE SOURCE.json store entry from its ledger row — the ONE place identity fields
 * (sourceRepo, sourceCommit, sourceDescribe, builtUtc) are read FROM the ledger rather than
 * independently recomputed by a caller (S4: ONE PROVENANCE RECORD).
 *
 * Deliberately minimal: it projects ONLY the identity fields the ledger itself carries.
 * `updater` supplies every NON-identity field a caller's SOURCE.json shape wants
 * (canonicalManifestUrl, canonicalBundleUrl, selfUpdate, builder, updateManaged, origin, …) —
 * spread first so identity fields read from `generation` always win, the same adapter pattern
 * scripts/build-bundle.mjs's projectStoreViews already uses for the release-time case ("only its
 * non-identity updater fields are borrowed per store; sourceCommit/builtUtc are always bound from
 * the selected generation record, never independently trusted from the updater's own copy"). This
 * function does not default those non-identity fields itself: a public-bundle store and a private
 * overlay store want genuinely different shapes (a private store has no selfUpdate command at
 * all, since forge-update.mjs never fetches it) — each caller states what IT needs.
 */
export function projectSourceStore(name, generation, updater = {}) {
  if (!generation) throw new Error(`projectSourceStore: no ledger generation record for ${name}`);
  return {
    ...updater,
    kbName: updater.kbName || name,
    sourceRepo: generation.sourceRepo ?? null,
    sourceCommit: generation.sourceCommit ?? null,
    sourceDescribe: generation.sourceDescribe ?? null,
    builtUtc: generation.builtUtc,
  };
}

export function verifyRvfGenerations(dir, {
  version = getVersion(),
  releaseTag = getVersionTag(),
  requiredStores = [],
  allowMissingFiles = false,
  verifyBytes = true,
} = {}) {
  const manifest = readRvfGenerations(dir);
  const failures = [];
  if (manifest.brainVersion !== version) failures.push(`brainVersion=${manifest.brainVersion}, expected ${version}`);
  if (manifest.releaseTag !== releaseTag) failures.push(`releaseTag=${manifest.releaseTag}, expected ${releaseTag}`);
  // `verifyBytes: false` verifies ONLY the committed ledger fields above.
  //
  // WHY: the `.rvf` binaries are gitignored (.gitignore:28 `kb/*.rvf`), so a byte comparison is a
  // statement about the machine running the check, not about the commit being pushed. This ledger
  // records 72 stores; a working checkout routinely has a different set — the nightly rebuilds RVFs
  // and regenerates the ledger together (kb/forge-refresh.mjs:242), so between those two moments any
  // developer tree disagrees. Wired into the pre-push gate this was unsatisfiable: it blocked EVERY
  // push, including tags, and its own remedy line ("Run: node scripts/sync-version.mjs") could not
  // clear it because the byte check lives under `if (CHECK)` and write mode never regenerates. That
  // is what forced the 4.0.7 emergency promotion.
  //
  // release.mjs:100 already states the governing principle for this repo: "A verdict is only about
  // the exact committed candidate." Bytes are verified where they are actually present and actually
  // shipped — scripts/build-bundle.mjs:204-214, at bundle assembly — which is exactly what the
  // deferral comment in sync-version.mjs promised but never had a caller for.
  for (const store of requiredStores) {
    if (!manifest.stores[store]) failures.push(`${store}: no generation record`);
  }
  if (!verifyBytes) return { manifest, failures };
  for (const [store, generation] of Object.entries(manifest.stores)) {
    const file = path.join(dir, generation.file || `${store}.big.rvf`);
    if (!fs.existsSync(file)) {
      if (!allowMissingFiles) failures.push(`${store}: missing ${path.basename(file)}`);
      continue;
    }
    const actual = sha256File(file);
    if (actual !== generation.sha256) failures.push(`${store}: sha256=${actual}, recorded ${generation.sha256}`);
  }
  return { manifest, failures };
}

// Release-time closure check for the exact public roots selected for a bundle. Unlike the
// source-only verifier above, this rejects every ambiguity in the byte-bearing asset directory.
export function validateSelectedRvfGenerations(dir, {
  selectedStores = canonicalRvfStores(dir),
  privateStores = [],
  excludedStores = [],
  version,
  releaseTag,
} = {}) {
  const manifest = readRvfGenerations(dir);
  const failures = [];
  const selected = [...new Set(selectedStores)].sort();
  const selectedLower = new Map(selected.map((name) => [name.toLowerCase(), name]));
  const privateLower = new Set(privateStores.map((name) => String(name).toLowerCase()));
  const excludedLower = new Set(excludedStores.map((name) => String(name).toLowerCase()));
  if (version !== undefined && manifest.brainVersion !== version) failures.push(`brainVersion=${manifest.brainVersion}, expected ${version}`);
  if (releaseTag !== undefined && manifest.releaseTag !== releaseTag) failures.push(`releaseTag=${manifest.releaseTag}, expected ${releaseTag}`);
  for (const name of selected) if (privateLower.has(name.toLowerCase())) failures.push(`${name}: private store selected`);
  for (const name of selected) if (excludedLower.has(name.toLowerCase())) failures.push(`${name}: excluded store selected`);
  for (const [store, row] of Object.entries(manifest.stores || {})) {
    const canonical = selectedLower.get(store.toLowerCase());
    if (!canonical) {
      if (!privateLower.has(store.toLowerCase()) && !excludedLower.has(store.toLowerCase())) {
        failures.push(`${store}: extra generation record`);
      }
      continue;
    }
    if (canonical !== store) failures.push(`${store}: alias differs from selected store ${canonical}`);
    const expectedFile = `${canonical}.big.rvf`;
    if (row?.file !== expectedFile) failures.push(`${store}: file=${row?.file}, expected ${expectedFile}`);
    const file = path.join(dir, expectedFile);
    if (!fs.existsSync(file)) failures.push(`${store}: missing ${expectedFile}`);
    else {
      const stat = fs.statSync(file);
      if (row?.bytes !== stat.size) failures.push(`${store}: bytes=${row?.bytes}, actual ${stat.size}`);
      const digest = sha256File(file);
      if (row?.sha256 !== digest) failures.push(`${store}: sha256=${digest}, recorded ${row?.sha256}`);
    }
    if (typeof row?.model !== 'string' || !row.model.trim()) failures.push(`${store}: invalid model`);
    if (!Number.isInteger(row?.dimensions) || row.dimensions <= 0) failures.push(`${store}: invalid dimensions`);
    if (row?.sourceCommit !== null && (typeof row?.sourceCommit !== 'string' || !/^[a-f0-9]{7,64}$/i.test(row.sourceCommit))) failures.push(`${store}: invalid sourceCommit`);
    if (typeof row?.builtUtc !== 'string' || !Number.isFinite(Date.parse(row.builtUtc))) failures.push(`${store}: invalid builtUtc`);
  }
  for (const name of selected) if (!manifest.stores?.[name]) failures.push(`${name}: no exact generation record`);
  const publicRows = Object.keys(manifest.stores || {}).filter((name) => !privateLower.has(name.toLowerCase())
    && !excludedLower.has(name.toLowerCase()));
  if (publicRows.length !== selected.length) failures.push(`store count=${publicRows.length}, selected ${selected.length}`);
  return { manifest, selectedStores: selected, excludedStores: [...excludedLower].sort(), failures };
}
