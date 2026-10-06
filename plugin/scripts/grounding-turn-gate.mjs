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
 *     UPDATE (H1 / GitHub #316): per-product term files alone under-reported "was it searched" —
 *     grounding-stamp.sh used to recognise only a 9-term write-gate vocabulary that omitted `ruvnet`
 *     itself (and every other Gate-1 term), so a search literally about "ruvnet" minted nothing and
 *     this gate wrongly fired. grounding-stamp.sh now also writes a vocabulary-independent
 *     `.any-search` marker into this SAME directory on every successful search regardless of query
 *     content, so newestGroundingStampMs below (which already scans every file, by name-agnostic
 *     design) sees it with no code change needed here — a search_ruvnet call this turn always mints
 *     evidence here now, not only when its query happens to name a recognised product.
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
 * 2026-09-30 — ADR-0030 DECISION POINT #1, AND THE FALSE ALARM. Two changes, one registration:
 *   - On Claude the "was search_ruvnet called" question is answered from the TRANSCRIPT (the ordered
 *     record of every tool call and result, grounding-turn-evidence.mjs turnSources), not from stamp
 *     mtimes. The stamp was a lossy proxy: 7 real false alarms were measured, 3 from a queued
 *     mid-turn prompt re-dating the marker (fixed in grounding-turn-mark.mjs), 3 pre-H1 vocabulary
 *     misses, 1 successful search whose stamp never minted. Codex's rollout is not parsed anywhere in
 *     this repo, so Codex keeps the stamp evidence.
 *   - When the marker says the prompt asked a capability/feasibility/architecture question, every
 *     capability claim in the final answer needs a RELEVANT, STRONG source read this turn after the
 *     last weak one (auditAssertions). A WebFetch body is a small model's summary: weak.
 *   Gates #2/#3 of ADR-0030 run in shadow (logShadow) — measured, never delivered.
 *   At most ONE correction per stop episode: both checks compose into one message, and
 *   stop_hook_active silences the continued stop.
 *
 * 4.4.0 — GATE 1 FIRES ON A CLAIM, NOT ON A TOPIC. Gate 1 arms on any prompt that names the rUv
 * stack, and in this repository that is nearly every prompt. Replayed through this decide() on 183
 * real deliveries of the correction (the owner's sessions, 2026-09-12..10-01): 172 were on answers
 * that asserted nothing about a rUv tool (release status, git/CI, disk/backup, memory writes). Now a
 * search is demanded only when the final answer asserts a rUv capability (ruvCapabilityClaims);
 * measured on a held-out set of 70 real Stop points: false positives 68/68 -> 0/68, and 2 borderline
 * claims (copula, parenthetical) are missed — tests/unit/grounding-turn-false-alarm.test.mjs.
 * A LONG turn (the transcript tail cannot see its start) falls back to the stamps, never to a pass.
 *
 * FAILS OPEN ALWAYS. Exit 0 unconditionally — a gate that breaks a turn's completion because a
 * cache directory was unreadable would be disabled within a day.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groundingSubjectAllowed } from './ruvnet-gate1-pattern.mjs';
import { readStopHookInput } from './hook-input.mjs';
import { markerPathFor, consumeMarker } from './grounding-turn-mark.mjs';
import { readSettledTranscript } from './turn-outcome-capture.mjs';
import {
  architectureShadow, auditAssertions, correctionText, describeSources, loadVocabulary, logShadow,
  relayShadow, ruvCapabilityClaims, searchedThisTurn, turnSources,
} from './grounding-turn-evidence.mjs';

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

/** Product terms whose stamp was minted at or after `sinceMs` (Codex's only view of this turn's searches). */
export function stampTermsSince(sinceMs, dir = GROUNDED_DIR) {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.')
      && fs.statSync(path.join(dir, name)).mtimeMs >= sinceMs - SKEW_MS);
  } catch { return []; }
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

/**
 * The whole Stop decision for one armed turn: the correction text, or null. Exported so tests can
 * drive it with a synthetic transcript. Every failure inside returns null (fail open).
 */
export function decide({ hookInput, marker, markerMs, env = process.env, read = readSettledTranscript }) {
  try {
    const host = env.RUVNET_HOOK_HOST === 'codex' ? 'codex' : 'claude';
    const tp = hookInput.transcript_path;
    let turn = null;
    if (host === 'claude' && typeof tp === 'string' && /\.jsonl$/i.test(tp)) {
      try { turn = turnSources(read(tp, { maxMs: 0 })); } catch { turn = null; }
    }
    // The transcript is read as a bounded TAIL. When the turn's opening prompt is not inside it
    // (a long turn), the tail is a suffix of the turn and cannot prove a search did NOT happen
    // earlier — so it is not evidence either way. Fall back to the stamp evidence (the same path
    // Codex uses), never to a silent pass: `return null` here let every long turn skip the gate.
    if (turn && !turn.boundaryFound) turn = null;
    const sources = turn ? turn.sources : null;
    const message = String(hookInput.last_assistant_message || '');

    let assertion = null;
    if (marker.assert && message) {
      const vocab = loadVocabulary({ env });
      const audit = auditAssertions({ message, subjects: marker.subjects, vocab, sources,
        stampTerms: sources ? [] : stampTermsSince(markerMs),
        subjectAllowed: (subject) => groundingSubjectAllowed(subject, marker.groundingScope) });
      if (audit.findings.length) assertion = audit.findings;
      const shadow = [architectureShadow({ architecture: marker.architecture, message }), relayShadow({ message, sources })].filter(Boolean);
      for (const row of shadow) logShadow({ ...row, at: new Date().toISOString(), session: hookInput.session_id, host });
    }

    // Gate 1 demands a search only when the answer ASSERTS what a rUv product does (the directive's
    // own words). A status report, git/CI check or memory write on a rUv-named repo asserts nothing.
    const ruvClaims = marker.gate1 === false ? [] : ruvCapabilityClaims(message).filter((claim) => groundingSubjectAllowed(claim.subject, marker.groundingScope));
    const grounded = !ruvClaims.length
      || (sources ? searchedThisTurn(sources) : wasGroundedSince(markerMs, newestGroundingStampMs()));
    if (assertion) {
      return correctionText(assertion) + (grounded ? '' : '\nThis turn also asserted what a rUv tool does and no successful search_ruvnet call was recorded: call it with the product term(s).');
    }
    if (grounded) return null;
    return [
      `You asserted "${ruvClaims[0].text.slice(0, 200)}" about ${ruvClaims[0].subject}`
        + (ruvClaims.length > 1 ? ` (and ${ruvClaims.length - 1} more rUv capability claim(s))` : '') + ', and',
      'ground-ruvnet\'s directive requires calling the search_ruvnet MCP tool before asserting what any',
      'RuvNet tool can/cannot do — but no successful',
      sources ? `search_ruvnet call is in this turn's transcript (read this turn: ${describeSources(sources).join('; ')}).`
        : 'search_ruvnet call was recorded this turn (checked against the grounding-stamp evidence).',
      '',
      'Do NOT end the turn on an ungrounded rUv-domain answer. Call `search_ruvnet` now with the',
      'relevant product term(s) in the query, ground your answer in the cited source paths it returns,',
      'and correct anything you already asserted from memory. Training priors on the rUv stack are',
      'stale by construction (ADR-0012) — this is not a formality.',
    ].join('\n');
  } catch { return null; }
}


async function main() {
  const hookInput = await readStopHookInput();
  if (hookInput.__source !== 'stdin') process.exit(EXIT_ALLOW);
  if (hookInput.stop_hook_active) process.exit(EXIT_ALLOW);
  if (hookInput.hook_event_name !== 'Stop' || hookInput.interrupted || hookInput.cancelled) {
    process.exit(EXIT_ALLOW);
  }
  if (!hookInput.session_id) process.exit(EXIT_ALLOW);

  const marker = markerPathFor(hookInput.session_id);
  if (!marker) process.exit(EXIT_ALLOW);

  const episode = consumeMarker(marker);
  if (!episode) process.exit(EXIT_ALLOW);
  const text = decide({ hookInput, marker: episode.marker, markerMs: episode.markerMs });
  if (!text) process.exit(EXIT_ALLOW);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: text,
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
