// The census a code release carries changes every time a corpus generation does. release-qe requires each
// committed claim surface to state the candidate KB's exact chunk and store counts, and rejects the whole
// candidate on ONE stray number (4.3.37: a hand-typed "182 indexed stores and 143,682 source chunks" that the
// writer's patterns never matched). Whatever the current census is, every surface must agree with every other,
// so a claim the writer does not know about cannot sit beside claims it just rewrote.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CHUNK_SURFACES, SURFACE_CLAIM_RULES } from '../../scripts/claims-verify.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
// Phrasings the release check does not grade but a human reads as the same census.
const EXTRA = [
  { key: 'publicStores', re: /(?<![\d,])(\d{1,4})(\s+indexed\s+stores)/gi },
  { key: 'chunks', re: /(?<![\d,])(\d{1,3}(?:,\d{3})+)(\s+source\s+chunks)/gi },
];

function claims() {
  const found = [];
  for (const file of CHUNK_SURFACES) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const rule of [...SURFACE_CLAIM_RULES, ...EXTRA]) {
      for (const match of text.matchAll(rule.re)) {
        const groups = rule.groups ?? [{ i: 1 }];
        for (const group of groups) found.push({ file, key: rule.key, value: Number(match[group.i].replace(/,/g, '')) });
      }
    }
  }
  return found;
}

describe('census claims agree across every committed surface', () => {
  const found = claims();
  it('finds claims to compare (a vacuous pass would prove nothing)', () => {
    expect(found.filter(({ key }) => key === 'chunks').length).toBeGreaterThanOrEqual(4);
    expect(found.filter(({ key }) => key === 'publicStores').length).toBeGreaterThanOrEqual(3);
  });
  for (const key of ['chunks', 'publicStores', 'builtStores']) {
    it(`states one ${key} figure everywhere`, () => {
      const rows = found.filter((claim) => claim.key === key);
      const values = [...new Set(rows.map(({ value }) => value))];
      expect(values, rows.map(({ file, value }) => `${file}=${value}`).join(', ')).toHaveLength(rows.length ? 1 : 0);
    });
  }
});
