import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as controlledClaude from '../../scripts/claude-controlled-terminal.mjs';
import { createGuardedWorkflowAdapters } from '../../scripts/model-routing-execution-adapters.mjs';
import { artifactDigest, buildWorkflowPlan, validateWorkflowRequest, validateWorkflowPlan,
  loadManagedRunner, runRoutingWorkflow, waitForManagedCapacity, durableWorkflowReceipt } from '../../scripts/model-routing-controller.mjs';

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const decision = { harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
const verifyDecision = (route) => assert.deepEqual(route, decision);
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-controller-')));
  fs.writeFileSync(path.join(root, 'context.md'), 'Original canonical context');
  fs.writeFileSync(path.join(root, 'artifact.txt'), 'Artifact from actual path');
  const request = { id: 'workflow', projectRoot: root, originalPrompt: 'Perform the exact original task with all constraints intact.',
    contextRefs: [{ path: path.join(root, 'context.md'), digest: digest(path.join(root, 'context.md')) }],
    taskFacts: { work: 'coding' }, permissions: { write: false, apiBilling: false },
    deadline: Date.now() + 30_000, maxAttempts: 4, maxConcurrent: 2, acceptanceChecks: [{ id: 'actual-check' }] };
  const acceptance = () => {
    const artifactRefs = [{ path: path.join(root, 'artifact.txt'), digest: digest(path.join(root, 'artifact.txt')) }];
    const bound = artifactDigest(artifactRefs);
    return { passed: true, artifactRefs, artifactDigest: bound,
      evidence: [{ taskId: 'work', checkId: 'actual-check', passed: true, artifactDigest: bound }] };
  };
  return { root, request, acceptance, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function adapters(log, behavior = {}) {
  return { codex: { id: 'test-adapter',
    readiness: async ({ worker }) => { log.push(['ready', worker.id]); return { ready: true }; },
    prepare: async ({ worker }) => ({ worker }),
    launch: async (state) => { log.push(['launch', state.worker.id]); return state; },
    observe: async (state) => { if (behavior.observe) await behavior.observe(state); return {}; },
    interpret: (state) => ({ workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role,
      host: 'codex', status: behavior.status ?? 'succeeded', exitCategory: behavior.exitCategory ?? 'success',
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0,
      provider: 'openai', providerProvenance: 'observed', configuredModel: decision.model,
      observedModel: decision.model, sessionId: `session-${state.worker.id}`, transcriptRefs: [],
      failure: behavior.failure ?? null, usage: null }),
    summarize: () => ({ outcome: 'Actual worker output', artifacts: [], decisions: [], risks: [] }),
    cancel: async () => ({}), cleanup: async () => ({}),
  } };
}

function boundaries(f, overrides = {}) {
  const log = [], receipts = [];
  return { log, receipts, options: {
    sampleCapacity: () => ({ workers: f.request.maxConcurrent, tier: 'test-measurement', reason: 'bounded fixture' }),
    route: async ({ originalPrompt, taskFacts }) => { assert.equal(originalPrompt, f.request.originalPrompt); assert.deepEqual(taskFacts, f.request.taskFacts); return decision; },
    verifyDecision, createAdapters: async () => adapters(log),
    checkAcceptance: async () => f.acceptance(),
    review: async ({ request, acceptance, executeReview }) => {
      const worker = { id: 'independent-review', role: 'reviewer', activity: 'review', host: 'codex', decision,
        configuredModel: decision.model, configuredEffort: decision.effort, taskFacts: request.taskFacts,
        ownership: { mode: 'read', worktree: request.projectRoot, paths: [] },
        prompt: JSON.stringify({ originalPrompt: request.originalPrompt, contextRefs: request.contextRefs,
          taskFacts: request.taskFacts, permissions: { ...request.permissions, write: false }, acceptance }) };
      await executeReview(worker);
      return { passed: true, independent: true, reviewerWorkerId: worker.id, artifactDigest: acceptance.artifactDigest,
        findings: [], evidence: [{ review: 'actual reviewer completed' }] };
    },
    recordReceipt: async (_request, receipt) => { receipts.push(receipt); return { durable: true, agentDbCommitted: true }; },
    ...overrides,
  } };
}

test('global installed Agentic Kit runner is actually resolved', async () => {
  assert.equal(typeof await loadManagedRunner(), 'function');
});

test.each(['readiness-refusal', 'readiness-throw', 'prepare-throw', 'summary-throw', 'handoff-missing', 'handoff-invalid', 'handoff-request-throw', 'handoff-request-invalid', 'result-invalid', 'aggregate-overflow', 'aggregate-representable'])('required producer phase failure %s stops dependent and queued independent effects', async mode => {
  const { adoptedProject } = await import('../helpers/continuity-fixture.mjs');
  const { ContinuityJournal, drain } = await import('../../plugin/scripts/continuity-journal.mjs');
  const { commitManagedReceipt } = await import('../../scripts/model-managed-workflow-service.mjs');
  const p = adoptedProject(), events = [], receipts = [], states = [];
  const context = path.join(p.dir, 'context.txt'); fs.writeFileSync(context, 'Exact readonly local dependency context');
  const aggregate = mode.startsWith('aggregate-'), producers = aggregate ? Array.from({ length: 55 }, (_, i) => 'producer-' + i) : ['producer'];
  const request = { id: 'phase-proof-' + mode, projectRoot: p.dir, originalPrompt: 'Keep the required producer and all downstream work bounded and readonly.',
    contextRefs: [{ path: context, digest: digest(context) }], taskFacts: { scope: 'local consumer proof' },
    permissions: { apiBilling: false, write: false }, deadline: Date.now() + (aggregate ? 120_000 : 30_000), maxAttempts: aggregate ? 64 : 5, maxConcurrent: 1,
    tasks: [...producers, 'consumer', ...(aggregate ? ['downstream'] : []), 'queued-sibling'].map(id => ({ id, instructions: 'Read exact owned source only',
      dependsOn: id === 'consumer' ? producers : id === 'downstream' ? ['consumer'] : [], ownership: { mode: 'read', worktree: p.dir, paths: [] }, acceptanceChecks: [{ id: 'local-read' }] })) };
  class Journal extends ContinuityJournal { constructor(options) { super({ ...options, env: p.env, home: p.home }); } }
  const recordReceipt = async (req, receipt) => {
    const value = commitManagedReceipt(req, receipt, { Journal,
      drainJournal: (journal, options) => drain(journal, { ...options, ruflo: '/Users/stuartkerr/.npm-global/bin/ruflo', backoff: [] }) });
    receipts.push({ receipt, canonicalReceipt: value.canonicalReceipt }); return value;
  };
  const map = { codex: { id: 'actual-local-node-no-provider',
    readiness: async ({ worker }) => { if (worker.id === 'producer' && mode === 'readiness-refusal') return { ready: false };
      if (worker.id === 'producer' && mode === 'readiness-throw') throw Error('Observed readiness failure'); return { ready: true }; },
    prepare: async ({ worker }) => { if (worker.id === 'producer' && mode === 'prepare-throw') throw Error('Observed prepare failure'); return { worker }; },
    launch: async state => {
      assert.ok(receipts.some(row => row.receipt.status === 'queued' && row.canonicalReceipt));
      state.child = spawn(process.execPath, ['-e', "require('node:fs').readFileSync(process.argv[1]);process.stdout.write('actual-owned-read');", context], { cwd: p.dir });
      states.push(state); state.output = ''; state.child.stdout.on('data', data => state.output += data);
      state.done = new Promise((resolve, reject) => { state.child.once('error', reject); state.child.once('close', code => { state.code = code; state.closed = true; resolve(); }); });
      await new Promise((resolve, reject) => { state.child.once('error', reject); state.child.once('spawn', resolve); });
      state.nativeLaunched = true; state.nativeLaunchEvidence = { evidence: 'child-process-spawn-event', pid: state.child.pid, binary: process.execPath, cwd: p.dir };
      events.push(['actual-node-spawn', state.worker.id, state.child.pid]); return state;
    },
    observe: async state => { await state.done; return {}; },
    interpret: state => ({ workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: 'codex', status: 'succeeded', exitCategory: 'success',
      configuredModel: decision.model, observedModel: null, sessionId: null, provider: null, providerProvenance: 'unknown',
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0, transcriptRefs: [], usage: null, failure: null,
      ...(state.worker.id === 'producer' && mode === 'result-invalid' ? { provider: undefined } : {}) }),
    summarize: state => { if (state.worker.id === 'producer') {
      if (mode === 'summary-throw') throw Error('Observed summary failure');
      if (mode === 'handoff-missing') return null;
      if (mode === 'handoff-invalid') return { outcome: '', artifacts: [], decisions: [], risks: [] };
    } return { outcome: mode === 'aggregate-overflow' ? 'x'.repeat(768) : state.output, artifacts: [], decisions: [], risks: [] }; },
    handoffRequestFor: worker => { if (worker.id === 'producer' && mode === 'handoff-request-throw') throw Error('Observed handoff request failure');
      return worker.id === 'producer' && mode === 'handoff-request-invalid' ? null : '\nSupply the required bounded dependency handoff.'; },
    cancel: async state => { if (state.child && !state.closed) state.child.kill('SIGTERM'); if (state.done) await state.done; return {}; },
    cleanup: async state => { if (state.done) await state.done; return { nativeRetired: true,
      nativeRetirementEvidence: state.child ? { evidence: 'child-process-close-event', pid: state.child.pid, exitCode: state.code } : null }; },
  } };
  const outcome = await runRoutingWorkflow(request, { route: async () => decision, verifyDecision, createAdapters: async () => map, recordReceipt,
    sampleCapacity: () => ({ workers: 1, tier: 'controlled owner ceiling', reason: 'Local predicate fixture, not native physical availability' }),
    checkAcceptance: async () => ({ passed: false, status: 'blocked', reason: 'Probe deliberately ends before completion' }), review: async () => { throw Error('No reviewer allowed in this local phase proof'); } });
  await Promise.all(states.map(state => state.done));
  assert.ok(events.every(([, id]) => mode === 'aggregate-representable' || producers.includes(id)), JSON.stringify({ mode, events }));
  assert.equal(outcome.status, 'blocked');
  if (mode === 'aggregate-representable') assert.deepEqual(events.map(([, id]) => id), request.tasks.map(task => task.id));
  else for (const id of ['consumer', ...(aggregate ? ['downstream'] : []), 'queued-sibling']) assert.ok(outcome.taskChecklist.some(task => task.id === id && task.state === 'blocked' && task.attempted === false));
  assert.ok(states.every(state => state.closed)); assert.equal(outcome.deadline, request.deadline);
  assert.ok(outcome.capacityAdmissions.every(row => row.activeChildren <= 1));
  assert.ok(receipts.at(-1).canonicalReceipt); assert.equal(receipts.at(-1).receipt.status, 'blocked');
}, 180_000);

test('unverified registration metadata preserves scope-denial checks without creating a canonical checkpoint', async () => {
  const f=fixture();try{
    f.request.continuationRegistration={state:'UNVERIFIED',reason:'Current native USER record not exposed'};
    const b=boundaries(f),base=adapters(b.log,{status:'blocked',exitCategory:'permission_required',failure:{reason:'Original host denied the action'}});
    b.options.createAdapters=async()=>base;
    const outcome=await runRoutingWorkflow(f.request,b.options);
    assert.equal(outcome.status,'blocked');assert.equal(outcome.reason,'workflow-boundary-failed');assert.match(outcome.failure,/Workflow cancelled/);
    assert.equal(fs.existsSync(path.join(f.root,'.ruvnet-brain','loops',f.request.id)),false);
    assert.deepEqual(outcome.taskChecklist.map(task=>task.state),['blocked']);
    assert.equal(outcome.deadline,f.request.deadline);assert.equal(outcome.attemptsUsed,1);
  }finally{f.cleanup();}
});

test.each(['Update 3 files.', 'Use a swarm.', 'Change architecture boundaries.', 'Fix QA behavior.', 'Change release publication behavior.', 'Implement independent workstreams for backend and frontend.'])('preserved original classifier request reaches required machine choice before dispatch: %s', originalPrompt => {
  return (async()=>{const f=fixture();try{
    f.request.originalPrompt=originalPrompt;const b=boundaries(f);
    const result=await runRoutingWorkflow(f.request,b.options);
    assert.equal(b.receipts[0].status,'queued');assert.equal(b.receipts[0].parallelismPlan.classifierRequired,true);
    assert.equal(b.receipts[0].parallelismPlan.plannedChoice,'serial');assert.match(b.receipts[0].parallelismPlan.serialReason,/One scoped task/);
    assert.equal(result.status,'complete');assert.equal(result.parallelismPlan.classifierRequired,true);
    assert.equal(f.request.permissions.apiBilling,false);assert.equal(f.request.permissions.write,false);
  }finally{f.cleanup();}})();
});

test('one ordinary worker preserves original context and launches independent review before completion', async () => {
  const f = fixture(); try {
    const b = boundaries(f);
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'complete'); assert.equal(result.attemptsUsed, 2);
    assert.deepEqual(b.log.filter(([phase]) => phase === 'launch').map(([, id]) => id), ['work', 'independent-review']);
    assert.deepEqual(b.receipts.map((r) => r.status), ['queued', 'running', 'task-dispatch', 'stage-finished', 'checks-finished', 'review-finished', 'complete']);
    assert.equal(result.artifactDigest, f.acceptance().artifactDigest);
  } finally { f.cleanup(); }
});

test('explicit dependency DAG executes through actual runner and retains original request plus dependency handoff', async () => {
  const f = fixture(); try {
    f.request.tasks = ['research', 'verify'].map((id, i) => ({ id, instructions: `Perform ${id}`,
      dependsOn: i ? ['research'] : [], ownership: { mode: 'read', worktree: f.root, paths: [] }, acceptanceChecks: [{ id: 'actual-check' }] }));
    const observed = [], b = boundaries(f, {
      createAdapters: async () => {
        const map = adapters(observed); const prepare = map.codex.prepare;
        map.codex.prepare = async (input) => { assert.ok(input.worker.prompt.includes(f.request.originalPrompt));
          if (input.worker.id === 'verify') assert.match(input.worker.prompt, /Actual worker output/); return prepare(input); };
        return map;
      },
      checkAcceptance: async () => { const a = f.acceptance(); a.evidence = f.request.tasks.map((task) => ({ taskId: task.id, checkId: 'actual-check', passed: true, artifactDigest: a.artifactDigest })); return a; },
    });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'complete'); assert.equal(result.attemptsUsed, 3);
    assert.deepEqual(observed.filter(([phase]) => phase === 'launch').map(([, id]) => id), ['research', 'verify', 'independent-review']);
  } finally { f.cleanup(); }
});

test('all multiple writers are refused without resource claims, including sequential writers', () => {
  const f = fixture(); try {
    f.request.permissions.write = true;
    f.request.tasks = ['one', 'two'].map((id) => ({ id, instructions: id, dependsOn: [],
      ownership: { mode: 'write', worktree: f.root, paths: ['src'] }, acceptanceChecks: [{ id: 'check' }] }));
    assert.throws(() => validateWorkflowRequest(f.request), /Only one writer/);
    f.request.tasks[1].ownership.paths = ['tests'];
    assert.throws(() => validateWorkflowRequest(f.request), /Only one writer/);
    f.request.tasks[1].dependsOn = ['one']; assert.throws(() => validateWorkflowRequest(f.request), /Only one writer/);
    f.request.tasks[0].dependsOn = ['two']; assert.throws(() => validateWorkflowRequest(f.request), /cycle/);
  } finally { f.cleanup(); }
});

test('generated plan cannot rewrite scope or shed original prompt', async () => {
  const f = fixture(); try {
    const plan = await buildWorkflowPlan(f.request, { route: async () => decision });
    plan.workers[0].prompt = 'Weak summary';
    assert.throws(() => validateWorkflowPlan(f.request, plan, { verifyDecision }), /changed context/);
  } finally { f.cleanup(); }
});

test('missing scope coverage and exit-zero alone cannot complete', async () => {
  const f = fixture(); try {
    const b = boundaries(f, { checkAcceptance: async () => ({ ...f.acceptance(), evidence: [] }) });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.match(result.failure, /coverage incomplete/);
    assert.equal(b.log.filter(([phase]) => phase === 'launch').length, 1);
  } finally { f.cleanup(); }
});

test('fabricated independent verdict without a reviewer launch is refused', async () => {
  const f = fixture(); try {
    const b = boundaries(f, { review: async ({ acceptance }) => ({ passed: true, independent: true,
      reviewerWorkerId: 'imagined', artifactDigest: acceptance.artifactDigest, findings: [], evidence: ['confidence'] }) });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.match(result.failure, /Actual independent review/);
  } finally { f.cleanup(); }
});

test('artifact mutation after acceptance is detected after actual independent review', async () => {
  const f = fixture(); try {
    const b = boundaries(f); const review = b.options.review;
    b.options.review = async (input) => { const verdict = await review(input); fs.writeFileSync(path.join(f.root, 'artifact.txt'), 'Changed'); return verdict; };
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.match(result.failure, /Context reference changed/);
  } finally { f.cleanup(); }
});

test('consent/auth/quota/uncertain effects block and never escalate', async () => {
  for (const category of ['permission_required', 'auth_required', 'orphaned', 'unknown', 'quota_exhausted']) {
    const f = fixture(); try {
      const log = [], b = boundaries(f, { createAdapters: async () => adapters(log,
        { status: 'blocked', exitCategory: category === 'quota_exhausted' ? 'worker_error' : category, failure: { reason: category } }) });
      const result = await runRoutingWorkflow(f.request, b.options);
      assert.equal(result.status, 'blocked'); assert.equal(log.filter(([phase]) => phase === 'launch').length, 1);
    } finally { f.cleanup(); }
  }
});

test('bounded gate repair recomputes decisions with original facts and shares attempt budget with review', async () => {
  const f = fixture(); try {
    let gates = 0, routes = 0;
    const b = boundaries(f, {
      route: async ({ originalPrompt, taskFacts, feedback }) => { routes++; assert.equal(originalPrompt, f.request.originalPrompt);
        assert.deepEqual(taskFacts, f.request.taskFacts); if (routes > 1) {
          assert.equal(feedback.acceptance.passed, false); assert.equal(feedback.verifiedTaskQualityFailure, true);
          assert.deepEqual(feedback.priorDecisions.work, decision);
        } return decision; },
      checkAcceptance: async () => { gates++; const a = f.acceptance(); if (gates === 1) { a.passed = false; a.evidence[0].passed = false; } return a; },
    });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'complete'); assert.equal(routes, 2); assert.equal(result.attemptsUsed, 3);
    f.request.maxAttempts = 2; gates = 0; routes = 0;
    const bounded = await runRoutingWorkflow(f.request, b.options);
    assert.equal(bounded.status, 'blocked'); assert.equal(bounded.attemptsUsed, 1); assert.equal(routes, 1);
  } finally { f.cleanup(); }
});

test('environment-only worker or checker failures never schedule a repair, and caller quality claims are refused', async () => {
  const f = fixture(); try {
    const forged = { ...f.request, taskFacts: { verifiedTaskQualityFailure: true } };
    assert.throws(() => validateWorkflowRequest(forged), /validated workflow evidence/);
    for (const error of [{ reason: 'environment-unavailable' }, { exitCode: 127 }, { signal: 'SIGTERM' },
      { output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'missing'" }, { reason: 'permission_required' }]) {
      let repairs = 0;
      const b = boundaries(f, { checkAcceptance: async () => {
        const a = f.acceptance(); a.passed = false; Object.assign(a.evidence[0], { passed: false }, error); return a;
      }, planRepair: async () => { repairs++; throw new Error('Must not repair environment'); } });
      const result = await runRoutingWorkflow(f.request, b.options);
      assert.equal(result.status, 'blocked'); assert.equal(repairs, 0);
      assert.equal(b.log.filter(([phase]) => phase === 'launch').length, 1);
    }
    for (const category of ['worker_error', 'timeout', 'model_unavailable']) {
      let routes = 0;
      const log = [], b = boundaries(f, { route: async () => { routes++; return decision; },
        createAdapters: async () => adapters(log, { status: 'failed', exitCategory: category,
          failure: { reason: 'native environment unavailable', retrySafe: true } }) });
      assert.equal((await runRoutingWorkflow(f.request, b.options)).status, 'blocked'); assert.equal(routes, 1);
      assert.equal(log.filter(([phase]) => phase === 'launch').length, 1);
    }
  } finally { f.cleanup(); }
});

test('passing expected-denial checks retain success even when output contains environment error examples', async () => {
  const f = fixture(); try {
    const b = boundaries(f, { checkAcceptance: async () => {
      const a = f.acceptance(); Object.assign(a.evidence[0], { exitCode: 0,
        output: "Expected refusals: permission denied; Cannot find module; command not found; quota exhausted" }); return a;
    } });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'complete');
    assert.deepEqual(b.log.filter(([phase]) => phase === 'launch').map(([, id]) => id), ['work', 'independent-review']);
  } finally { f.cleanup(); }
});

test('global budget and stale context refuse before any worker launch', async () => {
  const f = fixture(); try {
    const b = boundaries(f); f.request.maxAttempts = 1;
    await assert.rejects(runRoutingWorkflow(f.request, b.options), /attempt budget/);
    f.request.maxAttempts = 4; f.request.deadline = Date.now() - 1;
    await assert.rejects(runRoutingWorkflow(f.request, b.options), /deadline/);
    f.request.deadline = Date.now() + 30_000; fs.writeFileSync(path.join(f.root, 'context.md'), 'Changed context');
    await assert.rejects(runRoutingWorkflow(f.request, b.options), /reference changed/);
    assert.equal(b.log.length, 0);
  } finally { f.cleanup(); }
});

test('denial at acceptance boundary blocks repair and absolute deadline aborts a hanging gate', async () => {
  const f = fixture(); try {
    const b = boundaries(f, { checkAcceptance: async () => ({ ...f.acceptance(), passed: false, reason: 'auth_required' }) });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.equal(result.attemptsUsed, 1);
    f.request.deadline = Date.now() + 40;
    let gateAborted = false;
    b.options.checkAcceptance = ({ signal }) => new Promise(() => signal.addEventListener('abort', () => { gateAborted = true; }));
    const expired = await runRoutingWorkflow(f.request, b.options);
    assert.equal(expired.status, 'blocked'); assert.match(expired.failure, /deadline/); assert.equal(gateAborted, true);
  } finally { f.cleanup(); }
});

test('successful writer A runs once when B fails; original DAG replay is blocked', async () => {
  const f = fixture(); try {
    f.request.permissions.write = true; f.request.maxAttempts = 8;
    f.request.tasks = [{ id: 'writer-a', instructions: 'Write A once', dependsOn: [],
      ownership: { mode: 'write', worktree: f.root, paths: ['artifact.txt'] }, acceptanceChecks: [{ id: 'check-a' }] },
    { id: 'worker-b', instructions: 'Check A output', dependsOn: ['writer-a'],
      ownership: { mode: 'read', worktree: f.root, paths: ['artifact.txt'] }, acceptanceChecks: [{ id: 'check-b' }] }];
    const log = [], b = boundaries(f, { createAdapters: async () => {
      const map = adapters(log); const interpret = map.codex.interpret;
      map.codex.interpret = (state) => state.worker.id === 'worker-b'
        ? { ...interpret(state), status: 'failed', exitCategory: 'worker_error', failure: { reason: 'deterministic check mismatch', retrySafe: true } }
        : interpret(state); return map;
    } });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'native-execution-failed-without-quality-evidence');
    assert.deepEqual(log.filter(([phase]) => phase === 'launch').map(([, id]) => id), ['writer-a', 'worker-b']);
    assert.equal(result.executionReceipts[0].results[0].status, 'succeeded');
  } finally { f.cleanup(); }
});

test('explicit repair narrows prior artifact scope and retains successful writer receipt without replay', async () => {
  const f = fixture(); try {
    f.request.permissions.write = true; f.request.maxAttempts = 5;
    f.request.tasks = [{ id: 'original-writer', instructions: 'Write the artifact', dependsOn: [],
      ownership: { mode: 'write', worktree: f.root, paths: ['artifact.txt'] }, acceptanceChecks: [{ id: 'actual-check' }] }];
    let gates = 0;
    const b = boundaries(f, {
      checkAcceptance: async ({ executionReceipts }) => {
        const a = f.acceptance(); a.evidence[0].taskId = 'original-writer';
        if (++gates === 1) { a.passed = false; a.evidence[0].passed = false; }
        else { assert.equal(executionReceipts.length, 2); assert.equal(executionReceipts[0].results[0].sessionId, 'session-original-writer'); }
        return a;
      },
      planRepair: async ({ request, acceptance, executionReceipts }) => {
        assert.equal(executionReceipts[0].results[0].status, 'succeeded');
        const original = request.tasks[0];
        return { baseArtifactDigest: acceptance.artifactDigest, artifactRefs: acceptance.artifactRefs,
          tasks: [{ ...original, id: 'targeted-repair', repairsTaskId: original.id,
            instructions: 'Fix only the failed acceptance in the referenced existing artifact', repairArtifacts: acceptance.artifactRefs }] };
      },
    });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'complete'); assert.equal(result.attemptsUsed, 3);
    assert.deepEqual(b.log.filter(([phase]) => phase === 'launch').map(([, id]) => id), ['original-writer', 'targeted-repair', 'independent-review']);
    const repairPrompt = result.executionReceipts[1].plan.workers[0].prompt;
    assert.match(repairPrompt, /repairArtifacts/); assert.ok(repairPrompt.includes(f.request.originalPrompt));
  } finally { f.cleanup(); }
});

test('explicit repair cannot expand paths or discard prior artifact binding', async () => {
  const f = fixture(); try {
    f.request.permissions.write = true;
    f.request.tasks = [{ id: 'original-writer', instructions: 'Write the artifact', dependsOn: [],
      ownership: { mode: 'write', worktree: f.root, paths: ['artifact.txt'] }, acceptanceChecks: [{ id: 'actual-check' }] }];
    const b = boundaries(f, {
      checkAcceptance: async () => { const a = f.acceptance(); a.passed = false; a.evidence[0].passed = false; a.evidence[0].taskId = 'original-writer'; return a; },
      planRepair: async ({ request, acceptance }) => ({ baseArtifactDigest: acceptance.artifactDigest, artifactRefs: acceptance.artifactRefs,
        tasks: [{ ...request.tasks[0], id: 'repair', repairsTaskId: 'original-writer', repairArtifacts: acceptance.artifactRefs,
          ownership: { ...request.tasks[0].ownership, paths: ['unrelated.txt'] } }] }),
    });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.match(result.failure, /expanded original ownership/);
    assert.deepEqual(b.log.filter(([phase]) => phase === 'launch').map(([, id]) => id), ['original-writer']);
  } finally { f.cleanup(); }
});

test('event-loop-blocked late review cannot complete and its real reviewer receipt is retained', async () => {
  const f = fixture(); try {
    const b = boundaries(f); const review = b.options.review;
    b.options.review = async (input) => {
      const verdict = await review(input);
      const until = performance.now() + 100; while (performance.now() < until) { /* reproduce synchronous event-loop stall */ }
      return verdict;
    };
    f.request.deadline = Date.now() + 70;
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.match(result.failure, /deadline/);
    assert.equal(b.receipts.some((r) => r.status === 'complete'), false);
    const receipt = b.receipts.find((r) => r.status === 'review-finished');
    assert.equal(receipt.nativeReceipts[0].sessionId, 'session-independent-review');
    assert.equal(b.receipts.at(-1).status, 'blocked');
  } finally { f.cleanup(); }
});

test('backward wall-clock movement never extends the initial monotonic deadline', async () => {
  const f = fixture(); try {
    let wall = Date.now(); f.request.deadline = wall + 70;
    const b = boundaries(f, { now: () => wall }); const review = b.options.review;
    b.options.review = async (input) => {
      const verdict = await review(input); wall -= 60_000;
      const until = performance.now() + 100; while (performance.now() < until) { /* stall without allowing the timer to run */ }
      return verdict;
    };
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.match(result.failure, /deadline/);
    assert.equal(b.receipts.some((r) => r.status === 'complete'), false);
  } finally { f.cleanup(); }
});

test('artifact drift during repair preparation refuses launch against stale prior bytes', async () => {
  const f = fixture(); try {
    f.request.permissions.write = true;
    f.request.tasks = [{ id: 'original-writer', instructions: 'Write the artifact', dependsOn: [],
      ownership: { mode: 'write', worktree: f.root, paths: ['artifact.txt'] }, acceptanceChecks: [{ id: 'actual-check' }] }];
    const log = [], b = boundaries(f, {
      createAdapters: async () => {
        const map = adapters(log); const prepare = map.codex.prepare;
        map.codex.prepare = async (input) => { const state = await prepare(input);
          if (input.worker.id === 'repair') fs.writeFileSync(path.join(f.root, 'artifact.txt'), 'Concurrent artifact drift'); return state; };
        return map;
      },
      checkAcceptance: async () => { const a = f.acceptance(); a.passed = false; a.evidence[0].passed = false; a.evidence[0].taskId = 'original-writer'; return a; },
      planRepair: async ({ request, acceptance }) => ({ baseArtifactDigest: acceptance.artifactDigest, artifactRefs: acceptance.artifactRefs,
        tasks: [{ ...request.tasks[0], id: 'repair', repairsTaskId: 'original-writer', repairArtifacts: acceptance.artifactRefs }] }),
    });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(log.filter(([phase]) => phase === 'launch').map(([, id]) => id), ['original-writer']);
  } finally { f.cleanup(); }
});

test.each([true, false])('actual AK runner overlaps read subprocesses and preserves writer exclusivity; retirement confirmation=%s', async retirementConfirmed => {
  const f = fixture(), intervals = []; try {
    f.request.permissions.write = true; f.request.maxConcurrent = 3;
    f.request.tasks = ['reader-a', 'reader-b', 'writer-c'].map((id, index) => ({ id, instructions: id,
      dependsOn: index === 2 ? ['reader-a', 'reader-b'] : [], ownership: { mode: index === 2 ? 'write' : 'read',
        worktree: f.root, paths: index === 2 ? ['artifact.txt'] : [] }, acceptanceChecks: [{ id: 'actual-check' }] }));
    const b = boundaries(f), native = adapters(b.log);
    native.codex.launch = async state => {
      if (state.worker.id === 'writer-c') {
        assert.match(state.worker.prompt, /reader-a-result/); assert.match(state.worker.prompt, /reader-b-result/);
      }
      const interval = { id: state.worker.id, start: Date.now() }; intervals.push(interval);
      const source = `const fs=require('fs');fs.readFileSync(process.argv[1]);setTimeout(()=>{${state.worker.id === 'writer-c' ? "fs.writeFileSync(process.argv[2],'Written after both reader handoffs');" : ''}process.exit(0)},120)`;
      state.child = spawn(process.execPath, ['-e', source, path.join(f.root, 'context.md'), path.join(f.root, 'artifact.txt')], { cwd: f.root });
      interval.pid = state.child.pid;
      await new Promise((resolve, reject) => { state.child.once('error', reject); state.child.once('spawn', () => {
        state.nativeLaunched = true; state.nativeLaunchEvidence = { evidence: 'child-process-spawn-event', pid: state.child.pid, binary: process.execPath, cwd: f.root }; resolve(); }); });
      state.done = new Promise((resolve, reject) => { state.child.once('error', reject); state.child.once('close', code => {
        interval.end = Date.now(); state.nativeRetirementEvidence = { evidence: 'child-process-close-event', pid: state.child.pid, exitCode: code }; code === 0 ? resolve() : reject(Error('stub subprocess failed')); }); });
      return state;
    };
    native.codex.observe = async state => { await state.done; return {}; };
    native.codex.cleanup = async state => { assert.equal(state.child.exitCode, 0); return retirementConfirmed
      ? { nativeRetired: true, nativeRetirementEvidence: state.nativeRetirementEvidence } : { cleaned: true }; };
    native.codex.summarize = state => ({ outcome: `${state.worker.id}-result`, artifacts: [], decisions: [], risks: [] });
    b.options.createAdapters = async () => native;
    b.options.checkAcceptance = async () => { const a = f.acceptance(); a.evidence = f.request.tasks.map(t => ({
      taskId: t.id, checkId: 'actual-check', passed: true, artifactDigest: a.artifactDigest })); return a; };
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'complete');
    const [a, c] = ['reader-a', 'reader-b'].map(id => intervals.find(x => x.id === id));
    const writer = intervals.find(x => x.id === 'writer-c');
    assert.notEqual(a.pid, c.pid); assert.ok(Math.max(a.start, c.start) < Math.min(a.end, c.end));
    assert.ok(writer.start >= Math.max(a.end, c.end));
    assert.ok(result.capacityAdmissions.some(x => x.activeChildren === 2));
    assert.equal(result.parallelismPlan.plannedIndependentReadPairs, 1);
    assert.equal(result.parallelismPlan.serialReason, null);
    assert.deepEqual(new Set(result.startedWorkerIds), new Set(['reader-a', 'reader-b', 'writer-c', 'independent-review']));
    assert.deepEqual(new Set(result.retiredWorkerIds), new Set(retirementConfirmed ? result.startedWorkerIds : []));
    if (!retirementConfirmed) assert.deepEqual(new Set(result.unverifiedRetirementWorkerIds), new Set(result.startedWorkerIds));
    assert.equal(result.attemptsUsed, 4); // three task children plus the existing independent reviewer
  } finally { f.cleanup(); }
});

test.each([false, true])('real adapter close receipt reaches controller retirement; mismatched PID=%s', async mismatch => {
  const f = fixture(), route = { harness: 'claude-code', provider: 'anthropic', model: 'fixture-model', effort: 'medium' };
  const native = vi.spyOn(controlledClaude, 'runControlledClaudeTurn').mockImplementation(async options => {
    const child = options.spawnNative(process.execPath, ['-e', 'process.exit(0)'], { cwd: options.cwd });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('Node fixture failed'))); });
    const answer = options.worker.role === 'reviewer' ? { passed: true, artifactDigest: f.acceptance().artifactDigest, findings: [], evidence: ['Node-process fixture only'],
      criterionCoverage: [{ taskId: 'work', criterionId: 'fixture', checkIds: ['actual-check'], passed: true, evidence: ['Fixture acceptance'] }],
      coverage: ['entry', 'caller', 'consumer', 'config', 'error'].map(dimension => ({ dimension, state: 'not-applicable', evidence: ['Retirement interface fixture'] })), omissions: [] }
      : { outcome: 'Node-process fixture only', artifacts: [], decisions: [], risks: [] };
    return { sessionId: crypto.randomUUID(), decision: route, finalAnswer: JSON.stringify(answer), structuredOutput: true, modelObserved: true, effortSettingsObserved: true };
  });
  try {
    const b = boundaries(f, { route: async () => route, verifyDecision: value => assert.deepEqual(value, route),
      createAdapters: async ({ budget }) => {
        const map = createGuardedWorkflowAdapters({ request: f.request, budget, binaries: { codex: process.execPath, claude: process.execPath }, verifyDecision: () => {} });
        if (mismatch) { const cleanup = map.claude.cleanup; map.claude.cleanup = async state => { const result = await cleanup(state);
          return { ...result, nativeRetirementEvidence: { ...result.nativeRetirementEvidence, pid: result.nativeRetirementEvidence.pid + 1 } }; }; }
        return map;
      }, review: async ({ acceptance, executeReview }) => {
        await executeReview({ id: 'independent-review', role: 'reviewer', activity: 'review', host: 'claude', decision: route,
          configuredModel: route.model, configuredEffort: route.effort, taskFacts: f.request.taskFacts,
          ownership: { mode: 'read', worktree: f.root, paths: [] }, prompt: JSON.stringify({ originalPrompt: f.request.originalPrompt,
            contextRefs: f.request.contextRefs, taskFacts: f.request.taskFacts, permissions: { ...f.request.permissions, write: false }, acceptance }) });
        return { passed: true, independent: true, reviewerWorkerId: 'independent-review', artifactDigest: acceptance.artifactDigest, findings: [], evidence: ['Retirement interface fixture'] };
      } });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'complete', JSON.stringify({reason:result.reason,failure:result.failure,workflowOutcome:result.workflowOutcome})); assert.deepEqual(new Set(result.startedWorkerIds), new Set(['work', 'independent-review']));
    assert.deepEqual(new Set(result.retiredWorkerIds), new Set(mismatch ? [] : result.startedWorkerIds));
    if (mismatch) assert.deepEqual(new Set(result.unverifiedRetirementWorkerIds), new Set(result.startedWorkerIds));
  } finally { native.mockRestore(); f.cleanup(); }
});

test('policy-denied adapter return is never counted as a native start or native retirement', async () => {
  const f = fixture(); try {
    const b = boundaries(f), native = adapters(b.log, { status: 'blocked', exitCategory: 'permission_required', failure: { reason: 'policy denied' } });
    native.codex.launch = async state => ({ ...state, nativeLaunched: false, nativeLaunchEvidence: null });
    b.options.createAdapters = async () => native;
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.startedWorkerIds, []); assert.deepEqual(result.retiredWorkerIds, []);
    assert.deepEqual(result.adapterReturnedWorkerIds, ['work']); assert.deepEqual(result.releasedWorkerIds, ['work']);
  } finally { f.cleanup(); }
});

test('slots remain held until cleanup and queued admission never exceeds a reduced ceiling', async () => {
  const f = fixture(), events = []; try {
    f.request.tasks = ['reader-a', 'reader-b'].map(id => ({ id, instructions: id, dependsOn: [],
      ownership: { mode: 'read', worktree: f.root, paths: [] }, acceptanceChecks: [{ id: 'actual-check' }] }));
    const b = boundaries(f), native = adapters(b.log);
    native.codex.launch = async state => { events.push(['launch', state.worker.id, Date.now()]); return state; };
    native.codex.observe = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return {}; };
    native.codex.cleanup = async state => { await new Promise(resolve => setTimeout(resolve, 40)); events.push(['clean', state.worker.id, Date.now()]); return {}; };
    b.options.createAdapters = async () => native;
    let samples = 0;
    b.options.sampleCapacity = () => ({ workers: ++samples === 1 ? 2 : 1, tier: 'reduced', reason: 'fresh reduced pressure fixture' });
    b.options.checkAcceptance = async () => { const a = f.acceptance(); a.evidence = f.request.tasks.map(t => ({
      taskId: t.id, checkId: 'actual-check', passed: true, artifactDigest: a.artifactDigest })); return a; };
    const result = await runRoutingWorkflow(f.request, b.options);
    const launches = events.filter(x => x[0] === 'launch');
    assert.ok(launches[1][2] >= events.find(x => x[0] === 'clean' && x[1] === launches[0][1])[2]);
    assert.ok(result.capacityAdmissions.every(x => x.activeChildren <= 1));
    assert.ok(result.capacityAdmissions.some(x => x.workers === 2));
    assert.ok(result.capacityAdmissions.some(x => x.workers === 1 && /fresh reduced/.test(x.serialReason)));
  } finally { f.cleanup(); }
});

test('known zero capacity waits for recovery or deadline; unavailable measurement is explicitly serial', async () => {
  let samples = 0;
  const recovered = await waitForManagedCapacity({ maxConcurrent: 5, deadline: Date.now() + 1000,
    sampleCapacity: () => ({ workers: ++samples < 2 ? 0 : 8, tier: 'sampled' }) });
  assert.equal(recovered.workers, 5); assert.equal(samples, 2);
  const unknown = await waitForManagedCapacity({ maxConcurrent: 5, deadline: Date.now() + 1000, sampleCapacity: () => null });
  assert.equal(unknown.workers, 1); assert.match(unknown.reason, /unknown.*serial/);
  await assert.rejects(waitForManagedCapacity({ maxConcurrent: 2, deadline: Date.now() + 30,
    sampleCapacity: () => ({ workers: 0, tier: 'constrained' }) }), /deadline/);
});

test('validated checklist precedes effects and verified writer is locked with an exact safe handoff', async () => {
  const f = fixture(); try {
    f.request.permissions.write = true; f.request.tasks = [{ id: 'work', instructions: 'Bounded work', dependsOn: [],
      ownership: { mode: 'write', worktree: f.root, paths: ['artifact.txt'] }, acceptanceChecks: [{ id: 'actual-check' }] }];
    const b = boundaries(f), base = adapters(b.log), launch = base.codex.launch;
    base.codex.launch = async state => { assert.equal(b.receipts[0].status, 'queued');
      assert.deepEqual(b.receipts[0].taskChecklist[0].requiredCheckIds, ['actual-check']); return launch(state); };
    b.options.createAdapters = async () => base;
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.taskChecklist[0].state, 'verified');
    assert.equal(result.taskChecklist[0].proof.artifactDigest, result.artifactDigest);
    assert.deepEqual(result.resumeHandoff.lockedWriterIds, ['work']); assert.match(result.resumeHandoff.nextStep, /STOP/);
    assert.equal(result.resumeHandoff.originalPromptDigest, crypto.createHash('sha256').update(f.request.originalPrompt).digest('hex'));
  } finally { f.cleanup(); }
});

test.each([false, true])('failed source identity is path-bound; byte swap=%s', async swap => {
  const f = fixture(); try {
    f.request.permissions.write = true; f.request.maxAttempts = 8;
    f.request.tasks = [{ id: 'work', instructions: 'Bounded writer', dependsOn: [],
      ownership: { mode: 'write', worktree: f.root, paths: ['artifact.txt'] }, acceptanceChecks: [{ id: 'actual-check' }] }];
    let gates = 0; if (swap) { fs.writeFileSync(path.join(f.root, 'other.txt'), 'Other content'); f.request.tasks[0].ownership.paths.push('other.txt'); }
    const b = boundaries(f, { checkAcceptance: async () => { const a = f.acceptance(); a.passed = swap && ++gates >= 3;
      a.evidence[0].passed = a.passed; a.evidence[0].exitCode = a.passed ? 0 : 1; return a; },
    planRepair: async ({ request, acceptance }) => ({ baseArtifactDigest: acceptance.artifactDigest, artifactRefs: acceptance.artifactRefs,
      tasks: [{ ...request.tasks[0], id: 'scoped-repair', repairsTaskId: 'work', repairArtifacts: acceptance.artifactRefs }] }) });
    if (swap) { const native = adapters(b.log), launch = native.codex.launch; let starts = 0; native.codex.launch = async state => { if (++starts === 2) { const a = path.join(f.root, 'artifact.txt'), c = path.join(f.root, 'other.txt'), bytes = fs.readFileSync(a); fs.writeFileSync(a, fs.readFileSync(c)); fs.writeFileSync(c, bytes); } return launch(state); }; b.options.createAdapters = async () => native; }
    const result = await runRoutingWorkflow(f.request, b.options);
    if (swap) { assert.equal(result.status, 'complete'); assert.equal(result.attemptsUsed, 4); return; }
    assert.equal(result.reason, 'unchanged-check-failure-and-source-bytes'); assert.equal(result.attemptsUsed, 2);
    assert.equal(result.taskChecklist[0].state, 'blocked'); assert.deepEqual(result.resumeHandoff.lockedWriterIds, ['work']);
  } finally { f.cleanup(); }
});

test('capacity admission treats unchanging occupancy as unobservable progress and exits boundedly', async () => {
  const began = Date.now();
  await assert.rejects(waitForManagedCapacity({ maxConcurrent: 2, deadline: Date.now() + 2000, maxStallMs: 25,
    sampleCapacity: () => ({ workers: 0, tier: 'constrained' }) }), /Capacity admission stalled/);
  assert.ok(Date.now() - began < 500);
  await assert.rejects(waitForManagedCapacity({ maxConcurrent: 2, deadline: Date.now() + 1000, maxStallMs: 25,
    progress: () => true, sampleCapacity: () => ({ workers: 0, tier: 'constrained' }) }), /Capacity admission stalled/);
  assert.ok(Date.now() - began < 500);
});

test('unobservable active reader blocks only queued admission and remains alive through its observed completion', async () => {
  const f = fixture(); try {
    f.request.tasks = ['reader-a', 'reader-b'].map(id => ({ id, instructions: id, dependsOn: [],
      ownership: { mode: 'read', worktree: f.root, paths: [] }, acceptanceChecks: [{ id: 'actual-check' }] }));
    const b = boundaries(f), native = adapters(b.log), events = [];
    native.codex.launch = async state => { events.push(['started', state.worker.id]); return state; };
    native.codex.observe = async state => { await new Promise(resolve => setTimeout(resolve, 120)); events.push(['observed', state.worker.id]); return {}; };
    native.codex.cancel = async state => { events.push(['cancelled', state.worker.id]); return {}; };
    b.options.createAdapters = async () => native; b.options.maxAdmissionStallMs = 25;
    b.options.sampleCapacity = () => ({ workers: 1, tier: 'constrained', reason: 'measured single slot' });
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(events, [['started', 'reader-a'], ['observed', 'reader-a']]);
    assert.ok(result.admissionStalls.some(item => item.workerId === 'reader-b'));
  } finally { f.cleanup(); }
});

test('task-dispatch persistence cancellation or context drift cannot cross the underlying launch boundary', async () => {
  for (const change of ['drift', 'cancel']) {
    const f = fixture(), abort = new AbortController(); try {
      const b = boundaries(f); b.options.signal = abort.signal;
      b.options.recordReceipt = async (_req, receipt) => { b.receipts.push(receipt); if (receipt.status === 'task-dispatch') {
        if (change === 'drift') fs.writeFileSync(path.join(f.root, 'context.md'), 'Changed during receipt'); else abort.abort();
      } return { durable: true, agentDbCommitted: true }; };
      const result = await runRoutingWorkflow(f.request, b.options);
      assert.equal(result.status, 'blocked'); assert.equal(b.log.some(([phase]) => phase === 'launch'), false);
    } finally { f.cleanup(); }
  }
});


test('empty debt is not positive canonical receipt confirmation', () => {
  class Journal { constructor() { this.db = '/fixture/canonical.db'; } record([event]) { return [{key:'current',event}]; } }
  const request={id:'receipt-test',projectRoot:'/fixture',deadline:Date.now()+1000};
  assert.throws(() => durableWorkflowReceipt(request,{status:'complete',at:new Date().toISOString()},
    {Journal,drainJournal:()=>({remaining:0}),read:()=>({ok:true,value:null})}),/exact readback failed/);
});

test('canonical positive completion binds exact current bytes', () => {
  let stored;
  class Journal { constructor() { this.db = '/fixture/canonical.db'; } record([event]) { stored=event; return [{key:'current',event}]; } }
  const result=durableWorkflowReceipt({id:'receipt-test',projectRoot:'/fixture',deadline:Date.now()+1000},
    {status:'complete',at:new Date().toISOString()},
    {Journal,drainJournal:()=>({remaining:0}),read:(_db,fn)=>({ok:true,value:fn({readContent:()=>JSON.stringify(stored)})})});
  assert.equal(result.agentDbCommitted,true);
  assert.equal(result.canonicalReceipt.valueSha256,crypto.createHash('sha256').update(JSON.stringify(stored)).digest('hex'));
});

test('durable queued-only callback cannot complete or dispatch workflow', async () => {
  const f=fixture();
  try {
    const b=boundaries(f);
    b.options.recordReceipt=async()=>({durable:true,agentDbCommitted:false});
    await assert.rejects(runRoutingWorkflow(f.request,b.options),/canonical commit not proven/);
  } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
});


test('ordinary managed callback reads checkpoint first, writes last and stops exact verified replay', async () => {
  const root=fs.realpathSync(new URL('../..',import.meta.url));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'routing-checkpoint-consumer-'));
  const helper=path.join(root,'scripts/model-routing-checkpoint.mjs'),controller=path.join(root,'scripts/model-routing-controller.mjs');
  let source=fs.readFileSync(path.join(root,'tests/unit/managed-frontend-intake.test.mjs'),'utf8');
  source=source.replace(/(from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\2/g,(_match,prefix,quote,value)=>prefix+quote+path.resolve(root,'tests/unit',value)+quote);
  const start=source.indexOf("it('actual ordinary question callback commits"),end=source.indexOf("it('fresh ordinary resume callback",start);
  assert.ok(start>=0&&end>start,'Existing ordinary callback fixture boundary changed');
  const extra=String.raw`expect(result.status).toBe('complete');
   const {createRoutingCheckpoint}=await import(HELPER);
   const {runRoutingWorkflow}=await import(CONTROLLER);
   const kernel=createRoutingCheckpoint(plan.request),saved=fs.readFileSync(kernel.file,'utf8');
   expect(kernel.readFirst().code).toBe(3);
   const cp=JSON.parse(saved),marker=path.join(f.p.dir,'forbidden-command-effect');
   fs.writeFileSync(kernel.file,JSON.stringify({...cp,doneCriteria:'touch '+marker}));
   expect(()=>kernel.readFirst()).toThrow('foreign or tampered');expect(fs.existsSync(marker)).toBe(false);
   fs.writeFileSync(kernel.file,saved);
   const metadata=JSON.parse(cp.blockers);
   fs.writeFileSync(kernel.file,JSON.stringify({...cp,blockers:JSON.stringify({...metadata,binding:'wrong-scope'})}));
   expect(()=>kernel.readFirst()).toThrow('foreign or tampered');fs.writeFileSync(kernel.file,saved);
   const prior=JSON.parse(fs.readFileSync(f.ledger)).managedTasks[0].registrationReceipt;
   fs.writeFileSync(kernel.file,JSON.stringify({...cp,blockers:JSON.stringify({...metadata,canonicalHead:prior})}));
   expect(()=>kernel.readFirst()).toThrow('out-of-date');fs.writeFileSync(kernel.file,saved);
   const noEffect=async()=>{throw Error('Completed checkpoint must not dispatch/review/commit again');};
   fs.writeFileSync(kernel.file,'{');expect(()=>kernel.readFirst()).toThrow('Unreadable');
   const malformed=await runRoutingWorkflow(plan.request,{route:noEffect,createAdapters:noEffect,checkAcceptance:noEffect,review:noEffect,recordReceipt:noEffect});
   expect(malformed.status).toBe('checkpoint-stop');expect(fs.readFileSync(kernel.file,'utf8')).toBe('{');fs.writeFileSync(kernel.file,saved);
   const loops=path.dirname(path.dirname(kernel.file)),retained=loops+'-retained',outside=fs.mkdtempSync(path.join(f.p.home,'foreign-loops-'));
   fs.mkdirSync(path.join(outside,plan.request.id));const foreign=path.join(outside,plan.request.id,'checkpoint.json');fs.writeFileSync(foreign,'FOREIGN');
   fs.renameSync(loops,retained);fs.symlinkSync(outside,loops,'dir');
   try{expect(()=>kernel.readFirst()).toThrow('foreign checkpoint directory');expect(()=>kernel.writeLast({resumeHandoff:{nextStep:'No overwrite'}},metadata.canonicalHead)).toThrow('foreign checkpoint directory');expect(fs.readFileSync(foreign,'utf8')).toBe('FOREIGN');}
   finally{fs.unlinkSync(loops);fs.renameSync(retained,loops);}
   const replay=await runRoutingWorkflow(plan.request,{route:noEffect,createAdapters:noEffect,checkAcceptance:noEffect,review:noEffect,recordReceipt:noEffect});
   expect(replay.status).toBe('checkpoint-stop');expect(replay.checkpoint.code).toBe(3);
   expect(fs.readFileSync(kernel.file,'utf8')).toBe(saved);
` .replaceAll('HELPER',JSON.stringify(helper)).replaceAll('CONTROLLER',JSON.stringify(controller));
  const trace=String.raw`
   const reads=checkpointReads.mock.invocationCallOrder.filter((_order,index)=>checkpointReads.mock.calls[index][0]===kernel.file);
   const writes=checkpointWrites.mock.invocationCallOrder.filter((_order,index)=>checkpointWrites.mock.calls[index][1]===kernel.file);
   expect(reads.length).toBeGreaterThanOrEqual(2);expect(writes.length).toBe(2);
   expect(reads[0]).toBeLessThan(writes[0]);expect(writes[0]).toBeLessThan(reads[1]);expect(reads[1]).toBeLessThan(writes[1]);
`;
  const region=source.slice(start,end);assert.ok(region.includes("expect(result.status).toBe('complete');"));
  source=source.slice(0,start)+region.replace("expect(result.status).toBe('complete');",extra.replace("expect(kernel.readFirst().code).toBe(3);",trace+"expect(kernel.readFirst().code).toBe(3);"))+source.slice(end);
  const protocol=path.join(root,'scripts/loop-checkpoint.mjs');
  const prefix='import {vi} from "vitest";import * as checkpointProtocol from '+JSON.stringify(protocol)+';\nconst checkpointReads=vi.spyOn(checkpointProtocol,"readCheckpoint"),checkpointWrites=vi.spyOn(checkpointProtocol,"writeCheckpoint");\n';
  fs.symlinkSync(path.join(root,'node_modules'),path.join(dir,'node_modules'),'dir');
  fs.writeFileSync(path.join(dir,'consumer.test.mjs'),prefix+source);
  try {
    const child=spawn(process.execPath,[path.join(root,'node_modules/vitest/vitest.mjs'),'run','consumer.test.mjs','-t','actual ordinary question callback commits','--root',dir,'--maxWorkers=1','--testTimeout','20000'],{cwd:dir});
    let diagnostics='';child.stdout.on('data',chunk=>diagnostics+=chunk);child.stderr.on('data',chunk=>diagnostics+=chunk);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(code,0,diagnostics);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
},60_000);

// Constructed gate-domain uncertainty markers, not observed model usage.
test.each(['acceptance','review'])('required retirement scope blocks %s completion and repair without rejecting nonapplicable telemetry', async boundary => {
 const f=fixture();try{
  const required={retirementRequired:true,retirementConfirmed:true,retirementScope:'owned-process-group',retirementState:'GROUP_ONLY',treeVerified:false};
  const cases=[[required,false],[{...required,retirementScope:'owned-direct-child-only'},false],[{...required,retirementState:'UNKNOWN'},false],
   [{...required,launched:false,workerPid:12},false],[{...required,launched:false,nativeLaunchEvidence:{pid:12}},false],[{...required,launched:false,nativeLaunched:null},false],
   [{retirementRequired:true,retirementConfirmed:true,launched:false,treeVerified:false},true],
   [{nativeRetired:true,scope:'owned-direct-child-only',treeVerified:false},true],[{treeVerified:false},true]];
  for(const [marker,allowed]of cases){let repairs=0;const b=boundaries(f,{planRepair:async()=>{repairs++;throw Error('Retirement gap is not quality repair');}});
   if(boundary==='acceptance')b.options.checkAcceptance=async()=>{const a=f.acceptance();a.evidence[0].evidence=[marker];return a;};
   else{const review=b.options.review;b.options.review=async args=>{const v=await review(args);v.evidence.push(marker);return v;};}
   const result=await runRoutingWorkflow(f.request,b.options);assert.equal(result.status,allowed?'complete':'blocked',JSON.stringify(marker));assert.equal(repairs,0);
   if(!allowed)assert.ok(b.receipts.every(receipt=>receipt.status!=='complete'));
  }
 }finally{f.cleanup();}
});

test('actual group-only producer requirement cannot close direct or nested acceptance evidence',async()=>{
 const {learningFixture}=await import('../helpers/learning-fixture.mjs');
 const {learningContext}=await import('../../plugin/scripts/runtime-preferences.mjs');
 const {takeQueueLock,readSafe}=await import('../../plugin/scripts/learning-queue.mjs');
 const producer=process.env.RUVNET_TEST_RETIREMENT_PRODUCER
  ?await import(process.env.RUVNET_TEST_RETIREMENT_PRODUCER):await import('../../plugin/scripts/learning-worker-supervisor.mjs');
 const learning=learningFixture();let child;try{
  const context=learningContext({env:learning.env,cwd:learning.project}),token=takeQueueLock(context);let persistedRequirement;
  const report=await producer.superviseLearning(context,token,Date.now()+2000,{env:learning.env,spawnEngine:()=>{
   persistedRequirement=JSON.parse(readSafe(path.join(context.queueDir,'.worker-lock'))).retirementRequired;
   child=spawn(process.execPath,['-e',"process.send({type:'learning-worker-complete'});setInterval(()=>{},50)"],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:learning.env});return child;}});
  assert.equal(persistedRequirement,true);assert.equal(report.retirementRequired,true);assert.equal(report.retirementState,'GROUP_ONLY');assert.equal(report.retirementConfirmed,true);assert.equal(report.treeVerified,false);
  for(const nested of[false,true]){const f=fixture();try{let repairs=0;const b=boundaries(f,{checkAcceptance:async()=>{const a=f.acceptance();a.evidence[0].evidence=[nested?{evidence:[report]}:report];return a;},planRepair:async()=>{repairs++;throw Error('No repair of retirement uncertainty');}});
   const result=await runRoutingWorkflow(f.request,b.options);assert.equal(result.status,'blocked');assert.equal(repairs,0);assert.ok(b.receipts.every(r=>r.status!=='complete'));
  }finally{f.cleanup();}}
 }finally{if(child&&!child.killed)try{process.kill(-child.pid,'SIGKILL');}catch{}learning.cleanup();}
},15_000);

test.each(['acceptance','review'])('explicit uncertainty blocks %s completion and repair', async boundary => {
 const f=fixture();try {
  for(const marker of [{uncertainUsage:true},{retirementUnconfirmed:true},{retirementConfirmed:false}]) {
   let repairs=0;const b=boundaries(f,{planRepair:async()=>{repairs++;throw Error('uncertainty is not a quality repair');}});
   if(boundary==='acceptance')b.options.checkAcceptance=async()=>{const a=f.acceptance();Object.assign(a.evidence[0],marker);return a;};
   else {const review=b.options.review;b.options.review=async args=>{const v=await review(args);v.evidence.push({evidence:[marker]});return v;};}
   const result=await runRoutingWorkflow(f.request,b.options);
   assert.equal(result.status,'blocked',JSON.stringify(marker));assert.equal(result.reason,`${boundary}-boundary-blocked`);assert.equal(repairs,0);
   assert.ok(b.receipts.every(receipt=>receipt.status!=='complete'));
  }
 }finally{f.cleanup();}
});
