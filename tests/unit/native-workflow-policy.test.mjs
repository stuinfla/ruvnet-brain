import { test, vi } from 'vitest';
import * as controlledClaude from '../../scripts/claude-controlled-terminal.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { evaluateCandidateReceipt, REQUIRED_CHECKS } from '../../scripts/release-proof.mjs';
import { validateProtectedPublishEnvironment } from '../../scripts/protected-release-invocation.mjs';
import { getVersion } from '../../scripts/version.mjs';
import { pathToFileURL } from 'node:url';
import { canonicalNativePolicyRoot, createNativeWorkflowPolicy } from '../../scripts/native-workflow-policy.mjs';
import { createGuardedWorkflowAdapters } from '../../scripts/model-routing-execution-adapters.mjs';

const state = { cwd: process.cwd(), worker: { id: 'w1', host: 'codex', ownership: { mode: 'read' } }, decision: { model: 'fixture-model' } };
const runtime = (mode, decision, calls = []) => ({ loadPolicyState: () => ({ mode }),
  authorizeMcpTool: async (...args) => { calls.push(args); return decision; } });

test('legacy and observe allowed never establish domain enforcement; capability denial still blocks', async () => {
  for (const mode of ['legacy', 'observe']) {
    const calls = [];
    const bind = createNativeWorkflowPolicy({ runtime: runtime(mode, { mode, outcome: 'denied', enforcedOutcome: 'allowed', receiptId: 'r1' }, calls), resolveRoot: () => '/canonical' });
    const evidence = await bind({ stage: 'launch', state });
    assert.equal(evidence.enforced, false); assert.equal(evidence.status, `UNENFORCED_${mode.toUpperCase()}`);
    assert.equal(calls[0][2].projectRoot, '/canonical'); assert.equal(calls[0][3].actionType, 'native.worker.launch');
    const deny = createNativeWorkflowPolicy({ runtime: runtime(mode, { mode, outcome: 'denied', enforcedOutcome: 'denied', receiptId: 'r2' }), resolveRoot: () => '/canonical' });
    await assert.rejects(deny({ stage: 'launch', state }), /denied/);
  }
});

test('unknown mode, missing receipt, missing matching rules and unenforced allow fail closed when bound', async () => {
  for (const [mode, decision] of [['unknown', {}], ['enforce', { mode: 'enforce', outcome: 'allowed', enforcedOutcome: 'allowed' }],
    ['enforce', { mode: 'enforce', outcome: 'allowed', enforcedOutcome: 'allowed', receiptId: 'r', matchedRules: [] }],
    ['enforce', { mode: 'observe', outcome: 'allowed', enforcedOutcome: 'allowed', receiptId: 'r', matchedRules: ['allow'] }]]) {
    const bind = createNativeWorkflowPolicy({ runtime: runtime(mode, decision), resolveRoot: () => '/canonical' });
    await assert.rejects(bind({ stage: 'apply', state }), /UNKNOWN|unbound/);
  }
});

test('enforced decision evidence binds native action and preserves existing request ownership', async () => {
  const calls = [], bind = createNativeWorkflowPolicy({ runtime: runtime('enforce', {
    mode: 'enforce', outcome: 'allowed', enforcedOutcome: 'allowed', receiptId: 'canonical-receipt', matchedRules: ['native-read'] }, calls), resolveRoot: () => '/canonical' });
  const evidence = await bind({ stage: 'apply', state });
  assert.equal(evidence.enforced, true); assert.equal(evidence.receiptId, 'canonical-receipt');
  assert.deepEqual(calls[0][1].ownership, state.worker.ownership);
  assert.equal(calls[0][3].destructive, true);
  assert.equal(calls[0][2].approvalIds, undefined); // Adapter never fabricates approval.
});

test.skipIf(!fs.existsSync(path.join(os.homedir(), '.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/policy-runtime.js')))('linked worktree uses common-root installed runtime state, without evaluating owner authority', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-policy-root-')), repo = path.join(dir, 'repo'), work = path.join(dir, 'worker');
  try {
    fs.mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', '-q', work]);
    assert.equal(canonicalNativePolicyRoot(work), fs.realpathSync(repo));
    const installed = await import(pathToFileURL(path.join(os.homedir(), '.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/policy-runtime.js')).href);
    const snapshot = installed.loadPolicyState(canonicalNativePolicyRoot(work));
    assert.equal(snapshot.mode, 'legacy'); assert.equal(snapshot.rules.length, 0);
    assert.equal(fs.existsSync(path.join(repo, '.claude-flow/policy/state.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('default native route reports unbound policy and bound refusal prevents executor side effect', async () => {
  let launches = 0;
  const request = { originalPrompt: 'Read context', cwd: process.cwd(), permissions: { write: false } };
  const worker = { id: 'w', host: 'codex', role: 'developer', activity: 'implementation', configuredModel: 'fixture-model',
    decision: { harness: 'codex', model: 'fixture-model', effort: 'medium' }, ownership: { mode: 'read' }, prompt: JSON.stringify({ originalPrompt: request.originalPrompt }) };
  const options = { request, budget: { deadline: Date.now() + 10000 }, binaries: { codex: process.execPath, claude: process.execPath }, verifyDecision: () => {},
    executeNative: async () => { launches++; return { completed: true, model: 'fixture-model', effort: 'medium', answer: '{}' }; } };
  const ordinary = createGuardedWorkflowAdapters(options).codex;
  const ready = await ordinary.prepare({ worker, timeoutMs: 5000 }); await ordinary.launch(ready);
  assert.equal(ready.observation.policyAuthorization.enforced, false);
  assert.equal(ready.observation.policyAuthorization.evidence[0].status, 'UNKNOWN_UNBOUND');
  const deny = createGuardedWorkflowAdapters({ ...options, authorizeNative: async () => { throw new Error('policy denied'); } }).codex;
  const refused = await deny.prepare({ worker, timeoutMs: 5000 }); await deny.launch(refused);
  assert.equal(launches, 1); assert.equal(refused.nativeLaunched, false);
  assert.equal(deny.interpret(refused, await deny.observe(refused)).nativeLaunched, false);
  assert.equal(ready.nativeLaunched, null);
  assert.equal(deny.interpret(refused, await deny.observe(refused)).status, 'blocked');
});


test('Claude owner approval cannot bypass bound apply policy before a native write', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-policy-apply-'))), file = path.join(dir, 'owned.mjs');
  fs.writeFileSync(file, 'before'); const stages = [];
  const request = { originalPrompt: 'Bound edit', cwd: dir, permissions: { write: true } };
  const worker = { id: 'w', host: 'claude', role: 'developer', activity: 'implementation', configuredModel: 'fixture-model',
    decision: { harness: 'claude-code', model: 'fixture-model', effort: 'medium' }, ownership: { mode: 'write', worktree: dir, paths: ['owned.mjs'] },
    prompt: JSON.stringify({ originalPrompt: request.originalPrompt }) };
  const mock = vi.spyOn(controlledClaude, 'runControlledClaudeTurn').mockImplementation(async options => {
    await options.approve({ tool_name: 'Write', input: { file_path: file } });
    throw new Error('Write must not reach this point');
  });
  try {
    const adapter = createGuardedWorkflowAdapters({ request, budget: { deadline: Date.now() + 10000 }, binaries: { codex: process.execPath, claude: process.execPath },
      verifyDecision: () => {}, approve: async () => true, authorizeNative: async ({ stage }) => {
        stages.push(stage); if (stage === 'apply') throw new Error('apply policy denied');
        return { enforced: false, status: 'UNENFORCED_LEGACY' };
      } }).claude;
    const prepared = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(prepared);
    assert.deepEqual(stages, ['launch', 'apply']); assert.equal(prepared.error.message, 'apply policy denied');
    assert.equal(fs.readFileSync(file, 'utf8'), 'before');
    assert.equal(adapter.interpret(prepared, await adapter.observe(prepared)).status, 'blocked');
  } finally { mock.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test('cancellation while awaiting policy cannot start a native worker', async () => {
  let launches = 0;
  const request = { originalPrompt: 'Read context', cwd: process.cwd(), permissions: { write: false } };
  const worker = { id: 'w', host: 'codex', role: 'developer', activity: 'implementation', configuredModel: 'fixture-model',
    decision: { harness: 'codex', model: 'fixture-model', effort: 'medium' }, ownership: { mode: 'read' }, prompt: JSON.stringify({ originalPrompt: request.originalPrompt }) };
  const adapter = createGuardedWorkflowAdapters({ request, budget: { deadline: Date.now() + 10000 }, binaries: { codex: process.execPath, claude: process.execPath },
    verifyDecision: () => {}, executeNative: async () => { launches++; }, authorizeNative: async ({ state }) => {
      state.controller.abort(); return { enforced: false, status: 'UNENFORCED_LEGACY' };
    } }).codex;
  const prepared = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(prepared);
  assert.equal(launches, 0); assert.match(prepared.error.message, /cancelled or expired/);
});


test('launch-only evidence cannot certify write apply inside an injected executor', async () => {
  const request = { originalPrompt: 'Bound edit', cwd: process.cwd(), permissions: { write: true } };
  const worker = { id: 'w', host: 'codex', role: 'developer', activity: 'implementation', configuredModel: 'fixture-model',
    decision: { harness: 'codex', model: 'fixture-model', effort: 'medium' }, ownership: { mode: 'write', paths: ['owned.mjs'] },
    prompt: JSON.stringify({ originalPrompt: request.originalPrompt }) };
  const adapter = createGuardedWorkflowAdapters({ request, budget: { deadline: Date.now() + 10000 }, binaries: { codex: process.execPath, claude: process.execPath },
    verifyDecision: () => {}, authorizeNative: async () => ({ enforced: true, actionType: 'native.worker.launch' }),
    executeNative: async () => ({ completed: true, model: 'fixture-model', effort: 'medium', answer: '{}' }) }).codex;
  const prepared = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(prepared);
  assert.equal(prepared.observation.policyAuthorization.enforced, false);
  assert.match(prepared.observation.policyAuthorization.scope, /internals not covered/);
});


test('only supplied existing approval/evidence references reach the canonical runtime context', async () => {
  const calls = [], proof = { id: 'existing-evidence', kind: 'source' };
  const bind = createNativeWorkflowPolicy({ runtime: runtime('legacy', { mode: 'legacy', outcome: 'allowed', enforcedOutcome: 'allowed', receiptId: 'r' }, calls),
    resolveRoot: () => '/canonical', contextForAction: () => ({ projectRoot: '/forged', approvalIds: ['existing-approval'], evidence: [proof] }) });
  await bind({ stage: 'launch', state });
  assert.equal(calls[0][2].projectRoot, '/canonical');
  assert.deepEqual(calls[0][2].approvalIds, ['existing-approval']); assert.deepEqual(calls[0][2].evidence, [proof]);
});


test('nativeLaunched true requires an actual default worker spawn event, not completed stub metadata', async () => {
  const request = { originalPrompt: 'Read context', cwd: process.cwd(), permissions: { write: false } };
  const worker = { id: 'w', host: 'claude', role: 'developer', activity: 'implementation', configuredModel: 'fixture-model',
    decision: { harness: 'claude-code', model: 'fixture-model', effort: 'medium' }, ownership: { mode: 'read' }, prompt: JSON.stringify({ originalPrompt: request.originalPrompt }) };
  const mock = vi.spyOn(controlledClaude, 'runControlledClaudeTurn').mockImplementation(async options => {
    const child = options.spawnNative(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    return { decision: worker.decision, finalAnswer: '{"outcome":"fixture process completed","artifacts":[],"decisions":[],"risks":[]}',
      structuredOutput: true, modelObserved: true, effortSettingsObserved: true };
  });
  try {
    const adapter = createGuardedWorkflowAdapters({ request, budget: { deadline: Date.now() + 10000 },
      binaries: { codex: process.execPath, claude: process.execPath }, verifyDecision: () => {} }).claude;
    const prepared = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(prepared);
    assert.equal(prepared.nativeLaunched, true); assert.equal(prepared.nativeLaunchEvidence.evidence, 'child-process-spawn-event');
    assert.equal(adapter.interpret(prepared, await adapter.observe(prepared)).nativeLaunched, true);
  } finally { mock.mockRestore(); }
});


test('P067 actual controller refuses lease-supplied write and API spend capabilities', async () => {
  const sourceRoot = process.env.RUVNET_P067_SOURCE_ROOT || path.resolve(import.meta.dirname, '../..');
  const { validateWorkflowRequest } = await import(pathToFileURL(path.join(sourceRoot, 'scripts', 'model-routing-controller.mjs')).href);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p067-request-')));
  try {
    const request = { id: 'lease-request', originalPrompt: 'Read context', projectRoot: root, contextRefs: [], taskFacts: { work: 'read' },
      permissions: { write: false, apiBilling: false }, deadline: Date.now() + 30_000, maxAttempts: 4, maxConcurrent: 1,
      acceptanceChecks: [{ id: 'checked' }], lease: { granted: true, write: true, apiBilling: true, publication: true } };
    validateWorkflowRequest(request);
    const writer = { ...request, tasks: [{ id: 'work', instructions: 'Write owned file', dependsOn: [],
      ownership: { mode: 'write', worktree: root, paths: ['owned.mjs'] }, acceptanceChecks: [{ id: 'checked' }], lease: request.lease }] };
    assert.throws(() => validateWorkflowRequest(writer), /Write authority/);
    assert.throws(() => validateWorkflowRequest({ ...request, permissions: { write: false, apiBilling: true } }), /no API billing/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P067 owned coordination and approval receipt cannot bypass independent native policy denial', async () => {
  let invoked = false;
  const request = { originalPrompt: 'Read context', cwd: process.cwd(), permissions: { write: false, apiBilling: false },
    lease: { granted: true, policyAuthorized: true, receiptId: 'lease-receipt' } };
  const worker = { id: 'lease-worker', host: 'codex', role: 'developer', activity: 'implementation', configuredModel: 'fixture-model',
    decision: { harness: 'codex', model: 'fixture-model', effort: 'medium' }, ownership: { mode: 'read' },
    lease: request.lease, prompt: JSON.stringify({ originalPrompt: request.originalPrompt }) };
  const adapter = createGuardedWorkflowAdapters({ request, budget: { deadline: Date.now() + 10000 },
    binaries: { codex: process.execPath, claude: process.execPath }, verifyDecision: () => {},
    authorizeNative: async () => { throw Error('independent native policy denied'); }, executeNative: async () => { invoked = true; } }).codex;
  const prepared = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(prepared);
  assert.equal(invoked, false); assert.equal(adapter.interpret(prepared, await adapter.observe(prepared)).status, 'blocked');
});

test('P067 schema-valid candidate evidence is not local publication authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p067-receipt-'));
  try {
    const version = getVersion(), sha = 'a'.repeat(40), digest = crypto.createHash('sha256').update('fixture artifact').digest('hex');
    const receipt = { schemaVersion: 1, phase: 'candidate', sha, tree: 'b'.repeat(40), dirty: false, version, tag: `v${version}`,
      sourceVersions: { package: version, claudePlugin: version, codexPlugin: version },
      artifact: { path: 'fixture.tgz', sha256: digest, sourceSha: sha, version, bundle: { brainVersion: version, releaseTag: `v${version}` } },
      releaseVector: { verdict: 'PASS', sha, unknown: 0, skipped: 0 }, tests: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
      coverage: { status: 'PASS', lines: 95, requiredLines: 80 }, security: { status: 'PASS', critical: 0, high: 0 }, issues: { open: [] },
      github: { sha, checks: REQUIRED_CHECKS.map(name => ({ name, status: 'completed', conclusion: 'success' })) },
      hosts: { claude: { status: 'PASS', version, artifactSha256: digest }, codex: { status: 'PASS', version, artifactSha256: digest } },
      brain: { status: 'PASS', selfStore: true, citedSelfSource: true, narrowMs: 100, broadMs: 200, concurrentMs: 150, deadlineMs: 1000 },
      qe: { status: 'PASS', total: 1, passed: 1, failed: 0, skipped: 0 },
      graders: [{ id: 'a', independent: true, score: 95, sha, artifactSha256: digest }, { id: 'b', independent: true, score: 96, sha, artifactSha256: digest }] };
    assert.equal(evaluateCandidateReceipt(receipt).verdict, 'PASS'); // Fixture protocol, no real grader/public claim.
    assert.ok(validateProtectedPublishEnvironment({ RUVNET_CANDIDATE_RECEIPT: 'candidate-receipt.json', lease: 'granted' }).length);
    const file = path.join(root, 'candidate-receipt.json'); fs.writeFileSync(file, JSON.stringify(receipt));
    const sourceRoot = process.env.RUVNET_P067_SOURCE_ROOT || path.resolve(import.meta.dirname, '../..');
    const result = spawnSync(process.execPath, [path.join(sourceRoot, 'scripts', 'self-update.mjs'), '--publish', '--receipt', file],
      { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, RUVNET_CANDIDATE_RECEIPT: file, RUFLO_DAEMON_AUTOSTART: '0' } });
    assert.equal(result.status, 2); assert.match(result.stderr, /DENIED.*rebuild-only/);
    assert.deepEqual(fs.readdirSync(root), ['candidate-receipt.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
