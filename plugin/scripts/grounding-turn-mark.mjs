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
import { ruvnetGate1Matches, groundingScopeMatches, groundingSubjectAllowed, normalizeGroundingScope, mergeGroundingScopes } from './ruvnet-gate1-pattern.mjs';
import { randomUUID } from 'node:crypto';
import { loadSettings, writeAtomic } from './user-settings.mjs';
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
export function shouldMark(hookInput, scope = 'all') {
  return eligible(hookInput) && groundingScopeMatches(promptOf(hookInput), scope);
}

/** Both arms for one prompt, or null when neither fires. Pure apart from the vocabulary it is given. */
export function armFor(hookInput, vocab = [], scope = 'all') {
  if (!eligible(hookInput)) return null;
  // Silent audit arm also covers an excluded topic whose answer introduces a selected product.
  const gate1 = ruvnetGate1Matches(promptOf(hookInput));
  const c = classifyPrompt(promptOf(hookInput), vocab);
  c.subjects = c.subjects.filter((subject) => groundingSubjectAllowed(subject, scope));
  if (!c.subjects.length) c.assert = c.architecture = false;
  if (!gate1 && !c.assert) return null;
  return { gate1, assert: c.assert, architecture: c.architecture, subjects: c.subjects, groundingScope: normalizeGroundingScope(scope).value };
}

export const STALE_MS = 2 * 3600_000;
/** A marker's JSON, or null. Old markers (no `gate1` field) were only ever written for Gate 1. */
function exists(file) { try { return !!fs.lstatSync(file); } catch (e) { return e.code !== 'ENOENT'; } }
function latches(file) {
  const base = path.basename(file);
  try { return fs.readdirSync(path.dirname(file)).filter((n) => n === `${base}.all` || n.startsWith(`${base}.all-`)).map((n) => path.join(path.dirname(file), n)); }
  catch (e) { return e.code === 'ENOENT' ? [] : null; }
}
const conservativeArm = () => ({ gate1: true, assert: true, architecture: false, subjects: [], groundingScope: 'all' });
export function readMarker(file, { locked = false } = {}) {
  const flags = latches(file);
  const uncertain = flags === null || flags.length > 0 || (!locked && exists(`${file}.lock`));
  try {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) return conservativeArm();
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || typeof m !== 'object') return conservativeArm();
    return { gate1: uncertain || m.gate1 !== false, assert: !!m.assert, architecture: !!m.architecture,
      groundingScope: uncertain ? 'all' : normalizeGroundingScope(m.groundingScope ?? 'all').value,
      subjects: Array.isArray(m.subjects) ? m.subjects.map(String) : [], at: m.at };
  } catch (e) { return uncertain || e.code !== 'ENOENT' ? conservativeArm() : null; }
}

/** An exclusive-create lock, without unsafe stale takeover or unlocked writes. */
function markerLock(file, fn) {
  const lock = `${file}.lock`, token = randomUUID();
  let fd;
  try {
    fd = fs.openSync(lock, 'wx', 0o600); fs.writeSync(fd, token);
  } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch {} return { ok: false }; }
  const owns = () => {
    try { const st = fs.lstatSync(lock); return st.isFile() && !st.isSymbolicLink() && fs.readFileSync(lock, 'utf8') === token; }
    catch { return false; }
  };
  try { return { ok: true, value: fn(owns) }; }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { if (owns()) fs.unlinkSync(lock); else failSafeArm(file); }
    catch { failSafeArm(file); }
  }
}

/** A monotonic exclusive latch: a delayed narrow commit cannot erase an all obligation. */
function failSafeArm(file) {
  const arm = conservativeArm();
  try { fs.writeFileSync(`${file}.all-${randomUUID()}`, 'all\n', { flag: 'wx', mode: 0o600 }); } catch { /* existing/unwritable => conservatively read */ }
  // Never overwrite a held writer. If no marker exists yet, publish a conservative one exclusively.
  try { fs.writeFileSync(file, JSON.stringify(arm) + '\n', { flag: 'wx', mode: 0o600 }); } catch {}
  return arm;
}

/** Stat/read/merge/atomic publication/mtime belong to one exclusive owner. */
export function writeArm(file, arm, meta = {}, now = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let held;
  try {
    held = markerLock(file, (owns) => {
      let st = null;
      try { st = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const prior = readMarker(file, { locked: true });
      const prev = prior && (!st || now - st.mtimeMs < STALE_MS) ? prior : null;
      const next = prev ? { ...meta, at: prev.at, gate1: prev.gate1 || arm.gate1, assert: prev.assert || arm.assert,
        architecture: prev.architecture || arm.architecture, groundingScope: mergeGroundingScopes(prev.groundingScope, arm.groundingScope),
        subjects: [...new Set([...prev.subjects, ...arm.subjects])].slice(0, 32) }
        : { ...meta, at: new Date(now).toISOString(), ...arm };
      if (!owns()) throw new Error('marker owner changed');
      const staged = `${file}.staged-${randomUUID()}`;
      try {
        writeAtomic(staged, JSON.stringify(next) + '\n');
        if (!owns()) throw new Error('marker owner changed before commit');
        fs.renameSync(staged, file);
      } finally { try { fs.unlinkSync(staged); } catch {} }
      if (prev && st && owns()) fs.utimesSync(file, st.atime, st.mtime);
      return next;
    });
  } catch { return failSafeArm(file); }
  return held.ok ? readMarker(file) : failSafeArm(file);
}

/** Stop reads and consumes the same episode under the same exclusive protocol. */
export function consumeMarker(file) {
  // No episode directory is ordinary silence, not a lock failure or a grounding obligation.
  try { fs.lstatSync(path.dirname(file)); } catch (e) { if (e.code === 'ENOENT') return null; }
  let held;
  try {
    held = markerLock(file, (owns) => {
      const observedLatches = latches(file);
      if (observedLatches === null) throw new Error('marker latch read failed');
      const marker = readMarker(file, { locked: true });
      if (!marker) return null;
      let markerMs = Date.now();
      try { markerMs = fs.lstatSync(file).mtimeMs; } catch {}
      // Suspicious sidecars remain in place; never follow or retire their targets.
      if (observedLatches.some((flag) => fs.lstatSync(flag).isSymbolicLink())) return { marker: conservativeArm(), markerMs };
      if (!owns()) throw new Error('marker owner changed');
      if (exists(file)) fs.unlinkSync(file);
      // Consume only witnessed latches; a contender publishes a new unique obligation.
      for (const flag of observedLatches) fs.unlinkSync(flag);
      return { marker, markerMs };
    });
  } catch { failSafeArm(file); return { marker: conservativeArm(), markerMs: Date.now() }; }
  if (!held.ok) { failSafeArm(file); return { marker: conservativeArm(), markerMs: Date.now() }; }
  return held.value;
}

async function main() {
  let hookInput;
  try {
    const raw = (await readStdinBounded()).toString('utf8');
    hookInput = JSON.parse(raw || '{}');
  } catch { process.exit(0); }

  let arm = null;
  const scope = loadSettings().values.groundingScope;
  try { arm = armFor(hookInput, loadVocabulary(), scope); } catch { arm = shouldMark(hookInput, scope) ? { gate1: true, assert: false, architecture: false, subjects: [], groundingScope: scope } : null; }
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
