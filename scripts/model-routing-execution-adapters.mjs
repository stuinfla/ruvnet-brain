const assertModelRoutingText = async text => (await import('./model-routing-defence.mjs')).assertModelRoutingText(text);
// Guarded native workers for Agentic Kit's existing execution runner.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { runControlledClaudeTurn } from './claude-controlled-terminal.mjs';
import { validateDispatchDecision, assertSubscriptionAuth, buildLaunch, subscriptionEnvironment } from './model-router-dispatch.mjs';
import { subscriptionOnlyEnv } from './subscription-hosts.mjs';
import { readCodexAllowance } from './native-subscription-usage.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const blocked = reason => Object.assign(new Error(reason), { safetyBlocked: true });

export function nativeWorkflowBinaries(home = os.homedir()) {
  const config = JSON.parse(fs.readFileSync(path.join(home, '.cache/ruvnet-brain/model-routing/terminal-launcher-config.json'), 'utf8'));
  return { claude: config.realClaude, codex: config.realCodex };
}

export function readCodexWorkerObservation(sessionId, { home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), now = Date.now(), expectedPriorTurns, evidencePath, expectedPrefix, allowHistory = false, deadline = Infinity, signal } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId || '')) throw blocked('Native worker session identity missing');
  const matches = [];
  const directories = [];
  const base = path.join(fs.existsSync(home) ? fs.realpathSync(home) : home, 'sessions');
  if (evidencePath) {
    const directory = fs.realpathSync(path.dirname(evidencePath));
    if (!directory.startsWith(base + path.sep)) throw blocked('Native evidence escaped its session home');
    evidencePath = path.join(directory, path.basename(evidencePath)); directories.push(directory);
  }
  else if ((expectedPriorTurns !== undefined || allowHistory) && fs.existsSync(base)) {
    for (const year of fs.readdirSync(base)) if (/^\d{4}$/.test(year))
      for (const month of fs.readdirSync(path.join(base, year))) if (/^\d{2}$/.test(month))
        for (const day of fs.readdirSync(path.join(base, year, month))) if (/^\d{2}$/.test(day)) directories.push(path.join(base, year, month, day));
  } else for (const offset of [0, 86400000]) {
    const date = new Date(now - offset).toISOString().slice(0, 10).split('-');
    directories.push(path.join(base, ...date));
  }
  for (const directory of new Set(directories)) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(`-${sessionId}.jsonl`)) continue;
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || process.getuid && stat.uid !== process.getuid()) throw blocked('Unsafe native worker evidence file');
      if (!evidencePath || evidencePath === file) matches.push({ file });
    }
  }
  if (matches.length !== 1) throw blocked('Exact native worker rollout unavailable or ambiguous');
  const file = matches[0].file, fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const limit = 16 * 1024 * 1024, decoder = new TextDecoder('utf-8', { fatal: true }), hash = crypto.createHash('sha256');
  const prefix = expectedPrefix && crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
  let before, offset = 0, rowOffset = 0, rowBytes = 0, parts = [], context, contextRange, meta, compact, turnCount = 0, metaCount = 0;
  const live = () => { if (signal?.aborted || Date.now() >= deadline) throw blocked('Native evidence capture cancelled or expired'); };
  const consume = () => {
    let row;
    try { row = JSON.parse(decoder.decode(Buffer.concat(parts, rowBytes))); } catch { throw blocked('Malformed native evidence record or UTF-8'); }
    if (!row || typeof row !== 'object' || typeof row.type !== 'string') throw blocked('Malformed native evidence record');
    const range = { offset: rowOffset, bytes: rowBytes };
    if (row.type === 'session_meta') { metaCount++; meta = { ...range, id: row.payload?.id }; }
    if (row.type === 'turn_context') { turnCount++; context = row.payload; contextRange = range; }
    if (row.type === 'compacted') {
      if (!Array.isArray(row.payload?.replacement_history) || !row.payload.replacement_history.length) throw blocked('Native compaction provenance unavailable');
      compact = range;
    }
    rowOffset += rowBytes; rowBytes = 0; parts = [];
  };
  try {
    before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || process.getuid && before.uid !== BigInt(process.getuid()) || before.size > BigInt(Number.MAX_SAFE_INTEGER)
      || !process.getuid && before.size > BigInt(limit)) throw blocked('Unsafe native worker evidence file');
    if (expectedPrefix && (!Number.isSafeInteger(expectedPrefix.bytes) || expectedPrefix.bytes < 0 || expectedPrefix.bytes > Number(before.size)
      || !/^[a-f0-9]{64}$/.test(expectedPrefix.sha256 || ''))) throw blocked('Native history prefix changed');
    while (offset < Number(before.size)) {
      live(); const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (!count) throw blocked('Native evidence truncated during capture');
      hash.update(buffer.subarray(0, count));
      if (prefix && offset < expectedPrefix.bytes) prefix.update(buffer.subarray(0, Math.min(count, expectedPrefix.bytes - offset)));
      let start = 0;
      while (start < count) {
        const newline = buffer.indexOf(10, start), end = newline >= start && newline < count ? newline + 1 : count;
        const part = Buffer.from(buffer.subarray(start, end)); rowBytes += part.length;
        if (rowBytes > limit) throw blocked('Native evidence record exceeded bound');
        parts.push(part); if (end <= count && buffer[end - 1] === 10) consume(); start = end;
      }
      offset += count;
    }
    if (rowBytes) { if (Number(before.size) > limit) throw blocked('Partial native evidence terminal record'); consume(); }
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key] || after[key] !== current[key]) || current.isSymbolicLink()) throw blocked('Native evidence changed during capture');
    live();
  } finally { fs.closeSync(fd); }
  if (prefix && prefix.digest('hex') !== expectedPrefix.sha256) throw blocked('Native history prefix changed');
  if (!turnCount || !context || !allowHistory && turnCount !== (expectedPriorTurns === undefined ? 1 : expectedPriorTurns + 1)) throw blocked('Native worker has unexpected turn history');
  const sha256 = hash.digest('hex'), bytes = Number(before.size);
  if (metaCount > 1 || meta && meta.id !== sessionId) throw blocked('Native history session provenance mismatch');
  let sourceBound;
  if (bytes > limit) {
    if (metaCount !== 1 || meta?.id !== sessionId) throw blocked('Native history session provenance mismatch');
    if (compact) {
      const ranges = [{ offset: meta.offset, bytes: meta.bytes }, ...(contextRange.offset < compact.offset ? [contextRange] : []), { offset: compact.offset, bytes: bytes - compact.offset }];
      if (ranges.some((range, index) => index && range.offset < ranges[index - 1].offset + ranges[index - 1].bytes)) throw blocked('Native projection provenance overlaps');
      sourceBound = { kind: 'native-compaction-projection', nativeSessionId: sessionId, sourceSha256: sha256, sourceBytes: bytes,
        fullTurnCount: turnCount, omittedHistoryPrefix: true, ranges };
    }
  }
  return { model: context.model, effort: context.effort, cwd: context.cwd, sandbox: context.sandbox_policy, sessionId,
    turnCount, evidence: { path: file, sha256, type: 'native-turn-context', byteLength: bytes, ...(sourceBound ? { sourceBound } : {}) } };
}

/** Only the installed user-owned Brain search server is projected into isolated native workers. */
export function codexBrainSearchArguments(env = process.env) {
  const server = path.join(env.HOME || os.homedir(), '.claude', 'ruvnet-brain', 'mcp', 'server.mjs');
  if (!fs.existsSync(server)) return [];
  const stat = fs.lstatSync(server);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw blocked('Installed Brain search server is not user-owned');
  const table = `mcp_servers.ruvnet-brain={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(server)}],enabled_tools=["search_ruvnet"],startup_timeout_sec=30,tool_timeout_sec=90,env={RUVNET_HOOK_HOST="codex"}}`;
  return ['-c', table];
}

const CLAUDE_WORKFLOW_SCHEMAS = {"planner":{"type":"object","properties":{"tasks":{"type":"array","minItems":1,"items":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[a-z][a-z0-9-]{0,79}$"},"instructions":{"type":"string","minLength":1},"dependsOn":{"type":"array","items":{"type":"string"}},"mode":{"type":"string","enum":["read","write"]},"worktree":{"type":"string"},"paths":{"type":"array","items":{"type":"string"}},"checkIds":{"type":"array","items":{"type":"string"}}},"required":["id","instructions","mode","checkIds"]}}},"required":["tasks"]},"worker":{"type":"object","properties":{"outcome":{"type":"string","minLength":1},"artifacts":{"type":"array","items":{}},"decisions":{"type":"array","items":{}},"risks":{"type":"array","items":{}}},"required":["outcome","artifacts","decisions","risks"]},"reviewer":{"type":"object","properties":{"passed":{"type":"boolean"},"artifactDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"findings":{"type":"array","items":{}},"evidence":{"type":"array","items":{},"minItems":1}},"required":["passed","artifactDigest","findings","evidence"]}};
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function claudeWorkflowResponse(role) {
  const kind = role === 'developer' ? 'worker' : role;
  if (!Object.hasOwn(CLAUDE_WORKFLOW_SCHEMAS, kind)) throw blocked('Unknown native Claude workflow role');
  const schema = CLAUDE_WORKFLOW_SCHEMAS[kind];
  if (!schema) throw blocked('Unknown native Claude workflow role');
  const nonblank = value => typeof value === 'string' && value.trim().length > 0;
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  const validate = value => {
    if (!plainObject(value)) return false;
    if (kind === 'planner') return Array.isArray(value.tasks) && value.tasks.length > 0 && value.tasks.every(task =>
      plainObject(task) && Object.keys(task).every(key => ['id', 'instructions', 'dependsOn', 'mode', 'worktree', 'paths', 'checkIds'].includes(key))
      && /^[a-z][a-z0-9-]{0,79}$/.test(task.id || '') && nonblank(task.instructions) && ['read', 'write'].includes(task.mode)
      && strings(task.checkIds) && (task.dependsOn === undefined || strings(task.dependsOn))
      && (task.paths === undefined || strings(task.paths)) && (task.worktree === undefined || typeof task.worktree === 'string'));
    if (kind === 'worker') return nonblank(value.outcome) && ['artifacts', 'decisions', 'risks'].every(key => Array.isArray(value[key]));
    return typeof value.passed === 'boolean' && /^[a-f0-9]{64}$/.test(value.artifactDigest || '')
      && Array.isArray(value.findings) && Array.isArray(value.evidence) && value.evidence.length > 0;
  };
  return { responseSchema: structuredClone(schema), validateStructuredOutput: validate };
}

export async function executeCodexWorkflowWorker({ binary, decision, prompt, cwd, readOnly, signal, timeoutMs,
  env = process.env, sessionId, launch = spawn, observe = readCodexWorkerObservation, allowance = readCodexAllowance }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || signal?.aborted) throw blocked('Native worker cancelled or deadline unavailable');
  const limit = performance.now() + timeoutMs;
  await assertModelRoutingText(prompt);
  const clean = { ...subscriptionOnlyEnv(subscriptionEnvironment(env)), RNB_TERMINAL_LAUNCH_ACTIVE: '1' };
  assertSubscriptionAuth('codex', { env: clean });
  const quota = await allowance({ env: clean,
    spawnHost: (_command, args, options) => launch(binary, args, options) });
  if (quota.ordinaryUsageAllowed !== true) throw blocked('Native Codex included allowance not available');
  if (performance.now() >= limit || signal?.aborted) throw blocked('Native worker deadline expired during readiness');
  const spec = buildLaunch(decision, { cwd });
  const evidenceHome = clean.CODEX_HOME || path.join(os.homedir(), '.codex');
  const prior = sessionId ? observe(sessionId, { home: evidenceHome, expectedPriorTurns: undefined, allowHistory: true,
    deadline: Date.now() + Math.max(0, limit - performance.now()), signal }) : null;
  const args = sessionId ? ['exec', 'resume', '--ignore-user-config', '--skip-git-repo-check', '--json', '--model', decision.model,
    '-c', `model_reasoning_effort=\"${decision.effort}\"`, '-c', 'model_provider=\"openai\"',
    '-c', 'service_tier=\"default\"', '-c', `sandbox_mode=\"${readOnly ? 'read-only' : 'workspace-write'}\"`,
    '-c', 'features.fast_mode=false', '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false', sessionId, '-']
    : [...spec.args.slice(0, -1), '--skip-git-repo-check', '--json', '--sandbox', readOnly ? 'read-only' : 'workspace-write',
      '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false', '-'];
  args.splice(args.length - 1, 0, ...codexBrainSearchArguments(clean));
  if (performance.now() >= limit || signal?.aborted) throw blocked('Native worker deadline expired before launch');
  const result = await new Promise((resolve, reject) => {
    const child = launch(binary, args, { cwd, env: clean, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', finished = false, timer, killTimer, cancelled = false, cancelReason;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      error ? reject(error) : resolve(value);
    };
    const safeKill = signalName => { try { child.kill(signalName); } catch { /* close remains required */ } };
    const cancel = reason => {
      if (finished || cancelled) return; cancelled = true; cancelReason = typeof reason === 'string' ? reason : 'Native worker cancelled';
      safeKill('SIGTERM');
      killTimer = setTimeout(() => { safeKill('SIGKILL');
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.();
        finish(Object.assign(blocked('Native worker retirement not confirmed'), { retirementUnconfirmed: true })); }, 1000);
    };
    child.stdout.on('data', chunk => { if (cancelled) return; stdout += chunk; if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) cancel('Native worker output exceeded bound'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', () => cancel('Native worker process error; retirement required'));
    child.stdin.once('error', () => cancel('Native worker input delivery failed'));
    child.once('close', (code, nativeSignal) => {
      if (cancelled || signal?.aborted || nativeSignal) return finish(blocked('Native worker interrupted; effects require inspection'));
      if (code !== 0) return finish(blocked(`Native worker failed (exit ${code}); inspect effects before retry`));
      finish(null, { stdout, stderr });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => cancel('Native worker deadline exceeded'), Math.max(1, limit - performance.now()));
    if (signal?.aborted) cancel(); else child.stdin.end(prompt);
  });
  if (performance.now() >= limit || signal?.aborted) throw blocked('Native worker completed after its deadline');
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  const thread = events.find(event => event.type === 'thread.started');
  if (!events.some(event => event.type === 'turn.completed') || events.some(event => event.type === 'turn.failed' || event.type === 'error')) {
    throw blocked('Native Codex turn did not complete successfully');
  }
  if (sessionId && thread?.thread_id !== sessionId) throw blocked('Native parent session changed');
  const observation = observe(thread?.thread_id, { home: evidenceHome, deadline: Date.now() + Math.max(0, limit - performance.now()), signal,
    ...(sessionId ? { expectedPriorTurns: prior.turnCount, evidencePath: prior.evidence.path,
      expectedPrefix: { bytes: prior.evidence.byteLength, sha256: prior.evidence.sha256 } } : {}) });
  if (observation.model !== decision.model || observation.effort !== decision.effort || observation.cwd !== cwd
    || (readOnly && observation.sandbox?.type !== 'read-only')) throw blocked('Native worker model, effort, directory or sandbox mismatch');
  const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
  const answer = messages.at(-1)?.item?.text;
  if (typeof answer !== 'string') throw blocked('Native final answer unavailable');
  await assertModelRoutingText(answer);
  if (performance.now() >= limit || signal?.aborted) throw blocked('Native worker exceeded deadline during output inspection');
  return { ...observation, answer, completed: true, modelObserved: true, effortSettingsObserved: true, effortEvidence: 'native-turn-context', usage: events.find(event => event.type === 'turn.completed')?.usage ?? null };
}

/** Native Codex stays read-only. Only exact, preconditioned owner-authorized files are published here. */
export function applyOwnedCodexEdits(worker, answer, { signal, deadline = Infinity } = {}) {
  let report;
  try { report = JSON.parse(answer); } catch { throw blocked('Codex write result must be bounded JSON edits'); }
  if (!Array.isArray(report.edits) || !report.edits.length || report.edits.length > 32) throw blocked('Exact bounded edits required');
  const root = fs.realpathSync(worker.ownership.worktree), targets = new Set(); let total = 0;
  const live = () => { if (signal?.aborted || Date.now() >= deadline) throw blocked('Edit publication cancelled or expired'); };
  const edits = report.edits.map(edit => {
    live();
    if (!edit || typeof edit.path !== 'string' || path.isAbsolute(edit.path) ||
      edit.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') ||
      !worker.ownership.paths.includes(edit.path) || typeof edit.content !== 'string') throw blocked('Edit escaped exact file ownership');
    const file = path.join(root, edit.path); if (targets.has(file)) throw blocked('Duplicate edit'); targets.add(file);
    total += Buffer.byteLength(edit.content); if (total > 4 * 1024 * 1024) throw blocked('Edit bytes exceeded bound');
    for (let ancestor = file; ancestor !== root; ancestor = path.dirname(ancestor)) {
      if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw blocked('Symlink edit refused');
    }
    if (!fs.existsSync(path.dirname(file))) throw blocked('Edit parent must already exist');
    const exists = fs.existsSync(file), stat = exists ? fs.lstatSync(file) : null;
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw blocked('Nonregular or hardlinked edit refused');
    if (exists ? edit.oldSha256 !== digest(fs.readFileSync(file)) : edit.oldSha256 !== null) throw blocked('Edit precondition changed');
    return { ...edit, file, mode: stat?.mode & 0o777 || 0o600, exists };
  });
  const applied = [];
  try {
    for (const edit of edits) {
      live();
      if (edit.exists ? !fs.existsSync(edit.file) || digest(fs.readFileSync(edit.file)) !== edit.oldSha256 : fs.existsSync(edit.file)) throw blocked('Edit changed at publication');
      const temporary = path.join(path.dirname(edit.file), `.rnb-edit-${crypto.randomUUID()}`);
      try {
        fs.writeFileSync(temporary, edit.content, { flag: 'wx', mode: edit.mode }); live();
        if (edit.exists) {
          if (fs.lstatSync(edit.file).isSymbolicLink() || digest(fs.readFileSync(edit.file)) !== edit.oldSha256) throw blocked('Edit changed before replacement');
          // Single-writer ownership is required; external same-user writes are not an atomic CAS contract.
          fs.renameSync(temporary, edit.file);
        } else fs.linkSync(temporary, edit.file); // no-replace publication even if a destination races into existence
        applied.push({ path: edit.file, digest: digest(fs.readFileSync(edit.file)) });
      } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
  } catch (error) {
    throw Object.assign(blocked(`Edit publication blocked: ${error.message}; inspect actual applied files before retry`), { applied, uncertainEffects: applied.length > 0 });
  }
  return applied;
}

function ownedPermission(request, worker, nativeRequest) {
  if (['Agent', 'Task'].includes(nativeRequest.tool_name)) return false;
  if (['Read', 'Glob', 'Grep'].includes(nativeRequest.tool_name) || /__search_ruvnet$/.test(nativeRequest.tool_name)) return true;
  if (worker.ownership?.mode !== 'write' || request.permissions?.write !== true) return false;
  if (!['Write', 'Edit', 'MultiEdit'].includes(nativeRequest.tool_name)) return false;
  const input = nativeRequest.input || {}, raw = input.file_path;
  if (typeof raw !== 'string') return false;
  const root = fs.realpathSync(worker.ownership.worktree), target = path.resolve(root, raw);
  if (!target.startsWith(root + path.sep)) return false;
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) return false;
  return worker.ownership.paths.some(relative => {
    const allowed = path.resolve(root, relative);
    return target === allowed || (relative.endsWith('/') && target.startsWith(allowed + path.sep));
  });
}

export function createGuardedWorkflowAdapters({ request, budget, env = process.env,
  binaries = nativeWorkflowBinaries(), executeNative, verifyDecision = validateDispatchDecision, captureObservation = () => {} }) {
  const adapters = {};
  for (const host of ['codex', 'claude']) {
    adapters[host] = {
      id: `brain-native-${host}`,
      hostId: host,
      readiness: async () => ({ ready: true }),
      prepare: async ({ worker, signal, timeoutMs }) => {
        const decision = worker.decision;
        if (!decision || decision.harness !== (host === 'claude' ? 'claude-code' : host)
          || decision.model !== worker.configuredModel) throw blocked('Worker allocation missing or inconsistent');
        verifyDecision(decision);
        const binary = binaries[host];
        if (!path.isAbsolute(binary || '') || !fs.statSync(binary).isFile()) throw blocked('Native executable unavailable');
        const cwd = fs.realpathSync(worker.ownership?.worktree || request.projectRoot || request.cwd);
        if (worker.ownership?.mode === 'write' && (request.permissions?.write !== true || !worker.ownership.paths?.length)) {
          throw blocked('Worker write authority unavailable');
        }
        if (!request.originalPrompt || typeof worker.prompt !== 'string') throw blocked('Original request context unavailable');
        let original;
        try { original = JSON.parse(worker.prompt).originalPrompt; } catch { /* AK appends its handoff below the canonical JSON. */ }
        if (original !== request.originalPrompt && !worker.prompt.includes(request.originalPrompt)
          && !worker.prompt.includes(JSON.stringify(request.originalPrompt))) throw blocked('Worker lost the original request');
        for (const ref of request.contextRefs || []) {
          if (digest(fs.readFileSync(ref.path)) !== ref.digest) throw blocked('Canonical context changed before launch');
        }
        const controller = new AbortController();
        return { worker, decision, binary, cwd, controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          timeoutMs: Math.min(timeoutMs, budget.deadline - Date.now()), startedAt: new Date().toISOString(), finished: false };
      },
      launch: async state => {
        try {
          if (host === 'claude') state.timeoutMs = Math.floor(Math.min(state.timeoutMs, budget.deadline - Date.now()));
          if (state.timeoutMs <= 0) throw blocked('Shared workflow deadline exhausted');
          if (executeNative) state.observation = await executeNative({ ...state, prompt: state.worker.prompt + (state.worker.reviewContract ? '\n' + state.worker.reviewContract : ''), env });
          else if (host === 'codex') {
            const write = state.worker.ownership?.mode === 'write';
            const contract = write ? '\nExecution contract: native execution is read-only. Return ONLY JSON with outcome, artifacts, decisions, risks, and edits:[{path,oldSha256,content}]. Read each existing file first and use its actual SHA256; new files use oldSha256:null. Paths must exactly match ownership.paths. Do not write files or run mutating commands.' : '';
            state.observation = await executeCodexWorkflowWorker({ ...state, prompt: state.worker.prompt + contract + (state.worker.reviewContract ? '\n' + state.worker.reviewContract : ''), readOnly: true, env });
            if (write) state.observation.appliedArtifacts = applyOwnedCodexEdits(state.worker, state.observation.answer, { signal: state.signal, deadline: budget.deadline });
          }
          else {
            const receipts = [];
            const turn = await runControlledClaudeTurn({ ...state, ...claudeWorkflowResponse(state.worker.role), prompt: state.worker.prompt + (state.worker.reviewContract ? '\n' + state.worker.reviewContract : ''), env,
              decide: async () => state.decision, approve: async permission => ownedPermission(request, state.worker, permission),
              receipt: value => receipts.push(value) });
            if (turn.structuredOutput !== true || typeof turn.finalAnswer !== 'string' || !turn.finalAnswer.trim()) throw blocked('Native final answer unavailable');
            state.observation = { model: turn.decision?.model, effort: turn.decision?.effort,
              sessionId: turn.sessionId, completed: turn.modelObserved === true && turn.effortSettingsObserved === true, answer: turn.finalAnswer,
              evidence: receipts, responseFormat: 'json-schema', nativeSchemaRetries: 'not-observed', effortEvidence: 'Native settings observed before and after; per-request effort not exposed' };
          }
          if (state.observation?.completed && state.observation.model === state.decision.model && state.observation.effort === state.decision.effort) {
            captureObservation(state.worker, state.observation);
          }
        } catch (error) { state.error = error; if (error.retirementUnconfirmed) state.retirementUnconfirmed = true; }
        finally { state.finished = true; }
        return state;
      },
      observe: async state => state.observation,
      interpret: (state, observation) => {
        const valid = !state.error && observation?.completed === true && observation.model === state.decision.model && observation.effort === state.decision.effort;
        state.observation = observation;
        const endedAt = new Date().toISOString();
        return { workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host,
          status: valid ? 'succeeded' : 'blocked', exitCategory: valid ? 'success' : 'protocol_error',
          startedAt: state.startedAt, endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(state.startedAt)),
          provider: valid ? state.decision.provider : null, providerProvenance: valid ? 'configured' : 'unknown',
          configuredModel: state.decision.model, observedModel: valid ? observation.model : null,
          configuredEffort: state.decision.effort, observedEffort: valid ? observation.effort : null,
          effortEvidence: valid ? observation.effortEvidence || 'native-turn-context' : null,
          sessionId: observation?.sessionId || null, transcriptRefs: observation?.evidence?.path ? [observation.evidence.path] : [],
          failure: valid ? null : { reason: state.error?.message || 'Native model/effort/completion unverified' }, usage: observation?.usage || null,
          ...(observation?.type === 'orphaned' || state.retirementUnconfirmed ? { status: 'blocked', exitCategory: 'orphaned' } : {}) };
      },
      summarize: state => {
        try { return JSON.parse(state.observation.answer); } catch { throw blocked('Required native handoff is missing or malformed'); }
      },
      cancel: async state => { state?.controller.abort(); return { type: state?.finished ? 'cancelled' : 'orphaned' }; },
      cleanup: async state => {
        if (state && (!state.finished || state.retirementUnconfirmed)) throw blocked('Native worker cleanup is not confirmed');
        return { cleaned: true };
      },
    };
  }
  return adapters;
}

export async function runObservedWorkflowWorker({ request, decision, prompt, ownership, role = 'worker',
  id = `worker-${crypto.randomUUID()}`, env = process.env, signal, timeoutMs = 120000 }) {
  const host = decision.harness === 'claude-code' ? 'claude' : decision.harness;
  const adapters = createGuardedWorkflowAdapters({ request, env, budget: { deadline: request.deadline || Date.now() + timeoutMs } });
  if (!adapters[host]) throw blocked('Native workflow host unavailable');
  const worker = { id, host, activity: role === 'reviewer' ? 'review' : 'implementation', role, decision,
    configuredModel: decision.model, configuredEffort: decision.effort, ownership, prompt };
  const state = await adapters[host].prepare({ worker, signal, timeoutMs });
  await adapters[host].launch(state);
  const result = adapters[host].interpret(state, await adapters[host].observe(state));
  await adapters[host].cleanup(state);
  if (result.status !== 'succeeded') throw blocked(result.failure?.reason || 'Native worker completion unverified');
  return { ...state.observation, result };
}
