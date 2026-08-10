import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  actionKey, recordRefusal, report, resolve, sweepStale, abandonSession,
} from '../../plugin/scripts/decision-outcomes.mjs';

/**
 * ADR-067 §outcomes — the refusal ledger, and specifically the ways it could lie.
 *
 * ADR-066's honesty boundary said "obedience is not measured". This measures the one thing that
 * genuinely IS observable from a hook — what happened after a refusal — and the tests below are
 * mostly about the fabrication paths, because a metric that can only produce good news is worse than
 * no metric: it launders a failing guard as a working one.
 */
let dir; let ledger; let pending; let files;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-out-'));
  ledger = path.join(dir, 'outcomes.jsonl');
  pending = path.join(dir, 'pending.json');
  files = { ledger, pending };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const T = 1_754_800_000_000;   // fixed clock: the caller owns time, so these are hermetic

describe('the action key decides what counts as "the same thing again"', () => {
  it('keys a write on its target, not its content', () => {
    // A model that fixes a refusal usually changes the CONTENT and keeps the target. Keying on
    // content would score every correction as a brand-new action, making `repeated` unreachable —
    // a metric that structurally cannot report bad news.
    expect(actionKey('Write', { file_path: '/a/b.mjs', content: 'one' }))
      .toBe(actionKey('Write', { file_path: '/a/b.mjs', content: 'two' }));
  });

  it('keys bash on the command head, so an edited flag is still the same action', () => {
    expect(actionKey('Bash', { command: 'git commit -m "x"' }))
      .toBe(actionKey('Bash', { command: 'git commit -m "totally different"' }));
    expect(actionKey('Bash', { command: 'git push' }))
      .not.toBe(actionKey('Bash', { command: 'git commit -m x' }));
  });
});

describe('every refusal resolves to exactly one outcome', () => {
  it('a retry that succeeds is `corrected`', () => {
    recordRefusal({ session: 's', key: 'write:/a', policies: ['design-wall'], ts: T }, files);
    expect(resolve({ session: 's', key: 'write:/a', allowed: true, ts: T + 500 }, files)).toBe('corrected');
    const r = report(files);
    expect(r).toMatchObject({ refused: 1, corrected: 1, repeated: 0, abandoned: 0, open: 0 });
    expect(r.correctedRate).toBe(1);
  });

  it('a retry that is refused again is `repeated`', () => {
    recordRefusal({ session: 's', key: 'write:/a', policies: ['ground-before-write'], ts: T }, files);
    expect(resolve({ session: 's', key: 'write:/a', allowed: false, ts: T + 10 }, files)).toBe('repeated');
    expect(report(files)).toMatchObject({ corrected: 0, repeated: 1, correctedRate: 0 });
  });

  it('TEETH: an unresolved refusal becomes `abandoned` — never left outside the denominator', () => {
    // THE FABRICATION THIS BLOCKS. A walked-away-from refusal is the most likely outcome. If it
    // stayed `open`, correctedRate would be computed only over the actions someone bothered to
    // retry, which is "record only the wins" arriving through the back door.
    recordRefusal({ session: 'dead', key: 'write:/a', policies: ['design-wall'], ts: T }, files);
    recordRefusal({ session: 'dead', key: 'bash:git commit', policies: ['design-wall'], ts: T }, files);
    expect(report(files).open).toBe(2);
    expect(sweepStale({ session: 'alive', ts: T + 1000 }, files)).toBe(2);
    const r = report(files);
    expect(r.open).toBe(0);
    expect(r.abandoned).toBe(2);
    expect(r.resolved, 'abandoned MUST sit in the denominator').toBe(2);
    expect(r.correctedRate).toBe(0);
  });

  it('the CURRENT session keeps its debts open — a retry three calls later is a real outcome', () => {
    recordRefusal({ session: 's', key: 'write:/a', policies: ['x'], ts: T }, files);
    expect(sweepStale({ session: 's', ts: T + 1000 }, files)).toBe(0);
    expect(report(files).open).toBe(1);
    // …but not forever: an ancient debt in a long-lived session still closes.
    expect(sweepStale({ session: 's', ts: T + 7 * 60 * 60_000 }, files)).toBe(1);
    expect(report(files).abandoned).toBe(1);
  });

  it('abandonSession closes only its own session', () => {
    recordRefusal({ session: 'a', key: 'k1', policies: ['p'], ts: T }, files);
    recordRefusal({ session: 'b', key: 'k2', policies: ['p'], ts: T }, files);
    expect(abandonSession('a', T + 1, files)).toBe(1);
    expect(report(files).open).toBe(1);
  });
});

describe('the report cannot flatter itself', () => {
  it('TEETH: an empty ledger reports null, not 0% and not 100%', () => {
    // 0% would claim the guards are failing; 100% would claim they are perfect. Both are claims
    // about a measurement that has not happened.
    const r = report(files);
    expect(r.correctedRate).toBeNull();
    expect(r).toMatchObject({ refused: 0, resolved: 0, open: 0 });
  });

  it('resolving something that was never refused records nothing', () => {
    expect(resolve({ session: 's', key: 'write:/never', allowed: true, ts: T }, files)).toBeNull();
    expect(report(files)).toMatchObject({ refused: 0, corrected: 0 });
  });

  it('attributes outcomes per policy, so one bad guard cannot hide behind three good ones', () => {
    recordRefusal({ session: 's', key: 'k1', policies: ['design-wall'], ts: T }, files);
    resolve({ session: 's', key: 'k1', allowed: true, ts: T + 1 }, files);
    recordRefusal({ session: 's', key: 'k2', policies: ['hijack-ruvnet'], ts: T }, files);
    resolve({ session: 's', key: 'k2', allowed: false, ts: T + 1 }, files);
    const { byPolicy } = report(files);
    expect(byPolicy['design-wall']).toMatchObject({ corrected: 1, repeated: 0 });
    expect(byPolicy['hijack-ruvnet']).toMatchObject({ corrected: 0, repeated: 1 });
  });

  it('a write failure never throws — a ledger may not break a tool call', () => {
    const bad = { ledger: '/proc/nope/x.jsonl', pending: '/proc/nope/p.json' };
    expect(() => recordRefusal({ session: 's', key: 'k', policies: [], ts: T }, bad)).not.toThrow();
    expect(() => resolve({ session: 's', key: 'k', allowed: true, ts: T }, bad)).not.toThrow();
    expect(() => sweepStale({ session: 's', ts: T }, bad)).not.toThrow();
  });
});
