// user-settings.mjs — how THIS user wants the brain to behave, stored where an update cannot eat it.
//
// THE ONE IDEA. Everybody uses this differently: some people want it to learn across every repo they
// own, some want it to forget the moment they leave the directory, some want it to act, most want it
// to shut up unless something is actually wrong. None of those are wrong, so none of them can be
// hardcoded — but "make it configurable" is where products usually go murky, because a settings model
// with vague labels and optimistic defaults is worse than no settings at all: the user believes they
// are in control while the machine does something else.
//
// So this file holds three invariants, and each exists because of a specific way this project has
// already been burned:
//
//   1. NOTHING THAT ACTS BEYOND THE CURRENT PROJECT MAY DEFAULT TO ON. Encoded as `escalates` per
//      entry — a machine-checkable list of the values that write outside the directory you invoked us
//      in. The default is asserted, by test, never to be one of them. This is the same move as
//      lesson-store.makeLesson() and console-engine.makeRecommendation(): put the invariant in the
//      type, not in a reviewer's memory, because a reviewer forgets and a constructor does not.
//
//   2. EVERY SETTING STATES ITS DOWNSIDE. `whyItMatters` explains the tradeoff and `downside` names
//      the concrete cost of turning it up — required fields, both. A settings page that lists only
//      benefits is a sales page, and it makes the safe choice feel like the timid one. If we cannot
//      articulate what turning something on costs the user, we have not understood it well enough to
//      offer it.
//
//   3. A SETTING DESTROYED BY AN UPDATE IS NOT A SETTING. Hence the storage location below, which is
//      a checked fact rather than a hopeful one — see STORE_PATH.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO. It does not execute anything. It records intent and hands
// back a validated object. Whether a given intent is HONOURED is the caller's job to prove, and per
// house rule 2 a console must not render one of these as a live toggle until it has a real executor
// and a real undo behind it — otherwise we have built a light switch wired to nothing, which is the
// most expensive kind of lie because the user stops looking for the real problem.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

/**
 * WHERE IT LIVES, and why this exact directory — verified against bin/install.mjs, not assumed.
 *
 * `--update` extracts a fresh bundle and overwrites the cache directory entry-by-entry with
 * `fs.rmSync(to, { recursive: true, force: true })` (install.mjs:410); `--uninstall` rmSync's the
 * whole kb dir (install.mjs:1526). Anything under ~/.cache/ruvnet-brain is therefore transient by
 * design. Grepping install.mjs for `.config/ruvnet-brain` returns ZERO hits — the installer has no
 * code path that reads, writes, or deletes here at all.
 *
 * That is the entire argument for this path: not "it feels more permanent", but "the only program
 * that deletes things cannot see it". Same reasoning, same directory, as lesson-store.STORE_PATH —
 * a preference that does not survive the next release never compounds, and compounding is the point.
 *
 * Env override matches the RUVNET_LESSON_STORE idiom so tests never touch the real user's file.
 */
export const STORE_PATH = process.env.RUVNET_SETTINGS_FILE
  || path.join(HOME, '.config', 'ruvnet-brain', 'settings.json');

/** Bumped only when the on-disk shape changes incompatibly. Unknown/newer versions degrade to defaults. */
export const SETTINGS_VERSION = 1;

/**
 * THE SCHEMA.
 *
 * `escalates` is the load-bearing field and the reason this is a data structure rather than four
 * `if` statements: it lists the values of this setting that cause work OUTSIDE the project you are
 * standing in. A value in `escalates` may be chosen, but may never be the default, and a test asserts
 * exactly that. It also gives the console something honest to render — "this one reaches past this
 * repo" is the sentence a user actually needs before clicking.
 *
 * `type` reuses the vocabulary already in onboarding-console.mjs CONFIG_SCHEMA ('enum' | 'bool') so a
 * single renderer can handle both schemas without a translation layer.
 *
 * `options` for enums are ordered LEAST active → MOST active. That ordering is not cosmetic: it is
 * what makes "conservative" mean something checkable rather than a claim in a comment.
 */
export const SETTINGS_SCHEMA = Object.freeze([
  Object.freeze({
    key: 'brainEnabled',
    label: 'Is the brain switched on',
    type: 'bool',
    default: true,
    // NOT an escalation in either direction. `escalates` lists values that cause work OUTSIDE the
    // project you are standing in, and this setting only ever REMOVES work: false stops retrieval,
    // stops the advocacy hooks and stops the learning capture. true is the shipped state every
    // existing install is already in, so it cannot be the value that "reaches past this repo".
    escalates: Object.freeze([]),
    help: 'Whether the brain is working at all — retrieval, grounding hooks and everything it volunteers.',
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    // THIS KEY IS A MIRROR, NOT THE SWITCH (ADR-054 §2). Read scripts/brain-state.mjs before
    // wiring anything to it.
    //
    // The enforcement artifact is the sentinel file ~/.config/ruvnet-brain/brain-off. This entry
    // exists so the choice is VISIBLE where a user goes looking for their choices, and so the
    // console has something to render — but nothing enforces off by reading this value, and nothing
    // ever should. The reason is mechanical and was measured, not theorised: validate() below DROPS
    // unknown keys, so any older release that saves ANY setting deletes this one and the machine
    // silently comes back on. tests/unit/brain-off.test.mjs reproduces that exact sequence and
    // asserts the sentinel survives it.
    //
    // Consequence for callers: when this value and the sentinel disagree, the SENTINEL is in force.
    // brain-state.disagreement() returns the fact so a surface can show it rather than pick a side.
    // ─────────────────────────────────────────────────────────────────────────────────────────────
    whyItMatters: 'On, the brain retrieves from rUv\'s real source before answering, and its hooks watch the write path. Off, it stops retrieving, stops volunteering, and stops learning from your work — the machine is quiet and answers about the RuvNet stack come from the model\'s own memory instead of from source. The switch is a file, so it survives updates and both states are readable by every part of the product at once.',
    downside: 'Off, answers about rUv\'s ecosystem are no longer grounded in his source and nothing warns you when they drift, the write-path grounding gate stops enforcing, and nothing is learned from this or any later session until you switch it back on. Updates and health alarms keep running while it is off, which the console states plainly rather than hiding.',
  }),

  Object.freeze({
    key: 'brainProfile',
    label: 'How much of the brain is installed',
    type: 'enum',
    options: Object.freeze(['complete', 'ruvector']),
    default: 'complete',
    escalates: Object.freeze([]),
    help: 'Complete Brain searches every installed public rUv repository. RuVector Only keeps and searches only RuVector.',
    whyItMatters: 'RuVector Only uses substantially less disk and searches a much smaller corpus. Complete Brain can answer cross-repository questions and find supporting evidence outside RuVector.',
    downside: 'RuVector Only deliberately removes the other repository stores, so answers cannot cite supporting evidence that lives in Ruflo, AgentDB, RuView, meeting notes, or another rUv repository. Switching back restores them from the complete bundle.',
  }),

  Object.freeze({
    key: 'learningScope',
    label: 'What it learns from',
    type: 'enum',
    options: Object.freeze(['off', 'project', 'user']),
    default: 'project',
    escalates: Object.freeze(['user']),
    help: 'Whether what it learns stays in this project, compounds across every project you own, or is not kept at all.',
    // DEFAULT = 'project', and this is the one default worth defending at length, because 'off' is
    // technically more conservative and I did not choose it.
    //
    // The rule is "nothing that changes the MACHINE defaults to on". 'project' writes only into the
    // directory you deliberately invoked us in — the same place your source, your .git and your
    // node_modules already live. It changes nothing outside your own repo, so it does not engage the
    // rule. 'user' does: a lesson learned in one client's repo would surface while you work in
    // another's, which is a data-flow decision only the user can make, so it is opt-in.
    //
    // Defaulting the whole thing to 'off' would be conservatism theatre: memory would be silently
    // absent, the console would truthfully report an empty store, and the user would conclude the
    // product does not work rather than that they never switched it on.
    whyItMatters: 'Project scope keeps everything it learns inside this repo, which is the narrowest setting where the thing still works at all. User scope is where it gets genuinely useful — a mistake corrected once is never repeated anywhere — but it means notes taken while working on one codebase can surface while you are working on a different one.',
    downside: 'On "user", context crosses between unrelated projects: a client repo can teach the model something that shows up while you work for a different client. On "off", nothing is remembered between sessions and you will re-explain the same preferences indefinitely.',
  }),

  Object.freeze({
    key: 'managedMemoryBoundary',
    label: 'Direct access to managed memory stores',
    type: 'enum',
    options: Object.freeze(['advise', 'read-only', 'block']),
    default: 'advise',
    escalates: Object.freeze(['read-only', 'block']),
    help: 'Whether a direct sqlite3 call against a Ruflo-managed AgentDB store is merely advised against, refused when it would WRITE, or refused outright.',
    // ADR-063, issue #103. The reporter measured a long Codex session in which 59 shell calls went
    // straight at memory stores: the Brain prevented NONE, and 49 did not even ask for read-only.
    // The advisory was neutered five independent ways (hijack-ruvnet's hardcoded `defer`, the shim's
    // advisory mode, `|| true` on the registration, the Codex adapter deleting permissionDecision,
    // and the 1–5 dial being speech-only) — each sufficient on its own, so fixing any one changed
    // nothing.
    //
    // WHY THIS IS ITS OWN SETTING AND NOT THE 1–5 DIAL. ADR-040 scopes that dial to SPEECH and
    // user-settings says so at the `advocacy` entry below: "no value of this setting writes anything
    // anywhere". Someone who picked "Maximum help" asked to be TALKED to more. Turning a verbosity
    // preference into a command-authorization preference is the kind of surprise that makes people
    // distrust every other control on the page — and the reporter names exactly that confusion as
    // part of the defect.
    //
    // WHY THE DEFAULT IS `advise`. The rule at the top of this file: nothing that acts beyond the
    // current project may default to on. Both other values REFUSE a command the user typed, and
    // this repo has already shipped three gates that could never pass (the RVF byte-compare,
    // EXPECTED_VERSION, the colorized `Test Files` grep). An unsatisfiable gate that nags is a
    // nuisance; one that BLOCKS is an outage. `escalates` lists both non-default values, so the
    // existing test forbidding an escalating default binds this automatically — no new machinery.
    whyItMatters: 'Ruflo owns these stores. Reading one directly is usually harmless and occasionally necessary; writing one behind Ruflo\'s back is how two writers end up on one file and a store gets corrupted. "Read-only" is the setting that matches what most people actually want: look freely, never write.',
    downside: 'On "read-only" or "block", a legitimate direct query you intended can be refused, and you will have to route it through `ruflo memory` or change this setting back. On "advise" — the default — nothing is ever refused and the boundary is a suggestion only.',
  }),

  Object.freeze({
    key: 'advocacy',
    label: 'How much it jumps in',
    type: 'enum',
    options: Object.freeze([1, 2, 3, 4, 5]),
    default: 3,
    escalates: Object.freeze([]),   // speech only — no value of this setting writes anything anywhere
    // 1–5 DIAL (ADR-052, owner 2026-07-25: "a setting from 1 to 5 on how aggressive you want it to be
    // to support you"). The runtime — plugin/scripts/unprompted-runtime.mjs, the SINGLE enforcement
    // chokepoint (DDD-0004) — maps a level to {advocacy channel on/off, promotion channel on/off,
    // severity floor}. No producer decides. DEFAULT = 3 (Balanced): advocacy on for relevant findings,
    // promotion off — byte-identical to the old 'important-only' default, so nobody's behaviour changes
    // on upgrade.
    //
    // LEGACY MIGRATION: pre-dial string values map to their nearest level rather than being rejected
    // and silently reset to default (which would lose a real choice). off→1, important-only→3, all→4.
    legacy: Object.freeze({ 'off': 1, 'important-only': 3, 'all': 4 }),
    // Each level, named + what it ACTUALLY changes (kept honest against the runtime's LEVEL_POLICY; if
    // that map changes, this copy changes with it). Levels 4–5 additionally enable the promotion
    // channel — offers to promote lessons learned across your projects — which is also what lets the
    // outcome ledger fill from users who opted into more help (ADR-052).
    levels: Object.freeze({
      1: { name: 'Only when I ask', what: 'Nothing unprompted — the brain speaks only when you open the console or run a command. Genuine failure alarms still reach you.' },
      2: { name: 'Critical only', what: 'Unprompted only for high-severity findings (a corrupt store, a failing job). No routine suggestions, no lesson-promotion nudges.' },
      3: { name: 'Balanced', what: 'High-confidence suggestions relevant to what you are doing, plus anything critical. No lesson-promotion nudges. The recommended default.' },
      4: { name: 'Proactive', what: 'Everything in Balanced, plus offers to promote lessons it has learned across your projects to your global brain.' },
      5: { name: 'Maximum help', what: 'The most forward: it also surfaces more loosely-relevant capabilities and optimizations. Best when you want it to teach you the stack.' },
    }),
    help: 'How much the brain jumps in unprompted, on a 1–5 dial (3 = Balanced, the default). It governs unsolicited capability advocacy and lesson-promotion nudges; genuine failure alarms are never gated by it, and named lessons carry their own controls.',
    // This dial governs the advocacy + promotion channels, enforced centrally in the runtime. It is NOT
    // a master mute: named lessons (ratification + blocking-optin.json + RUVNET_LESSON_MAX_SHOWS) and
    // the Markdown grounding stamp (RUVNET_MD_STAMP) are separate channels with their own controls, and
    // a genuine failure alarm bypasses the dial at every level by design.
    whyItMatters: '1–5, from "only when I ask" to "maximum help". You set how forward the brain is; it records whether you act on what it offers, so it can prove it is helping rather than nagging. Higher levels offer more (and generate more of that feedback); lower levels stay quiet. Failure alarms reach you at every level, and named lessons are a separate channel with its own controls.',
    downside: 'At 1 the brain never volunteers anything (alarms aside) — help only when you ask. At 2 it offers only high-severity findings; at 3 (default) also the clearly-relevant ones; at 4–5 it additionally nudges you to promote learned lessons and surfaces more optional capabilities. If a level feels too forward, dial it down — the change takes effect immediately, machine-wide. There is no level at which it hides a genuine failure, and this dial never touches named lessons or the md-stamp, which have their own controls.',
  }),

  Object.freeze({
    key: 'autoApply',
    label: 'May it act on its own',
    type: 'bool',
    default: false,
    escalates: Object.freeze([true]),
    help: 'Whether it may apply a fix itself, or must always stop and ask you first.',
    // DEFAULT = false, and this is the least negotiable default in the file. The executors this would
    // unlock are real machine changes — reindexing stores, flushing and training on learning data,
    // rewriting settings files. Every one of them is reversible today, which is exactly why it is
    // tempting to default it on, and exactly the wrong reason: "we can undo it" is not consent.
    //
    // The user must be able to describe their machine without reading a changelog. Anything that
    // edits it while they are not looking breaks that, no matter how good the edit was.
    whyItMatters: 'Off, it can only ever propose — you read the change and click it yourself, so the machine is never modified without you present. On, routine fixes stop needing your attention, which matters if you are running long sessions unattended.',
    downside: 'On, your machine changes while you are not watching. Each change is backed up and reversible, but you will find your setup different from how you left it and have to read a log to learn why.',
  }),

  Object.freeze({
    key: 'newProjectDefaults',
    label: 'Apply these choices to new projects',
    type: 'bool',
    default: false,
    escalates: Object.freeze([true]),
    help: 'Whether these same answers are reused automatically the next time you open a project that has never been set up.',
    // DEFAULT = false. Turning this on means writing configuration into directories the user has not
    // opened yet and never opted in for — a mutation whose blast radius is "every repo I touch from
    // now on". That is precisely the shape of change that must be chosen out loud.
    //
    // Note the honest asymmetry: enabling this is a convenience for someone who has already decided
    // how they like to work. It is a trap for someone still deciding, because a preference set once,
    // early, silently becomes the policy for everything they do afterwards.
    whyItMatters: 'Off, every new project starts neutral and asks you once. On, you answer these questions a single time and every future project inherits them, which is the difference between setting this up once and setting it up forty times.',
    downside: 'On, a choice you made early — possibly before you understood it — is silently applied to projects you have not created yet, including ones where it is the wrong choice. You will not be asked again, so a bad default propagates quietly.',
  }),
]);

const BY_KEY = new Map(SETTINGS_SCHEMA.map((s) => [s.key, s]));

/** The shipped answer for every key. Callers get a fresh object — the schema itself stays frozen. */
export function defaults() {
  return Object.fromEntries(SETTINGS_SCHEMA.map((s) => [s.key, s.default]));
}

/** Does this value reach outside the project you are standing in? The question a console must render. */
export function escalatesBeyondProject(key, value) {
  const entry = BY_KEY.get(key);
  return entry ? entry.escalates.includes(value) : false;
}

/**
 * VALIDATE — total, never throws, and always returns a COMPLETE settings object.
 *
 * Total on purpose. This reads a file the user is explicitly invited to hand-edit (that is the point
 * of storing it as readable JSON rather than a database), so malformed input is an expected state,
 * not an exceptional one. The lesson-store precedent applies: re-validate on read, drop what cannot
 * be honoured, keep the rest usable — a single bad key must not cost the user their other answers.
 *
 * What it will NOT do is guess. An unrecognised value falls back to that key's default and says so in
 * `errors`, rather than being coerced into whatever is nearest. Silently reinterpreting a user's
 * stated preference is worse than ignoring it, because they have no way to notice.
 */
export function validate(input) {
  const values = defaults();
  const errors = [];
  const warnings = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    if (input !== undefined) errors.push({ key: null, reason: 'settings must be a JSON object; using defaults for everything' });
    return { ok: false, values, errors, warnings };
  }

  for (const [key, raw] of Object.entries(input)) {
    const entry = BY_KEY.get(key);
    if (!entry) {
      // Dropped, not preserved. Carrying unknown keys forward would let a typo'd setting live in the
      // file forever looking like it does something.
      warnings.push({ key, reason: 'not a known setting — ignored' });
      continue;
    }
    if (entry.type === 'bool') {
      if (typeof raw !== 'boolean') { errors.push({ key, reason: `expected true or false, got ${JSON.stringify(raw)} — using the default (${entry.default})` }); continue; }
      values[key] = raw;
    } else if (entry.type === 'enum') {
      // Legacy-value migration: a pre-rename stored value maps to its current equivalent (entry.legacy)
      // rather than being rejected and silently reset to the default — which would lose the user's real
      // choice. Only defined for settings that were renamed (advocacy: off→1, important-only→3, all→4).
      let v = raw;
      if (entry.legacy && Object.prototype.hasOwnProperty.call(entry.legacy, raw)) v = entry.legacy[raw];
      if (!entry.options.includes(v)) { errors.push({ key, reason: `expected one of ${entry.options.join(' | ')}, got ${JSON.stringify(raw)} — using the default (${entry.default})` }); continue; }
      values[key] = v;
    }
  }
  return { ok: errors.length === 0, values, errors, warnings };
}

/**
 * LOAD — returns an envelope, not a bare object, because the caller has to be able to tell the
 * difference between "the user chose the defaults" and "we could not read their choices".
 *
 * House rule 1 in a function signature: a console that renders these must be able to say which of
 * those two it is looking at. Collapsing them into one plain object would force it to present a
 * corrupt file as a deliberate configuration, which is exactly the class of fabricated status this
 * repo has a standing order against.
 */
export function loadSettings(file = STORE_PATH) {
  // `fromFuture` is a NARROW flag and its narrowness is the entire design. It marks the one state in
  // which saving would DESTROY RECOVERABLE DATA, and nothing else:
  //
  //   fromFuture = the file is perfectly valid and intact; we simply do not understand its schema
  //                because a NEWER build wrote it. Their real choices are sitting there, readable by
  //                the version that made them. Overwriting = deleting live data. → REFUSE.
  //   corrupt    = the bytes are not JSON. Their choices are already GONE; there is nothing left to
  //                protect. Refusing here would strand the user forever with a broken file and no way
  //                to fix it from the console. → RECOVER: back the wreckage up and write a good file.
  //   !healthy   = we read their choices fine and one value was invalid. Entirely normal. → PROCEED.
  //
  // The tempting version of this fix was one flag for "could not read it" covering both corrupt and
  // fromFuture. That is wrong, and its own test caught it: recovery from a truncated write is a
  // CONTRACT here, and a blanket refusal breaks the only path out of it. "Can we still recover their
  // intent from this file?" is the question — not "can we parse it?"
  const envelope = { path: file, exists: false, healthy: true, fromFuture: false, values: defaults(), errors: [], warnings: [] };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return envelope; }   // no file yet is the NORMAL state, not a fault — empty-first, house rule 3

  envelope.exists = true;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    // Degrade, do not throw. A truncated write (full disk, killed process) must not make every
    // surface that reads settings explode; it must make them fall back and say why.
    // NOT fromFuture: these bytes are unrecoverable, so there is nothing here for a refusal to
    // protect. saveSettings backs the wreckage up and writes a clean file — recovery, not overwrite.
    envelope.healthy = false;
    envelope.errors.push({ key: null, reason: `settings file is not valid JSON (${e.message}) — using defaults` });
    return envelope;
  }

  if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number' && parsed.version > SETTINGS_VERSION) {
    // Written by a newer version than this code understands. Refuse to reinterpret it — an older
    // reader guessing at a newer schema is how settings get silently downgraded on the next save.
    envelope.healthy = false;
    envelope.fromFuture = true;
    envelope.errors.push({ key: null, reason: `settings were written by a newer version (v${parsed.version} > v${SETTINGS_VERSION}) — using defaults rather than misreading them` });
    return envelope;
  }

  const result = validate(parsed && typeof parsed === 'object' ? parsed.settings : undefined);
  envelope.values = result.values;
  envelope.errors = result.errors;
  envelope.warnings = result.warnings;
  envelope.healthy = result.ok;
  return envelope;
}

/**
 * MUTUAL EXCLUSION around read-modify-write, because the comment that used to sit on saveSettings
 * claimed read-modify-write had solved the 2026-07-12 concurrent-clobber and it had not — it only
 * narrowed the window. MEASURED: four writers each setting a different key, released simultaneously,
 * lost at least one setting in 19 of 20 trials. Every writer returned `ok: true`. No error, no
 * warning, no evidence — the user clicks four toggles and two of them quietly do not stick, which is
 * the same silent-loss shape as the checkpoint clobber, on the surface whose entire job is to record
 * what the user wants.
 *
 * `open(…, 'wx')` is the primitive: exclusive creation is atomic on POSIX and on Windows, and it
 * needs no dependency. The alternative — a lockfile package — is not available to a script that must
 * run from a bare install.
 *
 * STALE LOCKS ARE BROKEN, DELIBERATELY. A process killed mid-save leaves the lock file behind, and a
 * guard that then wedges every future save forever is worse than the race it prevents. This repo has
 * already retired two defensive wrappers (`-readonly`, `timeout`) for causing exactly the failures
 * they were meant to guard against; a lock with no stale path would be the third. So the lock records
 * its pid and mtime, and any lock older than STALE_LOCK_MS is taken over.
 */
export const LOCK_WAIT_MS = 5000;    // total time a writer will queue before giving up and saying so
const STALE_LOCK_MS = 30_000; // older than this and the holder is presumed dead, not slow

/** Sleep without async. Atomics.wait on a throwaway buffer is the only dependency-free sync sleep. */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — spin the remaining wait out rather than fail the save */ }
}

// EXPORTED because the console's own writer needs them. These were written, tested and hardened here
// while `/api/save-config` — the only writer any user can actually reach — kept using a truncating
// writeFileSync with no lock and no validation. Write-safety that lives in a module nothing calls is
// not write-safety; it is a test suite. See saveConfig in onboarding-console.mjs.
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;

  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; }
    catch (e) {
      // A filesystem error (EACCES on a read-only directory, EROFS, ENOSPC) is NOT contention, and
      // must not be thrown out of a function whose callers are all documented to return a receipt
      // rather than raise. It broke the read-only-directory test by turning a clean "refusing to
      // write — backup failed" into an EACCES stack trace out of saveSettings.
      //
      // Proceeding unlocked is safe here, and provably so rather than hopefully: the lock lives in
      // the SAME directory as the settings file, so a directory that refuses a new lock entry will
      // equally refuse the backup and the temp file. The real operation fails a moment later with the
      // accurate message about what actually could not be done. Better a truthful error from the step
      // that matters than an accurate-but-obscure one about a lock the user never asked for.
      if (e.code !== 'EEXIST') return { ok: true, unlocked: true, value: fn() };
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; }
      catch { continue; }   // vanished between open and stat — the holder just released it; retry
      if (age > STALE_LOCK_MS) {
        // Presumed-dead holder. Unlink and retry rather than write through the lock, so two
        // simultaneous stale-breakers still serialise on the next exclusive create.
        try { fs.unlinkSync(lock); } catch { /* someone else won the race to clear it — fine */ }
        continue;
      }
      if (Date.now() > deadline) {
        return { ok: false, timedOut: true, heldMs: age };
      }
      sleepSync(25);
    }
  }

  try {
    try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } catch { /* advisory only */ }
    return { ok: true, value: fn() };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* already cleared by a stale-breaker */ }
  }
}

/**
 * Write a file so that no reader — and no crash — can ever observe a half-written one.
 *
 * temp-in-the-same-directory + rename() is atomic on POSIX, so the settings file is either entirely
 * the old content or entirely the new one. The previous code wrote in place with writeFileSync,
 * which truncates first: a process killed between truncate and write leaves an empty settings file
 * and the user's answers are gone with no backup step having failed.
 *
 * The temp name carries the pid so two concurrent writers cannot collide on it even in the moment
 * before one of them takes the lock.
 */
export function writeAtomic(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, body);
    // fsync before rename: rename is atomic with respect to readers, but without the flush a power
    // loss can land the rename while the content is still in the page cache — an atomically-renamed
    // empty file, which is precisely the outcome the rename was chosen to prevent.
    try { fs.fsyncSync(fd); } catch { /* filesystem without fsync (some network mounts) — proceed */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to close */ } }
    if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch { /* leave the temp rather than throw over it */ } }
  }
}

/** Backups this module has taken, newest last. The undo history, derived from disk rather than claimed. */
export function listBackups(file = STORE_PATH) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-`;
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().map((n) => path.join(dir, n));
  } catch { return []; }
}

/**
 * SAVE — backup first, merge, then write. Every clause here is a real failure, not defensiveness.
 *
 * BACKUP BEFORE WRITE, and refuse the write outright if the backup fails. A save that cannot be
 * undone is not a save, it is an overwrite, and the user has no way to know which one they got.
 *
 * READ-MODIFY-WRITE rather than replace-wholesale, because two Claude Code sessions genuinely do run
 * against one machine at once. That exact scenario destroyed a checkpoint on 2026-07-12: a second
 * session's plain overwrite wiped the first session's state with no error and no evidence beyond a
 * changed row id. A partial patch here therefore updates the keys it names and leaves every other
 * answer standing.
 *
 * The `patch` is validated as a WHOLE-object merge against what is already on disk, so an invalid
 * incoming value falls back to the stored answer's replacement rather than to the shipped default —
 * a bad click must not quietly reset the three settings the user got right.
 */
export function saveSettings(patch, { file = STORE_PATH } = {}) {
  // The directory must exist before the lock can be created in it — the lock lives beside the file.
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  catch (e) { return { ok: false, backup: null, values: defaults(), log: `refusing to write — could not create ${path.dirname(file)}: ${e.message}` }; }

  // EVERYTHING from here is under the lock, and `before` is re-read INSIDE it. Reading before
  // acquiring would reintroduce the exact race the lock exists to close: two writers could both read
  // the same pre-state, both merge onto it, and the second rename would erase the first's key.
  const held = withLock(file, () => saveLocked(patch, file));
  if (held.timedOut) {
    return {
      ok: false,
      backup: null,
      values: loadSettings(file).values,
      log: `another process is saving these settings and did not finish within ${LOCK_WAIT_MS}ms (lock held ${Math.round(held.heldMs)}ms) — nothing was written; try again`,
    };
  }
  return held.value;
}

function saveLocked(patch, file) {
  const before = loadSettings(file);

  // REFUSE rather than silently downgrade. loadSettings already decided it could not interpret these
  // choices and said so in its own comment — "an older reader guessing at a newer schema is how
  // settings get silently downgraded on the next save" — and then the next save did precisely that.
  // MEASURED: a v2 file holding six deliberate choices, saved once by this v1 code after toggling one
  // unrelated key, came back as v1 with four keys reset to defaults and two deleted outright, and the
  // receipt said "saved; previous settings kept at …bak-…". A clean-looking success that destroyed
  // three explicit decisions is worse than any error message.
  //
  // ONLY the from-the-future case. A corrupt file deliberately falls through to the recovery path
  // below: there is no live data left in it to protect, and a refusal there would leave the user with
  // a broken settings file and no way to repair it from the console — a guard that traps the person
  // it was written for. See the flag's definition in loadSettings.
  //
  // Note what is NOT done here: unknown keys are still dropped by validate(), by the deliberate
  // decision documented there. Preserving them would be a second, weaker answer to this problem —
  // refusing the write protects a newer file completely, whereas preserving keys would still rewrite
  // its version stamp and re-interpret the keys we think we recognise.
  if (before.fromFuture) {
    return {
      ok: false,
      backup: null,
      values: before.values,
      log: `refusing to write over settings this version cannot read (${before.errors[0]?.reason ?? 'unreadable file'}) — your file is untouched; nothing was saved`,
    };
  }

  const merged = { ...before.values, ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}) };
  const result = validate(merged);

  // validate() falls back to the SHIPPED default, which is right for a cold read and wrong here: on a
  // save, the honest fallback is what the user already had. Caught by its own test — a bad click on
  // one control was silently resetting that control to factory rather than leaving it alone. Every
  // value in `before.values` is already validated, so this cannot reintroduce a bad value.
  for (const e of result.errors) {
    if (e.key && Object.hasOwn(before.values, e.key)) result.values[e.key] = before.values[e.key];
  }

  let backup = null;
  if (fs.existsSync(file)) {
    // The timestamp is only millisecond-resolution, and two saves DO land in the same millisecond —
    // measured, not theorised: six rapid saves produced five backups, because one copyFileSync
    // overwrote another at an identical path. Silently, with no error. An undo history that drops a
    // step without saying so is worse than none, since the user is relying on it. So the name is made
    // unique before writing: one save, one backup, always.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.bak-${stamp}`;
    // Zero-padded so listBackups()'s lexicographic sort still means "newest last" — unpadded, "-10"
    // would sort BEFORE "-2" and revert-without-a-named-backup would restore the wrong one.
    for (let n = 2; fs.existsSync(backup); n++) backup = `${file}.bak-${stamp}-${String(n).padStart(2, '0')}`;
    // READ-THEN-WRITE, NOT copyFileSync — and this is not stylistic. Under sustained concurrent
    // saving, copyFileSync WEDGED the process permanently: reproduced in 3 of 6 trials at 40 saves
    // per writer with two writers, observed at 100% CPU for 4m38s with zero file progress, never
    // returning and never throwing. macOS `sample` put 1473 of 1476 stack samples inside
    // node::fs::CopyFile. A hung request handler that never recovers is not survivable on a surface
    // people are told to click. `wx` additionally refuses to overwrite an existing backup, so the
    // uniqueness loop above cannot be defeated by a racing writer between existsSync and the write.
    try { fs.writeFileSync(backup, fs.readFileSync(file), { flag: 'wx' }); }
    catch (e) { return { ok: false, backup: null, values: before.values, log: `refusing to write — backup failed: ${e.message}` }; }
  }

  const body = { version: SETTINGS_VERSION, updated: new Date().toISOString(), settings: result.values };
  try {
    writeAtomic(file, JSON.stringify(body, null, 2) + '\n');
  } catch (e) {
    return { ok: false, backup, values: before.values, log: `write failed: ${e.message}${backup ? `; your previous settings are at ${backup}` : ''}` };
  }

  // `existedBefore: false` is the undo instruction for the first-ever save: there is no backup to
  // restore because there was no file, so reverting means REMOVING it. Without this flag, revert
  // would have to guess, and a revert that guesses is not an undo.
  return {
    ok: true,
    file,
    backup,
    existedBefore: before.exists,
    values: result.values,
    errors: result.errors,
    warnings: result.warnings,
    log: backup ? `saved; previous settings kept at ${backup.replace(HOME, '~')}` : 'saved (first time — reverting will remove the file)',
  };
}

/**
 * REVERT — the other half of the promise made by saveSettings.
 *
 * Restores a specific backup, or the most recent one when none is named. Passing the save receipt's
 * `{ backup: null, existedBefore: false }` removes the file, returning the machine to genuinely
 * having no settings rather than to a synthesised "defaults" file — those are different states and
 * loadSettings() reports them differently, so revert must not blur them.
 */
export function revertSettings({ file = STORE_PATH, backup, existedBefore = true } = {}) {
  const target = backup ?? listBackups(file).slice(-1)[0] ?? null;

  if (!target) {
    if (existedBefore === false || !fs.existsSync(file)) {
      if (!fs.existsSync(file)) return { ok: true, log: 'nothing to revert — there are no settings on disk' };
      try { fs.rmSync(file); return { ok: true, log: 'removed the settings file (there was none before this save)' }; }
      catch (e) { return { ok: false, log: `could not remove ${file}: ${e.message}` }; }
    }
    return { ok: false, log: 'no backup available to restore' };
  }
  if (!fs.existsSync(target)) return { ok: false, log: `that backup is gone (${target})` };

  // Same read-then-atomic-write as the save path, for the same two reasons: copyFileSync can wedge
  // under contention (see saveSettings), and an in-place copy that is interrupted leaves the user
  // with neither their old settings nor their new ones — during an UNDO, which is the one operation
  // that must never be able to lose data.
  //
  // AND THE RECEIPT IS CHECKED. withLock returns {ok:false, timedOut:true} WITHOUT EVER CALLING fn
  // when another process holds a fresh lock — so discarding its result meant a revert that wrote
  // nothing still reported "restored your previous settings from …bak-…". MEASURED against a held
  // lock: 5017ms elapsed, receipt said ok:true, file byte-for-byte unchanged. saveSettings has
  // checked `held.timedOut` since the day it was written; revert was the copy that forgot, which put
  // the fabricated-success bug inside the one operation whose entire promise is that it really
  // happened. A failed undo the user is told succeeded is worse than an undo button that isn't there.
  let held;
  try {
    const bytes = fs.readFileSync(target);
    held = withLock(file, () => writeAtomic(file, bytes));
  } catch (e) { return { ok: false, log: `restore failed: ${e.message}` }; }
  if (held.timedOut) {
    return {
      ok: false,
      log: `another process is writing these settings and did not finish within ${LOCK_WAIT_MS}ms (lock held ${Math.round(held.heldMs)}ms) — NOTHING was restored and your backup at ${path.basename(target)} is intact; try again`,
    };
  }
  return { ok: true, restored: target, log: `restored your previous settings from ${path.basename(target)}` };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
// Read-only by default. Printing what is actually stored, plus the downside of every choice, is the
// whole point — a settings model you cannot inspect from a terminal is one you have to trust.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('user-settings.mjs');
if (invokedDirectly) {
  const state = loadSettings();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.log(`\n  Settings file: ${state.path.replace(HOME, '~')}${state.exists ? '' : '  (not created yet — showing defaults)'}\n`);
    for (const s of SETTINGS_SCHEMA) {
      const v = state.values[s.key];
      const reach = escalatesBeyondProject(s.key, v) ? '  ← reaches outside this project' : '';
      console.log(`  ${s.label}`);
      console.log(`    now: ${JSON.stringify(v)}${v === s.default ? ' (default)' : ''}${reach}`);
      console.log(`    ${s.help}`);
      console.log(`    downside: ${s.downside}\n`);
    }
    for (const e of state.errors) console.log(`  ! ${e.key ?? 'file'}: ${e.reason}`);
    for (const w of state.warnings) console.log(`  · ${w.key}: ${w.reason}`);
  }
}
