// DISTINCT-FROM: kb/forge-update.mjs reclaimBackups/assertRedundantBackup — that proof requires every byte of a copy to survive in live, which no older generation satisfies; this one requires byte-identity only for private-store files and public provenance for stores the live brain lacks (ADR-0098).
//
// kb-copy-proof.mjs — may a full copy of the knowledge base be deleted? The ONE proof used by the
// footprint sweep (plugin/scripts/brain-footprint.mjs) and by the installer right after it activates a
// new generation (bin/install.mjs unzipInto). Pure read; never follows a link; never writes.
//
// A copy is DISPOSABLE only when nothing in it is unique. Every file must be one of:
//   * a PRIVATE-store file (names from the PRIVATE-STORES.json fence of the live brain AND of the copy, plus
//     every updateManaged:false store in either SOURCE.json; membership rule = kb/forge-update.mjs
//     capturePrivateOverlayState) that exists BYTE-IDENTICAL at the same path in the live brain — nothing
//     else excuses a private file;
//   * a public release file: listed with these exact bytes in the copy's own ARCHIVE-MANIFEST.json, or a
//     name the live generation ships, or a member of a public store family (named by either COVERAGE.json
//     or the live SOURCE.json) that a newer release replaced or retired;
//   * installer-written or reinstallable (node_modules/, the updater/validator files the installer places);
//   * a symbolic link identical in the live brain (links are compared, never followed).
// Anything else — a user's own file, an unfenced store, a link the live brain lacks — KEEPS the copy, and
// is named. The live brain itself must be present, so a copy is never removed while it may be the only one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isVolumeMetadata } from './footprint-io.mjs';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const lstat = (file) => { try { return fs.lstatSync(file); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every regular file and link under `root`, relative, without following links. macOS volume metadata
 * (AppleDouble `._*` shadows on an exFAT disk, .DS_Store, …) is the volume's, never a copy's unique data. */
function walk(root, prefix = '', out = []) {
  for (const name of names(path.join(root, prefix)).filter((n) => !isVolumeMetadata(n))) {
    const relative = prefix ? path.join(prefix, name) : name;
    const st = lstat(path.join(root, relative));
    if (!st) continue;
    if (st.isSymbolicLink()) out.push({ relative, link: true });
    else if (st.isDirectory()) walk(root, relative, out);
    else if (st.isFile()) out.push({ relative, link: false, size: st.size });
  }
  return out;
}

const storeList = (source) => {
  const stores = source?.stores;
  if (Array.isArray(stores)) return stores;
  return stores && typeof stores === 'object' ? Object.entries(stores).map(([kbName, value]) => ({ kbName, ...value })) : [];
};
const stemOf = (file) => path.basename(String(file)).replace(/(?:\.big)?\.rvf$/i, '').toLowerCase();
// The store a sidecar belongs to: <store>.big.rvf[.embed|.idmap].json, <store>.meta.json, <store>.passages.jsonl,
// <store>.symbols.json, <store>-primer.md.
const storeStem = (file) => path.basename(String(file)).toLowerCase()
  .replace(/-primer\.md$/, '').replace(/(?:\.big)?\.rvf(?:\.[a-z]+\.json)?$/, '').replace(/\.(?:meta|symbols)\.json$|\.passages\.jsonl$/, '');
// Files the installer/updater writes into a KB that no bundle ships (bin/install.mjs placeUpdater,
// placeTrustedCoverageValidator, ensureVerifier; the updater's snapshot receipt). Re-created on every install.
const INSTALLER_WRITTEN = new Set(['coverage-integrity.mjs', 'RUNTIME-IDENTITY.json', '.refresh-snapshot.json',
  'forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs', 'update-storage-transaction.mjs',
  'lifecycle-evidence-retention.mjs', 'corpus-release-identity.mjs', 'verify-citation.mjs', 'package-lock.json', '.DS_Store']);

/** A directory that is a knowledge-base tree (SOURCE.json plus a store or the search entry point). */
export const isKbTree = (dir) => Boolean(lstat(path.join(dir, 'SOURCE.json')))
  && names(dir).some((n) => /\.rvf$/i.test(n) || n === 'forge-mcp-all.mjs');

/** Private store names the given trees declare: PRIVATE-STORES.json fences and updateManaged:false stores. */
export function privateStoreNames(dirs) {
  const out = new Set();
  for (const dir of dirs) {
    const fence = readJson(path.join(dir, 'PRIVATE-STORES.json'))?.privateStores;
    for (const name of Array.isArray(fence) ? fence : []) out.add(String(name).toLowerCase());
    for (const store of storeList(readJson(path.join(dir, 'SOURCE.json')))) {
      if (store?.updateManaged === false && store.kbName) out.add(String(store.kbName).toLowerCase());
    }
  }
  return out;
}

/** The capturePrivateOverlayState membership rule (kb/forge-update.mjs), applied to one relative path. */
function belongsToPrivate(relative, privateNames, privateArtifacts) {
  const base = path.basename(relative).toLowerCase();
  for (const name of privateNames) if (base === name || base.startsWith(`${name}.`) || base.startsWith(`${name}-`)) return true;
  return privateArtifacts.some(({ directory, basename, stem }) => path.dirname(relative) === directory
    && (base === basename || base.startsWith(`${basename}.`) || base.startsWith(`${stem}.`) || base.startsWith(`${stem}-`)));
}

const sameBytes = (left, right) => {
  const a = lstat(left); const b = lstat(right);
  if (!a || !b || !a.isFile() || !b.isFile() || a.isSymbolicLink() || b.isSymbolicLink() || a.size !== b.size) return false;
  try { return sha256File(left) === sha256File(right); } catch { return false; }
};

/**
 * @returns {{disposable: boolean, unique: {file: string, why: string}[], reason: string}} — a kept copy
 * always names the files that keep it.
 */
export function kbCopyProof({ copyDir, liveDir }) {
  const copy = lstat(copyDir);
  if (!copy || copy.isSymbolicLink() || !copy.isDirectory()) return { disposable: false, unique: [], reason: 'not a real directory (a link is never entered)' };
  const live = lstat(liveDir);
  if (!live || !live.isDirectory() || !readJson(path.join(liveDir, 'SOURCE.json'))
    || !names(liveDir).some((name) => /\.rvf$/i.test(name))) {
    return { disposable: false, unique: [], reason: 'the live brain is missing or incomplete, so this copy may be the only good one' };
  }
  const privateNames = privateStoreNames([liveDir, copyDir]);
  const generations = readJson(path.join(copyDir, 'RVF-GENERATIONS.json'))?.stores || {};
  const privateArtifacts = Object.entries(generations).filter(([name]) => privateNames.has(name.toLowerCase()))
    .map(([, g]) => String(g?.file || '')).filter(Boolean).map((file) => ({ directory: path.dirname(path.normalize(file)),
      basename: path.basename(file).toLowerCase(), stem: stemOf(file) }));
  const coverageNames = (dir) => (readJson(path.join(dir, 'COVERAGE.json'))?.rows || [])
    .flatMap((row) => [row?.artifact?.store, row?.name]).filter(Boolean).map((n) => String(n).toLowerCase());
  const publicNames = new Set([...coverageNames(liveDir), ...coverageNames(copyDir),
    ...storeList(readJson(path.join(liveDir, 'SOURCE.json'))).filter((s) => s?.updateManaged !== false)
      .map((s) => String(s.kbName || '').toLowerCase())]);
  for (const name of privateNames) publicNames.delete(name); // a fenced name is never "public provenance"
  // The copy's own signed release manifest (scripts/build-bundle.mjs, every bundle since 2026-08-23): a file
  // it lists with these exact bytes is a public, re-downloadable release file.
  const shipped = new Map((readJson(path.join(copyDir, 'ARCHIVE-MANIFEST.json'))?.files || [])
    .filter((f) => typeof f?.path === 'string').map((f) => [path.normalize(f.path), f]));
  const unique = [];
  let files;
  try { files = walk(copyDir); } catch (error) { return { disposable: false, unique, reason: `unreadable copy: ${error.message}` }; }
  for (const { relative, link, size } of files) {
    // node_modules (npm reinstalls it) and .console-runtime (bin/install.mjs installConsoleRuntime re-places it)
    if (['node_modules', '.console-runtime'].includes(relative.split(path.sep)[0])
      || (!relative.includes(path.sep) && INSTALLER_WRITTEN.has(relative))) continue;
    const isPrivate = belongsToPrivate(relative, privateNames, privateArtifacts);
    const inLive = path.join(liveDir, relative);
    if (link) {
      const liveLink = lstat(inLive);
      const same = liveLink?.isSymbolicLink() && fs.readlinkSync(inLive) === fs.readlinkSync(path.join(copyDir, relative));
      if (!same) unique.push({ file: relative, why: 'a symbolic link the live brain does not have (never followed)' });
      continue;
    }
    if (isPrivate) {
      if (!sameBytes(path.join(copyDir, relative), inLive)) {
        unique.push({ file: relative, why: lstat(inLive) ? 'private file differs from the live brain' : 'private file absent from the live brain' });
      }
      continue;
    }
    if (relative === 'ARCHIVE-MANIFEST.json' && shipped.size) continue; // the release manifest itself
    const listed = shipped.get(relative);
    if (listed && listed.bytes === size && listed.sha256 === sha256File(path.join(copyDir, relative))) continue;
    if (lstat(inLive)) continue; // a release-owned name the live generation ships (same or newer bytes)
    if (publicNames.has(storeStem(relative))) continue; // a public store family a newer release replaced or retired
    unique.push({ file: relative, why: 'not in the live brain, not in this copy\'s release manifest, not a public store' });
  }
  return unique.length
    ? { disposable: false, unique, reason: `holds ${unique.length} file(s) the live brain does not: ${unique.slice(0, 4).map((u) => u.file).join(', ')}${unique.length > 4 ? ', …' : ''}` }
    : { disposable: true, unique, reason: 'every private file is byte-identical in the live brain; public bytes are re-downloadable' };
}
