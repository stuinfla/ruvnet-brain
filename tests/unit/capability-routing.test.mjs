import { describe, it, expect } from 'vitest';
import { buildCapabilityRoutingReceipt, validateCapabilityRoutingReceipt, TOOL_PREFERENCES } from '../../plugin/scripts/capability-routing.mjs';

const row = (key, state = 'off') => ({ key, state, evidence: `live audit evidence for ${key}`, evidenceDigest: 'a'.repeat(64) });

describe('evidence-bound proactive capability routing', () => {
  it('routes only audited capabilities to existing RuvNet building blocks', () => {
    const receipt = buildCapabilityRoutingReceipt({
      prompt: 'Claude keeps solving the same problem from scratch and never learns what worked',
      capabilities: [row('workflow-pattern-learning')],
      matches: [{ capability: { key: 'workflow-pattern-learning' }, confidence: 0.84 }],
    });
    expect(receipt.routes[0]).toMatchObject({ capability: 'workflow-pattern-learning', tools: ['agentdb'], evidenceDigest: 'a'.repeat(64) });
    expect(validateCapabilityRoutingReceipt(receipt)).toEqual(receipt);
  });

  it('returns no route for an unknown capability instead of hand-rolling a fallback', () => {
    expect(buildCapabilityRoutingReceipt({ prompt: 'x', capabilities: [row('made-up-capability')], matches: [{ capability: 'made-up-capability', confidence: 1 }] })).toBeNull();
  });

  it('rejects a tampered evidence-bound receipt', () => {
    const receipt = buildCapabilityRoutingReceipt({ prompt: 'x', capabilities: [row('cheap-model-routing')], matches: [{ capability: 'cheap-model-routing', confidence: 0.8 }] });
    receipt.routes[0].tools = ['hand-rolled-router'];
    expect(() => validateCapabilityRoutingReceipt(receipt)).toThrow(/digest|route/);
  });

  it('covers every proactive goal with a declared RuvNet route', () => {
    expect(Object.keys(TOOL_PREFERENCES)).toHaveLength(11);
  });
});
