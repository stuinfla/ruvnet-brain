#!/usr/bin/env node
// Enforced knowledge-to-execution boundary. The caller must provide receipts produced by the
// live Brain search and exact project AgentDB retrieval; prose, memory, and guessed host state do
// not satisfy this command.
import { classifyExecutionPolicy } from './execution-policy.mjs';
import { DualWorkflowStore } from './dual-workflow-store.mjs';

export function runExecutionPreflight(input = {}, { cwd = process.cwd() } = {}) {
  const policy = classifyExecutionPolicy({ ...input, enforceEvidence: true });
  if (policy.verdict !== 'ALLOW' || policy.action === 'read') return policy;
  try {
    // Load the active plan from canonical project state, never from an optional caller flag.
    const dual = new DualWorkflowStore(cwd).preflight({
      jobId: input.jobId, changedFiles: input.changedFiles ?? [],
    });
    if (dual.managed && policy.action === 'write' && !input.changedFiles?.length) throw new Error('a Dual write must declare exact changed files');
    return { ...policy, dual };
  } catch (error) {
    return { ...policy, verdict: 'REFUSE', reason: 'dual-plan-preflight-failed',
      evidence: { valid: false, failures: [error.message] } };
  }
}

export function main(argv = process.argv.slice(2)) {
  let input;
  try { input = JSON.parse(argv[0] || '{}'); }
  catch { process.stderr.write('execution-preflight: input must be JSON\n'); return 2; }
  const result = runExecutionPreflight(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.verdict === 'ALLOW' ? 0 : 2;
}
if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
