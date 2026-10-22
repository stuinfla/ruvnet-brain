#!/usr/bin/env node
/**
 * grok-hook-adapter.mjs — the Grok CLI host boundary. Grok payloads in, the shared Brain hook bodies
 * (through hook-shim.mjs, unchanged) in the middle, Grok-valid output back. Registered only by
 * plugin/hooks/grok-hooks.json, which Grok selects through plugin/.grok-plugin/plugin.json.
 *
 * Every rule below is either quoted from Grok's shipped docs (~/.grok/docs/user-guide/10-hooks.md,
 * grok 1.0.50) or was measured on a real `grok -p` turn on 2026-10-13
 * (tests/fixtures/hook-payloads/grok-1.0.50/). Where the docs are silent the behaviour is marked
 * UNVERIFIED in grok-hooks.json and the contract test, never guessed here.
 *
 *   · INPUT. Grok sends camelCase keys plus snake_case copies of SOME of them (measured: session_id,
 *     tool_name, tool_input, tool_response, transcript_path; NOT stop_hook_active,
 *     last_assistant_message or prompt_id). hook-input.mjs normalizeHostEvent() already owns that
 *     mapping (and Grok's tool names: search_replace -> Edit, run_terminal_command -> Bash); it is
 *     reused here, not restated. prompt_id is added from promptId.
 *   · TRANSCRIPT. Grok's transcriptPath is its own ACP update log (…/updates.jsonl), not Claude's
 *     transcript. Every body that parses a transcript parses Claude's format only, so the path is
 *     withheld: the bodies then report their transcript half UNKNOWN (as on Codex) instead of
 *     misreading a foreign file.
 *   · SESSION-END STOP. "A separate Stop also fires at session end (reason: "channel_closed" or
 *     "shutdown"); its decision output is parsed but ignored" (10-hooks.md:399). Measured: a Stop with
 *     reason "shutdown" arrived after SessionEnd. It is not a turn, so no body runs for it.
 *   · OUTPUT. PreToolUse: exit 2 is a deny and the first stderr line its reason (10-hooks.md:377);
 *     JSON permissionDecision/additionalContext use Claude's vocabulary (:318-321). PostToolUse:
 *     stdout is parsed (:341); prose is wrapped as additionalContext rather than recorded as malformed.
 *     Stop: Claude's decision/reason/additionalContext vocabulary "works unchanged" (:497); non-JSON is
 *     an allow (:391). SessionStart, UserPromptSubmit, PreCompact, SessionEnd: stdout is ignored or
 *     discarded (:113, :531), so none is written.
 *   · FAIL OPEN. Only decision-gate may refuse. Any other non-zero status, a timeout or a crash exits 0,
 *     and a kill by this adapter's own budget is one hook-failures row (same writer as the Codex wrapper).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeHostEvent } from './hook-input.mjs';
import { developmentHooksSuspended } from './development-maintenance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

/** Ids whose exit 2 is a refusal Grok must see. Must name only ids hook-shim.mjs calls 'blocking'. */
export const GROK_BLOCKING_HOOKS = Object.freeze(new Set(['decision-gate']));

/** Events whose stdout Grok reads (10-hooks.md:531). Everything else is written nowhere. */
export const GROK_OUTPUT_EVENTS = Object.freeze(new Set(['PreToolUse', 'PostToolUse', 'Stop']));

/**
 * This adapter's own kill budget, below the registration timeout in grok-hooks.json so the adapter,
 * not Grok, ends a slow body and records it. SessionEnd: "A plugin's SessionEnd hook runs for at most
 * that default [1.5 s], whatever its timeout" (10-hooks.md:644-645), so the budget sits under 1500 ms and
 * is handed to the body (RUVNET_CODEX_BUDGET_MS, the host-budget seam the Codex wrapper already uses), which
 * then detaches its checkpoint instead of starting an inline store+readback Grok would kill partway.
 */
export const SESSION_END_BUDGET_MS = 1_400;
export function budgetFor(hookId, event) {
  if (event === 'SessionEnd') return SESSION_END_BUDGET_MS;
  if (hookId === 'decision-gate') return 6_500;
  if (hookId === 'grounding-stamp' || hookId === 'grounding-turn-mark') return 4_000;
  return 8_500;
}

/** Grok payload -> the Claude-shaped payload the shared bodies read. Pure. */
export function grokToBrainPayload(input) {
  const out = normalizeHostEvent(input && typeof input === 'object' ? input : {});
  if (out.prompt_id === undefined && typeof input?.promptId === 'string') out.prompt_id = input.promptId;
  delete out.transcript_path;
  delete out.transcriptPath;
  return out;
}

/** True for Grok's session-end observe-only Stop fire, which is not a turn (10-hooks.md:399, :502). */
export function isSessionEndStop(payload) {
  return payload?.hook_event_name === 'Stop' && typeof payload.reason === 'string' && payload.reason !== 'end_turn';
}

/**
 * The body's result -> what this process writes and its exit code. Pure, so the contract test can
 * drive every branch without a host.
 */
export function grokOutput({ hookId, event, status, stdout = '', stderr = '' }) {
  if (status === 2 && GROK_BLOCKING_HOOKS.has(hookId) && event === 'PreToolUse') {
    return { stdout: isJson(stdout) ? stdout : '', stderr: stderr || 'RuvNet Brain decision-gate refused this write.\n', code: 2 };
  }
  if (status !== 0 || !GROK_OUTPUT_EVENTS.has(event)) return { stdout: '', stderr: '', code: 0 };
  const text = String(stdout || '').trim();
  if (!text) return { stdout: '', stderr: '', code: 0 };
  if (isJson(text)) return { stdout: text, stderr: '', code: 0 };
  if (event === 'Stop') return { stdout: '', stderr: '', code: 0 };
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }), stderr: '', code: 0 };
}

function isJson(text) {
  try { const v = JSON.parse(text); return Boolean(v) && typeof v === 'object' && !Array.isArray(v); } catch { return false; }
}

function readStdin(limit = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    let idle;
    const finish = () => { if (done) return; done = true; clearTimeout(idle); process.stdin.pause(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const arm = () => { clearTimeout(idle); idle = setTimeout(finish, 150); };
    process.stdin.on('data', (chunk) => {
      if (bytes < limit) { const kept = chunk.subarray(0, limit - bytes); chunks.push(kept); bytes += kept.length; }
      arm();
    });
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
    arm();
    process.stdin.resume();
  });
}

async function main() {
  if (developmentHooksSuspended()) return 0;
  const hookId = process.argv[2] || '';
  const extra = process.argv.slice(3);
  const raw = await readStdin();
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { /* the bodies fail soft on an empty payload */ }
  if (typeof input.cwd === 'string' && developmentHooksSuspended(input.cwd)) return 0;
  const payload = grokToBrainPayload(input);
  const event = String(payload.hook_event_name || '');
  if (isSessionEndStop(payload)) return 0;

  const projectDir = String(payload.cwd || process.env.GROK_WORKSPACE_ROOT || process.cwd());
  let cwd = process.cwd();
  try { if (fs.statSync(projectDir).isDirectory()) cwd = projectDir; } catch { /* keep the default */ }
  const budget = budgetFor(hookId, event);
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_SESSION_ID: String(payload.session_id || process.env.GROK_SESSION_ID || ''),
    RUVNET_HOOK_HOST: 'grok',
    ...(event === 'SessionEnd' ? { RUVNET_CODEX_BUDGET_MS: String(budget) } : {}), // the body plans inside Grok's 1.5 s
  };
  const r = spawnSync(process.execPath, [path.join(HERE, 'hook-shim.mjs'), hookId, ...extra], {
    input: JSON.stringify(payload), encoding: 'utf8', env, cwd, timeout: budget, killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL') {
    try {
      const { recordHookFailure } = await import(pathToFileURL(path.join(HERE, 'hook-failures.mjs')).href);
      recordHookFailure({ hook: hookId, event, error: 'killed-by-grok-adapter', limitMs: budget });
    } catch { /* an unrecordable failure must not become a second one */ }
    return 0;
  }
  const out = grokOutput({ hookId, event, status: r.status, stdout: r.stdout, stderr: r.stderr });
  if (out.stdout) fs.writeSync(1, out.stdout);
  if (out.stderr) fs.writeSync(2, out.stderr);
  return out.code;
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) process.exit(await main().catch(() => 0));
