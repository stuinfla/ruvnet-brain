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
});
