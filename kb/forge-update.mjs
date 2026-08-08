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
import { createHash } from 'node:crypto';
import { extractZip } from './zip-extract.mjs';
import { applyBrainProfile, readBrainProfile } from './brain-profile.mjs';

const KB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(KB_DIR, 'SOURCE.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const RESTORE_COMPLETE = argv.includes('--restore-complete');
const ONLY = argv.find((a) => !a.startsWith('--'));

/**
 * EXIT CODES — anything scripting this (a cron line, a LaunchAgent, `npx ruvnet-brain --update`)
 * reads only this number, so each one means exactly one thing:
 *
 *    0  --check: current  ·  --apply: the bundle on disk genuinely moved
 *    1  configuration/verification error; local copy may need the rollback beside it
 *    2  network / canonical manifest unreachable — nothing was touched
 *    3  the signature could not be fetched — refused to apply
 *    4  signature verification FAILED — refused to apply
 *   10  --check: a newer build exists
 *   11  --apply: the download completed but the bundle on disk did NOT change (issue #106)
 *
 * 11 is deliberately NOT 1: it is a truthful verdict about an intact KB, not a broken updater, so
 * a caller can tell "nothing landed" apart from "something went wrong" — and must not retry it as
 * if a fresh install would help.
 */
export const EXIT_NOT_LANDED = 11;

// ── ROLLBACK COPIES — ONE settlement point, on EVERY exit path ────────────────────────────────
// `process.exit()` does NOT run `finally` blocks, so a die() anywhere below the directory swap used
// to leave a multi-gigabyte rollback copy behind with nothing to release it. Issue #108 measured
// exactly that: ~1.6 GB stranded per night, ten copies (~16 GB) before the owner noticed — and the
// run that stranded them had actually SUCCEEDED. Every exit now passes through settleRollback(), so
// the copy is either RELEASED or deliberately KEPT and named. Never silently stranded.
const backupsMade = [];
let rollbackSettled = false;
function settleRollback({ reclaimable, keepReason = null, intentionallyRemovedStores = [] }) {
  if (rollbackSettled) return;
  rollbackSettled = true;
  if (!reclaimable) {
    // A rollback copy is only dead weight once the copy in place is known good. When it is NOT,
    // this directory is the user's recovery — deleting it to "not strand resources" would be the
    // far worse bug. Keep it, and say where it is and why.
    for (const b of backupsMade) {
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

function relativeFiles(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not a governed regular file: ${relative}`);
    if (entry.isDirectory()) files.push(...relativeFiles(dir, relative));
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
async function fetchBuffer(url) {
  let res;
  try { res = await fetch(url, { redirect: 'follow' }); }
  catch (e) { die(`network failure downloading ${url}\n  ${e.message} — nothing changed locally.`, 2); }
  if (!res.ok) die(`bundle download returned HTTP ${res.status} for ${url} — nothing changed.`, 2);
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
    copyTree(extractDir, kbDir);
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
      stores.set(`store:${name}`, generation.file);
      declaredFiles.add(generation.file);
    }
  } catch (error) {
    if (hasGenerationFile) { complete = false; reason = `unreadable RVF-GENERATIONS.json: ${error.message}`; }
  }
  try {
    const files = relativeFiles(dir);
    for (const relative of files.filter((name) => name.endsWith('.rvf'))) {
      if (!declaredFiles.has(relative)) {
        stores.set(`file:${relative}`, relative);
      }
    }
    const legacyMetadata = new Set([
      'SOURCE.json', 'repo-aliases.json', 'capability-cards.md', 'package.json', 'package-lock.json',
      'forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'manifest.json',
    ]);
    if (!hasGenerationFile && files.some((name) => !name.endsWith('.rvf') && !legacyMetadata.has(path.basename(name)))) {
      complete = false; reason = 'legacy inventory contains unclassified non-RVF files';
    }
  } catch (error) {
    complete = false; reason = `unreadable inventory tree: ${error.message}`;
  }
  return { stores, complete, reason };
}

/** Recursive byte size, for honestly reporting how much was actually reclaimed. */
function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { total += fs.statSync(p).size; } catch { /* vanished mid-walk */ } }
    }
  };
  walk(dir);
  return total;
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
  const liveInventory = storeInventory(kbDir);
  const allowedMissing = new Set(intentionallyRemovedStores.flatMap((store) => [
    `store:${store}`,
    `file:${store}.rvf`,
    `file:${store}.big.rvf`,
  ]));

  for (const b of all) {
    if (!fs.existsSync(b)) continue;
    if (env.RUVNET_KEEP_BACKUP === '1') { kept.push([b, 'RUVNET_KEEP_BACKUP=1 is set']); continue; }
    const backupInventory = storeInventory(b);
    if (!liveInventory.complete || !backupInventory.complete) {
      kept.push([b, `inventory is incomplete; refusing destructive reclaim (${backupInventory.reason || liveInventory.reason || 'unknown'})`]);
      continue;
    }
    const lost = [...backupInventory.stores].filter(([identity]) => !liveInventory.stores.has(identity) && !allowedMissing.has(identity));
    if (lost.length) {
      const labels = lost.map(([, file]) => file);
      kept.push([b, `it holds ${lost.length} store(s) the new copy does NOT have: ${labels.slice(0, 3).join(', ')}${lost.length > 3 ? '…' : ''}`]);
      continue;
    }
    const size = dirSize(b);
    try { fs.rmSync(b, { recursive: true, force: true }); removed.push(b); freed += size; }
    catch (e) { kept.push([b, `could not remove: ${e.message}`]); }
  }
  return { removed, kept, freed };
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

  if (!anyBehind) { console.log(`\nNothing to apply — already current.`); process.exit(0); }

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
  const mismatches = [];
  let attempted = 0;
  let privateOverlay;
  try { privateOverlay = capturePrivateOverlayState({ kbDir: KB_DIR, allStores: stores }); }
  catch (e) { die(`private overlay preflight failed: ${e.message} — refusing to update.`); }

  for (const { local } of behindStores) {
    attempted++;
    // ── RESOLVE THE BUNDLE URL FROM THE LIVE MANIFEST, NOT THE PINNED LOCAL COPY (issue #35 item 1) ─
    const resolved = resolveBundleUrl({ canon, local, source });
    if (!resolved.url) die(`[${local.kbName}] no canonicalBundleUrl in SOURCE.json and no resolvable asset in the live manifest — cannot self-update this store.`);
    if (resolved.warning) console.warn(`\n  ⚠ ${resolved.warning}`); // issue #35 item 3: never fall back silently
    const bundleUrl = resolved.url;
    const originLabel = resolved.origin === 'latest-release-asset' ? `live release asset "${resolved.assetName}"`
      : resolved.origin === 'live-manifest' ? `live manifest entry for ${local.kbName}`
      : 'PINNED FALLBACK (see warning above)';
    console.log(`\n[${local.kbName}] downloading ${bundleUrl}\n  (source: ${originLabel}) ...`);
    const buf = await fetchBuffer(bundleUrl);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `forge-update-${local.kbName}-`));
    const zipPath = path.join(tmp, 'bundle.zip'), extractDir = path.join(tmp, 'extracted');
    fs.writeFileSync(zipPath, buf); fs.mkdirSync(extractDir, { recursive: true });
    console.log(`  downloaded ${(buf.length / 1e6).toFixed(1)} MB.`);

    // ── SIGNED AUTO-APPLY (SEC-0010 #6) — verify BEFORE extracting executable code ────────────────
    // Trust root = the Ed25519 public key ALREADY on disk from the last good install (KB_DIR/keys/…),
    // NOT a key riding inside this download. So a tampered bundle cannot supply its own key: we check
    // the new zip against the key we already trusted. Fail-closed — any doubt, refuse, local untouched.
    const verifierPath = path.join(KB_DIR, 'verify-bundle.mjs');
    const keyPath = path.join(KB_DIR, 'keys', 'ruvnet-brain-signing.pub.pem');
    if (fs.existsSync(verifierPath) && fs.existsSync(keyPath)) {
      let sigBuf;
      try { sigBuf = await fetchBuffer(`${bundleUrl}.sig`); }
      catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); die(`[${local.kbName}] cannot fetch the signature (${bundleUrl}.sig): ${e.message}\n  REFUSING to apply an unverifiable bundle — your current brain is untouched.`, 3); }
      const sigPath = path.join(tmp, 'bundle.zip.sig');
      fs.writeFileSync(sigPath, sigBuf);
      const { verifyBundle } = await import(pathToFileURL(verifierPath).href);
      const v = verifyBundle(zipPath, sigPath, keyPath);
      if (!v.ok) { fs.rmSync(tmp, { recursive: true, force: true }); die(`[${local.kbName}] ✗ SIGNATURE VERIFICATION FAILED: ${v.reason}\n  REFUSING to apply — the download may be tampered. Your current brain is untouched.`, 4); }
      console.log(`  ✓ signature verified — ${v.reason}`);
    } else {
      // Bootstrap: a bundle from before signed auto-apply has no verifier/key on disk yet. It can't
      // check a signature it never shipped the means to check. Apply this once (the new bundle INSTALLS
      // the verifier + key), so every auto-update AFTER this one is signature-checked. Installer-driven
      // updates (`npx ruvnet-brain@latest --update`) verify via the npm package's own key regardless.
      console.log(`  ⚠ this brain predates signed auto-apply — applying UNVERIFIED once to install the verifier; every auto-update after this is signature-checked.`);
    }
    console.log(`  extracting...`);
    // In-process extraction (node:zlib) — never a shelled-out `unzip`. This self-updater runs on
    // whatever machine installed the brain, and on Windows `unzip` is either absent entirely
    // (PowerShell) or present-but-broken by backslash paths reaching an MSYS2 build via cmd.exe.
    // Both were measured on the stranger-machine matrix. Same module the installer uses, so there
    // is exactly one extraction implementation in the product. Failures still name the archive and
    // the offending entry, and NOTHING local is touched before this succeeds.
    try { await extractZip(zipPath, extractDir); }
    catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); die(`[${local.kbName}] extraction failed: ${e.message} — local files untouched.`); }
    const backupPath = path.join(path.dirname(KB_DIR), `${path.basename(KB_DIR)}.bak-${stamp()}`);
    console.log(`  backing up current copy -> ${backupPath}`);
    console.log(`  (temporary — released automatically once the new copy verifies)`);
    fs.cpSync(KB_DIR, backupPath, { recursive: true });
    backupsMade.push(backupPath);
    try {
      const restored = applyPublicBundlePreservingPrivate({ extractDir, kbDir: KB_DIR, backupPath, overlay: privateOverlay });
      if (restored.restored) console.log(`  restored ${restored.restored} private overlay registration(s).`);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      die(`[${local.kbName}] PRIVATE OVERLAY RESTORE FAILED: ${e.message}\n  Previous copy remains at ${backupPath}. REFUSING to reclaim it or report success.`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`  files replaced.`);

    // ── VERIFY WHAT ACTUALLY LANDED (issue #35 item 2) ────────────────────────────────────────────
    // Re-read the SOURCE.json this extraction just wrote to KB_DIR and confirm it genuinely differs
    // from the copy we started with (and, when GitHub gave us a digest, that the bytes match it).
    // Do NOT trust `canon` here — that lookup happened before any download and says nothing about
    // what is now actually on disk. See verifyLanded()'s doc comment for why this can't reuse
    // isBehind() safely.
    const verified = verifyLanded({
      kbDir: KB_DIR, kbName: local.kbName, before: local, beforeBundle: source,
      expectedDigest: resolved.digest, downloadedBuffer: buf,
    });
    if (!verified.ok) {
      // 'damaged' — the copy in place is suspect. die() KEEPS the rollback and names it.
      if (verified.kind !== 'noop') {
        die(`[${local.kbName}] UPDATE MISMATCH: ${verified.reason}\n  REFUSING to report success.`);
      }
      // --restore-complete deliberately re-lands the SAME bundle, to bring back artifacts a profile
      // removed. An unchanged identity is the EXPECTED outcome of that request, not a failed
      // update: what it restores is FILES, which SOURCE.json's identity has nothing to say about.
      if (RESTORE_COMPLETE) {
        unchangedStores.push(local.kbName);
        landedByStore.set(local.kbName, { landed: verified.landed, origin: resolved.origin, assetName: resolved.assetName });
        continue;
      }
      // 'noop' — the bundle did not move. The KB in place is intact (it is what the rollback copy
      // already holds), so there is nothing to roll back TO that differs, and the run is settled
      // once below rather than aborting here. Every store in this bundle shares its identity, so
      // re-downloading the rest to prove the same thing would cost gigabytes for no new fact.
      mismatches.push({ kbName: local.kbName, reason: verified.reason });
      break;
    }
    if (verified.storeUnchanged) unchangedStores.push(local.kbName);
    landedByStore.set(local.kbName, { landed: verified.landed, origin: resolved.origin, assetName: resolved.assetName });
  }

  if (mismatches.length) {
    // ── THE BUNDLE DID NOT MOVE — SAY SO IN THE EXIT CODE (issue #106) ───────────────────────────
    // The mid-log error was already correct and named the issue; what a script or a scheduled job
    // reads is the exit code, and that used to be swallowed. Release the rollback copy FIRST
    // (issue #108): nothing changed, so it duplicates the copy in place byte for byte and is pure
    // waste — ~1.6 GB of it per run, which is how the two issues turned out to be one run.
    settleRollback({ reclaimable: true });
    console.error(`\n[forge-update] ERROR: [${mismatches[0].kbName}] UPDATE MISMATCH: ${mismatches[0].reason}`);
    console.error(`\n=== NOT DONE — 0 of ${behindStores.length} store(s) moved ===`);
    console.error(`  ${mismatches.length} store(s) reported UPDATE MISMATCH: ${mismatches.map((m) => m.kbName).join(', ')}`);
    if (attempted < behindStores.length) {
      console.error(`  stopped at the first mismatch; ${behindStores.length - attempted} store(s) not attempted (same bundle, same verdict).`);
    }
    console.error(`  exiting ${EXIT_NOT_LANDED}: the download completed but the corpus on disk did not change, so no`);
    console.error(`  script or scheduled job may read this run as success.`);
    process.exit(EXIT_NOT_LANDED);
  }

  // Re-verify only the updated store(s) with the bundled guard. forge-guard.mjs takes the KB
  // name + dir; pass them so a single-store copy doesn't fail on absent sibling stores.
  const guard = path.join(KB_DIR, 'forge-guard.mjs');
  if (fs.existsSync(guard)) {
    for (const { local } of behindStores) {
      console.log(`\nre-verifying [${local.kbName}] with forge-guard.mjs ...`);
      try { execFileSync(process.execPath, [guard, '--dir', KB_DIR, '--name', local.kbName], { cwd: KB_DIR, stdio: 'inherit' }); }
      catch { die(`forge-guard FAILED for [${local.kbName}] after update. Previous copy backed up beside the KB dir (*.bak-*). Restore it if needed.`); }
    }
  } else {
    console.log(`\n(no forge-guard.mjs found to re-verify — skipped)`);
  }

  let intentionallyRemovedStores = [];
  if (activeProfile !== 'complete') {
    const scoped = applyBrainProfile(KB_DIR, activeProfile);
    intentionallyRemovedStores = scoped.removedStores;
    console.log(`\nprofile ${activeProfile}: kept ${scoped.stores.join(', ')}; removed ${scoped.removed.length} unselected artifact(s).`);
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
  console.log(`\n=== DONE — ${behindStores.length} store(s) updated ===`);
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
  console.log(`\n(the above is read back from disk, verified — not a tag lookup)`);
  process.exit(0);
}

// Run ONLY when executed directly. `reclaimBackups` is exported for its own tests, and without this
// guard merely importing this file would start a live update — a network fetch, a directory swap, and
// a process.exit() inside whatever imported it. (Found exactly that way: the reclaim test's import
// began racing a real update against the test run.)
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => die(`unexpected: ${e.message}`));
