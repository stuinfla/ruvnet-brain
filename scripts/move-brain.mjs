// move-brain.mjs — `npx ruvnet-brain --move-brain <dir>`: put the whole Brain on another disk with one
// command, and `--move-brain --back` to bring it home.
//
// Design (decided 2026-10-01): the Brain stays addressed by its default path, ~/.cache/ruvnet-brain, which
// becomes a symlink (a junction on Windows) to the new location. Every reader, hook, the MCP server and the
// nightly keep their path and follow the link, so nothing else needs configuring (an env var would not reach
// GUI-launched hosts or launchd). The move is: take the refresh lock the updater takes, preflight space, copy,
// PROVE every source file arrived byte-identical, swap the link, then remove the old copy. Any failure before
// the swap leaves the Brain exactly where it was and removes the copy; a failure DURING the swap is rolled
// back step by step, and the message says plainly where the Brain is.
//
// What the proof ignores, and why (review S1/S2, reproduced on a real exFAT image 2026-10-01):
//   - VOLUME METADATA, on either side. macOS writes an AppleDouble `._<name>` beside every copied file that
//     has extended attributes on exFAT/FAT/NTFS/SMB, and volumes grow .DS_Store/.Spotlight-V100/.fseventsd/
//     .Trashes. They are the filesystem's, not the Brain's (no release ships one; coverage-integrity skips
//     `._*` too). So they are never copied — `--back` from exFAT used to bring `._ruvector.rvf` home, where
//     every reader saw a fake `._ruvector` store — and never compared or required on either side.
//   - TRANSIENT IPC in run/. A search worker's recommender socket (run/recommend-<pid>.sock) is a live
//     endpoint, not data; a SIGKILLed worker leaves it behind. Stale ones are swept exactly as the endpoint
//     sweeps them on start (kb/recommend-endpoint.mjs sweepStale — not shipped in the npm package, so the
//     rule is repeated here and held equal by tests/unit/move-brain.test.mjs); live ones are not copied.
//   Any other socket, FIFO or device anywhere in the Brain refuses the move by name, before anything is copied.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brainLocation, defaultBrainHome } from '../plugin/scripts/brain-location.mjs';
import { checkDiskSpace, directoryBytes } from '../kb/update-storage-transaction.mjs';
import { acquireRefreshLock, releaseRefreshLock } from '../kb/refresh-run.mjs';

// The plugin updater's own locks (plugin/scripts/update-apply.mjs, session-start-health.mjs). The refresh
// lock (kb/refresh-run.mjs) is not merely checked: the move HOLDS it, so no update can start mid-move.
const PLUGIN_LOCK_NAMES = ['.update.lock', 'auto-update.lock'];
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const VOLUME_METADATA = /^(?:\._.+|\.DS_Store|\.Spotlight-V100|\.fseventsd|\.Trashes|\.TemporaryItems|\.apdisk|System Volume Information|\$RECYCLE\.BIN)$/;
const STALE_ENDPOINT = /^recommend-(\d+)\.(json|sock)$/;

class MoveRefused extends Error {}
export { MoveRefused };

const refuse = (message) => { throw new MoveRefused(message); };
const describe = (error) => (error?.code ? `${error.code}: ${error.message}` : String(error?.message || error));

function isEmptyDir(dir) {
  try { return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0; } catch { return false; }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/** The endpoint's own stale rule (kb/recommend-endpoint.mjs sweepStale): a descriptor or socket whose pid is dead. */
export function sweepStaleEndpoints(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    const m = n.match(STALE_ENDPOINT);
    if (!m || pidAlive(Number(m[1]))) continue;
    try { fs.rmSync(path.join(dir, n), { force: true }); removed++; } catch { /* raced */ }
  }
  return removed;
}

/**
 * Walk a Brain tree without following links. Returns Map<relative, {type, size?, target?}> and the list of
 * transient run/ entries (sockets/FIFOs) that are left behind. Any other special file refuses by name.
 */
function inventory(root, { strict = true } = {}) {
  const entries = new Map();
  const transient = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const relative = rel ? path.join(rel, name) : name;
      if (VOLUME_METADATA.test(name)) continue; // the volume's, not the Brain's (header)
      const stat = fs.lstatSync(path.join(root, relative));
      if (stat.isSymbolicLink()) entries.set(relative, { type: 'symlink', target: fs.readlinkSync(path.join(root, relative)) });
      else if (stat.isDirectory()) { entries.set(relative, { type: 'dir' }); walk(relative); }
      else if (stat.isFile()) entries.set(relative, { type: 'file', size: stat.size });
      else if ((stat.isSocket() || stat.isFIFO()) && path.dirname(relative) === 'run') transient.push(relative);
      else if (strict) refuse(`${path.join(root, relative)} is a ${stat.isSocket() ? 'socket' : stat.isFIFO() ? 'named pipe' : 'device or special file'}, `
        + 'which cannot be copied to another disk. Stop whatever created it (or remove it if nothing is using it), then retry. Nothing was moved.');
      else entries.set(relative, { type: 'special' });
    }
  };
  walk('');
  return { entries, transient };
}

function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/**
 * Every source entry must exist at the copy with the same type, and every file the same bytes; the copy may
 * carry nothing else. Volume metadata is invisible to both inventories. Returns null, or what differs.
 */
export function verifyCopy(src, copy, { transient = [] } = {}) {
  const skipped = new Set(transient);
  const source = inventory(src, { strict: false }).entries;
  const landed = inventory(copy, { strict: false }).entries;
  const problems = [];
  for (const [relative, entry] of source) {
    if (skipped.has(relative)) continue;
    const other = landed.get(relative);
    if (!other) problems.push(`${relative} is missing from the copy`);
    else if (other.type !== entry.type) problems.push(`${relative} is a ${other.type} in the copy but a ${entry.type} in the original`);
    else if (entry.type === 'symlink' && other.target !== entry.target) problems.push(`link ${relative} points elsewhere in the copy`);
    else if (entry.type === 'file' && (other.size !== entry.size || fileSha256(path.join(copy, relative)) !== fileSha256(path.join(src, relative)))) {
      problems.push(`${relative} differs (${entry.size} bytes in the original, ${other.size} in the copy)`);
    }
  }
  for (const relative of landed.keys()) {
    if (!source.has(relative)) problems.push(`${relative} is in the copy but not in the original`);
  }
  return problems.length ? `${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}` : null;
}

/** The default fs operations the swap uses — a seam so a test can make any one step fail. */
export const defaultOps = Object.freeze({
  renameSync: (a, b) => fs.renameSync(a, b),
  symlinkSync: (target, link, type) => fs.symlinkSync(target, link, type),
  rmdirSync: (dir) => fs.rmdirSync(dir),
  mkdirSync: (dir) => fs.mkdirSync(dir),
  rmSync: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  copyTree: (src, dest, filter) => fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true,
    errorOnExist: true, force: false, filter }),
});

/**
 * @param {{ home?: string, to?: string, back?: boolean, available?: Function, log?: Function, ops?: object,
 *   lock?: Function }} options
 * @returns {{ from: string, to: string, bytes: number, link: string, warnings: string[] }}
 */
export function moveBrain({ home = os.homedir(), to, back = false, available, log = () => {}, ops: opsOverride = {},
  lock = (brainHome) => acquireRefreshLock({ kbDir: path.join(brainHome, 'kb'), brainHome, action: 'move-brain' }) } = {}) {
  const ops = { ...defaultOps, ...opsOverride };
  const brainHome = defaultBrainHome(home);
  const where = brainLocation({ home });
  if (where.state === 'unmounted') refuse(where.message);
  if (where.state === 'absent') refuse(`no RuvNet Brain is installed at ${brainHome}; nothing to move.`);
  const src = where.real;
  for (const name of PLUGIN_LOCK_NAMES) {
    if (fs.existsSync(path.join(src, name))) refuse(`an update is running (${path.join(src, name)}); retry when it finishes. Nothing was moved.`);
  }

  let dest;
  if (back) {
    if (where.state === 'local') refuse(`the Brain is already at its default location, ${brainHome}.`);
    dest = brainHome;
  } else {
    if (!to || !path.isAbsolute(to)) refuse('--move-brain needs an absolute directory, e.g.  --move-brain /Volumes/SanDisk/ruvnet-brain');
    dest = path.resolve(to);
    if (dest === path.resolve(brainHome)) refuse('that is the default location; use  --move-brain --back  to return there.');
    if (!fs.existsSync(path.dirname(dest))) refuse(`the target's parent ${path.dirname(dest)} does not exist (is the disk mounted?). Nothing was moved.`);
    if (fs.existsSync(dest) && fs.realpathSync(dest) === src) refuse(`the Brain is already at ${dest}.`);
    const rel = path.relative(src, dest);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) refuse('the target is inside the Brain itself.');
    if (fs.existsSync(dest) && !isEmptyDir(dest)) refuse(`the target ${dest} exists and is not empty; choose a new or empty directory.`);
    // The copy is staged beside the target and renamed into place, so the target must be a folder ON the disk,
    // never the disk's own root: staging would land on the parent's filesystem (measured there, copied there).
    if (fs.existsSync(dest) && fs.statSync(dest).dev !== fs.statSync(path.dirname(dest)).dev) {
      refuse(`${dest} is the top of a disk; choose a folder on it, e.g.  --move-brain ${path.join(dest, 'ruvnet-brain')}`);
    }
  }

  let held;
  try { held = lock(brainHome); } catch (error) {
    refuse(`an update is running or its lock is unclear (${describe(error)}); retry when it finishes. Nothing was moved.`);
  }
  try {
    return moveLocked({ where, brainHome, src, dest, back, available, log, ops });
  } finally {
    // Through the default path: after a successful swap the held lock directory lives in the new copy.
    if (held) releaseRefreshLock(held);
  }
}

function moveLocked({ where, brainHome, src, dest, back, available, log, ops }) {
  const warnings = [];
  sweepStaleEndpoints(path.join(src, 'run'));
  const { transient } = inventory(src); // refuses, by name, on any socket/FIFO/device outside run/
  const bytes = directoryBytes(src);
  const stagingDir = path.dirname(dest);
  try {
    const space = checkDiskSpace([{ dir: stagingDir, bytes, purpose: 'Brain copy' }],
      { what: 'move the Brain', bigger: 'choose a folder on a bigger disk', ...(available ? { available } : {}) });
    if (!space.ok) refuse(space.message);
  } catch (error) {
    if (error instanceof MoveRefused) throw error;
    // Node < 18.15 has no fs.statfsSync; an unmeasurable disk is not a refusal. The copy is still verified,
    // and running out of space part-way removes the copy and leaves the Brain where it was.
    const line = `could not measure free space on ${stagingDir} (${describe(error)}); copying anyway — a full disk stops the move safely`;
    warnings.push(line);
    log(line);
  }

  const staging = path.join(stagingDir, `.${path.basename(dest)}.moving-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  const skip = new Set(transient.map((relative) => path.join(src, relative)));
  log(`copying ${src} -> ${dest} …`);
  try {
    try { ops.copyTree(src, staging, (from) => !skip.has(from) && (from === src || !VOLUME_METADATA.test(path.basename(from)))); } catch (error) {
      refuse(error?.code === 'ENOSPC'
        ? `${stagingDir} ran out of space while copying. The partial copy was removed and the Brain is unchanged at ${src}.`
        : `copying to ${stagingDir} failed (${describe(error)}). The partial copy was removed and the Brain is unchanged at ${src}.`);
    }
    const drift = verifyCopy(src, staging, { transient });
    if (drift) {
      refuse(`the copy does not match the original: ${drift}. Either a file changed while it was being copied (retry when no `
        + `search or update is running) or ${stagingDir} did not store it faithfully. The copy was removed and the Brain is unchanged at ${src}.`);
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  swap({ where, brainHome, src, dest, staging, back, ops });
  const landed = fs.realpathSync(brainHome);
  // The previous copy goes only once the default path is proven to resolve to the new one.
  const previous = back || where.state === 'linked' ? src : `${brainHome}.old-${process.pid}`;
  try { if (fs.existsSync(previous)) ops.rmSync(previous); } catch (error) {
    const line = `the previous copy at ${previous} could not be removed (${describe(error)}); it is no longer used — delete it by hand.`;
    warnings.push(line);
    log(line);
  }
  log(`the Brain now lives at ${landed}${back ? '' : ` (${brainHome} links to it)`}`);
  return { from: src, to: landed, bytes, link: brainHome, warnings };
}

/**
 * Point the default path at the verified copy. Every step is recorded and undone in reverse on failure, so
 * the only outcomes are "moved" or "unchanged" — and the message says which, and what is left where.
 */
function swap({ where, brainHome, src, dest, staging, back, ops }) {
  const undo = [];
  const step = (name, run, revert) => { run(); undo.push({ name, revert }); };
  const asideLink = `${brainHome}.link-old-${process.pid}`;
  const tmpLink = `${brainHome}.link-${process.pid}`;
  let failedAt = null;
  let originalAt = src; // where the original Brain's bytes are right now (a local brain home is set aside mid-swap)
  try {
    if (back) {
      failedAt = 'set the old link aside';
      step(failedAt, () => ops.renameSync(brainHome, asideLink), () => ops.renameSync(asideLink, brainHome));
      failedAt = `move the copy into ${brainHome}`;
      step(failedAt, () => ops.renameSync(staging, brainHome), () => ops.renameSync(brainHome, staging));
    } else {
      if (isEmptyDir(dest)) {
        failedAt = `replace the empty folder ${dest}`;
        step(failedAt, () => ops.rmdirSync(dest), () => ops.mkdirSync(dest));
      }
      failedAt = `move the copy into ${dest}`;
      step(failedAt, () => ops.renameSync(staging, dest), () => ops.renameSync(dest, staging));
      failedAt = `create the link ${tmpLink}`;
      fs.rmSync(tmpLink, { force: true });
      step(failedAt, () => ops.symlinkSync(dest, tmpLink, linkType), () => fs.rmSync(tmpLink, { force: true }));
      if (where.state === 'local') {
        const old = `${brainHome}.old-${process.pid}`;
        failedAt = `set ${brainHome} aside`;
        step(failedAt, () => { ops.renameSync(brainHome, old); originalAt = old; },
          () => { ops.renameSync(old, brainHome); originalAt = src; });
        failedAt = `put the link at ${brainHome}`;
        step(failedAt, () => ops.renameSync(tmpLink, brainHome), () => ops.renameSync(brainHome, tmpLink));
      } else {
        failedAt = `replace the link at ${brainHome}`;
        try {
          step(failedAt, () => ops.renameSync(tmpLink, brainHome), () => ops.renameSync(brainHome, tmpLink)); // atomic on POSIX
        } catch (error) {
          // Windows will not rename over an existing junction (EPERM/EEXIST): set the old link aside, then rename.
          if (!['EPERM', 'EEXIST', 'EACCES', 'ENOTEMPTY', 'EISDIR'].includes(error?.code)) throw error;
          failedAt = 'set the old link aside';
          step(failedAt, () => ops.renameSync(brainHome, asideLink), () => ops.renameSync(asideLink, brainHome));
          failedAt = `put the link at ${brainHome}`;
          step(failedAt, () => ops.renameSync(tmpLink, brainHome), () => ops.renameSync(brainHome, tmpLink));
        }
      }
    }
    failedAt = `prove ${brainHome} resolves to ${dest}`;
    const landed = fs.realpathSync(brainHome);
    if (landed !== fs.realpathSync(dest)) throw new Error(`${brainHome} resolves to ${landed}`);
  } catch (error) {
    const unrestored = [];
    for (const { name, revert } of undo.reverse()) {
      try { revert(); } catch (revertError) { unrestored.push(`${name} (${describe(revertError)})`); }
    }
    // The staged copy is a verified duplicate; the original is intact either way, so it can always go.
    let leftover = '';
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { leftover = staging; }
    try {
      if (!leftover && !back && !isEmptyDir(dest) && fs.realpathSync(dest) !== fs.realpathSync(originalAt)) leftover = dest;
    } catch { /* dest absent: nothing left there */ }
    if (unrestored.length) {
      refuse(`moving the Brain failed while trying to ${failedAt} (${describe(error)}), and undoing it also failed at: `
        + `${unrestored.join('; ')}. The original Brain is intact at ${originalAt}; ${brainHome} must point to it again `
        + '(make it a link to that folder, or move that folder back to it) before the Brain is used.'
        + (leftover ? ` The unused copy at ${leftover} can be removed.` : ''));
    }
    // Undone: the default path is exactly as it was.
    try { fs.rmSync(asideLink, { force: true }); } catch { /* only exists if a revert failed, reported above */ }
    refuse(`moving the Brain failed while trying to ${failedAt} (${describe(error)}). Everything was put back: the Brain is `
      + `unchanged at ${src}${where.state === 'linked' ? ` (${brainHome} links to it)` : ''}.`
      + (leftover ? ` A copy at ${leftover} is not used and can be removed.` : ''));
  }
  try { fs.rmSync(asideLink, { force: true }); } catch { /* an unused old link; harmless */ }
}
