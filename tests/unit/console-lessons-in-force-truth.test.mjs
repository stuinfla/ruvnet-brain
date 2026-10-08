// tests/unit/console-lessons-in-force-truth.test.mjs — RNBC QA 2026-10-01.
//
// THE FAILURE THIS PINS. The lessons card filed every imported-owner row under "quarantined, not your
// policy" with a CHECKED BUT DISABLED switch and the words "It cannot be switched on" — while the gate
// (lessonsFor) delivers every ratified, un-demoted row regardless of source class. Measured on the
// owner's machine: 12 imported-owner rows were ratified, so the card's "55 on" chip and its
// "43 rules already in force" heading disagreed by exactly those 12, and the 12 that WERE in force had
// no working off switch. The card must describe what the gate enforces, and every enforced rule must
// be switchable off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-lessons-'));
const store = path.join(tmp, 'lessons.json');
const row = (id, sourceClass, status, extra = {}) => ({
  id,
  statement: `Rule ${id}: check the real source before stating the fact.`,
  trigger: 'assert-fact',
  enforcement: 'checklist',
  evidence: [{ observed: `fixture evidence for ${id}` }],
  origin: sourceClass === 'current-user' ? 'user-stated' : 'imported',
  sourceClass,
  status,
  ratifiedBy: status === 'candidate' ? null : 'user',
  demoted: false,
  ...extra,
});

let consoleMod;
let storeMod;
beforeAll(async () => {
  fs.writeFileSync(store, `${JSON.stringify({ version: 1, updated: new Date().toISOString(), lessons: [
    row('U1', 'current-user', 'ratified'),
    row('IMP-ON', 'imported-owner', 'ratified'),
    row('IMP-CAND', 'imported-owner', 'candidate'),
  ] }, null, 2)}\n`);
  process.env.RUVNET_LESSON_STORE = store;
  process.env.RUVNET_CONSOLE_ROOT = tmp;
  process.env.RUVNET_BRAIN_TEST = '1';
  storeMod = await import('../../plugin/scripts/lesson-store.mjs');
  consoleMod = await import('../../scripts/onboarding-console.mjs');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('lessons card states what the gate enforces', () => {
  it('precondition: current user policy is delivered and imported history stays quarantined', () => {
    const delivered = storeMod.lessonsFor('assert-fact', storeMod.loadLessons(store), { limit: 10 }).map((l) => l.id);
    expect(delivered).toContain('U1');
    expect(delivered).not.toContain('IMP-ON');
    expect(delivered).not.toContain('IMP-CAND');
  });

  it('ratified imported history stays visible and quarantined rather than counted as gate policy', () => {
    const out = consoleMod.gatherLessons();
    const byId = new Map(out.lessons.map((l) => [l.id, l]));
    expect(byId.get('IMP-ON').quarantined).toBe(true);
    const prior=fs.readFileSync(store);expect(consoleMod.setLesson({id:'IMP-ON',action:'demote'}).ok).toBe(false);expect(fs.readFileSync(store).equals(prior)).toBe(true);
    expect(byId.get('IMP-ON').ratified).toBe(true);
    // An unratified import is still quarantined: it cannot be ratified and the gate ignores it.
    expect(byId.get('IMP-CAND').quarantined).toBe(true);
    expect(byId.get('IMP-CAND').canRatify).toBe(false);
  });

  it('the "on" count equals the number of rules the gate can deliver', () => {
    const out = consoleMod.gatherLessons();
    const inForceListed = out.lessons.filter((l) => l.ratified && !l.demoted && !l.quarantined).length;
    expect(out.counts.active).toBe(inForceListed);
    expect(out.counts.active).toBe(1);
    expect(out.counts.quarantined).toBe(2);
  });

  it('current-user ratified policy demote and restore are an actual operational inverse', () => {
    const delivered = () => storeMod.lessonsFor('assert-fact', storeMod.loadLessons(store), { limit: 10 }).map((l) => l.id);
    // The exact verb the card's switch posts to /api/set-lesson.
    const off = consoleMod.setLesson({ id: 'U1', action: 'demote' });
    expect(off.ok, off.log).toBe(true);
    expect(delivered()).not.toContain('U1');
    const on = consoleMod.setLesson({ id: 'U1', action: 'restore' });
    expect(on.ok, on.log).toBe(true);
    expect(delivered()).toContain('U1');
    expect(delivered()).not.toContain('IMP-ON');
    // and ratification stays refused for imported history
    expect(consoleMod.setLesson({ id: 'IMP-CAND', action: 'ratify' }).ok).toBe(false);
  });
});

it('candidate ratification refuses before lesson bytes change and is not an offered UI action',()=>{
 const before=fs.readFileSync(store),out=consoleMod.gatherLessons();
 // Add a current-user candidate through the fixture document, not runtime policy.
 const data=JSON.parse(before);data.lessons.push(row('PRIVATE-CAND','current-user','candidate'));fs.writeFileSync(store,JSON.stringify(data));const prior=fs.readFileSync(store);const result=consoleMod.setLesson({id:'PRIVATE-CAND',action:'ratify'});expect(result.ok).toBe(false);expect(result.log).toMatch(/inverse.*unavailable|unavailable.*inverse/i);expect(fs.readFileSync(store).equals(prior)).toBe(true);const visible=consoleMod.gatherLessons().lessons.find(lesson=>lesson.id==='PRIVATE-CAND');expect(visible.canRatify).toBe(false);expect(visible.ratificationUnavailableReason).toMatch(/inverse|prior/i);
});
