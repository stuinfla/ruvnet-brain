// advocacy-outcomes.test.mjs — the ledger that decides when the brain stops talking.
//
// WHAT THIS PROTECTS, AND WHY THE WEIGHTING IS ODD. This module's failure modes are not symmetric.
// Offering a recommendation once too often costs a moment of irritation. SUPPRESSING one costs
// silence — and silence is indistinguishable from health, which is the exact shape of the failure
// ADR-028 was written about: the console could have said "your learner is off" for 21 days and the
// owner found it himself. So the tests below lean hard on the refusal-to-suppress side: it matters
// more that a corrupt-store warning survives a distracted click than that a nag dies promptly.
//
// The five test classes ADR-028 requires:
//   low         — the suppression predicate and precision arithmetic, table-driven, tmpfile only
//   medium      — real filesystem: append, reload, corrupt, truncate, reset
//   high        — the cross-project claim (dismiss in A, silent in B) and real concurrent processes
//   numeric     — the budget boundaries and the 0.60 target asserted exactly, not approximately
//   qualitative — the return values are self-describing: "unknown" is a distinct value with a
//                 stated reason, never a number that reads like a measurement

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ACTIONS, DISMISSAL_BUDGET, IGNORE_WEIGHT, HARD_DISMISSAL_CAP,
  PRECISION_TARGET, MIN_PRECISION_SAMPLES,
  MAX_ID, MAX_PROJECT, MAX_SEVERITY, MAX_HASH, MAX_RECORD_BYTES,
  record, loadOutcomes, outcomesFor, shouldStillOffer, precision, summarize,
  stateHashOf, weightClass, claimOffer, releaseClaim,
} from '../../scripts/advocacy-outcomes.mjs';

const MODULE = fileURLToPath(new URL('../../scripts/advocacy-outcomes.mjs', import.meta.url));

let tmp;
let file;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'advocacy-outcomes-')));
  file = path.join(tmp, 'nested', 'advocacy-outcomes.jsonl');   // nested: the dir must be created for us
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Append n records of one action. Returns the receipts so a test can assert the write succeeded. */
const put = (id, action, n = 1, extra = {}) =>
  Array.from({ length: n }, () => record({ id, action, ...extra }, { file }));

describe('low — an offer resolves into exactly one of three outcomes, and the schema says so', () => {
  it('refuses an action outside the closed set, at the call, not silently', () => {
    // The precision denominator is defined over exactly three actions. An unrecognised one written
    // quietly would not throw later — it would produce a plausible, wrong number forever.
    expect(() => record({ id: 'learning:flush', action: 'maybe' }, { file }))
      .toThrow(/action must be one of/);
    expect(() => record({ id: '', action: ACTIONS.APPLIED }, { file })).toThrow(/missing id/);
    expect(fs.existsSync(file), 'a rejected record must not reach the ledger').toBe(false);
  });

  it('refuses a permanent silence attached to anything but a dismissal', () => {
    // scope:'forever' mutes a card outright. Accepting it on an `applied` would let a stray field
    // silence something nobody asked to silence.
    expect(() => record({ id: 'x:y', action: ACTIONS.APPLIED, scope: 'forever' }, { file }))
      .toThrow(/only meaningful on a dismissal/);
    expect(() => record({ id: 'x:y', action: ACTIONS.DISMISSED, scope: 'quietly' }, { file }))
      .toThrow(/scope must be null or "forever"/);
  });

  it('a recommendation never offered is offered — silence has to be earned', () => {
    expect(shouldStillOffer('never-seen', { file })).toBe(true);
    expect(outcomesFor('never-seen', { file }).offered).toBe(0);
  });

  it('weightClass accepts both vocabularies, and an unknown severity resolves to the QUIETER class', () => {
    // console-engine speaks INFO/SUGGESTED/IMPORTANT; lesson-store speaks normal/high. Neither is
    // going to change to suit this file.
    expect(weightClass('IMPORTANT')).toBe('high');
    expect(weightClass('high')).toBe('high');
    expect(weightClass('SUGGESTED')).toBe('normal');
    expect(weightClass('INFO')).toBe('normal');
    // The direction of the default is a decision, not an accident: a caller that forgets severity
    // gets something silenceable, not something nearly unsilenceable.
    expect(weightClass(undefined)).toBe('normal');
    expect(weightClass(null)).toBe('normal');
  });
});

describe('low/numeric — dismissal suppresses re-offering, and the budget is exact', () => {
  it('one dismissal of a SUGGESTED card ends the conversation', () => {
    const id = 'suggest:try-rulake';
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' })).toBe(true);
    put(id, ACTIONS.DISMISSED, 1, { severity: 'SUGGESTED' });
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' })).toBe(false);
  });

  it('the budget is spent at exactly the declared count, not one either side', () => {
    // Asserted against the exported constants so the test cannot drift away from the policy it
    // documents — if someone retunes the budget, this reads the new number and still checks the edge.
    const id = 'repair:memory-index';
    const budget = Math.min(DISMISSAL_BUDGET.high, HARD_DISMISSAL_CAP);
    expect(budget).toBe(2);                       // and the number itself is pinned, deliberately
    for (let i = 1; i < budget; i++) {
      put(id, ACTIONS.DISMISSED, 1, { severity: 'IMPORTANT' });
      expect(shouldStillOffer(id, { file, severity: 'IMPORTANT' }),
        `dismissal ${i} of ${budget} must not yet suppress a high-severity finding`).toBe(true);
    }
    put(id, ACTIONS.DISMISSED, 1, { severity: 'IMPORTANT' });
    expect(shouldStillOffer(id, { file, severity: 'IMPORTANT' })).toBe(false);
  });

  it('silence accumulates at a fifth of a refusal — a card ignored enough times IS a nag', () => {
    const id = 'suggest:ignored-a-lot';
    const needed = Math.ceil(DISMISSAL_BUDGET.normal / IGNORE_WEIGHT);   // 5
    put(id, ACTIONS.IGNORED, needed - 1, { severity: 'SUGGESTED' });
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' }),
      'silence is consistent with "later" and with "I never saw it" — it may not settle the question early').toBe(true);
    put(id, ACTIONS.IGNORED, 1, { severity: 'SUGGESTED' });
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' })).toBe(false);
  });

  it('having actually used it buys credit back — a wanted card is not a nag', () => {
    const id = 'learning:flush';
    put(id, ACTIONS.APPLIED, 1, { severity: 'IMPORTANT' });
    put(id, ACTIONS.IGNORED, 5, { severity: 'IMPORTANT' });
    put(id, ACTIONS.DISMISSED, 1, { severity: 'IMPORTANT' });
    // spend = 1 dismissal + 1.0 from silence − 1 applied = 1.0, under the high budget of 3.
    expect(shouldStillOffer(id, { file, severity: 'IMPORTANT' })).toBe(true);
  });
});

describe('numeric — THE ASYMMETRY: a dismissal is evidence about FIT, not about IMPORTANCE', () => {
  // The adversarial review of ADR-031 (GPT-5.6-Sol, 2026-07-22) found that repeat count measures the
  // user's frustration rather than a lesson's correctness — "a formatting preference corrected 52
  // times dominates a security rule corrected once". A dismissal ledger repeats that error exactly
  // if one click is allowed to mean the same thing for a cosmetic suggestion and for a corrupt
  // database. These are the tests that hold the two apart.

  it('the SAME single dismissal silences a nag and does not silence a high-severity finding', () => {
    const nag = 'suggest:cosmetic';
    const grave = 'repair:memory-index';
    put(nag, ACTIONS.DISMISSED, 1, { severity: 'SUGGESTED' });
    put(grave, ACTIONS.DISMISSED, 1, { severity: 'IMPORTANT' });

    expect(shouldStillOffer(nag, { file, severity: 'SUGGESTED' })).toBe(false);
    expect(shouldStillOffer(grave, { file, severity: 'IMPORTANT' }),
      'one distracted click must not bury a corrupt store — the 2026-07-21 finding the owner had to spot himself').toBe(true);
  });

  it('severity is read from the CURRENT offer, so a finding that became serious un-suppresses', () => {
    // ADR-028: severity is derived from measured evidence on this machine. A capability that was
    // cosmetic last month and is now damaging must not stay muted by last month's classification.
    const id = 'learning:enable-fleet';
    put(id, ACTIONS.DISMISSED, 1, { severity: 'SUGGESTED' });
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' })).toBe(false);
    expect(shouldStillOffer(id, { file, severity: 'IMPORTANT' })).toBe(true);
  });

  it('new evidence re-opens a HIGH-severity question and does NOT re-open a suggestion', () => {
    // ADR-027: "offered once per state change". Applied to a nag, that clause is a licence to nag —
    // a flapping metric would re-fire forever through a budget it had already spent.
    const grave = 'repair:memory-index';
    const nag = 'suggest:cosmetic';
    const before = stateHashOf([{ observed: 'integrity_check: 1 corrupt index' }]);
    const after = stateHashOf([{ observed: 'integrity_check: 4 corrupt indexes' }]);
    expect(before).not.toBe(after);

    put(grave, ACTIONS.DISMISSED, 1, { severity: 'IMPORTANT', stateHash: before });
    put(grave, ACTIONS.IGNORED, 10, { severity: 'IMPORTANT', stateHash: before });
    put(nag, ACTIONS.DISMISSED, DISMISSAL_BUDGET.normal, { severity: 'SUGGESTED', stateHash: before });

    expect(shouldStillOffer(grave, { file, severity: 'IMPORTANT', stateHash: before }),
      'the same state must stay settled').toBe(false);
    expect(shouldStillOffer(grave, { file, severity: 'IMPORTANT', stateHash: after }),
      'the risk itself changed — that is new information, and it is worth one more interruption').toBe(true);
    expect(shouldStillOffer(nag, { file, severity: 'SUGGESTED', stateHash: after }),
      'a changed number is not new information worth interrupting a person for').toBe(false);
  });

  it('an unknown state can never argue its way past a dismissal', () => {
    // stateHashOf(no evidence) is null, and null is inert on BOTH sides of the comparison. A card
    // that cannot say what it observed does not get to claim the observation changed.
    const id = 'repair:memory-index';
    expect(stateHashOf([])).toBe(null);
    put(id, ACTIONS.DISMISSED, DISMISSAL_BUDGET.high, { severity: 'IMPORTANT', stateHash: null });
    expect(shouldStillOffer(id, { file, severity: 'IMPORTANT', stateHash: 'brand-new' })).toBe(false);
    expect(shouldStillOffer(id, { file, severity: 'IMPORTANT', stateHash: null })).toBe(false);
  });

  it('the hard cap outranks severity: after two refusals, nothing re-fires on any evidence', () => {
    const id = 'repair:memory-index';
    for (let i = 0; i < HARD_DISMISSAL_CAP; i++) {
      put(id, ACTIONS.DISMISSED, 1, { severity: 'IMPORTANT', stateHash: `state-${i}` });
    }
    expect(shouldStillOffer(id, { file, severity: 'IMPORTANT', stateHash: 'state-brand-new' }),
      'at two explicit refusals we are wrong about the user, not about the machine').toBe(false);
  });

  it('a permanent silence is honoured in one action, at every severity, with no override', () => {
    // ADR-028 anti-goal: "Interruption without an off switch." The off switch may not be negotiable
    // by the thing being switched off.
    const id = 'repair:memory-index';
    record({ id, action: ACTIONS.DISMISSED, severity: 'IMPORTANT', scope: 'forever' }, { file });
    expect(outcomesFor(id, { file }).silencedForever).toBe(true);
    expect(shouldStillOffer(id, { file, severity: 'IMPORTANT', stateHash: 'anything-new' })).toBe(false);
  });
});

describe('high — the L5 claim: an outcome in project A changes behaviour in project B', () => {
  // ADR-028's falsifiable test for L5 Compounding, expressed on the signal available today. It is
  // also simply true of the subject matter: these recommendations are about the user's MACHINE, so
  // per-repo suppression would ask one person the same question once per checkout.
  it('dismissing in project A suppresses the identical recommendation in project B', () => {
    const id = 'learning:flush';
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' })).toBe(true);
    record({ id, action: ACTIONS.DISMISSED, severity: 'SUGGESTED', project: 'project-a' }, { file });

    // Nothing about project B is passed, because there is nothing to pass — suppression is global.
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' })).toBe(false);
    expect(outcomesFor(id, { file }).projects).toEqual(['project-a']);
    // …and the per-project view still exists for anyone who needs to ask WHERE it happened.
    expect(outcomesFor(id, { file, project: 'project-b' }).offered).toBe(0);
  });

  it('the ledger survives a refresh: a suppression written now is read back from a cold module', async () => {
    // "…and survives a nightly refresh." Written by one process, read by another that shares nothing
    // but the file — which is the only durability claim this design actually makes.
    const id = 'learning:enable-fleet';
    record({ id, action: ACTIONS.DISMISSED, severity: 'SUGGESTED', project: 'project-a' }, { file });
    const out = await runNode(`
      const m = await import(${JSON.stringify(pathToFileURL(MODULE).href)});
      process.stdout.write(JSON.stringify({
        offer: m.shouldStillOffer(${JSON.stringify(id)}, { file: ${JSON.stringify(file)}, severity: 'SUGGESTED' }),
        rows: m.loadOutcomes(${JSON.stringify(file)}).length,
      }));
    `);
    expect(JSON.parse(out)).toEqual({ offer: false, rows: 1 });
  });
});

describe('medium — a reset is the undo for a suppression, and it does not erase the ledger', () => {
  it('un-suppresses without deleting a single record', () => {
    // Dismissal is a control. This repo does not ship a control without a real inverse — see
    // remedy-registry.mjs, which exists because an undo once reported "nothing to undo" and meant it.
    const id = 'suggest:try-rulake';
    put(id, ACTIONS.DISMISSED, 1, { severity: 'SUGGESTED' });
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' })).toBe(false);

    record({ id, action: ACTIONS.RESET }, { file });
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' }),
      'the user lifted the suppression; the brain speaks again').toBe(true);
    expect(loadOutcomes(file).length, 'append-only: nothing was destroyed to achieve that').toBe(2);
    expect(outcomesFor(id, { file }).offered, 'the arithmetic starts again after the checkpoint').toBe(0);
  });

  it('a reset cannot launder the precision score', () => {
    // shouldStillOffer honours the checkpoint because that is a preference about the FUTURE.
    // precision() is a measurement of how the product has actually behaved, and a metric you can
    // clear is a metric that stops judging you.
    put('a:b', ACTIONS.DISMISSED, 4);
    record({ id: 'a:b', action: ACTIONS.RESET }, { file });
    put('a:b', ACTIONS.APPLIED, 1);
    expect(outcomesFor('a:b', { file }).offered).toBe(1);
    expect(precision({ file }).offered, 'the four rejections are still on the record').toBe(5);
    expect(precision({ file }).precision).toBe(0.2);
  });

  it('reset ordering follows the FILE, not a caller-supplied clock', () => {
    // record() lets a caller pass `at`, and a skewed machine clock is real. If the arithmetic sorted
    // by timestamp, a reset stamped in the past would slide behind the dismissals it was meant to
    // clear and silently resurrect a suppression the user explicitly lifted.
    const id = 'suggest:clock-skew';
    record({ id, action: ACTIONS.DISMISSED, at: '2026-07-22T10:00:00.000Z', severity: 'SUGGESTED' }, { file });
    record({ id, action: ACTIONS.RESET, at: '2020-01-01T00:00:00.000Z' }, { file });
    expect(shouldStillOffer(id, { file, severity: 'SUGGESTED' })).toBe(true);
  });
});

describe('numeric — precision is ADR-028\'s metric, and it cannot be gamed upward', () => {
  it('computes acted-on ÷ fired exactly', () => {
    put('a', ACTIONS.APPLIED, 3);
    put('b', ACTIONS.DISMISSED, 1);
    put('c', ACTIONS.IGNORED, 1);
    const p = precision({ file });
    expect(p).toMatchObject({ applied: 3, dismissed: 1, ignored: 1, offered: 5, precision: 0.6 });
    expect(p.target).toBe(PRECISION_TARGET);

    // RETARGETED 2026-07-24, and the reversal is the point of this describe block finally being true.
    //
    // This used to assert meetsTarget === true because 3/5 = 0.60 and "the boundary is inclusive".
    // The ratio is right and the verdict was not: five offers are not evidence that the true rate is
    // at or above 0.60 — the 95% lower bound for 3/5 is about 0.19. Certifying a target from that is
    // the exact "gamed upward" failure the block is named for, which it was asserting rather than
    // preventing. meetsTarget now compares the LOWER BOUND, so offering less widens the interval
    // instead of buying a pass. The point estimate is unchanged and still checked above.
    expect(p.precision, 'the ratio itself is unchanged').toBe(0.6);
    expect(p.meetsTarget, 'five offers cannot certify a 0.60 floor, whatever the ratio').toBe(false);
    expect(p.lowerBound).toBeLessThan(PRECISION_TARGET);
  });

  it('a dismissal is in the denominator and NEVER in the numerator', () => {
    // Counting a dismissal as "acted on" would let the score rise as the product got worse: annoy
    // people into clicking X and precision climbs. A metric that inverts under pressure is worse
    // than no metric.
    put('x', ACTIONS.DISMISSED, 10);
    expect(precision({ file })).toMatchObject({ precision: 0, offered: 10, meetsTarget: false });
  });

  it('falls just below target at 0.59 and reports it', () => {
    put('x', ACTIONS.APPLIED, 59);
    put('x', ACTIONS.IGNORED, 41);
    const p = precision({ file });
    expect(p.precision).toBe(0.59);
    expect(p.meetsTarget, 'below 0.60 we are nagging, and the ledger has to say so').toBe(false);
  });

  it('an unrecorded miss is exactly how this number gets fabricated — proven, so it stays named', () => {
    // The failure mode is a caller that logs the applies and forgets the ignores. There is no code
    // fix for that inside this module; the defence is that it is written down and demonstrated here.
    put('honest', ACTIONS.APPLIED, 3);
    put('honest', ACTIONS.IGNORED, 7);
    expect(precision({ file, id: 'honest' }).precision).toBe(0.3);

    const lying = path.join(tmp, 'lying.jsonl');
    for (let i = 0; i < 3; i++) record({ id: 'honest', action: ACTIONS.APPLIED }, { file: lying });
    expect(precision({ file: lying }).precision, 'silence in the ledger reads as a perfect score').toBe(1);
  });
});

describe('qualitative — "unknown" is a value with a reason, never a number that looks measured', () => {
  it('precision is null, not 0, when nothing has been offered', () => {
    // The live rule this repo enforces everywhere: a detector once read a CLI table and reported
    // "26 hooks off" while the learner held 457 trajectories, because unknown rendered as off.
    // Advice nobody has been given does not have a 0.00 acceptance rate.
    const p = precision({ file });
    expect(p.precision).toBe(null);
    expect(p.offered).toBe(0);
    expect(p.meetsTarget).toBe(null);
    expect(p.reason).toMatch(/unknown, not zero/);
    expect(outcomesFor('nothing-here', { file }).precision).toBe(null);
  });

  it('withholds a verdict below the sample floor and says why', () => {
    put('x', ACTIONS.DISMISSED, MIN_PRECISION_SAMPLES - 1);
    const p = precision({ file });
    expect(p.precision).toBe(0);            // the ratio is real and reported
    expect(p.sufficient).toBe(false);
    expect(p.meetsTarget, 'one rejected offer is not a failing grade').toBe(null);
    expect(p.reason).toMatch(/below the \d+-sample floor/);
  });

  it('summarize() derives every field from records on disk, including the suppression state', () => {
    put('loud', ACTIONS.DISMISSED, 1, { severity: 'SUGGESTED' });
    put('wanted', ACTIONS.APPLIED, 2, { severity: 'IMPORTANT' });
    const rows = summarize({ file });
    expect(rows.find((r) => r.id === 'loud')).toMatchObject({ suppressed: true, dismissed: 1 });
    expect(rows.find((r) => r.id === 'wanted')).toMatchObject({ suppressed: false, applied: 2 });
    expect(rows[0].offered, 'ordered by how much evidence we actually have').toBe(2);
  });
});

describe('broken suppression history stays quiet; a genuinely absent ledger starts empty', () => {
  // Unknown history cannot stand in for consent. Reporting degradation is separate from
  // authorizing another optional recommendation. A missing fresh ledger remains normal.

  it('a missing file is not an error', () => {
    expect(loadOutcomes(path.join(tmp, 'nope.jsonl'))).toEqual([]);
    expect(() => precision({ file: path.join(tmp, 'nope.jsonl') })).not.toThrow();
    expect(shouldStillOffer('anything', { file: path.join(tmp, 'nope.jsonl') })).toBe(true);
  });

  it('corrupt suppression history cannot authorize a new offer', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all\n<<<>>>\n   \n');
    expect(loadOutcomes(file)).toEqual([]);
    expect(shouldStillOffer('repair:memory-index', { file, severity: 'IMPORTANT' })).toBe(false);
    expect(precision({ file }).precision).toBe(null);
  });

  it('one torn line costs one record, never the ledger', () => {
    // The residual hazard of an append-only file: a process killed mid-write, or an exotic
    // filesystem that split a write. Everything either side of the damage must still count.
    put('a:b', ACTIONS.APPLIED, 1);
    fs.appendFileSync(file, '{"v":1,"id":"a:b","action":"dismi');   // truncated, no newline
    fs.appendFileSync(file, '\n');
    put('a:b', ACTIONS.DISMISSED, 1);
    const rows = loadOutcomes(file);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.action)).toEqual([ACTIONS.APPLIED, ACTIONS.DISMISSED]);
  });

  it('drops a record whose action it does not understand rather than counting it as one it does', () => {
    // Written by a future version, or by a hand edit. Guessing would corrupt the denominator with a
    // value whose meaning we invented.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ v: 2, id: 'a:b', action: 'snoozed-until-tuesday' }),
      JSON.stringify({ v: 1, id: 'a:b', action: ACTIONS.APPLIED }),
      JSON.stringify({ v: 1, action: ACTIONS.APPLIED }),          // no id
      '{}',
      'null',
    ].join('\n') + '\n');
    const rows = loadOutcomes(file);
    expect(rows.length).toBe(1);
    expect(precision({ file })).toMatchObject({ offered: 1, applied: 1 });
  });

  it.skipIf(process.platform === 'win32')('an unwritable ledger returns a receipt instead of taking down the caller', () => { // chmod write-blocking is a no-op on win32 (documented gap, ci.yml)
    // Callers are surfaces. But the receipt must be checkable, because a dismissal that fails to
    // persist means the user's "stop showing me this" does not stick and the off switch is theatre.
    const blocked = path.join(tmp, 'blocked');
    fs.mkdirSync(blocked, { recursive: true });
    fs.chmodSync(blocked, 0o500);
    try {
      const r = record({ id: 'a:b', action: ACTIONS.DISMISSED }, { file: path.join(blocked, 'x.jsonl') });
      expect(r.ok).toBe(false);
      expect(r.reason, 'the reason survives rather than flattening to a boolean').toBeTruthy();
    } finally { fs.chmodSync(blocked, 0o700); }
  });

  it('the field caps PROVABLY keep the worst-case record inside one atomic write', () => {
    // The atomicity claim in appendLine() rests on every record being a single small write(), and
    // that is an arithmetic property, not a hope: each field is truncated, and the truncations sum
    // to well under the cap. This is the test that makes the claim checkable — and the one that goes
    // red the day somebody raises MAX_ID without redoing the sum.
    const r = record({
      id: 'z'.repeat(MAX_ID * 3),
      action: ACTIONS.DISMISSED,
      project: 'p'.repeat(MAX_PROJECT * 3),
      severity: 's'.repeat(MAX_SEVERITY * 3),
      stateHash: 'h'.repeat(MAX_HASH * 3),
      scope: 'forever',
    }, { file });
    expect(r.ok, 'oversized FIELDS are truncated — that is the normal path, not a refusal').toBe(true);

    const bytes = fs.statSync(file).size;
    expect(bytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    const [row] = loadOutcomes(file);
    expect(row.id.length).toBe(MAX_ID);
    expect(row.project.length).toBe(MAX_PROJECT);
    expect(row.severity.length).toBe(MAX_SEVERITY);
    expect(row.stateHash.length).toBe(MAX_HASH);
  });

  it('precision can be scoped to a window without rewriting history', () => {
    // A rolling window is how a slow improvement becomes visible: the lifetime number is dominated
    // by however bad we were at the start, which is not the question "are we nagging NOW".
    record({ id: 'a:b', action: ACTIONS.DISMISSED, at: '2026-06-01T00:00:00.000Z' }, { file });
    record({ id: 'a:b', action: ACTIONS.DISMISSED, at: '2026-06-02T00:00:00.000Z' }, { file });
    record({ id: 'a:b', action: ACTIONS.APPLIED, at: '2026-07-20T00:00:00.000Z' }, { file });
    expect(precision({ file }).precision).toBeCloseTo(0.3333, 3);
    expect(precision({ file, since: '2026-07-01T00:00:00.000Z' }).precision).toBe(1);
    expect(precision({ file, since: '2026-07-01T00:00:00.000Z' }).offered).toBe(1);
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────────────────────────
//
// THE FAILURE THIS REPO ALREADY PAID FOR. saveSettings() did read-modify-write on a JSON object, and
// measured across 20 trials of four simultaneous writers it lost at least one setting in 19 of them
// — every writer returning ok:true, with no error and no warning. That is why this ledger is JSONL
// and not a JSON array: append-only removes the read step, and with it the whole class of bug.
//
// The harness below is copied in shape from console-honesty-regressions.test.mjs, including both of
// its hard-won details: writers are launched with async spawn and only THEN awaited (spawnSync
// blocks, so an earlier version of that test ran its "simultaneous" writers strictly one after
// another and would have stayed green with the lock deleted), and each child SLEEPS to a shared
// release instant rather than busy-spinning, because four hot processes starved the ONNX worker-pool
// tests running in parallel.

/** Run one snippet of module code in a child process; resolve its stdout. */
function runNode(src) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

/** Launch every writer FIRST, then wait. That ordering is the entire point of the test. */
async function race(n, bodyFor) {
  const startAt = Date.now() + 500;
  const kids = Array.from({ length: n }, (_, i) => spawn(process.execPath, ['--input-type=module', '-e', `
    const lead = ${startAt} - Date.now();
    if (lead > 0) await new Promise((r) => setTimeout(r, lead));
    ${bodyFor(i)}
  `], { stdio: ['ignore', 'pipe', 'pipe'] }));
  return Promise.all(kids.map((c) => new Promise((res, rej) => {
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', rej);
    c.on('close', (code) => res({ code, err }));
  })));
}

describe('high — concurrent writers lose nothing', () => {
  it('eight processes recording different outcomes at one instant all land', async () => {
    const N = 8;
    const codes = await race(N, (i) => `
      const m = await import(${JSON.stringify(pathToFileURL(MODULE).href)});
      const r = m.record({ id: 'learning:flush', action: 'dismissed', project: 'p${i}' }, { file: ${JSON.stringify(file)} });
      if (!r.ok) { process.stderr.write(JSON.stringify(r)); process.exit(3); }
    `);
    for (const c of codes) expect(c.code, `writer failed: ${c.err}`).toBe(0);

    const rows = loadOutcomes(file);
    expect(rows.length, 'every writer returned ok — every record must actually be there').toBe(N);
    expect(new Set(rows.map((r) => r.project)).size, 'no writer overwrote another').toBe(N);
  }, 60_000);

  it('CONTROL: the harness can actually observe a lost write', async () => {
    // A regression test for the regression test. A blind harness and a correct implementation
    // produce byte-identical output: green. This runs the SAME shape against the read-modify-write
    // shape that a JSON-array ledger would force, and requires it to lose something. If this ever
    // passes cleanly, the writers have stopped overlapping and the guarantee above is unverified,
    // whatever colour the suite reports.
    const arrayFile = path.join(tmp, 'array-ledger.json');
    fs.writeFileSync(arrayFile, '[]');
    const codes = await race(8, (i) => `
      import fs from 'node:fs';
      const prev = JSON.parse(fs.readFileSync(${JSON.stringify(arrayFile)}, 'utf8'));
      await new Promise((r) => setTimeout(r, 40));   // the window: read, yield, write
      prev.push({ id: 'rec-${i}', action: 'dismissed' });
      fs.writeFileSync(${JSON.stringify(arrayFile)}, JSON.stringify(prev));
    `);
    for (const c of codes) expect(c.code, `control writer crashed: ${c.err}`).toBe(0);
    const got = JSON.parse(fs.readFileSync(arrayFile, 'utf8'));
    expect(got.length, 'the unlocked read-modify-write shape MUST lose records here — if it does not, this harness is blind and the test above proves nothing').toBeLessThan(8);
  }, 60_000);
});


describe('P037/P075 durable two-decline boundary', () => {
  it('two explicit declines override severity, changed state and prior applied credit', () => {
    expect(HARD_DISMISSAL_CAP).toBe(2);
    put('repair:two-declines', ACTIONS.OFFERED, 1, { severity: 'IMPORTANT', stateHash: 'old' });
    put('repair:two-declines', ACTIONS.APPLIED, 5, { severity: 'IMPORTANT' });
    put('repair:two-declines', ACTIONS.DISMISSED, 2, { severity: 'IMPORTANT', stateHash: 'old' });
    for (const stateHash of ['old', 'changed']) {
      expect(shouldStillOffer('repair:two-declines', { file, severity: 'IMPORTANT', stateHash })).toBe(false);
    }
    const restart = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {shouldStillOffer} from ${JSON.stringify(MODULE)};console.log(shouldStillOffer('repair:two-declines',{file:process.argv[1],severity:'IMPORTANT',stateHash:'changed'}));`, file], { encoding: 'utf8' });
    expect(restart.status).toBe(0);
    expect(restart.stdout.trim()).toBe('false');
    put('repair:two-declines', ACTIONS.RESET);
    expect(shouldStillOffer('repair:two-declines', { file, severity: 'IMPORTANT', stateHash: 'changed' })).toBe(true);
  });
});


describe('P037 suggestions require a new observed state', () => {
  it('durably suppresses delivered unchanged or unknown state across restart and honors explicit reset', () => {
    const id = 'recommend:state-probe';
    put(id, ACTIONS.OFFERED, 1, { stateHash: 'observed-A' });
    expect(shouldStillOffer(id, { file, stateHash: 'observed-A' })).toBe(false);
    expect(shouldStillOffer(id, { file, stateHash: null })).toBe(false);
    expect(shouldStillOffer(id, { file, stateHash: 'observed-B' })).toBe(true);
    const restart = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {shouldStillOffer} from ${JSON.stringify(MODULE)};console.log(shouldStillOffer('recommend:state-probe',{file:process.argv[1],stateHash:'observed-A'}));`, file], { encoding: 'utf8' });
    expect(restart.status).toBe(0);
    expect(restart.stdout.trim()).toBe('false');
    put(id, ACTIONS.RESET);
    expect(shouldStillOffer(id, { file, stateHash: 'observed-A' })).toBe(true);
  });
});


describe('P037 strict delivery claims', () => {
  it('fails silent on unavailable storage and expired unknown ownership until explicit recovery', () => {
    const blocked = path.join(tmp, 'not-a-directory'); fs.writeFileSync(blocked, 'blocked');
    expect(claimOffer('strict-probe', { dir: path.join(blocked, 'claims'), strict: true })).toBe(false);
    const claims = path.join(tmp, 'strict-claims');
    const owned=claimOffer('strict-probe', { dir: claims, now: 1000, strict: true, ownership: true });
    expect(owned.ownerToken).toBeTypeOf('string');
    expect(claimOffer('strict-probe', { dir: claims, now: 100000, ttlMs: 1, strict: true })).toBe(false);
    expect(releaseClaim('strict-probe', { dir: claims, ownership: owned })).toBe(true);
    expect(claimOffer('strict-probe', { dir: claims, strict: true })).toBe(true);
  });
});


it('P037 explicit RESET recovers an unknown claim but fences its old ownership receipt', () => {
  const dir = path.join(path.dirname(file), 'offer-claims');
  const stale=claimOffer('reset-delivery', { dir, strict: true, ownership: true });
  const claimFile=fs.readdirSync(dir).find(f=>f.endsWith('.claim'));
  fs.writeFileSync(path.join(dir,claimFile),'{unknown');
  expect(record({id:'reset-delivery',action:ACTIONS.RESET},{file}).ok).toBe(true);
  const successor=claimOffer('reset-delivery', { dir, strict: true, ownership: true });
  expect(successor.ownerToken).toBeTypeOf('string');
  expect(releaseClaim('reset-delivery', {dir,ownership:stale})).toBe(false);
  expect(record({id:'reset-delivery',action:ACTIONS.OFFERED},{file,ownership:stale}).ok).toBe(false);
  expect(releaseClaim('reset-delivery', {dir,ownership:successor})).toBe(true);
});

it('P037 RESET refuses a live owner without recording a false reset or removing its claim', () => {
  const dir=path.join(path.dirname(file),'offer-claims');
  const owned=claimOffer('live-reset',{dir,strict:true,ownership:true});
  const result=record({id:'live-reset',action:ACTIONS.RESET},{file,resetWaitMs:0});
  expect(result.ok).toBe(false);expect(result.reason).toBe('RESET_BUSY_UNCOMMITTED');
  expect(loadOutcomes(file).some(r=>r.action===ACTIONS.RESET)).toBe(false);
  expect(releaseClaim('live-reset',{dir,ownership:owned})).toBe(true);
  expect(record({id:'live-reset',action:ACTIONS.RESET},{file}).ok).toBe(true);
});

it('P037 explicit RESET recovers a genuinely terminated owned process claim', () => {
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    `import {claimOffer} from ${JSON.stringify(MODULE)};console.log(JSON.stringify(claimOffer('dead-reset',{dir:process.argv[1],strict:true,ownership:true})));`,
    path.join(path.dirname(file),'offer-claims')],{encoding:'utf8'});
  expect(child.status).toBe(0);expect(JSON.parse(child.stdout).ownerToken).toBeTypeOf('string');
  expect(record({id:'dead-reset',action:ACTIONS.RESET},{file}).ok).toBe(true);
});
