// Runs one install transaction for the updater inside a worker thread of the running server.
import { parentPort, workerData } from 'node:worker_threads';
import { install, Refused } from './install.mjs';

try {
  const r = await install({ home: workerData.home, from: workerData.from });
  parentPort.postMessage({ ok: true, message: `installed app ${r.current.app}, pack ${r.current.pack}` });
} catch (e) {
  parentPort.postMessage({ ok: false, refused: e instanceof Refused, message: e.message });
}
