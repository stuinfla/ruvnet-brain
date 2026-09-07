// remedy-registry.test.mjs — THE CLOSURE PROOF.
//
// The bug class this exists to kill: a recommendation that can be OFFERED but not RUN, or that
// promises an undo nothing implements. Both shipped. Both were invisible, because the id, the
// executor, and the inverse lived in three files nothing forced to agree:
//
//   • `learning:enable-fleet` was built, schema-validated, and offered — with no executor. Clicking
//     it returned "Unknown recommendation id".
//   • `repair:memory-index` journalled an undo kind undo() had no branch for, so asking to reverse a
//     database repair answered "nothing to undo (the change reverses itself automatically)".
//
// So this test does not check a hand-written list of ids — a hand-written list drifts from the
// builders in exactly the same way. It drives the REAL recommendation builders with inputs that
// trip every branch, collects the ids they actually construct, and proves each one resolves to
// exactly one runnable remedy with an undo the console genuinely implements.

import { test, expect } from 'vitest';

import { buildHealthRecommendations, buildStackRecommendations, buildWiringRecommendations, buildCapabilityRecommendations } from '../../scripts/console-engine.mjs';
import { REMEDIES, planFor, resolveRemedy, assertRegistryClosure, sampleIdFor, UNDO_KINDS } from '../../scripts/remedy-registry.mjs';
import { HANDLED_UNDO_KINDS } from '../../scripts/onboarding-console.mjs';

/**
 * Every id the product can put in front of a user. Inputs are chosen to trip EVERY branch of every
 * builder — that is the whole point. If a builder grows a new recommendation and this fixture is not
 * extended, the new id simply will not appear here, so keep the inputs maximal rather than minimal.
 */
function allOfferableIds() {
  const ids = [];

  // Health: corruption + a full queue + a stale learner + a fleet of distillable stores.
  ids.push(...buildHealthRecommendations({
    memory: { dimensions: [{ key: 'liveness', status: 'fail', detail: 'store is corrupt (integrity_check: wrong # of entries in index)' }] },
    learning: {
      queueDepth: 1884,
      lastTrainSeconds: 60 * 60 * 24 * 6,
      trajectories: 5,
      fleet: [
        // distillable: embedded, zero patterns
        { name: 'a', total: 5000, coverPct: 99, patterns: 0, learns: false },
        { name: 'b', total: 4000, coverPct: 80, patterns: 0, learns: false },
        { name: 'c', total: 3000, coverPct: 62, patterns: 0, learns: false },
        // NOT distillable: nothing embedded
        { name: 'd', total: 9000, coverPct: 2, patterns: 0, learns: false },
        // healthy
        { name: 'e', total: 1000, coverPct: 99, patterns: 400, learns: true },
      ],
    },
  }).map((r) => r.id));

  // Stack: a behind package, a broken one, and stale npx shadows.
  ids.push(...buildStackRecommendations({
    rows: [
      { name: 'ruflo', installed: '3.25.6', target: '3.28.0', state: 'BEHIND', tag: 'latest' },
      { name: 'agentdb', installed: null, target: '3.0.0', state: 'BROKEN', tag: 'alpha' },
    ],
    stale: [{ name: 'ruflo', version: '3.20.0', global: '3.28.0', dir: '/tmp/x' }],
  }).map((r) => r.id));

  // Wiring: a project resolving tools through npx.
  ids.push(...buildWiringRecommendations({
    sites: [{ project: 'demo-project', mechanism: 'NPX', file: '.claude/settings.json', event: 'PreToolUse', spec: 'npx ruflo@latest hooks pre-edit' }],
  }).map((r) => r.id));

  // Capability bridge: an OFF memory-distillation row with a verified, placeholder-free command and
  // real evidence — the one shape capability-registry.mjs actually produces when this capability is
  // off. This is the exact fixture that would have caught the "offered with no executor" bug if it
  // had shipped here instead of in learning:enable-fleet.
  ids.push(...buildCapabilityRecommendations({
    capabilities: [{
      key: 'memory-distillation', label: 'Memory distillation', scope: 'project', state: 'off',
      whatItBuysYou: 'Loose notes from past sessions get mined into reusable patterns.',
      turnOn: { human: "Mine this project's stored memories into reusable patterns (snapshots first; reversible)", cmd: 'node /repo/scripts/distill-project.mjs' },
      evidence: '120 memories stored and 80.0% embedded, but 0 have been distilled into patterns — the store records and forgets',
    }],
  }).map((r) => r.id));

  return ids;
}

test('every offerable recommendation id resolves to exactly one remedy with a real undo', () => {
  const ids = allOfferableIds();
  // Guard the guard: if the fixture stops producing ids, the closure check below would pass
  // vacuously and prove nothing. That is a failure mode this test must not have.
  expect(ids.length >= 7, `fixture produced only ${ids.length} ids — it is no longer exercising every builder branch`).toBeTruthy();

  const { orphanIds, ambiguousIds, unhandledUndoKinds, deadKinds } = assertRegistryClosure(ids, HANDLED_UNDO_KINDS);

  expect(orphanIds, `offered with NO executor behind them (dead buttons): ${orphanIds.join(', ')}`).toEqual([]);
  expect(ambiguousIds, `claimed by more than one remedy — would silently misroute: ${ambiguousIds.join(', ')}`).toEqual([]);
  expect(unhandledUndoKinds, `promise an undo the console cannot perform: ${unhandledUndoKinds.join(', ')}`).toEqual([]);
  expect(deadKinds, `registry declares undo kinds undo() does not implement: ${deadKinds.join(', ')}`).toEqual([]);
});

test('the North Star recommendation is runnable — it was not, and that was the whole bug', () => {
  const ids = allOfferableIds();
  expect(ids.includes('learning:distill-fleet'), 'the distill-fleet recommendation was not constructed at all').toBeTruthy();
  const plan = planFor('learning:distill-fleet');
  expect(plan, 'learning:distill-fleet has no remedy — this is the exact regression that shipped').toBeTruthy();
  expect(plan.exec.script).toBe('scripts/health-repair.mjs');
  expect(plan.exec.args.includes('--distill-fleet')).toBeTruthy();
  expect(plan.undo.kind).toBe(UNDO_KINDS.RESTORE_STORE_BACKUPS);
  expect(plan.exec.needsReceipt, 'a fleet-wide change must record WHICH stores it touched, or its undo is a guess').toBeTruthy();
});

test('project distillation stays explicitly runnable but is not offered without an available undo', () => {
  const ids = allOfferableIds();
  expect(ids.includes('enable:memory-distillation'), 'an unavailable inverse must not be offered as reversible').toBe(false);
  const plan = planFor('enable:memory-distillation');
  expect(plan, 'enable:memory-distillation has no remedy — a checkbox with no executor behind it').toBeTruthy();
  expect(plan.exec.script).toBe('scripts/distill-project.mjs');
  // No project baked into the args here — usesServerProject defers that to onboarding-console.mjs's
  // apply(), which supplies process.cwd() (the ACTUAL project the console is serving), never REPO.
  // See remedy-registry.mjs's own comment on this remedy for why that distinction matters.
  expect(plan.exec.usesServerProject, 'must be scoped to the server\'s project, never left to default to REPO').toBeTruthy();
  expect(plan.undo.kind).toBe(UNDO_KINDS.RESTORE_PROJECT_DISTILL);
  expect(plan.undo.available).toBe(false);
  expect(plan.autoEligible).toBe(false);
});

test('repair:memory-index routes to the database repair, never to a package sync', () => {
  // The precise misroute that review caught: `repair:memory-index` also matches `repair:<pkg>`, and
  // one reordering of an if/else chain ran a GLOBAL NPM SYNC while reporting a repaired database.
  const plan = planFor('repair:memory-index');
  expect(plan.key).toBe('memory-index');
  expect(plan.exec.script).toBe('scripts/health-repair.mjs');
  expect(plan.undo.kind).toBe(UNDO_KINDS.RESTORE_MEMORY_BACKUP);

  // And a genuine package repair still works, without the reserved id leaking into it.
  const pkg = planFor('repair:agentdb');
  expect(pkg.key).toBe('stack-sync');
  expect(pkg.params.pkg).toBe('agentdb');
});

test('an ambiguous id throws rather than picking a winner', () => {
  // Simulate the collision by asking two remedies to claim one id. Resolution must refuse, because
  // silently preferring the first match is how a wrong action gets reported as the right one.
  const spy = { key: 'spy', summary: 'test double', match: (id) => (id === 'purge:shadows' ? {} : null), plan: () => ({ script: 'x', args: [] }), inverse: () => ({ kind: UNDO_KINDS.NONE }) };
  REMEDIES.push(spy);
  try {
    expect(() => resolveRemedy('purge:shadows')).toThrow(/ambiguous/i);
  } finally {
    REMEDIES.splice(REMEDIES.indexOf(spy), 1);
  }
});

test('every remedy in the registry is itself reachable and complete', () => {
  for (const r of REMEDIES) {
    const id = sampleIdFor(r);
    expect(!id.startsWith('__unknown:'), `remedy "${r.key}" has no sample id — closure cannot check it`).toBeTruthy();
    const plan = planFor(id);
    expect(plan, `remedy "${r.key}" does not match its own sample id ${id}`).toBeTruthy();
    expect(plan.exec.script && Array.isArray(plan.exec.args), `remedy "${r.key}" has no runnable executor`).toBeTruthy();
    expect(Object.values(UNDO_KINDS).includes(plan.undo.kind), `remedy "${r.key}" declares undo kind "${plan.undo.kind}", which is not in UNDO_KINDS`).toBeTruthy();
    // A declared no-op must SAY why. "none" with no explanation is indistinguishable from a
    // forgotten undo, which is the ambiguity that let the memory-index lie survive review.
    if (plan.undo.kind === UNDO_KINDS.NONE) {
      expect(plan.undo.human && plan.undo.human.length > 20, `remedy "${r.key}" declares undo "none" without explaining why — say what a user would do instead`).toBeTruthy();
    }
  }
});
