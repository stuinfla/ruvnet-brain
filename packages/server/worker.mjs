// The search worker thread: loads the engine of the app it was started for and answers calls.
// A search runs the question as given on the installed pack; widen() then adds the private packs
// whose project list includes the caller's folder and, when the recipe switches it on, the extra terms.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { widen } from './widen.mjs';
import { read } from './read.mjs';

const engine = await import(pathToFileURL(path.join(workerData.appDir, 'engine', 'index.mjs')).href);
const layered = await import(pathToFileURL(path.join(workerData.appDir, 'engine', 'layered', 'query.mjs')).href);
let handle = null;
let lh = null; // the layered store, opened on first use; only ever the installed public pack
const privates = { list: null };

/** A layered tool call: { tool, args } -> the JSON text of its answer, or a refusal naming why. */
function runLayered(m) {
  try {
    lh ??= layered.openLayered(workerData.packDir, handle.pack, handle.recipe);
  } catch (e) {
    if (e instanceof layered.Unavailable) throw Object.assign(new Error(`refused: ${e.message}`), { refused: true });
    throw e;
  }
  return layered.runTool(lh, m.tool, m.args);
}

parentPort.on('message', (m) => {
  try {
    if (!handle) handle = engine.open(workerData.packDir);
    let result;
    if (m.type === 'selfTest') result = engine.selfTest(handle);
    else if (m.type === 'read') result = read(engine, handle, privates, m);
    else if (m.type === 'layered') result = runLayered(m);
    else result = engine.search(handle, m.query, m.options);
    if (m.type === 'search') result = widen(engine, handle, privates, m, result);
    parentPort.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String(e?.message ?? e) });
  }
});
