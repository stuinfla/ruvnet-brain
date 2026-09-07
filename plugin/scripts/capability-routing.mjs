// capability-routing.mjs — evidence-bound routing for proactive recommendations.
//
// This is deliberately a small policy layer over goal-match + capability-registry. It does not
// invent a second capability catalogue: every recommendation must name a row from the live audit,
// and every row must carry the audit's observation digest. The tool family is a routing preference,
// not a claim that the tool is installed or healthy.
import crypto from 'node:crypto';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// These are the existing RuvNet building blocks for the capability's job. A route is only metadata
// for the receipt and copy; execution remains the row's verified turnOn command.
export const TOOL_PREFERENCES = Object.freeze({
  'learning-hooks': ['ruflo'],
  'memory-distillation': ['agentdb', 'ruflo'],
  'workflow-pattern-learning': ['agentdb'],
  'cheap-model-routing': ['agentic-flow'],
  'cross-project-lessons': ['ruflo', 'agentdb'],
  'lessons-in-force': ['ruflo'],
  'harness-evolution': ['sparc', 'ruflo'],
  'write-gates': ['ruflo'],
  'session-capture': ['agentdb', 'ruflo'],
  'mcp-servers': ['ruflo'],
  'nightly-refresh': ['rvf', 'ruflo'],
});

export const hasToolPreference = (key) => Array.isArray(TOOL_PREFERENCES[key]) && TOOL_PREFERENCES[key].length > 0;

const evidenceDigest = (row) => row?.evidenceDigest || sha256(row?.evidence || '');

export function buildCapabilityRoutingReceipt({ prompt, matches, capabilities, observedAt = new Date().toISOString() } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || !Array.isArray(matches) || !Array.isArray(capabilities)) return null;
  const byKey = new Map(capabilities.filter((row) => row && typeof row.key === 'string').map((row) => [row.key, row]));
  const routes = [];
  for (const match of matches) {
    const key = typeof match?.capability === 'string' ? match.capability : match?.capability?.key;
    const row = byKey.get(key);
    const tools = TOOL_PREFERENCES[key];
    // No row, no digest, or no known RuvNet route means UNKNOWN — never a hand-rolled fallback.
    if (!row || !Array.isArray(tools) || !tools.length || typeof row.evidence !== 'string' || !row.evidence.trim()) continue;
    routes.push({ capability: key, tools, state: row.state, evidenceDigest: evidenceDigest(row), confidence: match.confidence });
  }
  if (!routes.length) return null;
  const payload = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-capability-routing',
    observedAt,
    promptDigest: sha256(prompt.trim().toLowerCase()),
    routes,
    verdict: 'PASS',
  };
  return { ...payload, receiptSha256: sha256(JSON.stringify(payload)) };
}

export function validateCapabilityRoutingReceipt(receipt) {
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== 'ruvnet-brain-capability-routing'
    || !Array.isArray(receipt.routes) || !receipt.routes.length || receipt.verdict !== 'PASS'
    || !/^[a-f0-9]{64}$/.test(String(receipt.promptDigest || ''))
    || !/^[a-f0-9]{64}$/.test(String(receipt.receiptSha256 || ''))) {
    throw new Error('capability routing receipt is malformed');
  }
  const { receiptSha256: _digest, ...payload } = receipt;
  if (sha256(JSON.stringify(payload)) !== receipt.receiptSha256) throw new Error('capability routing receipt digest mismatch');
  for (const route of receipt.routes) {
    if (!TOOL_PREFERENCES[route.capability] || !Array.isArray(route.tools)
      || route.tools.some((tool) => !TOOL_PREFERENCES[route.capability].includes(tool))
      || !/^[a-f0-9]{64}$/.test(String(route.evidenceDigest || ''))) throw new Error('capability routing route is not evidence-bound');
  }
  return receipt;
}
