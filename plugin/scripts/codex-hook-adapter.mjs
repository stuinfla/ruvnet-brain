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
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const raw = fs.readFileSync(0, 'utf8');
let input = {};
try { input = raw ? JSON.parse(raw) : {}; } catch { /* the shared hook bodies already fail soft */ }

const hookId = process.argv[2] || '';
const event = String(input.hook_event_name || '');
let adapted = false;
const codexToolName = String(input.tool_name).toLowerCase();

/**
 * Events whose output schema defines a *HookSpecificOutputWire with `additionalContext`. Only these
 * may carry a hook's prose back to the model.
 */
const CONTEXT_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SessionStart', 'SubagentStart', 'UserPromptSubmit',
]);

/** Every file an apply_patch touches, in patch order. Codex patches are routinely multi-file. */
export function patchFiles(patch) {
  const out = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const f = m[1].trim();
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

// Codex names these tools differently from the shared Claude hook contracts. Normalize at the
// host boundary once so every existing safety/learning body sees the same typed event.
let files = [];
if (['exec_command', 'functions.exec_command', 'functions__exec_command'].includes(codexToolName)) {
  input.tool_name = 'Bash';
  input.tool_input = {
    ...(input.tool_input || {}),
    command: input.tool_input?.command || input.tool_input?.cmd || '',
  };
  adapted = true;
} else if (codexToolName === 'apply_patch') {
  const patch = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  files = patchFiles(patch);
  input.tool_name = 'Edit';
  input.tool_input = {
    ...(input.tool_input || {}),
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
const env = {
  ...process.env,
  CLAUDE_SESSION_ID: String(input.session_id || process.env.CLAUDE_SESSION_ID || ''),
  CLAUDE_PLUGIN_ROOT: String(process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || ''),
  CLAUDE_PROJECT_DIR: String(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()),
  RUVNET_HOOK_HOST: 'codex',
};

const runShim = (payload) => spawnSync(process.execPath, [shim, hookId, ...process.argv.slice(3)], {
  input: payload, encoding: 'utf8', env,
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
 * wrapper hands its budget down; iteration stops at 75% of it and ALLOWS, which is decision-gate's
 * own rule for a blown budget ("a blown budget ALLOWS and says nothing"): the gate's slowness must
 * never be indistinguishable from the user doing something wrong.
 */
const BUDGET_MS = Number(process.env.RUVNET_CODEX_BUDGET_MS) || 0;
const started = Date.now();
const spent = () => Date.now() - started;

const payloads = files.length > 1
  ? files.map((file) => JSON.stringify({
    ...input,
    tool_input: { ...input.tool_input, file_path: file },
  }))
  : [hookInput];

const stdouts = [];
for (const payload of payloads) {
  const r = runShim(payload);
  // A refusal (or any error) from ANY file is the decision for the whole patch, forwarded verbatim
  // and immediately — there is nothing to compose once one wall has said no.
  if (r.status && r.stderr) process.stderr.write(r.stderr);
  if (r.status) process.exit(r.status);
  if (r.stdout) stdouts.push(r.stdout);
  if (BUDGET_MS && spent() > BUDGET_MS * 0.75) break;
}

if (!stdouts.length) process.exit(0);

/** Merge N bodies' output into ONE value. Envelopes join by context; anything else joins as text. */
function merge(outs) {
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

if (event === 'Stop') {
  const reason = parsed?.hookSpecificOutput?.additionalContext
    || parsed?.reason
    || parsed?.stopReason;
  // `stop.command.output` has no hookSpecificOutput; `decision: "block"` REQUIRES a non-empty
  // `reason` ("Stop hook returned decision:block without a non-empty reason"). No reason ⇒ say
  // nothing at all, which is the allow.
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
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
