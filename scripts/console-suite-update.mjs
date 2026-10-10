// RNBC adapter: one shipped coordinator owns updates and the shared developer-update lock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { applyNightlyChoice, nightlyStatus, NIGHTLY_LABEL } from './nightly-controller.mjs';
import { readDeveloperUpdateConfig, readDeveloperUpdateReceipt,
  writeDeveloperUpdateConfig, sharedLockStatus, atomic } from '../plugin/scripts/developer-update.mjs';
const RUNNER = fileURLToPath(new URL('../plugin/scripts/developer-update.mjs', import.meta.url));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
export function coordinatorSourceIdentity(runner) {
  const directory = path.dirname(runner);
  return { sourceSha256: hash(runner), sourceSnapshot: Object.fromEntries([
    'developer-update.mjs', 'developer-update-policy.mjs', 'developer-update-lock.mjs',
    'developer-update-maintenance.mjs', 'developer-update-cleanup.mjs',
  ].map(name => [name, hash(name === 'developer-update.mjs' ? runner : path.join(directory, name))])) };
}
export function validUpdateChannel(channel) { return channel === 'latest' || channel === 'alpha'; }
export function createSuiteUpdater({ home = os.homedir(), brainHome = path.join(home, '.cache/ruvnet-brain'),
  runner = RUNNER, node = process.execPath, spawnChild = spawn, processAlive = alive,
  nightly = { status: nightlyStatus, enable: applyNightlyChoice }, markNightly = () => ({ ok: true }),
  policy = { readDeveloperUpdateConfig, readDeveloperUpdateReceipt, writeDeveloperUpdateConfig, sharedLockStatus, atomic } } = {}) {
  const options = { home, brainHome };
  const schedulerOptions = { identity: NIGHTLY_LABEL, brainHome, kbDir: path.join(brainHome, 'kb'), cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome } };
  const jobFile = path.join(brainHome, 'console-suite-update-job.json');
  let pending = null;
  const lock = () => policy.sharedLockStatus({ brainHome, alive: processAlive });
  function state() {
    let config = null, run = null, policyError = null;
    try { config = policy.readDeveloperUpdateConfig(options); run = policy.readDeveloperUpdateReceipt(options); }
    catch (error) { policyError = error.message; }
    if (run?.kind !== 'nightly-suite-update' || !Number.isFinite(Date.parse(run.startedAt))) run = null;
    const job = pending || read(jobFile), shared = lock();
    let schedule;
    try { schedule = nightly.status(schedulerOptions); } catch { schedule = { state: 'unknown' }; }
    const active = !!pending || shared.state === 'running' || (run?.state === 'running' && processAlive(run.pid));
    const newerJob = job && (!run || Date.parse(job.startedAt) > Date.parse(run.startedAt));
    const completedJob = job?.pid === run?.pid && job?.finishedAt && Date.parse(job.finishedAt) >= Date.parse(run?.finishedAt || 0);
    const source = newerJob || completedJob ? job : run;
    const activeReceipt = active && run?.state === 'running' && (pending
      ? run.pid === pending.pid && Date.parse(run.startedAt) >= Date.parse(pending.startedAt) - 1000
      : shared.owner?.pid === run.pid || (shared.owner?.token && shared.owner.token === run.ownerToken) || processAlive(run.pid));
    const visibleRun = active && !activeReceipt ? null : run;
    const view = active ? (activeReceipt ? run : pending || { startedAt: shared.owner?.startedAt, mode: 'apply' }) : source;
    const status = policyError ? 'unavailable' : active ? 'running' : source?.state === 'failed' ? 'failed'
      : source?.ok === true && source?.finishedAt && source?.mode === 'apply' ? 'succeeded'
        : source?.mode === 'check' && source?.finishedAt ? 'checked' : source ? 'interrupted' : 'never-run';
    return { channel: validUpdateChannel(config?.channel) ? config.channel : null, scope: config?.scope ?? null,
      nightly: schedule.state === 'on', nightlyState: schedule.state,
      available: !policyError && fs.existsSync(node) && fs.existsSync(runner), policyError,
      status, active, lockState: shared.state, startedAt: view?.startedAt ?? null, finishedAt: active ? null : view?.finishedAt ?? null,
      error: active ? null : view?.error ?? null, mode: view?.mode ?? null, sourceSha256: view?.sourceSha256 ?? null,
      steps: [
        ...(Array.isArray(visibleRun?.steps) ? visibleRun.steps : []).map(s => ({ name: String(s.name || 'Tool'), state: String(s.state || 'unknown') })),
        ...(Array.isArray(visibleRun?.plugins?.steps) ? visibleRun.plugins.steps : []).map(s => ({ name: `${String(s.id || 'Plugin')} (${String(s.scope || 'unknown')})`, state: String(s.state || 'unknown') })),
        ...(Array.isArray(visibleRun?.maintenance?.stages) ? visibleRun.maintenance.stages : []).map(s => ({
          name: path.isAbsolute(String(s.owner || '')) ? path.basename(s.owner) : String(s.owner || 'Provider'),
          state: run?.mode === 'check' ? 'checked' : 'completed' })),
        ...(visibleRun?.knowledge?.state ? [{ name: 'Brain knowledge', state: String(visibleRun.knowledge.state) }] : []),
      ],
      unverified: Array.isArray(visibleRun?.coverage?.unverified) ? visibleRun.coverage.unverified.map(String) : [],
      exclusions: (Array.isArray(visibleRun?.coverage?.excluded) ? visibleRun.coverage.excluded : []).map(s => ({ name: String(s.name || 'Tool'), reason: String(s.reason || 'preserved') })) };
  }
  function start(channel) {
    if (!validUpdateChannel(channel)) return { ok: false, error: 'Choose Latest or Alpha.', status: 400 };
    const shared = lock();
    if (pending || shared.state === 'running') return { ok: false, error: 'An update is already running. Follow its activity below.', status: 409 };
    if (shared.state !== 'idle') return { ok: false, error: 'Update ownership cannot be verified. No second updater was started.', status: 409 };
    if (!fs.existsSync(node) || !fs.existsSync(runner)) return { ok: false, error: 'The coordinated updater is unavailable.', status: 503 };
    try {
      // This explicit all-tools click authorizes existing installations only; optional providers
      // remain exclusions when absent. Cleanup and managed-callback preferences are preserved.
      const config = policy.readDeveloperUpdateConfig(options);
      policy.writeDeveloperUpdateConfig({ ...config, channel, scope: 'all', homebrew: true, uv: true, cargo: true, native: true }, options);
      const enrollment = nightly.enable(true, schedulerOptions);
      if (!enrollment.ok || enrollment.after?.state !== 'on') return { ok: false, error: enrollment.log || 'Nightly updates could not be enabled.', status: 503 };
      const mirrored = markNightly();
      if (!mirrored?.ok) return { ok: false, error: mirrored?.log || 'The nightly choice could not be saved.', status: 503 };
      if (lock().state !== 'idle') return { ok: false, error: 'Nightly updates are enabled; an update is already running.', status: 409 };
      pending = { kind: 'console-suite-update-job', startedAt: new Date().toISOString(), mode: 'apply', state: 'running', ok: false,
        ...coordinatorSourceIdentity(runner), adapterSha256: hash(new URL(import.meta.url)) };
      policy.atomic(jobFile, pending);
      const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome };
      delete env.RUVNET_DEVELOPER_UPDATE_TOKEN; // The runner acquires its own owner; RNBC holds none.
      const child = spawnChild(node, [runner, '--apply'], { cwd: home, env, stdio: 'ignore', detached: true, shell: false });
      pending.pid = child.pid; policy.atomic(jobFile, pending);
      const finish = error => {
        if (!pending) return;
        let receipt = null;
        try { receipt = policy.readDeveloperUpdateReceipt(options); } catch (failure) { error ||= failure.message; }
        const matched = receipt?.kind === 'nightly-suite-update' && receipt?.pid === child.pid && receipt?.mode === 'apply'
          && receipt?.sourceSha256 === pending.sourceSha256 && !!receipt?.finishedAt
          && Object.keys(receipt.sourceSnapshot || {}).length === Object.keys(pending.sourceSnapshot).length
          && Object.entries(pending.sourceSnapshot).every(([name, digest]) => receipt.sourceSnapshot?.[name] === digest)
          && ['completed', 'succeeded', 'failed'].includes(receipt?.state)
          && Date.parse(receipt.startedAt) >= Date.parse(pending.startedAt) - 1000;
        const ok = !error && matched && receipt.ok === true;
        policy.atomic(jobFile, { ...pending, finishedAt: new Date().toISOString(), state: ok ? 'succeeded' : 'failed', ok,
          error: error || (matched ? receipt.error ?? null : 'The updater stopped without a matching source-bound result receipt.') });
        pending = null;
      };
      child.once('error', error => finish(error.message));
      child.once('exit', code => finish(code === 0 ? null : `The updater exited with status ${code}.`));
      child.unref(); return { ok: true, started: true, state: state() };
    } catch (error) {
      if (pending) policy.atomic(jobFile, { ...pending, state: 'failed', error: error.message, finishedAt: new Date().toISOString() });
      pending = null; return { ok: false, error: error.message, status: 500 };
    }
  }
  return { state, start };
}
