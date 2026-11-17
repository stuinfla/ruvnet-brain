// Runs engine calls in a worker THREAD of this process, under a deadline. No program is started on
// the search path, so no Node path is remembered and none can go stale (architecture 2.2).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const fault = (message, code) => Object.assign(new Error(message), { code });

export function createRunner(appDir, packDir) {
  const workerUrl = pathToFileURL(path.join(appDir, 'server', 'worker.mjs'));
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function fail(w, err) {
    if (worker === w) worker = null;
    for (const [id, p] of pending) {
      if (p.w === w) {
        pending.delete(id);
        p.reject(err);
      }
    }
  }

  function start() {
    const w = new Worker(workerUrl, { workerData: { appDir, packDir } });
    w.on('message', (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(fault(m.error, 'ENGINE'));
    });
    w.on('error', (e) => fail(w, fault(`the search worker failed: ${e.message}`, 'WORKER_DIED')));
    w.on('exit', (c) => fail(w, fault(`the search worker stopped (exit ${c})`, 'WORKER_DIED')));
    return w;
  }

  function call(msg, deadlineMs) {
    if (!worker) worker = start();
    const w = worker;
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const onDeadline = () => {
        pending.delete(id);
        if (worker === w) worker = null;
        w.terminate();
        reject(fault(`the search ran past its ${deadlineMs} ms deadline`, 'DEADLINE'));
      };
      const timer = setTimeout(onDeadline, deadlineMs);
      pending.set(id, {
        w,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      w.postMessage({ ...msg, id });
    });
  }

  function terminate() {
    const w = worker;
    worker = null;
    if (!w) return;
    fail(w, fault('the search worker was replaced', 'REPLACED'));
    w.terminate();
  }

  return { call, terminate };
}
