#!/usr/bin/env node
// PostToolUse captures only a fixed workflow vocabulary, then schedules bounded orphan recovery.
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { learningContext } from './runtime-preferences.mjs';
import { learningTarget } from './learning-store.mjs';
import { safeQueue, safeAction, writeExclusive, takeQueueLock, releaseQueueLock } from './learning-queue.mjs';

try {
  const context = learningContext();
  if (!context.enabled) process.exit(0);
  const raw = await readStdinBounded({ maxBytes: 65536, emptyMs: 150 });
  const input = JSON.parse(raw.toString());
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') process.exit(0);
  const response = input.tool_response;
  if (typeof response === 'string') {
    const exit = /^Process exited with code (-?\d+)\s*$/m.exec(response);
    if ((exit && Number(exit[1]) !== 0) || /Process running with session ID/.test(response)) process.exit(0);
  }
  if (input.error || input.is_error === true || response?.error || response?.interrupted === true || response?.signal
    || response?.success === false || response?.is_error === true || response?.isError === true
    || [response?.exit_code, response?.exitCode, response?.status].some(value => Number.isInteger(value) && value !== 0)) process.exit(0);
  const tool = input.tool_name;
  if (!['Bash', 'Write', 'Edit', 'MultiEdit'].includes(tool)) process.exit(0);
  const action = safeAction(tool, tool === 'Bash' ? input.tool_input?.command : 'edit file');
  if (!action) process.exit(0);
  const fresh = learningContext();
  if (!fresh.enabled || fresh.queueDir !== context.queueDir) process.exit(0);
  learningTarget(fresh); // Existing authorized user store is required before creating any user queue bytes.
  const dir = safeQueue(fresh, true);
  const sid = createHash('sha256').update(String(input.session_id || process.env.CLAUDE_SESSION_ID || 'default')).digest('hex').slice(0, 24);
  writeExclusive(path.join(dir, `session-${sid}-${randomUUID()}.jsonl`), JSON.stringify({ tool, action }) + '\n');
  // Per-scope lock in the flusher suppresses duplicate workers; capture never waits on the learner.
  const token = takeQueueLock(fresh);
  if (!token) process.exit(0);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./learn-flush.mjs', import.meta.url)), '--supervisor'], {
    cwd: fresh.projectDir, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, RUVNET_LEARN_WORKER_TOKEN: token },
  });
  child.on('error', () => releaseQueueLock(fresh, token)); child.unref();
} catch { /* advisory transport; unsafe/malformed input produces no persisted payload */ }
process.exit(0);
