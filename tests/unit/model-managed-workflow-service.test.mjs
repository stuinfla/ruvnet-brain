import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { managedRoute, planManagedTask, executeManagedWorkflow, captureCheckerRegistry, runRegisteredChecker,
  commitManagedReceipt } from '../../scripts/model-managed-workflow-service.mjs';
import { selectDecision } from '../../scripts/model-router-engine.mjs';
import * as routingPolicy from '../../config/model-router/policy.default.mjs';
import { artifactDigest } from '../../scripts/model-routing-controller.mjs';
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
      const canonical = JSON.parse(state.worker.prompt.split('\n\nInternal dependency')[0]);
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

test('verified quality repair dynamically selects the approved eligible hard route and refuses an unchanged route', async () => {
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
  await assert.rejects(managedRoute({ ...repairInput, priorDecision: repair }, deps), /No stronger eligible owner-approved/);
  selection.routes.codex.hard = { model: 'routine-fixture', effort: 'high' };
  assert.equal((await managedRoute(repairInput, deps)).effort, 'high');
  selection.routes.codex.hard = { model: 'routine-fixture', effort: 'medium' };
  await assert.rejects(managedRoute(repairInput, deps), /No stronger eligible owner-approved/);
  selection.routes.codex.hard = { model: 'unavailable-fixture', effort: 'high' };
  await assert.rejects(managedRoute(repairInput, deps), /unavailable or unauthorized/);
  await assert.rejects(managedRoute({ ...input, taskFacts: { verifiedTaskQualityFailure: true } }, deps), /validated controller feedback/);
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
        const packet = JSON.parse(state.worker.prompt);
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
      createAdapters: executor([], (state) => { const packet = JSON.parse(state.worker.prompt);
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
