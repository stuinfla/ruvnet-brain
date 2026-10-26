// Directory ownership protocol shared with agentic-kit. Inherited children do not release the parent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const brainRoot = brainHome => brainHome || process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache/ruvnet-brain');
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A dead or reclaimable owner must have been gone this long; an unreadable owner is judged by the directory's age.
export const STALE_RECLAIM_MS = 10 * 60 * 1000;
// An owner-less lock younger than this is another process between creating the lock and writing its owner.
export const OWNERLESS_GRACE_MS = 5 * 1000;
/** The OS start time of `pid` (`ps -o lstart=`, as kb/refresh-run.mjs records it), or null when it cannot be read (Windows). */
export function processStartOf(pid, { platform = process.platform } = {}) {
  if (platform === 'win32' || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
    const start = String(r.stdout || '').trim();
    return r.status === 0 && start ? start : null;
  } catch { return null; }
}
const removal = directory => process.platform === 'win32' ? `Remove-Item -Recurse -Force "${directory}"` : `rm -rf "${directory}"`;
// ── takeover is serialized (4.7.21 review, Codex #1) ─────────────────────────────────────────────
// Two contenders could judge the same abandoned lock: A moved it aside and acquired, then B moved A's FRESH lock
// aside on its stale judgement and both ran. A takeover now (1) creates an exclusive claim file inside the judged
// directory ('wx': one winner per directory instance), (2) re-checks, while holding the claim, that it is the same
// directory (dev/ino) with byte-identical owner.json, and only then (3) moves it aside. A claim left by a crashed
// reclaimer is superseded by the next numbered claim once CLAIM_STALE_MS old.
// Round 4 (Codex #1): a lock that existed before its owner record (mkdir, then write) could be judged owner-less and old,
// claimed, re-checked (still owner-less, so "the same") and moved aside together with the owner published in between:
// two owners. The lock is now built complete in a staging sibling and published by ONE rename, so it never exists
// without its owner; a rename onto an existing lock fails (ENOTEMPTY/EEXIST, EPERM/EACCES on Windows) and is re-judged.
export const CLAIM_STALE_MS = 5 * 60 * 1000;
const CLAIM_FILE = /^takeover(?:-(\d+))?\.json$/;
function observeDirectory(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('not an owned directory');
  let raw = null;
  try { raw = fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { identity: `${stat.dev}:${stat.ino}`, raw };
}
const readRaw = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
// A claim file must not restart the age an owner-less lock is judged by (Opus r2 #6): writing or removing one bumps the
// directory's mtime, so the directory's own times are put back.
function keepDirectoryTimes(directory, change) {
  let before = null;
  try { before = fs.lstatSync(directory); } catch { /* judged below */ }
  try { return change(); } finally { if (before) try { fs.lutimesSync(directory, before.atime, before.mtime); } catch { /* gone */ } }
}
const GONE = Symbol('judged lock vanished');
function claimTakeover(directory) {
  let highest = -1, highestName = null, names;
  // The judged lock vanished (another reclaimer moved it): re-judge rather than throw (Fable r2 P3-1).
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return GONE; throw error; }
  for (const name of names) {
    const match = CLAIM_FILE.exec(name);
    if (match && (match[1] ? Number(match[1]) : 0) > highest) { highest = match[1] ? Number(match[1]) : 0; highestName = name; }
  }
  if (highestName) {
    let ageMs = 0;
    try { ageMs = Date.now() - fs.lstatSync(path.join(directory, highestName)).mtimeMs; } catch { return null; }
    if (!(ageMs > CLAIM_STALE_MS)) return null; // another reclaimer is mid-takeover
  }
  const level = highest + 1;
  const file = path.join(directory, level ? `takeover-${level}.json` : 'takeover.json');
  const token = crypto.randomUUID();
  try { keepDirectoryTimes(directory, () => fs.writeFileSync(file, JSON.stringify({ token, pid: process.pid, claimedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })); }
  catch (error) { if (error.code === 'EEXIST') return null; if (error.code === 'ENOENT') return GONE; throw error; }
  return { file, token };
}
const dropClaim = claim => { try { if (readRaw(claim.file)?.includes(claim.token)) keepDirectoryTimes(path.dirname(claim.file), () => fs.unlinkSync(claim.file)); } catch { /* gone with its directory */ } };
/** Move `directory` aside only if it is still exactly the one observed: 'removed' | 'changed' | 'busy'. */
function removeObservedLock(directory, observed, { afterClaim = null } = {}) {
  const claim = claimTakeover(directory);
  if (claim === GONE) return 'changed';
  if (!claim) return 'busy';
  afterClaim?.({ directory, claim });
  let same = false;
  try {
    const now = observeDirectory(directory);
    same = now.identity === observed.identity && now.raw === observed.raw && Boolean(readRaw(claim.file)?.includes(claim.token));
  } catch { same = false; }
  if (!same) { dropClaim(claim); return 'changed'; }
  const tomb = `${directory}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try { fs.renameSync(directory, tomb); } catch (error) { if (error.code === 'ENOENT') return 'changed'; dropClaim(claim); throw error; }
  if (!readRaw(path.join(tomb, path.basename(claim.file)))?.includes(claim.token)) {
    try { if (!fs.existsSync(directory)) fs.renameSync(tomb, directory); } catch { /* keep it as evidence */ }
    throw Error(`developer update lock takeover moved a directory it did not claim; ${directory}`);
  }
  fs.rmSync(tomb, { recursive: true, force: true });
  return 'removed';
}
/** Publish the lock with its owner already inside: one rename, which fails when any populated lock is there. */
const CONTENDED = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']);
function publishLock(directory, content) {
  const staged = `${directory}.acquire-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const dropStaged = () => { try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    fs.mkdirSync(staged, { mode: 0o700 });
    fs.writeFileSync(path.join(staged, 'owner.json'), content, { flag: 'wx', mode: 0o600 });
  } catch (error) { dropStaged(); throw error; } // staging failures are real errors, never contention
  try { fs.renameSync(staged, directory); return true; } catch (error) {
    dropStaged();
    // A refused publication is contention even if the lock is gone a moment later: its owner can release in between,
    // and re-checking existsSync here threw a raw ENOTEMPTY at the caller (Opus r3 P2-1). Re-judge (bounded by the caller).
    if (CONTENDED.has(error.code)) return false;
    throw error;
  }
}
export function sharedLockStatus({ brainHome, alive = pidAlive, startOf = processStartOf } = {}) {
  const directory = path.join(brainRoot(brainHome), 'developer-update.lock');
  let status = judgeLock(directory, alive, startOf);
  // An owner-less reading can be the instant between one owner's release and the next owner's publication: the lock was
  // gone (or moved aside before owner.json was read) and a new owner's lock was there when existence was checked. That
  // live lock was judged "unknown" and the refusal offered rm -rf (Opus r3 P2-2). Look again before calling it unknown.
  for (let look = 0; look < 2 && status.state === 'unknown' && (status.observed === null || status.observed.raw === null); look++) {
    let again = null;
    try { again = observeDirectory(directory); } catch { /* vanished or unjudgeable: judged afresh */ }
    if (again && status.observed && again.identity === status.observed.identity && again.raw === null) break; // the same owner-less directory
    status = judgeLock(directory, alive, startOf);
  }
  return status;
}
function judgeLock(directory, alive, startOf) {
  let observed = null;
  try {
    observed = observeDirectory(directory);
    if (observed.raw === null) throw Object.assign(Error('owner.json absent'), { code: 'ENOENT' });
    const owner = JSON.parse(observed.raw);
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || owner.token.length < 16) throw Error('invalid owner');
    if (!alive(owner.pid)) return { state: 'stale', directory, owner, observed };
    // A live pid is the owner only when the recorded process start matches: a reused pid is another process.
    const seen = typeof owner.processStart === 'string' && owner.processStart ? startOf(owner.pid) : null;
    if (seen && seen !== owner.processStart) return { state: 'stale', directory, owner, reusedPid: true, observed };
    return { state: 'running', directory, owner, observed };
  } catch (error) { return { state: error.code === 'ENOENT' && !fs.existsSync(directory) ? 'idle' : 'unknown', directory, error: error.message, observed }; }
}
export function acquireDeveloperLock({ brainHome, token = process.env.RUVNET_DEVELOPER_UPDATE_TOKEN, pid = process.pid, alive, startOf = processStartOf, now = Date.now(), afterTakeoverClaim = null } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = sharedLockStatus({ brainHome, alive, startOf });
    if (token && status.state === 'running' && status.owner.token === token) return { token, ownerPid: status.owner.pid, inherited: true, release() {} };
    // A dead owner's lock must not wedge every future update (measured 2026-10-15: a coordinator killed mid-run left `stale`
    // behind and the automatic updater refused until a person removed the directory). Reclaimable: a provably dead or reused-pid
    // owner, or a directory with no readable owner (a kill between mkdir and the owner write), once STALE_RECLAIM_MS old by its
    // recorded start or, failing that, the directory's own mtime. The takeover is claimed and re-checked (above), then the
    // normal atomic mkdir claim follows. A live owner, or anything younger, still refuses.
    let ageMs = NaN;
    if (status.state === 'stale' || status.state === 'unknown') {
      ageMs = now - Date.parse(status.owner?.startedAt || '');
      if (!Number.isFinite(ageMs)) try { ageMs = now - fs.lstatSync(status.directory).mtimeMs; } catch { ageMs = NaN; }
    }
    const refuse = state => Error(`developer update lock ${state}; ${status.directory}. If no update is running on this machine, remove it: ${removal(status.directory)}`);
    // A lock with no owner yet that is seconds old is another process mid-creation (agentic-kit writes its owner after its
    // mkdir), not debris: never offer to remove it (Opus r3 P2-2).
    if (status.state === 'unknown' && status.observed?.raw === null && Number.isFinite(ageMs) && ageMs < OWNERLESS_GRACE_MS) {
      throw Error(`developer update lock is being created by another process; ${status.directory}. Retry shortly.`);
    }
    if ((status.state === 'stale' || status.state === 'unknown') && Number.isFinite(ageMs) && ageMs >= STALE_RECLAIM_MS) {
      if (!status.observed) throw refuse(status.state); // not a lock directory this protocol can judge (a symlink or a file)
      const outcome = removeObservedLock(status.directory, status.observed, { afterClaim: afterTakeoverClaim });
      if (outcome === 'busy') throw refuse('is being reclaimed by another process');
      continue; // 'removed' or 'changed': judge the directory afresh
    } else if (status.state !== 'idle') throw refuse(status.state);
    fs.mkdirSync(path.dirname(status.directory), { recursive: true });
    const owner = { pid, token: crypto.randomUUID(), startedAt: new Date().toISOString(), processStart: startOf(pid) };
    if (!publishLock(status.directory, JSON.stringify(owner))) continue; // judge the lock that won
    return { token: owner.token, ownerPid: pid, inherited: false, release() {
      const current = sharedLockStatus({ brainHome, alive, startOf });
      if (current.owner?.token !== owner.token || current.owner?.pid !== pid) throw Error('developer update lock ownership changed');
      // Move the whole lock aside in one step, then confirm it was this owner's: removing owner.json first left an empty
      // directory that a contender's publication rename could replace, and the follow-up removal deleted that live lock.
      const tomb = `${status.directory}.released-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      fs.renameSync(status.directory, tomb);
      if (!readRaw(path.join(tomb, 'owner.json'))?.includes(owner.token)) {
        try { if (!fs.existsSync(status.directory)) fs.renameSync(tomb, status.directory); } catch { /* keep it as evidence */ }
        throw Error('developer update lock ownership changed');
      }
      fs.rmSync(tomb, { recursive: true, force: true });
    } };
  }
  throw Error(`developer update lock is contended; ${path.join(brainRoot(brainHome), 'developer-update.lock')}. Retry shortly.`);
}
