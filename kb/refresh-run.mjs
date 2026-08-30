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

function ownerState(owner, { hostname, inspectProcess, isAlive }) {
  if (!owner || owner.host !== hostname || !owner.processStart || !owner.executable) return 'unknown';
  const observed = inspectProcess
    ? inspectProcess(owner.pid)
    : (isAlive && isAlive !== alive)
        ? (isAlive(owner.pid)
            ? { state: 'live', processStart: owner.processStart, executable: owner.executable }
            : { state: 'dead' })
        : observedProcessIdentity(owner.pid);
  if (observed?.state !== 'live') return observed?.state === 'dead' ? 'dead' : 'unknown';
  return observed.processStart === owner.processStart && sameExecutable(observed.executable, owner.executable)
    ? 'live'
    : 'dead';
}

export function inspectRefreshOwner(owner, { hostname = os.hostname(), inspectProcess = null,
  isAlive = alive } = {}) {
  return ownerState(owner, { hostname, inspectProcess, isAlive });
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

function abandonDeadOwner({ lockPath, owner, hostname, inspectProcess, isAlive, now }) {
  const claimFile = path.join(lockPath, 'takeover.json');
  const claim = { schemaVersion: 1, token: crypto.randomBytes(24).toString('hex'), host: hostname,
    pid: process.pid, claimedAt: now() };
  const fd = fs.openSync(claimFile, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(claim, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const observed = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  if (observed.schemaVersion !== 3 || observed.runId !== owner.runId || observed.token !== owner.token
    || ownerState(observed, { hostname, inspectProcess, isAlive }) !== 'dead') {
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
    receipt.detail = { reason: 'exact-dead-owner', abandonedOwner: { host: observed.host, pid: observed.pid,
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
} = {}) {
  const root = path.resolve(kbDir || '');
  const lockPath = refreshLockPath(root);
  const inherited = String(env.RUVNET_REFRESH_RUN_TOKEN || '');
  if (inherited) {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    if (owner.schemaVersion !== 3 || owner.token !== inherited || path.resolve(owner.kbDir) !== root
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
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')); } catch {
        throw new Error(`refresh lock owner is incomplete or unreadable; refusing stale takeover (${lockPath})`);
      }
      const state = ownerState(owner, { hostname, inspectProcess, isAlive });
      if (state !== 'dead') {
        throw new Error(`${state === 'live' ? 'another refresh run is active' : 'refresh lock owner is ambiguous'} `
          + `(pid ${owner.pid || '?'}, lock ${lockPath})`);
      }
      abandonDeadOwner({ lockPath, owner, hostname, inspectProcess, isAlive, now });
      const stale = `${lockPath}.stale-${pid}-${Date.now()}`;
      try {
        fs.renameSync(lockPath, stale);
        fs.rmSync(stale, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError?.code !== 'ENOENT') throw renameError;
      }
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
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
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
