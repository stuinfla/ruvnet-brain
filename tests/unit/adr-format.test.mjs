// tests/unit/adr-format.test.mjs — our ADRs must remain legible to the tool that verifies them.
//
// TWO REAL BUGS THIS PINS (both found 2026-07-09 by running ruflo-adr's real importer):
//
//  1. OURS. Every ADR wrote `**Status:** Accepted` — colon INSIDE the bold. ruflo-adr's parseStatus
//     matches `^\*\*Status\*\*:\s*([A-Za-z][A-Za-z\- ]*?)(?:\s*\(.*?\))?\s*$`. All 11 ADRs imported
//     as status "unknown". The hook tells us to treat ADRs as living plans; the tool that checks them
//     could not read one of them.
//
//  2. THEIRS (upstream, @claude-flow ruflo-adr/scripts/import.mjs). Its two id normalizers disagree:
//        parseId(filename "0011-…")   -> "ADR-0011"      (keeps 4 digits)
//        extractAdrRefs(body "ADR-0011") -> "ADR-011"    (.replace(/^0+(\d{3,})/,'$1') eats one zero)
//     So ANY repo with 4-digit ADR filenames gets 100% dangling cross-references. parseId prefers a
//     frontmatter `id:`, so each ADR carries the canonical 3-digit id the ref-extractor produces.
//     Remove that frontmatter and the graph silently empties — hence this test.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/adr');
const files = fs.readdirSync(ADR_DIR).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();

/** Exactly what ruflo-adr's extractAdrRefs() produces, so node ids and edge targets are one string. */
const canonicalId = (fourDigits) => `ADR-${String(fourDigits).padStart(3, '0').replace(/^0+(\d{3,})/, '$1')}`;

const read = (f) => fs.readFileSync(path.join(ADR_DIR, f), 'utf8');
const frontmatterId = (src) => (/^---\s*$([\s\S]*?)^---\s*$/m.exec(src)?.[1].match(/^id:\s*(\S+)/m) ?? [])[1];
const statusOf = (src) => (/^\*\*Status\*\*:\s*([A-Za-z][A-Za-z\- ]*?)(?:\s*\(.*?\))?\s*$/m.exec(src) ?? [])[1];
const relatedRefs = (src) => {
  const line = /^\*\*Related\*\*:\s*(.+)$/m.exec(src)?.[1] ?? '';
  return [...line.matchAll(/\bADR-?(\d+)\b/gi)].map((m) => canonicalId(m[1]));
};

const ALL_IDS = new Set(files.map((f) => canonicalId(f.slice(0, 4))));

describe('ADR corpus is machine-readable', () => {
  it('there are ADRs to check (a passing empty suite proves nothing)', () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  for (const f of files) {
    describe(f, () => {
      const src = read(f);

      it('carries a frontmatter id matching the canonical form the ref-extractor produces', () => {
        expect(frontmatterId(src)).toBe(canonicalId(f.slice(0, 4)));
      });

      it('has a Status line ruflo-adr can parse (colon OUTSIDE the bold)', () => {
        const s = statusOf(src);
        expect(s, `no parseable "**Status**: X" line in ${f}`).toBeTruthy();
        expect(['Proposed', 'Accepted', 'Implemented', 'Superseded', 'Deprecated']).toContain(s);
      });

      it('every **Related** reference resolves to an ADR that exists', () => {
        for (const ref of relatedRefs(src)) {
          expect(ALL_IDS.has(ref), `${f} references ${ref}, which does not exist`).toBe(true);
        }
      });
    });
  }
});

describe('the linter itself can fail', () => {
  it('rejects a colon inside the bold (the exact bug that blinded the importer)', () => {
    expect(statusOf('**Status:** Accepted (2026-06-27) · Origin: x')).toBeUndefined();
    expect(statusOf('**Status**: Accepted (2026-06-27)')).toBe('Accepted');
  });
  it('rejects a dangling Related ref', () => {
    expect(relatedRefs('**Related**: ADR-0002, ADR-9999').some((r) => !ALL_IDS.has(r))).toBe(true);
  });
  it('canonicalId collapses 4-digit to the ref-extractor form', () => {
    expect(canonicalId('0011')).toBe('ADR-011');
    expect(canonicalId('0002')).toBe('ADR-002');
  });
});
