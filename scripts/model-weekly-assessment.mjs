// DISTINCT-FROM: scripts/model-router-engine.mjs — dated evidence shortlist, never routing authority or model execution.
import { digest, currencyStatus } from './model-currency-evidence.mjs';

export const WEEKLY_ANALYST_INSTRUCTION = `Weekly model routing review
Priority: correctness first, subscription allowance second, task completion time third.
Research coding-agent workloads and model-only benchmarks as separate suites with harness/configuration versions.
Analyse OpenAI/Codex and Anthropic/Claude separately. Do not substitute one provider for the other.
Research current official model, effort, subscription and host support alongside independent benchmarks.
Keep public/API model discovery separate from native subscription access and exact returned model identity.
Compare exact models and supported efforts on comparable benchmark suites/versions; retain separate scores.
Distinguish API dollar prices, benchmark token/cost proxies, native subscription allowance and actual quota.
Preserve per-user explicit overrides, task requirements, coding effort rules, and prior reviewed allocation.
New discoveries must not become defaults without evidence for access, supported effort and correctness.
Save a dated report and a versioned proposal with source timestamps/digests and prior policy bytes preserved.
Standing authorization permits only evidence-qualified supported changes within native subscriptions.
Never use metered APIs, API billing keys, credits, overages, paid comparison runs or new spend.
Native subscription login alone does not prevent purchased-credit fallback after allowance exhaustion.
Require live ordinary-usage allowance plus an enforceable no-credit-fallback control before analyst inference.
If the native host cannot enforce that control, do not launch an analyst; report that specific gap.
Use supervised native subscription analyst execution only when its allowance/safety envelope is established.
Do not guess account telemetry, entitlement, correctness, optimality, usage savings or benchmark comparability.
Retain the established reviewed policy when evidence or quota telemetry is missing; annotate uncertainty.
Keep unchanged checks quiet. Surface actionable source failures, coverage regressions and qualified proposals.
Run weekly; if missed, catch up on the next active prompt without blocking the prompt or adding a daemon.
A deterministic shortlist is not a semantic analyst review. Report unimplemented analyst/backend/telemetry gaps.
`;
const providers = { codex: 'openai', 'claude-code': 'anthropic' };
const sameProvider = (model, host) => typeof model === 'string' && (host === 'codex' ? model.startsWith('gpt-') : model.startsWith('claude-'));
const terminal = (row) => row?.benchmarks?.find((b) => b.suite === 'terminalbench-4-0')?.score ?? null;
const summarize = (row) => row ? { model: row.model, effort: row.effort, sourceModelId: row.sourceModelId,
  benchmark: row.benchmark, intelligenceIndex: row.quality?.intelligenceIndex, terminalBench40: terminal(row),
  taskTimeSeconds: row.timePerTaskSeconds, apiBenchmarkCostPerTaskUsd: row.costPerTaskUsd, source: row.source } : null;

export function buildWeeklyAssessment({ currency, policy = null, priorPolicyBytes = null, now = Date.now(), previousAssessment = null, instruction = WEEKLY_ANALYST_INSTRUCTION, instructionSource = 'packaged-fallback' } = {}) {
  if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('weekly instruction must be nonempty text');
  const instructionSha256 = digest(instruction);
  const checkedAt = new Date(now).toISOString();
  const records = currency?.evaluations?.records ?? [];
  const gaps = ['semantic-native-analyst-not-run', 'current-subscription-allowance-unavailable',
    'native-credit-fallback-disable-control-unverified', 'task-specific-correctness-not-measured', 'official-docs-not-semantically-qualified', 'native-access-revalidation-not-run'];
  const coverage = []; const recommendations = [];
  for (const [host, provider] of Object.entries(providers)) {
    for (const [taskClass, selected] of Object.entries(policy?.routes?.[host] ?? {})) {
      if (!selected || typeof selected !== 'object' || typeof selected.model !== 'string' || typeof selected.effort !== 'string') continue;
      const current = selected ? records.find((r) => r.model === selected.model && r.effort === selected.effort) : null;
      const agent = selected ? currency?.agentSources?.records?.find((r) => r.nativeHost === host && r.model === selected.model && r.effort === selected.effort) : null;
      const alternatives = !current ? [] : records.filter((row) => sameProvider(row.model, host)
        && row.identityEvidence && row.benchmark?.suite === current.benchmark?.suite
        && row.benchmark?.version === current.benchmark?.version
        && Number.isFinite(terminal(row)) && Number.isFinite(terminal(current))
        && row.quality?.intelligenceIndex >= current.quality?.intelligenceIndex && terminal(row) >= terminal(current)
        && Number.isFinite(row.timePerTaskSeconds) && row.timePerTaskSeconds < current.timePerTaskSeconds
        && Number.isFinite(row.costPerTaskUsd) && row.costPerTaskUsd <= current.costPerTaskUsd);
      const shortlist = alternatives.sort((a, b) => a.timePerTaskSeconds - b.timePerTaskSeconds).map(summarize);
      coverage.push({ host, provider, taskClass, selected, evidence: summarize(current),
        codingAgentEvidence: agent ? { benchmark: agent.benchmark, harness: agent.harness, configurationLabel: agent.configurationLabel,
          codingAgentIndexFraction: agent.codingAgentIndexFraction, timePerTaskSeconds: agent.timePerTaskSeconds,
          apiBenchmarkCostPerTaskUsd: agent.apiBenchmarkCostPerTaskUsd, fallback: agent.fallback, versions: agent.versions, source: agent.source } : null,
        independentCoverage: current ? 'matched' : 'missing', officialPublicSources: (currency?.officialSources?.sources ?? []).filter((s) => s.provider === provider),
        nativeSubscriptionAccess: 'not revalidated', subscriptionAllowance: 'unknown', codingEffortRule: policy?.routes?.[host]?.codingEffort ?? null });
      recommendations.push({ host, taskClass, action: 'retain-reviewed-allocation', selected,
        shortlist, qualification: 'blocked', blockers: [...gaps],
        reason: shortlist.length ? 'Comparable benchmark shortlist warrants analyst review; no promotion authority inferred.' : 'No benchmark candidate dominates the baseline on correctness proxies, cost proxy and completion time.' });
    }
  }
  const priorPolicySha256 = priorPolicyBytes === null ? null : digest(priorPolicyBytes);
  const signature = digest(JSON.stringify({ priorPolicySha256, instructionSha256,
    coverage: coverage.map((c) => ({ host: c.host, taskClass: c.taskClass, independentCoverage: c.independentCoverage, codingAgentCovered: !!c.codingAgentEvidence })),
    recommendations: recommendations.map((r) => ({ host: r.host, taskClass: r.taskClass, selected: r.selected,
      shortlist: r.shortlist.map((s) => ({ model: s.model, effort: s.effort })) })) }));
  const changed = signature !== previousAssessment?.signature;
  const missingCoverage = coverage.filter((c) => c.selected && c.independentCoverage === 'missing');
  const actionable = !coverage.length || currencyStatus(currency, now).status === 'stale' || missingCoverage.length > 0;
  const report = { schemaVersion: 1, checkedAt, method: 'deterministic-comparable-benchmark-shortlist',
    analystExecuted: false, policyPreserved: true, priorPolicySha256, evidenceCurrency: currencyStatus(currency, now),
    instructionSha256, instructionSource,
    nativeAnalystSafety: { executed: false, noCreditFallbackEnforced: false,
      reason: 'Native subscription auth and ordinary usage allowance do not prove purchased credits cannot be consumed.' }, priorities: ['correctness', 'subscription allowance', 'completion time'],
    coverage, recommendations, gaps, signature, additionalCodingBenchmarkSources: currency?.agentSources?.additionalSources ?? [],
    notification: { actionable, quiet: !actionable && !changed, changed, reason: actionable ? 'source or route coverage needs attention' : changed ? 'new assessment available; no routing change qualified' : 'unchanged assessment' } };
  const proposal = { schemaVersion: 1, version: checkedAt, status: 'unqualified', applied: false,
    priorPolicySha256, candidateRoutes: policy?.routes ?? null, preserveOverrides: true,
    changes: [], recommendations, blockers: gaps, evidenceSignature: signature };
  const markdown = [`Model review — ${checkedAt}`, '',
    'Deterministic evidence assessment; no native analyst run or routing change.',
    'Priority: correctness, subscription allowance, completion time. Providers remain separate.', '',
    ...coverage.map((c) => `${c.provider} ${c.taskClass}: ${c.selected ? `${c.selected.model} / ${c.selected.effort}` : 'no allocation'}; independent coverage ${c.independentCoverage}; native allowance unknown.`),
    '', 'Qualification blockers:', ...gaps.map((g) => `- ${g}`), '',
    'API benchmark cost is a comparison proxy; it does not measure subscription usage. MODEL_OK smoke output proves neither task correctness nor quota.', ''].join('\n');
  return { report, proposal, markdown, instruction };
}
