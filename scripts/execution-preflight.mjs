#!/usr/bin/env node
// Enforced knowledge-to-execution boundary. The caller must provide receipts produced by the
// live Brain search and exact project AgentDB retrieval; prose, memory, and guessed host state do
// not satisfy this command.
import { classifyExecutionPolicy } from './execution-policy.mjs';

export function runExecutionPreflight(input = {}) {
  return classifyExecutionPolicy({ ...input, enforceEvidence: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input;
  try { input = JSON.parse(process.argv[2] || '{}'); }
  catch { process.stderr.write('execution-preflight: input must be JSON\n'); process.exit(2); }
  const result = runExecutionPreflight(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.verdict === 'ALLOW' ? 0 : 2);
}
