#!/usr/bin/env node
// One deterministic boundary between Brain knowledge and consequential execution.
// This module is deliberately pure: it never loads credentials, calls a provider, or mutates state.

const NATIVE_HOSTS = new Set(['claude', 'codex']);
const API_EXECUTORS = new Set(['agent_execute', 'sdk', 'openrouter', 'api']);
const ARCHITECTURE_TERMS = /\b(adr|ddd|architecture|release|deploy|qa|security|schema|migration)\b/i;
const CONSEQUENTIAL_ACTIONS = new Set(['delegate', 'write', 'release', 'external']);
const FRESHNESS_MS = 30 * 60 * 1000;

const hex64 = (value) => /^[a-f0-9]{64}$/i.test(String(value || ''));
const fresh = (value, now = Date.now()) => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) && time <= now && now - time <= FRESHNESS_MS;
};

/**
 * The classifier used to trust caller-supplied routing fields. That made a correct memory lesson
 * advisory: a caller could omit the live search and AgentDB read and still receive ALLOW. This is
 * the evidence boundary used by the executable preflight. Receipts are intentionally structural;
 * the producers (search_ruvnet and ruflo memory retrieve) own their contents and identities.
 */
export function validateEvidence(input = {}, now = Date.now()) {
  const failures = [];
  const grounding = input.groundingReceipt;
  const memory = input.memoryReceipt;
  if (!grounding || grounding.status !== 'success' || !fresh(grounding.observedAt, now)) {
    failures.push('fresh successful search_ruvnet receipt is required');
  } else if (!(Array.isArray(grounding.sources) && grounding.sources.length > 0)
    && !hex64(grounding.sourceIdentity)) {
    failures.push('grounding receipt must bind a source list or source identity');
  }
  if (!memory || memory.status !== 'retrieved' || !fresh(memory.observedAt, now)) {
    failures.push('fresh exact AgentDB checkpoint retrieval is required');
  } else {
    if (!String(memory.path || '').endsWith('/.swarm/memory.db')) failures.push('memory receipt must use the project .swarm/memory.db');
    if (!/^project-state-current-\d+$/.test(String(memory.key || ''))) failures.push('memory receipt must retrieve an append-only project-state-current key');
    if (!hex64(memory.valueDigest)) failures.push('memory receipt must bind the retrieved value digest');
  }
  return { valid: failures.length === 0, failures };
}

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

  const evidence = CONSEQUENTIAL_ACTIONS.has(action) && input.enforceEvidence === true
    ? validateEvidence(input, input.now ?? Date.now())
    : { valid: true, failures: [] };
  if (!evidence.valid) {
    return {
      schema: 'ruvnet-brain.execution-policy.v1',
      verdict: 'REFUSE', action, swarmRequired, swarmReason,
      executor: 'unknown', reason: 'live-evidence-preflight-failed', evidence,
    };
  }

  if (action !== 'delegate') {
    return {
      schema: 'ruvnet-brain.execution-policy.v1',
      verdict: 'ALLOW', action, swarmRequired, swarmReason, evidence,
      executor: 'current-agent', reason: 'delegation-not-requested',
    };
  }

  const nativeHost = NATIVE_HOSTS.has(input.activeHost) && nativeHosts.includes(input.activeHost)
    ? input.activeHost : nativeHosts[0] || null;
  if (API_EXECUTORS.has(requestedExecutor)) {
    return {
      schema: 'ruvnet-brain.execution-policy.v1',
      verdict: nativeHost ? 'REFUSE' : 'DEGRADED', action, swarmRequired, swarmReason, evidence,
      executor: nativeHost ? `native:${nativeHost}` : 'unknown',
      reason: nativeHost
        ? 'api-backed-executor-is-not-the-native-subscription-route'
        : 'no-authenticated-native-host-is-available',
    };
  }
  if (!nativeHost) {
    return {
      schema: 'ruvnet-brain.execution-policy.v1',
      verdict: 'DEGRADED', action, swarmRequired, swarmReason, executor: 'unknown', evidence,
      reason: 'no-authenticated-native-host-is-available',
    };
  }
  return {
    schema: 'ruvnet-brain.execution-policy.v1',
    verdict: 'ALLOW', action, swarmRequired, swarmReason, evidence,
    executor: `native:${nativeHost}`, reason: 'native-subscription-route-selected',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = process.argv[2] || '{}';
  let input;
  try { input = JSON.parse(raw); } catch { process.stderr.write('execution-policy: input must be JSON\n'); process.exit(2); }
  process.stdout.write(`${JSON.stringify(classifyExecutionPolicy(input))}\n`);
}
