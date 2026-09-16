import { describe, expect, it } from 'vitest';
import { classifyExecutionPolicy } from '../../scripts/execution-policy.mjs';

describe('knowledge-to-execution policy', () => {
  it('requires a swarm for an explicit swarm request', () => {
    expect(classifyExecutionPolicy({ action: 'delegate', explicitSwarm: true, nativeHosts: ['codex'] }))
      .toMatchObject({ verdict: 'ALLOW', swarmRequired: true, executor: 'native:codex' });
  });

  it('requires a swarm for three or more changed file surfaces', () => {
    expect(classifyExecutionPolicy({ action: 'delegate', changedFiles: ['a', 'b', 'c'], nativeHosts: ['claude'] }))
      .toMatchObject({ swarmRequired: true, swarmReason: 'three-or-more-independent-file-surfaces' });
  });

  it('classifies one sequential read as single-agent', () => {
    expect(classifyExecutionPolicy({ action: 'delegate', changedFiles: ['a'], nativeHosts: ['codex'] }))
      .toMatchObject({ swarmRequired: false, swarmReason: 'single-sequential-surface' });
  });

  it('refuses API-backed execution when a native host is available', () => {
    expect(classifyExecutionPolicy({ action: 'delegate', requestedExecutor: 'agent_execute', nativeHosts: ['claude'] }))
      .toMatchObject({ verdict: 'REFUSE', executor: 'native:claude' });
  });

  it('does not invent a native route when no host is authenticated', () => {
    expect(classifyExecutionPolicy({ action: 'delegate', requestedExecutor: 'agent_execute' }))
      .toMatchObject({ verdict: 'DEGRADED', executor: 'unknown' });
  });

  it('treats ADR and QA work as swarm-required', () => {
    expect(classifyExecutionPolicy({ action: 'delegate', description: 'reconcile ADR and QA architecture', nativeHosts: ['codex'] }))
      .toMatchObject({ swarmRequired: true, swarmReason: 'architecture-or-consequential-action' });
  });

  it('refuses an unsupported action instead of silently treating it as a read', () => {
    expect(classifyExecutionPolicy({ action: 'imagine' }))
      .toMatchObject({ verdict: 'REFUSE', reason: 'unsupported-action', swarmReason: 'invalid-action' });
  });

  it('accepts Windows canonical paths and append-only checkpoint slugs in evidence', () => {
    const now = Date.now();
    expect(classifyExecutionPolicy({
      action: 'write', enforceEvidence: true, now,
      groundingReceipt: { status: 'success', observedAt: new Date(now).toISOString(), sources: ['repo'] },
      memoryReceipt: {
        status: 'retrieved', observedAt: new Date(now).toISOString(),
        path: 'C:\\Project\\.swarm\\memory.db', key: 'project-state-current-123-slug', valueDigest: 'a'.repeat(64),
      },
    })).toMatchObject({ verdict: 'ALLOW' });
  });
});
