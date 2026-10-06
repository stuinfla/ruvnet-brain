import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactDigest, buildWorkflowPlan, validateWorkflowRequest, validateWorkflowPlan,
  loadManagedRunner, runRoutingWorkflow } from '../../scripts/model-routing-controller.mjs';

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
    recordReceipt: async (_request, receipt) => { receipts.push(receipt); return { durable: true }; },
    ...overrides,
  } };
}

test('global installed Agentic Kit runner is actually resolved', async () => {
  assert.equal(typeof await loadManagedRunner(), 'function');
});

test('one ordinary worker preserves original context and launches independent review before completion', async () => {
  const f = fixture(); try {
    const b = boundaries(f);
    const result = await runRoutingWorkflow(f.request, b.options);
    assert.equal(result.status, 'complete'); assert.equal(result.attemptsUsed, 2);
    assert.deepEqual(b.log.filter(([phase]) => phase === 'launch').map(([, id]) => id), ['work', 'independent-review']);
    assert.deepEqual(b.receipts.map((r) => r.status), ['running', 'stage-finished', 'review-finished', 'complete']);
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

test('overlapping ownership and shared-worktree parallel writers are refused before effects', () => {
  const f = fixture(); try {
    f.request.permissions.write = true;
    f.request.tasks = ['one', 'two'].map((id) => ({ id, instructions: id, dependsOn: [],
      ownership: { mode: 'write', worktree: f.root, paths: ['src'] }, acceptanceChecks: [{ id: 'check' }] }));
    assert.throws(() => validateWorkflowRequest(f.request), /nonoverlapping/);
    f.request.tasks[1].ownership.paths = ['tests'];
    assert.throws(() => validateWorkflowRequest(f.request), /separate worktrees/);
    f.request.tasks[1].dependsOn = ['one']; assert.equal(validateWorkflowRequest(f.request), f.request);
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
