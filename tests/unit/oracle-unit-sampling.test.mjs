// tests/unit/oracle-unit-sampling.test.mjs
//
// ADR-086:248 "Deterministically stratify and select min(100, U) units across modules and source types",
// with the exact procedure the EXTEND_FIRST Dual verdict specified: one slot per nonempty stratum, then
// Hamilton (largest-remainder) allocation of the rest in proportion to remaining capacity; K strata by a
// seeded hash when strata outnumber slots; within a stratum, the prefix of SHA-256 order over the
// canonical tuple [seed, repository, tree, stratum, unit id].
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocate, moduleOf, selectUnits, stratumOf, ROOT_MODULE } from '../../scripts/oracle/unit-sampling.mjs';

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/oracle/unit-sampling.mjs');
const TREE = 'c'.repeat(40);

const unitsFor = (spec) => Object.entries(spec).flatMap(([stratum, count]) => {
  const [sourceType, module] = stratum.split('|');
  return Array.from({ length: count }, (_, i) => ({
    unitId: `${stratum}#${i}`, sourceType, path: module === ROOT_MODULE ? `file${i}.x` : `${module}/file${i}.x`,
  }));
});

describe('strata are (source type, module)', () => {
  it('assigns root files to the root module and everything else to its first path component', () => {
    expect(moduleOf('README.md')).toBe(ROOT_MODULE);
    expect(moduleOf('src/deep/a.ts')).toBe('src');
    expect(stratumOf({ unitId: 'u', sourceType: 'typescript', path: 'src/a.ts' })).toBe('typescript|src');
    expect(() => stratumOf({ unitId: 'u', path: 'a' })).toThrow(/no sourceType/);
  });
});

describe('Hamilton allocation', () => {
  it('matches a hand-computed allocation exactly: strata of 50, 30 and 21 units give 49, 30 and 21', () => {
    // K = min(100, 101) = 100. One slot each leaves 97. Capacities 49, 29, 20 (total 98).
    // Quotas 97*49/98 = 48.5, 97*29/98 = 28.70, 97*20/98 = 19.80 -> floors 48, 28, 19 (95).
    // Remainders (x98) 49, 69, 78 -> the 2 leftover slots go to C then B.
    const sizes = new Map([['A', 50], ['B', 30], ['C', 21]]);
    const { slots, omittedStrata } = allocate({ sizes, K: 100, seed: 's', repo: 'r', treeSha: TREE });
    expect(Object.fromEntries(slots)).toEqual({ A: 49, B: 30, C: 21 });
    expect(omittedStrata).toEqual([]);
  });

  it('gives every nonempty stratum at least one slot and never more than it holds', () => {
    const sizes = new Map([['big', 400], ['mid', 12], ['tiny', 1], ['one', 1]]);
    const { slots } = allocate({ sizes, K: 100, seed: 's', repo: 'r', treeSha: TREE });
    expect([...slots.values()].reduce((a, b) => a + b, 0)).toBe(100);
    for (const [id, n] of sizes) {
      expect(slots.get(id)).toBeGreaterThanOrEqual(1);
      expect(slots.get(id)).toBeLessThanOrEqual(n);
    }
  });

  it('when strata outnumber slots, picks exactly K strata one unit each and publishes the rest as omitted', () => {
    const sizes = new Map(Array.from({ length: 7 }, (_, i) => [`s${i}`, 3]));
    const { slots, omittedStrata } = allocate({ sizes, K: 4, seed: 's', repo: 'r', treeSha: TREE });
    expect([...slots.values()].filter((n) => n === 1)).toHaveLength(4);
    expect([...slots.values()].filter((n) => n === 0)).toHaveLength(3);
    expect(omittedStrata).toHaveLength(3);
  });

  it('refuses an impossible K', () => {
    expect(() => allocate({ sizes: new Map([['a', 2]]), K: 3, seed: 's', repo: 'r', treeSha: TREE })).toThrow(/cannot allocate/);
  });
});

describe('selectUnits', () => {
  it('selects K = min(100, U) distinct units, and all of them when U <= 100', () => {
    const small = selectUnits({ units: unitsFor({ 'markdown|(root)': 10, 'rust|src': 5 }), repo: 'r', treeSha: TREE });
    expect(small).toMatchObject({ U: 15, K: 15, N: 30 });
    expect(new Set(small.selected).size).toBe(15);
    const large = selectUnits({ units: unitsFor({ 'markdown|docs': 120, 'rust|src': 90 }), repo: 'r', treeSha: TREE });
    expect(large).toMatchObject({ U: 210, K: 100, N: 200 });
    expect(new Set(large.selected).size).toBe(100);
    expect(large.allocations.reduce((s, a) => s + a.selected, 0)).toBe(100);
  });

  it('is deterministic across a process boundary, and the seed genuinely changes the selection', () => {
    const units = unitsFor({ 'markdown|docs': 150, 'python|pkg': 60, 'rust|(root)': 25 });
    const script = `import { selectUnits } from ${JSON.stringify(MODULE)};
      const units = ${JSON.stringify(units)};
      process.stdout.write(JSON.stringify(selectUnits({ units, repo: 'r', treeSha: '${TREE}', seed: process.argv[1] })));`;
    const run = (seed) => spawnSync(process.execPath, ['--input-type=module', '-e', script, seed], { encoding: 'utf8' });
    const a = run('adr-086-c3/1');
    const b = run('adr-086-c3/1');
    const c = run('a-different-seed');
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(JSON.parse(c.stdout).selected).not.toEqual(JSON.parse(a.stdout).selected);
  });

  it('binds the selection to the tree: the same units under another tree select differently', () => {
    const units = unitsFor({ 'markdown|docs': 150, 'rust|src': 80 });
    const one = selectUnits({ units, repo: 'r', treeSha: TREE });
    const two = selectUnits({ units, repo: 'r', treeSha: 'd'.repeat(40) });
    expect(two.selected).not.toEqual(one.selected);
  });

  it('refuses duplicate unit ids and an unidentified sample', () => {
    const dup = [{ unitId: 'x', sourceType: 'md', path: 'a' }, { unitId: 'x', sourceType: 'md', path: 'b' }];
    expect(() => selectUnits({ units: dup, repo: 'r', treeSha: TREE })).toThrow(/duplicate unit id/);
    expect(() => selectUnits({ units: [], repo: '', treeSha: TREE })).toThrow(/repository and tree identity/);
  });
});
