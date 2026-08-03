import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUNDLED_OWNER_SEED_IDS,
  ORIGIN,
  SOURCE_CLASS,
  STATUS,
  loadLessons,
  makeLesson,
  ratify,
} from '../../plugin/scripts/lesson-store.mjs';
import { SEED } from '../../scripts/lesson-seed.mjs';

const temps = [];
const temporary = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lesson-provenance-'));
  temps.push(value);
  return value;
};

afterEach(() => {
  for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('issue #83 — bundled owner lesson provenance', () => {
  it('a fresh personal store is empty and the installer has no seed mutation path', () => {
    expect(loadLessons(path.join(temporary(), 'lessons.json'))).toEqual([]);
    const installer = fs.readFileSync(path.resolve(import.meta.dirname, '../../bin/install.mjs'), 'utf8');
    expect(installer).not.toMatch(/lesson-seed\.mjs|saveLessons\(SEED/);
  });

  it('recognizes the exact legacy 12-row fingerprint and quarantines every imported owner row', () => {
    const file = path.join(temporary(), 'lessons.json');
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, lessons: SEED }, null, 2)}\n`);

    const loaded = loadLessons(file);
    expect(new Set(loaded.map((lesson) => lesson.id))).toEqual(BUNDLED_OWNER_SEED_IDS);
    expect(loaded).toHaveLength(12);
    expect(loaded.every((lesson) => lesson.sourceClass === SOURCE_CLASS.IMPORTED_OWNER)).toBe(true);
    expect(loaded.every((lesson) => lesson.origin === ORIGIN.IMPORTED && lesson.demoted)).toBe(true);
    expect(loaded.every((lesson) => lesson.status === STATUS.CANDIDATE)).toBe(true);
  });

  it('cannot ratify a quarantined owner import as current-user policy', () => {
    const imported = makeLesson({
      ...SEED[0],
      origin: ORIGIN.IMPORTED,
      sourceClass: SOURCE_CLASS.IMPORTED_OWNER,
      demoted: true,
    });
    expect(ratify(imported.id, [imported])).toEqual([imported]);
  });

  it('preserves ordinary current-user lessons outside the exact fingerprint', () => {
    const current = makeLesson({
      ...SEED[0],
      id: 'personal-rule',
      origin: ORIGIN.USER_STATED,
      sourceClass: SOURCE_CLASS.CURRENT_USER,
      demoted: false,
    });
    expect(current.origin).toBe(ORIGIN.USER_STATED);
    expect(current.sourceClass).toBe(SOURCE_CLASS.CURRENT_USER);
    expect(current.demoted).toBe(false);
  });
});
