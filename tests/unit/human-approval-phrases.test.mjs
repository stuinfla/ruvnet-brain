// human-approval-phrases.test.mjs — 4.3.39 review #2: B12 missed the exact line it was written for
// because of markdown emphasis, and B6 exempted any line containing "never" anywhere.
import { describe, expect, it } from 'vitest';
import { approvalHits, HUMAN_APPROVAL_STEP, LOCAL_INSTRUCTION_DRIFT, plainText } from '../../scripts/human-approval-phrases.mjs';

describe('B12 — markdown emphasis no longer hides the phrase', () => {
  it('catches the old CLAUDE.md line "Every publish needs Stuart\'s approval** of the …"', () => {
    const line = '- **Every publish needs Stuart\'s approval** of the `Production – ruvnet-brain` deployment.';
    expect(approvalHits(line, LOCAL_INSTRUCTION_DRIFT, { allowNegation: false })).toEqual(["Stuart's approval of"]);
    expect(plainText(line)).not.toMatch(/[*`]/);
  });

  it('catches "approves the `Production` …" with code ticks, and owner-approved', () => {
    expect(approvalHits('The release agent waits until the owner approves the `Production – ruvnet-brain` run.')).not.toEqual([]);
    expect(approvalHits('Ship only the owner-approved code artifact.')).toEqual(['owner-approved']);
  });
});

describe('B6 — a negation counts only in the matched phrase\'s own clause', () => {
  it('"The owner approves the Production deployment; never skip it." is a hit', () => {
    expect(approvalHits('The owner approves the Production deployment; never skip it.')).not.toEqual([]);
  });

  it('negated statements of the rule itself are not hits', () => {
    for (const line of [
      'No human approves a release: the machine gates are the control.',
      'There is no required reviewer on the environment.',
      'The owner is never asked to approve the release deployment.',
      'Stuart is not asked to click anything; the publish job starts by itself.',
    ]) expect(approvalHits(line), line).toEqual([]);
  });

  it('the pattern itself is the one B6 runs', () => {
    expect(HUMAN_APPROVAL_STEP.test('required reviewer')).toBe(true);
  });
});
