#!/usr/bin/env node
/**
 * grounding-turn-mark.mjs — UserPromptSubmit half of the "answered without searching" gate.
 *
 * THE GAP THIS CLOSES (measured, not assumed — see grounding-turn-gate.mjs's header for the full
 * account). ground-ruvnet.sh's Gate 1 tells the model, in prose, "you MUST call search_ruvnet
 * before asserting" whenever the prompt touches the rUv stack — but a prompt is advisory (rUv's own
 * ADR-G007: "prompts are advisory. Agents can and do ignore them"), and nothing checked whether the
 * model actually did it before the turn ended. This file is step one of making that check possible:
 * it records ONLY the fact that Gate 1 fired for this turn, so the Stop-time gate
 * (grounding-turn-gate.mjs) has something to check against — Stop's own payload carries no prompt
 * text (confirmed against every Stop-consuming file in this repo; continuation-gate.mjs's `Stop`
 * input has session_id/turn_id/stop_hook_active/last_assistant_message and nothing resembling the
 * user's prompt).
 *
 * THE REGEX IS NOT REDEFINED HERE. It is imported from ruvnet-gate1-pattern.mjs, which is the one
 * JS copy of ground-ruvnet.sh's Gate 1 ERE, proven byte-identical to it by
 * tests/unit/ruvnet-gate1-pattern.test.mjs. ground-ruvnet.sh itself is UNTOUCHED by this file — it
 * is a hot, heavily-tuned, every-prompt hook, and this feature does not need to change it.
 *
 * WHAT THIS WRITES: a marker file under ~/.cache/ruvnet-brain/grounding-turn/<session_id>, whose
 * MTIME is the signal (same idiom grounding-stamp.sh and ground-before-write.sh already use for
 * their own 24h stamps — this reuses that mtime-comparison convention rather than inventing a new
 * one). Its CONTENT is a JSON blob for a human reading the cache, but the Stop-time gate only ever
 * trusts the mtime.
 *
 * CONTRACT: PostToolUse-shaped hooks in this repo are advisory; this one is too — it can never
 * block a prompt. It exits 0 unconditionally and writes nothing to stdout Claude/Codex would act
 * on (UserPromptSubmit's silence contract). A write failure (unwritable cache dir, race, etc.) is
 * swallowed: a marker that fails to write means the Stop gate later sees nothing and stays silent,
 * which is fail-open in the correct direction — never a false block from a plumbing failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { ruvnetGate1Matches } from './ruvnet-gate1-pattern.mjs';

const HOME = os.homedir();
export const MARKER_DIR = process.env.RUVNET_GROUNDING_TURN_DIR
  || path.join(HOME, '.cache', 'ruvnet-brain', 'grounding-turn');

/** Filesystem-safe key for a session id — mirrors continuation-gate.mjs's own `replace(':', '-')`
 *  idiom, generalised: a session id is host-supplied and must never be trusted as a bare path
 *  segment. */
export function markerPathFor(sessionId, dir = MARKER_DIR) {
  const safe = String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 200);
  return safe ? path.join(dir, `${safe}.json`) : null;
}

/** Exported for the unit test: pure decision, no I/O. */
export function shouldMark(hookInput) {
  if (!hookInput || hookInput.hook_event_name !== 'UserPromptSubmit') return false;
  if (!hookInput.session_id) return false;
  const text = String(hookInput.prompt ?? hookInput.user_prompt ?? hookInput.input ?? '');
  return ruvnetGate1Matches(text);
}

async function main() {
  let hookInput;
  try {
    const raw = (await readStdinBounded()).toString('utf8');
    hookInput = JSON.parse(raw || '{}');
  } catch { process.exit(0); }

  if (!shouldMark(hookInput)) process.exit(0);

  const file = markerPathFor(hookInput.session_id);
  if (!file) process.exit(0);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      sessionId: hookInput.session_id,
      turnId: hookInput.turn_id || hookInput.prompt_id || null,
    }) + '\n');
  } catch { /* fail-open: no marker means the Stop gate stays silent, never a false block */ }
  process.exit(0);
}

/** Never runs main() merely because a test (or anything else) imported this file for its pure
 *  helpers — same guard decision-gate.mjs uses, for the same reason (entrypoint-guard-safety). */
function isMain() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) main();
