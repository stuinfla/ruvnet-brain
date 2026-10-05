import { describe, expect, it } from 'vitest';
import { buildWeeklyAssessment, WEEKLY_ANALYST_INSTRUCTION } from '../../scripts/model-weekly-assessment.mjs';
const NOW = Date.parse('2026-10-04T16:00:00Z');
const source = { url: 'https://artificialanalysis.ai/models/comparisons', checkedAt: new Date(NOW).toISOString(), sha256: 'a'.repeat(64) };
const row = (model, time = 100, intelligenceIndex = 50, effort = 'high') => ({ model, effort, sourceModelId: model,
  benchmark: { suite: 'artificial-analysis-intelligence-index', version: '4.3.2' }, identityEvidence: { model },
  quality: { intelligenceIndex }, benchmarks: [{ suite: 'terminalbench-4-0', score: 0.7 }],
  timePerTaskSeconds: time, costPerTaskUsd: 1, source });
const policy = { reviewedAt: source.checkedAt, routes: { codex: { fast: { model: 'gpt-baseline', effort: 'high' } }, 'claude-code': { fast: { model: 'claude-base', effort: 'high' }, codingEffort: 'high' } } };
const currency = { schemaVersion: 1, inventory: { checkedAt: source.checkedAt, discoveryOnly: true, models: Array(50).fill({}) },
  evaluations: { checkedAt: source.checkedAt, sources: [source], records: [row('gpt-baseline'), row('gpt-faster', 50), row('claude-base'), row('claude-other', 20)] }, lastAttempt: { status: 'complete' } };

describe('weekly deterministic assessment', () => {
  it('keeps providers separate and proposals unqualified while retaining policy', () => {
    const before = JSON.stringify(policy);
    const result = buildWeeklyAssessment({ currency, policy, priorPolicyBytes: before, now: NOW });
    expect(result.report.recommendations[0].shortlist.map((r) => r.model)).toEqual(['gpt-faster']);
    expect(result.proposal.applied).toBe(false); expect(result.proposal.status).toBe('unqualified');
    expect(result.proposal.candidateRoutes).toEqual(policy.routes);
    expect(JSON.stringify(policy)).toBe(before);
    expect(result.report.analystExecuted).toBe(false);
    expect(result.report.gaps).toContain('native-credit-fallback-disable-control-unverified');
  });
  it('never selects faster weaker or incomparable benchmarks and never authorizes discovery', () => {
    const changed = structuredClone(currency);
    changed.evaluations.records[1].quality.intelligenceIndex = 40;
    changed.evaluations.records.push({ ...row('gpt-unbound', 1), identityEvidence: null });
    changed.evaluations.records.push({ ...row('gpt-other-version', 1), benchmark: { suite: 'artificial-analysis-intelligence-index', version: '3.0' } });
    const r = buildWeeklyAssessment({ currency: changed, policy, now: NOW });
    expect(r.report.recommendations[0].shortlist).toEqual([]);
  });
  it('makes unchanged fresh assessments quiet without updating the allocation review', () => {
    const first = buildWeeklyAssessment({ currency, policy, priorPolicyBytes: JSON.stringify(policy), now: NOW });
    const second = buildWeeklyAssessment({ currency, policy, priorPolicyBytes: JSON.stringify(policy), now: NOW + 1000, previousAssessment: first.report });
    expect(second.report.notification.quiet).toBe(true);
    expect(second.report.notification.actionable).toBe(false);
    expect(policy.reviewedAt).toBe(source.checkedAt);
  });
  it('marks missing baseline evidence actionable and stores the full no-spend instruction', () => {
    const missing = buildWeeklyAssessment({ currency: { ...currency, evaluations: { ...currency.evaluations, records: [] } }, policy, now: NOW });
    expect(missing.report.notification.actionable).toBe(true);
    expect(missing.instruction).toBe(WEEKLY_ANALYST_INSTRUCTION);
    expect(missing.instruction).toContain('enforceable no-credit-fallback control');
  });
  it('covers every actual allocation including substantial and exceptional without treating settings as routes', () => {
    const extended = structuredClone(policy);
    extended.routes.codex.substantial = { model: 'gpt-baseline', effort: 'high' };
    extended.routes.codex.exceptional = { model: 'gpt-astra', effort: 'xhigh' };
    extended.routes.codex.nativeAgentRouting = { enabled: true, adapter: 'supervised' };
    extended.routes.codex.codingEffort = 'high';
    const r = buildWeeklyAssessment({ currency: { ...currency, evaluations: { ...currency.evaluations,
      records: [...currency.evaluations.records, row('gpt-astra', 200, 60, 'xhigh')] } }, policy: extended, now: NOW });
    expect(r.report.coverage).toHaveLength(4);
    expect(r.report.coverage.map((c) => `${c.host}.${c.taskClass}`)).toEqual(['codex.fast', 'codex.substantial', 'codex.exceptional', 'claude-code.fast']);
    expect(r.report.coverage.find((c) => c.taskClass === 'exceptional').independentCoverage).toBe('matched');
  });
  it('snapshots and hashes the effective instruction and changes the assessment signature when it changes', () => {
    const first = buildWeeklyAssessment({ currency, policy, now: NOW, instruction: 'Owner full mandate v1', instructionSource: 'effective-per-user-file' });
    const second = buildWeeklyAssessment({ currency, policy, now: NOW, instruction: 'Owner full mandate v2', previousAssessment: first.report });
    expect(first.instruction).toBe('Owner full mandate v1');
    expect(first.report.instructionSource).toBe('effective-per-user-file');
    expect(first.report.instructionSha256).not.toBe(second.report.instructionSha256);
    expect(first.report.signature).not.toBe(second.report.signature);
    expect(second.report.notification.changed).toBe(true);
  });

  it('shows coding-agent evidence separately without substituting its score for the model suite', () => {
    const r = buildWeeklyAssessment({ currency: { ...currency, agentSources: { records: [{ nativeHost: 'codex',
      model: 'gpt-baseline', effort: 'high', harness: 'Codex', configurationLabel: 'Codex high',
      benchmark: { suite: 'artificial-analysis-coding-agent-index', version: '1.5' }, codingAgentIndexFraction: 0.6,
      timePerTaskSeconds: 800, apiBenchmarkCostPerTaskUsd: 0.9, fallback: false, versions: { codex: '0.154.0' }, source }] } }, policy, now: NOW });
    expect(r.report.coverage[0].codingAgentEvidence.codingAgentIndexFraction).toBe(0.6);
    expect(r.report.coverage[0].evidence.intelligenceIndex).toBe(50);
    expect(r.proposal.applied).toBe(false);
  });

});
