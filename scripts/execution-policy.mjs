#!/usr/bin/env node
// One deterministic boundary between Brain knowledge and consequential execution.
// This module is deliberately pure: it never loads credentials, calls a provider, or mutates state.

const NATIVE_HOSTS = new Set(['claude', 'codex']);
const API_EXECUTORS = new Set(['agent_execute', 'sdk', 'openrouter', 'api']);
const ARCHITECTURE_TERMS = /\b(adr|ddd|architecture|release|deploy|qa|security|schema|migration)\b/i;

export function classifyExecutionPolicy(input = {}) {
  const action = String(input.action || 'read');
  const description = String(input.description || '');
  const changedFiles = [...new Set((input.changedFiles || []).map(String).filter(Boolean))];
  const nativeHosts = [...new Set((input.nativeHosts || []).map(String).filter((h) => NATIVE_HOSTS.has(h)))];
  const requestedExecutor = String(input.requestedExecutor || '');
  const explicitSwarm = input.explicitSwarm === true;
  const multiFile = changedFiles.length >= 3;
  const architectureTask = ARCHITECTURE_TERMS.test(description) || ['release', 'external'].includes(action);
  const swarmRequired = explicitSwarm || multiFile || architectureTask;
  const swarmReason = explicitSwarm
    ? 'explicit-swarm-request'
    : multiFile
      ? 'three-or-more-independent-file-surfaces'
      : architectureTask
        ? 'architecture-or-consequential-action'
        : 'single-sequential-surface';

  if (action !== 'delegate') {
    return {
      schema: 'ruvnet-brain.execution-policy.v1',
      verdict: 'ALLOW', action, swarmRequired, swarmReason,
      executor: 'current-agent', reason: 'delegation-not-requested',
    };
  }

  const nativeHost = NATIVE_HOSTS.has(input.activeHost) && nativeHosts.includes(input.activeHost)
    ? input.activeHost : nativeHosts[0] || null;
  if (API_EXECUTORS.has(requestedExecutor)) {
    return {
      schema: 'ruvnet-brain.execution-policy.v1',
      verdict: nativeHost ? 'REFUSE' : 'DEGRADED', action, swarmRequired, swarmReason,
      executor: nativeHost ? `native:${nativeHost}` : 'unknown',
      reason: nativeHost
        ? 'api-backed-executor-is-not-the-native-subscription-route'
        : 'no-authenticated-native-host-is-available',
    };
  }
  if (!nativeHost) {
    return {
      schema: 'ruvnet-brain.execution-policy.v1',
      verdict: 'DEGRADED', action, swarmRequired, swarmReason, executor: 'unknown',
      reason: 'no-authenticated-native-host-is-available',
    };
  }
  return {
    schema: 'ruvnet-brain.execution-policy.v1',
    verdict: 'ALLOW', action, swarmRequired, swarmReason,
    executor: `native:${nativeHost}`, reason: 'native-subscription-route-selected',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = process.argv[2] || '{}';
  let input;
  try { input = JSON.parse(raw); } catch { process.stderr.write('execution-policy: input must be JSON\n'); process.exit(2); }
  process.stdout.write(`${JSON.stringify(classifyExecutionPolicy(input))}\n`);
}
