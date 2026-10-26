import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
export const REFRESH_PHASE_CONTRACT = Object.freeze({
  schemaVersion: 1,
  update: Object.freeze([
  'source-enumeration',
  'ingestion',
  'local-overlay-restoration',
  'generation-ledger-reconciliation',
  'coverage-generation',
  'bundle-assembly',
  'update',
  ]),
  hostConvergence: 'host-convergence',
  cleanup: 'cleanup',
});
export const UPDATE_REFRESH_PHASES = REFRESH_PHASE_CONTRACT.update;
export const REQUIRED_REFRESH_PHASES = Object.freeze([
  ...UPDATE_REFRESH_PHASES,
  REFRESH_PHASE_CONTRACT.hostConvergence,
  REFRESH_PHASE_CONTRACT.cleanup,
]);

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

function observedProcessIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  if (!alive(pid)) return { state: 'dead' };
  try {
    if (platform === 'win32') {
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction Stop; `
        + `Write-Output ($p.StartTime.ToUniversalTime().ToString('o') + '|' + $p.Path)`], { encoding: 'utf8' });
      if (result.status !== 0) return { state: 'unknown' };
      const [processStart, ...rest] = String(result.stdout || '').trim().split('|');
      return processStart && rest.length ? { state: 'live', processStart, executable: rest.join('|') } : { state: 'unknown' };
    }
    const started = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
    });
    const command = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    const processStart = String(started.stdout || '').trim();
    const executable = String(command.stdout || '').trim();
    return started.status === 0 && command.status === 0 && processStart && executable
      ? { state: 'live', processStart, executable }
      : { state: 'unknown' };
  } catch { return { state: 'unknown' }; }
}

function sameExecutable(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return path.resolve(left || '') === path.resolve(right || ''); }
}

function observeOwnerProcess(owner, { inspectProcess, isAlive }) {
  return inspectProcess
    ? inspectProcess(owner.pid)
    : (isAlive && isAlive !== alive)
        ? (isAlive(owner.pid)
            ? { state: 'live', processStart: owner.processStart, executable: owner.executable }
            : { state: 'dead' })
        : observedProcessIdentity(owner.pid);
}

function ownerState(owner, { hostname, inspectProcess, isAlive }) {
  if (!owner || owner.host !== hostname || !owner.processStart || !owner.executable) return 'unknown';
  const observed = observeOwnerProcess(owner, { inspectProcess, isAlive });
  if (observed?.state !== 'live') return observed?.state === 'dead' ? 'dead' : 'unknown';
  return observed.processStart === owner.processStart && sameExecutable(observed.executable, owner.executable)
    ? 'live'
    : 'dead';
}

export function inspectRefreshOwner(owner, { hostname = os.hostname(), inspectProcess = null,
  isAlive = alive } = {}) {
  return ownerState(owner, { hostname, inspectProcess, isAlive });
}

// A lock nobody can prove alive must not wedge every later run (4.7.21, audit C). Liveness cannot be proven
// across hosts (and on macOS os.hostname() follows the network, so "another host" is often this Mac on
// another Wi-Fi: ownerVerdict checks the pid here first), but a refresh run cannot outlive the updater's own deadlines. An owner.json that cannot be
// read or lacks its identity is debris once no writer could still be publishing it.
export const REMOTE_OWNER_DEAD_MS = 3 * 3600_000;
export const INCOMPLETE_OWNER_RECLAIM_MS = 3600_000;
const ownerComplete = (owner) => owner?.schemaVersion === 3 && Boolean(owner.runId && owner.token && owner.host
  && Number.isSafeInteger(owner.pid) && owner.receiptPath && owner.brainHome);
const removalCommand = (lockPath) => (process.platform === 'win32'
  ? `Remove-Item -Recurse -Force "${lockPath}"` : `rm -rf "${lockPath}"`);
function newestMtimeMs(...files) {
  let newest = Number.NaN;
  for (const file of files) {
    try { const ms = fs.lstatSync(file).mtimeMs; if (!(newest >= ms)) newest = ms; } catch { /* absent */ }
  }
  return newest;
}

/**
 * 'dead' also for a remote owner past REMOTE_OWNER_DEAD_MS; every other answer is ownerState's.
 * 4.7.21 review (Opus updater #2, reproduced): on macOS the hostname follows the network, so an owner recorded
 * under "another host" is often THIS Mac, asleep mid-update on the old Wi-Fi. Its pid is inspected here first: the
 * same pid alive with the same process start and executable IS the owner, whatever the hostname says. Only an
 * absent or different local process may be aged out.
 */
function ownerVerdict(owner, { hostname, inspectProcess, isAlive, nowMs }) {
  const state = ownerState(owner, { hostname, inspectProcess, isAlive });
  if (state !== 'unknown' || !ownerComplete(owner) || owner.host === hostname) return { state, reason: 'exact-dead-owner' };
  if (owner.processStart && owner.executable) {
    const local = observeOwnerProcess(owner, { inspectProcess, isAlive });
    if (local?.state === 'live' && local.processStart === owner.processStart
      && sameExecutable(local.executable, owner.executable)) return { state: 'live', reason: 'same-process-other-hostname' };
  }
  const startedMs = Date.parse(owner.startedAt || '');
  return Number.isFinite(startedMs) && nowMs - startedMs > REMOTE_OWNER_DEAD_MS
    ? { state: 'dead', reason: 'stale-remote-owner' }
    : { state, reason: null };
}

// ── takeover is serialized (4.7.21 review, Codex #1) ─────────────────────────────────────────────
// Two contenders can judge the same abandoned lock. Without a claim, A reclaims and acquires, then B removes
// A's FRESH lock on its stale judgement and both run. A takeover now (1) creates an exclusive claim file
// inside the judged lock directory ('wx': one winner per directory instance), (2) re-checks, while holding
// the claim, that the directory is the same one (dev/ino) and owner.json is byte-identical to what was
// judged, and only then (3) moves it aside. A claim left by a crashed reclaimer is superseded by the next
// numbered claim once CLAIM_STALE_MS old, so a crash mid-takeover cannot wedge the lock either.
export const CLAIM_STALE_MS = 5 * 60_000;
const CLAIM_FILE = /^takeover(?:-(\d+))?\.json$/;
function dirIdentity(dir) {
  const stat = fs.lstatSync(dir, { bigint: true });
  if (!stat.isDirectory()) throw Object.assign(new Error(`${dir} is not a lock directory`), { code: 'ENOTDIR' });
  return `${stat.dev}:${stat.ino}`;
}
function readRaw(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
// A claim file must not restart the age an incomplete owner is judged by (Opus r2 #6): writing or removing one bumps
// the lock directory's mtime, which newestMtimeMs reads, so the directory's own times are put back.
function keepDirectoryTimes(dir, change) {
  let before = null;
  try { before = fs.lstatSync(dir); } catch { /* judged below */ }
  try { return change(); } finally { if (before) try { fs.lutimesSync(dir, before.atime, before.mtime); } catch { /* gone */ } }
}
const GONE = Symbol('judged lock vanished');
function claimTakeover(lockPath, hostname) {
  let highest = -1;
  let highestName = null;
  let names;
  // The judged lock vanished (another reclaimer moved it): re-judge rather than throw (Fable r2 P3-1).
  try { names = fs.readdirSync(lockPath); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return GONE; throw error; }
  for (const name of names) {
    const match = CLAIM_FILE.exec(name);
    if (!match) continue;
    const level = match[1] ? Number(match[1]) : 0;
    if (level > highest) { highest = level; highestName = name; }
  }
  if (highestName) {
    let ageMs = 0;
    try { ageMs = Date.now() - fs.lstatSync(path.join(lockPath, highestName)).mtimeMs; } catch { return null; }
    if (!(ageMs > CLAIM_STALE_MS)) return null; // another reclaimer is mid-takeover
  }
  const level = highest + 1;
  const file = path.join(lockPath, level ? `takeover-${level}.json` : 'takeover.json');
  const claim = { schemaVersion: 1, token: crypto.randomBytes(24).toString('hex'), host: hostname,
    pid: process.pid, claimedAt: new Date().toISOString(), file };
  let fd;
  try { fd = keepDirectoryTimes(lockPath, () => fs.openSync(file, 'wx', 0o600)); } catch (error) {
    if (error?.code === 'EEXIST') return null;
    if (error?.code === 'ENOENT') return GONE;
    throw error;
  }
  try { fs.writeFileSync(fd, `${JSON.stringify({ ...claim, file: undefined }, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return claim;
}
function dropClaim(claim) {
  try { if (readRaw(claim.file)?.includes(claim.token)) keepDirectoryTimes(path.dirname(claim.file), () => fs.unlinkSync(claim.file)); } catch { /* gone with its directory */ }
}
/**
 * Remove the lock directory at `lockPath` only if it is still exactly the one observed. Returns 'removed',
 * 'changed' (it is not the judged directory any more: re-judge it) or 'busy' (another reclaimer holds the claim).
 */
function removeObservedLock(lockPath, observed, { hostname, beforeRemove = null, afterClaim = null } = {}) {
  const claim = claimTakeover(lockPath, hostname);
  if (claim === GONE) return 'changed';
  if (!claim) return 'busy';
  afterClaim?.({ lockPath, claim });
  let same = false;
  try {
    same = dirIdentity(lockPath) === observed.identity
      && readRaw(path.join(lockPath, 'owner.json')) === observed.raw
      && Boolean(readRaw(claim.file)?.includes(claim.token));
  } catch { same = false; }
  if (!same) { dropClaim(claim); return 'changed'; }
  try { beforeRemove?.(claim); } catch (error) { dropClaim(claim); throw error; }
  const tomb = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try { fs.renameSync(lockPath, tomb); } catch (error) {
    if (error?.code === 'ENOENT') return 'changed';
    dropClaim(claim);
    throw error;
  }
  // Only the claim holder can move the judged directory, so the moved directory must carry this claim.
  if (!readRaw(path.join(tomb, path.basename(claim.file)))?.includes(claim.token)) {
    try { if (!fs.existsSync(lockPath)) fs.renameSync(tomb, lockPath); } catch { /* keep it as evidence */ }
    throw new Error(`refresh lock takeover moved a directory it did not claim (${lockPath}); refusing`);
  }
  fs.rmSync(tomb, { recursive: true, force: true });
  return 'removed';
}

/**
 * The ONE physical-path rule for brain directories. A user may reach the brain through a symlink
 * (`~/.cache -> /Volumes/<disk>`) while the updater knows it by its real path (Node resolves
 * import.meta.url), so identity checks compare this, never spellings. A directory that does not
 * exist right now (kb/ mid-rename) resolves through its parent, so the answer does not flip.
 */
export function physicalPath(dir) {
  const resolved = path.resolve(String(dir || ''));
  try { return fs.realpathSync.native(resolved); } catch { /* absent: resolve through the parent */ }
  try { return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)); }
  catch { return resolved; }
}

export const refreshLockPath = (kbDir) =>
  path.join(path.dirname(path.resolve(kbDir)), `.${path.basename(path.resolve(kbDir))}.refresh-run.lock`);

export function refreshReceiptPath(brainHome, runId) {
  if (!SAFE_ID.test(String(runId || ''))) throw new Error('refresh run has no safe runId');
  const root = path.resolve(brainHome || '');
  const file = path.resolve(root, 'refresh-runs', `${runId}.json`);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('refresh receipt path escapes brain home');
  return file;
}

/** Records the dead owner's run ABANDONED. Runs only while this process holds the takeover claim on its lock. */
function abandonDeadOwner({ lockPath, owner, hostname, inspectProcess, isAlive, now, claim }) {
  const observed = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  const verdict = ownerVerdict(observed, { hostname, inspectProcess, isAlive, nowMs: Date.parse(now()) });
  if (observed.schemaVersion !== 3 || observed.runId !== owner.runId || observed.token !== owner.token
    || verdict.state !== 'dead') {
    throw new Error('refresh owner changed or is no longer exactly dead during takeover');
  }
  const expectedReceipt = refreshReceiptPath(observed.brainHome, observed.runId);
  if (path.resolve(observed.receiptPath || '') !== expectedReceipt) throw new Error('dead refresh owner receipt path is invalid');
  fs.mkdirSync(path.dirname(expectedReceipt), { recursive: true });
  let receipt;
  if (fs.existsSync(expectedReceipt)) {
    const stat = fs.lstatSync(expectedReceipt);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('dead refresh owner receipt is not a regular file');
    receipt = JSON.parse(fs.readFileSync(expectedReceipt, 'utf8'));
    if (receipt.runId !== observed.runId || receipt.ownerToken?.token !== observed.token) {
      throw new Error('dead refresh owner receipt identity differs');
    }
  } else {
    receipt = { schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', runId: observed.runId,
      ...observed.receiptSeed, ownerToken: { token: observed.token, host: observed.host, pid: observed.pid,
        executable: observed.executable, processStart: observed.processStart, startedAt: observed.startedAt },
      startedAt: observed.startedAt, status: 'RUNNING', terminalVerdict: null,
      requiredPhaseOrder: [...REQUIRED_REFRESH_PHASES], phases: [], advisories: [] };
  }
  if (['RUNNING', 'SETTLING'].includes(receipt.status)) {
    receipt.status = 'ABANDONED';
    receipt.terminalVerdict = 'abandoned';
    receipt.finishedAt = now();
    receipt.detail = { reason: verdict.reason, abandonedOwner: { host: observed.host, pid: observed.pid,
      processStart: observed.processStart, executable: observed.executable }, takeoverToken: claim.token };
    delete receipt.intendedStatus;
    delete receipt.intendedTerminalVerdict;
    atomicJson(expectedReceipt, receipt);
  } else if (!['SUCCEEDED', 'FAILED', 'ABANDONED'].includes(receipt.status)) {
    throw new Error('dead refresh owner receipt has an unsupported state');
  }
  return claim;
}

export function acquireRefreshLock({
  kbDir,
  brainHome = path.dirname(path.resolve(kbDir || '')),
  action = 'update',
  desiredVersion = null,
  schedulerIdentity = null,
  executableIdentity = null,
  env = process.env,
  pid = process.pid,
  isAlive = alive,
  now = () => new Date().toISOString(),
  hostname = os.hostname(),
  executable = process.execPath,
  processStart = null,
  inspectProcess = null,
  afterStage = null,
  afterTakeoverClaim = null,
} = {}) {
  const root = path.resolve(kbDir || '');
  const lockPath = refreshLockPath(root);
  const inherited = String(env.RUVNET_REFRESH_RUN_TOKEN || '');
  if (inherited) {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    // Same DIRECTORY, not same spelling: the installer locks RUVNET_BRAIN_KB as given (possibly through
    // a symlinked ~/.cache), the child updater knows its KB by import.meta.url, which Node resolves to
    // the real path. Compare physical identity; a genuinely different directory still refuses.
    if (owner.schemaVersion !== 3 || owner.token !== inherited || physicalPath(owner.kbDir) !== physicalPath(root)
      || path.resolve(owner.receiptPath || '') !== refreshReceiptPath(owner.brainHome, owner.runId)) {
      throw new Error(`refresh lock inheritance does not match ${lockPath}`);
    }
    return { path: lockPath, token: inherited, runId: owner.runId, owned: false, owner };
  }
  const current = processStart
    ? { state: 'live', processStart, executable }
    : (isAlive !== alive ? { state: 'live', processStart: `injected:${pid}`, executable } : observedProcessIdentity(pid));
  if (current.state !== 'live' || !current.processStart || !current.executable) {
    throw new Error(`cannot establish exact process identity for refresh owner pid ${pid}`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const staged = `${lockPath}.acquire-${pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
      const token = crypto.randomBytes(24).toString('hex');
      const runId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
      const startedAt = now();
      const owner = { schemaVersion: 3, runId, pid, token, kbDir: root, brainHome: path.resolve(brainHome),
        receiptPath: refreshReceiptPath(brainHome, runId), host: hostname,
        executable: current.executable, processStart: current.processStart, startedAt,
        receiptSeed: { action, desiredVersion, schedulerIdentity, executableIdentity } };
      fs.mkdirSync(staged, { mode: 0o700 });
      fs.writeFileSync(path.join(staged, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      afterStage?.({ staged, lockPath, runId, token });
      fs.renameSync(staged, lockPath);
      return { path: lockPath, token, runId, owned: true, owner };
    } catch (error) {
      fs.rmSync(staged, { recursive: true, force: true });
      // Windows refuses rename-over-existing with EPERM/EACCES rather than EEXIST. Treat those
      // codes as contention, then inspect the owner through the same liveness fence.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      // Judge one exact directory: its identity and owner.json bytes are what the takeover re-checks later.
      let observed;
      try { observed = { identity: dirIdentity(lockPath), raw: readRaw(path.join(lockPath, 'owner.json')) }; }
      catch (observeError) { if (['ENOENT', 'ENOTDIR'].includes(observeError?.code)) continue; throw observeError; }
      let owner = null;
      try { owner = JSON.parse(observed.raw); } catch { /* judged below */ }
      const nowMs = Date.parse(now());
      let beforeRemove = null;
      if (!ownerComplete(owner)) {
        const ageMs = nowMs - newestMtimeMs(lockPath, path.join(lockPath, 'owner.json'));
        if (!(ageMs > INCOMPLETE_OWNER_RECLAIM_MS)) {
          throw new Error(`refresh lock owner is incomplete or unreadable; refusing takeover until it is 1 h old `
            + `(lock ${lockPath}). If no update is running, remove it:  ${removalCommand(lockPath)}`);
        }
      } else {
        const verdict = ownerVerdict(owner, { hostname, inspectProcess, isAlive, nowMs });
        if (verdict.state !== 'dead') {
          throw new Error(`${verdict.state === 'live' ? 'another refresh run is active' : 'refresh lock owner is ambiguous'} `
            + `(pid ${owner.pid || '?'} on ${owner.host || '?'}, started ${owner.startedAt || '?'}, lock ${lockPath}). `
            + `If no update is running${owner.host && owner.host !== hostname ? ` on ${owner.host}` : ''}, remove it:  ${removalCommand(lockPath)}`);
        }
        beforeRemove = (claim) => abandonDeadOwner({ lockPath, owner, hostname, inspectProcess, isAlive, now, claim });
      }
      const outcome = removeObservedLock(lockPath, observed, { hostname, beforeRemove, afterClaim: afterTakeoverClaim });
      if (outcome === 'busy') {
        throw new Error(`another process is taking over the refresh lock ${lockPath}; refusing to race it (retry shortly)`);
      }
      // 'removed' or 'changed': acquire again; a changed lock is judged afresh.
    }
  }
  throw new Error(`could not acquire refresh lock ${lockPath}`);
}

export function releaseRefreshLock(lock) {
  if (!lock?.owned) return false;
  const quarantined = `${lock.path}.release-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.renameSync(lock.path, quarantined);
    const owner = JSON.parse(fs.readFileSync(path.join(quarantined, 'owner.json'), 'utf8'));
    if (owner.token !== lock.token || owner.runId !== lock.runId) {
      if (!fs.existsSync(lock.path)) fs.renameSync(quarantined, lock.path);
      return false;
    }
    lock.afterQuarantine?.({ quarantined, lockPath: lock.path });
    fs.rmSync(quarantined, { recursive: true, force: true });
    return true;
  } catch {
    if (fs.existsSync(quarantined) && !fs.existsSync(lock.path)) {
      try { fs.renameSync(quarantined, lock.path); } catch { /* retain quarantined evidence */ }
    }
    return false;
  }
}

export function assertRefreshLockOwner(lock) {
  if (!lock?.path || !lock?.token || !lock?.runId) throw new Error('refresh lock identity is incomplete');
  const owner = JSON.parse(fs.readFileSync(path.join(lock.path, 'owner.json'), 'utf8'));
  if (owner.token !== lock.token || owner.runId !== lock.runId) {
    throw new Error('refresh lock owner changed during settlement');
  }
  return owner;
}

function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } catch (error) {
    // #434: a failed write/rename must not leave a temp behind to block lifecycle retention.
    try { fs.rmSync(temporary, { force: true }); } catch { /* the original error is the one to report */ }
    throw error;
  }
}

export function openRefreshReceipt({ brainHome, lock, action, desiredVersion = null,
  schedulerIdentity = null, executableIdentity = null, now = () => new Date().toISOString() }) {
  if (!lock?.runId || !SAFE_ID.test(lock.runId)) throw new Error('refresh run has no safe runId');
  const owner = assertRefreshLockOwner(lock);
  const file = refreshReceiptPath(brainHome, lock.runId);
  if (owner.schemaVersion !== 3 || path.resolve(owner.receiptPath || '') !== file
    || path.resolve(owner.brainHome || '') !== path.resolve(brainHome)) throw new Error('refresh owner receipt identity differs');
  const receipt = { schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', runId: lock.runId,
    action, desiredVersion, schedulerIdentity, executableIdentity,
    ownerToken: { token: lock.token, ...(lock.owner || {}) },
    startedAt: now(), status: 'RUNNING', terminalVerdict: null,
    requiredPhaseOrder: [...REQUIRED_REFRESH_PHASES], phases: [], advisories: [] };
  atomicJson(file, receipt);
  return { file, runId: lock.runId };
}

// Consumer convergence permits validated upstream artifacts. The stronger native
// nine-phase proof must establish that every operation belongs to this run.
export function validateCurrentRunPhaseExecution(receipt) {
  const failures = [];
  const phases = Array.isArray(receipt?.phases) ? receipt.phases : [];
  const start = Date.parse(receipt?.startedAt || '');
  const end = Date.parse(receipt?.finishedAt || '');
  if (!receipt?.runId || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    failures.push('current-run execution identity or time window is missing');
  }
  if (JSON.stringify(phases.map((phase) => phase?.phase)) !== JSON.stringify(REQUIRED_REFRESH_PHASES)) {
    failures.push('current-run execution phase ledger is incomplete or out of order');
  }
  for (const phase of phases) {
    const execution = phase?.evidence?.execution;
    const at = Date.parse(phase?.at || '');
    if (phase?.status !== 'PASS' || execution?.kind !== 'executed'
      || execution.runId !== receipt.runId || !Number.isFinite(at) || at < start || at > end) {
      failures.push(`${phase?.phase || 'unknown phase'} does not establish current-run execution`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function recordRefreshPhase(handle, phase, status, detail = null, now = () => new Date().toISOString()) {
  if (!handle?.file || !SAFE_ID.test(String(phase)) || !['PASS', 'FAIL', 'SKIP'].includes(status)) {
    throw new Error('invalid refresh phase receipt update');
  }
  const receipt = JSON.parse(fs.readFileSync(handle.file, 'utf8'));
  if (receipt.runId !== handle.runId || receipt.status !== 'RUNNING') throw new Error('refresh receipt is not active');
  const expected = REQUIRED_REFRESH_PHASES[receipt.phases.length];
  if (phase !== expected) throw new Error(`refresh phase ${phase} is out of order; expected ${expected || '(none)'}`);
  const required = detail?.required !== false;
  const evidence = detail && Object.hasOwn(detail, 'required') ? { ...detail } : detail;
  if (evidence && Object.hasOwn(evidence, 'required')) delete evidence.required;
  receipt.phases.push({ phase, required, status, at: now(), evidence });
  atomicJson(handle.file, receipt);
  return receipt;
}

export function recordRefreshAdvisory(handle, advisory, status, detail = null, now = () => new Date().toISOString()) {
  if (!handle?.file || !SAFE_ID.test(String(advisory)) || !['PASS', 'FAIL', 'SKIP'].includes(status)) {
    throw new Error('invalid refresh advisory receipt update');
  }
  const receipt = JSON.parse(fs.readFileSync(handle.file, 'utf8'));
  if (receipt.runId !== handle.runId || receipt.status !== 'RUNNING') throw new Error('refresh receipt is not active');
  if (receipt.advisories.some((entry) => entry.advisory === advisory)) throw new Error(`refresh advisory is duplicated: ${advisory}`);
  receipt.advisories.push({ advisory, status, at: now(), evidence: detail });
  atomicJson(handle.file, receipt);
  return receipt;
}

export function beginRefreshSettlement(handle, lock, status, detail = null, now = () => new Date().toISOString()) {
  if (!['SUCCEEDED', 'FAILED', 'ABANDONED'].includes(status)) throw new Error('invalid terminal refresh status');
  assertRefreshLockOwner(lock);
  const receipt = JSON.parse(fs.readFileSync(handle.file, 'utf8'));
  if (receipt.runId !== handle.runId || receipt.status !== 'RUNNING') throw new Error('refresh receipt is not active');
  const requiredFailure = receipt.phases.find((phase) => phase.required !== false && phase.status !== 'PASS');
  const exactOrder = receipt.phases.map(({ phase }) => phase);
  if (status === 'SUCCEEDED' && requiredFailure) {
    throw new Error(`required refresh phase ${requiredFailure.phase} is ${requiredFailure.status}; refusing success`);
  }
  if (status === 'SUCCEEDED' && JSON.stringify(exactOrder) !== JSON.stringify(REQUIRED_REFRESH_PHASES)) {
    throw new Error('required refresh phase ledger is incomplete or out of order; refusing success');
  }
  receipt.status = 'SETTLING';
  receipt.settlingAt = now();
  receipt.intendedStatus = status;
  receipt.intendedTerminalVerdict = status === 'SUCCEEDED'
    ? (detail?.terminalVerdict === 'noop' ? 'noop' : 'applied')
    : status === 'ABANDONED' ? 'abandoned'
      : (['cleanup-pending', 'recovery-required'].includes(detail?.terminalVerdict)
          ? detail.terminalVerdict : 'failed');
  receipt.detail = detail;
  atomicJson(handle.file, receipt);
  return receipt;
}

export function finishRefreshReceipt(handle, lock, now = () => new Date().toISOString()) {
  assertRefreshLockOwner(lock);
  const receipt = JSON.parse(fs.readFileSync(handle.file, 'utf8'));
  if (receipt.runId !== handle.runId || receipt.status !== 'SETTLING'
    || !['SUCCEEDED', 'FAILED', 'ABANDONED'].includes(receipt.intendedStatus)) {
    throw new Error('refresh receipt is not settling');
  }
  receipt.status = receipt.intendedStatus;
  receipt.terminalVerdict = receipt.intendedTerminalVerdict;
  receipt.finishedAt = now();
  delete receipt.intendedStatus;
  delete receipt.intendedTerminalVerdict;
  atomicJson(handle.file, receipt);
  return receipt;
}

export function settleRefreshRun({ handle, lock, status, detail = null, now = () => new Date().toISOString() }) {
  beginRefreshSettlement(handle, lock, status, detail, now);
  const receipt = finishRefreshReceipt(handle, lock, now);
  const lockReleased = releaseRefreshLock(lock);
  if (!lockReleased) throw new Error('refresh terminal receipt committed but lock release could not be verified');
  return { receipt, lockReleased };
}
