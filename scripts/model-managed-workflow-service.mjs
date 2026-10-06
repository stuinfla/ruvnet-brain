// Default composition: native read-only planning, guarded AK workers, deterministic gates, native independent review.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { runRoutingWorkflow, validateWorkflowRequest, artifactDigest, verifyContextRefs } from './model-routing-controller.mjs';
import { createGuardedWorkflowAdapters, runObservedWorkflowWorker, nativeWorkflowBinaries } from './model-routing-execution-adapters.mjs';
import { extractFeatures, selectDecision, loadPolicy, loadProfile, applyProfile, loadCatalog } from './model-router-engine.mjs';
import { validateDispatchDecision, subscriptionEnvironment } from './model-router-dispatch.mjs';
import { ContinuityJournal, drain } from '../plugin/scripts/continuity-journal.mjs';
import { CONTINUITY_NAMESPACE, EVENT_SCHEMA, redactText } from '../plugin/scripts/continuity-events.mjs';
import { withProgressionReader } from '../plugin/scripts/project-progression-reader.mjs';
import { recall } from '../plugin/scripts/agentdb-recall.mjs';
import { resolveProjectStore } from '../plugin/scripts/project-store-resolver.mjs';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const assert = (test, message) => { if (!test) throw new Error(message); };
const ID = /^[a-z][a-z0-9-]{0,79}$/;
const fileRef = (file) => ({ path: fs.realpathSync(file), digest: sha(fs.readFileSync(file)) });
const freeze = (obj) => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } return obj; };
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const JSON_LIMIT = 1024 * 1024;
const REPORT = 'Return only JSON {"outcome":"result","artifacts":[],"decisions":[],"risks":[]}; include substantive report text in outcome. Never invent execution or source evidence.';

function parseJson(text) {
  assert(typeof text === 'string' && Buffer.byteLength(text) <= JSON_LIMIT, 'Bounded native JSON output required');
  const value = JSON.parse(text); assert(value && typeof value === 'object' && !Array.isArray(value), 'Native JSON object required'); return value;
}

function ownedFile(root, relative) {
  assert(typeof relative === 'string' && relative && !path.isAbsolute(relative)
    && !relative.split(/[\\/]/).some((part) => !part || part === '.' || part === '..'), 'Exact relative file required');
  const target = path.resolve(root, relative); assert(target.startsWith(root + path.sep), 'Path escaped worktree');
  let ancestor = target; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assert(fs.realpathSync(ancestor) === ancestor && (!fs.existsSync(target) || fs.statSync(target).isFile()), 'Owned file is a symlink or directory');
  return target;
}

export async function managedRoute({ originalPrompt, taskFacts, harness, feedback, priorDecision },
  { readProfile = loadProfile, readCatalog = loadCatalog, readPolicy = loadPolicy,
    decide = selectDecision, verifyDecision = validateDispatchDecision } = {}) {
  const profile = readProfile(), candidates = applyProfile(readCatalog(), profile), policy = await readPolicy();
  assert(!Object.hasOwn(taskFacts ?? {}, 'verifiedTaskQualityFailure'), 'Quality failure facts require validated controller feedback');
  const facts = feedback?.verifiedTaskQualityFailure === true
    ? { ...taskFacts, verifiedTaskQualityFailure: true } : taskFacts;
  const decision = await decide({ prompt: originalPrompt, harness, candidates, profile, policy,
    features: extractFeatures(originalPrompt, harness, facts), learnedRoute: async () => ({ routedBy: 'policy-only' }) });
  decision.harness = harness; verifyDecision(decision);
  if (feedback?.verifiedTaskQualityFailure === true) {
    const classes = ['fast', 'medium', 'substantial', 'hard', 'exceptional'], efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    assert(priorDecision && priorDecision.harness === harness, 'Verified repair requires the actual prior scoped route');
    const stronger = decision.model === priorDecision.model
      ? efforts.indexOf(decision.effort) > efforts.indexOf(priorDecision.effort)
      : classes.indexOf(decision.taskClass) > classes.indexOf(priorDecision.taskClass);
    const hardContinuation = priorDecision.taskClass === 'hard' && decision.taskClass === 'hard'
      && ['harness', 'provider', 'model', 'effort'].every((field) => decision[field] === priorDecision[field]);
    assert(stronger || hardContinuation, 'No stronger eligible owner-approved native repair route; same or weaker route refused');
    if (hardContinuation) decision.reason += '; bounded scoped repair at approved hard allocation';
  }
  return decision;
}

/** Only host-defined commands enter the registry. Generated text can select IDs, never command strings. */
export function captureCheckerRegistry(projectRoot, worktrees = [projectRoot]) {
  const registry = [{ id: 'output-json', kind: 'output-json' }], sourceRefs = [];
  for (const worktree of worktrees) {
    const packageFile = path.join(worktree, 'package.json');
    if (!fs.existsSync(packageFile)) continue;
    sourceRefs.push(fileRef(packageFile));
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      if (!/^(test(?::[a-z0-9-]+)?|lint|typecheck|check)$/.test(name) || typeof script !== 'string'
        || /[;&|`$<>\r\n]/.test(script) || !/^(node\s+(?:--test|--check)\b|vitest\s+run\b|tsc\s+--noEmit\b|eslint\s)/.test(script)) continue;
      // Lifecycle hooks and script redirection would add effects outside the captured checker.
      if (pkg.scripts[`pre${name}`] || pkg.scripts[`post${name}`]) continue;
      registry.push({ id: `package-${sha(`${worktree}:${name}`).slice(0, 12)}`, kind: 'command',
        command: 'npm', args: ['run', '--ignore-scripts', name], cwd: worktree, sourceRef: fileRef(packageFile), script });
    }
  }
  return { registry, sourceRefs };
}

function normalizeInput(input) {
  const originalPrompt = input.originalPrompt ?? input.prompt;
  assert(typeof originalPrompt === 'string' && originalPrompt.trim(), 'Original prompt required');
  const projectRoot = fs.realpathSync(input.projectRoot ?? input.cwd);
  const allowedWorktrees = (input.allowedWorktrees ?? [projectRoot]).map((file) => fs.realpathSync(file));
  assert(allowedWorktrees.includes(projectRoot), 'Host project root must be allowed');
  assert(['codex', 'claude-code'].includes(input.harness), 'Native harness required');
  const deadline = input.deadline;
  assert(Number.isFinite(deadline) && deadline > Date.now() && deadline - Date.now() <= 15 * 60_000, 'Workflow requires an absolute deadline within fifteen minutes');
  const maxAttempts = input.workflowMaxAttempts ?? (input.maxAttempts - 2);
  assert(Number.isInteger(maxAttempts) && maxAttempts >= 2 && maxAttempts <= 62, 'Planner and frontend attempt reservation required');
  assert(input.permissions?.apiBilling === false && typeof input.permissions?.write === 'boolean', 'Host permissions and subscription-only authority required');
  verifyContextRefs(input.contextRefs);
  return { id: `workflow-${crypto.randomUUID()}`, originalPrompt, projectRoot, allowedWorktrees,
    harness: input.harness, nativeContext: structuredClone(input.nativeContext ?? {}),
    contextRefs: structuredClone(input.contextRefs), permissions: structuredClone(input.permissions),
    deadline, maxAttempts, maxConcurrent: input.maxConcurrent ?? 1, taskFacts: structuredClone(input.taskFacts ?? {}) };
}

function materializeTasks(proposal, request, checks) {
  assert(Array.isArray(proposal.tasks) && proposal.tasks.length > 0 && proposal.tasks.length < request.maxAttempts, 'Bounded planner task DAG required');
  const tasks = proposal.tasks.map((task) => {
    assert(task && Object.keys(task).every((key) => ['id', 'instructions', 'dependsOn', 'mode', 'worktree', 'paths', 'checkIds'].includes(key)), 'Planner may produce tasks, never executable commands or authority');
    assert(ID.test(task.id) && typeof task.instructions === 'string' && task.instructions.trim(), 'Planner task identity/instructions invalid');
    const worktree = task.worktree ?? request.projectRoot;
    assert(request.allowedWorktrees.includes(worktree), 'Planner widened allowed worktrees');
    assert(['read', 'write'].includes(task.mode) && (task.mode !== 'write' || request.permissions.write), 'Planner widened write authority');
    const paths = task.paths ?? [];
    assert(Array.isArray(paths), 'Exact planner file ownership required'); paths.forEach((file) => ownedFile(worktree, file));
    assert(Array.isArray(task.checkIds) && task.checkIds.every((id) => checks.registry.some((check) => check.id === id)), 'Planner selected an unknown checker');
    const acceptanceChecks = [...new Set(['output-json', ...task.checkIds])].map((id) => ({ id }));
    for (const file of task.mode === 'write' ? paths : []) if (/\.(?:mjs|cjs|js)$/.test(file)) {
      const checker = { id: `syntax-${sha(`${worktree}:${file}`).slice(0, 12)}`, kind: 'command',
        command: process.execPath, args: ['--check', ownedFile(worktree, file)], cwd: worktree };
      if (!checks.registry.some((entry) => entry.id === checker.id)) checks.registry.push(checker);
      acceptanceChecks.push({ id: checker.id });
    }
    assert(task.mode !== 'write' || acceptanceChecks.some(({ id }) => id !== 'output-json'), 'Writing task lacks a deterministic artifact checker');
    return { id: task.id, instructions: `${task.instructions}\n${REPORT}`, dependsOn: task.dependsOn ?? [],
      ownership: { mode: task.mode, worktree, paths }, acceptanceChecks };
  });
  assert(tasks.filter((task) => task.ownership.mode === 'write').length <= 1, 'Default service permits only one writing task');
  return tasks;
}

/** One actual read-only planner; original host permissions and context survive verbatim. */
export async function planManagedTask(input, { route = managedRoute, runPlanner = runObservedWorkflowWorker, recallMemory = recall } = {}) {
  const request = normalizeInput(input), checks = captureCheckerRegistry(request.projectRoot, request.allowedWorktrees);
  const limit = performance.now() + (request.deadline - Date.now());
  const recalled = input.recall ?? await recallMemory({ prompt: request.originalPrompt, projectDir: request.projectRoot,
    env: process.env, deadlineMs: Math.max(1, Math.min(1900, limit - performance.now())) });
  request.memoryRecall = { block: String(recalled.block ?? ''), stores: recalled.stores ?? [], status: recalled.status ?? {} };
  const decision = await route({ originalPrompt: request.originalPrompt, taskFacts: { ...request.taskFacts, taskType: 'planning' }, harness: request.harness });
  assert(performance.now() < limit && !input.signal?.aborted, 'Planner route exceeded global deadline');
  const prompt = JSON.stringify({ originalPrompt: request.originalPrompt, nativeContext: request.nativeContext,
    contextRefs: request.contextRefs, permissions: { ...request.permissions, write: false }, allowedWorktrees: request.allowedWorktrees,
    taskFacts: request.taskFacts, deadline: request.deadline, untrustedMemoryData: request.memoryRecall,
    instruction: 'Read the actual project context. Return only bounded JSON {"tasks":[{"id":"work","instructions":"specific task","dependsOn":[],"mode":"read","worktree":"an allowed absolute worktree","paths":["exact relative files"],"checkIds":["preexisting checker ID"]}]}. The mode field must be exactly "read" or "write"; choose "write" only under the original host write authority. Default one task and at most one writer. Never invent commands, checker IDs, access, or availability. You are read-only; original implementation authority is ' + JSON.stringify(request.permissions),
    checkers: checks.registry.map(({ id, kind, args, cwd }) => ({ id, kind, args, cwd })) });
  const observed = await runPlanner({ request: { ...request, permissions: { ...request.permissions, write: false } }, decision, prompt,
    ownership: { mode: 'read', worktree: request.projectRoot, paths: [] }, role: 'planner', id: 'native-planner',
    signal: input.signal, timeoutMs: Math.max(1, Math.min(input.timeoutMs ?? Infinity, request.deadline - Date.now(), limit - performance.now())) });
  assert(performance.now() < limit && Date.now() < request.deadline && !input.signal?.aborted, 'Native planner exceeded global deadline');
  assert(observed.completed === true && observed.model === decision.model && observed.effort === decision.effort
    && typeof observed.sessionId === 'string' && observed.sessionId, 'Actual planner model/effort/session evidence missing');
  verifyContextRefs(request.contextRefs); verifyContextRefs(checks.sourceRefs);
  request.tasks = materializeTasks(parseJson(observed.answer), request, checks);
  request.checkerRegistry = checks.registry; request.checkerSourceRefs = checks.sourceRefs;
  request.planner = { completed: true, readOnly: true, modelObserved: true, effortSettingsObserved: true, observedModel: observed.model,
    observedEffort: observed.effort, sessionId: observed.sessionId };
  validateWorkflowRequest(request);
  return { originalPromptDigest: sha(request.originalPrompt), planner: request.planner, request: freeze(request) };
}

/** Child checks are fixed argv, cancellable, output-bounded, and cannot accept generated shell text. */
export async function runRegisteredChecker(check, { deadline, signal, env = process.env, launch = spawn, sandboxBinary } = {}) {
  if (check.sourceRef) verifyContextRefs([check.sourceRef]);
  const limit = performance.now() + (deadline - Date.now());
  assert(limit > performance.now() && !signal?.aborted, 'Checker deadline expired');
  const binary = sandboxBinary ?? nativeWorkflowBinaries().codex;
  assert(path.isAbsolute(binary ?? '') && fs.statSync(binary).isFile(), 'Verified native read-only checker sandbox unavailable');
  const clean = Object.fromEntries(Object.entries(subscriptionEnvironment(env)).filter(([name]) =>
    !/^(NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|LD_PRELOAD|DYLD.*|NPM_CONFIG_NODE_OPTIONS|npm_config_node_options|NPM_CONFIG_USERCONFIG|npm_config_userconfig)$/i.test(name)));
  const result = await new Promise((resolve) => {
    const child = launch(binary, ['sandbox', '-P', ':read-only', '-C', check.cwd, '--', check.command, ...check.args], { cwd: check.cwd, env: clean, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false, retiring = false, settled = false, timer, killTimer, retirementTimer;
    const safeKill = (name) => {
      try { if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, name);
        else child.kill(name); } catch { /* unavailable process is handled by close or bounded retirement */ }
    };
    const finish = (value) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(retirementTimer);
      signal?.removeEventListener('abort', cancel); resolve({ ...value, stdoutDigest: sha(stdout), stderrDigest: sha(stderr), output: redactText(`${stdout}\n${stderr}`).slice(-8000) });
    };
    const cancel = () => {
      if (retiring || settled) return; retiring = true; safeKill('SIGTERM');
      killTimer = setTimeout(() => safeKill('SIGKILL'), 250);
      retirementTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref?.();
        finish({ passed: false, status: 'blocked', reason: 'uncertain-checker-retirement', exitCode: null, signal: null });
      }, 750);
    };
    const collect = (field, chunk) => {
      const text = String(chunk); if (field === 'stdout') stdout = (stdout + text).slice(-200_000); else stderr = (stderr + text).slice(-200_000);
      if (Buffer.byteLength(field === 'stdout' ? stdout : stderr) >= 200_000 || Buffer.byteLength(text) >= 200_000) { overflow = true; cancel(); }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk)); child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.once('error', () => {
      if (!child.pid) finish({ passed: false, status: 'blocked', reason: 'checker-launch-failed', exitCode: null, signal: null }); else cancel();
    });
    child.once('close', (code, nativeSignal) => {
      const expired = performance.now() >= limit || Date.now() >= deadline;
      finish({ passed: code === 0 && !nativeSignal && !overflow && !retiring && !signal?.aborted && !expired,
        exitCode: code, signal: nativeSignal, ...((retiring || overflow || signal?.aborted || expired)
          ? { status: 'blocked', reason: 'checker-deadline-or-cancellation' } : {}) });
    });
    signal?.addEventListener('abort', cancel, { once: true }); timer = setTimeout(cancel, Math.max(1, limit - performance.now()));
    if (signal?.aborted) cancel();
  });
  if (performance.now() >= limit || Date.now() >= deadline) return { ...result, passed: false, status: 'blocked', reason: result.reason ?? 'checker-deadline-expired' };
  return result;
}

/** Completion requires the exact current receipt row in the adopted canonical store; queued debt fails closed. */
export function commitManagedReceipt(request, receipt, { Journal = ContinuityJournal, drainJournal = drain, read = withProgressionReader } = {}) {
  const resolved = resolveProjectStore({ projectDir: request.projectRoot, gitTimeoutMs: 1000 });
  const journal = new Journal({ projectRoot: resolved.projectRoot, projectDir: request.projectRoot });
  const event = { schema: EVENT_SCHEMA, kind: 'decision', id: sha(JSON.stringify(receipt)).slice(0, 16),
    at: receipt.at, source: 'model-managed-workflow-service', authoritative: true,
    summary: `Managed workflow ${request.id}: ${receipt.status}`, detail: receipt };
  const [row] = journal.record([event]); assert(row, 'Current workflow receipt was not durably enqueued');
  drainJournal(journal, { budgetMs: Math.max(0, Math.min(1000, request.deadline - Date.now())), backoff: [] });
  const readback = read(journal.db, (reader) => reader.readContent(CONTINUITY_NAMESPACE, row.key));
  assert(readback.ok && readback.value === JSON.stringify(row.event), 'Canonical AgentDB exact receipt readback failed; queued is not complete');
  return { durable: true, agentDbCommitted: true, key: row.key, digest: row.digest };
}

function validateStoredRegistry(request) {
  verifyContextRefs(request.checkerSourceRefs);
  const fresh = captureCheckerRegistry(request.projectRoot, request.allowedWorktrees);
  for (const check of request.checkerRegistry) {
    if (check.id === 'output-json') { assert(exact(check, fresh.registry[0]), 'Output checker registry changed'); continue; }
    if (check.id.startsWith('package-')) { assert(fresh.registry.some((entry) => exact(entry, check)), 'Captured package checker changed'); continue; }
    assert(request.tasks.some((task) => task.ownership.mode === 'write' && task.ownership.paths.some((file) => exact(check,
      { id: `syntax-${sha(`${task.ownership.worktree}:${file}`).slice(0, 12)}`, kind: 'command', command: process.execPath,
        args: ['--check', ownedFile(task.ownership.worktree, file)], cwd: task.ownership.worktree }))), 'Unknown or modified executable checker');
  }
}

export async function executeManagedWorkflow(input, { route = managedRoute, createAdapters = createGuardedWorkflowAdapters,
  check = runRegisteredChecker, recordReceipt = commitManagedReceipt, verifyDecision = validateDispatchDecision, env = process.env, signal } = {}) {
  const request = freeze(structuredClone(input)); validateWorkflowRequest(request); validateStoredRegistry(request);
  assert(!signal?.aborted, 'Workflow cancelled before native launch');
  assert(request.planner?.completed && request.planner.readOnly && request.planner.sessionId, 'Native planning receipt required');
  const observations = new Map(), outputRefs = new Map();
  const artifactsRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-managed-artifacts-'))); fs.chmodSync(artifactsRoot, 0o700);
  const captureObservation = (worker, observation) => {
    const file = path.join(artifactsRoot, `${worker.id}.json`); fs.writeFileSync(file, observation.answer, { mode: 0o600 });
    outputRefs.set(worker.id, fileRef(file));
    const receiptFile = path.join(artifactsRoot, `${worker.id}.receipt.json`);
    const metadata = { workerId: worker.id, role: worker.role, host: worker.host, completed: observation.completed,
      configuredModel: worker.configuredModel, configuredEffort: worker.configuredEffort,
      observedModel: observation.model, observedEffort: observation.effort, sessionId: observation.sessionId,
      readOnly: worker.ownership.mode !== 'write', evidence: observation.evidence, effortEvidence: observation.effortEvidence,
      modelObserved: observation.completed === true && observation.model === worker.configuredModel,
      effortSettingsObserved: observation.completed === true && observation.effort === worker.configuredEffort };
    fs.writeFileSync(receiptFile, JSON.stringify(metadata), { mode: 0o600 });
    const receiptRef = fileRef(receiptFile); outputRefs.set(`${worker.id}-receipt`, receiptRef);
    observations.set(worker.id, { ...observation, receiptRef, answerRef: outputRefs.get(worker.id) });
  };
  const checkAcceptance = async ({ executionReceipts, signal }) => {
    validateStoredRegistry(request);
    const artifactRefs = [...outputRefs.entries()].filter(([id]) => !id.startsWith('independent-review')).map(([, ref]) => ref);
    for (const task of request.tasks) for (const file of task.ownership.mode === 'write' ? task.ownership.paths : []) {
      const target = ownedFile(task.ownership.worktree, file); assert(fs.existsSync(target), 'Owned artifact missing after implementation'); artifactRefs.push(fileRef(target));
    }
    const uniqueRefs = [...new Map(artifactRefs.map((ref) => [ref.path, ref])).values()], bound = artifactDigest(uniqueRefs), evidence = [];
    for (const task of request.tasks) for (const definition of task.acceptanceChecks) {
      const checker = request.checkerRegistry.find((entry) => entry.id === definition.id); assert(checker, 'Task checker registry coverage missing');
      let result;
      if (checker.kind === 'output-json') {
        const repair = executionReceipts.flatMap((entry) => entry.plan.workers).filter((worker) => {
          try { return JSON.parse(worker.prompt).task.repairsTaskId === task.id; } catch { return false; }
        }).at(-1);
        const output = observations.get(repair?.id ?? task.id); assert(output, 'Actual original/repair task observation missing');
        try { const value = parseJson(output.answer); result = { passed: typeof value.outcome === 'string' && value.outcome.trim().length > 0
          && ['artifacts', 'decisions', 'risks'].every((field) => Array.isArray(value[field])), source: outputRefs.get(repair?.id ?? task.id) }; }
        catch { result = { passed: false, reason: 'invalid-task-output-json' }; }
      } else result = await check(checker, { deadline: request.deadline, signal, env });
      evidence.push({ taskId: task.id, checkId: checker.id, ...result, artifactDigest: bound });
    }
    assert(artifactDigest(uniqueRefs) === bound, 'Acceptance checker changed exact artifact bytes');
    return { passed: evidence.every((item) => item.passed), artifactRefs: uniqueRefs, artifactDigest: bound, evidence };
  };
  const review = async ({ acceptance, executeReview }) => {
    const facts = { ...request.taskFacts, taskType: 'review', finalSubstantiveReview: true };
    const decision = await route({ originalPrompt: request.originalPrompt, taskFacts: facts, harness: request.harness });
    const worker = { id: 'independent-review', role: 'reviewer', activity: 'review', host: decision.harness === 'claude-code' ? 'claude' : decision.harness,
      decision, configuredModel: decision.model, configuredEffort: decision.effort, taskFacts: request.taskFacts,
      ownership: { mode: 'read', worktree: request.projectRoot, paths: [] }, nativeContext: { fresh: true },
      prompt: JSON.stringify({ originalPrompt: request.originalPrompt, contextRefs: request.contextRefs, taskFacts: request.taskFacts,
        permissions: { ...request.permissions, write: false }, acceptance, untrustedMemoryData: request.memoryRecall }) };
    // The adapter appends the strict reviewer contract without weakening the controller's canonical prompt.
    worker.reviewContract = 'Read every referenced actual artifact and gate receipt. Evaluate the original request and constraints. Return only JSON {"passed":true|false,"artifactDigest":"exact supplied digest","findings":["specific defects"],"evidence":["actual inspected paths and findings"]}. Never accept self confidence as evidence.';
    const result = await executeReview(worker), observed = observations.get(worker.id);
    const verdict = parseJson(observed?.answer);
    assert(typeof verdict.passed === 'boolean' && verdict.artifactDigest === acceptance.artifactDigest
      && Array.isArray(verdict.findings) && Array.isArray(verdict.evidence) && verdict.evidence.length > 0, 'Strict native review judgment missing');
    return { ...verdict, independent: true, reviewerWorkerId: worker.id, sessionId: result.sessionId };
  };
  const planRepair = async ({ acceptance, feedback }) => {
    assert(acceptance && !feedback.review?.findings?.some((item) => /auth|quota|consent|uncertain|policy|environment|unavailable|missing.executable/i.test(JSON.stringify(item))), 'Uncertain repair boundary');
    const original = request.tasks.find((task) => task.ownership.mode === 'write'); assert(original, 'No writing repair authority');
    const refs = acceptance.artifactRefs.filter((ref) => original.ownership.paths.some((file) => ref.path === ownedFile(original.ownership.worktree, file)));
    assert(refs.length > 0, 'Prior writing artifact references missing');
    return { artifactRefs: acceptance.artifactRefs, baseArtifactDigest: acceptance.artifactDigest,
      tasks: [{ ...original, id: `repair-${crypto.randomUUID()}`, repairsTaskId: original.id, dependsOn: [], repairArtifacts: refs,
        instructions: `Fix only the failed original acceptance or independent review in the exact prior artifacts. Preserve all successful work.\n${REPORT}` }] };
  };
  const outcome = await runRoutingWorkflow(request, { route: (ctx) => route({ ...ctx, harness: request.harness }),
    createAdapters: async (ctx) => {
      const adapters = await createAdapters({ ...ctx, env, captureObservation });
      return Object.fromEntries(Object.entries(adapters).map(([host, adapter]) => [host, { ...adapter,
        interpret: (...args) => { const result = adapter.interpret(...args); const observed = observations.get(result.workerId);
          return observed ? { ...result, receiptRef: observed.receiptRef } : result; } }]));
    }, checkAcceptance, review,
    ...(request.tasks.some((task) => task.ownership.mode === 'write') ? { planRepair } : {}),
    recordReceipt: (req, receipt) => recordReceipt(req, { ...receipt, planner: request.planner,
      recallEvidence: { stores: request.memoryRecall?.stores, status: request.memoryRecall?.status } }), verifyDecision, signal });
  if (outcome.status !== 'complete') return outcome;
  const originals = new Map();
  for (const stage of outcome.executionReceipts) for (const [index, worker] of stage.plan.workers.entries()) {
    const task = JSON.parse(worker.prompt).task, id = task.repairsTaskId ?? task.id;
    if (request.tasks.some((original) => original.id === id)) originals.set(id, { ...stage.results[index], workerId: id,
      executedWorkerId: worker.id, answer: observations.get(worker.id)?.answer });
  }
  const executions = [...observations].map(([workerId, observed]) => ({ workerId, sessionId: observed.sessionId,
    observedModel: observed.model, observedEffort: observed.effort, effortEvidence: observed.effortEvidence,
    receiptRef: observed.receiptRef, answerRef: observed.answerRef }));
  return { ...outcome, results: request.tasks.map((task) => originals.get(task.id)), executions,
    review: { ...outcome.review, sessionId: observations.get(outcome.review.reviewerWorkerId)?.sessionId } };
}
