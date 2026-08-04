#!/usr/bin/env node
/**
 * continuation-gate.mjs — the gate that fires on STOPPING, because nothing else can.
 *
 * THE HOLE THIS CLOSES, and it is a real architectural gap in ADR-030, not a missing feature.
 *
 * Every gate in this project fires on an ACTION: a Write, an Edit, a push, a claim, a status
 * report. That is what makes them enforceable — there is a tool call to intercept.
 *
 * **Stopping is the absence of an action.** When the model finishes a unit of work, writes a
 * summary, and waits — no tool fires, no text is classified, nothing is intercepted. The single
 * most costly failure of 2026-07-22 had NO TRIGGER, which is why a system explicitly built to
 * prevent it did not prevent it.
 *
 * The owner, 05:45, and it is the correct indictment: *"This was exactly the stuff that RuvNet-Brain
 * was designed to stop, so the fact that you didn't is yet another failure... you agree you are
 * going to finish something and you stop because you have some excuse, and then you don't start
 * yourself up again."*
 *
 * L13 was recorded and ratified an hour earlier and did not help, because it fires on
 * `report-status` — it can only catch a stop that ANNOUNCES itself. A silent stop is invisible to
 * every gate in the system.
 *
 * HOW THIS WORKS. A `Stop` hook runs when a turn ends. It reads the work ledger — a plain list of
 * committed-to items with a done state — and if authorized work remains unfinished, it says so, in
 * the last place the model looks before going quiet.
 *
 * WHAT IT DOES, verified against code.claude.com/docs/en/hooks.md (2026-07-23, not recalled, ADR-043):
 * a Stop hook's `additionalContext` at exit 0 DOES force a continuation — under the same loop
 * protections as decision:block (the `stop_hook_active` input + the 8-consecutive-continuation cap). An
 * earlier version of this header claimed "a Stop hook cannot force another turn"; that was wrong. The
 * gate still exits 0 always — continuation is driven by the envelope, never by a non-zero exit code.
 *
 * FAILS OPEN ALWAYS. Exit 0 unconditionally. A gate that breaks a turn's completion because it
 * could not read a JSON file would be disabled within a day, and a disabled gate protects nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readStdinBounded } from './hook-input.mjs';

const HOME = os.homedir();

// The only exit code this file may ever use. A Stop hook that exits non-zero refuses to let the turn
// end; this gate informs and never refuses, so every path below returns exactly this.
const EXIT_ALLOW = 0;
/**
 * PROJECT-SCOPED, because this runs machine-wide.
 *
 * The owner runs three projects simultaneously. A single global ledger would mix their commitments
 * and fire "you did not finish X" in a repo that never heard of X — which is a false alarm, and
 * ADR-028 fixes the false-alarm rate at ZERO. So the ledger is keyed by the git repo root (falling
 * back to cwd), stored centrally under ~/.config so it survives `--update`, but partitioned per
 * project so the three never see each other's work.
 */
function projectKey() {
  let dir = process.cwd();
  // Walk up to the git root — the stable identity of a project, regardless of which subdirectory
  // a hook happens to fire from. (A CWD-derived key was exactly the bug that scattered ledgers
  // through users' project trees in issue #36.)
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const up = path.dirname(dir);
    if (up === dir) { dir = process.cwd(); break; }
    dir = up;
  }
  return path.basename(dir).replace(/[^a-zA-Z0-9._-]/g, '_');
}

const LEDGER = process.env.RUVNET_WORK_LEDGER
  || path.join(HOME, '.config', 'ruvnet-brain', 'work-ledgers', `${projectKey()}.json`);

const argv = process.argv.slice(2);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const has = (f) => argv.includes(f);

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return Array.isArray(j.items) ? j : { items: [] };
  } catch { return { items: [] }; }
}
function save(led) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({ ...led, updated: new Date().toISOString() }, null, 2) + '\n');
  } catch { /* the ledger is advisory — never break a turn over it */ }
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────────
if (has('--commit-to')) {
  // Record work the model AGREED to do. The agreement is the thing that makes stopping a defect —
  // without it, ending a turn is simply finishing, and this gate must stay silent.
  const led = load();
  const text = arg('--commit-to');
  if (text && !led.items.some((i) => i.text === text && !i.done)) {
    led.items.push({ text, done: false, at: new Date().toISOString() });
    save(led);
  }
  console.log(`committed: ${text}`);
  process.exit(0);
}

if (has('--done')) {
  const led = load();
  const needle = arg('--done');
  // EXACT text match only (GPT-5.6-Sol review). The earlier "unambiguous substring" fallback could still
  // clear a SINGLETON open item via a fragment — a fake-completion valve under a gate that now applies real
  // continuation pressure. Marking done requires the item's exact text (copy it from the ledger line).
  const targets = led.items.filter((i) => !i.done && i.text === needle);
  for (const i of targets) { i.done = true; i.doneAt = new Date().toISOString(); }
  save(led);
  console.log(`marked done: ${targets.length}`);
  process.exit(0);
}

if (has('--clear')) { save({ items: [] }); console.log('ledger cleared'); process.exit(0); }

// ── the Stop hook itself (default action) ────────────────────────────────────────────────────────
/**
 * READ THE PAYLOAD. Every Stop hook receives a JSON object on stdin, and until 2026-07-22 this file
 * ignored it completely — which made the loop guard below not merely absent but UNREACHABLE.
 *
 * Never block waiting for stdin: the CLI paths (--commit-to / --done) are invoked from a terminal
 * with no piped input, and a gate that hangs is worse than a gate that is silent.
 */
async function readHookInput() {
  // Three cases, treated DIFFERENTLY (ADR-043, Fable red-team #1):
  //  - 'tty'        : run bare in a terminal, not as a hook → never force.
  //  - 'unreadable' : stdin present but read/parse FAILED. `fs.readFileSync(0)` throws EAGAIN
  //                   intermittently on macOS — a real footgun. The old code returned {} here, which
  //                   under a forcing gate LAUNDERS a read error into a fresh-stop verdict → a forced
  //                   loop. We must not force when we could not confirm the payload.
  //  - 'stdin'      : a payload we actually parsed → the only case allowed to force.
  if (process.stdin.isTTY) return { __source: 'tty' };
  try {
    const raw = (await readStdinBounded()).toString('utf8');
    return { ...JSON.parse(raw || '{}'), __source: 'stdin' };
  } catch { return { __source: 'unreadable' }; }
}
const hookInput = await readHookInput();

// LOOP-SAFETY 1 (ADR-043 / Fable #1) — only an affirmatively-parsed hook payload may force. A 'tty' or
// 'unreadable' source cannot be confirmed a fresh stop, so it never forces.
if (hookInput.__source !== 'stdin') process.exit(EXIT_ALLOW);

/**
 * LOOP-SAFETY 2 — the documented guard. `stop_hook_active` is true once Claude Code is already
 * continuing because of a stop hook (verified against code.claude.com/docs/en/hooks.md, ADR-043).
 * Honouring it caps each natural-stop episode at EXACTLY ONE forced continuation. Truthy, not
 * `=== true`, so a future string/number drift ("true", 1) cannot slip past into a loop.
 */
if (hookInput.stop_hook_active) process.exit(EXIT_ALLOW);

const led = load();
const nowMs = Date.now();

// LOOP-SAFETY 1b (GPT-5.6-Sol review) — an empty-but-parseable `{}` is NOT a real Stop payload; a genuine
// one carries `session_id` (a documented Stop input). Without it we cannot confirm a real stop, so we never
// force. This closes the empty-stdin hole that LOOP-SAFETY 1's `__source` check does not cover.
if (!hookInput.session_id) process.exit(EXIT_ALLOW);

/**
 * ARTIFACT-DERIVED OPEN WORK — the half that cannot be forgotten.
 *
 * WHY THIS EXISTS, measured rather than supposed. On 2026-08-04 the owner asked why the model had
 * gone back to stopping early, and the ledger answered: 25 items, ZERO open, last written 2026-07-25.
 * The gate had been structurally silent for ten days. Not broken — starved.
 *
 * The cause is the design, not the drift. Until now the ONLY source of "is work outstanding" was
 * `--commit-to`, i.e. the model noticing its own commitment and recording it. So the guard against
 * the model stopping early depended on the model remembering to arm it, and the failure mode is
 * silent in exactly the sessions where it matters most. That is this project's oldest rule broken
 * inside the mechanism meant to enforce it: status must be DERIVED FROM A VERIFIABLE ARTIFACT,
 * never asserted.
 *
 * So the gate now also reads work that exists whether or not anyone remembered to write it down.
 * `open-issues.json` is produced by the issue-watch pipeline against the real repo; an issue past
 * its response SLA is outstanding work by definition, and no amount of forgetting can erase it.
 *
 * Deliberately narrow: ONLY SLA breaches, never the full backlog — a permanently non-empty backlog
 * would make this fire forever, which is nagging, not enforcement. And only a FRESH observation
 * (<6h, the same window session-start-core uses), because a stale file is not evidence of anything.
 */
function artifactOpenWork() {
  try {
    const file = process.env.RUVNET_OPEN_ISSUES_FILE
      || path.join(HOME, '.cache', 'ruvnet-brain', 'open-issues.json');
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    const observedAt = Date.parse(status?.at || '');
    if (!Number.isFinite(observedAt) || nowMs - observedAt > 6 * 3600_000) return [];
    return (Array.isArray(status.issues) ? status.issues : [])
      .filter((issue) => issue?.breach)
      .map((issue) => ({
        text: `issue #${issue.number} on ${status.repo} is ${issue.ageHours}h past its response SLA — ${String(issue.title || '').slice(0, 80)}`,
        done: false,
        at: new Date(observedAt).toISOString(),
        derived: true,
      }));
  } catch { return []; }
}

const open = [...led.items.filter((i) => !i.done), ...artifactOpenWork()];
if (!open.length) process.exit(EXIT_ALLOW);   // nothing outstanding: silence is correct

/**
 * FRESHNESS (ADR-043 / Fable #3, tightened by GPT-5.6-Sol) — only FORCE for work with a VALID, recent
 * timestamp. A missing or unparseable `at` is treated as STALE and NOT forced: a real item always carries
 * an `at` (set by --commit-to), so only a malformed/legacy row lacks one, and forcing forever on an item of
 * UNKNOWN age is exactly the fabrication-pressure this guard exists to stop.
 */
// CORRECTED 2026-07-24, SAME DAY IT WAS INTRODUCED — and it had already broken the gate for ~30 hours.
//
// The guard above was written to stop "forcing forever on an item of UNKNOWN age." That intent is
// right and is preserved: a row with a missing or unparseable `at` is still refused, because an item
// of unknown age can nag forever with no evidence it is real.
//
// What shipped was different and wrong: `(nowMs - t) < 24h` ALSO discarded items with a perfectly
// VALID timestamp that were merely old. Measured on this machine: four genuinely-open commitments
// aged 53-56h, `forceable` came back empty, and the gate exited EXIT_ALLOW in silence. The owner's
// single most emphatic standing rule — "do not stop until it is done" — was enforced by a mechanism
// that had quietly switched itself off, and the only symptom was nothing happening.
//
// The inversion is the lesson: OLD OPEN WORK IS THE CASE THAT MOST NEEDS THE NUDGE. Work finished in
// an hour never reaches this gate. Work still open after two days is exactly what gets forgotten, and
// treating age as a reason for silence hands the failure mode a timer. It is the same shape as every
// other defect found today — silence standing in for a measurement — committed inside the guard whose
// whole job is to prevent stopping early.
//
// So: age no longer gates DELIVERY, it decorates it. An old item is still forced, and the nudge SAYS
// how old it is, which is information the reader needs rather than a reason to withhold. If a ledger
// is genuinely abandoned, the honest fix is to mark its items done — not to let a clock silently
// decide the commitment expired.
const forceable = open.filter((i) => Number.isFinite(Date.parse(i.at)));
if (!forceable.length) process.exit(EXIT_ALLOW);

/** Age, only ever used to LABEL an item — never to suppress one. See the note above. */
const ageLabel = (i) => {
  const h = (nowMs - Date.parse(i.at)) / 3_600_000;
  if (h < 1) return '';
  if (h < 24) return ` (committed ${Math.round(h)}h ago)`;
  return ` (committed ${Math.round(h / 24)}d ago — still open)`;
};

/**
 * LOOP-SAFETY 3 (belt-and-braces this file OWNS — Fable #1, made fail-closed + race-safe by the GPT-5.6-Sol
 * review). Claim the force ATOMICALLY via an exclusive-create lock that doubles as the cooldown marker:
 *   - a fresh lock (another force within COOLDOWN_MS, incl. a concurrent second Stop hook) → do NOT force;
 *   - the claim cannot be persisted → do NOT force (fail CLOSED — never a force we could not record);
 *   - exclusive create (`wx`) serialises two racing hooks so they can never both win.
 * This replaces a read-lastForcedAt-then-write that failed OPEN on a write error and let two hooks race.
 */
const COOLDOWN_MS = Number(process.env.RUVNET_CONTINUATION_COOLDOWN_MS ?? 20000);
const LOCK = LEDGER + '.cooldown';
function claimCooldown(now, windowMs) {
  try {
    const prev = Date.parse(fs.readFileSync(LOCK, 'utf8'));
    if (Number.isFinite(prev) && (now - prev) < windowMs) return false; // fresh lock: someone forced recently
    fs.unlinkSync(LOCK);                                                 // stale: clear it so we can re-claim
  } catch { /* no lock yet */ }
  try { fs.writeFileSync(LOCK, new Date(now).toISOString(), { flag: 'wx' }); return true; }
  catch { return false; }                                               // lost the race / cannot persist → fail closed
}
if (!claimCooldown(nowMs, COOLDOWN_MS)) process.exit(EXIT_ALLOW);

/**
 * DELIVERY. `additionalContext` in a Stop envelope forces the continuation (same protection as
 * decision:block). Directive copy — continue, do not look for an exit.
 */
const lines = [
  'You have unfinished work you committed to. Do NOT end the turn — continue now.',
  'Pick the highest-leverage open item below and make real progress on it this turn. Stop only when',
  'EVERY item is genuinely done or blocked; if one is blocked, say why in a single line and move to',
  'the next — never stop on the first obstacle, and never manufacture a reason to go quiet.',
  '',
  // Age is LABELLED, never used to suppress — an item open for days is the one most worth naming.
  ...forceable.slice(0, 8).map((i) => `  ☐ ${i.text}${ageLabel(i)}`),
  ...(forceable.length > 8 ? [`  … and ${forceable.length - 8} more`] : []),
  '',
  'Mark each item done as you complete it:  node plugin/scripts/continuation-gate.mjs --done "<exact item text>"',
  // THE HONEST EXIT, and it is what makes forcing old items safe.
  //
  // Fable's red-team #3 was right that a stale item pressuring every turn "breeds
  // mark-done-without-doing". The first answer to that was a 24h TTL — which silently disabled the
  // gate on genuine multi-day work (measured 2026-07-24: four real commitments, 53-56h old, gate mute
  // for ~30 hours). Both failure modes are real, and they are not opposites: the pressure to fake a
  // completion comes from being nagged with NO LEGITIMATE WAY OUT.
  //
  // So the resolution is neither silence nor endless nagging: keep forcing, and name the honest
  // disposal out loud. An item that is genuinely dead gets cleared — a deliberate, recorded act —
  // instead of expiring on a timer nobody sees, or being falsely marked done to stop the noise.
  ...(forceable.some((i) => (nowMs - Date.parse(i.at)) > 24 * 3_600_000)
    ? ['', 'Some of these are days old. If one is genuinely no longer real, say so and CLEAR it —',
       'that is a legitimate answer and the right one. What is never acceptable is marking it done',
       'without doing it, or letting it age quietly out of view.']
    : []),
];

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'Stop',            // must name the firing event or the envelope is discarded
    additionalContext: lines.join('\n'),
  },
}));

// Exit 0 regardless. This gate informs at the boundary; it never breaks the turn.
process.exit(EXIT_ALLOW);
