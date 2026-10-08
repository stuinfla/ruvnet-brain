import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_WORKFLOW_SCHEMAS, claudeWorkflowResponse } from '../../scripts/model-routing-execution-adapters.mjs';
const requireInstalled = createRequire(path.join(os.homedir(), '.npm-global/lib/node_modules/ruflo/package.json'));
let ajv;
try { const Ajv = requireInstalled('ajv'); ajv = new Ajv({ strict: false }); } catch { /* Real schema-engine test is explicitly skipped where global Ruflo is absent. */ }
const criterion = { id: 'source-claim', assertion: 'The source states this exact rule', checkIds: ['source'],
  sourceClaim: { checkId: 'source', claim: 'The source states this exact rule' } };
const planner = { tasks: [{ id: 'inspect', instructions: 'Inspect actual source', mode: 'read', checkIds: ['source'], acceptanceCriteria: [criterion] }], unresolvedObligations: [] };
const sourceClaim = { criterionId: 'source-claim', checkId: 'source', claim: criterion.assertion,
  sourceRef: { path: 'source.mjs', digest: 'a'.repeat(64) }, originalPromptDigest: 'b'.repeat(64) };
const worker = { outcome: criterion.assertion, artifacts: [], decisions: [], risks: [], sourceClaims: [sourceClaim] };
const reviewer = { passed: true, artifactDigest: 'c'.repeat(64), findings: [], evidence: ['reviewed'],
  criterionCoverage: [{ taskId: 'inspect', criterionId: 'source-claim', checkIds: ['source'], passed: true, evidence: ['actual source'] }],
  coverage: ['entry', 'caller', 'consumer', 'config', 'error'].map(dimension => ({ dimension, state: 'covered', evidence: ['actual source'] })), omissions: [] };
const both = (role, value, expected) => {
  if (ajv) assert.equal(ajv.validate(CLAUDE_WORKFLOW_SCHEMAS[role], value), expected, JSON.stringify(ajv.errors));
  assert.equal(claudeWorkflowResponse(role).validateStructuredOutput(value), expected);
};
test('real JSON schema and native final validator admit exact planner/worker/reviewer contract', () => {
  both('planner', planner, true); both('worker', worker, true); both('reviewer', reviewer, true);
});
test('planner missing criteria/intake obligations or criterion fields is rejected by actual schema', () => {
  both('planner', { tasks: planner.tasks }, false);
  both('planner', { ...planner, tasks: [{ ...planner.tasks[0], acceptanceCriteria: undefined }] }, false);
  both('planner', { ...planner, tasks: [{ ...planner.tasks[0], acceptanceCriteria: [{ ...criterion, arbitrary: 'authority' }] }] }, false);
  both('planner', { ...planner, tasks: [{ ...planner.tasks[0], acceptanceCriteria: [{ ...criterion, checkIds: [] }] }] }, false);
  both('planner', { ...planner, unresolvedObligations: ['unaccounted scope'] }, true); // Service must block dispatch, not hide disclosure.
});
test('worker malformed source-claim provenance is rejected without inventing ownership', () => {
  both('worker', { ...worker, sourceClaims: [{ ...sourceClaim, originalPromptDigest: 'invalid' }] }, false);
  both('worker', { ...worker, sourceClaims: [{ ...sourceClaim, sourceRef: { path: 'source.mjs' } }] }, false);
});
test('passing review requires typed criterion/dimension/omission envelopes; negative verdict stays possible', () => {
  both('reviewer', { passed: false, artifactDigest: 'c'.repeat(64), findings: ['missing proof'], evidence: ['inspected'] }, true);
  both('reviewer', { passed: true, artifactDigest: 'c'.repeat(64), findings: [], evidence: ['inspected'] }, false);
  both('reviewer', { ...reviewer, coverage: reviewer.coverage.slice(1) }, false);
  both('reviewer', { ...reviewer, omissions: [{ relevant: true, sourceRef: { path: 'source.mjs', digest: 'd'.repeat(64) }, reason: 'unread relevant source' }] }, true); // Service must reject relevant omission.
});


test.skipIf(!ajv)('installed real JSON-schema engine compiles all exported native schemas', () => {
  for (const [role, value] of [['planner', planner], ['worker', worker], ['reviewer', reviewer]]) {
    const validate = ajv.compile(CLAUDE_WORKFLOW_SCHEMAS[role]); assert.equal(validate(value), true);
  }
});
