// One finite owner attempts bounded group cleanup; unexpected retirement retains the queue fence.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownsQueueLock, releaseQueueLock, writeExclusive, writeAtomic, readSafe } from './learning-queue.mjs';
import { learningContext } from './runtime-preferences.mjs';

const aliveGroup = pid => {
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const killTree = pid => {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 1000, windowsHide: true, stdio: 'ignore' });
    return !r.error && r.status === 0;
  }
  try { process.kill(-pid, 'SIGKILL'); return true; } catch (error) { return error.code === 'ESRCH'; }
};

export async function superviseLearning(context, token, deadline, { report = false, spawnEngine = spawn,
  killOwned = killTree, groupAlive = aliveGroup, platform = process.platform, env = process.env,
  persistFence = writeAtomic, writeDiagnostic = writeExclusive } = {}) {
  // A supervisor crash or later read-only filesystem must never permit expired-lease takeover.
  // Persist and verify the retirement requirement before any worker can exist.
  const lockFile = path.join(context.queueDir, '.worker-lock');
  try {
    if (!ownsQueueLock(context, token)) throw new Error('queue ownership lost');
    const lock = JSON.parse(readSafe(lockFile));
    persistFence(lockFile, JSON.stringify({ ...lock, retirementRequired: true }));
    const verified = JSON.parse(readSafe(lockFile));
    if (verified.token !== token || verified.retirementRequired !== true) throw new Error('retirement requirement unverified');
  } catch {
    return { retirementConfirmed: true, fencePersisted: false, launched: false };
  }
  const child = spawnEngine(process.execPath, [fileURLToPath(new URL('./learn-flush.mjs', import.meta.url)), '--worker', ...(report ? ['--report'] : [])], {
    cwd: context.projectDir, detached: true, stdio: ['ignore', report ? 'inherit' : 'ignore', report ? 'inherit' : 'ignore', 'ipc'], windowsHide: true,
    env: { ...env, RUVNET_LEARN_WORKER_TOKEN: token, RUVNET_LEARN_WORKER_EXPIRES: String(deadline), RUFLO_DAEMON_AUTOSTART: '0' },
  });
  return await new Promise(resolve => {
    let retiring = false; let exited = false; let completionReported = false;
    const timer = setTimeout(() => void retire(true), Math.max(1, deadline - Date.now()));
    const retire = async failed => {
      if (retiring) return; retiring = true; clearTimeout(timer);
      let killed = false;
      try { killed = !child.pid || killOwned(child.pid); } catch { /* bounded refusal below */ }
      const until = Date.now() + 600; let confirmed = !child.pid;
      while (!confirmed && Date.now() < until) {
        try { confirmed = platform === 'win32' ? killed && exited : !groupAlive(child.pid); } catch { confirmed = false; }
        if (!confirmed) await new Promise(r => setTimeout(r, 25));
      }
      const groupRetired = confirmed;
      // Group absence after an unexpected root exit is not escaped-descendant proof.
      confirmed = confirmed && (!child.pid || (!failed && completionReported));
      const retirementScope = platform === 'win32' ? 'windows-taskkill-tree-attempt' : 'owned-process-group';
      const retirementState = confirmed ? 'GROUP_ONLY' : 'UNKNOWN';
      // Mandatory fencing is independent of optional diagnostics (including ENOSPC).
      let fencePersisted = confirmed;
      if (!confirmed) {
        try {
          if (ownsQueueLock(context, token)) {
            const lock = JSON.parse(readSafe(lockFile));
            persistFence(lockFile, JSON.stringify({ ...lock, retirementUnconfirmed: true }));
            fencePersisted = JSON.parse(readSafe(lockFile)).retirementUnconfirmed === true;
          }
        } catch { /* Report failed durability without claiming the queue is fenced. */ }
      }
      try {
        const current = learningContext({ env, cwd: context.projectDir });
        if (current.enabled && current.queueDir === context.queueDir) {
          if (failed || !confirmed) writeDiagnostic(path.join(context.queueDir, `.run-${Date.now()}-${process.pid}.json`), JSON.stringify({
            schemaVersion: 1, failed: 1, fed: 0, acknowledged: 0, workerPid: child.pid, retirementRequired: true, retirementConfirmed: confirmed, fencePersisted, groupRetired, retirementScope, retirementState, treeVerified: false,
            reason: confirmed ? 'owned process group cleanup confirmed; full tree proof unavailable; originals retained' : fencePersisted
              ? 'deadline or crash; owned tree retirement unconfirmed; queue fenced; originals retained'
              : 'deadline or crash; owned tree retirement unconfirmed; fence persistence failed; manual recovery required; originals retained',
          }));
        }
      } catch { /* Diagnostic failure never consumes original evidence. */ }
      if (confirmed) releaseQueueLock(context, token);
      if (child.connected) child.disconnect(); child.unref?.(); resolve({ retirementRequired: true, retirementConfirmed: confirmed, fencePersisted, groupRetired, retirementScope, retirementState, treeVerified: false });
    };
    child.once('message', message => {
      if (message?.type !== 'learning-worker-complete' || retiring) return;
      if (Date.now() >= deadline) { void retire(true); return; }
      completionReported = true; void retire(false);
    });
    child.once('error', () => void retire(true));
    child.once('exit', () => { exited = true; if (!retiring) void retire(true); });
  });
}
