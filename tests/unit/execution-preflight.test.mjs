import { describe, expect, it } from 'vitest';
import { runExecutionPreflight } from '../../scripts/execution-preflight.mjs';

const now = Date.parse('2026-08-31T13:00:00.000Z');
const valid = {
  action: 'delegate', description: 'release rail audit', nativeHosts: ['codex'], activeHost: 'codex',
  now,
  groundingReceipt: { status: 'success', observedAt: '2026-08-31T12:45:00.000Z', sourceIdentity: 'a'.repeat(64) },
  memoryReceipt: { status: 'retrieved', observedAt: '2026-08-31T12:45:00.000Z', path: '/repo/.swarm/memory.db', key: 'project-state-current-1756645200000', valueDigest: 'b'.repeat(64) },
};

describe('enforced execution preflight', () => {
  it('allows only with fresh live grounding and exact AgentDB checkpoint evidence', () => {
    expect(runExecutionPreflight(valid)).toMatchObject({ verdict: 'ALLOW', executor: 'native:codex', evidence: { valid: true } });
  });

  it('refuses a plausible route when the live evidence is missing', () => {
    expect(runExecutionPreflight({ ...valid, groundingReceipt: undefined, memoryReceipt: undefined }))
      .toMatchObject({ verdict: 'REFUSE', reason: 'live-evidence-preflight-failed', evidence: { valid: false } });
  });

  it('refuses stale receipts instead of treating AgentDB presence as a current read', () => {
    expect(runExecutionPreflight({ ...valid, groundingReceipt: { ...valid.groundingReceipt, observedAt: '2026-08-30T13:00:00.000Z' } }))
      .toMatchObject({ verdict: 'REFUSE', evidence: { valid: false } });
  });

  it('refuses an API executor before any provider can be selected', () => {
    expect(runExecutionPreflight({ ...valid, requestedExecutor: 'agent_execute' }))
      .toMatchObject({ verdict: 'REFUSE', executor: 'native:codex' });
  });
});
