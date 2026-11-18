// The safe-mode worker thread (review F09): the keyword lane of the installed pack and nothing else. It
// loads only the engine, never this server's search worker (worker.mjs) or its widening, so safe mode
// still answers when the search worker is what broke; it is never run on the server's main thread.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const engine = await import(pathToFileURL(path.join(workerData.appDir, 'engine', 'index.mjs')).href);
let handle = null;

parentPort.on('message', (m) => {
  try {
    handle ??= engine.open(workerData.packDir);
    parentPort.postMessage({ id: m.id, ok: true, result: engine.search(handle, m.query, m.options) });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String(e?.message ?? e) });
  }
});
