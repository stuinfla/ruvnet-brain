#!/usr/bin/env node
/**
 * grounding-turn-gate.mjs — Stop-time enforcement of "you were told to ground, did you?"
 *
 * THE GAP THIS CLOSES, measured rather than assumed. ground-ruvnet.sh's Gate 1 fires a PROMPT-LEVEL
 * directive — "you MUST call the search_ruvnet MCP tool ... BEFORE stating what any RuvNet tool
 * can/cannot do" — whenever the user's prompt touches the rUv stack. That directive is advisory: a
 * prompt is text in context, and rUv's own ADR-G007 names the failure mode by name — "prompts are
 * advisory. Agents can and do ignore them, especially in long sessions." Every OTHER wall in this
 * project fires on an ACTION (a Write, a push, a claim); a plain-text ANSWER that never calls a
 * tool is invisible to all of them, which is the exact shape of continuation-gate.mjs's own
 * "stopping is the absence of an action" problem, applied to grounding instead of to unfinished
 * work.
 *
 * WHY A NEW HOOK, not an extension of continuation-gate.mjs. continuation-gate.mjs's whole
 * architecture is a work LEDGER: explicit `--commit-to` items and derived backlog items, each with
 * an age, a cooldown-guarded force, and a "committed vs observed" vocabulary baked into its header
 * composition. What this file checks is neither — it is a stateless, single-turn compliance
 * question ("did Gate 1 fire this turn, and did search_ruvnet answer it?") with no ledger, no age,
 * and no meaningful "committed vs observed" framing. Folding it into continuation-gate.mjs's
 * cooldown lock would mean a real ledger force and a same-turn grounding nudge fight over one
 * shared 20s window, and folding it into that file's header composition would invent a third
 * category (`header` is currently a strict if/else over exactly two shapes). A second, independent
 * Stop registration is the surgical change; forcing this into continuation-gate.mjs's shape is not.
 *
 * THE MECHANISM, REUSED, NOT INVENTED:
 *   - Gate 1's regex: imported from ruvnet-gate1-pattern.mjs, the same copy
 *     grounding-turn-mark.mjs uses, proven byte-identical to ground-ruvnet.sh by
 *     tests/unit/ruvnet-gate1-pattern.test.mjs. This file does not re-test the prompt itself —
 *     Stop's payload carries no prompt text — it reads grounding-turn-mark.mjs's marker instead
 *     (see that file's header for why the split exists).
 *   - "was search_ruvnet called": the EXISTING evidence grounding-stamp.sh already produces —
 *     ~/.cache/ruvnet-brain/grounded/<term>, one file per product term, minted ONLY on a genuinely
 *     successful search (grounding-stamp.sh's own header: stamps mint ONLY on a successful grounded
 *     result). ground-before-write.sh already trusts this exact directory's file mtimes for its own
 *     24h freshness check; this file trusts the SAME directory the SAME way, just against a
 *     narrower window (since the marker's own mtime, not "20 hours ago", is the turn boundary).
 *     No second "was it searched" signal is invented — a search_ruvnet call this turn mints a stamp
 *     here exactly as it always has, for exactly the same reason (decision-gate's write gate).
 *   - The Stop block/continue contract: `{"hookSpecificOutput":{"hookEventName":"Stop",
 *     "additionalContext":"..."}}` on stdout, exit 0. This is not a new discovery — it is the exact
 *     contract continuation-gate.mjs already uses and this repo's own tests already prove works on
 *     BOTH hosts (tests/unit/codex-lifecycle-hooks.test.mjs, "translates the Claude Stop
 *     continuation envelope into Codex block plus reason" — codex-hook-adapter.mjs's Stop branch
 *     converts this exact envelope into Codex's `{decision:"block",reason}` wire shape). Blocking a
 *     Stop is genuinely supported here; this file exercises the already-proven path rather than
 *     asking a new question of the host.
 *
 * LOOP SAFETY: identical checks to continuation-gate.mjs (same reasons, same file) — only an
 * affirmatively-parsed `stdin` payload with a real `session_id` may force, `stop_hook_active` means
 * this stop episode has already been continued once and this gate stays silent, and an
 * interrupted/cancelled turn is never forced. The marker is consumed (deleted) whether or not it
 * fires, so a genuinely abandoned marker cannot pressure some unrelated later turn.
 *
 * FAILS OPEN ALWAYS. Exit 0 unconditionally — a gate that breaks a turn's completion because a
 * cache directory was unreadable would be disabled within a day.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinBounded } from './hook-input.mjs';
import { markerPathFor } from './grounding-turn-mark.mjs';

const HOME = os.homedir();
const EXIT_ALLOW = 0;

// Same directory grounding-stamp.sh writes and ground-before-write.sh reads — no env override in
// either of those (they are pure-bash, deliberately dependency-free per ADR-0021), so this reader
// must resolve the identical default for the two to ever agree. Tests isolate via HOME, exactly as
// tests/unit/codex-lifecycle-hooks.test.mjs already does for the rest of this hook family.
const GROUNDED_DIR = path.join(HOME, '.cache', 'ruvnet-brain', 'grounded');

/** Newest mtime (ms since epoch) among grounding-stamp.sh's product-term stamp files, or null if
 *  the directory is absent/empty/unreadable — never throws, this is a fail-open evidence read. */
export function newestGroundingStampMs(dir = GROUNDED_DIR) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  let newest = null;
  for (const name of entries) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      const ms = st.mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    } catch { /* a stamp that vanished mid-scan is not evidence either way */ }
  }
  return newest;
}

/** A little slack for filesystem mtime granularity (some filesystems round to whole seconds), so a
 *  stamp written the same wall-clock second as the marker is never wrongly judged "before" it. */
const SKEW_MS = 1500;

/** Pure decision: given the marker's mtime and the newest grounding stamp's mtime, was this turn's
 *  Gate-1 directive satisfied? Exported so the unit test can drive it without touching the
 *  filesystem or spawning a process. */
export function wasGroundedSince(markerMs, newestStampMs) {
  if (newestStampMs === null) return false;
  return newestStampMs >= markerMs - SKEW_MS;
}

async function readHookInput() {
  // Mirrors continuation-gate.mjs's own three-way source classification exactly (ADR-043 /
  // Fable #1): only a payload we actually parsed off stdin may ever force a continuation.
  if (process.stdin.isTTY) return { __source: 'tty' };
  try {
    const raw = (await readStdinBounded()).toString('utf8');
    return { ...JSON.parse(raw || '{}'), __source: 'stdin' };
  } catch { return { __source: 'unreadable' }; }
}

async function main() {
  const hookInput = await readHookInput();
  if (hookInput.__source !== 'stdin') process.exit(EXIT_ALLOW);
  if (hookInput.stop_hook_active) process.exit(EXIT_ALLOW);
  if (hookInput.hook_event_name !== 'Stop' || hookInput.interrupted || hookInput.cancelled) {
    process.exit(EXIT_ALLOW);
  }
  if (!hookInput.session_id) process.exit(EXIT_ALLOW);

  const marker = markerPathFor(hookInput.session_id);
  if (!marker) process.exit(EXIT_ALLOW);

  let markerStat;
  try { markerStat = fs.statSync(marker); } catch { process.exit(EXIT_ALLOW); }

  // Consume the marker unconditionally: whether this fires or not, it must never pressure a LATER,
  // unrelated turn (same reasoning as continuation-gate.mjs's cooldown lock, applied here as a
  // single-use marker instead of a timed window, because "did this turn ground itself" has no
  // meaningful reading beyond the one turn it was written for).
  try { fs.unlinkSync(marker); } catch { /* a marker that vanished between stat and unlink already told us what we needed */ }

  const grounded = wasGroundedSince(markerStat.mtimeMs, newestGroundingStampMs());
  if (grounded) process.exit(EXIT_ALLOW);

  const lines = [
    'This turn touched the RuvNet / rUv stack and ground-ruvnet\'s directive required calling the',
    'search_ruvnet MCP tool before asserting what any RuvNet tool can/cannot do — but no successful',
    'search_ruvnet call was recorded this turn (checked against the same grounding-stamp evidence',
    'ground-before-write.sh already trusts).',
    '',
    'Do NOT end the turn on an ungrounded rUv-domain answer. Call `search_ruvnet` now with the',
    'relevant product term(s) in the query, ground your answer in the cited source paths it returns,',
    'and correct anything you already asserted from memory. Training priors on the rUv stack are',
    'stale by construction (ADR-0012) — this is not a formality.',
  ];

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: lines.join('\n'),
    },
  }));
  process.exit(EXIT_ALLOW);
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
