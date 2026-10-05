import { test, expect } from 'vitest';
import { evaluateRouting, validateCases } from '../../scripts/model-routing-eval.mjs';

function row(id, minimumClass, maximumClass, risk, minimumRole) {
  return { id, group: 'test-fixture', request: `Original request ${id}`, rationale: 'Synthetic labeled evaluator fixture.',
    risk, expected: { minimumClass, maximumClass, minimumRole } };
}
const fixed = { generatedAt: '2026-10-04T00:00:00.000Z', clock: (() => { let n = 0; return () => n++; })() };

test('detects dangerous underrouting without letting benign underroute dilute its count', () => {
  const critical = { ...row('payment', 'hard', 'hard', 'critical', 'bounded-difficult-reasoning'), taskFacts: { scope: 'routine' } };
  const broad = row('broad', 'substantial', 'substantial', 'moderate', 'substantial-implementation');
  const report = evaluateRouting([critical, broad], { ...fixed, classifier: () => 'medium' });
  expect(report.metrics).toMatchObject({ cases: 2, failed: 2, underroute: 2, dangerousUnderroute: 1, needlessEscalation: 0 });
  expect(report.results[0]).toMatchObject({ request: critical.request, taskFacts: critical.taskFacts, observedClass: 'medium', verdict: 'FAIL' });
  expect(report.verdict).toBe('FAIL');
});

test('detects needless escalation but accepts a class within the independently labeled range', () => {
  const mechanical = row('copy', 'fast', 'fast', 'low', 'mechanical-work');
  const bounded = row('flexible', 'medium', 'substantial', 'moderate', 'ordinary-work');
  const report = evaluateRouting([mechanical, bounded], { ...fixed, classifier: (features) => features.taskHints.includes('copy') ? 'hard' : 'substantial' });
  expect(report.metrics).toMatchObject({ passed: 1, failed: 1, needlessEscalation: 1, dangerousUnderroute: 0 });
  expect(report.results[1].verdict).toBe('PASS');
  expect(report.nativeHandoff).toMatchObject({ status: 'unsupported', attempted: false, qualified: false });
});

test('reports classifier errors and unknown classes without claiming native qualification or successful routing', () => {
  const cases = ['throws', 'unknown'].map((id) => row(id, 'hard', 'hard', 'high', 'bounded-difficult-reasoning'));
  const report = evaluateRouting(cases, { ...fixed, classifier: (features) => {
    if (features.taskHints.includes('throws')) throw new Error('unavailable');
    return 'invented';
  } });
  expect(report.metrics).toMatchObject({ failed: 2, classifierErrors: 2, underroute: 0, dangerousUnderroute: 0 });
  expect(report.metrics.classificationLatencyMs).toMatchObject({ count: 2, median: 1, p95: 1, max: 1 });
  expect(report.results.map((result) => result.error)).toEqual(['unavailable', 'Classifier returned unknown class: invented']);
  expect(report.nativeHandoff.qualified).toBe(false);
});

test('rejects vacuous datasets, duplicate IDs, reversed class bounds, and role label contradictions', () => {
  const valid = row('fixture', 'medium', 'medium', 'moderate', 'ordinary-work');
  expect(() => validateCases([])).toThrow('at least one');
  expect(() => validateCases([valid, valid])).toThrow('unique');
  expect(() => validateCases([{ ...valid, expected: { ...valid.expected, minimumClass: 'hard' } }])).toThrow('range');
  expect(() => validateCases([{ ...valid, expected: { ...valid.expected, minimumRole: 'mechanical-work' } }])).toThrow('role');
});
