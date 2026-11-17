// The updater's one entry point, called by the running server's timer (never during a search). The
// auto-update off-switch is read here and only here. It fetches the signed manifest's address from
// config, records whether a newer release exists, and when one does, applies it with the same
// install transaction as `ruvnet-brain update`, in a worker thread so searches and heartbeats go on.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { paths, readConfig, readJson, readPointer, writeJsonAtomic } from '../contract/home.mjs';

let running = null;

function applyInWorker(home, from) {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./update-worker.mjs', import.meta.url), { workerData: { home, from } });
    let answer = null;
    w.on('message', (m) => (answer = m));
    w.on('error', (e) => (answer = { ok: false, message: e.message }));
    w.on('exit', () => resolve(answer ?? { ok: false, message: 'the update worker stopped without an answer' }));
  });
}

export async function checkForUpdate({ home, fetchImpl = globalThis.fetch, apply = true }) {
  const cfg = readConfig(home);
  if (cfg.autoUpdate === false) return { checked: false, reason: 'auto-update is off' };
  if (!cfg.updateUrl) return { checked: false, reason: 'no update source is configured' };
  if (running) return { checked: false, reason: 'an update is already being applied' };
  const res = await fetchImpl(new URL('release.json', cfg.updateUrl), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`update check failed: HTTP ${res.status}`);
  const offered = await res.json();
  const installed = readPointer(home)?.releaseNumber ?? 0;
  // An install or update that was killed part-way (its journal is still there) is applied again:
  // the transaction undoes or finishes it first, then checks the release through the real server.
  const interrupted = fs.existsSync(path.join(home, 'state', 'journal.json'));
  const result = { checked: true, at: Date.now(), offered: offered?.releaseNumber ?? null, installed, available: Number(offered?.releaseNumber) > installed, interrupted };
  // The last applied update stays on record until another one is applied.
  const last = readJson(paths(home).updateCheck, null)?.applied;
  writeJsonAtomic(paths(home).updateCheck, last ? { ...result, applied: last } : result);
  if (!(result.available || interrupted) || !apply) return result;
  running = applyInWorker(home, cfg.updateUrl);
  try {
    const applied = { ...(await running), at: Date.now() };
    writeJsonAtomic(paths(home).updateCheck, { ...result, applied });
    return { ...result, applied };
  } finally {
    running = null;
  }
}
