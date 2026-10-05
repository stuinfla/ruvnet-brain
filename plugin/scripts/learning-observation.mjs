// Read-only evidence shared by Console and the training remedy. No queue or learner is initialized.
import path from 'node:path';
import fs from 'node:fs';
import { learningTarget, learningStoreStatus } from './learning-store.mjs';
import { queueFiles, pendingRecords, safeQueue, readSafe } from './learning-queue.mjs';
import { learningContext } from './runtime-preferences.mjs';

const queueContext = (queueDir) => path.basename(queueDir) === 'ruvnet-brain-learn'
  ? { scope: 'project', queueDir, projectDir: path.dirname(path.dirname(queueDir)) }
  : { scope: 'user', queueDir, home: path.dirname(path.dirname(path.dirname(queueDir))) };

export function learningQueueFiles(queueDir) { return queueFiles(queueContext(queueDir)); }

/** Pending evidence includes malformed/torn lines; acknowledged retained originals are history. */
export function learningQueueDepth(queueDir) {
  return learningQueueFiles(queueDir).reduce((depth, file) => depth + pendingRecords(file).records.length, 0);
}

export function observeLearning(options = {}) {
  const env = options.env ?? process.env;
  const context = learningContext(options);
  const result = { ...context, queueDepth: 0, queueKnown: true, legacyUserDepth: 0, legacyUserKnown: true, lastTrainSeconds: null, trajectories: 0, statusKnown: false };
  if (!context.enabled) return result;
  try { learningTarget(context, { env }); } catch { result.statusKnown = false; result.queueKnown = false; return result; }
  try { result.queueDepth = learningQueueDepth(context.queueDir); }
  catch { result.queueKnown = false; }
  try { const lock = JSON.parse(readSafe(path.join(context.queueDir, '.worker-lock'), 4096)); result.workerRetirementUnconfirmed = lock.retirementUnconfirmed === true || (lock.retirementRequired === true && lock.expires < Date.now()); }
  catch { /* Absent diagnostic lock grants no claim about a running process. */ }
  try {
    const latest = fs.readdirSync(safeQueue(context)).filter(n => /^\.run-\d+-\d+\.json$/.test(n))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
    const receipt = latest && JSON.parse(readSafe(path.join(context.queueDir, latest), 65536));
    result.capturePendingFailure = result.queueDepth > 0 && ((Number.isSafeInteger(receipt?.failed) && receipt.failed > 0)
      || (Number.isSafeInteger(receipt?.malformed) && receipt.malformed > 0));
    result.distillationUnavailable = receipt?.distillation?.completed === false;
  } catch { /* Unknown diagnostic is never fabricated success. */ }
  if (context.scope === 'project') {
    try { result.legacyUserDepth = learningQueueDepth(path.join(context.home, '.cache', 'ruvnet-brain', 'learn')); }
    catch { result.legacyUserKnown = false; }
  }
  try {
    result.learningDb = learningTarget(context, { env });
    const state = learningStoreStatus(result.learningDb);
    result.statusKnown = state.known;
    result.trajectories = state.observations; // compatibility field; explicitly observations, never SONA trajectories.
    result.observations = state.observations; result.patterns = state.patterns;
    result.lastDistillAt = state.lastDistillAt;
    if (state.lastDistillAt !== null) result.lastTrainSeconds = Math.max(0, (Date.now() - state.lastDistillAt) / 1000);
  } catch { /* Missing consent/store/readback remains unknown. */ }
  return result;
}
