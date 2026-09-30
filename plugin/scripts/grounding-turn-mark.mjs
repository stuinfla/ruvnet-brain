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
 * 2026-09-30 — TWO ARMS, ONE MARKER (ADR-0030 decision point #1). The marker now also records, as
 * JSON content, whether the prompt ASKS for a capability / feasibility / architecture judgement about
 * a subject (grounding-turn-evidence.mjs classifyPrompt) and which subjects it named, so the Stop gate
 * can require a relevant source for any capability claim the answer makes — on any platform, not
 * only the rUv stack. `gate1` keeps the original meaning (the prompt matched Gate 1).
 *
 * THE FALSE-ALARM FIX. Measured on real transcripts (7 turns where the Stop gate said "no successful
 * search_ruvnet call was recorded" although one had been made): in 3 of them a QUEUED message (a
 * real user message typed mid-turn, or a task notification before H2) fired UserPromptSubmit again
 * AFTER the search and rewrote this marker, moving the turn boundary past the evidence. So an
 * unconsumed marker is now MERGED, never re-dated: its mtime (the boundary) stays at the first arm
 * of the stop episode. A marker older than STALE_MS (an interrupted turn never reaches Stop) is
 * replaced instead. Of the other 4, three were pre-H1 vocabulary misses (fixed by H1) and one was a
 * successful search whose stamp never minted (2026-09-30, cause not recoverable from the transcript);
 * so on Claude the Stop gate now reads the transcript itself (grounding-turn-gate.mjs).
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
import { readStdinBounded, isHarnessGenerated } from './hook-input.mjs';
import { ruvnetGate1Matches } from './ruvnet-gate1-pattern.mjs';
import { classifyPrompt, loadVocabulary } from './grounding-turn-evidence.mjs';

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

const promptOf = (hookInput) => String(hookInput?.prompt ?? hookInput?.user_prompt ?? hookInput?.input ?? '');
const eligible = (hookInput) => Boolean(hookInput && hookInput.hook_event_name === 'UserPromptSubmit' && hookInput.session_id
  // H2: a background task notification, slash-command scaffold, or other harness-authored message
  // arrives on UserPromptSubmit exactly like real user text — arming the Stop-time grounding gate off
  // one of these (because it happens to mention a rUv term) would demand a search_ruvnet call to
  // close out a "turn" nobody had a hand in.
  && !isHarnessGenerated(promptOf(hookInput)));

/** Exported for the unit test: pure decision, no I/O. Gate 1 (the rUv-stack search requirement). */
export function shouldMark(hookInput) {
  return eligible(hookInput) && ruvnetGate1Matches(promptOf(hookInput));
}

/** Both arms for one prompt, or null when neither fires. Pure apart from the vocabulary it is given. */
export function armFor(hookInput, vocab = []) {
  if (!eligible(hookInput)) return null;
  const gate1 = ruvnetGate1Matches(promptOf(hookInput));
  const c = classifyPrompt(promptOf(hookInput), vocab);
  if (!gate1 && !c.assert) return null;
  return { gate1, assert: c.assert, architecture: c.architecture, subjects: c.subjects };
}

export const STALE_MS = 2 * 3600_000;
/** A marker's JSON, or null. Old markers (no `gate1` field) were only ever written for Gate 1. */
export function readMarker(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return m && typeof m === 'object' ? { gate1: m.gate1 !== false, assert: !!m.assert, architecture: !!m.architecture,
      subjects: Array.isArray(m.subjects) ? m.subjects.map(String) : [], at: m.at } : null;
  } catch { return null; }
}

/** Merge an arm into an unconsumed marker WITHOUT moving its mtime (the turn boundary). */
export function writeArm(file, arm, meta = {}, now = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let st = null;
  try { st = fs.statSync(file); } catch { /* none yet */ }
  const prev = st && now - st.mtimeMs < STALE_MS ? readMarker(file) : null;
  const next = prev ? { ...meta, at: prev.at, gate1: prev.gate1 || arm.gate1, assert: prev.assert || arm.assert,
    architecture: prev.architecture || arm.architecture, subjects: [...new Set([...prev.subjects, ...arm.subjects])].slice(0, 32) }
    : { ...meta, at: new Date(now).toISOString(), ...arm };
  fs.writeFileSync(file, JSON.stringify(next) + '\n');
  if (prev) fs.utimesSync(file, st.atime, st.mtime);
  return next;
}

async function main() {
  let hookInput;
  try {
    const raw = (await readStdinBounded()).toString('utf8');
    hookInput = JSON.parse(raw || '{}');
  } catch { process.exit(0); }

  let arm = null;
  try { arm = armFor(hookInput, loadVocabulary()); } catch { arm = shouldMark(hookInput) ? { gate1: true, assert: false, architecture: false, subjects: [] } : null; }
  if (!arm) process.exit(0);

  const file = markerPathFor(hookInput.session_id);
  if (!file) process.exit(0);
  try {
    writeArm(file, arm, { sessionId: hookInput.session_id, turnId: hookInput.turn_id || hookInput.prompt_id || null });
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
