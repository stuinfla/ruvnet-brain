// Runs one install transaction for the updater inside a worker thread of the running server.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { install, Refused } from './install.mjs';

try {
  const r = await install({ home: workerData.home, from: workerData.from });
  // The shim is refreshed after an automatic update too (review F11), exactly as after `update`; a
  // shim that cannot be refreshed now leaves the previous one working and says so.
  let shim = 'shim refreshed';
  try {
    if (fs.existsSync(path.join(workerData.home, 'shim'))) (await import('../plugin/install.mjs')).installShim({ home: workerData.home });
    else shim = 'no shim to refresh';
  } catch (e) {
    shim = `shim not refreshed (${e.message}); the previous shim is still in place`;
  }
  parentPort.postMessage({ ok: true, message: `installed app ${r.current.app}, pack ${r.current.pack}; ${shim}` });
} catch (e) {
  parentPort.postMessage({ ok: false, refused: e instanceof Refused, message: e.message });
}
