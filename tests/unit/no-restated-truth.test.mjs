import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE ONE RULE: A GATE MAY NEVER CONTAIN A COPY OF THE TRUTH IT CHECKS.
 *
 * Measured across all 76 issues this repo has ever received, 47% are one disease wearing two faces:
 *
 *     20  a gate that cannot pass, or never fires
 *     16  a surface that states something false
 *
 * Both come from the same act — restating a fact instead of deriving it. Every restatement is a
 * COPY, and a copy rots the moment reality moves. Then it fails in exactly two ways: the gate goes
 * red for a reason unrelated to what it guards, or it stays green while the thing it guards is wrong.
 *
 * The same fact was found spelled in multiple places in a single week:
 *   version equality — 8 sites (#123 fixed six, #126 was the seventh I missed)
 *   memory-db filename — 2 (#127)
 *   host-fixture env — 2, silently drifted (the post-publication seal failed on every release)
 *   repo-count detector — 2, writer and gate disagreeing by construction
 *   corpus census — hand-edited on three consecutive nightly rebuilds
 *
 * Gates that DERIVE — sync-version, claims-verify, doc-currency, and now sync-census — have produced
 * ZERO issues of this class. The pattern that works already exists; it just was not the default.
 *
 * WHY THIS IS A FREEZE AND NOT A SWEEP. Converting all 17 existing offenders at once is a large,
 * risky, low-information change, and this repo has been burned by exactly that kind of bulk edit.
 * Instead the debt is frozen: the 17 known files are listed, they may be REMOVED from the list by
 * converting them, and NO NEW ONE may be added. The bleeding stops today; the burn-down is
 * incremental and each step is provable on its own.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const UNIT = path.join(ROOT, 'tests', 'unit');
const DEBT_FILE = path.join(UNIT, '.restating-gates-debt.json');

/**
 * A RESTATED TRUTH is a literal standing in for something the repo can compute:
 *   toBe('4.0.28')            a version the manifest already knows
 *   toMatch(/updated: 2026-.../) a stamp doc-currency already derives
 *   toContain('138,140')      a census claims-verify already recomputes
 *
 * Deliberately narrow. It does NOT flag small integers (counts of test cases, array indices,
 * thresholds) — only shapes that have bitten: quoted version-ish strings, dated stamps, and
 * thousands-separated or 2+ digit magnitudes inside an assertion.
 */
const RESTATED = [
  /toBe\('\d[\d.]*(-[a-z0-9.]+)?'\)/,        // e.g. a pinned version string // sync-version-ignore: the example IS the pattern this gate detects
  /toMatch\(\/[^/]*\d{4}-\d{2}-\d{2}/,        // toMatch(/updated:\s*2026-08-02/)
  /toContain\('\d{2,}[\d,]*'\)/,              // toContain('138,140')
];

/**
 * The guard's own remediation, quoted verbatim in the failure message below: "If the literal
 * genuinely IS the fixture, add `sync-version-ignore` on the line and say why." A line carrying that
 * marker AS A COMMENT is the sanctioned way a new fixture literal passes this gate without going on
 * the frozen debt list. Strip such lines before testing so the marker is an actual gate input, not
 * prose the gate never reads. Requires the `//` prefix (not a bare substring match) so the marker
 * cannot be smuggled into a string literal under test to blanket-exempt a real offender sharing its
 * line — the same reason `no-restated-truth`'s own TEETH fixtures below are excluded by filename, not
 * by hoping their content never collides with an unrelated check.
 */
const SYNC_VERSION_IGNORE = /\/\/\s*sync-version-ignore\b/;
const stripSyncVersionIgnoredLines = (source) =>
  source
    .split('\n')
    .filter((line) => !SYNC_VERSION_IGNORE.test(line))
    .join('\n');

const isDebt = (source) => RESTATED.some((re) => re.test(stripSyncVersionIgnoredLines(source)));

const debt = JSON.parse(fs.readFileSync(DEBT_FILE, 'utf8'));
const frozen = new Set(debt.files);
const testFiles = fs.readdirSync(UNIT).filter((f) => f.endsWith('.test.mjs'));

describe('no restated truth — a gate may not spell a fact it could derive', () => {
  it('NO NEW gate restates a truth', () => {
    const offenders = testFiles.filter((file) => {
      // This file's TEETH fixtures necessarily CONTAIN the shapes it detects — the literal IS the
      // subject under test, exactly as repo-count.test.mjs documents for its own detector fixtures.
      // Excluding it is not an exemption from the rule; it is the rule not applying to its own spec.
      if (file === 'no-restated-truth.test.mjs') return false;
      if (frozen.has(file)) return false; // known debt, tracked separately below
      return isDebt(fs.readFileSync(path.join(UNIT, file), 'utf8'));
    });
    expect(
      offenders,
      'These gates spell a value the repo can compute. Derive it instead — read the manifest, call '
      + 'getVersion(), or use the same function the product uses. 47% of this repo\'s issue history '
      + 'is this exact mistake. If the literal genuinely IS the fixture, add `sync-version-ignore` '
      + 'on the line and say why.',
    ).toEqual([]);
  });

  it('the frozen debt list stays honest — no phantom entries', () => {
    // A debt list naming files that no longer exist would let a real offender hide behind a stale
    // name, and would slowly become fiction. Every entry must be a real file.
    const missing = debt.files.filter((f) => !fs.existsSync(path.join(UNIT, f)));
    expect(missing, 'remove entries whose file is gone').toEqual([]);
  });

  it('the debt only shrinks — an entry that no longer restates anything must be removed', () => {
    // This is the burn-down ratchet. When a gate is converted to derive, its entry must come off the
    // list, so the number is always a truthful count of remaining work rather than a permanent alibi.
    const cleaned = debt.files.filter((file) => {
      const p = path.join(UNIT, file);
      return fs.existsSync(p) && !isDebt(fs.readFileSync(p, 'utf8'));
    });
    expect(
      cleaned,
      `These gates no longer restate a truth — remove them from ${path.basename(DEBT_FILE)} so the `
      + 'debt count stays honest.',
    ).toEqual([]);
  });

  it('TEETH: the detector actually fires on the shapes that caused real issues', () => {
    // Every one of these is a literal that shipped, went stale, and produced a red build.
    expect(isDebt("expect(v).toBe('4.0.28')"), 'a frozen version').toBe(true);
    expect(isDebt('expect(ADR).toMatch(/updated:\\s*2026-08-02/i)'), 'a frozen ADR stamp').toBe(true);
    expect(isDebt("expect(readme).toContain('138,140')"), 'a frozen census number').toBe(true);
    // And must NOT fire on ordinary assertions, or it becomes noise people route around.
    expect(isDebt('expect(rows.length).toBe(3)'), 'a small count is not a restated truth').toBe(false);
    expect(isDebt("expect(state).toBe('aborted')"), 'a state name is not a number').toBe(false);
    expect(isDebt('expect(result.status).toBe(0)'), 'an exit code is not a restated truth').toBe(false);
  });

  it('TEETH: sync-version-ignore is a real gate input, not prose the gate never reads', () => {
    // The failure message on the first test in this file tells the author to add this exact marker.
    // Prove the marker actually changes the verdict, and that an identical unmarked line still does not.
    const unmarked = "expect(v).toBe('4.0.28');";
    const marked = "expect(v).toBe('4.0.28'); // sync-version-ignore: the example IS the fixture";
    expect(isDebt(unmarked), 'an unmarked restated truth must still be caught').toBe(true);
    expect(isDebt(marked), "the guard's own documented remediation must actually suppress the line it annotates").toBe(false);
    // A marker on an unrelated line must not blanket-exempt a real offender elsewhere in the same file.
    const mixedFile = [unmarked, marked].join('\n');
    expect(isDebt(mixedFile), 'one annotated line must not exempt a different, unmarked offending line').toBe(true);
    // The marker text appearing INSIDE a string under test — not as a `//` comment — must not smuggle
    // an exemption for a real, unrelated offender sharing that same line. Found live by an independent
    // adversarial critic reviewing this diff, 2026-08-22: a naive substring match on the raw line would
    // have let this through.
    const smuggled = "expect(v).toBe('4.0.28'); expect(x).toBe('sync-version-ignore');";
    expect(isDebt(smuggled), 'the marker text inside a string literal is not a comment and must not suppress the line').toBe(true);
  });
});
