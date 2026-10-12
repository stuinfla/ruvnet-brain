#!/usr/bin/env node
// PostToolUse captures only a fixed workflow vocabulary, then schedules bounded orphan recovery.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { learningContext } from './runtime-preferences.mjs';
import { learningTarget } from './learning-store.mjs';
import { safeQueue, safeAction, writeExclusive, takeQueueLock, releaseQueueLock, queueFiles } from './learning-queue.mjs';

/**
 * One PostToolUse observation. Since ADR-106 it runs IN-PROCESS from session-snapshot's PostToolUse
 * boundary (one registration instead of two); the script entry below stays for explicit invocation.
 * learningContext() owns consent and brain-off, so the fold keeps ADR-054's OFF contract.
 */
export function captureLearning(input) {
  try {
    const context = learningContext();
    if (!context.enabled || !input || typeof input !== 'object') return false;
    if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return false;
    const response = input.tool_response;
    if (typeof response === 'string') {
      const exit = /^Process exited with code (-?\d+)\s*$/m.exec(response);
      if ((exit && Number(exit[1]) !== 0) || /Process running with session ID/.test(response)) return false;
    }
    if (input.error || input.is_error === true || response?.error || response?.interrupted === true || response?.signal
      || response?.success === false || response?.is_error === true || response?.isError === true
      || [response?.exit_code, response?.exitCode, response?.status].some(value => Number.isInteger(value) && value !== 0)) return false;
    const tool = input.tool_name;
    if (!['Bash', 'Write', 'Edit', 'MultiEdit'].includes(tool)) return false;
    const action = safeAction(tool, tool === 'Bash' ? input.tool_input?.command : 'edit file');
    if (!action) return false;
    const fresh = learningContext();
    if (!fresh.enabled || fresh.queueDir !== context.queueDir) return false;
    learningTarget(fresh); // Existing authorized user store is required before creating any user queue bytes.
    const dir = safeQueue(fresh, true);
    const sid = createHash('sha256').update(String(input.session_id || process.env.CLAUDE_SESSION_ID || 'default')).digest('hex').slice(0, 24);
    writeExclusive(path.join(dir, `session-${sid}-${randomUUID()}.jsonl`), JSON.stringify({ tool, action }) + '\n');
    // Per-scope lock in the flusher suppresses duplicate workers; capture never waits on the learner.
    const token = takeQueueLock(fresh);
    if (!token) return true;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./learn-flush.mjs', import.meta.url)), '--supervisor'], {
      cwd: fresh.projectDir, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, RUVNET_LEARN_WORKER_TOKEN: token },
    });
    child.on('error', () => releaseQueueLock(fresh, token)); child.unref();
    return true;
  } catch { return false; /* advisory transport; unsafe/malformed input produces no persisted payload */ }
}

/**
 * Lifecycle recovery (formerly its own SessionStart/SessionEnd registration, ADR-106): when learning
 * is enabled, start learn-flush detached so an orphaned queue is drained by one finite worker. The
 * caller never waits; learn-flush owns the lock, the deadline and the consent re-checks.
 */
export function scheduleLearningRecovery({ cwd = process.cwd(), env = process.env, spawnFn = spawn } = {}) {
  try {
    const context = learningContext({ env, cwd });
    if (!context.enabled) return false;
    // Nothing queued, nothing to recover. Spawning anyway cost a process at every session boundary and,
    // on Windows, a live worker holds the project directory as its cwd (EBUSY on delete/move).
    if (queueFiles(context, { limit: 1, deadline: Date.now() + 100 }).length === 0) return false;
    const child = spawnFn(process.execPath, [fileURLToPath(new URL('./learn-flush.mjs', import.meta.url))], {
      cwd, detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on?.('error', () => {}); child.unref?.();
    return true;
  } catch { return false; }
}

const isMain = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  try {
    if (learningContext().enabled) captureLearning(JSON.parse((await readStdinBounded({ maxBytes: 65536, emptyMs: 150 })).toString()));
  } catch { /* malformed input produces no persisted payload */ }
  process.exit(0);
}
