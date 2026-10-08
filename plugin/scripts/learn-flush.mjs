#!/usr/bin/env node
// SessionEnd schedules a finite detached learner; --sync is the explicit Console drain.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { learningContext } from './runtime-preferences.mjs';
import { recordLearningObservation, distillLearning } from './learning-store.mjs';
import { superviseLearning } from './learning-worker-supervisor.mjs';
import { resolveRuflo } from './ruflo-bin.mjs';
import { safeQueue, queueFiles, pendingRecords, acknowledge, safeAction, takeQueueLock,
  ownsQueueLock, releaseQueueLock, WORKER_BUDGET_MS, writeExclusive, writeAtomic, readSafe } from './learning-queue.mjs';

const started = Date.now();
const budget = Math.min(WORKER_BUDGET_MS, Math.max(1, Number(process.env.LEARN_FLUSH_DEADLINE_MS) || WORKER_BUDGET_MS));
const deadline = Math.min(started + budget, Number(process.env.RUVNET_LEARN_WORKER_EXPIRES) || Infinity);
const context = () => learningContext();
const initial = context();
if (!initial.enabled) process.exit(0);
const allowed = () => { const current = context(); return current.enabled && current.scope === initial.scope && current.queueDir === initial.queueDir; };
let token = process.env.RUVNET_LEARN_WORKER_TOKEN;
try { token ||= takeQueueLock(initial); } catch { process.exit(0); }
if (!token || !ownsQueueLock(initial, token)) process.exit(0);

// No enumeration/sorting on the native hook's synchronous path.
if (!process.argv.includes('--worker')) {
  if (process.argv.includes('--sync') || process.argv.includes('--supervisor')) {
    await superviseLearning(initial, token, deadline, { report: process.argv.includes('--sync') });
  } else {
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervisor'], {
        cwd: initial.projectDir, detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, RUVNET_LEARN_WORKER_TOKEN: token, RUVNET_LEARN_WORKER_EXPIRES: String(deadline), RUFLO_DAEMON_AUTOSTART: '0' },
      });
      child.once('error', () => releaseQueueLock(initial, token)); child.unref();
    } catch { releaseQueueLock(initial, token); }
  }
  process.exit(0);
}
const cursorFile = path.join(initial.queueDir, '.scan-cursor');
let cursor = ''; try { cursor = readSafe(cursorFile, 256).toString(); } catch { /* first pass */ }
let files; try { files = queueFiles(initial, { cursor, limit: 128, deadline }); } catch { if (!process.send) releaseQueueLock(initial, token); process.exit(0); }
const result = { schemaVersion: 1, scope: initial.scope, startedAt: new Date().toISOString(),
  fed: 0, acknowledged: 0, failed: 0, malformed: 0, scannedFiles: 0, exhausted: false, recorded: [], distillation: null,
  contract: 'Exact CLI plus independent canonical AgentDB row commits observations; distillation and ratified lessons are separate; originals retained' };
const binary = resolveRuflo({ home: initial.home });
try {
  let bytes = 0; let scanned = null;
  for (const file of files.slice(0, 128)) {
    if (Date.now() >= deadline || result.fed + result.failed >= 8 || bytes >= 16 * 1024 * 1024) break;
    safeQueue(initial); result.scannedFiles++; scanned = path.basename(file);
    let state;
    try { state = pendingRecords(file); bytes += fs.statSync(file).size; }
    catch { result.failed++; continue; } // Unsafe/torn sidecars remain intact; siblings still get a fair turn.
    for (const record of state.records) {
      if (Date.now() >= deadline || result.fed + result.failed >= 8) break;
      if (!allowed() || !ownsQueueLock(initial, token)) break;
      let row;
      try { row = JSON.parse(record.raw); } catch { result.malformed++; continue; }
      const action = safeAction(row.tool, row.action);
      if (!record.key || !action) { result.malformed++; continue; }
      if (!binary) { result.failed++; break; }
      let delivery;
      try {
        delivery = recordLearningObservation(binary, initial, file, record, { tool: row.tool, action }, {
          deadline, explicitLegacyApply: process.env.RUVNET_LEGACY_USER_APPLY === '1',
          allowed: () => allowed() && ownsQueueLock(initial, token),
        });
      } catch { result.failed++; continue; }
      result.recorded.push(delivery);
      result.fed++;
      if (!allowed() || !ownsQueueLock(initial, token)) break;
      state.ack[record.key] = true;
      acknowledge(file, state.ack); result.acknowledged++;
    }
  }
  if (binary && result.fed && allowed() && ownsQueueLock(initial, token) && deadline - Date.now() > 1000) {
    try { result.distillation = distillLearning(binary, initial, { deadline, automatic: true, allowed: () => allowed() && ownsQueueLock(initial, token), explicitLegacyApply: process.env.RUVNET_LEGACY_USER_APPLY === '1' }); }
    catch { result.distillation = { completed: false, reason: 'bounded canonical distillation unavailable', ratifiedLessons: 0 }; }
  }
  result.exhausted = Date.now() >= deadline || result.fed + result.failed >= 8;
  if (allowed() && ownsQueueLock(initial, token)) {
    if (scanned) writeAtomic(cursorFile, scanned);
    const receipt = path.join(initial.queueDir, `.run-${Date.now()}-${process.pid}.json`);
    writeExclusive(receipt, JSON.stringify({ ...result, endedAt: new Date().toISOString() }));
  }
} catch { result.failed++; }
finally { if (!process.send) releaseQueueLock(initial, token); }
if (process.argv.includes('--report')) console.log(`learn-flush: fed ${result.fed}; acknowledged ${result.acknowledged}; failed ${result.failed}; malformed ${result.malformed}; original queue is KEPT for retry/history`);
if (process.argv.includes('--report') && result.distillation?.capability === 'restricted') console.log(`learn-flush: ${result.distillation.deferred}; consented observations remain recorded.`);

// Keep the owned root alive until its supervisor terminates and confirms the whole tree.
// A lost supervisor cannot keep this worker alive beyond its inherited deadline.
if (process.send) {
  process.send({ type: 'learning-worker-complete' });
  await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now() + 600)));
}
