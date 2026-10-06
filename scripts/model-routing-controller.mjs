// Policy-bound workflow controller. Agentic Kit owns DAG scheduling; guarded native adapters own execution.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { validateDispatchDecision } from './model-router-dispatch.mjs';
import { ContinuityJournal, drain } from '../plugin/scripts/continuity-journal.mjs';
import { EVENT_SCHEMA } from '../plugin/scripts/continuity-events.mjs';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,79}$/;
const STOP = /permission|consent|auth|quota|allowance|policy|orphan|uncertain|unknown|cancel/i;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nativeReceipt = ({ workerId, host, configuredModel, observedModel, configuredEffort, observedEffort,
  effortEvidence, sessionId, status, exitCategory, transcriptRefs, receiptRef }) =>
  ({ workerId, host, configuredModel, observedModel, configuredEffort, observedEffort, effortEvidence,
    sessionId, status, exitCategory, transcriptRefs, receiptRef });
const requireValue = (test, message) => { if (!test) throw new TypeError(message); };
const immutable = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
};
const canonical = (file) => typeof file === 'string' && path.isAbsolute(file) && fs.realpathSync(file) === file;

/** Resolve the installed global runner, never an npm download or a stock adapter. */
export async function loadManagedRunner({ globalRoot = path.join(os.homedir(), '.npm-global', 'lib', 'node_modules') } = {}) {
  let entry;
  try { entry = createRequire(import.meta.url).resolve('@pacphi/agentic-kit/package.json'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    // Older installations may supply only the global package. Never download a runner.
    entry = createRequire(path.join(globalRoot, '_routing_resolver.cjs')).resolve('@pacphi/agentic-kit/package.json');
  }
  requireValue(JSON.parse(fs.readFileSync(entry, 'utf8')).name === '@pacphi/agentic-kit', 'Managed runner package mismatch');
  const runner = await import(pathToFileURL(path.join(path.dirname(entry), 'src/lib/execution/runner.mjs')).href);
  requireValue(typeof runner.executeRunPlan === 'function', 'Managed executeRunPlan unavailable');
  return runner.executeRunPlan;
}

export function verifyContextRefs(refs) {
  requireValue(Array.isArray(refs), 'Canonical context references required');
  for (const ref of refs) {
    requireValue(ref && canonical(ref.path) && HASH.test(ref.digest), 'Canonical context path and SHA-256 required');
    requireValue(sha(fs.readFileSync(ref.path)) === ref.digest, 'Context reference changed');
  }
}

/** Bind gate and review receipts to actual immutable artifact bytes. */
export function artifactDigest(refs) {
  requireValue(Array.isArray(refs) && refs.length > 0, 'Actual artifact references required');
  verifyContextRefs(refs);
  requireValue(new Set(refs.map((ref) => ref.path)).size === refs.length, 'Duplicate artifact reference');
  return sha(JSON.stringify([...refs].sort((a, b) => a.path.localeCompare(b.path))));
}

function tasksFor(request) {
  return request.tasks ?? [{ id: 'work', instructions: request.originalPrompt, dependsOn: [],
    ownership: { mode: 'read', worktree: request.projectRoot, paths: [] }, acceptanceChecks: request.acceptanceChecks }];
}

export function validateWorkflowRequest(request, now = Date.now()) {
  requireValue(request && ID.test(request.id), 'Workflow ID required');
  requireValue(typeof request.originalPrompt === 'string' && request.originalPrompt.trim(), 'Original request required');
  requireValue(canonical(request.projectRoot), 'Canonical project root required');
  verifyContextRefs(request.contextRefs);
  requireValue(request.taskFacts && typeof request.taskFacts === 'object' && !Array.isArray(request.taskFacts), 'Explicit task facts required');
  requireValue(!Object.hasOwn(request.taskFacts, 'verifiedTaskQualityFailure'), 'Quality failure facts must come from validated workflow evidence');
  requireValue(request.permissions && request.permissions.apiBilling === false && typeof request.permissions.write === 'boolean', 'Explicit permissions and no API billing required');
  requireValue(Number.isFinite(request.deadline) && request.deadline > now, 'Future absolute workflow deadline required');
  for (const field of ['maxAttempts', 'maxConcurrent']) requireValue(Number.isInteger(request[field]) && request[field] > 0 && request[field] <= 64, `Invalid global ${field}`);
  const tasks = tasksFor(request);
  requireValue(Array.isArray(tasks) && tasks.length > 0 && tasks.length + 1 <= request.maxAttempts, 'Tasks exceed global attempt budget');
  const ids = new Set();
  for (const task of tasks) {
    requireValue(task && ID.test(task.id) && !ids.has(task.id), 'Invalid or duplicate task ID'); ids.add(task.id);
    requireValue(typeof task.instructions === 'string' && task.instructions.trim(), 'Task instructions required');
    requireValue(Array.isArray(task.dependsOn ?? []) && new Set(task.dependsOn ?? []).size === (task.dependsOn ?? []).length, 'Invalid dependency list');
    const own = task.ownership;
    requireValue(own && ['read', 'write'].includes(own.mode) && canonical(own.worktree) && Array.isArray(own.paths), 'Explicit canonical ownership required');
    requireValue(own.mode !== 'write' || request.permissions.write && own.paths.length > 0, 'Write authority and exact ownership required');
    requireValue(own.paths.every((p) => typeof p === 'string' && p && !path.isAbsolute(p) && !p.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')), 'Invalid owned relative path');
    requireValue(Array.isArray(task.acceptanceChecks) && task.acceptanceChecks.length > 0 && task.acceptanceChecks.every((check) => check && ID.test(check.id)), 'Independently verifiable acceptance checks required');
  }
  const visiting = new Set(), visited = new Set();
  const visit = (id) => {
    requireValue(!visiting.has(id), 'Dependency cycle'); if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of tasks.find((task) => task.id === id).dependsOn ?? []) { requireValue(ids.has(dep) && dep !== id, 'Unknown or self dependency'); visit(dep); }
    visiting.delete(id); visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
  const precedes = (a, b) => (tasks.find((task) => task.id === b).dependsOn ?? []).some((dep) => dep === a || precedes(a, dep));
  const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i], b = tasks[j];
    if (a.ownership.mode !== 'write' || b.ownership.mode !== 'write') continue;
    requireValue(!a.ownership.paths.some((p) => b.ownership.paths.some((q) => overlaps(p, q))), 'Split writers must have nonoverlapping ownership');
    requireValue(request.maxConcurrent === 1 || a.ownership.worktree !== b.ownership.worktree || precedes(a.id, b.id) || precedes(b.id, a.id), 'Parallel writers require separate worktrees');
  }
  return request;
}

function workerPrompt(request, task, feedback) {
  return JSON.stringify({ originalPrompt: request.originalPrompt, contextRefs: request.contextRefs,
    taskFacts: request.taskFacts, permissions: request.permissions, deadline: request.deadline,
    untrustedMemoryData: request.memoryRecall,
    task, ...(feedback ? { repairEvidence: feedback } : {}) });
}

export async function buildWorkflowPlan(request, { route, feedback, now = Date.now } = {}) {
  validateWorkflowRequest(request, now()); requireValue(typeof route === 'function', 'Managed route resolver required');
  const workers = [];
  for (const task of tasksFor(request)) {
    const decision = await route({ originalPrompt: request.originalPrompt, contextRefs: request.contextRefs,
      taskFacts: request.taskFacts, permissions: request.permissions, task, feedback,
      priorDecision: feedback?.priorDecisions?.[task.repairsTaskId ?? task.id] });
    workers.push({ id: task.id, activity: 'implementation', role: 'worker', host: decision.harness === 'claude-code' ? 'claude' : decision.harness,
      configuredModel: decision.model, configuredEffort: decision.effort, decision, taskFacts: request.taskFacts, dependsOn: task.dependsOn ?? [],
      ownership: task.ownership, acceptanceChecks: task.acceptanceChecks,
      ...(task.repairArtifacts ? { repairArtifacts: task.repairArtifacts } : {}),
      prompt: workerPrompt(request, task, feedback), workflowDeadline: request.deadline });
  }
  return { workers };
}

/** Validate generated plans before adapter factories, receipts, or worker effects. */
export function validateWorkflowPlan(request, plan, { verifyDecision = validateDispatchDecision, feedback, now = Date.now } = {}) {
  validateWorkflowRequest(request, now());
  const tasks = tasksFor(request);
  requireValue(plan && Array.isArray(plan.workers) && plan.workers.length === tasks.length, 'Plan must cover exact task scope');
  for (const [index, worker] of plan.workers.entries()) {
    const task = tasks[index];
    requireValue(worker.id === task.id && same(worker.dependsOn, task.dependsOn ?? []) && same(worker.ownership, task.ownership)
      && same(worker.acceptanceChecks, task.acceptanceChecks) && worker.prompt === workerPrompt(request, task, feedback)
      && same(worker.repairArtifacts, task.repairArtifacts)
      && worker.workflowDeadline === request.deadline && worker.activity === 'implementation' && worker.role === 'worker'
      && !worker.escalate, 'Plan changed context, scope, authority, or budget');
    requireValue(worker.host === (worker.decision?.harness === 'claude-code' ? 'claude' : worker.decision?.harness) && worker.configuredModel === worker.decision?.model && worker.configuredEffort === worker.decision?.effort && same(worker.taskFacts, request.taskFacts), 'Plan route mismatch');
    verifyDecision(worker.decision);
  }
  return plan;
}

function blockedResult(result) {
  return result.status !== 'succeeded'
    || STOP.test(`${result.exitCategory} ${result.failure?.reason ?? ''}`)
    || result.exitCategory !== 'success';
}

function blockedEvidence(value) {
  return value?.status === 'blocked' || value?.uncertainEffects === true
    || value?.exitCode === 126 || value?.exitCode === 127 || value?.timedOut === true || !!value?.signal
    || STOP.test(`${value?.exitCategory ?? ''} ${value?.reason ?? ''}`)
    || value?.passed === false && (/environment|unavailable|not.found|missing.executable|enoent|spawn.error|timeout/i.test(`${value?.exitCategory ?? ''} ${value?.reason ?? ''}`)
      || /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|command not found|No such file or directory|permission denied|authentication required|quota exhausted|ECONNREFUSED|EAI_AGAIN|ENOTFOUND/i.test(value?.output ?? ''))
    || [...(value?.evidence ?? []), ...(value?.findings ?? [])].some((item) => item && typeof item === 'object' && blockedEvidence(item));
}

/** A repair is a new, explicitly scoped task; the original writing DAG is never replayed. */
export function validateRepairPlan(request, repair, now = Date.now()) {
  requireValue(repair && repair.baseArtifactDigest === artifactDigest(repair.artifactRefs), 'Repair must bind existing artifact bytes');
  requireValue(Array.isArray(repair.tasks) && repair.tasks.length > 0, 'Explicit repair tasks required');
  const originals = tasksFor(request);
  const seen = new Set();
  for (const task of repair.tasks) {
    const original = originals.find((entry) => entry.id === task.repairsTaskId);
    requireValue(original && !originals.some((entry) => entry.id === task.id) && !seen.has(task.id), 'Repair must use a new task ID and name original scope'); seen.add(task.id);
    const own = task.ownership, prior = original.ownership;
    requireValue(own && own.worktree === prior.worktree && (own.mode === 'read' || prior.mode === 'write')
      && own.paths.every((file) => prior.paths.some((scope) => file === scope || file.startsWith(`${scope}/`)))
      && same(task.acceptanceChecks, original.acceptanceChecks), 'Repair expanded original ownership or acceptance scope');
    const scopeRefs = repair.artifactRefs.filter((ref) => {
      const relative = path.relative(own.worktree, ref.path);
      return own.paths.some((scope) => relative === scope || relative.startsWith(`${scope}/`));
    });
    requireValue(own.mode !== 'write' || scopeRefs.length > 0, 'Writing repair must name existing artifacts in its exact scope');
    requireValue(same(task.repairArtifacts, scopeRefs), 'Repair task must retain exact prior artifact references');
  }
  const executionRequest = { ...request, tasks: repair.tasks };
  validateWorkflowRequest(executionRequest, now);
  return executionRequest;
}

/** Per-launch caps are shared across all DAG branches, repairs, and independent review. */
function guardAdapters(adapters, request, budget, now) {
  requireValue(adapters && typeof adapters === 'object', 'Explicit guarded adapters required; stock adapters forbidden');
  const abort = budget.abort;
  const preparedRefs = new WeakMap();
  const entries = adapters instanceof Map ? [...adapters] : Object.entries(adapters);
  return Object.fromEntries(entries.map(([host, adapter]) => {
    const check = () => {
      requireValue(!budget.blocked, 'Workflow policy blocked'); budget.assertTime();
      verifyContextRefs(request.contextRefs);
    };
    const phase = (name) => async (...args) => {
      check();
      const refs = args[0]?.worker?.repairArtifacts ?? preparedRefs.get(args[0]) ?? [];
      if (['readiness', 'prepare', 'launch'].includes(name) && refs.length) verifyContextRefs(refs);
      const options = args.at(-1);
      if (options && typeof options === 'object') args[args.length - 1] = { ...options,
        signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal,
        timeoutMs: Math.min(options.timeoutMs ?? Infinity, budget.remainingMs()) };
      if (name === 'launch') {
        requireValue(budget.attemptsUsed < budget.maxAttempts, 'Global attempt budget exhausted');
        budget.attemptsUsed++;
      }
      const result = await adapter[name](...args);
      if (name === 'prepare' && result && typeof result === 'object') preparedRefs.set(result, refs);
      budget.assertTime(); return result;
    };
    return [host, { id: adapter.id, readiness: phase('readiness'), prepare: phase('prepare'),
      launch: phase('launch'), observe: phase('observe'), summarize: (...args) => adapter.summarize(...args),
      cancel: (...args) => adapter.cancel(...args), cleanup: (...args) => adapter.cleanup(...args),
      ...(adapter.handoffRequestFor ? { handoffRequestFor: (...args) => adapter.handoffRequestFor(...args) } : {}),
      interpret: (...args) => {
        const result = adapter.interpret(...args);
        if (blockedResult(result)) {
          budget.blocked = true;
          // A safely retired native failure still yields its receipt; later launches are refused.
          if (result.failure?.retrySafe !== true || STOP.test(`${result.exitCategory} ${result.failure?.reason ?? ''}`)) abort.abort();
        }
        return result;
      } }];
  }));
}

export function durableWorkflowReceipt(request, receipt) {
  const journal = new ContinuityJournal({ projectRoot: request.projectRoot });
  const event = { schema: EVENT_SCHEMA, kind: 'decision', id: sha(JSON.stringify(receipt)),
    at: receipt.at, source: 'model-routing-controller', authoritative: true,
    summary: `Routing workflow ${request.id}: ${receipt.status}`, detail: receipt };
  journal.record([event]);
  // Existing outbox is durable before the existing exact-readback AgentDB drainer runs.
  const status = drain(journal, { budgetMs: Math.max(0, Math.min(1000, request.deadline - Date.now())), backoff: [] });
  return { durable: true, agentDbCommitted: status.remaining === 0, ...status };
}

function validateAcceptance(request, acceptance) {
  requireValue(acceptance && acceptance.artifactDigest === artifactDigest(acceptance.artifactRefs), 'Acceptance must bind actual artifact bytes');
  requireValue(Array.isArray(acceptance.evidence), 'Actual acceptance evidence required');
  const expected = tasksFor(request).flatMap((task) => task.acceptanceChecks.map((check) => `${task.id}:${check.id}`));
  requireValue(new Set(expected).size === expected.length, 'Duplicate acceptance check ID');
  requireValue(expected.every((id) => acceptance.evidence.some((e) => `${e.taskId}:${e.checkId}` === id
    && typeof e.passed === 'boolean' && e.artifactDigest === acceptance.artifactDigest)), 'Acceptance coverage incomplete');
  requireValue(typeof acceptance.passed === 'boolean' && acceptance.passed === acceptance.evidence.every((e) => e.passed === true), 'Acceptance aggregate contradicts actual check evidence');
  return acceptance.passed;
}

async function bounded(budget, operation) {
  const controller = new AbortController(); let timer, onAbort;
  budget.assertTime();
  try {
    const result = await Promise.race([Promise.resolve().then(() => operation(AbortSignal.any([controller.signal, budget.abort.signal]))),
      new Promise((_, reject) => { onAbort = () => reject(new Error('Workflow cancelled'));
        budget.abort.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new Error('Absolute workflow deadline exceeded')); }, budget.remainingMs()); })]);
    budget.assertTime(); return result;
  } catch (error) { controller.abort(); throw error;
  } finally { clearTimeout(timer); budget.abort.signal.removeEventListener('abort', onAbort); }
}

/** No automatic transport/settings mutation. Every completed result has real gates and independent review. */
export async function runRoutingWorkflow(input, { route, createAdapters, executePlan, checkAcceptance, review, planRepair,
  recordReceipt = durableWorkflowReceipt, verifyDecision = validateDispatchDecision, now = Date.now, signal } = {}) {
  const request = immutable(structuredClone(input)); validateWorkflowRequest(request, now());
  for (const [name, fn] of Object.entries({ route, createAdapters, checkAcceptance, review, recordReceipt })) requireValue(typeof fn === 'function', `${name} boundary required`);
  const budget = { deadline: request.deadline, maxAttempts: request.maxAttempts, attemptsUsed: 0, blocked: false, abort: new AbortController() };
  const monotonicDeadline = performance.now() + (request.deadline - now());
  const onAbort = () => { budget.blocked = true; budget.abort.abort(signal?.reason); };
  signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  budget.remainingMs = () => Math.max(0, Math.min(request.deadline - now(), monotonicDeadline - performance.now()));
  budget.assertTime = () => { requireValue(!signal?.aborted, 'Workflow cancelled'); requireValue(budget.remainingMs() > 0, 'Absolute workflow deadline exceeded'); };
  const runner = executePlan ?? await loadManagedRunner(); let results = [], acceptance, feedback, revision = 0;
  let executionRequest = request, repairArtifactRefs = null, writerExecuted = false;
  const executionReceipts = [];
  const persist = async (status, extra = {}) => {
    const receipt = { workflowId: request.id, status, at: new Date(now()).toISOString(),
      originalPromptDigest: sha(request.originalPrompt), contextDigest: sha(JSON.stringify(request.contextRefs)),
      attemptsUsed: budget.attemptsUsed, deadline: request.deadline, ...extra };
    if (status === 'complete') budget.assertTime();
    const recorded = status === 'blocked' ? await recordReceipt(request, receipt)
      : await bounded(budget, (signal) => recordReceipt(request, receipt, { signal }));
    requireValue(recorded?.durable === true, 'Workflow receipt durability not proven'); return receipt;
  };
  const execute = async (plan) => {
    requireValue(!budget.blocked && budget.attemptsUsed < budget.maxAttempts, 'Global execution budget blocked'); budget.assertTime();
    const adapters = guardAdapters(await bounded(budget, () => createAdapters({ request, plan, budget })), request, budget, now);
    const results = await bounded(budget, () => runner(plan, { adapters, cwd: request.projectRoot, maxConcurrent: request.maxConcurrent,
      timeoutMs: Math.max(1, budget.remainingMs()), escalate: false }));
    try { budget.assertTime(); } catch (error) { error.executionResults = results; throw error; } return results;
  };
  try {
    for (;;) {
      if (repairArtifactRefs) verifyContextRefs(repairArtifactRefs);
      const plan = immutable(await bounded(budget, () => buildWorkflowPlan(executionRequest, { route, feedback, now })));
      validateWorkflowPlan(executionRequest, plan, { verifyDecision, feedback, now });
      await persist('running', { revision: revision++ });
      results = await execute(plan);
      requireValue(Array.isArray(results) && results.length === plan.workers.length && results.every((r, i) => r.workerId === plan.workers[i].id), 'Execution result coverage invalid');
      executionReceipts.push({ plan, results });
      await persist('stage-finished', { nativeReceipts: results.map(nativeReceipt) });
      writerExecuted ||= plan.workers.some((worker, index) => worker.ownership.mode === 'write'
        && results[index].status !== 'blocked');
      if (budget.blocked || results.some(blockedResult)) return {
        ...await persist('blocked', { reason: 'native-execution-failed-without-quality-evidence' }), results, executionReceipts };
      if (results.every((result) => result.status === 'succeeded')) {
        acceptance = await bounded(budget, (signal) => checkAcceptance({ request, plan, results, executionReceipts, signal }));
        if (blockedEvidence(acceptance)) return { ...await persist('blocked', { reason: 'acceptance-boundary-blocked' }), results, acceptance };
        if (validateAcceptance(request, acceptance)) {
          const reviewResults = new Map();
          const executeReview = async (worker) => {
            requireValue(worker?.role === 'reviewer' && worker.activity === 'review' && ID.test(worker.id)
              && !executionReceipts.some((entry) => entry.plan.workers.some((w) => w.id === worker.id)) && worker.ownership?.mode === 'read'
              && canonical(worker.ownership.worktree) && !worker.escalate
              && worker.host === (worker.decision?.harness === 'claude-code' ? 'claude' : worker.decision?.harness) && worker.configuredModel === worker.decision?.model && worker.configuredEffort === worker.decision?.effort && same(worker.taskFacts, request.taskFacts),
            'Independent read-only reviewer required');
            verifyDecision(worker.decision);
            requireValue(worker.prompt === JSON.stringify({ originalPrompt: request.originalPrompt, contextRefs: request.contextRefs,
              taskFacts: request.taskFacts, permissions: { ...request.permissions, write: false }, acceptance,
              untrustedMemoryData: request.memoryRecall }), 'Review must retain exact request and artifact evidence');
            const [result] = await execute({ workers: [worker] }); reviewResults.set(worker.id, result);
            await persist('review-finished', { nativeReceipts: [nativeReceipt(result)] }); return result;
          };
          const verdict = await bounded(budget, (signal) => review({ request, plan, results, executionReceipts, acceptance, executeReview, signal }));
          if (budget.blocked || blockedEvidence(verdict)) return { ...await persist('blocked', { reason: 'review-boundary-blocked' }), results, acceptance };
          const reviewer = reviewResults.get(verdict?.reviewerWorkerId);
          requireValue(verdict?.independent === true && reviewer?.status === 'succeeded'
            && typeof reviewer.sessionId === 'string' && reviewer.sessionId.length > 0
            && !executionReceipts.some((entry) => entry.results.some((result) => result.sessionId === reviewer.sessionId))
            && verdict.artifactDigest === acceptance.artifactDigest && Array.isArray(verdict.findings)
            && Array.isArray(verdict.evidence) && verdict.evidence.length > 0, 'Actual independent review of exact artifact required');
          requireValue(artifactDigest(acceptance.artifactRefs) === acceptance.artifactDigest, 'Artifact changed after acceptance/review');
          if (budget.blocked) return { ...await persist('blocked'), results };
          if (verdict.passed === true && verdict.findings.length === 0) return { ...await persist('complete', {
            artifactDigest: acceptance.artifactDigest, acceptanceEvidence: acceptance.evidence,
            reviewerWorkerId: verdict.reviewerWorkerId, reviewEvidence: verdict.evidence }), results, executionReceipts, acceptance, review: verdict };
          requireValue(verdict.findings.length > 0, 'Failed review requires specific quality defects');
          feedback = { acceptance, review: verdict, verifiedTaskQualityFailure: true };
        } else feedback = { acceptance, verifiedTaskQualityFailure: true };
      } else feedback = { results };
      feedback.priorDecisions = Object.fromEntries(plan.workers.map((worker) => {
        const task = tasksFor(executionRequest).find((entry) => entry.id === worker.id);
        return [task.repairsTaskId ?? task.id, worker.decision];
      }));
      if (writerExecuted || planRepair) {
        if (typeof planRepair !== 'function') return { ...await persist('blocked', { reason: 'unsafe-writer-replay-refused' }), results, executionReceipts, acceptance };
        const repair = await bounded(budget, (signal) => planRepair({ request, plan, results, acceptance, feedback,
          executionReceipts, budget: { deadline: budget.deadline, maxAttempts: budget.maxAttempts, attemptsUsed: budget.attemptsUsed }, signal }));
        executionRequest = immutable(validateRepairPlan(request, structuredClone(repair), now()));
        repairArtifactRefs = immutable(structuredClone(repair.artifactRefs));
        await persist('repair-planned', { baseArtifactDigest: repair.baseArtifactDigest, artifactRefs: repairArtifactRefs,
          repairTasks: executionRequest.tasks.map(({ id, repairsTaskId, ownership }) => ({ id, repairsTaskId, ownership })) });
      }
      if (budget.blocked || budget.remainingMs() <= 0 || budget.attemptsUsed + tasksFor(executionRequest).length + 1 > budget.maxAttempts) {
        return { ...await persist('blocked', { reason: 'budget-or-gates-unresolved' }), results, acceptance };
      }
    }
  } catch (error) {
    budget.blocked = true; budget.abort.abort();
    const lateResults = error.executionResults ?? [];
    return { ...await persist('blocked', { reason: 'workflow-boundary-failed', nativeReceipts: lateResults.map(nativeReceipt) }),
      results, lateResults, executionReceipts, failure: String(error.message).slice(0, 240) };
  } finally { signal?.removeEventListener('abort', onAbort); }
}
