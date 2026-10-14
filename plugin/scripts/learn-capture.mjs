#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { learningContext } from './runtime-preferences.mjs';
import { recordLearningObservation, distillObservations } from './learning-store.mjs';
import { resolveRuflo } from './ruflo-bin.mjs';
import { recordHookFailure } from './hook-failures.mjs';

// Fixed vocabulary: arbitrary executable names, arguments, basenames and paths never persist.
const verbs = new Set('git npm node python python3 cargo rustc go gh cd ls rg cat export mkdir rm cp mv bash sh curl wget npx ruflo'.split(' '));
const subs = new Set('status diff log show add commit push pull fetch checkout switch branch test run install ci build check fmt clippy auth workflow release memory hooks'.split(' '));
export function safeAction(tool, value) {
  if (typeof value !== 'string') return null;
  if (tool === 'Bash') {
    const [verb, sub] = value.trim().split(/\s+/, 3);
    if (!verbs.has(verb)) return 'command';
    return subs.has(sub) ? `${verb} ${sub}` : verb;
  }
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) return null;
  // Legacy action is minimized again before invocation; no private basename reaches Ruflo argv.
  return 'edit file';
}

/**
 * One PostToolUse observation, written DIRECTLY with `ruflo memory store` + exact-key readback (owner
 * ruling 2026-10-12: no local queue, no flush worker, no replay). It runs in-process from
 * session-snapshot's PostToolUse boundary. learningContext() owns consent and brain-off. A refused or
 * unverified write is LOUD: one row in the hook-failures ledger, summarized at the next SessionStart.
 */
export function captureLearning(input, { env = process.env, binary = resolveRuflo({ env }), brainHome, detach = false } = {}) {
  let tool; let action;
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
    tool = input.tool_name;
    if (!['Bash', 'Write', 'Edit', 'MultiEdit'].includes(tool)) return false;
    action = safeAction(tool, tool === 'Bash' ? input.tool_input?.command : 'edit file');
    if (!action) return false;
    if (!binary) throw new Error('ruflo not found');
    const observation = { tool, action, session: String(input.session_id || '') };
    // Review M3: on the hook path the store + exact readback run in a detached, bounded child, so the
    // tool call returns at once; that child writes the ledger row if the write is refused or unverified.
    if (detach) return detachLearning('--observe', { env, brainHome, observation });
    recordLearningObservation(binary, context, observation, { env, deadline: Date.now() + 6000 });
    return true;
  } catch (error) {
    if (tool && action) recordHookFailure({ hook: 'learn-capture', event: 'PostToolUse', error: String(error?.message || error).slice(0, 160) }, brainHome ? { brainHome } : undefined);
    return false;
  }
}

/** Detached, bounded child (`--observe` one observation, `--distill` the namespace). Only fixed-vocabulary fields cross. */
export function detachLearning(mode, { env = process.env, brainHome, observation } = {}) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...env, ...(observation ? { RUVNET_LEARN_OBSERVATION: JSON.stringify(observation) } : {}), ...(brainHome ? { RUVNET_BRAIN_HOME: brainHome } : {}) } });
  child.unref();
  return true;
}

function runDetached(mode) {
  const fail = (error) => recordHookFailure({ hook: mode === '--distill' ? 'learn-distill' : 'learn-capture', event: mode === '--distill' ? 'SessionEnd' : 'PostToolUse', error: String(error?.message || error).slice(0, 160) });
  try {
    const context = learningContext(); // consent is re-read: a withdrawn consent writes nothing
    if (!context.enabled) return;
    const binary = resolveRuflo({ env: process.env });
    if (!binary) throw new Error('ruflo not found');
    if (mode === '--distill') { distillObservations(binary, context, { env: process.env }); return; }
    const o = JSON.parse(process.env.RUVNET_LEARN_OBSERVATION || '{}');
    if (!['Bash', 'Write', 'Edit', 'MultiEdit'].includes(o.tool) || typeof o.action !== 'string') throw new Error('invalid detached observation');
    recordLearningObservation(binary, context, { tool: o.tool, action: o.action, session: String(o.session || '') }, { env: process.env, deadline: Date.now() + 14_000, allowed: () => learningContext().enabled });
  } catch (error) { fail(error); }
}

const isMain = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain && ['--observe', '--distill'].includes(process.argv[2])) {
  runDetached(process.argv[2]);
  process.exit(0);
} else if (isMain) {
  try {
    if (learningContext().enabled) captureLearning(JSON.parse((await readStdinBounded({ maxBytes: 65536, emptyMs: 150 })).toString()));
  } catch { /* malformed input produces no persisted payload */ }
  process.exit(0);
}
