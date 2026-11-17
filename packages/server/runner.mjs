// Runs engine calls in worker THREADS of this process, under a deadline. No program is started on
// the search path, so no Node path is remembered and none can go stale (architecture 2.2).
// Concurrency: a small pool of workers and one queue in front of it. A call waits in the queue until
// a worker is free; its deadline starts when a worker takes it, and the time it may wait is bounded
// too, so fifty calls at once all answer and memory stays at the pool's size.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export const POOL = 2;
export const MAX_QUEUE = 200;
const fault = (message, code) => Object.assign(new Error(message), { code });

export function createRunner(appDir, packDir, { size = POOL } = {}) {
  const workerUrl = pathToFileURL(path.join(appDir, 'server', 'worker.mjs'));
  const slots = new Set(); // { w, job }
  const queue = [];
  let seq = 0;
  let peak = 0;
  let retired = false;

  function start() {
    const w = new Worker(workerUrl, { workerData: { appDir, packDir } });
    const slot = { w, job: null };
    w.on('message', (m) => {
      const job = slot.job;
      if (!job || job.id !== m.id) return;
      slot.job = null;
      if (m.ok) job.resolve(m.result);
      else job.reject(fault(m.error, 'ENGINE'));
      pump();
    });
    w.on('error', (e) => drop(slot, fault(`the search worker failed: ${e.message}`, 'WORKER_DIED')));
    w.on('exit', (c) => drop(slot, fault(`the search worker stopped (exit ${c})`, 'WORKER_DIED')));
    slots.add(slot);
    peak = Math.max(peak, slots.size);
    return slot;
  }

  /** A worker that ended (died, timed out, replaced): its call fails with the reason, the slot goes. */
  function drop(slot, err) {
    if (!slots.delete(slot)) return;
    const job = slot.job;
    slot.job = null;
    job?.reject(err);
    slot.w.terminate();
    pump();
  }

  function dispatch(slot, job) {
    clearTimeout(job.waitTimer);
    const { deadlineMs } = job;
    const onDeadline = () => drop(slot, fault(`the search ran past its ${deadlineMs} ms deadline`, 'DEADLINE'));
    const timer = setTimeout(onDeadline, deadlineMs);
    const { resolve, reject } = job;
    job.resolve = (v) => (clearTimeout(timer), resolve(v));
    job.reject = (e) => (clearTimeout(timer), reject(e));
    slot.job = job;
    slot.w.postMessage({ ...job.msg, id: job.id });
  }

  /** Hands queued calls to free workers, starting workers up to the pool size. A `fresh` call (the
   *  probe) gets a newly started worker, so the index is opened again and damage on disk is seen. */
  function pump() {
    while (queue.length) {
      const job = queue[0];
      let slot = [...slots].find((s) => !s.job);
      if (job.fresh) {
        if (!slot && slots.size >= size) return;
        // Retire the idle worker without pumping again here (a nested pump would dispatch this same
        // call a second time, on a third worker: one leaked worker per probe).
        if (slot) (slots.delete(slot), slot.w.terminate());
        slot = start();
      } else if (!slot) {
        if (slots.size >= size) return;
        slot = start();
      }
      queue.shift();
      dispatch(slot, job);
    }
    if (retired && ![...slots].some((s) => s.job)) for (const s of [...slots]) drop(s, fault('the search worker was retired', 'REPLACED'));
  }

  function call(msg, deadlineMs, { fresh = false } = {}) {
    return new Promise((resolve, reject) => {
      if (retired) return reject(fault('the search workers were replaced by a newer version', 'REPLACED'));
      if (queue.length >= MAX_QUEUE) return reject(fault(`${queue.length} searches were already waiting`, 'BUSY'));
      const job = { id: ++seq, msg, deadlineMs, fresh, resolve, reject };
      // Waiting is bounded by the same deadline: a call that cannot start in time is answered in safe mode.
      job.waitTimer = setTimeout(() => {
        const i = queue.indexOf(job);
        if (i < 0) return;
        queue.splice(i, 1);
        reject(fault(`the search waited ${deadlineMs} ms for a free worker (${queue.length + 1} were waiting)`, 'BUSY'));
      }, deadlineMs);
      queue.push(job);
      pump();
    });
  }

  /** Ends every worker now; queued and running calls fail. */
  function terminate() {
    retired = true;
    for (const job of queue.splice(0)) (clearTimeout(job.waitTimer), job.reject(fault('the search worker was replaced', 'REPLACED')));
    for (const s of [...slots]) drop(s, fault('the search worker was replaced', 'REPLACED'));
  }

  /** Takes no new calls; the workers end once the calls already given to them have finished. */
  function retire() {
    retired = true;
    pump();
  }

  const stats = () => ({ workers: slots.size, running: [...slots].filter((s) => s.job).length, queued: queue.length, peakWorkers: peak });
  const busy = () => queue.length > 0 || [...slots].some((s) => s.job);

  return { call, terminate, retire, stats, busy };
}
