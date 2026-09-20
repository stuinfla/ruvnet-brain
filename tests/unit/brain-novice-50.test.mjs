import { describe, expect, it } from 'vitest';
import { NOVICE_QUESTIONS, grade } from '../../scripts/brain-novice-50.mjs';

describe('novice 50-question acceptance corpus', () => {
  it('contains exactly 50 unique, graded questions across broad and specific levels', () => {
    expect(NOVICE_QUESTIONS).toHaveLength(50);
    expect(new Set(NOVICE_QUESTIONS.map((item) => item.query)).size).toBe(50);
    expect(new Set(NOVICE_QUESTIONS.map((item) => item.category)).size).toBeGreaterThanOrEqual(10);
    for (const item of NOVICE_QUESTIONS) {
      expect(item.repo).toMatch(/^[a-z0-9-]+$/);
      expect(item.required).toBeInstanceOf(RegExp);
    }
  });

  it('does not call a useful-looking answer effective when it cites the wrong repository', () => {
    const spec = NOVICE_QUESTIONS.find((item) => item.repo === 'ruvector');
    const result = grade(spec, '#1 repo=concepts\npath : concepts/agentdb/CARD/agentdb-card\nHNSW vector search', 100, true);
    expect(result.keywordSignal).toBe(true);
    expect(result.cited).toBe(true);
    expect(result.expectedRepoCited).toBe(false);
    expect(result.effective).toBe(false);
  });

  it('does not count a refusal as success on an answerable novice question', () => {
    const spec = NOVICE_QUESTIONS.find((item) => item.repo === 'ruvector');
    const result = grade(spec, 'EVIDENCE: THIN. No source found.', 100, true);
    expect(result.honest).toBe(true);
    expect(result.effective).toBe(false);
  });

  it('does not call a negative-score expected-owner citation effective', () => {
    const spec = NOVICE_QUESTIONS.find((item) => item.repo === 'ruvector');
    const result = grade(spec, '#1 repo=ruvector ce=-2.66\npath : ruvector/real-but-unrelated.md\nHNSW vector search', 100, true);
    expect(result.expectedRepoCited).toBe(true);
    expect(result.keywordSignal).toBe(true);
    expect(result.abstained).toBe(true);
    expect(result.effective).toBe(false);
  });
});
