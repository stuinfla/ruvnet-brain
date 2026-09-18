import { fork } from 'node:child_process';
import { killProcessTree, trackProcessTree } from '../native-host-process.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'search-worker.mjs');
const DEFAULT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 30_000;
const PRIVATE_ENV = /(?:API_KEY|TOKEN|SECRET|PRIVATE_KEY|SIGNING_KEY|PASSWORD|CREDENTIAL)/i;
function cleanEnv() {
  const env = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'RVF_MODULE_PATH', 'XENOVA_PATH']) delete env[key];
  for (const key of Object.keys(env)) if (PRIVATE_ENV.test(key)) delete env[key];
  return env;
}

export function createSearchProcess({ entryFile, warmup = false, readyTimeoutMs = READY_TIMEOUT_MS,
  cleanupTimeoutMs = 2000, terminateTree = killProcessTree } = {}) {
  if (typeof entryFile !== 'string' || !path.isAbsolute(entryFile)) throw new Error('search process entryFile must be absolute');
  if (![readyTimeoutMs, cleanupTimeoutMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('search process deadlines must be positive');
  let current = null;
  let closed = false;
  let requestActive = false;
  let sequence = 0;

  function settle(record, reason) {
    clearTimeout(record.readyTimer);
    record.rejectReady?.(new Error(reason));
    record.rejectReady = null;
    if (record.pending) {
      clearTimeout(record.pending.timer);
      record.pending.reject(new Error(reason));
      record.pending = null;
    }
  }

  function stop(record, reason) {
    if (!record) return Promise.resolve(null);
    if (record.stopping) return record.stopping;
    record.reason = reason;
    record.expired = true;
    clearTimeout(record.readyTimer);
    record.stopping = (async () => {
      let failure = null;
      try { terminateTree(record.child); } catch (error) { failure = error; }
      if (!record.exited) {
        let timer;
        await Promise.race([record.joined, new Promise(resolve => { timer = setTimeout(resolve, cleanupTimeoutMs); })]);
        clearTimeout(timer);
      }
      if (!record.exited) {
        closed = true; // Never spawn another worker while this one's death is unproven.
        failure ??= new Error(`worker did not exit within ${cleanupTimeoutMs}ms`);
      }
      const message = failure ? `${reason}; cleanup failed: ${failure.message}` : reason;
      settle(record, message);
      if (record.exited && current === record) current = null;
      return failure;
    })();
    return record.stopping;
  }

  function start() {
    if (closed) return Promise.reject(new Error('search process is closed'));
    if (current) return current.ready;
    const child = fork(WORKER, [entryFile, ...(warmup ? ['warmup'] : [])], {
      detached: process.platform !== 'win32', env: cleanEnv(), execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const release = trackProcessTree(child);
    const record = {child, expired: false, exited: false, pending: null, stopping: null};
    current = record;
    record.joined = new Promise(resolve => { record.join = resolve; });
    record.ready = new Promise((resolve, reject) => { record.resolveReady = resolve; record.rejectReady = reject; });
    record.readyTimer = setTimeout(() => { void stop(record, 'search process readiness timeout'); }, readyTimeoutMs);
    child.on('message', message => {
      if (record.expired || record.stopping || closed || current !== record) return;
      if (message?.type === 'ready') {
        clearTimeout(record.readyTimer);
        record.rejectReady = null;
        record.resolveReady();
      } else if (message?.type === 'init-error') {
        void stop(record, message.error || 'search worker initialization failed');
      } else if (record.pending && message?.id === record.pending.id) {
        const pending = record.pending;
        record.pending = null;
        clearTimeout(pending.timer);
        if (message.type === 'result') pending.resolve(message.result);
        else pending.reject(new Error(message.error || 'search worker failed'));
      }
    });
    child.once('error', error => { void stop(record, error.message); });
    child.once('close', () => {
      record.exited = true;
      record.join();
      release();
      settle(record, record.reason || 'search process exited unexpectedly');
      if (current === record) current = null;
    });
    return record.ready;
  }

  async function searchAll(request = {}) {
    if (requestActive || current?.stopping) throw new Error('search process does not support concurrent requests');
    requestActive = true;
    try {
      await start();
      const record = current;
      if (!record?.child.connected || closed || record.stopping) throw new Error('search process is unavailable');
      const id = ++sequence;
      const timeoutMs = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_TIMEOUT_MS;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { void stop(record, `search query timed out after ${timeoutMs}ms`); }, timeoutMs);
        record.pending = {id, resolve, reject, timer};
        try {
          record.child.send({type: 'search', id, request}, error => { if (error) void stop(record, error.message); });
        } catch (error) { void stop(record, error.message); }
      });
    } finally { requestActive = false; }
  }

  async function close() {
    closed = true;
    const failure = await stop(current, 'search process closed');
    if (failure) throw new Error(`search process cleanup failed: ${failure.message}`);
  }
  return {searchAll, close, ready: start};
}
