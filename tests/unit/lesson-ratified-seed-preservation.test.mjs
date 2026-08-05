// tests/unit/lesson-ratified-seed-preservation.test.mjs — issue #111.
//
// THE FAILURE THIS PINS. `loadLessons()` decided "this store is untouched bundled maintainer
// history" by fingerprinting the store's ID SET. A store seeded from the bundle carries those twelve
// IDs forever, so the predicate stayed true through every legitimate change it was supposed to
// detect — and the quarantine overwrite therefore re-ran on EVERY load, forcing each row's
// origin/sourceClass/status/demoted/ratifiedBy back to imported-candidate-demoted. Rows a person had
// ratified to `enforcement: block` then failed the store's own trust boundary against the origin the
// overwrite had just invented, and were dropped with a warning that read like a schema change.
//
// The reporter's store is reproduced exactly: twelve bundled IDs, five of them ratified by the
// console to block / user-stated / ratified. Every assertion below is about data the user owns
// surviving a read, because a store that un-teaches ratified rules on reload is the precise failure
// the file's own header ("you should never have to tell me twice") exists to prevent.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENFORCEMENT, ORIGIN, SOURCE_CLASS, STATUS,
  loadLessons, updateLessons,
} from '../../plugin/scripts/lesson-store.mjs';
import { SEED } from '../../scripts/lesson-seed.mjs';

const temps = [];
const temporary = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lesson-ratified-'));
  temps.push(value);
  return value;
};
afterEach(() => { for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

/** The rows the reporter had ratified — the five that carry a `check`, so `block` is legal for them. */
const RATIFIED_IDS = [
  'L01-verify-with-a-capable-channel',
  'L02-check-before-you-assert',
  'L05-version-is-the-update-signal',
  'L06-use-the-real-tool',
  'L07-blast-radius-not-social-comfort',
];

/** Exactly what the console writes when a person ratifies a bundled row to its intended force. */
const ratifiedRow = (seed) => ({
  ...seed,
  enforcement: ENFORCEMENT.BLOCK,
  origin: ORIGIN.USER_STATED,
  sourceClass: SOURCE_CLASS.CURRENT_USER,
  status: STATUS.RATIFIED,
  ratifiedBy: 'user',
  demoted: false,
});

/** The reporter's store: 12 bundled rows, 5 of them ratified, written to disk as JSON. */
function reporterStore() {
  const file = path.join(temporary(), 'lessons.json');
  const lessons = SEED.map((s) => (RATIFIED_IDS.includes(s.id) ? ratifiedRow(s) : s));
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, updated: new Date().toISOString(), lessons }, null, 2)}\n`);
  return file;
}

describe('issue #111 — a ratified bundled lesson survives every reload', () => {
  it('loads all twelve rows, not the seven the overwrite left behind', () => {
    const loaded = loadLessons(reporterStore());
    expect(loaded).toHaveLength(12);
    expect(loaded.map((l) => l.id).sort()).toEqual(SEED.map((s) => s.id).sort());
  });

  it('keeps the ratification the console recorded, on every one of the five', () => {
    const byId = new Map(loadLessons(reporterStore()).map((l) => [l.id, l]));
    for (const id of RATIFIED_IDS) {
      const l = byId.get(id);
      expect(l, `${id} was dropped on load`).toBeDefined();
      expect(l.enforcement, `${id} lost its enforcement`).toBe(ENFORCEMENT.BLOCK);
      expect(l.origin, `${id} lost its origin`).toBe(ORIGIN.USER_STATED);
      expect(l.sourceClass, `${id} lost its sourceClass`).toBe(SOURCE_CLASS.CURRENT_USER);
      expect(l.status, `${id} lost its ratification`).toBe(STATUS.RATIFIED);
      expect(l.ratifiedBy, `${id} lost who ratified it`).toBe('user');
      expect(l.demoted, `${id} was re-demoted`).toBe(false);
    }
  });

  it('is stable across reloads — reading is not a mutation', () => {
    const file = reporterStore();
    const before = fs.readFileSync(file, 'utf8');
    const first = loadLessons(file);
    const second = loadLessons(file);
    expect(second).toEqual(first);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  // The other direction, and the reason the overwrite exists at all (issue #83): a row nobody has
  // touched is still quarantined maintainer history, not the installing user's personal policy.
  it('still quarantines bundled rows that no person has ratified', () => {
    const file = path.join(temporary(), 'lessons.json');
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, lessons: SEED }, null, 2)}\n`);
    const loaded = loadLessons(file);
    expect(loaded).toHaveLength(12);
    expect(loaded.every((l) => l.sourceClass === SOURCE_CLASS.IMPORTED_OWNER)).toBe(true);
    expect(loaded.every((l) => l.origin === ORIGIN.IMPORTED && l.demoted)).toBe(true);
    expect(loaded.every((l) => l.status === STATUS.CANDIDATE)).toBe(true);
  });

  // The under-counting twin of the same fingerprint: a store holding the twelve bundled rows PLUS
  // the user's own lessons was not "exactly twelve", so nothing in it was ever quarantined.
  it('quarantines untouched bundled rows even when the user has added lessons of their own', () => {
    const file = path.join(temporary(), 'lessons.json');
    const mine = { ...SEED[2], id: 'my-own-rule', origin: ORIGIN.USER_STATED, sourceClass: SOURCE_CLASS.CURRENT_USER, demoted: false };
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, lessons: [...SEED, mine] }, null, 2)}\n`);
    const byId = new Map(loadLessons(file).map((l) => [l.id, l]));
    expect(byId.size).toBe(13);
    expect(byId.get('L03-research-before-recommending').sourceClass).toBe(SOURCE_CLASS.IMPORTED_OWNER);
    expect(byId.get('my-own-rule').sourceClass).toBe(SOURCE_CLASS.CURRENT_USER);
    expect(byId.get('my-own-rule').demoted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE COMPOUNDING SECOND BUG in the same report. updateLessons' shrink guard exists so a write can
// never silently lose a rule — but it measured against `loadLessons()`, which omits every row this
// version failed to validate. So the rows most at risk were invisible to the guard protecting them,
// and the next legitimate write erased them with no error at all. The store's own comment says an
// unparseable row is the EXPECTED case ("this is usually a schema change"), which is what makes this
// a data-loss path rather than a corner.
describe('issue #111 — a write cannot erase the rows this version could not parse', () => {
  /** A row from a future schema: `enforcement: 'quarantine'` is not in today's enum. */
  const futureRow = {
    id: 'L99-from-a-newer-schema',
    statement: 'A rule written by a later version of the schema, which this one cannot validate.',
    trigger: 'assert-fact',
    enforcement: 'quarantine',
    evidence: [{ observed: 'a future enforcement value' }],
  };

  const storeWith = (lessons) => {
    const file = path.join(temporary(), 'lessons.json');
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, lessons }, null, 2)}\n`);
    return file;
  };

  it('carries an unparseable row through a write, byte for byte', () => {
    const keeper = { ...SEED[2], id: 'keeper', origin: ORIGIN.USER_STATED, sourceClass: SOURCE_CLASS.CURRENT_USER, demoted: false };
    const file = storeWith([keeper, futureRow]);

    const res = updateLessons((fresh) => fresh, file);
    expect(res.ok).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).lessons;
    expect(onDisk.map((l) => l.id).sort()).toEqual(['keeper', 'L99-from-a-newer-schema'].sort());
    expect(onDisk.find((l) => l.id === 'L99-from-a-newer-schema')).toEqual(futureRow);
  });

  it('still refuses a transform that would drop a row it CAN parse', () => {
    const a = { ...SEED[2], id: 'a', origin: ORIGIN.USER_STATED, sourceClass: SOURCE_CLASS.CURRENT_USER, demoted: false };
    const b = { ...SEED[3], id: 'b', origin: ORIGIN.USER_STATED, sourceClass: SOURCE_CLASS.CURRENT_USER, demoted: false };
    const file = storeWith([a, b]);
    expect(() => updateLessons((fresh) => fresh.slice(1), file)).toThrow(/would drop 1 lesson/);
  });
});
