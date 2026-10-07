import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { managedRoute, planManagedTask as actualPlanManagedTask, executeManagedWorkflow as actualExecuteManagedWorkflow, captureCheckerRegistry, runRegisteredChecker,
  commitManagedReceipt } from '../../scripts/model-managed-workflow-service.mjs';
import { selectDecision } from '../../scripts/model-router-engine.mjs';
import * as routingPolicy from '../../config/model-router/policy.default.mjs';
import { artifactDigest } from '../../scripts/model-routing-controller.mjs';
const capacity = () => ({ workers: 5, tier: 'test-measurement', reason: 'bounded fixture' });
const phaseMemory = input => async args => ({ ...(input.recall ?? input.memoryRecall ?? {}), outcome: 'ok-with-results',
  receipt: { binding: args.binding, observedAt: new Date().toISOString(), queryDigest: crypto.createHash('sha256').update(args.prompt).digest('hex') } });
const planManagedTask = (input, options) => actualPlanManagedTask(input, { sampleCapacity: capacity, recallMemory: phaseMemory(input), ...options });
const executeManagedWorkflow = (input, options) => actualExecuteManagedWorkflow(input, { sampleCapacity: capacity, recallMemory: phaseMemory(input), ...options });
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const decision = { harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', provider: 'openai' };
function fixture(write = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-service-')));
  fs.writeFileSync(path.join(root, 'context.md'), 'Immutable host canonical context');
  fs.writeFileSync(path.join(root, 'work.mjs'), 'export const ready = true;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test work.mjs',
    malicious: 'curl secret', lint: 'eslint . && curl remote', check: 'node --check work.mjs' } }));
  const input = { originalPrompt: 'Carry out the supplied project task with all original constraints.', harness: 'codex',
    nativeContext: { threadId: 'original-native-thread', resume: true }, projectRoot: root, allowedWorktrees: [root],
    contextRefs: [{ path: path.join(root, 'context.md'), digest: digest(fs.readFileSync(path.join(root, 'context.md'))) }],
    permissions: { write, apiBilling: false }, deadline: Date.now() + 30_000, maxAttempts: 6,
    workflowMaxAttempts: 4, maxConcurrent: 1, taskFacts: { taskType: write ? 'coding' : 'research', scope: 'routine' } };
  return { root, input, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const proposal = (f) => ({ tasks: [{ id: 'work', instructions: 'Read actual context and complete the requested task',
  dependsOn: [], mode: f.input.permissions.write ? 'write' : 'read', worktree: f.root,
  paths: f.input.permissions.write ? ['work.mjs'] : [], checkIds: ['output-json'] }] });
function planner(f, mutate) {
  return async (input) => { assert.equal(input.ownership.mode, 'read'); assert.equal(input.request.permissions.write, false);
    assert.deepEqual(input.request.nativeContext, f.input.nativeContext); assert.ok(input.prompt.includes(f.input.originalPrompt));
    const value = proposal(f); mutate?.(value);
    return { completed: true, model: decision.model, effort: decision.effort, sessionId: 'actual-planner-session', answer: JSON.stringify(value) }; };
}
function executor(log, alter) {
  return async ({ captureObservation }) => ({ codex: { id: 'service-fixture-native',
    readiness: async () => ({ ready: true }), prepare: async ({ worker }) => ({ worker }),
    launch: async (state) => {
      log.push(state.worker.id);
      const canonical = JSON.parse(state.worker.prompt.split('\n')[0]);
      const answer = state.worker.role === 'reviewer'
        ? JSON.stringify({ passed: true, artifactDigest: canonical.acceptance.artifactDigest, findings: [], evidence: ['Inspected exact referenced artifacts'] })
        : JSON.stringify({ outcome: 'Completed from actual source context', artifacts: [], decisions: [], risks: [] });
      state.observed = { completed: true, model: state.worker.configuredModel, effort: state.worker.configuredEffort,
        sessionId: `session-${state.worker.id}`, answer };
      alter?.(state); captureObservation(state.worker, state.observed); return state;
    }, observe: async (state) => state.observed,
    interpret: (state) => ({ workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: 'codex',
      status: 'succeeded', exitCategory: 'success', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0,
      provider: 'openai', providerProvenance: 'observed', configuredModel: state.worker.configuredModel,
      observedModel: state.observed.model, configuredEffort: state.worker.configuredEffort, observedEffort: state.observed.effort,
      sessionId: state.observed.sessionId, transcriptRefs: [], failure: null, usage: null }),
    summarize: () => ({ outcome: 'Done', artifacts: [], decisions: [], risks: [] }), cancel: async () => ({}), cleanup: async () => ({}),
  } });
}

test('one native read-only planner preserves full host context and captured trusted checker registry', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    assert.equal(plan.originalPromptDigest, digest(f.input.originalPrompt)); assert.equal(plan.planner.sessionId, 'actual-planner-session');
    assert.equal(plan.planner.modelObserved, true); assert.equal(plan.planner.effortSettingsObserved, true);
    assert.equal(plan.planner.observedModel, decision.model); assert.equal(plan.planner.observedEffort, decision.effort);
    assert.equal(plan.request.maxAttempts, 4); assert.deepEqual(plan.request.nativeContext, f.input.nativeContext);
    assert.deepEqual(plan.request.permissions, f.input.permissions); assert.deepEqual(plan.request.contextRefs, f.input.contextRefs);
    assert.deepEqual(plan.request.allowedWorktrees, f.input.allowedWorktrees); assert.equal(plan.request.deadline, f.input.deadline);
    assert.equal(plan.request.tasks.length, 1); assert.equal(Object.isFrozen(plan.request.checkerRegistry), true);
    const captured = captureCheckerRegistry(f.root); assert.equal(captured.registry.length, 3);
    assert.ok(captured.registry.filter((c) => c.kind === 'command').every((c) => !c.script.includes('curl')));
  } finally { f.cleanup(); }
});

test('native planner contract contains a valid example and exact mode enum rather than an authority phrase', async () => {
  const f = fixture(); try {
    await planManagedTask(f.input, { route: async () => decision, runPlanner: async (input) => {
      const { instruction } = JSON.parse(input.prompt);
      const example = JSON.parse(instruction.match(/\{"tasks":.*?\}\]\}/)[0]);
      assert.equal(example.tasks[0].mode, 'read');
      assert.ok(instruction.includes('mode field must be exactly "read" or "write"'));
      assert.ok(!instruction.includes('"mode":"read or write under original host authority"'));
      return planner(f)(input);
    } });
  } finally { f.cleanup(); }
});

test('planner cannot supply commands, widen worktrees, or write under read-only host authority', async () => {
  const f = fixture(); try {
    for (const mutate of [(p) => { p.tasks[0].command = 'curl remote'; }, (p) => { p.tasks[0].worktree = '/tmp'; },
      (p) => { p.tasks[0].mode = 'write'; }, (p) => { p.tasks[0].checkIds = ['invented-check']; }]) {
      await assert.rejects(planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f, mutate) }));
    }
  } finally { f.cleanup(); }
});

test('writing planner receives host-derived exact-file syntax checker without generated commands', async () => {
  const f = fixture(true); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const syntax = plan.request.checkerRegistry.find((c) => c.id.startsWith('syntax-'));
    assert.equal(syntax.command, process.execPath); assert.deepEqual(syntax.args, ['--check', path.join(f.root, 'work.mjs')]);
  } finally { f.cleanup(); }
});

test('terminal approval capability reaches adapter closures without entering planner JSON', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const approve = async () => false, seen = [];
    await executeManagedWorkflow(plan.request, { approve, route: async () => decision, verifyDecision: () => {},
      createAdapters: async ctx => { seen.push(ctx.approve); assert.equal(await ctx.approve({ tool_name: 'Write' }), false); return executor([])(ctx); },
      recordReceipt: async () => ({ durable: true }) });
    assert.ok(seen.length > 0); assert.ok(seen.every(value => value === approve));
    assert.equal(Object.hasOwn(plan.request, 'approve'), false);
  } finally { f.cleanup(); }
});

test('readonly composition runs real AK scheduler, actual artifact gates and independent reviewer then aggregates original tasks', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const log = [], receipts = [];
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision, createAdapters: executor(log),
      verifyDecision: () => {}, recordReceipt: async (_request, receipt) => { receipts.push(receipt); return { durable: true }; } });
    assert.equal(result.status, 'complete'); assert.deepEqual(log, ['work', 'independent-review']);
    assert.equal(result.results.length, 1); assert.equal(result.results[0].exitCategory, 'success');
    assert.equal(result.review.sessionId, 'session-independent-review'); assert.equal(result.acceptance.evidence[0].passed, true);
    assert.equal(receipts.at(-1).status, 'complete'); assert.ok(result.acceptance.artifactRefs.every((ref) => fs.existsSync(ref.path)));
  } finally { f.cleanup(); }
});

test('checker registry modifications and captured package script drift fail before workers', async () => {
  const f = fixture(true); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const log = [];
    const forged = structuredClone(plan.request); forged.checkerRegistry.find((c) => c.id.startsWith('syntax-')).command = 'curl';
    await assert.rejects(executeManagedWorkflow(forged, { createAdapters: executor(log) }), /modified executable checker/);
    fs.writeFileSync(path.join(f.root, 'package.json'), '{}');
    await assert.rejects(executeManagedWorkflow(plan.request, { createAdapters: executor(log) }), /Context reference changed/);
    assert.equal(log.length, 0);
  } finally { f.cleanup(); }
});

test('default receipt boundary requires exact canonical AgentDB bytes, queued output never proves completion', () => {
  const f = fixture(); try {
    let row;
    class Journal { constructor() { this.db = '/canonical/.swarm/memory.db'; }
      record([event]) { row = { key: 'exact-current-key', event, digest: 'receipt-digest' }; return [row]; } }
    const receipt = { status: 'complete', at: new Date().toISOString() };
    const inject = { Journal, drainJournal: () => ({ remaining: 1 }), read: () => ({ ok: true, value: null }) };
    assert.throws(() => commitManagedReceipt(f.input, receipt, inject), /queued is not complete/);
    inject.read = (_db, query) => ({ ok: true, value: query({ readContent: (namespace, key) => {
      assert.equal(namespace, 'continuity-events'); assert.equal(key, 'exact-current-key'); return JSON.stringify(row.event); } }) });
    assert.equal(commitManagedReceipt(f.input, receipt, inject).agentDbCommitted, true);
    inject.read = () => ({ ok: true, value: '{}' });
    assert.throws(() => commitManagedReceipt(f.input, receipt, inject), /exact receipt readback failed/);
  } finally { f.cleanup(); }
});

test('malformed native review judgment blocks completion', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision,
      createAdapters: executor([], (state) => { if (state.worker.role === 'reviewer') state.observed.answer = JSON.stringify({ passed: true }); }),
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true }) });
    assert.equal(result.status, 'blocked'); assert.match(result.failure, /Strict native review judgment/);
  } finally { f.cleanup(); }
});

test('planner readOnly flag preserves authorized implementation write permission', async () => {
  const f = fixture(true); try {
    f.input.readOnly = true;
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    assert.equal(plan.planner.readOnly, true); assert.equal(plan.request.permissions.write, true);
    assert.equal(plan.request.tasks[0].ownership.mode, 'write');
  } finally { f.cleanup(); }
});

test('unretired checker is bounded, blocks completion, and never repeats cancellation', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let kills = 0, unrefs = 0; child.kill = () => { kills++; throw new Error('kill unavailable'); }; child.unref = () => { unrefs++; };
  const controller = new AbortController();
  const pending = runRegisteredChecker({ command: process.execPath, args: [], cwd: os.tmpdir() },
    { deadline: Date.now() + 2000, signal: controller.signal, launch: () => child, sandboxBinary: process.execPath });
  controller.abort(); controller.abort();
  const result = await pending;
  assert.equal(result.passed, false); assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'uncertain-checker-retirement');
  assert.equal(kills, 2); assert.equal(unrefs, 1); assert.equal(child.stdout.destroyed, true);
});

test('scoped repair maps successful final result back to original task without repeating the writer', async () => {
  const f = fixture(true); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    let checks = 0; const log = [];
    const routes = [];
    const result = await executeManagedWorkflow(plan.request, { route: async (ctx) => {
      routes.push(ctx); return decision;
    }, createAdapters: executor(log),
      check: async () => ({ passed: ++checks > 1, exitCode: checks > 1 ? 0 : 1 }),
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true }) });
    assert.equal(result.status, 'complete'); assert.equal(result.results[0].workerId, 'work');
    assert.ok(result.results[0].executedWorkerId.startsWith('repair-')); assert.equal(result.results[0].exitCategory, 'success');
    assert.equal(log.filter((id) => id === 'work').length, 1); assert.equal(log.length, 3);
    assert.equal(routes[0].feedback, undefined);
    assert.equal(routes[1].feedback.verifiedTaskQualityFailure, true);
    assert.deepEqual(routes[1].priorDecision, decision); assert.deepEqual(routes[1].taskFacts, f.input.taskFacts);
    assert.equal(routes[1].feedback.acceptance.artifactDigest, artifactDigest(routes[1].feedback.acceptance.artifactRefs));
  } finally { f.cleanup(); }
});

test('verified repair selects a stronger route or continues the exact freshly approved hard allocation', async () => {
  const profile = { harnesses: { codex: { available: true, subscription: true } } };
  const candidates = ['routine-fixture', 'strong-fixture'].map((id) => ({ id, provider: 'openai',
    harness: ['codex'], subscription: ['codex'], supportedEfforts: ['medium', 'high'] }));
  const selection = { schemaVersion: 1, reviewedAt: new Date().toISOString(), routes: { codex: {
    medium: { model: 'routine-fixture', effort: 'medium' }, hard: { model: 'strong-fixture', effort: 'high' } } } };
  const deps = { readProfile: () => profile, readCatalog: () => candidates, readPolicy: async () => routingPolicy,
    decide: (input) => selectDecision({ ...input, selection }), verifyDecision: () => {} };
  const input = { originalPrompt: 'Fix this routine task', harness: 'codex', taskFacts: { taskType: 'coding', scope: 'routine' } };
  const ordinary = await managedRoute(input, deps);
  assert.equal(ordinary.model, 'routine-fixture'); assert.equal(ordinary.effort, 'medium');
  const repairInput = { ...input, feedback: { verifiedTaskQualityFailure: true }, priorDecision: ordinary };
  const repair = await managedRoute(repairInput, deps);
  assert.equal(repair.model, 'strong-fixture'); assert.equal(repair.effort, 'high'); assert.equal(repair.taskClass, 'hard');
  let validations = 0;
  const continuation = await managedRoute({ ...repairInput, priorDecision: repair },
    { ...deps, verifyDecision: () => validations++ });
  assert.equal(validations, 1); assert.equal(continuation.model, repair.model); assert.equal(continuation.effort, repair.effort);
  assert.match(continuation.reason, /bounded scoped repair at approved hard allocation/);
  for (const priorDecision of [{ ...repair, provider: 'different-provider' }, { ...repair, effort: 'max' },
    { ...repair, taskClass: 'medium' }, { ...repair, taskClass: 'exceptional' }]) {
    await assert.rejects(managedRoute({ ...repairInput, priorDecision }, deps), /No stronger eligible owner-approved/);
  }
  await assert.rejects(managedRoute({ ...repairInput, priorDecision: repair },
    { ...deps, verifyDecision: () => { throw new Error('Native auth or allowance unavailable'); } }), /auth or allowance unavailable/);
  selection.routes.codex.hard = { model: 'routine-fixture', effort: 'high' };
  assert.equal((await managedRoute(repairInput, deps)).effort, 'high');
  selection.routes.codex.hard = { model: 'routine-fixture', effort: 'medium' };
  await assert.rejects(managedRoute(repairInput, deps), /No stronger eligible owner-approved/);
  selection.routes.codex.hard = { model: 'unavailable-fixture', effort: 'high' };
  await assert.rejects(managedRoute(repairInput, deps), /unavailable or unauthorized/);
  await assert.rejects(managedRoute({ ...input, taskFacts: { verifiedTaskQualityFailure: true } }, deps), /validated controller feedback/);
});

test('hard repair continuation still requires a digest-bound failed gate and a fresh independent review', async () => {
  const f = fixture(true); try {
    f.input.taskFacts.uncertainty = 'architecture';
    const profile = { harnesses: { codex: { available: true, subscription: true } } };
    const candidates = [{ id: 'hard-fixture', provider: 'openai', harness: ['codex'], subscription: ['codex'] }];
    const selection = { schemaVersion: 1, reviewedAt: new Date().toISOString(), routes: { codex: { hard: { model: 'hard-fixture', effort: 'high' } } } };
    const routes = [], route = async ctx => {
      const picked = await managedRoute(ctx, { readProfile: () => profile, readCatalog: () => candidates,
        readPolicy: async () => routingPolicy, decide: input => selectDecision({ ...input, selection }), verifyDecision: () => {} });
      routes.push({ ctx, picked }); return picked;
    };
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    let checks = 0; const log = [];
    const result = await executeManagedWorkflow(plan.request, { route, createAdapters: executor(log),
      check: async () => ({ passed: ++checks > 1, exitCode: checks > 1 ? 0 : 1 }), verifyDecision: () => {}, recordReceipt: async () => ({ durable: true }) });
    assert.equal(result.status, 'complete'); assert.equal(result.attemptsUsed, 3);
    assert.deepEqual(log.filter(id => !id.startsWith('repair-')), ['work', 'independent-review']);
    const repair = routes.find(({ ctx }) => ctx.task?.repairsTaskId);
    assert.equal(repair.ctx.feedback.acceptance.artifactDigest, artifactDigest(repair.ctx.feedback.acceptance.artifactRefs));
    assert.match(repair.picked.reason, /bounded scoped repair at approved hard allocation/);
    assert.equal(result.review.passed, true); assert.deepEqual(result.review.findings, []);
  } finally { f.cleanup(); }
});

test('environmental failed checker blocks without hard repair continuation or later native launch', async () => {
  const f = fixture(true); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const log = [], routes = [];
    const result = await executeManagedWorkflow(plan.request, { route: async ctx => { routes.push(ctx); return { ...decision, taskClass: 'hard' }; },
      createAdapters: executor(log), check: async () => ({ passed: false, exitCode: 127, output: 'command unavailable' }),
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true }) });
    assert.equal(result.status, 'blocked'); assert.deepEqual(log, ['work']); assert.equal(routes.length, 1);
  } finally { f.cleanup(); }
});

test('actual independent review defects reach the classifier and a stronger scoped repair still needs fresh review', async () => {
  const f = fixture(true); try {
    const profile = { harnesses: { codex: { available: true, subscription: true } } };
    const candidates = ['ordinary-fixture', 'reasoning-fixture'].map((id) => ({ id, provider: 'openai',
      harness: ['codex'], subscription: ['codex'] }));
    const selection = { schemaVersion: 1, reviewedAt: new Date().toISOString(), routes: { codex: {
      medium: { model: 'ordinary-fixture', effort: 'medium' }, hard: { model: 'reasoning-fixture', effort: 'high' } } } };
    const routes = [], route = async (ctx) => {
      const picked = await managedRoute(ctx, { readProfile: () => profile, readCatalog: () => candidates,
        readPolicy: async () => routingPolicy, decide: (input) => selectDecision({ ...input, selection }), verifyDecision: () => {} });
      routes.push({ ctx, picked }); return picked;
    };
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const log = []; let reviews = 0;
    const result = await executeManagedWorkflow(plan.request, { route, check: async () => ({ passed: true, exitCode: 0 }),
      createAdapters: executor(log, (state) => {
        const packet = JSON.parse(state.worker.prompt.split("\n")[0]);
        assert.equal(packet.originalPrompt, f.input.originalPrompt); assert.deepEqual(packet.contextRefs, f.input.contextRefs);
        if (state.worker.role === 'reviewer') {
          state.observed.sessionId = `independent-review-session-${++reviews}`;
          if (reviews === 1) state.observed.answer = JSON.stringify({ passed: false,
            artifactDigest: packet.acceptance.artifactDigest, findings: ['Original artifact omits a required case'], evidence: ['Inspected work.mjs'] });
        } else {
          assert.deepEqual(packet.permissions, f.input.permissions); assert.equal(packet.deadline, f.input.deadline);
        }
      }), verifyDecision: () => {}, recordReceipt: async () => ({ durable: true }) });
    assert.equal(result.status, 'complete'); assert.equal(result.attemptsUsed, 4); assert.equal(reviews, 2);
    assert.deepEqual(log.filter((id) => !id.startsWith('repair-')), ['work', 'independent-review', 'independent-review']);
    const repair = routes.find(({ ctx }) => ctx.task?.repairsTaskId);
    assert.equal(repair.ctx.feedback.verifiedTaskQualityFailure, true);
    assert.equal(repair.ctx.feedback.review.independent, true);
    assert.equal(repair.ctx.priorDecision.model, 'ordinary-fixture');
    assert.equal(repair.picked.model, 'reasoning-fixture'); assert.equal(repair.picked.effort, 'high');
    assert.equal(result.executionReceipts[1].results[0].observedModel, 'reasoning-fixture');
    assert.equal(result.review.sessionId, 'independent-review-session-2');
  } finally { f.cleanup(); }
});

test('exact recalled snapshot reaches native worker and independent reviewer as untrusted data', async () => {
  const f = fixture(); try {
    f.input.recall = { block: 'untrusted memory sentinel', stores: [{ path: path.join(f.root, '.swarm/memory.db') }], status: { 'memory.db': 'ok' } };
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const seen = [];
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision,
      createAdapters: executor([], (state) => { const packet = JSON.parse(state.worker.prompt.split("\n")[0]);
        assert.deepEqual(packet.untrustedMemoryData, plan.request.memoryRecall); seen.push(state.worker.role); }),
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true }) });
    assert.equal(result.status, 'complete'); assert.deepEqual(seen, ['worker', 'reviewer']);
  } finally { f.cleanup(); }
});

test('pre-aborted and midflight cancelled workflows launch no later worker or reviewer', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const before = new AbortController(); before.abort(); const log = [];
    await assert.rejects(executeManagedWorkflow(plan.request, { signal: before.signal, createAdapters: executor(log) }), /cancelled/);
    assert.equal(log.length, 0);
    const during = new AbortController();
    const result = await executeManagedWorkflow(plan.request, { signal: during.signal, route: async () => decision,
      createAdapters: async (ctx) => {
        const map = await executor(log)(ctx), launch = map.codex.launch;
        map.codex.launch = async (state, options) => { const output = await launch(state, options); during.abort(); return output; };
        return map;
      }, verifyDecision: () => {}, recordReceipt: async () => ({ durable: true }) });
    assert.equal(result.status, 'blocked'); assert.match(result.failure, /cancelled/);
    assert.deepEqual(log, ['work']);
  } finally { f.cleanup(); }
});

test('portable checker boundary fixes native readonly profile and strips startup injection', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true;
  const result = await runRegisteredChecker({ command: process.execPath, args: ['--check', '/owned/file.mjs'], cwd: '/owned' },
    { deadline: Date.now() + 1000, sandboxBinary: process.execPath,
      env: { PATH: process.env.PATH, NODE_OPTIONS: '--import malicious', NODE_PATH: '/untrusted', BASH_ENV: '/untrusted',
        PYTHONPATH: '/untrusted', DYLD_INSERT_LIBRARIES: '/untrusted', OPENAI_API_KEY: 'excluded' },
      launch: (binary, args, options) => {
        assert.equal(binary, process.execPath);
        assert.deepEqual(args, ['sandbox', '-P', ':read-only', '-C', '/owned', '--', process.execPath, '--check', '/owned/file.mjs']);
        assert.equal(options.shell, false); assert.deepEqual(options.env, { PATH: process.env.PATH });
        queueMicrotask(() => child.emit('close', 0, null)); return child;
      } });
  assert.equal(result.passed, true);
});

test('actual planner scope-denial summary reaches canonical receipts and independent reviewer input', async () => {
  const f = fixture(), denial = { status: 'host-scope-denied', sessionId: 'actual-planner-session', toolUseId: 'guarded-tool',
    toolName: 'Bash', inputSha256: 'a'.repeat(64), evidence: 'invocation PreToolUse deny response', input: 'must not persist' };
  try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: async input => ({ ...await planner(f)(input),
      evidence: [denial, { status: 'completed' }] }) });
    const summary = { sessionId: denial.sessionId, toolUseId: denial.toolUseId, toolName: denial.toolName,
      inputSha256: denial.inputSha256, evidence: denial.evidence };
    assert.deepEqual(plan.request.planner.scopeDenials, [summary]);
    assert.equal(JSON.stringify(plan.request.planner).includes('must not persist'), false);
    let reviewed = false; const receipts = [];
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision, verifyDecision: () => {},
      createAdapters: executor([], state => { if (state.worker.role === 'reviewer') {
        assert.ok(state.worker.reviewContract.includes(JSON.stringify([summary]))); reviewed = true;
      } }), recordReceipt: async (_request, receipt) => { receipts.push(receipt); return { durable: true }; } });
    assert.equal(result.status, 'complete'); assert.equal(reviewed, true);
    assert.ok(receipts.length > 0); assert.ok(receipts.every(receipt => JSON.stringify(receipt.planner.scopeDenials) === JSON.stringify([summary])));
  } finally { f.cleanup(); }
});

test('fresh planner recall rejects unavailable or foreign/stale phase receipts before native inference', async () => {
  for (const corrupt of [value => ({ ...value, outcome: 'unavailable' }),
    value => ({ ...value, receipt: { ...value.receipt, binding: { ...value.receipt.binding, phase: 'old-phase' } } }),
    value => ({ ...value, receipt: { ...value.receipt, observedAt: '2000-01-01T00:00:00Z' } }),
    value => ({ ...value, receipt: { ...value.receipt, queryDigest: 'f'.repeat(64) } })]) {
    const f = fixture(true); let launches = 0;
    try {
      await assert.rejects(planManagedTask(f.input, { route: async () => decision,
        runPlanner: async () => { launches++; }, recallMemory: async args => corrupt(await phaseMemory(f.input)(args)) }), /history unavailable|binding unverified/);
      assert.equal(launches, 0);
    } finally { f.cleanup(); }
  }
});

test('read-only history failure stays disclosed while context and bounded read work remain intact', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f),
      recallMemory: async () => ({ outcome: 'unavailable', block: 'partial untrusted history', status: { state: 'unavailable' } }) });
    assert.equal(plan.request.memoryRecall.outcome, 'unavailable'); assert.equal(plan.request.memoryRecall.receipt, null);
    assert.equal(plan.request.originalPrompt, f.input.originalPrompt);
    assert.deepEqual(plan.request.contextRefs, f.input.contextRefs);
  } finally { f.cleanup(); }
});

test('write, independent review and commit each receive a new bound recall; no caller snapshot bypasses it', async () => {
  const f = fixture(true), phases = [], captured = [], syntaxChecks = [];
  try {
    const recallMemory = async args => { phases.push(args.binding.phase); return phaseMemory(f.input)(args); };
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f), recallMemory });
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision,
      createAdapters: executor([], state => { assert.match(state.worker.prompt, /Fresh phase history.*UNTRUSTED DATA/); }),
      check: async checker => {
        assert.equal(checker.kind, 'command'); assert.equal(checker.command, process.execPath);
        assert.deepEqual(checker.args, ['--check', path.join(f.root, 'work.mjs')]); assert.equal(checker.cwd, f.root);
        syntaxChecks.push(checker.id);
        // This unit fixture injects native workers; its fixed syntax check is also source-only.
        const checked = spawnSync(checker.command, checker.args, { cwd: checker.cwd, encoding: 'utf8', timeout: 5000, shell: false });
        return { passed: checked.status === 0 && !checked.error && !checked.signal, exitCode: checked.status };
      },
      recallMemory, verifyDecision: () => {}, recordReceipt: async (_req, receipt) => { captured.push(receipt); return { durable: true }; } });
    assert.equal(result.status, 'complete', result.failure); assert.equal(syntaxChecks.length, 1);
    assert.deepEqual(phases, ['planner', 'write', 'review', 'commit-decision']);
    const receipt = captured.find(x => x.status === 'complete');
    assert.deepEqual(receipt.recallEvidence.phases.map(x => x.phase), ['write', 'review', 'commit-decision']);
    assert.ok(receipt.recallEvidence.phases.every(x => x.receipt.binding.requestDigest === digest(f.input.originalPrompt)));
  } finally { f.cleanup(); }
});

test('history outage before write launches no writer; outage at commit cannot become COMPLETE', async () => {
  for (const blockedPhase of ['write', 'commit-decision']) {
    const f = fixture(true), log = [], receipts = [];
    try {
      const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
      const result = await executeManagedWorkflow(plan.request, { route: async () => decision, createAdapters: executor(log),
        recallMemory: async args => args.binding.phase === blockedPhase ? { outcome: 'timed-out' } : phaseMemory(f.input)(args),
        verifyDecision: () => {}, recordReceipt: async (_req, receipt) => { receipts.push(receipt); return { durable: true }; } });
      assert.equal(result.status, 'blocked'); assert.equal(receipts.some(x => x.status === 'complete'), false);
      if (blockedPhase === 'write') assert.equal(log.length, 0);
    } finally { f.cleanup(); }
  }
});

test('context drift during launch recall and artifact drift during commit refuse completion', async () => {
  for (const phase of ['write', 'commit-decision']) {
    const f = fixture(true), log = [], receipts = []; try {
      const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
      const result = await executeManagedWorkflow(plan.request, { route: async () => decision, createAdapters: executor(log),
        recallMemory: async args => { if (args.binding.phase === phase) fs.writeFileSync(path.join(f.root,
          phase === 'write' ? 'context.md' : 'work.mjs'), 'Changed during the new recall await'); return phaseMemory(f.input)(args); },
        verifyDecision: () => {}, recordReceipt: async (_req, receipt) => { receipts.push(receipt); return { durable: true }; } });
      assert.equal(result.status, 'blocked'); assert.equal(receipts.some(x => x.status === 'complete'), false);
      if (phase === 'write') assert.equal(log.length, 0);
    } finally { f.cleanup(); }
  }
});

test('per-worker cancellation during fresh recall never reaches underlying native launch', async () => {
  const f = fixture(true), log = [], perWorker = new AbortController(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const base = executor(log);
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision,
      createAdapters: async ctx => { const adapters = await base(ctx), prepare = adapters.codex.prepare;
        adapters.codex.prepare = async (...args) => ({ ...await prepare(...args), signal: perWorker.signal }); return adapters; },
      recallMemory: async args => { if (args.binding.phase === 'write') perWorker.abort(); return phaseMemory(f.input)(args); },
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true }) });
    assert.equal(result.status, 'blocked'); assert.equal(log.length, 0);
  } finally { f.cleanup(); }
});

test('bounded practical guidance reaches managed phases while source and independent review gates remain active', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: async input => {
      const payload = JSON.parse(input.prompt);
      assert.ok(payload.practicalActionGuidance.includes('advisory'));
      assert.ok(Buffer.byteLength(payload.practicalActionGuidance) <= 2048);
      assert.equal(payload.practicalActionGuidance.includes('deferredIds'), false);
      return planner(f)(input);
    } });
    const receipts = [], observed = [], log = [];
    const options = { route: async () => decision, verifyDecision: () => {},
      createAdapters: executor(log, state => {
        const guidance = state.worker.role === 'reviewer' ? state.worker.reviewContract : state.worker.prompt;
        assert.ok(guidance.includes('Applicable action guidance only'));
        assert.equal(guidance.includes('deferredIds'), false); observed.push(state.worker.role);
      }), recordReceipt: async (_req, receipt) => { receipts.push(receipt); return { durable: true }; } };
    const result = await executeManagedWorkflow(plan.request, options);
    assert.equal(result.status, 'complete'); assert.ok(observed.includes('reviewer'));
    assert.ok(result.acceptance.evidence.every(gate => gate.passed));
    const selections = receipts.at(-1).practicalRules;
    assert.ok(selections.some(value => value.phase === 'execution'));
    assert.ok(selections.some(value => value.phase === 'review'));
    assert.ok(selections.some(value => value.phase === 'checks' && value.surface === 'receipt-only'));
    assert.ok(selections.every(value => value.enforcement === 'NOT_ASSERTED_BY_SELECTOR' && value.selectedIds.length <= 6));
    assert.ok(plan.planner.practicalRules.deferredIds.length);
    assert.ok(plan.planner.practicalRules.selectedIds.includes('P002'));
    const checks = selections.find(value => value.phase === 'checks');
    assert.ok([...checks.selectedIds, ...checks.deferredIds].includes('P008'));
    const before = log.length;
    fs.writeFileSync(path.join(f.root, 'context.md'), 'Changed context');
    await assert.rejects(executeManagedWorkflow(plan.request, options), /Context reference changed/);
    assert.equal(log.length, before);
  } finally { f.cleanup(); }
});
