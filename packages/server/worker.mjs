// The search worker thread: loads the engine of the app it was started for and answers calls.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const engine = await import(pathToFileURL(path.join(workerData.appDir, 'engine', 'index.mjs')).href);
let handle = null;

parentPort.on('message', (m) => {
  try {
    if (!handle) handle = engine.open(workerData.packDir);
    let result;
    if (m.type === 'selfTest') result = engine.selfTest(handle);
    else result = engine.search(handle, m.query, m.options);
    parentPort.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String(e?.message ?? e) });
  }
});
