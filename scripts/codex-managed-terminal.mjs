// Controlled native exec/resume frontend. This is deliberately not the native Codex TUI.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createManagedTerminal } from './managed-terminal-input.mjs';
import { runManagedPrompt } from './model-managed-prompt.mjs';
import { decideNativeTurn, appendGatewayReceipt, canonicalCodexConfig } from './model-routing-gateway.mjs';
import { validateDispatchDecision, subscriptionEnvironment } from './model-router-dispatch.mjs';
import { classifyTerminalArguments } from './model-terminal-gateway.mjs';
import { executeCodexWorkflowWorker } from './model-routing-execution-adapters.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const BYPASS = '--dangerously-bypass-approvals-and-sandbox';
const invalid = () => new Error('Controlled Codex accepts a literal prompt, resume <UUID>, -C/--cd <directory>, and explicit owner permission bypass. Unsupported flags are refused.');

export function parseCodexManagedArguments(args = [], cwd = process.cwd()) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw invalid();
  if (classifyTerminalArguments(args) === 'admin') return { administrative: true, args: [...args], cwd };
  let sessionId, sandbox, approvalPolicy, ownerBypass = false, literal = false;
  const prompts = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (literal) { prompts.push(arg); continue; }
    if (arg === '--') { literal = true; continue; }
    if (arg === BYPASS && !ownerBypass) { ownerBypass = true; continue; }
    if (['-s', '--sandbox', '-a', '--ask-for-approval'].includes(arg)) {
      const value = args[++index];
      if (['-s', '--sandbox'].includes(arg)) {
        if (sandbox !== undefined || !['read-only', 'workspace-write', 'danger-full-access'].includes(value)) throw invalid(); sandbox = value;
      } else {
        if (approvalPolicy !== undefined || !['never', 'on-request', 'on-failure', 'untrusted'].includes(value)) throw invalid(); approvalPolicy = value;
      }
      continue;
    }
    if (['-C', '--cd'].includes(arg)) {
      const directory = args[++index]; if (!directory || directory.startsWith('-')) throw invalid();
      cwd = fs.realpathSync(path.resolve(cwd, directory)); if (!fs.statSync(cwd).isDirectory()) throw invalid(); continue;
    }
    if (arg === 'resume' && !prompts.length && !sessionId) {
      sessionId = args[++index]; if (!UUID.test(sessionId || '')) throw invalid(); continue;
    }
    if (arg.startsWith('-') || ['fork', 'agents'].includes(arg) && !prompts.length) throw invalid();
    prompts.push(arg);
  }
  return { administrative: false, sessionId, ownerBypass, sandbox, approvalPolicy, cwd: fs.realpathSync(cwd), initialPrompt: prompts.length ? prompts.join(' ') : undefined };
}

/** Metadata only, using the configured native home/auth; never starts a thread or turn. */
export function readCodexTerminalConfig({ binary, cwd, env = process.env, signal, timeoutMs = 8000, spawnHost = spawn } = {}) {
  if (!path.isAbsolute(binary || '') || !path.isAbsolute(cwd || '') || signal?.aborted || timeoutMs <= 0) return Promise.reject(new Error('Native authority metadata unavailable'));
  return new Promise((resolve, reject) => {
    const child = spawnHost(binary, ['app-server', '--listen', 'stdio://'], { cwd, env: subscriptionEnvironment(env), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, settled = false, retiring = false, result, failure;
    const timer = setTimeout(() => finish(new Error('Native authority metadata deadline exceeded')), Math.min(8000, timeoutMs));
    let retirement;
    const complete = () => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(retirement); signal?.removeEventListener('abort', cancel);
      failure ? reject(failure) : resolve(result);
    };
    const finish = (error, value) => {
      if (retiring) return; retiring = true; failure = error; result = value; clearTimeout(timer);
      child.stdin.destroy(); child.kill(); retirement = setTimeout(() => { failure = new Error('Native authority metadata retirement unconfirmed'); complete(); }, 1000);
    };
    const cancel = () => finish(new Error('Native authority metadata cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', () => finish(new Error('Native authority metadata host unavailable')));
    child.stdin.on('error', () => finish(new Error('Native authority metadata input failed')));
    child.on('close', () => { if (!retiring) failure = new Error('Native authority metadata exited before proof'); complete(); });
    child.stderr.on('data', () => {});
    const send = packet => child.stdin.write(JSON.stringify(packet) + '\n');
    child.stdout.on('data', chunk => {
      if (retiring) return; bytes += chunk.length; buffer += chunk.toString();
      if (bytes > 1024 * 1024) return finish(new Error('Native authority metadata exceeded bound'));
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let row; try { row = JSON.parse(line); } catch { return finish(new Error('Native authority metadata malformed')); }
        if (row.id === 1) {
          if (row.error) return finish(new Error('Native authority initialization refused'));
          send({ method: 'initialized' }); send({ id: 2, method: 'config/read', params: { cwd, includeLayers: true } });
        } else if (row.id === 2) return finish(row.error ? new Error('Native effective authority refused') : null, row.result);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'rnb_terminal_authority', version: '1' }, capabilities: { experimentalApi: true } } });
  });
}

export function codexTerminalAuthority(effective, parsed) {
  const config = effective?.config;
  if (!canonicalCodexConfig(config) || !Array.isArray(effective.layers) || !config.projects || typeof config.projects !== 'object') throw new Error('Actual native authority facts unavailable');
  const approvalPolicy = parsed.approvalPolicy ?? config.approval_policy;
  if (approvalPolicy !== 'never') throw new Error('Controlled native exec cannot preserve this approval policy; refusing instead of changing it');
  const sandbox = parsed.sandbox ?? (parsed.ownerBypass ? 'danger-full-access' : config.sandbox_mode);
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) throw new Error('Native sandbox authority unavailable');
  const matching = Object.entries(config.projects).filter(([directory]) => path.isAbsolute(directory) && (parsed.cwd === directory || parsed.cwd.startsWith(directory + path.sep))).sort(([a], [b]) => b.length - a.length);
  const deniedProject = effective.layers.some(layer => {
    const directory = path.dirname(layer.name?.dotCodexFolder || '');
    return layer.name?.type === 'project' && layer.disabledReason != null && path.isAbsolute(directory)
      && (directory === parsed.cwd || parsed.cwd.startsWith(directory.endsWith(path.sep) ? directory : directory + path.sep));
  });
  const write = sandbox !== 'read-only' && config.permissions == null && config.default_permissions == null
    && matching[0]?.[1]?.trust_level === 'trusted' && !deniedProject;
  return { write, approvalPolicy, sandbox: write ? 'workspace-write' : 'read-only' };
}

/** Allocation is selected for every ordinary parent turn; native rollout evidence is authoritative. */
export async function runCodexManagedPrimaryTurn({ binary, prompt, decisionPrompt = prompt, sessionId, threadId, cwd = process.cwd(),
  env = process.env, readOnly = true, signal, timeoutMs = 900000, decide = decideNativeTurn,
  verifyDecision = validateDispatchDecision, executeNative = executeCodexWorkflowWorker, receipt = appendGatewayReceipt,
  output = () => {}, approvalPolicy = 'never', monotonic = () => performance.now() } = {}) {
  if (!path.isAbsolute(binary || '') || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000 ||
    /^\s*\//.test(prompt) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 900000 || signal?.aborted) throw invalid();
  const id = sessionId ?? threadId;
  if (id !== undefined && !UUID.test(id)) throw invalid();
  const limit = monotonic() + timeoutMs;
  const live = () => { if (signal?.aborted || monotonic() >= limit) throw new Error('Controlled Codex cancelled or absolute deadline exceeded'); };
  const clean = subscriptionEnvironment(env);
  const decision = await decide(decisionPrompt, 'codex', { env: clean });
  live(); verifyDecision(decision); live();
  const result = await executeNative({ binary, decision, prompt, cwd, readOnly, signal, timeoutMs: Math.max(1, limit - monotonic()),
    env: { ...clean, RNB_TERMINAL_LAUNCH_ACTIVE: '1' }, sessionId: id, approvalPolicy });
  live();
  if (result?.completed !== true || result.modelObserved !== true || result.effortSettingsObserved !== true ||
    result.model !== decision.model || result.effort !== decision.effort || !UUID.test(result.sessionId || '') ||
    id !== undefined && result.sessionId !== id) throw new Error('Controlled Codex native model, effort or parent session unproven');
  verifyDecision(decision); live();
  receipt({ ts: new Date().toISOString(), harness: 'codex', status: result.completed === true ? 'completed' : 'failed', model: result.model, effort: result.effort,
    taskClass: decision.taskClass, modelObserved: true, serviceMode: 'standard',
    evidence: 'native turn_context model/effort and exact parent session observed; recursive native agents disabled' }, { env: clean });
  if (result.answer) output(result.answer);
  return { ...result, decision };
}

async function administrative(binary, args, env, cwd, signalSource, spawnNative) {
  const child = spawnNative(binary, args, { cwd, env: { ...subscriptionEnvironment(env), RNB_TERMINAL_LAUNCH_ACTIVE: '1' }, shell: false, stdio: 'inherit' });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { try { child.kill(signal); } catch {} }]));
  handlers.forEach((handler, signal) => signalSource.on(signal, handler));
  try {
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  } finally { handlers.forEach((handler, signal) => signalSource.removeListener(signal, handler)); }
}

export async function launchCodexManagedTerminal({ binary, args = [], input = process.stdin, output = process.stdout,
  diagnostics = process.stderr, cwd = process.cwd(), env = process.env, signalSource = process,
  primaryTurn = runCodexManagedPrimaryTurn, managedPrompt = runManagedPrompt, readConfig = readCodexTerminalConfig, spawnNative = spawn } = {}) {
  if (env.RNB_TERMINAL_LAUNCH_ACTIVE) throw new Error('Controlled Codex recursive terminal invocation refused');
  if (!path.isAbsolute(binary || '')) throw new Error('Absolute native Codex binary required');
  const parsed = parseCodexManagedArguments(args, cwd);
  if (parsed.administrative) return administrative(binary, args, env, parsed.cwd, signalSource, spawnNative);
  if (!input.isTTY || !output.isTTY) throw new Error('Controlled Codex requires a person at a terminal');
  let sessionId = parsed.sessionId, resume = Boolean(sessionId), initialPrompt = parsed.initialPrompt;
  const terminal = createManagedTerminal({ input, output }), controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.on('SIGINT', cancel);
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) signalSource.on(name, cancel);
  diagnostics.write('Controlled Codex: native exec/resume with automatic managed workflows; native TUI and recursive agents unavailable. /exit closes.\n');
  if (parsed.ownerBypass) diagnostics.write('Explicit owner bypass authorizes guarded workspace writes; unrestricted native sandbox bypass is not forwarded.\n');
  try {
    while (!controller.signal.aborted) {
      const prompt = initialPrompt ?? await terminal.question('Codex> ', { signal: controller.signal }); initialPrompt = undefined;
      if (prompt.trim() === '/exit') break;
      if (!prompt.trim()) continue;
      const effective = await readConfig({ binary, cwd: parsed.cwd, env, signal: controller.signal });
      const authority = codexTerminalAuthority(effective, parsed);
      const turn = await managedPrompt({ binary, originalPrompt: prompt, harness: 'codex', projectRoot: parsed.cwd,
        nativeContext: { sessionId, resume }, permissions: { apiBilling: false, write: authority.write },
        primaryTurn, readOnly: true, approvalPolicy: authority.approvalPolicy, cwd: parsed.cwd, env, signal: controller.signal,
        output: text => output.write(String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') + '\n') });
      if (!UUID.test(turn?.sessionId || '')) throw new Error('Controlled Codex parent session unproven');
      sessionId = turn.sessionId; resume = true;
      const reviewer = turn.managedWorkflow?.executions?.find(item => item.workerId === 'independent-review');
      const safe = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
      if (turn.modelObserved === true && turn.model && turn.effort) diagnostics.write(`Completed by ${safe(turn.model)} · ${safe(turn.effort)}${reviewer ? `; review ${safe(reviewer.observedModel)} · ${safe(reviewer.observedEffort)}` : ''}\n`);
      diagnostics.write(`Native session: ${sessionId} (resume with resume ${sessionId})\n`);
    }
    return { code: 0, signal: null, sessionId };
  } finally { controller.abort(); terminal.close(); for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) signalSource.removeListener(name, cancel); }
}

// Canonical launcher API name; the controlled implementation is shared.
export const launchManagedCodexTerminal = launchCodexManagedTerminal;
