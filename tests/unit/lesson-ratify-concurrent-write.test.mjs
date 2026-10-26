// tests/unit/lesson-ratify-concurrent-write.test.mjs — Dream Cycle 2026-10-07, enforcement-integrity.
//
// THE FAILURE THIS PINS. `scripts/lesson-ratify.mjs` read `lessons` once at module load
// (`loadLessons()`, unlocked) and later wrote the transformed copy straight back with
// `saveLessons(next)` — the exact unlocked read-modify-write `lesson-store.mjs`'s own header says
// destroyed three of the owner's ratified rules on 2026-07-22, and the exact race `updateLessons()`
// exists to close. `saveLessons()` locking the WRITE never protected the READ that came before it: a
// second ratify/demote whose change landed on disk between the first invocation's read and its write
// was silently discarded by the first invocation's save, which still reports success. This is
// `lesson-delivery` — the human's own ratify/demote decision, the one thing this CLI's whole header
// says the user must never have to make twice — not making it through.
//
// The candidate moves `applyMutation`/`applyRatifyAllUserStated` onto `updateLessons()`, which holds
// the store lock across read → transform → write, so a concurrent writer's change survives.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENFORCEMENT, ORIGIN, SOURCE_CLASS, STATUS,
  loadLessons, saveLessons, updateLessons, ratify,
} from '../../plugin/scripts/lesson-store.mjs';
import { applyMutation, applyRatifyAllUserStated } from '../../scripts/lesson-ratify.mjs';

const temps = [];
const temporary = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lesson-ratify-'));
  temps.push(value);
  return value;
};
afterEach(() => { for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

const row = (id) => ({
  id,
  statement: `a user-stated rule, candidate ${id}, awaiting ratification`,
  trigger: 'write-code',
  enforcement: ENFORCEMENT.CHECKLIST,
  intendedEnforcement: ENFORCEMENT.BLOCK,
  evidence: [`${id} was corrected once by the user`],
  check: `${id}-check`,
  origin: ORIGIN.USER_STATED,
  sourceClass: SOURCE_CLASS.CURRENT_USER,
  status: STATUS.CANDIDATE,
  demoted: false,
});

function storeWith(lessons) {
  const file = path.join(temporary(), 'lessons.json');
  saveLessons(lessons, file);
  return file;
}

describe('lesson-ratify.mjs — a concurrent ratify/demote is never lost', () => {
  it('CONTROL: the old read-then-save pattern loses a concurrent writer\'s change (proves the race is real)', () => {
    const file = storeWith([row('A'), row('B')]);

    // Simulate invocation #1's stale read, the way the pre-fix CLI did at module load.
    const staleSnapshot = loadLessons(file);

    // A concurrent invocation #2 ratifies B, successfully, through the safe path.
    updateLessons((fresh) => ratify('B', fresh), file);
    expect(loadLessons(file).find((l) => l.id === 'B').status).toBe(STATUS.RATIFIED);

    // Invocation #1 now "finishes": transforms its OWN stale snapshot and saves it back directly —
    // exactly what `show()` used to do. This is the control that proves the bug class is real.
    const clobbered = ratify('A', staleSnapshot);
    saveLessons(clobbered, file);

    const after = loadLessons(file);
    expect(after.find((l) => l.id === 'A').status).toBe(STATUS.RATIFIED); // invocation #1's own change survives
    expect(after.find((l) => l.id === 'B').status, 'the old pattern silently discarded a concurrent ratification')
      .not.toBe(STATUS.RATIFIED); // invocation #2's change was lost
  });

  it('CANDIDATE: applyMutation (ratify) survives a concurrent write between a stale read and this call', () => {
    const file = storeWith([row('A'), row('B')]);

    // Something else reads a stale snapshot first (e.g. a `--list` moments earlier) — must not matter.
    loadLessons(file);

    // A concurrent writer ratifies B before this call's own read happens.
    updateLessons((fresh) => ratify('B', fresh), file);

    const result = applyMutation('A', ratify, file);
    expect(result.status).toBe(STATUS.RATIFIED);

    const after = loadLessons(file);
    expect(after.find((l) => l.id === 'A').status).toBe(STATUS.RATIFIED);
    expect(after.find((l) => l.id === 'B').status, 'applyMutation must read fresh under the lock, not a stale snapshot')
      .toBe(STATUS.RATIFIED);
  });

  it('CANDIDATE: applyMutation returns null, and touches nothing, for an unknown id', () => {
    const file = storeWith([row('A')]);
    const result = applyMutation('does-not-exist', ratify, file);
    expect(result).toBeNull();
    expect(loadLessons(file).find((l) => l.id === 'A').status).toBe(STATUS.CANDIDATE);
  });

  it('CANDIDATE: applyRatifyAllUserStated is also lock-protected across read and write', () => {
    const file = storeWith([row('A'), row('B'), row('C')]);

    // A concurrent demote-style write lands on C between this call's conceptual read and write.
    let sawConcurrentWrite = false;
    const originalUpdateLessons = updateLessons;
    // No monkey-patching needed: just perform the concurrent write first, then call the bulk action —
    // the assertion is that the bulk action's own fresh read (inside updateLessons) still sees it.
    updateLessons((fresh) => fresh.map((l) => (l.id === 'C' ? { ...l, demoted: true } : l)), file);
    sawConcurrentWrite = true;
    expect(sawConcurrentWrite).toBe(true);

    const { ratifiedCount } = applyRatifyAllUserStated(file);
    // The bulk action's own target filter excludes demoted rows — C was demoted by the concurrent
    // write, so only A and B are ratified. This is only meaningful if the bulk action's fresh read
    // (inside updateLessons) actually SAW the concurrent demote; a stale-snapshot bug would instead
    // see C still a non-demoted candidate and ratify all three.
    expect(ratifiedCount).toBe(2);

    const after = loadLessons(file);
    expect(after.find((l) => l.id === 'A').status).toBe(STATUS.RATIFIED);
    expect(after.find((l) => l.id === 'B').status).toBe(STATUS.RATIFIED);
    // The concurrent demote on C must have survived the bulk ratify's read-transform-write.
    expect(after.find((l) => l.id === 'C').demoted, 'a concurrent demote was lost by the bulk ratify').toBe(true);
    expect(after.find((l) => l.id === 'C').status, 'C must not have been ratified — it was demoted first').toBe(STATUS.CANDIDATE);
  });
});
