#!/usr/bin/env node
// lesson-seed.mjs — the lessons of 2026-07-21/22, as executable objects.
//
// Every one has a dated, measured failure behind it from a single session, and each is classified by
// what could ACTUALLY have caught it. Several are declared `review`/`checklist`, meaning no hook can
// fully observe them — saying so is the honest move; claiming otherwise would be the
// under-enumeration failure (L10) committed while recording L10.
//
// PROVENANCE IS REAL HERE, not decorative. Lessons where the owner's words can be quoted are
// `user-stated`; lessons the model inferred about its OWN behaviour are `model-inferred` and are
// quarantined — they can never block, no matter how convincing they sound. Nothing here is ratified,
// because the model does not get to ratify its own rules. That is the point of the boundary.
//
//   node scripts/lesson-seed.mjs           # preview: what fires when, and at what force
//   node scripts/lesson-seed.mjs --apply   # store as CANDIDATES awaiting ratification

import os from 'node:os';
import {
  makeLesson, saveLessons, loadLessons, lessonsFor, unenforceable, pending, weightOf,
  TRIGGERS as T, ENFORCEMENT as E, ORIGIN as O, SOURCE_CLASS,
} from './lesson-store.mjs';

// Shipped at CHECKLIST; `intendedEnforcement` records what it becomes once a human ratifies it.
const blocking = { enforcement: E.CHECKLIST, intendedEnforcement: E.BLOCK };
const ownerImport = {
  origin: O.IMPORTED,
  sourceClass: SOURCE_CLASS.IMPORTED_OWNER,
  demoted: true,
};

export const SEED = [
  makeLesson({
    id: 'L01-verify-with-a-capable-channel',
    ...blocking,
    ...ownerImport,
    severity: 'high',
    statement: 'Before claiming something works, verify through a channel CAPABLE of observing the change — an independent tool, a re-measurement, a read-write connection. Never the exit code of the thing being tested.',
    trigger: T.CLAIM_DONE.key,
    check: 'a measurement was taken AFTER the change by something other than the process that made it',
    evidence: [
      { observed: 'distillation wrote 684 patterns; the success check used a read-only connection that structurally cannot see another process\'s WAL, and reported "produced no new patterns"' },
      { observed: 'the queue flush deleted 60 of 68 distinct lessons and reported success' },
      { observed: 'the capture flush fired on an exact modulo, so the queue reached 491 while both ends reported healthy' },
      { observed: 'a repair promised an undo the console had no branch for, and answered "nothing to undo"' },
      { observed: 'the installer compared versions with !== and told a user who was AHEAD they were out of date' },
    ],
    repeatCount: 25,
    projects: ['Code-PowerPlatePulse', 'Code-ruvnet-brain', 'Code-AppealArmor'],
  }),

  makeLesson({
    id: 'L02-check-before-you-assert',
    ...blocking,
    ...ownerImport,
    severity: 'high',
    statement: 'Before stating any fact about the world — a version, an API, what a tool does, how an architecture works — read a live source THIS TURN and name it. Recalling is not checking. The urge to skip the check IS the signal you are about to be wrong.',
    trigger: T.ASSERT_FACT.key,
    check: 'a source was read this turn (tool call, file read, or command output) for the specific claim, and it is cited',
    evidence: [
      { observed: 'owner, 2026-07-22: "I ask you questions about architecture, and you immediately do a casual look and come back and tell me something dead wrong... those assumptions are the big toxic killer"' },
      { observed: 'reading one --help cost 5 seconds and revealed distillation SILENTLY SKIPS corrupt stores — the entire reason the feature appeared broken' },
      { observed: 'this project\'s own hook prints "EFFECTIVE BEATS EFFICIENT. Skipping this step has never once saved time" — and it fired on the author' },
      { observed: 'a model name was asserted as available and turned out to be unsupported on the account in use — caught only by running it' },
    ],
    repeatCount: 28,
    projects: ['Code-PowerPlatePulse', 'Code-ruvnet-brain', 'Code-AppealArmor', 'Code-BWEconstruction'],
  }),

  makeLesson({
    id: 'L03-research-before-recommending',
    enforcement: E.CHECKLIST,
    ...ownerImport,
    statement: 'Before recommending an architecture, research it: compare at least three real options with tradeoffs, and check whether the ecosystem already ships it. Pattern-matching from training data is not a recommendation.',
    trigger: T.RECOMMEND_ARCH.key,
    evidence: [
      { observed: 'cross-project lesson promotion was about to be designed from scratch; grounding found the ecosystem already ships it three ways' },
      { observed: 'a proxy health check was three lines from being hand-rolled when an existing doctor command already did all of it' },
    ],
    repeatCount: 6,
    projects: ['Code-ruvnet-brain'],
  }),

  makeLesson({
    id: 'L04-never-relay-a-number',
    enforcement: E.CHECKLIST,
    ...ownerImport,
    severity: 'high',
    statement: 'Never repeat a score, benchmark, or subagent result without re-checking the underlying artifact yourself. A number you did not measure is a claim you cannot defend.',
    trigger: T.RELAY_NUMBER.key,
    evidence: [
      { observed: 'a known analyzer hallucinates scores on remote URLs; relaying one would have shipped a fabricated number' },
      { observed: 'a capability detector reported "1 variant promoted" when that one was the baseline — making a run where every improvement was discarded read as partially successful' },
    ],
    repeatCount: 5,
    projects: ['Code-ruvnet-brain', 'Code-PowerPlatePulse'],
  }),

  makeLesson({
    id: 'L05-version-is-the-update-signal',
    ...blocking,
    ...ownerImport,
    severity: 'high',
    statement: 'Any behaviour-changing push bumps the version IN THE SAME COMMIT, and the release narrative is updated to match. A fix label on a new subsystem is a lie about what changed.',
    trigger: T.SHIP.key,
    check: 'the diff touches behaviour AND the version is unchanged from origin/main',
    evidence: [
      { observed: 'recorded 14 times in this repository alone — and violated again on 2026-07-22: six behaviour-changing commits at patch level with no bump, caught by the owner rather than the system' },
      { observed: 'promotion across projects could not have helped: the lesson was already here, fourteen times over. Only enforcement closes this.' },
    ],
    repeatCount: 52,
    projects: ['Code-ruvnet-brain', 'Code-AppealArmor', 'Code-PowerPlatePulse', 'Code-Chris-David-Salon'],
  }),

  makeLesson({
    id: 'L06-use-the-real-tool',
    ...blocking,
    ...ownerImport,
    severity: 'high',
    statement: 'Before writing code in the RuvNet domain, search for the tool that already implements it. If you still disagree after genuinely looking, say so OUT LOUD, cite the source path, and name the hand-roll as a hand-roll. Never silently.',
    trigger: T.WRITE_CODE.key,
    check: 'the brain was searched for the capability being written, and the result is cited',
    evidence: [
      { observed: 'a fake router was built while the real one sat on npm' },
      { observed: 'a hand-rolled capture hook was built while the real distill pipeline shipped the correct design' },
      { observed: 'the ground-before-write gate fired 3 times on 2026-07-21 and was right every time' },
      { observed: 'it fired twice more on 2026-07-22 while this very file was being written, and was right both times' },
    ],
    repeatCount: 6,
    projects: ['Code-ruvnet-brain'],
  }),

  makeLesson({
    id: 'L07-blast-radius-not-social-comfort',
    ...blocking,
    ...ownerImport,
    severity: 'high',
    statement: 'Gate on blast radius, not on how awkward an action feels. Ask: is it reversible, and is it outward-facing? A silent irreversible change is worse than an awkward reversible one.',
    trigger: T.MUTATE_MACHINE.key,
    check: 'the action is classified reversible/irreversible and internal/outward-facing before it runs, and an inverse is recorded first',
    evidence: [
      { observed: 'on 2026-07-22 permission was requested before filing a deletable comment, while six unversioned commits shipped silently in the same session — the risk model was exactly inverted' },
      { observed: 'a --root flag did not scope, so a scratch-scoped run modified a real store outside it' },
    ],
    repeatCount: 4,
    projects: ['Code-ruvnet-brain'],
  }),

  makeLesson({
    id: 'L08-status-is-a-table',
    enforcement: E.CHECKLIST,
    ...ownerImport,
    statement: 'Report status as a structured table with an explicit shipped/tested column, never as narrative. Prose lets unfinished work live inside sentences about progress.',
    trigger: T.REPORT_STATUS.key,
    evidence: [
      { observed: 'the owner asked "where are we" four times in one session; each answer was a story, and the incomplete items became legible only once a table was produced' },
      { observed: '"pushed" was allowed to read as "shipped" all evening; the installed plugin was three versions behind the repo the whole time' },
    ],
    repeatCount: 9,
    projects: ['Code-ruvnet-brain', 'Code-PowerPlatePulse'],
  }),

  // ── MODEL-INFERRED. The model observed these about ITSELF, so they are quarantined: they may
  //    never block, regardless of how true they sound. That asymmetry is the trust boundary.
  makeLesson({
    id: 'L09-gradeable-is-not-valuable',
    enforcement: E.CHECKLIST,
    ...ownerImport,
    statement: 'When choosing what to work on, name the ungradeable items explicitly and commit to them. The instinct to pick the task with a green test routes systematically away from the user\'s actual value.',
    trigger: T.CHOOSE_WORK.key,
    evidence: [
      { observed: 'of nine requested items on 2026-07-22, the four with test suites were built and the four product surfaces were all skipped' },
    ],
    repeatCount: 3,
    projects: ['Code-ruvnet-brain'],
  }),

  makeLesson({
    id: 'L10-under-enumeration-is-a-tell',
    enforcement: E.CHECKLIST,
    ...ownerImport,
    statement: 'When producing a list of failure modes, options, or requirements, state what was left out and why. A satisfyingly round number is evidence of rounding, not of completeness.',
    trigger: T.REPORT_STATUS.key,
    evidence: [
      { observed: 'an ADR listed exactly five decision points and omitted the owner\'s Rule 0 — "the #1 cause of failure" — because a clean list of five felt more finished than a messy list of seven' },
    ],
    repeatCount: 2,
    projects: ['Code-ruvnet-brain'],
  }),

  makeLesson({
    id: 'L11-retrieval-without-volition-is-broken',
    enforcement: E.REVIEW,
    ...ownerImport,
    statement: 'A surface that CAN detect something useful and stays silent is broken. Judge every feature by whether it volunteers what it knows, not by whether it can answer when asked.',
    trigger: T.CHOOSE_WORK.key,
    evidence: [
      { observed: 'the brain held every fact needed to say "your learning is off" for 21 days and answered other questions instead' },
      { observed: 'for three weeks the brain was queried only defensively — never once asked "what should we be using that we aren\'t?"' },
    ],
    repeatCount: 3,
    projects: ['Code-ruvnet-brain'],
  }),

  makeLesson({
    id: 'L12-efficiency-seeking-is-the-tell',
    enforcement: E.REVIEW,
    ...ownerImport,
    statement: 'Treat the impulse to save a step as a defect signal, not a virtue. Skipping a check to save a turn is the specific mechanism that produces wrong answers — effectiveness first, always.',
    trigger: T.CHOOSE_WORK.key,
    evidence: [
      { observed: 'owner, 2026-07-22: "Efficiency means nothing if you\'re wrong, and you focus on it far, far, far too often"' },
      { observed: 'the assumption failure and the efficiency preference are the same behaviour, not two: checking costs a tool call, and turn-count optimisation is what skips it' },
    ],
    repeatCount: 4,
    projects: ['Code-ruvnet-brain', 'Code-PowerPlatePulse'],
  }),
];

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('lesson-seed.mjs');
if (invokedDirectly) {
  const byTrigger = {};
  for (const l of SEED) (byTrigger[l.trigger] = byTrigger[l.trigger] || []).push(l);

  console.log(`\n  ${SEED.length} lessons — each bound to a trigger that makes it ACT.\n`);
  for (const t of Object.values(T)) {
    const ls = byTrigger[t.key];
    if (!ls) continue;
    const note = t.surface === 'text' ? 'fires on TEXT — least gated, most-failing surface'
      : t.surface === 'plan' ? 'fires while CHOOSING — no hook can observe this'
        : 'fires on a TOOL CALL';
    console.log(`  ▸ WHEN ${t.label}\n    (${note})`);
    for (const l of ls) {
      const shown = l.intendedEnforcement ? `${l.enforcement}→${l.intendedEnforcement}` : l.enforcement;
      console.log(`      ${shown.padEnd(18)} ${l.id}`);
      console.log(`      ${''.padEnd(18)}   IMPORTED MAINTAINER HISTORY (quarantined — never personal policy) · observed ${l.repeatCount}× · weight ${weightOf(l)}`);
    }
    console.log('');
  }
  const un = unenforceable(SEED);
  const pend = pending(SEED);
  console.log(`  ${pend.length} awaiting ratification. Bundled maintainer history is quarantined and cannot`);
  console.log(`  become the installing user's personal policy.`);
  if (un.length) console.log(`  ${un.length} are declared unenforceable (no hook can observe them); checked at review instead.`);
  console.log('');

  if (process.argv.includes('--apply')) {
    const res = saveLessons(SEED);
    const back = loadLessons();
    console.log(`  ✓ stored ${res.count} candidates at ${res.file.replace(os.homedir(), '~')}`);
    console.log(`  ✓ read back ${back.length}, each re-validated against the schema on load`);
    console.log(`  ✓ a gate at 'assert-fact' receives: ${lessonsFor('assert-fact', back).map((l) => l.id).join(', ') || 'none'}`);
    console.log(`  ✓ a gate at 'ship' receives:        ${lessonsFor('ship', back).map((l) => l.id).join(', ') || 'none'}\n`);
  } else {
    console.log(`  Preview only — nothing written. Use --apply to store.\n`);
  }
}
