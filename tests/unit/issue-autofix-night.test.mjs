// ADR-107 night: what one failed issue means. Every code family maps to exactly one of: stop the run, a private page
// (infrastructure), a security HOLD (urgent, reveals nothing publicly), or an honest public item; the breaker counts
// only failures that are the fix's own fault.
import { describe, expect, it } from 'vitest';
import { AutofixAbort, ABORT_CODES } from '../../scripts/issue-autofix-policy.mjs';
import { classifyFailure } from '../../scripts/issue-autofix-night.mjs';

const PLAN = { rootCause: { file: 'scripts/paths.mjs', line: 12, explanation: 'the path is joined with a slash' }, whatItNeeds: 'a decision on Windows paths' };
const ab = (stage, code, o) => new AutofixAbort(stage, code, 'PRIVATE-DETAIL', o);
const STOP = ['kill-switch-off', 'halted', 'deadline', 'sandbox-unavailable'];
const INFRA = ['agent-failed', 'agent-timeout', 'model-downgrade', 'window-closed', 'transient', 'lock-held', 'primary-checkout', 'forbidden-command', 'injection-scan-failed'];
const HOSTILE = ['security-finding', 'redteam-flagged', 'modules-tampered', 'injection-suspected'];
const BREAKER = ['test-validity', 'verify-not-resolved', 'verify-evidence-failed', 'diff-policy', 'not-editable', 'test-weakened', 'protected-path', 'plan-not-fixable', 'plan-high-risk', 'gate-failed'];

describe('classifyFailure', () => {
  it('every family is a real abort code (a typo would silently fall through to a public not-fixed)', () => {
    for (const c of [...STOP, ...INFRA, ...HOSTILE, ...BREAKER]) expect(ABORT_CODES, c).toContain(c);
  });
  for (const code of STOP) it(`${code} stops the whole run`, () => expect(classifyFailure(ab('S4', code), { plan: PLAN })).toEqual({ stop: true }));

  for (const code of INFRA) {
    it(`${code} is infrastructure: a private default page, nothing public, no breaker`, () => {
      expect(classifyFailure(ab('S4', code), { plan: PLAN })).toEqual({ item: null, page: { title: 'AUTOFIX ABORTED at S4', priority: 'default' }, breaker: false });
    });
  }

  for (const code of HOSTILE) {
    for (const stage of ['S3', 'S4', 'S5']) {
      it(`${code} at ${stage} is a security HOLD: urgent page, no breaker, an honest not-fixed that reveals nothing`, () => {
        const c = classifyFailure(ab(stage, code, { publicFindings: true }), { plan: PLAN });
        expect(c).toMatchObject({ hold: true, breaker: false, page: { title: 'AUTOFIX SECURITY HOLD', priority: 'urgent' }, item: { kind: 'not-fixed' } });
        expect(c.stop).toBeUndefined();
        const publicText = JSON.stringify([c.item, c.facts]);
        expect(publicText).not.toMatch(/secur|red.?team|malic|hostil|tamper|inject|scan|PRIVATE-DETAIL|node_modules/i);
        expect(c.item.fallback.whatItNeeds).toBe('a maintainer to review a change by hand.');
        expect(c.facts).toEqual({ verified: [], notVerified: ['a change that passes every check'] });
      });
    }
  }
  it('a hold still names the real root cause when the plan found one, and degrades without one', () => {
    expect(classifyFailure(ab('S4', 'redteam-flagged'), { plan: PLAN }).item.fallback.whatWasWrong).toBe('the path is joined with a slash (scripts/paths.mjs:12)');
    expect(classifyFailure(ab('S4', 'redteam-flagged'), {}).item.fallback.whatWasWrong).toBe('the cause is not yet pinned down.');
  });

  it('S3 with public findings and a root cause: findings, with the plan\'s whatItNeeds; breaker for plan codes', () => {
    for (const code of ['plan-not-fixable', 'plan-high-risk', 'protected-path']) {
      expect(classifyFailure(ab('S3', code, { publicFindings: true }), { plan: PLAN })).toEqual({ breaker: true,
        item: { kind: 'findings', fallback: { whatWasWrong: 'the path is joined with a slash (scripts/paths.mjs:12)', whatItNeeds: 'a decision on Windows paths' } } });
    }
  });
  it('S3 public findings but no root-cause text: a reply, not findings', () => {
    const c = classifyFailure(ab('S3', 'plan-not-fixable', { publicFindings: true }), { plan: { rootCause: { file: 'x', line: 3, explanation: '' } } });
    expect(c.item.kind).toBe('reply');
    expect(c.item.fallback.whatWasWrong).toMatch(/could not pin the cause down/);
  });
  it('S3 without public findings (silent plan): a reply that claims no fix, never findings', () => {
    const c = classifyFailure(ab('S3', 'plan-not-fixable', { publicFindings: false }), { plan: PLAN });
    expect(c).toMatchObject({ breaker: true, item: { kind: 'reply', fallback: { whatWasWrong: 'the path is joined with a slash (scripts/paths.mjs:12)', whatItNeeds: 'a decision on Windows paths' } } });
    expect(classifyFailure(ab('S3', 'plan-not-fixable'), {}).item.fallback.whatItNeeds).toBe('a maintainer to take a look.');
  });
  it('S5 NEEDS_OWNER with a root cause: findings; S5 without public findings: not-fixed', () => {
    expect(classifyFailure(ab('S5', 'verify-not-resolved', { publicFindings: true }), { plan: PLAN })).toMatchObject({ breaker: true, item: { kind: 'findings' } });
    expect(classifyFailure(ab('S5', 'verify-not-resolved'), { plan: PLAN })).toMatchObject({ breaker: true, item: { kind: 'not-fixed' } });
  });
  for (const code of ['test-validity', 'diff-policy', 'not-editable', 'test-weakened', 'gate-failed', 'verify-evidence-failed']) {
    it(`${code} at S4: an honest not-fixed and the breaker trips`, () => {
      const c = classifyFailure(ab('S4', code), { plan: PLAN });
      expect(c).toEqual({ breaker: true, facts: { verified: [], notVerified: ['a fix that passes every check'] },
        item: { kind: 'not-fixed', fallback: { whatWasWrong: 'the path is joined with a slash (scripts/paths.mjs:12)', whatItNeeds: 'a maintainer to finish or rethink the fix.' } } });
      expect(c.hold).toBeUndefined(); expect(c.page).toBeUndefined();
    });
  }
  it('a code outside every family is a not-fixed WITHOUT the breaker (only the fix\'s own faults count)', () => {
    expect(classifyFailure(ab('S4', 'push-failed'), { plan: PLAN })).toMatchObject({ breaker: false, item: { kind: 'not-fixed' } });
  });
  it('no plan: the verifier summary, else a plain sentence; line 0 drops the file:line', () => {
    expect(classifyFailure(ab('S5', 'verify-evidence-failed'), { verifySummary: 'the test did not exercise the bug' }).item.fallback.whatWasWrong).toBe('the test did not exercise the bug');
    expect(classifyFailure(ab('S4', 'test-validity'), {}).item.fallback.whatWasWrong).toBe('the cause is not yet pinned down.');
    expect(classifyFailure(ab('S4', 'test-validity'), { plan: { rootCause: { file: 'a.mjs', line: 0, explanation: 'unknown spot' } } }).item.fallback.whatWasWrong).toBe('unknown spot');
  });
  it('the private detail never reaches any public item', () => {
    for (const code of [...BREAKER, ...HOSTILE, 'push-failed']) {
      const c = classifyFailure(ab('S4', code), { plan: PLAN });
      expect(JSON.stringify(c.item ?? null), code).not.toContain('PRIVATE-DETAIL');
    }
  });
});

describe('classifyFailure: a plan that says already-fixed', () => {
  it('pages privately and posts nothing (a model guess about main is not said publicly)', async () => {
    const { classifyFailure } = await import('../../scripts/issue-autofix-night.mjs');
    const { AutofixAbort } = await import('../../scripts/issue-autofix-policy.mjs');
    const c = classifyFailure(new AutofixAbort('S3', 'plan-not-fixable', '', { publicFindings: true }),
      { plan: { classification: 'already-fixed', rootCause: { file: 'scripts/x.mjs', line: 3, explanation: 'fixed in 4.7.22' } } });
    expect(c.item).toBeNull();
    expect(c.page).toMatchObject({ title: 'AUTOFIX NEEDS OWNER' });
  });
});

