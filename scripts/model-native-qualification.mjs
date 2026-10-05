// Native subscription qualification: fixed plaintext tasks, never candidate code execution.
// Protocol sequence derives from the source-bound native gateway acceptance probe.
// Configuration identity is observable; provider/backend identity is never proved here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { assertSubscriptionAuth, subscriptionEnvironment } from './model-router-dispatch.mjs';
import { discoverNativeCodex } from './model-routing-launchers.mjs';

const SELF = fileURLToPath(import.meta.url);
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ID = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const redact = (key, value) => /^(?:email|account_id|access_token|refresh_token|id_token|api_key|authorization|credentials)$/i.test(key) ? '[redacted]' : value;

function binaryFor(host) {
  const extensions = path.join(os.homedir(), '.vscode-server/extensions');
  if (host === 'codex') return discoverNativeCodex(extensions);
  const entries = JSON.parse(fs.readFileSync(path.join(extensions, 'extensions.json')));
  const entry = entries.find((e) => e.identifier?.id === 'anthropic.claude-code');
  if (!entry) throw new Error('Native Claude extension unavailable');
  return path.join(entry.location.path, 'resources/native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
}

export function verifyClaudeAllowance(usage, model) {
  // Native 2.1.289 get_usage is explicitly experimental. Unknown shapes fail closed.
  if (usage?.rate_limits_available !== true || usage.rate_limits?.extra_usage?.is_enabled !== false) throw new Error('Native Claude allowance unknown or extra usage enabled');
  const limits = usage.rate_limits;
  for (const key of ['five_hour', 'seven_day']) {
    const window = limits[key];
    if (!window || !Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization >= 100 || window.locked_reason !== null) throw new Error('Native Claude ordinary allowance unavailable');
  }
  for (const scoped of limits.model_scoped || []) {
    if (!Number.isFinite(scoped.utilization) || scoped.utilization < 0 || scoped.utilization >= 100 || scoped.locked_reason != null) throw new Error('Native Claude scoped allowance unavailable or unmapped');
  }
  for (const limit of limits.limits || []) {
    if (!Number.isFinite(limit.percent) || limit.percent < 0 || limit.percent >= 100 || !['normal', 'warning'].includes(limit.severity)) throw new Error('Native Claude allowance unavailable or unknown');
  }
  return { verified: true, basis: 'native-get_usage-2.1.289', checkedAt: new Date().toISOString(), reservation: false, raceSafe: false, model };
}

class Transport {
  constructor(child, host, fail, transcript, signal) {
    this.child = child; this.host = host; this.fail = fail; this.transcript = transcript;
    this.pending = new Map(); this.events = []; this.waiters = []; this.serial = 0; this.buffer = ''; this.bytes = 0; this.decoder = new StringDecoder('utf8');
    child.stderr.on('data', () => {}); child.stdin.on('error', () => fail(new Error('Native input transport failed')));
    child.once('error', () => fail(new Error('Native executable unavailable')));
    child.once('exit', () => { if (!signal.aborted) fail(new Error('Native host exited before qualification')); });
    child.stdout.on('data', (chunk) => {
      this.bytes += chunk.length; if (this.bytes > 512 * 1024) return fail(new Error('Native transcript exceeded bound'));
      this.buffer += this.decoder.write(chunk);
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { return fail(new Error('Malformed native protocol output')); }
        transcript.push({ direction: 'native', packet: message });
        const id = host === 'codex' ? message.id : message.type === 'control_response' ? message.response?.request_id : null;
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          if (message.error || (host === 'claude-code' && message.response.subtype !== 'success')) pending.reject(new Error('Native request refused'));
          else pending.resolve(host === 'codex' ? message.result : message.response.response);
        } else {
          // No native tool/approval request is ever serviced by this adapter.
          const tool = host === 'codex' ? Object.hasOwn(message, 'id') && Boolean(message.method)
            : message.type === 'control_request' || message.message?.content?.some((p) => p.type === 'tool_use');
          const item = message.params?.item;
          if (tool || (item?.type && !['agentMessage', 'reasoning', 'userMessage'].includes(item.type))) return fail(new Error('Native tool inference refused'));
          this.events.push(message);
          for (const waiter of [...this.waiters]) if (waiter.predicate(message)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(message); }
        }
      }
    });
  }
  send(packet) { this.transcript.push({ direction: 'client', packet }); this.child.stdin.write(`${JSON.stringify(packet)}\n`); }
  request(method, params = {}) {
    const id = `qualification-${++this.serial}`;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send(this.host === 'codex' ? { id, method, params } : { type: 'control_request', request_id: id, request: { subtype: method, ...params } });
    return promise;
  }
  wait(predicate, start = 0) {
    const existing = this.events.slice(start).find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }
}

async function run(options, inspectOnly) {
  const { host, model, effort, prompt, cwd, env = process.env, deadline = Date.now() + 60000,
    spawnHost = spawn, versionProbe = execFileSync, authCheck = assertSubscriptionAuth, now = Date.now } = options;
  const started = now(); const transcript = []; let child, transport;
  const result = { completed: false, output: '', nativeModel: null, nativeEffort: null, identityBasis: null,
    backendIdentityProved: false, nativeSubscription: false, available: false, supported: false, models: [],
    harnessVersion: null, elapsedMs: 0, nativeSessionId: null, nativeTurnId: null, sourceReceipt: {
      schemaVersion: 1, kind: 'native-model-qualification', host, backendIdentityProved: false,
      adapterSha256: digest(fs.readFileSync(SELF)), nativeSettings: {}, nativeTurn: null,
      request: inspectOnly ? null : { model, effort, promptSha256: digest(String(prompt)) }, transcriptRedactions: ['account/auth identifying fields'],
    } };
  const controller = new AbortController(); let abortError;
  const fail = (error) => { if (!controller.signal.aborted) { abortError = error; controller.abort(); } };
  const remaining = () => { const ms = deadline - now(); if (ms <= 0) throw new Error('Shared native qualification deadline exhausted'); return ms; };
  const bounded = (promise) => new Promise((resolve, reject) => {
    if (controller.signal.aborted) return reject(abortError);
    const stop = () => reject(abortError); controller.signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stop));
  });
  let timer;
  try {
    if (!['codex', 'claude-code'].includes(host) || !Number.isFinite(deadline)) throw new Error('Supported native host and absolute deadline required');
    remaining(); timer = setTimeout(() => fail(new Error('Shared native qualification deadline exhausted')), remaining());
    if (!inspectOnly && (!ID.test(model || '') || !EFFORTS.has(effort) || typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 16384 || !path.isAbsolute(cwd || ''))) throw new Error('Static model/effort, bounded plaintext prompt and absolute sandbox cwd required');
    const binary = fs.realpathSync(options.binary || binaryFor(host));
    result.sourceReceipt.binary = binary;
    // Exact native executable bytes, without retaining executable or credentials in the receipt.
    const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(binary);
    const stopHash = () => stream.destroy(abortError);
    controller.signal.addEventListener('abort', stopHash, { once: true });
    try { await bounded(new Promise((resolve, reject) => { stream.on('data', (bytes) => { try { remaining(); hash.update(bytes); } catch (e) { stream.destroy(e); } }); stream.once('error', reject); stream.once('end', resolve); })); }
    finally { controller.signal.removeEventListener('abort', stopHash); }
    result.sourceReceipt.nativeBinarySha256 = hash.digest('hex');
    const clean = subscriptionEnvironment(env);
    result.harnessVersion = String(versionProbe(binary, ['--version'], { env: clean, encoding: 'utf8', timeout: remaining(), stdio: ['ignore', 'pipe', 'pipe'] })).trim().slice(0, 128);
    await bounded(authCheck(host, { env: clean, probe: (_command, args, opts) => versionProbe(binary, args, { ...opts, timeout: remaining() }) }));
    result.nativeSubscription = true;
    const args = host === 'codex' ? ['app-server', '--strict-config', '-c', 'model_provider="openai"', '-c', 'service_tier="default"', '-c', 'features.fast_mode=false',
      '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.code_mode=false', '-c', 'features.code_mode_host=false', '-c', 'features.multi_agent=false', '-c', 'features.plugins=false', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}']
      : ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--tools', '', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '--no-session-persistence'];
    remaining(); child = spawnHost(binary, args, { env: clean, cwd: cwd || os.tmpdir(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    transport = new Transport(child, host, fail, transcript, controller.signal);
    const metadata = (promise) => {
      const timeout = setTimeout(() => fail(new Error(`Native metadata timeout: ${result.sourceReceipt.stage}`)), Math.min(10000, remaining()));
      return bounded(promise).finally(() => clearTimeout(timeout));
    };
    const request = (...params) => { result.sourceReceipt.stage = params[0]; return metadata(transport.request(...params)); };
    if (host === 'codex') {
      await request('initialize', { clientInfo: { name: 'native_model_qualification', version: '1' }, capabilities: { experimentalApi: true } }); transport.send({ method: 'initialized' });
      const account = await request('account/read', { refreshToken: false });
      if (account?.account?.type !== 'chatgpt') throw new Error('Native same-process subscription account unavailable');
      const allowance = await request('account/rateLimits/read', { excludeResetCreditDetails: true, supportsLunaReserve: false });
      if (allowance?.ordinaryUsageAllowed !== true) throw new Error('Native ordinary subscription allowance unavailable');
      result.sourceReceipt.allowance = { verified: true, basis: 'native-account/rateLimits/read', reservation: false, raceSafe: false };
      let cursor;
      do {
        const catalog = await request('model/list', { ...(cursor ? { cursor } : {}), includeHidden: true });
        if (!Array.isArray(catalog?.data)) throw new Error('Native model catalog unavailable');
        result.models.push(...catalog.data.map((m) => ({ id: m.model, efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort), inputModalities: m.inputModalities })));
        cursor = catalog.nextCursor;
        if (result.models.length > 1000) throw new Error('Native catalog exceeded bound');
      } while (cursor);
      result.available = true; result.catalogStatus = 'verified';
      if (!inspectOnly) {
        if (!result.models.some((m) => m.id === model && m.efforts.includes(effort))) throw new Error('Native model/effort unsupported');
        result.supported = true;
        const thread = await request('thread/start', { cwd, model, modelProvider: 'openai', serviceTier: 'default', sandbox: 'read-only', approvalPolicy: 'untrusted', ephemeral: true, environments: [], dynamicTools: [],
          developerInstructions: 'Qualification: plaintext answer only. Never use tools, read files, execute code, or delegate.' });
        const threadId = thread?.thread?.id; if (!threadId) throw new Error('Native thread identity missing');
        result.nativeSessionId = threadId;
        const settings = async (params) => {
          const start = transport.events.length;
          await request('thread/settings/update', { threadId, ...params });
          result.sourceReceipt.stage = 'thread/settings/updated';
          const event = await metadata(transport.wait((m) => m.method === 'thread/settings/updated' && m.params?.threadId === threadId, start));
          const s = event.params.threadSettings;
          if (s?.model !== model || s.effort !== effort || s.modelProvider !== 'openai' || s.serviceTier !== 'default') throw new Error('Native configured model/effort/provider mismatch');
          return { model: s.model, effort: s.effort, provider: s.modelProvider, serviceTier: s.serviceTier, threadId };
        };
        result.sourceReceipt.nativeSettings.before = await settings({ model, effort, serviceTier: 'default' });
        const accepted = await request('turn/start', { threadId, model, effort, serviceTier: 'default', input: [{ type: 'text', text: prompt }] });
        const turnId = accepted?.turn?.id; if (!turnId) throw new Error('Native turn identity missing');
        result.sourceReceipt.stage = 'turn/completed';
        const end = await bounded(transport.wait((m) => m.method === 'turn/completed' && m.params?.threadId === threadId && m.params?.turn?.id === turnId));
        if (end.params.turn.status !== 'completed') throw new Error('Native turn did not complete');
        const items = transport.events.filter((m) => m.method === 'item/completed' && m.params?.threadId === threadId && m.params?.turnId === turnId);
        result.output = items.filter((m) => m.params.item?.type === 'agentMessage').map((m) => m.params.item.text || '').join('\n');
        result.nativeTurnId = turnId;
        // Native same-value updates emit no notification. Read actual live thread
        // metadata after completion; never infer settings from a no-op acknowledgment.
        const observed = (await request('thread/read', { threadId, includeTurns: false }))?.thread;
        if (observed?.id !== threadId || observed.model !== model || observed.reasoningEffort !== effort || observed.modelProvider !== 'openai') throw new Error('Native completed thread model/effort/provider mismatch');
        result.sourceReceipt.nativeSettings.after = { model: observed.model, effort: observed.reasoningEffort, provider: observed.modelProvider, threadId, basis: 'native-thread/read' };
        if (Object.hasOwn(observed, 'serviceTier')) {
          if (observed.serviceTier !== 'default') throw new Error('Native completed thread service tier mismatch');
          result.sourceReceipt.nativeSettings.after.serviceTier = observed.serviceTier;
          result.sourceReceipt.nativeSettings.after.serviceTierBasis = 'native-thread/read';
        } else result.sourceReceipt.nativeSettings.after.serviceTierBasis = 'pre-turn-native-settings-and-fixed-host-configuration';
      }
    } else {
      if (!/^2\.1\.289 \(Claude Code\)$/.test(result.harnessVersion)) throw new Error('Experimental Claude allowance contract version unsupported');
      const initialized = await request('initialize');
      if (initialized?.session_state !== 'idle') throw new Error('Native Claude session not idle');
      result.sourceReceipt.allowance = verifyClaudeAllowance(await request('get_usage', { skip_behaviors: true }), model);
      // Native initialize.models is the extension's supportedModels() source.
      result.catalogStatus = Array.isArray(initialized.models) ? 'verified' : 'unknown';
      for (const m of initialized.models || []) {
        if (typeof m.resolvedModel !== 'string') throw new Error('Native Claude model catalog malformed');
        if (!result.models.some((entry) => entry.id === m.resolvedModel)) result.models.push({ id: m.resolvedModel,
          efforts: m.supportsEffort === true && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e) => EFFORTS.has(e)) : [] });
      }
      result.available = true;
      if (!inspectOnly) {
        if (!result.models.some((m) => m.id === model && m.efforts.includes(effort))) throw new Error('Native Claude model/effort unsupported or unknown');
        await request('apply_flag_settings', { settings: { model, effortLevel: effort } });
        const settings = async () => {
          const observed = (await request('get_settings'))?.applied;
          if (observed?.model !== model || observed.effort !== effort) throw new Error('Native Claude configured model/effort mismatch');
          return { model: observed.model, effort: observed.effort };
        };
        result.sourceReceipt.nativeSettings.before = await settings(); result.supported = true;
        transport.send({ type: 'user', uuid: crypto.randomUUID(), session_id: '', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null });
        result.sourceReceipt.stage = 'result';
        const completion = await bounded(transport.wait((m) => m.type === 'result'));
        if (completion.is_error || completion.subtype !== 'success' || !completion.uuid || !completion.session_id || !completion.usage || !(completion.duration_api_ms > 0) || !(completion.num_turns > 0)) throw new Error('Native Claude completion identity/usage unavailable');
        result.output = completion.result || ''; result.nativeSessionId = completion.session_id; result.nativeTurnId = completion.uuid;
        result.sourceReceipt.nativeSettings.after = await settings();
      }
    }
    if (!inspectOnly) {
      if (typeof result.output !== 'string' || !result.output.trim() || Buffer.byteLength(result.output) > 32768) throw new Error('Native plaintext output missing or exceeded bound');
      result.completed = true; result.nativeModel = result.sourceReceipt.nativeSettings.after.model; result.nativeEffort = result.sourceReceipt.nativeSettings.after.effort; result.identityBasis = 'native-host-confirmed-configuration';
      result.sourceReceipt.nativeTurn = { threadId: result.nativeSessionId, turnId: result.nativeTurnId, status: 'completed', toolEvents: [],
        turnIdBasis: host === 'codex' ? 'native-turn.id' : 'native-result.uuid' };
      result.sourceReceipt.stage = 'completed';
    }
  } catch (error) { result.failure = error.message; result.completed = false; result.output = ''; }
  finally {
    clearTimeout(timer); controller.abort();
    if (child) {
      await new Promise((resolve) => {
        const grace = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, Math.max(0, Math.min(100, deadline - now())));
        child.once('close', () => { clearTimeout(grace); resolve(); });
        child.stdin.end(); child.kill('SIGTERM');
      });
    }
    result.elapsedMs = Math.max(0, now() - started); result.checkedAt = new Date().toISOString();
    result.transcript = transcript.map((frame) => JSON.stringify(frame, redact)).join('\n');
    if (Buffer.byteLength(result.transcript) > 1024 * 1024) {
      result.completed = false; result.output = ''; result.failure = 'Archived native transcript exceeded bound';
      result.transcript = ''; result.sourceReceipt.nativeTurn = null;
    }
    result.transcriptSha256 = digest(result.transcript); result.sourceReceipt.transcriptSha256 = result.transcriptSha256;
    result.sourceReceipt.harnessVersion = result.harnessVersion;
  }
  return result;
}

export const runNativeQualification = (options) => run(options, false);
export const inspectNativeQualificationHost = (options) => run(options, true);
