#!/usr/bin/env node
// DISTINCT-FROM: scripts/model-router-dispatch.mjs — same-session native JSONL proxy, never a worker.
// Manual host adapter: Codex cliExecutable / Claude claudeProcessWrapper. No settings are installed.
// New turns fail closed. Active Codex additions require an exact approved pair; Claude packets defer.
// Approvals, tools, cancellation and shutdown retain native protocols.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { subscriptionEnvironment, assertSubscriptionAuth, validateDispatchDecision, loadNativeCodexModels } from './model-router-dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFUSED = 'Current reviewed native model/effort allocation unavailable; new turn was not forwarded.';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Native inference surfaces without qualified execution-time routing are denied.
const UNQUALIFIED = new Set(['review/start', 'thread/queue/add', 'thread/queue/update', 'thread/queue/start',
  'thread/realtime/start', 'thread/realtime/appendAudio', 'thread/realtime/appendSpeech', 'thread/realtime/appendText',
  'thread/goal/set', 'thread/goal/create', 'thread/goal/resume', 'thread/compact/start', 'turn/addUserMessage', 'thread/startAeon']);

function canonicalCodexConfig(config) {
  if (!config || (config.model_provider ?? 'openai') !== 'openai') return false;
  // Native 0.160 gives serviceTierForTurn precedence over daemon/thread Fast defaults.
  // routeCodexTurn supplies both standard overrides; provider/auth checks remain mandatory.
  // A provider with the built-in name can still be replaced by a custom endpoint.
  if (config.model_providers && Object.hasOwn(config.model_providers, 'openai') && config.model_providers.openai != null) return false;
  if (config.chatgpt_base_url != null && config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/') return false;
  // Native Config serializes openai_base_url:null when the override is unset.
  return !Object.entries(config).some(([key, value]) => value != null && /^(model_providers\.openai|base_url|baseUrl|openai_base_url)(\.|$)/.test(key));
}

/** Fresh policy-only subprocess: prompt stays on stdin, never argv, receipts or diagnostics. */
export function decideNativeTurn(prompt, harness, { env = process.env, spawnEngine = spawn, timeoutMs = 4000, multimodal = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnEngine(process.execPath, [env.MODEL_ROUTER_ENGINE || path.join(HERE, 'model-router-engine.mjs'),
      '--harness', harness, '--policy-only', '--json', ...(multimodal ? ['--request-json'] : [])], { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', done = false;
    const finish = (error, decision) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) child.kill();
      error ? reject(error) : resolve(decision);
    };
    const timer = setTimeout(() => finish(new Error(REFUSED)), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 131072) finish(new Error(REFUSED)); });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error(REFUSED)));
    child.stdin.on('error', () => finish(new Error(REFUSED)));
    child.once('exit', (code) => {
      try { if (code !== 0) throw new Error(); finish(null, JSON.parse(stdout)); }
      catch { finish(new Error(REFUSED)); }
    });
    child.stdin.end(multimodal ? JSON.stringify({ prompt: harness === 'claude-code' ? 'Unresolved architecture uncertainty: unclassified multimodal input' : prompt || 'Unclassified multimodal input', taskFacts: { uncertainty: 'architecture' } }) : prompt);
  });
}

export function nativeGatewayLaunch({ harness, realBinary, args = [], env = process.env } = {}) {
  if (!['codex', 'claude-code'].includes(harness) || !path.isAbsolute(realBinary || '')) {
    throw new Error('Explicit absolute native host executable and supported harness required');
  }
  const binary = fs.realpathSync(realBinary);
  if (binary === fs.realpathSync(fileURLToPath(import.meta.url)) || env.MODEL_ROUTER_GATEWAY_ACTIVE) {
    throw new Error('Native routing gateway recursion refused');
  }
  const clean = subscriptionEnvironment(env);
  clean.MODEL_ROUTER_GATEWAY_ACTIVE = '1';
  const nativeArgs = [...args];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (harness === 'codex' && (arg.startsWith('-c') || arg === '--config' || arg.startsWith('--config='))) {
      const setting = arg.startsWith('--config=') ? arg.slice(9) : arg.startsWith('-c') && arg.length > 2 ? arg.slice(2).replace(/^=/, '') : args[++index];
      const at = setting?.indexOf('=');
      if (at == null || at < 0) throw new Error(REFUSED);
      const key = setting.slice(0, at), raw = setting.slice(at + 1);
      let value; try { value = JSON.parse(raw); } catch { value = raw; }
      if (unsafeSettings({ [key]: value })) throw new Error(REFUSED);
    }
    if (harness === 'claude-code' && /^--settings(?:-file)?(?:=|$)/.test(arg)) {
      const overlay = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index];
      let settings;
      try { settings = JSON.parse(overlay.trim().startsWith('{') ? overlay : fs.readFileSync(overlay, 'utf8')); }
      catch { throw new Error(REFUSED); }
      if (unsafeSettings(settings)) throw new Error(REFUSED);
    }
    if (harness === 'codex' && /^(--profile(?:=|$)|-p)/.test(arg)) throw new Error(REFUSED);
    if (/^--(?:betas|model-provider|api-key|base-url)(?:=|$)/.test(arg)) throw new Error(REFUSED);
  }
  if (harness === 'codex') {
    if (!nativeArgs.includes('app-server')) throw new Error('Codex gateway requires native app-server mode');
    nativeArgs.push('-c', 'model_provider="openai"', '-c', 'service_tier="default"', '-c', 'features.fast_mode=false');
  } else if (!nativeArgs.includes('--input-format') || nativeArgs[nativeArgs.indexOf('--input-format') + 1] !== 'stream-json'
    || !nativeArgs.includes('--output-format') || nativeArgs[nativeArgs.indexOf('--output-format') + 1] !== 'stream-json') {
    throw new Error('Claude gateway requires bidirectional native stream-json mode');
  }
  return { command: binary, args: nativeArgs, env: clean };
}

export function appendGatewayReceipt(receipt, { env = process.env } = {}) {
  const file = env.MODEL_ROUTER_GATEWAY_RECEIPTS || path.join(os.homedir(), '.claude', 'metaharness', 'native-turn-routing.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const allowed = new Set(['ts', 'harness', 'status', 'model', 'effort', 'taskClass', 'modelObserved',
    'serviceMode', 'allowanceVerified', 'reservation', 'evidence', 'classificationSource']);
  const metadata = Object.fromEntries(Object.entries(receipt).filter(([key]) => allowed.has(key)));
  fs.appendFileSync(file, JSON.stringify(metadata) + '\n', { mode: 0o600 });
}

function promptFor(message, harness) {
  const content = harness === 'codex' ? message.params?.input : message.message?.content;
  if (typeof content === 'string') return { prompt: content, multimodal: false };
  if (!Array.isArray(content)) throw new Error(REFUSED);
  const text = content.filter((part) => part?.type === 'text').map((part) => part.text);
  if (text.some((part) => typeof part !== 'string')) throw new Error(REFUSED);
  const multimodal = content.some((part) => ['image', 'localImage', 'image_url'].includes(part?.type));
  if (!text.length && !multimodal) throw new Error(REFUSED);
  return { prompt: text.join('\n'), multimodal };
}

// Guard native provider/config overlays recursively, including flattened keys.
function unsafeSettings(value, prefix = '', routing = false) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (/^(model_providers|apiKeyHelper|api_key|apiKey|base_url|baseUrl|openai_base_url|chatgpt_base_url|auth_token|authToken|customHeaders|env|modelSettings|alwaysThinkingEnabled|maxEffortLevel)(\.|$)/.test(name)) return true;
    if (/^(model_provider|modelProvider)$/.test(name) && entry !== 'openai') return true;
    if (/^(service_tier|serviceTier|service_tier_for_turn|serviceTierForTurn)$/.test(name) && entry != null && entry !== 'default') return true;
    if (/^(features\.fast_mode|fastMode)$/.test(name) && entry !== false) return true;
    if (routing && /^(model|effort|effortLevel|reasoning_effort|collaborationMode)(\.|$)/.test(name)) return true;
    return unsafeSettings(entry, name, routing);
  });
}

export function verifyNativeVision(decision, models = loadNativeCodexModels()) {
  const modalities = models.find((model) => model.slug === decision.model)?.input_modalities;
  if (Array.isArray(modalities) && !modalities.includes('image')) throw new Error(REFUSED);
}

/** Pure native override: preserve every context, tool, approval and collaboration instruction. */
export function routeCodexTurn(message, decision) {
  const params = { ...message.params, model: decision.model, effort: decision.effort, serviceTier: 'default', serviceTierForTurn: 'default' };
  if (params.collaborationMode) params.collaborationMode = { ...params.collaborationMode,
    settings: { ...params.collaborationMode.settings, model: decision.model, reasoning_effort: decision.effort } };
  return { ...message, params };
}

/** Injectable protocol transport; no inference or model implementation lives in the gateway. */
export function connectNativeGateway({ harness, child, input, output, diagnostics = process.stderr,
  decide = decideNativeTurn, verifyDecision = validateDispatchDecision, checkAuth = () => {},
  receipt = appendGatewayReceipt, timeoutMs = 5000, maxDeferredBytes = 64 * 1024 * 1024, tempRoot = os.tmpdir(), now = () => new Date().toISOString() } = {}) {
  const nonce = crypto.randomUUID();
  const pending = new Map(), initIds = new Set(), ownIds = new Set(), held = new Set();
  const accepted = new Map(), starts = new Map(), inactiveWaiters = new Set(), boundedWaiters = new Set();
  let serial = Promise.resolve(), ready = harness === 'codex', active = false, closed = false, serialNumber = 0;
  let readiness = null, resolveReady;
  let queuedBytes = 0, spoolDirectory = null, spoolSequence = 0, declineUsers = false;
  const spoolKey = crypto.randomBytes(32);
  const waitInactive = () => !active ? Promise.resolve() : new Promise((resolve) => inactiveWaiters.add(resolve));
  const packetFor = (token) => {
    if (token.packet) return token.packet;
    const bytes = fs.readFileSync(token.file);
    const decipher = crypto.createDecipheriv('aes-256-gcm', spoolKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const packet = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    fs.unlinkSync(token.file); token.file = null; token.packet = packet; return packet;
  };
  const retire = (token) => {
    if (!held.delete(token)) return;
    queuedBytes -= token.bytes;
    if (token.file) { fs.rmSync(token.file, { force: true }); token.file = null; }
  };
  const retain = (line, message) => {
    const token = { bytes: Buffer.byteLength(line), cancelled: false };
    if (harness !== 'claude-code' || held.size < 32) token.packet = message;
    else {
      if (!spoolDirectory) { spoolDirectory = fs.mkdtempSync(path.join(tempRoot, 'native-routing-')); fs.chmodSync(spoolDirectory, 0o700); }
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', spoolKey, nonce);
      const encrypted = Buffer.concat([cipher.update(line, 'utf8'), cipher.final()]);
      token.file = path.join(spoolDirectory, `${++spoolSequence}.bin`);
      fs.writeFileSync(token.file, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
    }
    held.add(token); queuedBytes += token.bytes; return token;
  };
  // Honor writable backpressure while preserving order and pausing its upstream.
  const writer = (destination, source) => {
    const queue = [], idleWaiters = []; let blocked = false, stopped = false, resuming = false;
    const settle = () => { if (!queue.length && !blocked) idleWaiters.splice(0).forEach((resolve) => resolve()); };
    const flush = () => {
      while (!stopped && !blocked && !resuming && queue.length) {
        const entry = queue.shift();
        if (entry.token?.cancelled) { entry.resolve(false); continue; }
        blocked = !destination.write(entry.line);
        if (entry.token) { entry.token.dispatched = true; retire(entry.token); if (harness === 'claude-code') active = true; }
        entry.resolve(true);
      }
      if (blocked) source.pause(); else if (!stopped) source.resume();
      settle();
    };
    destination.on('drain', () => {
      blocked = false; resuming = true; if (!stopped) source.resume();
      setImmediate(() => { resuming = false; flush(); });
    });
    const write = (value, token) => new Promise((resolve) => {
      if (stopped) { resolve(false); return; }
      queue.push({ line: typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n', token, resolve }); flush();
    });
    write.idle = () => !queue.length && !blocked ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve));
    write.close = () => { stopped = true; queue.splice(0).forEach((entry) => entry.resolve(false)); blocked = false; settle(); };
    return write;
  };
  const hostWriter = writer(child.stdin, input), writeClient = writer(output, child.stdout);
  const writeHost = (value, token) => { if (closed) throw new Error(REFUSED); return hostWriter(value, token); };
  const record = (status, decision, observed = false, extra = {}) => receipt({ ts: now(), harness, status,
    ...(decision ? { model: decision.model, effort: decision.effort, taskClass: decision.taskClass } : {}),
    modelObserved: observed, ...(decision?.classificationSource ? { classificationSource: decision.classificationSource } : {}), ...extra });
  const fail = (message, reason = REFUSED) => {
    diagnostics.write(`[native-model-routing] ${reason}\n`);
    if (harness === 'codex' && Object.hasOwn(message, 'id')) {
      writeClient({ id: message.id, error: { code: -32001, message: reason } });
    } else if (harness === 'claude-code' && message.type === 'control_request') {
      writeClient({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: reason } });
    } else if (harness === 'claude-code') {
      writeClient({ type: 'result', subtype: 'error_during_execution', is_error: true,
        errors: [reason], session_id: message.session_id || '', uuid: crypto.randomUUID(),
        duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
    }
    try { record('routing-refused'); } catch { /* diagnostics above are the fail-closed proof */ }
  };
  const waitReady = () => {
    if (ready) return Promise.resolve();
    if (!readiness) readiness = new Promise((resolve) => { resolveReady = resolve; });
    return bounded(readiness);
  };
  function bounded(work) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => { clearTimeout(timer); boundedWaiters.delete(cancel); error ? reject(error) : resolve(value); };
      const cancel = () => finish(new Error(REFUSED));
      const timer = setTimeout(cancel, timeoutMs); boundedWaiters.add(cancel);
      Promise.resolve(work).then((value) => finish(null, value), (error) => finish(error));
    });
  }
  const control = (request) => new Promise((resolve, reject) => {
    const id = `model-routing-gateway:${nonce}:${++serialNumber}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(REFUSED)); }, timeoutMs);
    ownIds.add(id);
    pending.set(id, { resolve, reject, timer });
    try {
      writeHost(harness === 'codex' ? { id, ...request }
        : { type: 'control_request', request_id: id, request });
    } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  async function route(token) {
    let message;
    const assertLive = () => { if (closed || token.cancelled) throw new Error('cancelled'); };
    try {
      message = packetFor(token);
      await waitReady();
      assertLive();
      // Active Claude packets become unchanged next-turn input after the current result.
      if (harness === 'claude-code' && active) {
        try { record('active-input-deferred'); } catch { diagnostics.write('[native-model-routing] Deferred-input receipt unavailable; current work continues.\n'); }
        await waitInactive(); assertLive();
      }
      const facts = promptFor(message, harness);
      const decision = await bounded(decide(facts.prompt, harness, { multimodal: facts.multimodal }));
      assertLive();
      if (facts.multimodal && (decision.taskClass !== 'hard' || decision.effort !== 'high')) throw new Error(REFUSED);
      if (facts.multimodal) decision.classificationSource = 'multimodal-uncertainty';
      if (!decision?.subscriptionCovered || decision.harness !== harness || !EFFORTS.has(decision.effort)
        || !/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(decision.model || '')) throw new Error(REFUSED);
      await bounded(verifyDecision(decision));
      if (facts.multimodal && harness === 'codex' && verifyDecision === validateDispatchDecision) {
        verifyNativeVision(decision);
      }
      assertLive();
      await bounded(checkAuth(harness));
      assertLive();
      if (harness === 'codex') {
        if (message.method !== 'turn/start') {
          const pair = accepted.get(message.params?.threadId);
          if (!pair || pair.turnId !== message.params?.expectedTurnId || pair.model !== decision.model || pair.effort !== decision.effort) {
            fail(message, 'Input not submitted: requires a new turn with reviewed allocation; current work continues.'); return;
          }
          record('active-input-approved', decision, false, { evidence: 'native-turn-start.accepted-configured-pair' });
          await writeHost(message, token); return;
        }
        const account = await control({ method: 'account/read', params: { refreshToken: false } });
        assertLive();
        if (account?.account?.type !== 'chatgpt') throw new Error(REFUSED);
        const thread = await control({ method: 'thread/read', params: { threadId: message.params?.threadId, includeTurns: false } });
        assertLive();
        if (thread?.thread?.id !== message.params?.threadId || thread.thread.modelProvider !== 'openai') throw new Error(REFUSED);
        const cwd = message.params?.cwd ?? thread.thread.cwd;
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error(REFUSED);
        const effective = await control({ method: 'config/read', params: { includeLayers: false, cwd } });
        assertLive();
        if (!canonicalCodexConfig(effective?.config)) throw new Error(REFUSED);
        const allowance = await control({ method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
        assertLive();
        if (allowance?.ordinaryUsageAllowed !== true) throw new Error(REFUSED);
        record('turn-ready', decision, false, { serviceMode: 'standard', allowanceVerified: true, reservation: false });
        starts.set(message.id, { threadId: message.params?.threadId, model: decision.model, effort: decision.effort });
        if (await writeHost(routeCodexTurn(message, decision), token)) {
          record('turn-forwarded', decision, false, { serviceMode: 'standard', allowanceVerified: true, reservation: false });
        }
      } else {
        if (!['low', 'medium', 'high', 'xhigh'].includes(decision.effort)) throw new Error(REFUSED);
        await control({ subtype: 'apply_flag_settings', settings: { model: decision.model, effortLevel: decision.effort } });
        assertLive();
        const settings = await control({ subtype: 'get_settings' });
        assertLive();
        if (settings?.applied?.model !== decision.model || settings?.applied?.effort !== decision.effort) throw new Error(REFUSED);
        record('turn-ready', decision, true, { evidence: 'native-get_settings.applied' });
        if (await writeHost(message, token)) record('turn-forwarded', decision, true, { evidence: 'native-get_settings.applied' });
      }
    } catch {
      if (!message && !closed && !token.cancelled) diagnostics.write('[native-model-routing] Deferred transport integrity unavailable; packet not submitted; current work continues.\n');
      if (!closed && !token.cancelled && !token.dispatched && message && !(harness === 'claude-code' && active)) fail(message);
      else if (token.dispatched) diagnostics.write('[native-model-routing] Post-dispatch receipt unavailable; native work continues.\n');
    }
    finally { retire(token); }
  }
  const listenLines = (stream, handler) => {
    let buffer = ''; const decoder = new StringDecoder('utf8');
    const pump = () => {
      let split;
      while ((split = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        handler(line);
      }
    };
    stream.on('data', (chunk) => { buffer += decoder.write(chunk); pump(); });
    stream.on('resume', () => { if (buffer) setImmediate(pump); });
    stream.on('end', () => { buffer += decoder.end(); if (buffer) handler(buffer); });
  };
  listenLines(input, (line) => {
    if (closed) return;
    let message;
    try { message = JSON.parse(line); } catch { if (!closed) writeHost(line); return; }
    if (harness === 'claude-code' && message.type === 'control_request' && message.request?.subtype === 'initialize') initIds.add(message.request_id);
    if (harness === 'codex' && UNQUALIFIED.has(message.method)) {
      fail(message, 'Native inference method is not qualified for gateway routing; request not forwarded.'); return;
    }
    const routable = harness === 'codex' ? ['turn/start', 'turn/steer'].includes(message.method) : message.type === 'user';
    if (routable && harness === 'claude-code' && (declineUsers || queuedBytes + Buffer.byteLength(line) > maxDeferredBytes)) {
      declineUsers = true;
      const reason = 'Deferred input capacity (64 MiB) exceeded; new user packet not submitted; current work continues.';
      diagnostics.write(`[native-model-routing] ${reason}\n`);
      try { record('deferred-capacity-refused'); } catch { /* keep parsing permission/cancel controls */ }
      if (!active) fail(message, reason);
      return;
    }
    const cancel = harness === 'codex' ? message.method === 'turn/interrupt' : message.request?.subtype === 'interrupt';
    const shutdown = message.method === 'shutdown';
    if (shutdown || (cancel && (harness === 'codex' || !active))) {
      for (const token of held) {
        if (!token.cancelled && (shutdown || harness !== 'codex' || !message.params?.threadId || message.params.threadId === token.packet?.params?.threadId)) {
          token.cancelled = true; fail(packetFor(token), 'Native turn cancelled before dispatch.');
        }
      }
    }
    let unsafe = false;
    if (harness === 'codex') {
      const params = message.params || {};
      unsafe = unsafeSettings(params.config) || unsafeSettings({ modelProvider: params.modelProvider ?? 'openai',
        serviceTier: params.serviceTier, service_tier: params.service_tier,
        serviceTierForTurn: params.serviceTierForTurn, service_tier_for_turn: params.service_tier_for_turn });
      if (message.method === 'account/login/start' && !['chatgpt', 'chatgptDeviceCode', 'chatgptAuthTokens'].includes(params.type)) unsafe = true;
      if (['thread/settings/update', 'turn/settings/update'].includes(message.method)) unsafe ||= unsafeSettings(params, '', true);
      const edits = message.method === 'config/value/write' ? [params] : message.method === 'config/batchWrite' ? params.edits || [] : [];
      if (message.method === 'config/batchWrite' && params.reloadUserConfig === true) unsafe = true;
      unsafe ||= edits.some((edit) => unsafeSettings({ [edit.keyPath]: edit.value }, '', true));
    } else if (message.type === 'control_request') {
      const request = message.request || {};
      unsafe = ['set_model', 'set_max_thinking_tokens'].includes(request.subtype)
        || (['apply_flag_settings', 'update_settings'].includes(request.subtype) && unsafeSettings(request.settings || request, '', true));
    }
    if (unsafe) { fail(message, 'Native allocation/provider override refused; reviewed gateway routing owns model and effort.'); return; }
    if (routable) {
      try { const token = retain(line, message); serial = serial.then(() => route(token)); }
      catch { diagnostics.write('[native-model-routing] Deferred transport storage unavailable; packet not submitted; current work continues.\n'); if (!active) fail(message); }
    }
    else {
      if (!closed) writeHost(line);
    }
  });
  listenLines(child.stdout, (line) => {
    let message;
    try { message = JSON.parse(line); } catch { writeClient(line); return; }
    const id = harness === 'codex' ? message.id : message.type === 'control_response' ? message.response?.request_id : null;
    if (pending.has(id)) {
      const waiter = pending.get(id); pending.delete(id); clearTimeout(waiter.timer);
      const failed = harness === 'codex' ? message.error : message.response?.subtype !== 'success';
      failed ? waiter.reject(new Error(REFUSED)) : waiter.resolve(harness === 'codex' ? message.result : message.response.response);
      return;
    }
    if (starts.has(id)) {
      const pair = starts.get(id); starts.delete(id);
      if (!message.error && typeof message.result?.turn?.id === 'string' && message.result.turn.id) accepted.set(pair.threadId, { ...pair, turnId: message.result.turn.id });
    }
    if (message.method === 'turn/completed' && accepted.get(message.params?.threadId)?.turnId === message.params?.turn?.id) accepted.delete(message.params.threadId);
    if (ownIds.has(id)) return; // late own-control replies never escape into the host client
    if (initIds.has(id) && message.response?.subtype === 'success') {
      ready = true; active = message.response.response?.session_state && message.response.response.session_state !== 'idle'; resolveReady?.();
    }
    if (harness === 'claude-code' && ['assistant', 'stream_event'].includes(message.type)) active = true;
    if (harness === 'claude-code' && message.type === 'result') { active = false; inactiveWaiters.forEach((resolve) => resolve()); inactiveWaiters.clear(); }
    writeClient(line);
  });
  child.stderr?.on('data', (chunk) => diagnostics.write(chunk));
  const close = () => {
    if (closed) return;
    closed = true; hostWriter.close(); inactiveWaiters.forEach((resolve) => resolve()); inactiveWaiters.clear();
    boundedWaiters.forEach((cancel) => cancel()); boundedWaiters.clear(); accepted.clear(); starts.clear();
    for (const token of [...held]) { token.cancelled = true; retire(token); }
    if (spoolDirectory) fs.rmSync(spoolDirectory, { recursive: true, force: true });
    spoolKey.fill(0);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(REFUSED)); }
    pending.clear();
  };
  child.once('error', close); child.once('exit', close); child.stdin.on('error', close); child.stdout.on('error', close);
  const disconnect = () => { close(); if (!child.stdin.destroyed) child.stdin.end(); };
  input.on('end', disconnect); input.on('error', disconnect); input.on('close', disconnect);
  return { idle: () => serial, close, spoolState: () => ({ directory: spoolDirectory, queuedBytes }) };
}

export function parseGatewayInvocation(argv, env = process.env) {
  const args = [...argv];
  let harness, realBinary;
  if (args[0] === '--harness') { harness = args[1]; args.splice(0, 2); }
  if (['--real-binary', '--executable'].includes(args[0])) { realBinary = args[1]; args.splice(0, 2); }
  if (args[0] === '--') args.shift();
  if (!harness) harness = args.includes('app-server') ? 'codex' : 'claude-code';
  if (!realBinary) realBinary = harness === 'codex' ? env.MODEL_ROUTER_REAL_CODEX : args.shift();
  return { harness, realBinary, args, env };
}

async function main(argv) {
  const launch = nativeGatewayLaunch(parseGatewayInvocation(argv));
  const harness = parseGatewayInvocation(argv).harness;
  const auth = (host) => assertSubscriptionAuth(host, { env: launch.env,
    probe: (_command, args, options) => execFileSync(launch.command, args, options) });
  auth(harness);
  const child = spawn(launch.command, launch.args, { env: launch.env, cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const gateway = connectNativeGateway({ harness, child, input: process.stdin, output: process.stdout,
    decide: (prompt, host, metadata) => decideNativeTurn(prompt, host, { env: launch.env, ...metadata }), checkAuth: auth });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { gateway.close(); child.kill(signal); });
  child.once('exit', (code, signal) => { process.stdin.pause(); process.stdin.unref?.(); process.exitCode = code ?? (signal ? 1 : 0); });
  child.once('error', () => { process.stderr.write('[native-model-routing] Native host transport unavailable.\n'); process.exitCode = 1; });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('[native-model-routing] Explicit native executable or subscription authentication unavailable.\n'); process.exitCode = 1; });
}
