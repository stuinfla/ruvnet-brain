import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  actionKey, recordRefusal, report, resolve, sweepStale, abandonSession,
} from '../../plugin/scripts/decision-outcomes.mjs';

const MODULE = path.resolve('plugin/scripts/decision-outcomes.mjs');

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
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

const T = 1_754_800_000_000;   // fixed clock: the caller owns time, so these are hermetic

describe('the action key decides what counts as "the same thing again"', () => {
  it('TEETH: the JavaScript source contains no raw NUL bytes', () => {
    // A raw NUL made Git and source tools classify this module as binary. The source escape keeps
    // the exact runtime separator without hiding implementation from review or instrumentation.
    expect(fs.readFileSync(MODULE).includes(0)).toBe(false);
    expect(fs.readFileSync(MODULE, 'utf8').match(/\\u0000/g).length).toBeGreaterThan(0);
  });

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
  it('an allowed pretool retry is admitted, while repair success remains unverified', () => {
    recordRefusal({ session: 's', key: 'write:/a', policies: ['design-wall'], ts: T }, files);
    expect(resolve({ session: 's', key: 'write:/a', allowed: true, ts: T + 500 }, files)).toBe('admitted-retry');
    const r = report(files);
    expect(r).toMatchObject({ refused: 1, admittedRetries: 1, repeated: 0, abandoned: 0, open: 0 });
    expect(r.admittedRetryRate).toBe(1); expect(r.correctedRate).toBeNull();
    expect(r.repairSuccessRate).toBeNull(); expect(r.metricBasis).toBe('pretool-admission-only');
  });

  it('a retry that is refused again is `repeated`', () => {
    recordRefusal({ session: 's', key: 'write:/a', policies: ['ground-before-write'], ts: T }, files);
    expect(resolve({ session: 's', key: 'write:/a', allowed: false, ts: T + 10 }, files)).toBe('repeated');
    expect(report(files)).toMatchObject({ admittedRetries: 0, repeated: 1, admittedRetryRate: 0, correctedRate: null });
  });

  it('TEETH: an unresolved refusal becomes `abandoned` — never left outside the denominator', () => {
    // THE FABRICATION THIS BLOCKS. A walked-away-from refusal is the most likely outcome. If it
    // stayed `open`, correctedRate would be computed only over the actions someone bothered to
    // retry, which is "record only the wins" arriving through the back door.
    recordRefusal({ session: 'dead', key: 'write:/a', policies: ['design-wall'], ts: T }, files);
    recordRefusal({ session: 'dead', key: 'bash:git commit', policies: ['design-wall'], ts: T }, files);
    expect(report(files).open).toBe(2);
    expect(sweepStale({ session: 'alive', ts: T + 1000 }, files)).toBe(0);
    expect(report(files).open).toBe(2);
    expect(abandonSession('dead', T + 1000, files)).toBe(2);
    const r = report(files);
    expect(r.open).toBe(0);
    expect(r.abandoned).toBe(2);
    expect(r.resolved, 'abandoned MUST sit in the denominator').toBe(2);
    expect(r.admittedRetryRate).toBe(0); expect(r.correctedRate).toBeNull();
  });

  it('the CURRENT session keeps its debts open — a retry three calls later is a real outcome', () => {
    recordRefusal({ session: 's', key: 'write:/a', policies: ['x'], ts: T }, files);
    expect(sweepStale({ session: 's', ts: T + 1000 }, files)).toBe(0);
    expect(report(files).open).toBe(1);
    // …but not forever: an ancient debt in a long-lived session still closes.
    expect(sweepStale({ session: 's', ts: T + 7 * 60 * 60_000 }, files)).toBe(1);
    expect(report(files)).toMatchObject({ abandoned: 0, expired: 1 });
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
    expect(report(files)).toMatchObject({ refused: 0, admittedRetries: 0 });
  });

  it('attributes outcomes per policy, so one bad guard cannot hide behind three good ones', () => {
    recordRefusal({ session: 's', key: 'k1', policies: ['design-wall'], ts: T }, files);
    resolve({ session: 's', key: 'k1', allowed: true, ts: T + 1 }, files);
    recordRefusal({ session: 's', key: 'k2', policies: ['hijack-ruvnet'], ts: T }, files);
    resolve({ session: 's', key: 'k2', allowed: false, ts: T + 1 }, files);
    const { byPolicy } = report(files);
    expect(byPolicy['design-wall']).toMatchObject({ admittedRetries: 1, repeated: 0 });
    expect(byPolicy['hijack-ruvnet']).toMatchObject({ admittedRetries: 0, repeated: 1 });
  });

  it('a write failure never throws — a ledger may not break a tool call', () => {
    // A regular file used as a parent produces an immediate, deterministic write failure on every
    // supported platform. `/proc/nope` was not an ordinary unwritable directory on Linux: Node 20's
    // recursive mkdir could block on procfs forever, hanging this file before Vitest flushed output.
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    const bad = { ledger: path.join(blocker, 'x.jsonl'), pending: path.join(blocker, 'p.json') };
    expect(() => recordRefusal({ session: 's', key: 'k', policies: [], ts: T }, bad)).not.toThrow();
    expect(() => resolve({ session: 's', key: 'k', allowed: true, ts: T }, bad)).not.toThrow();
    expect(() => sweepStale({ session: 's', ts: T }, bad)).not.toThrow();
  });
});

describe('scoped durable decision observations', () => {
  it('capacity defers new measurement without abandoning active debts or deleting foreign state', () => {
    const ownerNote = { text: 'synthetic foreign note' };
    const state = { ownerNote };
    for (let i = 0; i < 200; i++) state[`active-${i}`] = { session: 'active-' + i, key: 'k', policies: ['p'], ts: T };
    fs.writeFileSync(pending, JSON.stringify(state)); const before = fs.readFileSync(pending);
    expect(recordRefusal({ session: 'new', key: 'k', policies: ['p'], ts: T + 1 }, files)).toBe(false);
    expect(fs.readFileSync(pending)).toEqual(before); expect(fs.existsSync(ledger)).toBe(false);
    expect(report(files)).toMatchObject({ available: false, atCapacity: true, open: 200, abandoned: 0, foreignPendingRecords: 1 });
  });
  it('a missing pending snapshot recovers the fsynced refusal instead of losing its debt', () => {
    recordRefusal({ session: 's', key: 'k', policies: ['p'], ts: T }, files); fs.unlinkSync(pending);
    expect(report(files).open).toBe(1);
    expect(resolve({ session: 's', key: 'k', allowed: true, ts: T + 1 }, files)).toBe('admitted-retry');
    expect(report(files)).toMatchObject({ admittedRetries: 1, open: 0 });
  });
  it.each(['host', 'project'])('the same native session/action cannot borrow an allowed retry from another %s', kind => {
    const other = path.join(dir, 'other-project'); fs.mkdirSync(other);
    const scope = { host: 'codex', project: dir }, foreign = kind === 'host' ? { ...scope, host: 'claude' } : { ...scope, project: other };
    recordRefusal({ session: 's', key: 'bash:git push', policies: ['p'], ts: T, ...scope }, files);
    expect(resolve({ session: 's', key: 'bash:git push', allowed: true, ts: T + 1, ...foreign }, files)).toBeNull();
    expect(report(files)).toMatchObject({ open: 1, admittedRetries: 0 });
    expect(resolve({ session: 's', key: 'bash:git push', allowed: true, ts: T + 2, ...scope }, files)).toBe('admitted-retry');
  });
  it('unscoped historical debt is preserved instead of migrated into a newly scoped session', () => {
    recordRefusal({ session: 's', key: 'k', policies: ['p'], ts: T }, files); const before = fs.readFileSync(pending);
    expect(resolve({ session: 's', key: 'k', allowed: true, ts: T + 1, host: 'codex', project: dir }, files)).toBeNull();
    expect(fs.readFileSync(pending)).toEqual(before); expect(report(files).open).toBe(1);
  });
  it('an unknown admission verdict does not close debt or manufacture an admitted/repeated outcome', () => {
    recordRefusal({ session: 's', key: 'k', policies: ['p'], ts: T }, files);
    expect(resolve({ session: 's', key: 'k', ts: T + 1 }, files)).toBeNull();
    expect(report(files)).toMatchObject({ open: 1, admittedRetries: 0, repeated: 0 });
  });
  it('malformed pending data is unavailable and never replaced with an empty object', () => {
    const bytes = '{"owner-note":'; fs.writeFileSync(pending, bytes);
    expect(recordRefusal({ session: 's', key: 'k', policies: [], ts: T }, files)).toBe(false);
    expect(fs.readFileSync(pending, 'utf8')).toBe(bytes);
    expect(report(files)).toMatchObject({ available: false, admittedRetryRate: null, repairSuccessRate: null });
  });
  it('foreign pending records survive observation, expiry and explicit session closure', () => {
    const foreign = { ownerNote: { text: 'synthetic owner note', custom: true } }; fs.writeFileSync(pending, JSON.stringify(foreign));
    recordRefusal({ session: 's', key: 'k', policies: ['p'], ts: T }, files);
    sweepStale({ session: 'other', ts: T + 1000 }, files); abandonSession('s', T + 2000, files);
    expect(JSON.parse(fs.readFileSync(pending))).toEqual(foreign);
  });
  it('an owned held lock defers measurement without mutating ledger or pending bytes', () => {
    recordRefusal({ session: 'a', key: 'k', policies: ['p'], ts: T }, files);
    const before = [fs.readFileSync(ledger), fs.readFileSync(pending)]; fs.writeFileSync(ledger + '.lock', 'foreign owner');
    expect(recordRefusal({ session: 'b', key: 'x', policies: [], ts: T + 1 }, files)).toBe(false);
    expect(fs.readFileSync(ledger)).toEqual(before[0]); expect(fs.readFileSync(pending)).toEqual(before[1]);
    expect(fs.readFileSync(ledger + '.lock', 'utf8')).toBe('foreign owner');
  });
  it('existing historical corrected records are labeled as admissions without rewriting their bytes', () => {
    const raw = JSON.stringify({ kind: 'corrected', session: 's', key: 'k', policies: ['p'], ts: T }) + '\n'; fs.writeFileSync(ledger, raw);
    expect(report(files)).toMatchObject({ admittedRetries: 1, legacyCorrectedRecords: 1, correctedRate: null, repairSuccessRate: null });
    expect(fs.readFileSync(ledger, 'utf8')).toBe(raw);
  });
  it('an append capacity boundary never truncates foreign or historical ledger records', () => {
    const raw = JSON.stringify({ kind: 'owner-record', note: 'x'.repeat((1 << 20) + 1) }) + '\n'; fs.writeFileSync(ledger, raw);
    expect(recordRefusal({ session: 's', key: 'k', policies: [], ts: T }, files)).toBe(false);
    expect(fs.readFileSync(ledger, 'utf8')).toBe(raw); expect(report(files).available).toBe(false);
  });
  it('crash-shaped pending snapshot lag cannot duplicate an admitted retry', () => {
    recordRefusal({ session: 's', key: 'k', policies: ['p'], ts: T }, files); const before = fs.readFileSync(pending);
    resolve({ session: 's', key: 'k', allowed: true, ts: T + 1 }, files);
    fs.writeFileSync(pending, before); // ledger fsync survived, pending rename did not
    expect(resolve({ session: 's', key: 'k', allowed: true, ts: T + 2 }, files)).toBeNull();
    expect(report(files)).toMatchObject({ admittedRetries: 1, open: 0 });
  });
  it('four overlapping native processes retain every measured refusal and session debt', async () => {
    const code = `import {recordRefusal} from ${JSON.stringify(new URL('../../plugin/scripts/decision-outcomes.mjs', import.meta.url).href)}; const files=JSON.parse(process.argv[1]); const session=process.argv[2]; const deadlineAt=Date.now()+5000; for(let i=0;i<12;i++){if(!recordRefusal({session,key:'k'+i,policies:['p'],ts:${T}+i,deadlineAt,nonBlocking:false},files))process.exitCode=2;}`;
    await Promise.all(['a','b','c','d'].map(session => new Promise((resolveDone, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(files), session], { stdio: ['ignore','pipe','pipe'] });
      let error=''; child.stderr.on('data', bytes => { error += bytes; }); child.on('error', reject);
      child.on('exit', code => { if(code!==0)reject(new Error(error || 'measurement deferred')); else resolveDone(); });
    })));
    expect(report(files)).toMatchObject({ refused: 48, open: 48, abandoned: 0 });
    expect(Object.keys(JSON.parse(fs.readFileSync(pending))).length).toBe(48);
  });
});

describe('reviewed metric shape and blocking-policy budget boundaries', () => {
  it.each(['admitted-retry', 'corrected', 'refused', 'repeated', 'abandoned', 'expired'])('a malformed recognized %s record makes measurement unavailable without rewriting it', kind => {
    const bytes = JSON.stringify({ kind }) + '\n'; fs.writeFileSync(ledger, bytes);
    const result = report(files); expect(result).toMatchObject({ available: false, admittedRetryRate: null, repairSuccessRate: null });
    expect(result.admittedRetries).toBeUndefined(); expect(fs.readFileSync(ledger, 'utf8')).toBe(bytes);
  });
  it('one near-expired shared budget and default nonblocking calls cannot wait through a held measurement lock', () => {
    recordRefusal({ session: 's', key: 'k', policies: ['p'], ts: T }, files);
    const before = [fs.readFileSync(ledger), fs.readFileSync(pending)]; fs.writeFileSync(ledger + '.lock', 'active owner');
    const started = Date.now(), deadlineAt = started + 10;
    expect(sweepStale({ session: 's', ts: T + 1, deadlineAt }, files)).toBe(0);
    expect(resolve({ session: 's', key: 'k', allowed: true, ts: T + 1, deadlineAt }, files)).toBeNull();
    expect(recordRefusal({ session: 's', key: 'other', policies: [], ts: T + 1, deadlineAt }, files)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200); expect(fs.readFileSync(ledger)).toEqual(before[0]); expect(fs.readFileSync(pending)).toEqual(before[1]);
  });
  it('an expired metric budget never acquires state or writes an observation', () => {
    const deadlineAt = Date.now() - 1;
    expect(recordRefusal({ session: 's', key: 'k', policies: ['p'], ts: T, deadlineAt }, files)).toBe(false);
    expect(fs.existsSync(ledger)).toBe(false); expect(fs.existsSync(pending)).toBe(false);
  });
});
