import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insertSorted } from '../../scripts/card-from-source.mjs';

/**
 * `insertSorted()` decides "does this store already have a card?" by building a RegExp straight
 * from the store name. GitHub repo names may contain `.` — this corpus already has one, `ruv.io`
 * (`kb/capability-cards.md`) — and an un-escaped `.` in a RegExp matches any character, so the
 * check can false-positive-match an unrelated heading instead of doing an exact literal match.
 */
let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-insert-'));
  file = path.join(dir, 'capability-cards.md');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('insertSorted: exact-heading match, not regex-wildcard match', () => {
  it('TEETH: a name containing "." does not false-positive-match a differently-spelled heading', () => {
    // "ruv.io" is a REAL store name in this corpus. Seed a file with an UNRELATED heading that is
    // the same shape once "." is read as "any character" — "ruvXio" — and confirm the genuinely
    // absent "ruv.io" card still gets written rather than being mistaken for already-present.
    fs.writeFileSync(file, '## ruvxio\nAn unrelated store whose name happens to be the same length.\n');
    const wrote = insertSorted(file, '## ruv.io\nThe real card for the ruv.io store.\n', 'ruv.io');
    expect(wrote, 'ruv.io was never actually present — it must be written, not skipped').toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('The real card for the ruv.io store.');
  });

  it('a name is recognised as already-carded only on an exact heading match', () => {
    fs.writeFileSync(file, '## ruv.io\nAlready here.\n');
    const wrote = insertSorted(file, '## ruv.io\nA duplicate attempt.\n', 'ruv.io');
    expect(wrote).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('A duplicate attempt.');
  });

  it('never throws for any character GitHub permits in a repository name', () => {
    // GitHub repo names are restricted to ASCII letters, digits, ".", "-", "_" — all of which must
    // be safe to pass straight through, including "." which is also a regex metacharacter.
    fs.writeFileSync(file, '## seed\nbody\n');
    expect(() => insertSorted(file, '## a.b-c_d9\nbody\n', 'a.b-c_d9')).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toContain('## a.b-c_d9');
  });

  it('still inserts in sorted position after the escaping fix', () => {
    fs.writeFileSync(file, '## alpha\nfirst\n\n## zeta\nlast\n');
    insertSorted(file, '## middle\nmid\n', 'middle');
    const order = [...fs.readFileSync(file, 'utf8').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(order).toEqual(['alpha', 'middle', 'zeta']);
  });
});
