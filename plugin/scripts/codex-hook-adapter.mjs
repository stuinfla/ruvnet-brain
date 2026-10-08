#!/usr/bin/env node
/**
 * codex-hook-adapter.mjs — the host boundary. Codex payloads in, shared Brain hook bodies out, and
 * Codex-VALID output back.
 *
 * THE OUTPUT CONTRACT IS NOT GUESSED. Every rule below was read out of the real host: the JSON
 * schemas Codex 0.147.0 carries inside its own binary — `<event>.command.output`, extracted
 * 2026-08-14 with `strings` from
 * `~/.codex/packages/standalone/releases/0.147.0-aarch64-apple-darwin/bin/codex` — plus the host's
 * own error strings. The three that shaped this file:
 *
 *   · "hook returned invalid post-tool-use JSON output"  — PostToolUse stdout is PARSED. Plain text
 *     is a host error, not a message. signal-watch.mjs prints one advisory LINE on a failed
 *     gh/vercel/npm command, which reached Codex as invalid JSON on every such command, and nothing
 *     in this file wrapped it: the old envelope branch covered SessionStart and UserPromptSubmit
 *     only. Measured before the fix: raw text passed straight through.
 *   · The events that may carry `hookSpecificOutput.additionalContext` are exactly the ones with a
 *     *HookSpecificOutputWire definition — PreToolUse, PostToolUse, PermissionRequest, SessionStart,
 *     SubagentStart, UserPromptSubmit. `session-end.command.output` DOES NOT EXIST, and
 *     pre-compact/post-compact/stop/subagent-stop have no additionalContext at all. So for those,
 *     unparseable stdout is DROPPED. Wrapping it would trade a silent no-op for a host error.
 *   · "PreToolUse hook returned unsupported permissionDecision:allow" / ":ask" — the wire enum has
 *     three values and Codex accepts exactly one of them, `deny`. Anything else is stripped, which
 *     is why the pre-existing `defer` strip is now a general rule rather than one special case.
 *
 * Exit-2-plus-stderr is the refusal channel on every blocking event ("PreToolUse hook exited with
 * code 2 but did not write a blocking reason to stderr" is the host's complaint when the stderr half
 * is missing), so a non-zero status is forwarded verbatim and never reinterpreted.
 */
import fs from 'node:fs';
import { readContextFrame, contextFrame, selectContextFrame, renderContextFrame, recordContextBudget } from './hook-context-budget.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTEXT_EVENTS } from './codex-hook-events.mjs';
import { developmentHooksSuspended } from './development-maintenance.mjs';
import { snapshotDeadlineAt } from './session-snapshot-budget.mjs';

if (developmentHooksSuspended()) process.exit(0);

const raw = fs.readFileSync(0, 'utf8');
let input = {};
try { input = raw ? JSON.parse(raw) : {}; } catch { /* the shared hook bodies already fail soft */ }
if (typeof input.cwd === 'string' && developmentHooksSuspended(input.cwd)) process.exit(0);

const hookId = process.argv[2] || '';
const event = String(input.hook_event_name || '');
let adapted = false;
const codexToolName = String(input.tool_name).toLowerCase();

// CONTEXT_EVENTS (events whose output schema defines a *HookSpecificOutputWire with
// `additionalContext`) now lives in the pure sibling ./codex-hook-events.mjs — see that file's
// header for why: this module's top level reads stdin synchronously, which makes it unsafe to
// import for its constants alone (Dream Cycle 2026-08-30).

/** Every file an apply_patch touches, in patch order. Codex patches are routinely multi-file. */
export function patchFiles(patch) {
  return [...new Set(patchOperations(patch).flatMap((op) => op.move ? [op.file, op.move] : [op.file]))];
}

function patchOperations(patch) {
  const out = [];
  for (const line of String(patch || '').split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) out.push({ operation: header[1], file: header[2].trim() });
    else {
      const move = /^\*\*\* Move to: (.+)$/.exec(line);
      if (move && out.at(-1)?.operation === 'Update') out.at(-1).move = move[1].trim();
    }
  }
  return out;
}

// Codex names these tools differently from the shared Claude hook contracts. Normalize at the
// host boundary once so every existing safety/learning body sees the same typed event.
let files = [];
let operations = [];
const patchTool = ['apply_patch', 'functions.apply_patch', 'functions__apply_patch'].includes(codexToolName);
if (['exec_command', 'functions.exec_command', 'functions__exec_command'].includes(codexToolName)) {
  input.tool_name = 'Bash';
  input.tool_input = {
    ...(input.tool_input || {}),
    command: input.tool_input?.command || input.tool_input?.cmd || '',
  };
  adapted = true;
} else if (patchTool) {
  // Codex 0.153.4's installed hook schema declares tool_input as arbitrary JSON. Its installed
  // apply_patch grammar is FREEFORM (raw string); object.command is the existing compatibility
  // contract. Do not spread a raw string into numbered object properties or guess other fields.
  const patch = typeof input.tool_input === 'string' ? input.tool_input
    : typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  operations = patchOperations(patch);
  files = patchFiles(patch);
  input.tool_name = 'Edit';
  input.tool_input = {
    ...(input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}),
    ...(files[0] ? { file_path: files[0] } : {}),
    new_string: patch,
  };
  adapted = true;
} else if (codexToolName === 'spawn_agent') {
  input.tool_name = 'Agent';
  input.tool_input = {
    ...(input.tool_input || {}),
    description: input.tool_input?.description || input.tool_input?.message || '',
    subagent_type: input.tool_input?.subagent_type || input.tool_input?.agent_type || 'default',
  };
  adapted = true;
}

const hookInput = adapted ? JSON.stringify(input) : raw;
const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook-shim.mjs');
const projectDir = String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const env = {
  ...process.env,
  CLAUDE_SESSION_ID: String(input.session_id || process.env.CLAUDE_SESSION_ID || ''),
  CLAUDE_PLUGIN_ROOT: String(process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || ''),
  CLAUDE_PROJECT_DIR: projectDir,
  RUVNET_HOOK_HOST: 'codex',
  RUVNET_CODEX_CONTEXT_FRAMES: '1',
};

// Dream Cycle 2026-09-05. Codex's own dispatch trampoline (codex-hooks.json) never passes `cwd:`
// when it spawns codex-hook.mjs, and codex-hook-wrapper.mjs never passes it when it spawns THIS
// process either — so the real OS $PWD this process (and every child below it) inherits is wherever
// Codex happened to launch the trampoline from, architecturally independent of the payload's own
// `cwd` field used for CLAUDE_PROJECT_DIR above. project-identity.mjs's projectDirectory() and
// learn-capture.sh's containment check both trust CLAUDE_PROJECT_DIR only when $PWD actually lies
// inside it (#85/#107) — so whenever the dispatcher's real cwd and the payload's declared cwd
// diverge, that check silently REJECTS the correct root and falls back to the dispatcher's own
// directory, which this plugin does not own (ADR-058 D5). Fall back to the current cwd if the
// declared one no longer exists, rather than handing spawnSync a cwd it will ENOENT on.
let shimCwd = process.cwd();
try { if (fs.statSync(projectDir).isDirectory()) shimCwd = projectDir; } catch { /* keep the default */ }

const snapshotDeadline = hookId === 'session-snapshot' ? snapshotDeadlineAt(env, performance.timeOrigin) : Infinity;
if (Number.isFinite(snapshotDeadline)) env.RUVNET_SESSION_SNAPSHOT_DEADLINE_AT = String(snapshotDeadline);
const runShim = (payload) => spawnSync(process.execPath, [shim, hookId, ...process.argv.slice(3)], {
  input: payload, encoding: 'utf8', env: { ...env, ...(BUDGET_MS ? { RUVNET_DECISION_DEADLINE: String(Math.min(Number(env.RUVNET_DECISION_DEADLINE) || Infinity, Date.now() + Math.max(1, BUDGET_MS - spent() - 350))) } : {}) }, cwd: shimCwd,
  ...((BUDGET_MS || Number.isFinite(snapshotDeadline)) ? { timeout: Math.max(1, Math.floor(Math.min(
    BUDGET_MS ? BUDGET_MS - spent() - 100 : Infinity, snapshotDeadline - Date.now() + 100))), killSignal: 'SIGKILL' } : {}),
});

/**
 * ONE PAYLOAD PER FILE for a multi-file patch.
 *
 * Every write policy on both hosts reads a single `tool_input.file_path` (protect-brain-state.sh
 * line 56, ground-before-write.sh line 109, adr-currency-gate.mjs line 137). A Codex `apply_patch`
 * carries N files in one call, so exposing only the first meant files 2..N were never shown to any
 * wall — the same shape as every other defect in this area: the check exists and points one surface
 * away from the failure.
 *
 * BOUNDED, because the wrapper SIGKILLs this process at its own budget and a kill is invisible. The
 * wrapper hands its budget down; advisory iteration may stop at 75% of it. A PreToolUse write-policy
 * decision instead refuses the whole patch if any remaining path is unchecked, with explicit
 * unchecked scope; a timeout can never authorize an uninspected write.
 */
const BUDGET_MS = Number(process.env.RUVNET_CODEX_BUDGET_MS) || 0;
const started = Date.now();
const spent = () => Date.now() - started;

let payloads = files.length > 1
  ? files.map((file) => JSON.stringify({
    ...input,
    tool_input: { ...input.tool_input, file_path: file },
  }))
  : [hookInput];

if (patchTool && hookId === 'md-stamp') {
  // Installed apply_patch reports this exact success banner plus A/M/D path records. A raw patch
  // describes intent; only the successful result authorizes stamping or supplies Add provenance.
  const response = input.tool_response;
  if (event !== 'PostToolUse' || typeof response !== 'string'
    || !/^Success\. Updated the following files:\r?\n/.test(response)) process.exit(0);
  const succeeded = new Map([...response.matchAll(/^([AMD]) (.+)$/gm)]
    .map((m) => [path.resolve(projectDir, m[2].trim()), m[1]]));
  payloads = operations.filter((op) => op.operation !== 'Delete').flatMap((op) => {
    const file = op.move || op.file;
    const status = succeeded.get(path.resolve(projectDir, file));
    if (status !== 'A' && status !== 'M') return [];
    return [JSON.stringify({
      ...input,
      tool_input: { ...input.tool_input, file_path: file },
      tool_response: op.operation === 'Add' && status === 'A' ? { type: 'create' } : response,
    })];
  });
}

const stdouts = [];
let managedWrite = false;
if (hookId === 'decision-gate' && process.argv[3] === 'managed-store') {
  try {
    const { knownRawStoreWrites } = await import('./hook-input.mjs');
    const { canonicalStoreWriteScope } = await import('./project-store-resolver.mjs');
    managedWrite = canonicalStoreWriteScope({ projectDir, targets: knownRawStoreWrites(input.tool_input?.command || '',
      { cwd: projectDir, home: process.env.HOME || os.homedir() }) });
  } catch { /* Only a positive canonical witness changes legacy error behavior. */ }
}
const guardedPatch = patchTool && hookId === 'decision-gate' && event === 'PreToolUse';
// Materialize every path before consulting any policy; a move checks both ends.
const patchScope = files.map((file) => path.resolve(projectDir, file));
const refuseUnchecked = (index) => {
  process.stderr.write(`Patch refused: write-policy inspection incomplete for ${JSON.stringify(patchScope.slice(index))}. Split the patch or retry after the bounded policy check is available.\n`);
  process.exit(2);
};
if (guardedPatch && !patchScope.length) refuseUnchecked(0);
for (const [index, payload] of payloads.entries()) {
  if (hookId === 'session-snapshot' && Date.now() >= snapshotDeadline) {
    process.stderr.write('[RuvNet Brain — PROJECT CONTINUITY UNKNOWN] Snapshot fanout deadline exhausted; capture is unverified.\n');
    break;
  }
  if (guardedPatch && BUDGET_MS && BUDGET_MS - spent() <= 100) refuseUnchecked(index);
  const r = runShim(payload);
  if (managedWrite && (r.error || r.signal || r.status !== 2)) {
    process.stderr.write('Raw writes to the canonical Ruflo-managed store are refused: Codex policy body unavailable.\n'); process.exit(2);
  }
  if (hookId === 'session-snapshot') {
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error || r.signal || r.status === null) {
      process.stderr.write('[RuvNet Brain — PROJECT CONTINUITY UNKNOWN] Snapshot child did not complete inside its inherited deadline; capture is unverified.\n');
      break;
    }
  }
  // A refusal (or any error) from ANY file is the decision for the whole patch, forwarded verbatim
  // and immediately — there is nothing to compose once one wall has said no.
  if (guardedPatch && (r.error || r.signal || r.status === null)) refuseUnchecked(index);
  if (r.status && r.stderr && hookId !== 'session-snapshot') process.stderr.write(r.stderr);
  if (r.status) process.exit(r.status);
  if (r.stdout) stdouts.push(r.stdout);
  if (BUDGET_MS && spent() > BUDGET_MS * 0.75 && index + 1 < payloads.length) {
    if (guardedPatch) refuseUnchecked(index + 1);
    break;
  }
}

if (!stdouts.length) process.exit(0);

/** Merge N bodies' output into ONE value. Envelopes join by context; anything else joins as text. */
function merge(outs) {
  const frames = outs.map((value) => readContextFrame(value));
  if (frames.every((frame) => frame && frame.event === event && frame.handler === hookId)) {
    const selected = selectContextFrame(contextFrame(hookId, event, frames.flatMap((frame) => frame.blocks)));
    recordContextBudget({ ...selected.receipt, stage: 'codex-final-fanout-merge' }, env);
    return renderContextFrame(selected.frame);
  }
  if (frames.some(Boolean)) {
    recordContextBudget({ handler: hookId, event, scope: 'mixed-framed-unframed-budget-unknown' }, env);
    outs = outs.map((value, index) => frames[index] ? renderContextFrame({ ...frames[index], event }) : value);
  }
  if (!frames.some(Boolean)) recordContextBudget({ handler: hookId, event, scope: 'unframed-output-budget-unknown' }, env);
  if (outs.length === 1) return outs[0];
  const parsedAll = outs.map((s) => { try { return JSON.parse(s); } catch { return null; } });
  const contexts = parsedAll.map((p) => p?.hookSpecificOutput?.additionalContext);
  if (parsedAll.every((p) => p) && contexts.every((c) => typeof c === 'string')) {
    const first = parsedAll[0];
    return JSON.stringify({
      ...first,
      hookSpecificOutput: { ...first.hookSpecificOutput, additionalContext: contexts.join('\n') },
    });
  }
  return outs.map((s) => s.trim()).filter(Boolean).join('\n');
}

const stdout = merge(stdouts);

let parsed = null;
try { parsed = JSON.parse(stdout); } catch { /* a shared body may legitimately print prose */ }

function validPostToolUseOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const topLevelKeys = new Set([
    'continue', 'stopReason', 'suppressOutput', 'systemMessage',
    'decision', 'reason', 'hookSpecificOutput',
  ]);
  if (Object.keys(value).some((key) => !topLevelKeys.has(key))) return false;
  if (value.continue !== undefined && typeof value.continue !== 'boolean') return false;
  if (value.stopReason !== undefined && typeof value.stopReason !== 'string') return false;
  if (value.suppressOutput !== undefined && typeof value.suppressOutput !== 'boolean') return false;
  if (value.systemMessage !== undefined && typeof value.systemMessage !== 'string') return false;
  if (value.decision !== undefined && value.decision !== 'block') return false;
  if (value.decision === 'block' && (typeof value.reason !== 'string' || !value.reason.trim())) return false;
  if (value.hookSpecificOutput !== undefined) {
    const specific = value.hookSpecificOutput;
    if (!specific || typeof specific !== 'object' || Array.isArray(specific)) return false;
    const specificKeys = new Set([
      'hookEventName', 'additionalContext',
    ]);
    if (Object.keys(specific).some((key) => !specificKeys.has(key))) return false;
    if (specific.hookEventName !== 'PostToolUse') return false;
    if (specific.additionalContext !== undefined && typeof specific.additionalContext !== 'string') return false;
  }
  return true;
}

if (event === 'Stop') {
  // Native Stop has no hookSpecificOutput. Only an explicit denial may hold the turn open;
  // incidental context is advice, while supported native control fields retain their meaning.
  const output = {};
  for (const key of ['continue', 'suppressOutput']) if (typeof parsed?.[key] === 'boolean') output[key] = parsed[key];
  for (const key of ['stopReason', 'systemMessage']) if (typeof parsed?.[key] === 'string') output[key] = parsed[key];
  const block = parsed?.decision === 'block' && typeof parsed.reason === 'string' && parsed.reason.trim();
  if (block) { output.decision = 'block'; output.reason = parsed.reason; }
  const advice = [!parsed ? stdout.trim() : '',
    typeof parsed?.hookSpecificOutput?.additionalContext === 'string' ? parsed.hookSpecificOutput.additionalContext : '',
    !block && typeof parsed?.reason === 'string' ? parsed.reason : ''].filter(text => text.trim());
  if (advice.length) output.systemMessage = [...new Set([output.systemMessage, ...advice].filter(Boolean))].join('\n');
  if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Dream Cycle 2026-08-25: this event's schema has nowhere to carry an envelope at all — see
// CONTEXT_EVENTS above. The `!parsed` branch below already dropped unparseable prose here; a body
// that happens to emit VALID JSON (e.g. a stray hookSpecificOutput.additionalContext) used to skip
// that guard and fall through to a verbatim stdout write, which Codex rejects exactly like prose
// would. No shipped body does this today, but nothing enforced that it couldn't start.
if (!CONTEXT_EVENTS.has(event)) process.exit(0);

if (!parsed) {
  // Prose from a shared body. It is only deliverable on an event whose schema has somewhere to put
  // it; everywhere else it is dropped rather than emitted as output the host will reject.
  if (CONTEXT_EVENTS.has(event)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: stdout },
    }));
  }
  process.exit(0);
}

// Codex 0.160.0 post-tool-use.command.output (extracted from the installed binary on
// 2026-10-04) rejects terminalSequence, updatedToolOutput, and telemetry fields. The
// host additionally rejects updatedMCPToolOutput semantically after schema parsing. Keep
// supported control fields even when a shared body includes incompatible metadata: wrapping
// the whole output as context alone would silently discard a security block.
if (event === 'PostToolUse' && !validPostToolUseOutput(parsed)) {
  const normalized = {};
  for (const key of ['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'reason']) {
    const type = ['continue', 'suppressOutput'].includes(key) ? 'boolean' : 'string';
    if (typeof parsed[key] === type) normalized[key] = parsed[key];
  }
  if (parsed.decision === 'block') {
    normalized.decision = 'block';
    if (!normalized.reason?.trim()) normalized.reason = stdout.trim();
  }
  normalized.hookSpecificOutput = { hookEventName: event, additionalContext: stdout.trim() };
  process.stdout.write(JSON.stringify(normalized));
  process.exit(0);
}

// `deny` is the only permissionDecision Codex accepts; `allow`, `ask` and the shared bodies' own
// `defer` are all rejected by name. Strip, then drop an envelope that has nothing left to say.
const decision = parsed?.hookSpecificOutput?.permissionDecision;
if (decision && decision !== 'deny') {
  delete parsed.hookSpecificOutput.permissionDecision;
  if (Object.keys(parsed.hookSpecificOutput).length === 1 && parsed.hookSpecificOutput.hookEventName) {
    delete parsed.hookSpecificOutput;
  }
  process.stdout.write(JSON.stringify(parsed));
  process.exit(0);
}

process.stdout.write(stdout);
