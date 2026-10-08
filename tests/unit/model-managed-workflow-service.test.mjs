import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { managedRoute, planManagedTask as actualPlanManagedTask, executeManagedWorkflow as actualExecuteManagedWorkflow, captureCheckerRegistry, runRegisteredChecker,
  commitManagedReceipt, boundedPolicyAuthorization } from '../../scripts/model-managed-workflow-service.mjs';
import { selectDecision } from '../../scripts/model-router-engine.mjs';
import * as routingPolicy from '../../config/model-router/policy.default.mjs';
import { artifactDigest } from '../../scripts/model-routing-controller.mjs';
import { createStore } from '../helpers/continuity-fixture.mjs';
const capacity = () => ({ workers: 5, tier: 'test-measurement', reason: 'bounded fixture' });
const phaseMemory = input => async args => ({ ...(input.recall ?? input.memoryRecall ?? {}), outcome: 'ok-with-results',
  receipt: { binding: args.binding, observedAt: new Date().toISOString(), queryDigest: crypto.createHash('sha256').update(args.prompt).digest('hex') } });
const planManagedTask = (input, options) => actualPlanManagedTask(input, { sampleCapacity: capacity, recallMemory: phaseMemory(input), ...options });
// Mechanical checker seam: actual fixture argv only; never launch a native model session.
const fixtureCheck = async checker => {
  const result = spawnSync(checker.command, checker.args, { cwd: checker.cwd, encoding: 'utf8' });
  return { passed: result.status === 0, exitCode: result.status, stdoutDigest: digest(result.stdout || '') };
};
const executeManagedWorkflow = (input, options) => actualExecuteManagedWorkflow(input, { sampleCapacity: capacity,
  recallMemory: phaseMemory(input), check: fixtureCheck, ...options });
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const decision = { harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', provider: 'openai' };
function fixture(write = false, adopted = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-service-')));
  if (adopted) { fs.mkdirSync(path.join(root, '.swarm')); createStore(path.join(root, '.swarm', 'memory.db')); }
  fs.writeFileSync(path.join(root, 'context.md'), 'Immutable host canonical context');
  fs.writeFileSync(path.join(root, 'work.mjs'), 'export const ready = true;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test acceptance.test.mjs',
    malicious: 'curl secret', lint: 'eslint . && curl remote', check: 'node --check work.mjs' } }));
  fs.writeFileSync(path.join(root, 'acceptance.test.mjs'), "import assert from 'node:assert/strict'; import {ready} from './work.mjs'; assert.equal(ready, true);");
  const input = { originalPrompt: 'Carry out the supplied project task with all original constraints.', harness: 'codex',
    nativeContext: { threadId: 'original-native-thread', resume: true }, projectRoot: root, allowedWorktrees: [root],
    contextRefs: [{ path: path.join(root, 'context.md'), digest: digest(fs.readFileSync(path.join(root, 'context.md'))) }],
    permissions: { write, apiBilling: false }, deadline: Date.now() + 30_000, maxAttempts: 6,
    workflowMaxAttempts: 4, maxConcurrent: 1, taskFacts: { taskType: write ? 'coding' : 'research', scope: 'routine' } };
  return { root, input, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const proposal = (f) => ({ unresolvedObligations: [], tasks: [{ id: 'work', instructions: 'Read actual context and complete the requested task',
  dependsOn: [], mode: f.input.permissions.write ? 'write' : 'read', worktree: f.root,
  paths: f.input.permissions.write ? ['work.mjs'] : [], checkIds: [captureCheckerRegistry(f.root).registry.find(check => check.script?.startsWith('node --test')).id],
  acceptanceCriteria: [{ id: 'requested-result', assertion: 'Source fixture executable test proves the required result',
    checkIds: [captureCheckerRegistry(f.root).registry.find(check => check.script?.startsWith('node --test')).id] }] }] });
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
        ? JSON.stringify({ passed: true, artifactDigest: canonical.acceptance.artifactDigest, findings: [], evidence: ['Inspected exact referenced artifacts'],
          criterionCoverage: canonical.acceptance.evidence.filter(item => item.checkId !== 'output-json' && !item.checkId.startsWith('syntax-')).map(item => ({ taskId: item.taskId, criterionId: 'requested-result', checkIds: [item.checkId], passed: true, evidence: ['Inspected source-bound fixture test'] })),
          coverage: ['entry','caller','consumer','config','error'].map(dimension => ({ dimension, state: 'not-applicable', evidence: ['Disposable mechanical fixture scope only'] })), omissions: [] })
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
    assert.equal(plan.request.continuationRegistration.state, 'UNVERIFIED');
    assert.equal(Object.hasOwn(plan.request.continuationRegistration, 'binding'), false);
    const captured = captureCheckerRegistry(f.root); assert.equal(captured.registry.length, 3);
    assert.ok(captured.registry.filter((c) => c.kind === 'command').every((c) => !c.script.includes('curl')));
  } finally { f.cleanup(); }
});

test('native planner contract contains a valid example and exact mode enum rather than an authority phrase', async () => {
  const f = fixture(); try {
    await planManagedTask(f.input, { route: async () => decision, runPlanner: async (input) => {
      const { instruction } = JSON.parse(input.prompt);
      const example = JSON.parse(instruction.slice(instruction.indexOf('{"tasks":'), instruction.indexOf('. The mode')));
      assert.equal(example.tasks[0].mode, 'read');
      assert.ok(instruction.includes('mode field must be exactly "read" or "write"'));
      assert.ok(!instruction.includes('"mode":"read or write under original host authority"'));
      return planner(f)(input);
    } });
  } finally { f.cleanup(); }
});

test('caller trust labels and native turn IDs cannot authorize registration before canonical intake', async () => {
  const f = fixture(); try {
    let routes = 0, registrations = 0;
    f.input.nativeUserInstruction = { trusted: true,
      nativeUserEventRef: { kind: 'codex-turn-id', id: 'claimed-current-user-turn' } };
    await assert.rejects(planManagedTask(f.input, {
      route: async () => { routes++; return decision; }, runPlanner: planner(f),
      recordRegistration: async () => { registrations++; return { durable: true, agentDbCommitted: true }; },
    }), /native intake exact receipt required/);
    assert.equal(routes, 0); assert.equal(registrations, 0);
  } finally { f.cleanup(); }
});

test('unsupported current native intake stays unverified and does not register a continuation', async () => {
  const f = fixture(); try {
    f.input.nativeUserInstruction = { status: 'UNVERIFIED', reason: 'current native user record not yet exposed' };
    let registrations = 0;
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f),
      recordRegistration: async () => { registrations++; return { durable: true, agentDbCommitted: true }; } });
    assert.equal(plan.request.continuationRegistration.state, 'UNVERIFIED');
    assert.equal(Object.hasOwn(plan.request.continuationRegistration, 'binding'), false);
    assert.equal(registrations, 0);
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

test('JSON shape, syntax-only and unmapped criteria cannot establish task acceptance', async () => {
  const f = fixture(); try {
    for (const mutate of [p => { p.tasks[0].checkIds = ['output-json']; p.tasks[0].acceptanceCriteria[0].checkIds = ['output-json']; },
      p => { const syntax = captureCheckerRegistry(f.root).registry.find(check => check.script?.startsWith('node --check')).id;
        p.tasks[0].checkIds = [syntax]; p.tasks[0].acceptanceCriteria[0].checkIds = [syntax]; },
      p => { delete p.tasks[0].acceptanceCriteria; }, p => { delete p.unresolvedObligations; },
      p => { p.unresolvedObligations = ['Original caller/consumer acceptance still unavailable']; }, p => { p.tasks[0].acceptanceCriteria[0].checkIds = ['invented-check']; }]) {
      await assert.rejects(planManagedTask(f.input, {route:async()=>decision,runPlanner:planner(f, mutate)}), /acceptance|criteria|scope/i);
    }
  } finally { f.cleanup(); }
});

test('passing independent review cannot omit criterion or source-path coverage', async () => {
  const f = fixture(); try {
    for (const field of ['criterionCoverage', 'coverage', 'omissions']) {
      const plan = await planManagedTask(f.input, {route:async()=>decision,runPlanner:planner(f)});
      const outcome = await executeManagedWorkflow(plan.request, {route:async()=>decision,verifyDecision:()=>{},
        recordReceipt:async()=>({durable:true,agentDbCommitted:true}), createAdapters:executor([], state => {
          if(state.worker.role === 'reviewer') { const verdict=JSON.parse(state.observed.answer); delete verdict[field]; state.observed.answer=JSON.stringify(verdict); }
        })});
      assert.equal(outcome.status,'blocked');
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
      recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
    assert.ok(seen.length > 0); assert.ok(seen.every(value => value === approve));
    assert.equal(Object.hasOwn(plan.request, 'approve'), false);
  } finally { f.cleanup(); }
});

test('readonly composition runs real AK scheduler, actual artifact gates and independent reviewer then aggregates original tasks', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const log = [], receipts = [];
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision, createAdapters: executor(log),
      verifyDecision: () => {}, recordReceipt: async (_request, receipt) => { receipts.push(receipt); return { durable: true, agentDbCommitted: true }; } });
    assert.equal(result.status, 'complete'); assert.deepEqual(log, ['work', 'independent-review']);
    assert.equal(result.results.length, 1); assert.equal(result.results[0].exitCategory, 'success');
    assert.equal(result.review.sessionId, 'session-independent-review'); assert.equal(result.acceptance.evidence[0].passed, true);
    assert.equal(receipts.at(-1).status, 'complete'); assert.ok(result.acceptance.artifactRefs.every((ref) => fs.existsSync(ref.path)));
    assert.ok(receipts.every(receipt => !Object.hasOwn(receipt, 'continuationBinding')));
    const reviewed = JSON.parse(fs.readFileSync(result.executions.find(item => item.workerId === 'independent-review').receiptRef.path));
    assert.equal(reviewed.workflowId, plan.request.id);
    assert.equal(reviewed.originalPromptDigest, digest(f.input.originalPrompt));
    assert.equal(reviewed.artifactDigest, result.artifactDigest);
    assert.deepEqual(reviewed.checkerSourceRefs, plan.request.checkerSourceRefs);
  } finally { f.cleanup(); }
});

test('execute entry rejects missing, unmapped and syntax-only criteria before adapter or receipt effects', async () => {
  const f = fixture(true); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const outcomes = [];
    for (const variant of ['missing', 'unmapped', 'syntax-only']) {
      const request = structuredClone(plan.request), task = request.tasks[0];
      if (variant === 'missing') delete task.acceptanceCriteria;
      if (variant === 'unmapped') task.acceptanceCriteria[0].checkIds = ['not-selected'];
      if (variant === 'syntax-only') task.acceptanceCriteria[0].checkIds = [task.acceptanceChecks.find(c => c.id.startsWith('syntax-')).id];
      let adapterEffects = 0, receiptEffects = 0;
      let rejection;
      try { await executeManagedWorkflow(request, {
        createAdapters: async () => { adapterEffects++; throw new Error('INVALID_TASK_REACHED_ADAPTER_EFFECT'); },
        recordReceipt: async () => { receiptEffects++; return { durable: true, agentDbCommitted: true }; },
      }); } catch (error) { rejection = error.message; }
      outcomes.push({ variant, rejection: rejection ?? null, adapterEffects, receiptEffects });
    }
    assert.deepEqual(outcomes, ['missing', 'unmapped', 'syntax-only'].map(variant => ({ variant,
      rejection: 'Task-specific observable acceptance criteria must map to preexisting selected checker IDs',
      adapterEffects: 0, receiptEffects: 0 })));
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
    const committed = commitManagedReceipt(f.input, receipt, inject);
    assert.equal(committed.agentDbCommitted, true);
    assert.equal(committed.canonicalReceipt.namespace, 'continuity-events');
    assert.equal(committed.canonicalReceipt.valueSha256, digest(JSON.stringify(row.event)));
    assert.notEqual(committed.canonicalReceipt.valueSha256, row.digest);
    inject.read = () => ({ ok: true, value: '{}' });
    assert.throws(() => commitManagedReceipt(f.input, receipt, inject), /exact receipt readback failed/);
  } finally { f.cleanup(); }
});

test('exact current receipt gets a bounded write without draining or deleting older queued debt', () => {
  const f=fixture(); try {
    let current, pending;
    class Journal { constructor() {this.db='/canonical/.swarm/memory.db';pending=[{key:'older-debt'}];}
      record([event]) {current={key:'current-exact',event};pending.push(current);return[current];}
      pending() {return pending;} }
    const result=commitManagedReceipt(f.input,{status:'registered',at:new Date().toISOString()}, {Journal,
      drainJournal: (journal,options) => {assert.deepEqual(journal.pending().map(row=>row.key),['current-exact']);
        assert(options.budgetMs > 0 && options.budgetMs <= 5000);assert.equal(typeof options.store,'function');},
      read:()=>({ok:true,value:JSON.stringify(current.event)})});
    assert.equal(result.agentDbCommitted,true);assert.equal(result.canonicalReceipt.key,'current-exact');
    assert.deepEqual(pending.map(row=>row.key),['older-debt','current-exact']);
  } finally {f.cleanup();}
});

test('malformed native review judgment blocks completion', async () => {
  const f = fixture(); try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision,
      createAdapters: executor([], (state) => { if (state.worker.role === 'reviewer') state.observed.answer = JSON.stringify({ passed: true }); }),
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
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
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
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
      check: async () => ({ passed: ++checks > 1, exitCode: checks > 1 ? 0 : 1 }), verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
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
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
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
      }), verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
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
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
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
      }, verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
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

test('temporary observation artifacts and exact checker inputs are redacted before their first write', async () => {
  const f = fixture(); const secret = 'synthetic-observation-secret-025068'; const originals = new Map();
  try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
    const result = await executeManagedWorkflow(plan.request, { createAdapters: executor([], (state) => {
      if (state.worker.role === 'reviewer') return;
      state.observed.answer = JSON.stringify({ outcome: `Completed source check; API_KEY=${secret}`, artifacts: [], decisions: [], risks: [] });
      state.observed.evidence = { password: secret };
      originals.set(state.worker.id, digest(state.observed.answer));
    }), verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
    assert.equal(result.status, 'complete');
    for (const ref of result.acceptance.artifactRefs) {
      const bytes = fs.readFileSync(ref.path); assert.equal(bytes.includes(secret), false);
      assert.equal(digest(bytes), ref.digest);
      if (ref.path.endsWith('.receipt.json')) {
        const metadata = JSON.parse(String(bytes));
        if (originals.has(metadata.workerId)) {
          assert.equal(metadata.privacy.answerChanged, true);
          assert.equal(metadata.privacy.originalAnswerDigest, originals.get(metadata.workerId));
        }
      }
    }
  } finally { f.cleanup(); }
});

test('checker stream redacts a secret before an overflowing tail could discard its marker', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  const chunks = ['-----BEGIN PRIVATE KEY-----\n', 'A'.repeat(210_000), '\n-----END PRIVATE KEY-----'];
  const result = await runRegisteredChecker({ command: process.execPath, args: [], cwd: os.tmpdir() },
    { deadline: Date.now() + 1000, sandboxBinary: process.execPath, launch: () => {
      queueMicrotask(() => { for (const chunk of chunks) child.stdout.write(chunk); child.emit('close', 0, null); }); return child;
    } });
  assert.equal(result.passed, false);
  assert.equal(result.stdoutDigest, digest(chunks.join('')));
  assert.ok(result.output.includes('[REDACTED:private-key]'));
  assert.equal(result.output.includes('A'.repeat(100)), false);
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
      } }), recordReceipt: async (_request, receipt) => { receipts.push(receipt); return { durable: true, agentDbCommitted: true }; } });
    assert.equal(result.status, 'complete'); assert.equal(reviewed, true);
    assert.ok(receipts.length > 0); assert.ok(receipts.every(receipt => JSON.stringify(receipt.planner.scopeDenials) === JSON.stringify([summary])));
  } finally { f.cleanup(); }
});

test('fresh planner recall rejects unavailable or foreign/stale phase receipts before native inference', async () => {
  for (const write of [false, true]) for (const corrupt of [value => ({ ...value, outcome: 'unavailable' }),
    value => ({ ...value, receipt: { ...value.receipt, binding: { ...value.receipt.binding, phase: 'old-phase' } } }),
    value => ({ ...value, receipt: { ...value.receipt, observedAt: '2000-01-01T00:00:00Z' } }),
    value => ({ ...value, receipt: { ...value.receipt, queryDigest: 'f'.repeat(64) } })]) {
    const f = fixture(write); let launches = 0;
    try {
      await assert.rejects(planManagedTask(f.input, { route: async () => decision,
        runPlanner: async () => { launches++; }, recallMemory: async args => corrupt(await phaseMemory(f.input)(args)) }), /history unavailable|binding unverified/);
      assert.equal(launches, 0);
    } finally { f.cleanup(); }
  }
});

test('enabled adopted readonly planner refuses missing history before native planning', async () => {
  const f = fixture(); let launches = 0;
  try {
    await assert.rejects(planManagedTask(f.input, { route: async () => decision, runPlanner: async () => { launches++; },
      recallMemory: async () => ({ outcome: 'unavailable', block: 'partial untrusted history', status: { state: 'unavailable' } }) }), /history unavailable/);
    assert.equal(launches, 0);
  } finally { f.cleanup(); }
});

test('trusted runtime opt-outs suppress recall while learning-off alone preserves canonical phase recall', async () => {
  for (const setting of ['brain-env', 'brain-file', 'agentdb-off', 'learning-off']) {
    const f = fixture(), env = { ...process.env, HOME: f.root, RUVNET_BRAIN_STATE_DIR: path.join(f.root, 'state') }; let calls = 0;
    try {
      if (setting === 'brain-env') env.RUVNET_BRAIN_OFF = '1';
      if (setting === 'brain-file') { fs.mkdirSync(env.RUVNET_BRAIN_STATE_DIR); fs.writeFileSync(path.join(env.RUVNET_BRAIN_STATE_DIR, 'brain-off'), ''); }
      if (setting === 'agentdb-off') env.RUVNET_AGENTDB_FIRST = 'off';
      if (setting === 'learning-off') env.RUVNET_LEARNING_SCOPE = 'off';
      const plan = await planManagedTask(f.input, { env, route: async () => decision, runPlanner: planner(f), recallMemory: async args => {
        calls++; assert.equal(args.env, env); return { ...await phaseMemory(f.input)(args), outcome: 'ok-empty' }; } });
      assert.equal(calls, setting === 'learning-off' ? 1 : 0);
      assert.equal(plan.request.memoryRecall.outcome, setting === 'learning-off' ? 'ok-empty' : 'disabled');
      if (setting !== 'learning-off') assert.equal(plan.request.memoryRecall.receipt, null);
    } finally { f.cleanup(); }
  }
});

test('returned disabled status and caller flags cannot exempt an enabled adopted decision', async () => {
  const f = fixture(); let launches = 0;
  try {
    f.input.memoryRecallRequired = false; f.input.memoryApplicable = false;
    await assert.rejects(planManagedTask(f.input, { route: async () => decision, runPlanner: async () => { launches++; },
      recallMemory: async () => ({ outcome: 'disabled', receipt: null }) }), /history unavailable/);
    assert.equal(launches, 0);
  } finally { f.cleanup(); }
});

test('verified unadopted scope remains disclosed without recall reads or store creation', async () => {
  const f = fixture(false, false); let calls = 0;
  try {
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f), recallMemory: async () => { calls++; throw Error('must not read'); } });
    assert.equal(plan.request.memoryRecall.outcome, 'not-adopted'); assert.equal(plan.request.memoryRecall.receipt, null);
    assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(f.root, '.swarm')), false);
  } finally { f.cleanup(); }
});

test('unknown canonical store type cannot masquerade as verified absence', async () => {
  const f = fixture(false, false); let calls = 0, launches = 0;
  try {
    fs.mkdirSync(path.join(f.root, '.swarm', 'memory.db'), { recursive: true });
    await assert.rejects(planManagedTask(f.input, { route: async () => decision, runPlanner: async () => { launches++; },
      recallMemory: async () => { calls++; return { outcome: 'disabled' }; } }), /store hard link rejected|not a regular file/);
    assert.equal(calls, 0); assert.equal(launches, 0);
  } finally { f.cleanup(); }
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('unreadable trusted Brain state blocks rather than granting a disabled exemption', async () => {
  const f = fixture(), state = path.join(f.root, 'private-state'); let calls = 0, launches = 0;
  try {
    fs.mkdirSync(state); fs.chmodSync(state, 0);
    await assert.rejects(planManagedTask(f.input, { env: { ...process.env, RUVNET_BRAIN_STATE_DIR: state }, route: async () => decision,
      runPlanner: async () => { launches++; }, recallMemory: async () => { calls++; return { outcome: 'disabled' }; } }), /memory consent is unavailable/);
    assert.equal(calls, 0); assert.equal(launches, 0);
  } finally { fs.chmodSync(state, 0o700); f.cleanup(); }
});

test('readonly review and final completion reject newly unavailable phase history', async () => {
  for (const phase of ['review', 'commit-decision']) {
    const f = fixture(), launched = [], receipts = [];
    try {
      const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f) });
      const result = await executeManagedWorkflow(plan.request, { route: async () => decision, createAdapters: executor(launched),
        recallMemory: async args => args.binding.phase === phase ? { outcome: 'timed-out' } : phaseMemory(f.input)(args),
        verifyDecision: () => {}, recordReceipt: async (_request, receipt) => { receipts.push(receipt); return { durable: true, agentDbCommitted: true }; } });
      assert.notEqual(result.status, 'complete'); assert.equal(receipts.some(receipt => receipt.status === 'complete'), false);
      if (phase === 'review') assert.equal(launched.includes('independent-review'), false);
    } finally { f.cleanup(); }
  }
});

test('write, independent review and commit each receive a new bound recall; no caller snapshot bypasses it', async () => {
  const f = fixture(true), phases = [], captured = [], syntaxChecks = [];
  try {
    const recallMemory = async args => { phases.push(args.binding.phase); return phaseMemory(f.input)(args); };
    const plan = await planManagedTask(f.input, { route: async () => decision, runPlanner: planner(f), recallMemory });
    const result = await executeManagedWorkflow(plan.request, { route: async () => decision,
      createAdapters: executor([], state => { assert.match(state.worker.prompt, /Fresh phase history.*UNTRUSTED DATA/); }),
      check: async checker => {
        assert.equal(checker.kind, 'command'); assert.equal(checker.cwd, f.root);
        if (checker.id.startsWith('syntax-')) { assert.equal(checker.command, process.execPath);
          assert.deepEqual(checker.args, ['--check', path.join(f.root, 'work.mjs')]); }
        if (checker.id.startsWith('syntax-')) syntaxChecks.push(checker.id);
        // This unit fixture injects native workers; its fixed syntax check is also source-only.
        const checked = spawnSync(checker.command, checker.args, { cwd: checker.cwd, encoding: 'utf8', timeout: 5000, shell: false });
        return { passed: checked.status === 0 && !checked.error && !checked.signal, exitCode: checked.status };
      },
      recallMemory, verifyDecision: () => {}, recordReceipt: async (_req, receipt) => { captured.push(receipt); return { durable: true, agentDbCommitted: true }; } });
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
        verifyDecision: () => {}, recordReceipt: async (_req, receipt) => { receipts.push(receipt); return { durable: true, agentDbCommitted: true }; } });
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
        verifyDecision: () => {}, recordReceipt: async (_req, receipt) => { receipts.push(receipt); return { durable: true, agentDbCommitted: true }; } });
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
      verifyDecision: () => {}, recordReceipt: async () => ({ durable: true, agentDbCommitted: true }) });
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
      }), recordReceipt: async (_req, receipt) => { receipts.push(receipt); return { durable: true, agentDbCommitted: true }; } };
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


test('read source-claim acceptance works without package commands and refuses unsupported or substituted reports', async () => {
  for (const attack of ['none','unsupported-source','source-substitution','shape-only','wrong-request','truncated-claim']) {
    const f=fixture(); try {
      fs.rmSync(path.join(f.root,'package.json'));
      const passage='The retry limit is exactly three attempts.';
      fs.writeFileSync(path.join(f.root,'context.md'),passage+'\n');
      f.input.originalPrompt='Quote the retry limit from the supplied original source exactly.';
      f.input.contextRefs[0].digest=digest(fs.readFileSync(f.input.contextRefs[0].path));
      const source=captureCheckerRegistry(f.root,[f.root],{contextRefs:f.input.contextRefs,originalPromptDigest:digest(f.input.originalPrompt)}).registry.find(check=>check.kind==='source-claim');
      const claim=attack==='unsupported-source'?'The retry limit is exactly four attempts.':attack==='truncated-claim'?'retry limit is exactly three attempts.':passage;
      const plan=await planManagedTask(f.input,{route:async()=>decision,runPlanner:async()=>({completed:true,model:decision.model,effort:decision.effort,
        sessionId:'source-fixture-planner',answer:JSON.stringify({unresolvedObligations:[],tasks:[{id:'work',instructions:'Quote the original requested source statement exactly',mode:'read',worktree:f.root,paths:[],dependsOn:[],checkIds:[source.id],
          acceptanceCriteria:[{id:'requested-result',assertion:'Exact retry limit quote from the original host-supplied source',checkIds:[source.id],sourceClaim:{checkId:source.id,claim}}]}]})})});
      const captured=[];
      const outcome=await executeManagedWorkflow(plan.request,{route:async()=>decision,verifyDecision:()=>{},
        recordReceipt:async(_request,receipt)=>{captured.push(receipt);return{durable:true,agentDbCommitted:true};},
        createAdapters:executor([],state=>{if(state.worker.role==='reviewer')return;
          const sourceRef=attack==='source-substitution'?{...source.sourceRef,path:path.join(f.root,'work.mjs')}:source.sourceRef;
          state.observed.answer=JSON.stringify({outcome:attack==='shape-only'?'A report-shaped but unsupported response':claim,artifacts:[],decisions:[],risks:[],
            ...(attack==='shape-only'?{}:{sourceClaims:[{criterionId:'requested-result',checkId:source.id,claim,sourceRef,
              originalPromptDigest:attack==='wrong-request'?'0'.repeat(64):digest(f.input.originalPrompt)}]})});
        })});
      assert.equal(outcome.status,attack==='none'?'complete':'blocked');
      if(attack==='none'){assert.equal(outcome.acceptance.evidence.find(item=>item.checkId===source.id).kind,'exact-source-claim');
        assert.equal(captured.at(-1).reviewCoverage.criterionCoverage[0].criterionId,'requested-result');}
    }finally{f.cleanup();}
  }
});

test('source identity alone or source criteria without a frozen claim cannot establish acceptance',async()=>{
  const f=fixture();try{
    fs.rmSync(path.join(f.root,'package.json'));
    const source=captureCheckerRegistry(f.root,[f.root],{contextRefs:f.input.contextRefs,originalPromptDigest:digest(f.input.originalPrompt)}).registry.find(check=>check.kind==='source-claim');
    await assert.rejects(planManagedTask(f.input,{route:async()=>decision,runPlanner:async()=>({completed:true,model:decision.model,effort:decision.effort,sessionId:'source-shape-fixture',
      answer:JSON.stringify({unresolvedObligations:[],tasks:[{id:'work',instructions:'Source hash alone is not the requested answer',mode:'read',worktree:f.root,paths:[],dependsOn:[],checkIds:[source.id],
        acceptanceCriteria:[{id:'requested-result',assertion:'Claim requires real source support rather than hash identity alone',checkIds:[source.id]}]}]})})}),/criteria/);
  }finally{f.cleanup();}
});

test('bounded policy evidence survives receipt and final handoff without upgrading observe or legacy to enforcement',async()=>{
  const f=fixture();try{
    const evidence={enforced:true,scope:'adapter boundaries',evidence:[{enforced:false,status:'UNENFORCED_OBSERVE',mode:'observe',projectRoot:f.root,receiptId:'observed-policy-receipt',authorization:'advisory only'}]};
    assert.equal(boundedPolicyAuthorization(evidence).enforced,false);
    assert.throws(()=>boundedPolicyAuthorization({...evidence,evidence:[{enforced:false,status:'fabricated'}]}),/Typed/);
    const plan=await planManagedTask(f.input,{route:async()=>decision,runPlanner:planner(f)}),captured=[];
    const outcome=await executeManagedWorkflow(plan.request,{route:async()=>decision,verifyDecision:()=>{},recordReceipt:async(_req,receipt)=>{captured.push(receipt);return{durable:true,agentDbCommitted:true};},
      createAdapters:executor([],state=>{state.observed.policyAuthorization=evidence;})});
    assert.equal(outcome.status,'complete');
    for(const item of outcome.executions){assert.equal(item.policyDecision.enforced,false);assert.equal(item.policyDecision.evidence[0].receiptId,'observed-policy-receipt');
      assert.equal(item.policyDecision.completionEligibility,'not-established-by-authorization');
      assert.equal(JSON.parse(fs.readFileSync(item.receiptRef.path)).policyDecision.evidence[0].mode,'observe');}
    assert.equal(captured.at(-1).workerObservations.items[0].policyDecision.enforced,false);
  }finally{f.cleanup();}
});


test('actual native Claude schemas admit source-backed planner/worker/review outputs consumed by the service',async()=>{
  const file=process.env.RUVNET_TEST_NATIVE_SCHEMA_ADAPTER || path.resolve(import.meta.dirname,'../../scripts/model-routing-execution-adapters.mjs');
  const native=await import(pathToFileURL(file).href);
  let ajv;try {const imported=createRequire(path.join(os.homedir(),'.npm-global/lib/node_modules/ruflo/package.json'))('ajv');ajv=new(imported.default||imported)({strict:false});}catch{/* Runtime validator remains authoritative when optional external Ajv is unavailable. */}
  const validate=(role,value)=>{const contract=native.claudeWorkflowResponse(role);assert.equal(contract.validateStructuredOutput(value),true,`${role} native validator rejected actual service data`);
    if(ajv){const check=ajv.compile(contract.responseSchema);assert.equal(check(value),true,JSON.stringify(check.errors));}};
  const f=fixture();try{
    fs.rmSync(path.join(f.root,'package.json'));
    const claim='The requested source states that the retry limit is three.';
    fs.writeFileSync(path.join(f.root,'context.md'),claim+'\n');f.input.contextRefs[0].digest=digest(fs.readFileSync(f.input.contextRefs[0].path));
    f.input.originalPrompt='Quote the retry limit from the supplied source exactly.';
    const check=captureCheckerRegistry(f.root,[f.root],{contextRefs:f.input.contextRefs,originalPromptDigest:digest(f.input.originalPrompt)}).registry.find(value=>value.kind==='source-claim');
    const proposed={unresolvedObligations:[],tasks:[{id:'work',instructions:'Report the exact requested original source passage',mode:'read',worktree:f.root,paths:[],dependsOn:[],checkIds:[check.id],
      acceptanceCriteria:[{id:'requested-result',assertion:'Actual requested quoted claim matches its supplied immutable source',checkIds:[check.id],sourceClaim:{checkId:check.id,claim}}]}]};
    validate('planner',proposed);
    const plan=await planManagedTask(f.input,{route:async()=>decision,runPlanner:async()=>({completed:true,model:decision.model,effort:decision.effort,sessionId:'schema-valid-planner',answer:JSON.stringify(proposed)})});
    const roles=[];
    const outcome=await executeManagedWorkflow(plan.request,{route:async()=>decision,verifyDecision:()=>{},recordReceipt:async()=>({durable:true,agentDbCommitted:true}),
      createAdapters:executor([],state=>{const role=state.worker.role==='reviewer'?'reviewer':'worker';
        if(role==='worker')state.observed.answer=JSON.stringify({outcome:claim,artifacts:[],decisions:[],risks:[],sourceClaims:[{criterionId:'requested-result',checkId:check.id,claim,sourceRef:check.sourceRef,originalPromptDigest:check.originalPromptDigest}]});
        validate(role,JSON.parse(state.observed.answer));roles.push(role);
      })});
    assert.equal(outcome.status,'complete');assert.deepEqual(roles,['worker','reviewer']);
    if(process.env.RUVNET_TEST_NATIVE_SCHEMA_ADAPTER)fs.writeFileSync('/tmp/rnb-source-claim-native-schema-proof.json',JSON.stringify({scope:'Actual native schemas + mechanical source-claim service composition; no vendor calls',schemaFile:file,schemaSha256:digest(fs.readFileSync(file)),ajvValidated:Boolean(ajv),status:outcome.status,roles,serviceSha256:digest(fs.readFileSync(path.resolve(import.meta.dirname,'../../scripts/model-managed-workflow-service.mjs')))},null,2));
  }finally{f.cleanup();}
});

test('optional parent policy binding reaches existing adapter caller separately from planner JSON',async()=>{
  const f=fixture();try{
    const authorizeNative=async()=>({enforced:false,status:'UNKNOWN_UNBOUND',authorization:'No authentic parent issuer/approval evidence in this fixture'}),seen=[];
    const plan=await planManagedTask(f.input,{authorizeNative,route:async()=>decision,runPlanner:async args=>{assert.equal(args.authorizeNative,authorizeNative);assert.equal(Object.hasOwn(JSON.parse(args.prompt),'authorizeNative'),false);return planner(f)(args);}});
    const outcome=await executeManagedWorkflow(plan.request,{authorizeNative,route:async()=>decision,verifyDecision:()=>{},recordReceipt:async()=>({durable:true,agentDbCommitted:true}),
      createAdapters:async args=>{seen.push(args.authorizeNative);return executor([])(args);}});
    assert.equal(outcome.status,'complete');assert(seen.length>0);assert(seen.every(value=>value===authorizeNative));assert.equal(Object.hasOwn(plan.request,'authorizeNative'),false);
    assert.equal(outcome.executions[0].policyDecision.evidence[0].status,'UNKNOWN_UNBOUND');assert.equal(outcome.executions[0].policyDecision.enforced,false);
  }finally{f.cleanup();}
});

const actualCheckerBinary = '/Users/stuartkerr/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin/bin/codex';
const actualVitestCheckerFixture = script => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-vitest-evidence-')));
  const home = path.join(root, 'private-home'); fs.mkdirSync(home); fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: script } }));
  fs.symlinkSync(fs.realpathSync(new URL('../../node_modules', import.meta.url)), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, home, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test.skipIf(!fs.existsSync(actualCheckerBinary))('actual default Vitest checker refuses a successful zero-test exit', async () => {
  // Private task inputs only. Actual registered checker, native read-only sandbox and Vitest process; no model or injected outcome.
  const f = actualVitestCheckerFixture('vitest run --passWithNoTests');
  try {
    const check = captureCheckerRegistry(f.root).registry.find(item => item.kind === 'command');
    const result = await runRegisteredChecker(check, { deadline: Date.now() + 15000,
      sandboxBinary: actualCheckerBinary, env: { ...process.env, HOME: f.home, CODEX_HOME: path.join(f.home, '.codex') } });
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.passed, false);
    assert.equal(result.testEvidence?.qualified, false);
  } finally { f.cleanup(); }
}, 20000);

test.skipIf(!fs.existsSync(actualCheckerBinary))('actual default Vitest checker passes executed explicit suite with frozen reporter argv and unchanged source', async () => {
  const f = actualVitestCheckerFixture('vitest run one.test.mjs --experimental.viteModuleRunner=false');
  try {
    const testFile = path.join(f.root, 'one.test.mjs');
    fs.writeFileSync(testFile, "import {it,expect} from 'vitest';it('real behavior',()=>expect(2+3).toBe(5));\n");
    const before = digest(fs.readFileSync(testFile)), captured = captureCheckerRegistry(f.root);
    const check = captured.registry.find(item => item.kind === 'command');
    assert.deepEqual(check.args, ['run', '--ignore-scripts', '--silent', 'test', '--', '--reporter=json']);
    assert.deepEqual(check.testEvidence.files, ['one.test.mjs']);
    assert.ok(captured.sourceRefs.some(ref => ref.path === testFile && ref.digest === before));
    const result = await runRegisteredChecker(check, { deadline: Date.now() + 15000,
      sandboxBinary: actualCheckerBinary, env: { ...process.env, HOME: f.home, CODEX_HOME: path.join(f.home, '.codex') } });
    assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.exitCode, 0);
    assert.equal(result.testEvidence.qualified, true); assert.equal(result.testEvidence.total, 1);
    assert.equal(result.testEvidence.passed, 1); assert.equal(result.testEvidence.reportDigest, result.stdoutDigest);
    assert.deepEqual(result.execution.args, check.args); assert.equal(result.execution.sandboxProfile, ':read-only');
    assert.equal(digest(fs.readFileSync(testFile)), before);
  } finally { f.cleanup(); }
}, 20000);

test.skipIf(!fs.existsSync(actualCheckerBinary))('actual skipped-only explicit Vitest suite cannot establish behavioral acceptance', async () => {
  const f = actualVitestCheckerFixture('vitest run one.test.mjs --experimental.viteModuleRunner=false');
  try {
    fs.writeFileSync(path.join(f.root, 'one.test.mjs'), "import {it} from 'vitest';it.skip('not executed',()=>{});\n");
    const check = captureCheckerRegistry(f.root).registry.find(item => item.kind === 'command');
    const result = await runRegisteredChecker(check, { deadline: Date.now() + 15000,
      sandboxBinary: actualCheckerBinary, env: { ...process.env, HOME: f.home, CODEX_HOME: path.join(f.home, '.codex') } });
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.passed, false); assert.equal(result.testEvidence.qualified, false);
  } finally { f.cleanup(); }
}, 20000);

test('constructed machine-output seam rejects missing/malformed report and UNKNOWN Vitest discovery', async () => {
  const f = actualVitestCheckerFixture('vitest run one.test.mjs');
  try {
    fs.writeFileSync(path.join(f.root, 'one.test.mjs'), '// fixed source fixture');
    const captured = captureCheckerRegistry(f.root).registry.find(item => item.kind === 'command');
    for (const [text, discovery] of [['', 'explicit-files'], ['not JSON', 'explicit-files'], ['{}', 'UNKNOWN']]) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      const result = await runRegisteredChecker({ ...captured, testEvidence: { ...captured.testEvidence, discovery } }, {
        deadline: Date.now() + 1000, sandboxBinary: process.execPath, launch: () => {
          queueMicrotask(() => { child.stdout.write(text); child.emit('close', 0, null); }); return child;
        } });
      assert.equal(result.exitCode, 0); assert.equal(result.passed, false); assert.equal(result.testEvidence.qualified, false);
    }
    fs.writeFileSync(path.join(f.root, 'one.test.mjs'), '// changed frozen input');
    await assert.rejects(runRegisteredChecker(captured, { deadline: Date.now() + 1000, sandboxBinary: process.execPath }), /changed|digest|source/i);
  } finally { f.cleanup(); }
});

test('Vitest reporter decoration is captured before selection while non-test argv remains exact', () => {
  const f = actualVitestCheckerFixture('vitest run one.test.mjs');
  try {
    fs.writeFileSync(path.join(f.root, 'one.test.mjs'), '// source fixture');
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run one.test.mjs', check: 'node --check one.test.mjs' } }));
    const registry = captureCheckerRegistry(f.root).registry;
    const vitest = registry.find(item => item.script?.startsWith('vitest'));
    assert.deepEqual(vitest.args, ['run', '--ignore-scripts', '--silent', 'test', '--', '--reporter=json']);
    assert.equal(vitest.script, 'vitest run one.test.mjs'); assert.equal(vitest.testEvidence.discovery, 'explicit-files');
    const nonTest = registry.find(item => item.script?.startsWith('node --check'));
    assert.deepEqual(nonTest.args, ['run', '--ignore-scripts', 'check']); assert.equal(nonTest.testEvidence, undefined);
    fs.writeFileSync(path.join(f.root, 'vitest.config.mjs'), 'export default {};');
    const unknown = captureCheckerRegistry(f.root).registry.find(item => item.script?.startsWith('vitest'));
    assert.equal(unknown.testEvidence.discovery, 'UNKNOWN');
  } finally { f.cleanup(); }
});

test('literal TODO assertion cannot pass even when Vitest summary claims zero pending and full success', async () => {
  // Constructed machine-report trap from an observed real report mismatch; not a native outcome.
  const f = actualVitestCheckerFixture('vitest run one.test.mjs');
  try {
    fs.writeFileSync(path.join(f.root, 'one.test.mjs'), '// fixed test-source fixture');
    const check = captureCheckerRegistry(f.root).registry.find(item => item.kind === 'command');
    const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
      numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0,
      testResults: [{ name: path.join(f.root, 'one.test.mjs'), status: 'passed', assertionResults: [{ status: 'todo' }] }] };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    const result = await runRegisteredChecker(check, { deadline: Date.now() + 1000, sandboxBinary: process.execPath,
      launch: () => { queueMicrotask(() => { child.stdout.write(JSON.stringify(report)); child.emit('close', 0, null); }); return child; } });
    assert.equal(result.exitCode, 0); assert.equal(result.passed, false); assert.equal(result.testEvidence.qualified, false);
    assert.equal(result.status, 'blocked');
  } finally { f.cleanup(); }
});

test('constructed Vitest byte stream requires complete exact UTF-8 before qualification', async () => {
  const f = actualVitestCheckerFixture('vitest run one.test.mjs');
  try {
    fs.writeFileSync(path.join(f.root, 'one.test.mjs'), '// frozen test-source fixture');
    const check = captureCheckerRegistry(f.root).registry.find(item => item.kind === 'command');
    const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
      numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0,
      testResults: [{ name: path.join(f.root, 'one.test.mjs'), status: 'passed', assertionResults: [{ status: 'passed', title: 'literal �' }] }] };
    const valid = Buffer.from(JSON.stringify(report));
    const invalidMiddle = Buffer.from(valid); invalidMiddle[invalidMiddle.indexOf(Buffer.from('�'))] = 0xff;
    const replacementOffset = valid.indexOf(Buffer.from('�', 'utf8'));
    assert.ok(replacementOffset > 0);
    for (const [bytes, expected, split] of [[Buffer.concat([valid, Buffer.from([0xe2, 0x82])]), false, valid.length],
      [invalidMiddle, false, replacementOffset + 1], [valid, true, replacementOffset + 1], [valid, true, replacementOffset + 2]]) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      const result = await runRegisteredChecker(check, { deadline: Date.now() + 1000, sandboxBinary: process.execPath,
        launch: () => { queueMicrotask(() => {
          child.stdout.write(bytes.subarray(0, split)); child.stdout.write(bytes.subarray(split));
          child.stderr.write(Buffer.from([0xe2, 0x82])); child.emit('close', 0, null);
        }); return child; } });
      assert.equal(result.exitCode, 0); assert.equal(result.passed, expected); assert.equal(result.testEvidence.qualified, expected);
      assert.equal(result.stdoutDigest, digest(bytes));
      assert.equal(result.stderrDigest, digest(Buffer.from([0xe2, 0x82])));
      assert.ok(result.output.endsWith('\n�'), 'stderr decoder must flush its incomplete suffix');
      if (expected) assert.equal(result.testEvidence.reportDigest, result.stdoutDigest);
    }
  } finally { f.cleanup(); }
});

test('acceptance checks retain correlated planner and worker denials in exact reviewer input',async()=>{
 const f=fixture(),log=[],receipts=[];let seen,checked;
 const row=sessionId=>({status:'host-scope-denied',sessionId,toolUseId:'guarded-tool',toolName:'Bash',inputSha256:'a'.repeat(64),evidence:'invocation PreToolUse deny response'});
 try{
 const plan=await planManagedTask(f.input,{route:async()=>decision,runPlanner:async input=>({...await planner(f)(input),evidence:[row('actual-planner-session')]})});
 const outcome=await executeManagedWorkflow(plan.request,{verifyDecision:()=>{},route:async()=>decision,check:async(checker,options)=>{checked=structuredClone(options.scopeDenials);return fixtureCheck(checker);},createAdapters:executor(log,state=>{if(state.worker.role==='reviewer')seen=JSON.parse(state.worker.prompt.split('\n')[0]).acceptance.scopeDenials;else state.observed.evidence=[row(state.observed.sessionId)];}),recordReceipt:async(_request,receipt)=>{receipts.push(receipt);return{durable:true,agentDbCommitted:true};}});
 assert.equal(outcome.status,'complete',JSON.stringify({status:outcome.status,reason:outcome.reason,failure:outcome.failure}));assert.ok(Array.isArray(outcome.acceptance.scopeDenials));assert.equal(outcome.acceptance.scopeDenials.length,2);assert.deepEqual(seen,outcome.acceptance.scopeDenials);assert.deepEqual(checked,outcome.acceptance.scopeDenials);assert.ok(receipts.at(-1).acceptanceEvidence.some(item=>item.scopeDenials?.length===2));
 }finally{f.cleanup();}
});
test.each(['session','digest','tool','planner'])('invalid recovered denial %s blocks before independent reviewer',async fault=>{
 const f=fixture(),log=[];try{
 const plan=await planManagedTask(f.input,{route:async()=>decision,runPlanner:planner(f)});
 const request=structuredClone(plan.request);if(fault==='planner')request.planner.scopeDenials=[{sessionId:'untracked'}];
 const outcome=await executeManagedWorkflow(request,{verifyDecision:()=>{},route:async()=>decision,createAdapters:executor(log,state=>{if(state.worker.role!=='reviewer')state.observed.evidence=[{status:'host-scope-denied',sessionId:fault==='session'?'untracked':state.observed.sessionId,toolUseId:'guarded-tool',toolName:fault==='tool'?'':'Bash',inputSha256:fault==='digest'?'invalid':'a'.repeat(64),evidence:'invocation PreToolUse deny response'}];}),recordReceipt:async()=>({durable:true,agentDbCommitted:true})});
 assert.equal(outcome.status,'blocked',JSON.stringify({status:outcome.status,reason:outcome.reason,failure:outcome.failure}));assert.equal(log.includes('independent-review'),false);
 }finally{f.cleanup();}
});
