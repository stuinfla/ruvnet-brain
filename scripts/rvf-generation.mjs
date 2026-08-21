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
    return { schemaVersion: 1, brainVersion: getVersion(), releaseTag: getVersionTag(), stores: {} };
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
  builtUtc = new Date().toISOString(),
  previousDir = dir,
}) {
  const rvfPath = path.join(dir, rvfFile);
  if (!fs.existsSync(rvfPath)) throw new Error(`cannot stamp missing RVF: ${rvfPath}`);
  const manifest = readRvfGenerations(previousDir);
  manifest.schemaVersion = 1;
  manifest.brainVersion = getVersion();
  manifest.releaseTag = getVersionTag();
  manifest.stores[store] = {
    file: rvfFile,
    sha256: sha256File(rvfPath),
    bytes: fs.statSync(rvfPath).size,
    model,
    dimensions,
    sourceCommit,
    builtUtc,
  };
  fs.writeFileSync(path.join(dir, RVF_GENERATIONS_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.stores[store];
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
  version,
  releaseTag,
} = {}) {
  const manifest = readRvfGenerations(dir);
  const failures = [];
  const selected = [...new Set(selectedStores)].sort();
  const selectedLower = new Map(selected.map((name) => [name.toLowerCase(), name]));
  const privateLower = new Set(privateStores.map((name) => String(name).toLowerCase()));
  if (version !== undefined && manifest.brainVersion !== version) failures.push(`brainVersion=${manifest.brainVersion}, expected ${version}`);
  if (releaseTag !== undefined && manifest.releaseTag !== releaseTag) failures.push(`releaseTag=${manifest.releaseTag}, expected ${releaseTag}`);
  for (const name of selected) if (privateLower.has(name.toLowerCase())) failures.push(`${name}: private store selected`);
  for (const [store, row] of Object.entries(manifest.stores || {})) {
    const canonical = selectedLower.get(store.toLowerCase());
    if (!canonical) {
      if (!privateLower.has(store.toLowerCase())) failures.push(`${store}: extra generation record`);
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
  const publicRows = Object.keys(manifest.stores || {}).filter((name) => !privateLower.has(name.toLowerCase()));
  if (publicRows.length !== selected.length) failures.push(`store count=${publicRows.length}, selected ${selected.length}`);
  return { manifest, selectedStores: selected, failures };
}
