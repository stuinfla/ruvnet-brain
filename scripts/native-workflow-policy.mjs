// Translate native domain actions into the one installed Ruflo authority.
// This authorizes actions; it does not establish completion eligibility.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function canonicalNativePolicyRoot(cwd) {
  const common = execFileSync('git', ['-C', fs.realpathSync(cwd), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return path.dirname(fs.realpathSync(common));
}

export function unboundNativePolicyEvidence() {
  return { enforced: false, status: 'UNKNOWN_UNBOUND', authorization: 'existing-native-and-ownership-guards-only' };
}

const loadInstalledRuntime = () => import(pathToFileURL(path.join(os.homedir(), '.npm-global/lib/node_modules/ruflo',
  'node_modules/@claude-flow/cli/dist/src/services/policy-runtime.js')).href);

/** Opt-in binding. Legacy/observe never become enforcement or approval. */
export function createNativeWorkflowPolicy({ runtime, loadRuntime = loadInstalledRuntime,
  resolveRoot = canonicalNativePolicyRoot, contextForAction = () => ({}) } = {}) {
  return async ({ stage, state }) => {
    if (!['launch', 'apply'].includes(stage)) throw new Error('Unknown native policy action');
    const authority = runtime || await loadRuntime();
    const projectRoot = resolveRoot(state.cwd);
    // Installed MCP authorization derives its root from process.cwd when a delegated envelope is present.
    if (process.env.CLAUDE_FLOW_CAPABILITY_ENVELOPE && resolveRoot(process.cwd()) !== projectRoot) {
      throw new Error('Native worker canonical policy root mismatch');
    }
    const policy = authority.loadPolicyState(projectRoot);
    if (!['legacy', 'observe', 'enforce'].includes(policy?.mode)) throw new Error('Native policy state UNKNOWN');
    const worker = state.worker;
    const supplied = await contextForAction({ stage, state, projectRoot });
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Native policy context UNKNOWN');
    const decision = await authority.authorizeMcpTool(`native.worker.${stage}`, {
      workerId: worker.id, host: worker.host, model: state.decision.model,
      ownership: worker.ownership,
    }, { projectRoot, approvalIds: supplied.approvalIds, evidence: supplied.evidence }, { actionType: `native.worker.${stage}`, concurrency: stage === 'launch' ? 1 : 0,
      network: stage === 'launch', destructive: stage === 'apply' });
    if (decision?.enforcedOutcome !== 'allowed' || decision.mode !== policy.mode || !decision.receiptId) {
      throw Object.assign(new Error('Native policy authorization denied or UNKNOWN'), { policyAuthorization: {
        enforced: false, actionBlocked: true, status: 'DENIED_OR_UNKNOWN', mode: decision?.mode ?? 'unknown',
        projectRoot, receiptId: decision?.receiptId ?? null, reason: decision?.reason ?? 'unknown', actionType: `native.worker.${stage}` } });
    }
    if (decision.mode !== 'enforce') return { enforced: false, status: `UNENFORCED_${decision.mode.toUpperCase()}`,
      mode: decision.mode, projectRoot, receiptId: decision.receiptId,
      authorization: 'domain-policy-unenforced; existing capability/native/ownership restrictions retained' };
    if (decision.outcome !== 'allowed'
      || !Array.isArray(decision.matchedRules) || !decision.matchedRules.length || !decision.receiptId) {
      throw Object.assign(new Error('Native policy authorization denied, unbound, or UNKNOWN'), { policyAuthorization: {
        enforced: false, actionBlocked: true, status: 'DENIED_OR_UNBOUND', mode: decision.mode, projectRoot,
        receiptId: decision.receiptId ?? null, reason: decision.reason ?? 'unbound', actionType: `native.worker.${stage}` } });
    }
    return { enforced: true, status: 'ENFORCED_AUTHORIZATION', mode: decision.mode, projectRoot,
      receiptId: decision.receiptId, matchedRules: decision.matchedRules, actionType: `native.worker.${stage}` };
  };
}
