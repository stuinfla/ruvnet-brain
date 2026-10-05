import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { subscriptionOnlyEnv } from './subscription-hosts.mjs';

export function grokSubscriptionEnv(parent = process.env) {
  const env = subscriptionOnlyEnv(parent);
  for (const key of ['GROK_API_KEY', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_OIDC_ISSUER',
    'GROK_OIDC_CLIENT_ID', 'GROK_MODELS_BASE_URL', 'GROK_MODELS_LIST_URL',
    'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_XAI_API_BASE_URL', 'GROK_WS_URL', 'GROK_WS_ORIGIN']) delete env[key];
  env.GROK_DISABLE_API_KEY_AUTH = '1';
  // Background ACP workers have no dictation UI. The installed native hook
  // wrapper explicitly supports this override and skips nonexecutable paths.
  // Without it, superwhisper's Stop agent-hook blocks native prompt completion.
  // This child-only setting leaves the interactive app and hook file untouched.
  env.SUPERWHISPER_GROK_HOOK = '/dev/null';
  return env;
}

// These provider fields are admission evidence, not an atomic credit reservation.
export function grokBillingReceipt(auth, billing, topup) {
  const meta = auth?._meta ?? auth?.meta;
  const config = billing?.config;
  const subscription = typeof meta?.subscription_tier === 'string' && meta.subscription_tier.length > 0;
  const included = meta?.auth_mode === 'Oidc' && meta?.backend_billed === false
    && meta?.gate === null && subscription && auth?.authenticated !== false;
  const zero = config?.onDemandCap?.val === 0 && config?.onDemandUsed?.val === 0
    && config?.prepaidBalance?.val === 0;
  // Official pager effects/helpers.rs: a successful empty response means no
  // rule and maps to AutoTopupInfo::disabled; proto3 also omits enabled=false.
  // Never normalize failed requests, raw bodies or malformed shapes to false.
  const validTopup = topup && typeof topup === 'object' && !Array.isArray(topup)
    && Object.keys(topup).every((key) => key === 'rule');
  const disabledTopup = validTopup && (topup.rule == null || (
    typeof topup.rule === 'object' && !Array.isArray(topup.rule)
    && (topup.rule.enabled === false || !Object.hasOwn(topup.rule, 'enabled'))));
  return {
    eligible: Boolean(included && zero && disabledTopup && billing?.subscription_tier === meta.subscription_tier),
    auth: included ? 'grok-oidc-subscription' : 'unknown-or-metered',
    plan: meta?.subscription_tier ?? null,
    backendBilled: meta?.backend_billed ?? null,
    onDemandCap: config?.onDemandCap?.val ?? null,
    onDemandUsed: config?.onDemandUsed?.val ?? null,
    prepaidBalance: config?.prepaidBalance?.val ?? null,
    autoTopupDisabled: Boolean(disabledTopup),
    period: config?.currentPeriod ?? null,
    reason: included && zero && disabledTopup ? 'Native subscription, zero paid-credit sources and disabled auto top-up verified'
      : 'Included subscription, zero paid-credit sources or disabled auto top-up not verified',
    atomicReservation: false,
    concurrentAccountChangesSupported: false,
  };
}

function identity(auth) {
  const meta = auth?._meta ?? auth?.meta;
  if (typeof meta?.email !== 'string' || !meta.email) throw new Error('Native Grok account identity unavailable');
  return createHash('sha256').update(JSON.stringify([meta.email, meta.team_id, meta.is_team_principal])).digest('hex');
}

export function grokModelReceipt(state) {
  return (state?.availableModels ?? []).map((m) => ({
    model: m.modelId, name: m.name, contextWindow: m._meta?.totalContextTokens ?? null,
    contextWindows: m._meta?.contextWindows ?? [],
    efforts: (m._meta?.reasoningEfforts ?? []).map((e) => e.value ?? e.id),
    effort: m._meta?.reasoningEffort ?? null,
  }));
}

function runBudget({ timeoutMs = 30_000, signal } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Positive Grok deadline required');
  const deadline = performance.now() + timeoutMs;
  const check = () => {
    if (signal?.aborted) throw new Error('Grok execution aborted');
    if (performance.now() >= deadline) throw new Error('Grok native deadline exceeded');
  };
  return { signal, check, remaining: () => { check(); return Math.max(1, Math.ceil(deadline - performance.now())); } };
}

// Python's isolated stdlib parser handles quoted, dotted, inline and escaped
// TOML keys. Missing Python 3.11+ or malformed TOML denies execution; no config
// values or parser errors (which can contain credentials) leave this process.
const TOML_POLICY = `import json,sys,tomllib
blocked=set("api_key env_key auth_provider auth_provider_command models_base_url models_list_url cli_chat_proxy_base_url xai_api_base_url grok_ws_url grok_ws_origin base_url preferred_method".split())
def unsafe(value):
 if isinstance(value,dict): return any(key in blocked or unsafe(item) for key,item in value.items())
 if isinstance(value,list): return any(unsafe(item) for item in value)
 return False
try:
 parsed=tomllib.loads(sys.stdin.read())
 print(json.dumps({"unsafe":unsafe(parsed)}))
except Exception:
 sys.exit(1)
`;

export function verifyGrokConfig({ binary, cwd, env, run = spawnSync, parseRun = spawnSync,
  read = fs.readFileSync, budget = runBudget() }) {
  budget.check();
  const result = run(binary, ['inspect', '--json'], { cwd, env, encoding: 'utf8',
    timeout: Math.min(15_000, budget.remaining()), killSignal: 'SIGKILL' });
  budget.check();
  if (result.status !== 0) throw new Error('Grok configuration inspection failed');
  let inspection;
  try { inspection = JSON.parse(result.stdout); } catch { throw new Error('Grok configuration inspection is invalid'); }
  if (inspection.loginPolicy?.apiKeyAuthDisabled !== true) throw new Error('Grok API-key prohibition not active');
  const layers = inspection.configSources?.layers;
  if (!Array.isArray(layers)) throw new Error('Grok configuration sources not verified');
  for (const layer of layers) {
    budget.check();
    if (!path.isAbsolute(layer.path ?? '')) throw new Error('Grok config source is not inspectable');
    const input = read(layer.path, 'utf8');
    const parsed = parseRun('python3', ['-I', '-c', TOML_POLICY], { env, input,
      encoding: 'utf8', timeout: Math.min(5_000, budget.remaining()), killSignal: 'SIGKILL', maxBuffer: 4096 });
    budget.check();
    if (parsed.status !== 0) throw new Error('Trusted Grok TOML inspection unavailable or invalid');
    let policy;
    try { policy = JSON.parse(parsed.stdout); } catch { throw new Error('Trusted Grok TOML inspection invalid'); }
    if (policy?.unsafe !== false) throw new Error('Custom Grok credential or endpoint configuration is unsupported for subscription routing');
  }
  return { apiKeyAuthDisabled: true, configSourcesChecked: layers.length };
}

class GrokAcp {
  constructor({ binary, cwd, env, budget, retirementMs = 2_000, launch = spawn }) {
    budget.check();
    if (!Number.isFinite(retirementMs) || retirementMs <= 0 || retirementMs > 2_000) {
      throw new Error('Grok retirement bound must be within 2000ms');
    }
    this.budget = budget; this.retirementMs = retirementMs;
    this.pending = new Map(); this.id = 0; this.buffer = ''; this.closed = false;
    this.child = launch(binary, ['agent', '--no-leader', 'stdio'], {
      cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.retired = new Promise((resolve) => { this.confirmRetired = resolve; });
    this.child.stdout.on('data', (data) => this.receive(data.toString()));
    // Native stderr may include account identity, config and prompts; never forward it.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on?.('error', () => this.fail(new Error('Grok native request delivery failed')));
    this.child.on('error', () => {
      if (!this.child.pid) this.confirmRetired();
      this.fail(new Error('Grok native process could not start'));
    });
    this.child.once('close', () => this.confirmRetired());
    this.child.on('exit', () => this.fail(new Error('Grok native process exited')));
    this.abort = () => this.fail(new Error('Grok execution aborted'));
    budget.signal?.addEventListener('abort', this.abort, { once: true });
    try { this.timer = setTimeout(() => this.fail(new Error('Grok native deadline exceeded')), budget.remaining()); }
    catch (error) { this.fail(error); }
    if (budget.signal?.aborted) this.abort();
  }
  fail(error) {
    this.failure ??= error;
    for (const p of this.pending.values()) p.reject(this.failure);
    this.pending.clear();
    void this.close().catch(() => {});
  }
  receive(data) {
    if (this.closed) return;
    try { this.budget.check(); } catch (error) { return this.fail(error); }
    this.buffer += data;
    if (this.buffer.length > 16 * 1024 * 1024) return this.fail(new Error('Grok protocol line exceeds bound'));
    let end;
    while (!this.closed && (end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let message;
      try { this.budget.check(); message = JSON.parse(line); } catch (error) {
        return this.fail(error.message.includes('Grok') ? error : new Error('Grok native protocol is invalid'));
      }
      if (message.method && message.id !== undefined) {
        const reply = message.method === 'session/request_permission'
          ? { result: { outcome: { outcome: 'cancelled' } } }
          : { error: { code: -32601, message: 'Client capability unavailable' } };
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })}\n`);
      } else if (this.pending.has(message.id)) {
        const p = this.pending.get(message.id); this.pending.delete(message.id);
        message.error ? p.reject(new Error(`Grok rejected ${p.method}`)) : p.resolve(message.result);
      } else this.onNotification?.(message);
    }
  }
  request(method, params) {
    try { this.budget.check(); } catch (error) { this.fail(error); return Promise.reject(error); }
    if (this.closed) return Promise.reject(this.failure ?? new Error('Grok native connection is closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
      catch { this.fail(new Error('Grok native request delivery failed')); }
    });
  }
  close() {
    if (this.retirement) return this.retirement;
    let cleanupFailed = false;
    const safely = (action) => { try { action(); } catch { cleanupFailed = true; } };
    this.closed = true;
    safely(() => clearTimeout(this.timer));
    safely(() => this.budget.signal?.removeEventListener('abort', this.abort));
    for (const p of this.pending.values()) safely(() => p.reject(
      this.failure ?? new Error('Grok native connection is closed')));
    this.pending.clear();
    this.retirement = (async () => {
      let timer;
      const bounded = new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new Error('Grok native process retirement not confirmed');
        error.retirementUnconfirmed = true;
        reject(error);
      }, this.retirementMs); });
      try {
        await Promise.race([this.retired, bounded]);
        if (cleanupFailed) throw new Error('Grok native cleanup failed');
      } catch (error) {
        // An unconfirmed process must not retain the controller's event loop.
        // Unref does not claim the process exited or turn failure into success.
        safely(() => this.child.unref?.());
        for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) safely(() => pipe.unref?.());
        throw error;
      } finally { safely(() => clearTimeout(timer)); }
    })();
    // Observe immediately even if cleanup hooks throw or close is called from
    // an event handler. Every caller still awaits this same rejecting promise.
    void this.retirement.catch(() => {});
    // --no-leader creates an owned process group, never a shared user leader.
    let signalled = false;
    if (process.platform !== 'win32' && Number.isInteger(this.child.pid)) {
      try { process.kill(-this.child.pid, 'SIGKILL'); signalled = true; } catch { /* Fall back to owned child. */ }
    }
    if (!signalled) safely(() => this.child.kill('SIGKILL'));
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) safely(() => pipe.destroy?.());
    return this.retirement;
  }
}

async function connect(options, budget) {
  budget.check();
  const cwd = options.cwd ?? process.cwd();
  if (!path.isAbsolute(cwd)) throw new Error('Absolute Grok working directory required');
  const binary = options.binary ?? path.join(os.homedir(), '.grok/bin/grok');
  const env = grokSubscriptionEnv(options.env ?? process.env);
  const config = verifyGrokConfig({ binary, cwd, env, run: options.run, parseRun: options.parseRun, read: options.read, budget });
  await yieldImmediate(); // Deliver cancellation queued while synchronous inspection ran.
  budget.check();
  const client = new GrokAcp({ ...options, binary, cwd, env, budget });
  try {
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'ruvnet-subscription-router', version: '1' } });
    if (!init.authMethods?.some((m) => m.id === 'cached_token')) throw new Error('Native Grok cached OAuth login unavailable');
    const auth = await client.request('authenticate', { methodId: 'cached_token' });
    const billing = await client.request('_x.ai/billing', {});
    const topup = await client.request('_x.ai/auto-topup-rule', {});
    const receipt = grokBillingReceipt(auth, billing, topup);
    return { client, init, receipt, config, cwd, accountIdentity: identity(auth) };
  } catch (error) { await client.close(); throw error; }
}

export async function probeGrokSubscriptionNative(options = {}) {
  let client;
  try {
    const budget = runBudget(options);
    const connected = await connect(options, budget); client = connected.client;
    await client.close(); budget.check();
    return { host: 'grok', ...connected.receipt, eligibilityScope: 'subscription-billing-preflight',
      nativeVersion: connected.init._meta?.agentVersion ?? null,
      config: connected.config, models: grokModelReceipt(connected.init._meta?.modelState),
      checkedAt: new Date().toISOString(), inferenceTested: false };
  } catch (error) {
    return { host: 'grok', eligible: false, auth: 'unknown', reason: error.message, inferenceTested: false };
  } finally { await client?.close().catch(() => {}); }
}

export async function executeGrokSubscription(options = {}) {
  if (typeof options.prompt !== 'string' || !options.prompt.trim()) throw new Error('Grok prompt required');
  if (!options.model || !options.effort) throw new Error('Explicit Grok model and effort required');
  if (options.workerThreads !== undefined && options.workerThreads !== 1) throw new Error('Grok worker-thread limits unsupported');
  const budget = runBudget(options);
  budget.check();
  const { client, init, receipt, config, cwd, accountIdentity } = await connect(options, budget);
  try {
    if (!receipt.eligible) throw new Error(receipt.reason);
    let models = grokModelReceipt(init._meta?.modelState);
    const text = []; let notificationFailure; let collectAssistant = false;
    client.onNotification = (message) => {
      if (message.method === '_x.ai/models/update') models = grokModelReceipt(message.params);
      if (message.method === '_x.ai/settings/update' && message.params?.allow_access === false) {
        notificationFailure = new Error('Grok subscription access withdrawn'); client.fail(notificationFailure);
      }
      if (/^_x\.ai\/billing(?:\/|$)/.test(message.method ?? '') && (
        message.params?.config?.onDemandCap?.val !== 0 || message.params?.config?.onDemandUsed?.val !== 0
        || message.params?.config?.prepaidBalance?.val !== 0)) {
        notificationFailure = new Error('Grok paid-credit state changed'); client.fail(notificationFailure);
      }
      if (message.method === '_x.ai/auto-topup-rule' && message.params?.rule?.enabled !== false) {
        notificationFailure = new Error('Grok auto top-up state changed'); client.fail(notificationFailure);
      }
      if (collectAssistant && message.method === 'session/update' && message.params?.update?.sessionUpdate === 'agent_message_chunk') {
        const content = message.params.update.content;
        if (content?.type === 'text') text.push(content.text);
      }
    };
    let fork;
    let session;
    if (options.parentSessionId) {
      if (!path.isAbsolute(options.parentCwd ?? '')) throw new Error('Native Grok fork requires absolute parentCwd');
      fork = await client.request('_x.ai/session/fork', { sourceSessionId: options.parentSessionId,
        sourceCwd: options.parentCwd, newCwd: cwd });
      if (fork.parentSessionId !== options.parentSessionId || !fork.newSessionId) throw new Error('Native Grok fork lineage not verified');
      session = { ...await client.request('session/load', { sessionId: fork.newSessionId, cwd, mcpServers: [] }),
        sessionId: fork.newSessionId };
    } else session = await client.request('session/new', { cwd, mcpServers: [] });
    models = grokModelReceipt(session.models ?? init._meta?.modelState);
    const selected = models.find((m) => m.model === options.model);
    if (!selected || !selected.efforts.includes(options.effort)) throw new Error('Requested Grok model or effort absent from native catalog');
    if (options.contextWindow !== undefined && options.contextWindow !== selected.contextWindow) {
      throw new Error('Native Grok ACP cannot set requested context window; refusing substitution');
    }
    let controls = await client.request('session/set_config_option', {
      sessionId: session.sessionId, configId: 'model', value: options.model });
    controls = await client.request('session/set_config_option', {
      sessionId: session.sessionId, configId: 'reasoning_effort', value: options.effort });
    const actual = Object.fromEntries((controls.configOptions ?? []).map((c) => [c.id, c.currentValue]));
    if (actual.model !== options.model || actual.reasoning_effort !== options.effort) throw new Error('Native Grok model/effort receipt mismatch');
    const beforeAuth = await client.request('_x.ai/auth/check_subscription', {});
    if (identity(beforeAuth) !== accountIdentity) throw new Error('Native Grok account changed before execution');
    const before = grokBillingReceipt(beforeAuth, await client.request('_x.ai/billing', {}),
      await client.request('_x.ai/auto-topup-rule', {}));
    if (!before.eligible) throw new Error(before.reason);
    // session/load replays the parent's history; only the dispatched turn is
    // execution output. Never return old assistant messages as a new answer.
    collectAssistant = true;
    const result = await client.request('session/prompt', { sessionId: session.sessionId,
      prompt: [{ type: 'text', text: options.prompt }] });
    collectAssistant = false;
    const afterAuth = await client.request('_x.ai/auth/check_subscription', {});
    if (identity(afterAuth) !== accountIdentity) throw new Error('Native Grok account changed during execution');
    const after = grokBillingReceipt(afterAuth, await client.request('_x.ai/billing', {}),
      await client.request('_x.ai/auto-topup-rule', {}));
    if (notificationFailure || !after.eligible) throw new Error('Grok billing/access state changed during execution');
    return { host: 'grok', sessionId: session.sessionId, model: actual.model,
      effort: actual.reasoning_effort, contextWindow: selected.contextWindow,
      fork: fork ? { parentSessionId: fork.parentSessionId, newSessionId: fork.newSessionId,
        chatMessagesCopied: fork.chatMessagesCopied } : null,
      output: text.join(''), stopReason: result.stopReason, completed: result.stopReason === 'end_turn', config,
      subscription: { before, after }, nativeVersion: init._meta?.agentVersion ?? null,
      workerThreadLimitEnforced: false, permissionRequests: 'deny',
      desktopDictationHook: 'suppressed-in-background-worker',
      inferenceTested: true, checkedAt: new Date().toISOString() };
  } finally { await client.close(); budget.check(); }
}
