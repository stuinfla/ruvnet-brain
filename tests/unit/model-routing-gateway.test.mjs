import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { validateDispatchDecision } from '../../scripts/model-router-dispatch.mjs';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { connectNativeGateway, routeCodexTurn, nativeGatewayLaunch, parseGatewayInvocation,
  decideNativeTurn, appendGatewayReceipt, verifyNativeVision } from '../../scripts/model-routing-gateway.mjs';

const roots = [], gateways = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const decision = (harness = 'codex', model = 'native-fixture', effort = 'high') => ({
  harness, model, effort, taskClass: 'hard', subscriptionCovered: true,
});
const turn = (id = 9) => ({ id, method: 'turn/start', params: { threadId: 'existing-thread',
  input: [{ type: 'text', text: 'PRIVATE PROMPT', text_elements: [{ byteRange: { start: 0, end: 2 } }] },
    { type: 'image', url: 'image://fixture' }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' },
  cwd: '/existing/worktree', model: 'previous', effort: 'high', summary: 'detailed', customTools: [{ name: 'my-tool' }],
  collaborationMode: { mode: 'plan', settings: { model: 'previous', reasoning_effort: 'high', developer_instructions: 'CONTEXT TO RETAIN' } },
} });
const user = (text = 'PRIVATE PROMPT') => ({ type: 'user', uuid: 'unchanged-user-id', session_id: 'existing-session',
  message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { data: 'fixture-data' } }] },
  parent_tool_use_id: null, customContext: 'retain' });
function lines(stream, collect) {
  let buffer = '';
  stream.on('data', (data) => { buffer += data.toString(); let at;
    while ((at = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); collect(JSON.parse(line)); }
  });
}
function fixture(harness, options = {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const sent = [], received = [], receipts = [], prompts = [];
  lines(child.stdin, (msg) => sent.push(msg)); lines(output, (msg) => received.push(msg));
  const gateway = connectNativeGateway({ harness, child, input, output, diagnostics, timeoutMs: 40,
    decide: async (prompt) => { prompts.push(prompt); return decision(harness); },
    verifyDecision: () => {}, receipt: (record) => receipts.push(record), ...options });
  gateways.push(gateway);
  const send = (message) => input.write(JSON.stringify(message) + '\n');
  const respond = (message) => child.stdout.write(JSON.stringify(message) + '\n');
  const reply = (request, payload = {}) => respond(harness === 'codex' ? { id: request.id, result: payload }
    : { type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: payload } });
  const initialize = () => {
    send({ type: 'control_request', request_id: 'external-init', request: { subtype: 'initialize', hooks: { retained: true } } });
    respond({ type: 'control_response', response: { subtype: 'success', request_id: 'external-init', response: { session_state: 'idle' } } });
  };
  return { ...gateway, child, input, send, respond, reply, initialize, sent, received, receipts, prompts };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 25 && !predicate(); i++) await tick(); expect(predicate()).toBe(true); }
function autoCodex(f, allowance = true) {
  f.child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.method === 'account/read') f.reply(msg, { account: { type: 'chatgpt' } });
      if (msg.method === 'config/read') f.reply(msg, { config: { model_provider: 'openai', openai_base_url: null } });
      if (msg.method === 'thread/read') f.reply(msg, { thread: { id: msg.params.threadId, modelProvider: 'openai', cwd: '/tmp' } });
      if (msg.method === 'account/rateLimits/read') f.reply(msg, { ordinaryUsageAllowed: allowance });
    }
  });
}
async function claudeControls(f, d = decision('claude-code')) {
  await until(() => f.sent.some((msg) => msg.request?.subtype === 'apply_flag_settings'));
  const apply = f.sent.findLast((msg) => msg.request?.subtype === 'apply_flag_settings');
  f.reply(apply);
  await until(() => f.sent.some((msg) => msg.request?.subtype === 'get_settings'));
  f.reply(f.sent.findLast((msg) => msg.request?.subtype === 'get_settings'), { applied: { model: d.model, effort: d.effort } });
  await f.idle();
}

describe('native turn routing transport', () => {
  it('overrides all Codex precedence fields, retaining IDs, inputs, context, tools and instructions', async () => {
    const f = fixture('codex'); autoCodex(f);
    const original = turn(); f.send(original); await f.idle();
    expect(f.sent.at(-1)).toEqual(routeCodexTurn(original, decision()));
    expect(f.sent.at(-1).params).toMatchObject({ serviceTier: 'default', serviceTierForTurn: 'default' });
    expect(f.sent.at(-1).params.collaborationMode.settings.developer_instructions).toBe('CONTEXT TO RETAIN');
    expect(f.prompts).toEqual(['PRIVATE PROMPT']);
    expect(f.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'turn-forwarded', modelObserved: false, serviceMode: 'standard', allowanceVerified: true })]));
    expect(JSON.stringify(f.receipts)).not.toContain('PRIVATE');
    const result = { id: 9, result: { turn: { id: 'native-turn', items: [] } } }; f.respond(result);
    expect(f.received).toEqual([result]);
  });

  it('pure normalization replaces both native service precedence fields without mutating the original', () => {
    const original = turn(); original.params.serviceTier = 'priority'; original.params.serviceTierForTurn = 'priority';
    expect(routeCodexTurn(original, decision()).params).toMatchObject({ serviceTier: 'default', serviceTierForTurn: 'default' });
    expect(original.params).toMatchObject({ serviceTier: 'priority', serviceTierForTurn: 'priority' });
  });

  it('keeps cancellation and tool traffic immediate while refusing unqualified queue inference', async () => {
    let resolve; const f = fixture('codex', { decide: () => new Promise((r) => { resolve = r; }) });
    autoCodex(f); f.send(turn()); await tick();
    const messages = [ { id: 'steer', method: 'turn/steer', params: { threadId: 'existing-thread', input: ['keep'] } },
      { id: 'queue', method: 'thread/queue/add', params: { retain: 'everything' } },
      { id: 'cancel', method: 'turn/interrupt', params: { threadId: 'existing-thread', turnId: 'prior-active' } },
      { id: 'tool', result: { approved: true } }, { method: 'shutdown', params: {} } ];
    for (const msg of messages) f.send(msg);
    expect(f.sent).toEqual(messages.slice(2));
    resolve(decision()); await f.idle();
    expect(f.sent.some((msg) => msg.method === 'turn/start')).toBe(false);
    expect(f.received.find((m) => m.id === 9)).toMatchObject({ id: 9, error: { message: 'Native turn cancelled before dispatch.' } });
  });

  it('preserves UTF-8 split across every byte in both protocol directions', async () => {
    const f = fixture('codex'); autoCodex(f);
    const original = turn(); original.params.input[0].text = 'Brain 🧠 日本語';
    for (const byte of Buffer.from(JSON.stringify(original) + '\n')) f.input.write(Buffer.from([byte]));
    await f.idle(); expect(f.sent.at(-1).params.input).toEqual(original.params.input);
    const response = { id: original.id, result: { text: '🧠 日本語' } };
    for (const byte of Buffer.from(JSON.stringify(response) + '\n')) f.child.stdout.write(Buffer.from([byte]));
    expect(f.received.at(-1)).toEqual(response);
  });

  it('honors bidirectional backpressure and ordered drain without dropping messages', async () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const input = new PassThrough(), observedHost = [], observedClient = [], callbacks = [], clientCallbacks = [];
    child.stdin = new Writable({ highWaterMark: 1, write(data, _encoding, done) { observedHost.push(data.toString()); callbacks.push(done); } });
    const output = new Writable({ highWaterMark: 1, write(data, _encoding, done) { observedClient.push(data.toString()); clientCallbacks.push(done); } });
    const gateway = connectNativeGateway({ harness: 'codex', child, input, output }); gateways.push(gateway);
    input.write('{"id":1,"method":"ping"}\n{"id":2,"method":"ping"}\n');
    expect(input.isPaused()).toBe(true); expect(observedHost).toHaveLength(1);
    callbacks.shift()(); await until(() => observedHost.length === 2);
    callbacks.shift()(); await tick(); expect(input.isPaused()).toBe(false);
    child.stdout.write('{"id":1,"result":"🧠"}\n{"id":2,"result":true}\n');
    expect(child.stdout.isPaused()).toBe(true); expect(observedClient).toHaveLength(1);
    clientCallbacks.shift()(); await until(() => observedClient.length === 2);
    clientCallbacks.shift()(); await tick(); expect(child.stdout.isPaused()).toBe(false);
    expect(observedHost.map(JSON.parse).map((m) => m.id)).toEqual([1, 2]);
    expect(observedClient.map(JSON.parse).map((m) => m.id)).toEqual([1, 2]);
  });

  it('cancels held turns during native allowance verification and close suppresses late decisions', async () => {
    const f = fixture('codex'); f.send(turn()); await until(() => f.sent.length === 1);
    f.send({ id: 'cancel', method: 'turn/interrupt', params: { threadId: 'existing-thread' } });
    f.reply(f.sent[0], { account: { type: 'chatgpt' } }); await f.idle();
    expect(f.sent.some((m) => m.method === 'turn/start')).toBe(false);
    let resolve; const g = fixture('codex', { decide: () => new Promise((r) => { resolve = r; }) });
    g.send(turn()); await tick(); g.close(); resolve(decision()); await g.idle(); expect(g.sent).toEqual([]);
  });

  it('drops backpressured held turns on cancellation, close or EOF without late dispatch', async () => {
    for (const action of ['cancel', 'close']) {
      const f = fixture('codex'); let blocked = false;
      const nativeWrite = f.child.stdin.write.bind(f.child.stdin);
      f.child.stdin.write = (line) => { nativeWrite(line); if (JSON.parse(line).method === 'account/rateLimits/read') { blocked = true; return false; } return true; };
      autoCodex(f); f.send(turn()); await until(() => blocked);
      await tick(); expect(f.sent.some((m) => m.method === 'turn/start')).toBe(false);
      if (action === 'close') f.close();
      else f.send({ id: 'cancel', method: 'turn/interrupt', params: { threadId: 'existing-thread' } });
      f.child.stdin.emit('drain'); await f.idle();
      expect(f.sent.some((m) => m.method === 'turn/start')).toBe(false);
      expect(f.receipts.some((r) => r.status === 'turn-forwarded')).toBe(false);
    }
    const f = fixture('codex'); const nativeWrite = f.child.stdin.write.bind(f.child.stdin);
    f.child.stdin.write = (line) => { nativeWrite(line); return false; };
    f.input.end('{"id":1,"method":"ping"}\n{"id":2,"method":"ping"}\n'); await tick();
    expect(f.child.stdin.writableEnded).toBe(true);
    f.child.stdin.emit('drain'); await tick();
    expect(f.sent.map((m) => m.id)).toEqual([1]);
    const g = fixture('codex'); const write = g.child.stdin.write.bind(g.child.stdin);
    g.child.stdin.write = (line) => { write(line); return false; };
    g.input.write('{"id":1,"method":"ping"}\n{"id":2,"method":"ping"}\n');
    g.close(); g.child.stdin.emit('drain'); await tick(); await tick(); expect(g.sent.map((m) => m.id)).toEqual([1]);
  });

  it('refuses allocation mutations during Claude readback while permissions stay immediate', async () => {
    const f = fixture('claude-code'); f.initialize(); f.send(user());
    await until(() => f.sent.length === 2); f.reply(f.sent[1]); await until(() => f.sent.length === 3);
    f.send({ type: 'control_request', request_id: 'parent-model', request: { subtype: 'set_model', model: 'other' } });
    f.send({ type: 'control_response', response: { request_id: 'tool', subtype: 'success', response: { behavior: 'allow' } } });
    expect(f.received.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'parent-model', subtype: 'error' } });
    expect(f.sent.at(-1).response.request_id).toBe('tool');
    f.reply(f.sent[2], { applied: { model: 'native-fixture', effort: 'high' } }); await f.idle();
    expect(f.sent.at(-1)).toEqual(user()); expect(f.sent.some((m) => m.request?.subtype === 'set_model')).toBe(false);
  });

  it('rejects native model-specific effort overrides without touching unrelated tools', () => {
    const f = fixture('claude-code'); f.initialize();
    for (const settings of [{ modelSettings: { 'native-fixture': { effortLevel: 'low' } } },
      { modelSettings: { 'native-fixture': { maxEffortLevel: 'low' } } }, { alwaysThinkingEnabled: false }, { maxEffortLevel: 'low' }]) {
      f.send({ type: 'control_request', request_id: 'effort-bypass', request: { subtype: 'apply_flag_settings', settings } });
      expect(f.received.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'effort-bypass', subtype: 'error' } });
    }
    expect(f.sent).toHaveLength(1);
  });

  it('rejects nested provider, configuration, thread-setting and API login bypasses', () => {
    const f = fixture('codex');
    for (const message of [
      { method: 'thread/resume', params: { config: { model_providers: { openai: { base_url: 'foreign' } } } } },
      { method: 'thread/settings/update', params: { threadId: 'same', model: 'override' } },
      { method: 'turn/settings/update', params: { threadId: 'same', turnId: 'active', model: 'override' } },
      { method: 'config/value/write', params: { keyPath: 'model_providers.openai.base_url', value: 'foreign', mergeStrategy: 'replace' } },
      { method: 'config/batchWrite', params: { edits: [{ keyPath: 'features.fast_mode', value: true }] } },
      { method: 'account/login/start', params: { type: 'apiKey', apiKey: 'PRIVATE' } },
    ]) f.send({ id: 'blocked', ...message });
    expect(f.sent).toEqual([]); expect(f.received).toHaveLength(6); expect(JSON.stringify(f.received)).not.toContain('PRIVATE');
    const allowed = { id: 'safe', method: 'config/value/write', params: { keyPath: 'sandbox_mode', value: 'read-only', mergeStrategy: 'replace' } };
    f.send(allowed); expect(f.sent).toEqual([allowed]);
  });

  it('routes mixed and image-only inputs conservatively without changing image payloads', async () => {
    const f = fixture('codex', { decide: async (prompt, host, facts) => { expect(facts.multimodal).toBe(true); return decision(host); } }); autoCodex(f);
    const original = turn(); original.params.input = original.params.input.filter((part) => part.type === 'image');
    f.send(original); await f.idle(); expect(f.sent.at(-1).params.input).toEqual(original.params.input);
    expect(f.receipts[0]).toMatchObject({ classificationSource: 'multimodal-uncertainty', effort: 'high' });
    const g = fixture('codex', { decide: async () => ({ ...decision(), effort: 'low', taskClass: 'fast' }) }); autoCodex(g);
    g.send(turn()); await g.idle(); expect(g.sent.some((m) => m.method === 'turn/start')).toBe(false);
  });

  it('preserves native thread resume context but refuses explicit provider or credit-tier overrides', () => {
    const f = fixture('codex');
    const resume = { id: 'resume', method: 'thread/resume', params: { threadId: 'retained-thread',
      modelProvider: 'openai', history: [{ type: 'retain' }], config: { sandbox_mode: 'read-only', mcp_servers: { retained: { env: { api_key: 'tool-private' }, base_url: 'tool-endpoint' } } } } };
    f.send(resume); expect(f.sent).toEqual([resume]);
    for (const params of [{ modelProvider: 'foreign' }, { serviceTier: 'priority' },
      { config: { model_provider: 'foreign' } }, { config: { features: { fast_mode: true } } }]) {
      f.send({ id: 'refuse', method: 'thread/start', params });
      expect(f.received.at(-1)).toMatchObject({ id: 'refuse', error: { code: -32001 } });
    }
    expect(f.sent).toEqual([resume]);
  });

  it('reclassifies each new turn in the same thread and never treats requested model as observed', async () => {
    let n = 0; const f = fixture('codex', { decide: async () => decision('codex', `native-${++n}`, 'high') });
    autoCodex(f);
    f.send(turn(1)); await f.idle(); f.send(turn(2)); await f.idle();
    expect(f.sent.filter((msg) => msg.method === 'turn/start').map((msg) => msg.params.model)).toEqual(['native-1', 'native-2']);
    expect(f.receipts.every((r) => r.modelObserved === false)).toBe(true);
  });

  it.each(['selection', 'validation', 'authentication', 'allowance'])('fails closed on unavailable %s without killing native transport', async (phase) => {
    const reject = () => { throw new Error('SECRET RAW POLICY ERROR'); };
    const f = fixture('codex', { ...(phase === 'selection' ? { decide: reject } : {}),
      ...(phase === 'validation' ? { verifyDecision: reject } : {}), ...(phase === 'authentication' ? { checkAuth: reject } : {}) });
    autoCodex(f, phase !== 'allowance'); f.send(turn()); await f.idle();
    expect(f.sent.some((msg) => msg.method === 'turn/start')).toBe(false);
    expect(f.received.at(-1)).toMatchObject({ id: 9, error: { code: -32001 } });
    expect(JSON.stringify(f.received)).not.toContain('SECRET');
    f.send({ id: 'still-alive', method: 'turn/interrupt' });
    expect(f.sent.at(-1)).toEqual({ id: 'still-alive', method: 'turn/interrupt' });
  });

  it('times out own metadata without leaking late own-control responses to client IDs', async () => {
    const f = fixture('codex', { timeoutMs: 5 }); f.send(turn()); await f.idle();
    const internal = f.sent[0]; expect(f.received).toHaveLength(1);
    f.reply(internal, { ordinaryUsageAllowed: true });
    expect(f.received).toHaveLength(1);
    const external = { id: 'unrelated-native-id', result: { unchanged: true } }; f.respond(external);
    expect(f.received.at(-1)).toEqual(external);
  });

  it('Claude awaits initialization, apply acknowledgement and effective native settings before user input', async () => {
    const f = fixture('claude-code'); f.send(user()); await tick();
    expect(f.sent).toEqual([]);
    f.initialize(); await tick();
    expect(f.sent[0].request_id).toBe('external-init');
    expect(f.sent[1].request).toEqual({ subtype: 'apply_flag_settings', settings: { model: 'native-fixture', effortLevel: 'high' } });
    expect(f.sent.some((msg) => msg.type === 'user')).toBe(false);
    await claudeControls(f);
    expect(f.sent.at(-1)).toEqual(user());
    expect(f.received).toHaveLength(1); // only client's own initialize response
    expect(f.receipts[0]).toMatchObject({ modelObserved: true, evidence: 'native-get_settings.applied' });
  });

  it('Claude requires applied runtime evidence, not requested or effective configuration', async () => {
    const f = fixture('claude-code'); f.initialize(); f.send(user());
    await until(() => f.sent.length === 2); f.reply(f.sent[1]);
    await until(() => f.sent.length === 3);
    f.reply(f.sent[2], { effective: { model: 'native-fixture', effortLevel: 'high' }, applied: { model: 'other', effort: 'high' } });
    await f.idle();
    expect(f.sent.some((msg) => msg.type === 'user')).toBe(false);
    expect(f.receipts.every((r) => r.modelObserved === false)).toBe(true);
    expect(f.received.at(-1)).toMatchObject({ type: 'result', is_error: true });
  });

  it('defers original Claude active packets until native result then applies a fresh route', async () => {
    const f = fixture('claude-code'); f.initialize(); f.send(user()); await claudeControls(f);
    const original = user('NEXT DEFERRED TURN'); f.send(original); await tick();
    expect(f.sent.filter((m) => m.type === 'user')).toHaveLength(1);
    expect(f.sent.filter((m) => m.request?.subtype === 'apply_flag_settings')).toHaveLength(1);
    expect(f.received.some((m) => m.type === 'result')).toBe(false);
    const tool = { type: 'control_response', response: { request_id: 'permission', subtype: 'success' } }; f.send(tool);
    expect(f.sent.at(-1)).toEqual(tool);
    f.respond({ type: 'result', subtype: 'success', session_id: 'existing-session' });
    await until(() => f.sent.filter((m) => m.request?.subtype === 'apply_flag_settings').length === 2);
    f.reply(f.sent.at(-1)); await until(() => f.sent.filter((m) => m.request?.subtype === 'get_settings').length === 2);
    f.reply(f.sent.at(-1), { applied: { model: 'native-fixture', effort: 'high' } }); await f.idle();
    expect(f.sent.at(-1)).toEqual(original); expect(f.prompts).toEqual(['PRIVATE PROMPT', 'NEXT DEFERRED TURN']);
  });

  it('bounds deferred Claude intake and retains original packets in order under backpressure', async () => {
    const f = fixture('claude-code'); f.initialize();
    f.child.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const message = JSON.parse(line);
        if (message.request?.subtype === 'apply_flag_settings') f.reply(message);
        if (message.request?.subtype === 'get_settings') f.reply(message, { applied: { model: 'native-fixture', effort: 'high' } });
      }
    });
    f.send(user()); await f.idle();
    const packets = Array.from({ length: 33 }, (_, index) => ({ ...user(`DEFERRED ${index}`), uuid: `original-${index}` }));
    const sameChunkControl = { type: 'control_response', response: { request_id: 'same-chunk-permission', subtype: 'success' } };
    f.input.write([...packets, sameChunkControl].map((message) => JSON.stringify(message)).join('\n') + '\n'); await tick();
    expect(f.sent.at(-1)).toEqual(sameChunkControl);
    expect(f.input.isPaused()).toBe(false); expect(f.sent.filter((m) => m.type === 'user')).toHaveLength(1);
    const controls = [{ type: 'control_response', response: { request_id: 'permission-after-overflow', subtype: 'success' } },
      { type: 'control_request', request_id: 'cancel-after-overflow', request: { subtype: 'interrupt' } }];
    f.input.write(controls.map(JSON.stringify).join('\n') + '\n');
    expect(f.sent.slice(-2)).toEqual(controls);
    expect(f.spoolState().directory).toBeTruthy();
    const directory = f.spoolState().directory;
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    // Windows stat mode is not a POSIX ACL/private-directory proof. Keep mode
    // checks on POSIX; ciphertext privacy and lossless replay are checked on every host.
    if (process.platform !== 'win32') expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    for (const file of fs.readdirSync(directory)) {
      const encrypted = fs.readFileSync(path.join(directory, file));
      expect(encrypted.includes(Buffer.from('DEFERRED'))).toBe(false);
      expect(fs.statSync(path.join(directory, file)).isFile()).toBe(true);
      expect(file).toMatch(/^\d+\.bin$/);
      expect(encrypted.length).toBeGreaterThan(28); // 12-byte nonce + 16-byte GCM tag + ciphertext
      expect(() => JSON.parse(encrypted.toString())).toThrow();
      if (process.platform !== 'win32') expect(fs.statSync(path.join(directory, file)).mode & 0o777).toBe(0o600);
    }
    for (let index = 0; index < packets.length; index++) {
      f.respond({ type: 'result', subtype: 'success' });
      await until(() => f.sent.filter((m) => m.type === 'user').length === index + 2);
    }
    expect(f.sent.filter((m) => m.type === 'user').slice(1)).toEqual(packets);
    await f.idle(); expect(f.received.filter((m) => m.type === 'result')).toHaveLength(33);
    expect(fs.readdirSync(directory)).toEqual([]); f.close(); expect(fs.existsSync(directory)).toBe(false);
  });

  it('reports finite deferred capacity without terminal active result and keeps controls flowing', async () => {
    const diagnostics = new PassThrough(); let errors = ''; diagnostics.on('data', (chunk) => { errors += chunk; });
    const f = fixture('claude-code', { maxDeferredBytes: 2048, diagnostics }); f.initialize(); f.send(user()); await claudeControls(f);
    f.send(user('x'.repeat(2048))); f.send(user('further declined'));
    const control = { type: 'control_response', response: { request_id: 'permission', subtype: 'success' } }; f.send(control);
    expect(f.sent.at(-1)).toEqual(control); expect(f.received.some((m) => m.type === 'result')).toBe(false);
    expect(errors).toContain('capacity (64 MiB) exceeded'); expect(errors).not.toContain('further declined');
  });

  it('removes encrypted queued transport files on native failure without launching held packets', async () => {
    const f = fixture('claude-code'); f.initialize(); f.send(user()); await claudeControls(f);
    for (let index = 0; index < 33; index++) f.send(user(`retained ${index}`));
    await tick(); const directory = f.spoolState().directory; expect(fs.readdirSync(directory).length).toBeGreaterThan(0);
    f.child.stdin.emit('error', new Error('native pipe failed')); await f.idle();
    expect(fs.existsSync(directory)).toBe(false); expect(f.spoolState().queuedBytes).toBe(0);
    expect(f.sent.filter((m) => m.type === 'user')).toHaveLength(1);
    expect(f.received.some((m) => m.type === 'result')).toBe(false);
  });

  it('allows Codex active additions only for exact native accepted configured pair', async () => {
    let d = decision(); const f = fixture('codex', { decide: () => d }); autoCodex(f);
    f.send(turn()); await f.idle();
    const steer = { id: 'steer', method: 'turn/steer', params: { threadId: 'existing-thread', expectedTurnId: 'accepted-native-turn', input: turn().params.input } };
    f.send(steer); await f.idle(); expect(f.received.at(-1).error.message).toContain('requires a new turn');
    f.respond({ id: 9, result: { turn: { id: 'accepted-native-turn' } } });
    f.send(steer); await f.idle(); expect(f.sent.at(-1)).toEqual(steer);
    d = { ...decision(), model: 'different-native' };
    const queue = { ...steer, id: 'queue', method: 'thread/queue/add' }; f.send(queue); await f.idle();
    expect(f.sent.at(-1)).toEqual(steer); expect(f.received.at(-1)).toMatchObject({ id: 'queue', error: { code: -32001 } });
    expect(f.receipts.find((r) => r.status === 'active-input-approved')).toMatchObject({ modelObserved: false, evidence: 'native-turn-start.accepted-configured-pair' });
    f.respond({ method: 'turn/completed', params: { threadId: 'existing-thread', turn: { id: 'accepted-native-turn' } } });
    d = decision(); f.send(steer); await f.idle(); expect(f.received.at(-1).error.message).toContain('requires a new turn');
  });

  it('fails before dispatch on receipt failure without falsely completing already dispatched work', async () => {
    const f = fixture('codex', { receipt: () => { throw new Error('receipt unavailable'); } }); autoCodex(f);
    f.send(turn()); await f.idle(); expect(f.sent.some((m) => m.method === 'turn/start')).toBe(false);
    let failReceipt = false;
    const g = fixture('claude-code', { receipt: (r) => { if (failReceipt && r.status === 'turn-forwarded') throw new Error('receipt lost after dispatch'); } });
    g.initialize(); g.send(user()); failReceipt = true; await claudeControls(g);
    expect(g.sent.some((m) => m.type === 'user')).toBe(true);
    expect(g.received.some((m) => m.type === 'result')).toBe(false);
    g.send(user('DEFERRED')); await tick(); g.child.stdin.emit('error', new Error('EPIPE')); await g.idle();
    expect(g.sent.filter((m) => m.type === 'user')).toHaveLength(1);
    expect(g.received.some((m) => m.type === 'result')).toBe(false);
  });

  it('Claude rejection and initialize timeout never submit a user prompt', async () => {
    const f = fixture('claude-code', { timeoutMs: 5 }); f.send(user()); await f.idle();
    expect(f.sent).toEqual([]); expect(f.received[0].is_error).toBe(true);
    const g = fixture('claude-code'); g.initialize(); g.send(user()); await until(() => g.sent.length === 2);
    g.respond({ type: 'control_response', response: { subtype: 'error', request_id: g.sent[1].request_id, error: 'native rejected' } });
    await g.idle(); expect(g.sent.some((msg) => msg.type === 'user')).toBe(false);
  });

  it('preserves bidirectional permission/control IDs and stops held work on native exit', async () => {
    const f = fixture('claude-code'); f.initialize();
    const permission = { type: 'control_request', request_id: 'native-tool-permission', request: { subtype: 'can_use_tool', input: { retain: true } } };
    f.respond(permission); expect(f.received.at(-1)).toEqual(permission);
    const approval = { type: 'control_response', response: { request_id: permission.request_id, subtype: 'success', response: { behavior: 'allow' } } };
    f.send(approval); expect(f.sent.at(-1)).toEqual(approval);
    f.send(user()); await until(() => f.sent.some((m) => m.request?.subtype === 'apply_flag_settings'));
    f.child.emit('exit', 0); await f.idle();
    expect(f.sent.some((msg) => msg.type === 'user')).toBe(false);
  });
});

describe('native gateway launch and privacy', () => {
  function executable() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-host-')); roots.push(root);
    const file = path.join(root, 'native'); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); return file; }
  it('uses explicit native executables and preserves flags while stripping metered environment', () => {
    const binary = executable(); const args = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'];
    const launch = nativeGatewayLaunch({ harness: 'codex', realBinary: binary, args,
      env: { HOME: '/retained', OPENAI_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'foreign' } });
    expect(launch.command).toBe(fs.realpathSync(binary)); expect(launch.args.slice(0, args.length)).toEqual(args);
    expect(launch.args.slice(-6)).toEqual(['-c', 'model_provider="openai"', '-c', 'service_tier="default"', '-c', 'features.fast_mode=false']);
    expect(launch.env).toEqual({ HOME: '/retained', MODEL_ROUTER_GATEWAY_ACTIVE: '1' });
    expect(() => nativeGatewayLaunch({ harness: 'codex', realBinary: binary, args, env: { MODEL_ROUTER_GATEWAY_ACTIVE: '1' } })).toThrow(/recursion/);
    expect(() => nativeGatewayLaunch({ harness: 'codex', realBinary: 'codex', args })).toThrow(/absolute/);
  });
  it('accepts the Claude wrapper real binary first and refuses incompatible transports', () => {
    const binary = executable(), args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--resume', 'retained-session'];
    expect(parseGatewayInvocation(['--harness', 'claude-code', '--executable', binary, '--', ...args], {})).toMatchObject({ harness: 'claude-code', realBinary: binary, args });
    expect(parseGatewayInvocation([binary, ...args], {})).toMatchObject({ harness: 'claude-code', realBinary: binary, args });
    expect(nativeGatewayLaunch({ harness: 'claude-code', realBinary: binary, args, env: {} }).args).toEqual(args);
    expect(() => nativeGatewayLaunch({ harness: 'claude-code', realBinary: binary, args: [] })).toThrow(/stream-json/);
  });
  it('validates provider/auth overlays without removing unrelated native settings', () => {
    const binary = executable(), codexArgs = ['app-server'];
    for (const setting of ['model_providers.openai.base_url="foreign"', 'model_providers={openai={base_url="foreign"}}', 'service_tier="priority"']) {
      expect(() => nativeGatewayLaunch({ harness: 'codex', realBinary: binary, args: [...codexArgs, '-c', setting], env: {} })).toThrow();
    }
    for (const arg of ['-cmodel_providers.openai.base_url="foreign"', '-c=model_providers.openai.base_url="foreign"', '--profile=unsafe']) {
      expect(() => nativeGatewayLaunch({ harness: 'codex', realBinary: binary, args: [...codexArgs, arg], env: {} })).toThrow();
    }
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    for (const settings of [{ apiKeyHelper: 'secret-helper' }, { env: { ANTHROPIC_BASE_URL: 'foreign' } }, { modelSettings: { native: { maxEffortLevel: 'low' } } }]) {
      expect(() => nativeGatewayLaunch({ harness: 'claude-code', realBinary: binary, args: [...args, '--settings', JSON.stringify(settings)], env: {} })).toThrow();
    }
    const safe = [...args, '--settings', JSON.stringify({ hooks: { SessionStart: [] }, permissions: { allow: ['Read'] } })];
    expect(nativeGatewayLaunch({ harness: 'claude-code', realBinary: binary, args: safe, env: {} }).args).toEqual(safe);
  });
  it('policy-only engine receives prompt on stdin, never args, and timeout is bounded', async () => {
    let actual;
    const fake = (_bin, args) => { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
      actual = { args, input: '' }; child.stdin.on('data', (data) => { actual.input += data; });
      child.stdin.on('finish', () => { child.stdout.write(JSON.stringify(decision())); child.emit('exit', 0); }); return child; };
    expect(await decideNativeTurn('SECRET PROMPT', 'codex', { spawnEngine: fake })).toEqual(decision());
    expect(actual.input).toBe('SECRET PROMPT'); expect(actual.args).not.toContain('SECRET PROMPT'); expect(actual.args).toContain('--policy-only');
  });
  it('retains owner-approved stale policy identity and refuses invalid selections through the real engine', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-policy-')); roots.push(root);
    const selection = { schemaVersion: 1, reviewedAt: new Date().toISOString(), routes: {
      codex: { fast: { model: 'gpt-native-fixture', effort: 'low' }, hard: { model: 'gpt-native-fixture', effort: 'high' } },
      'claude-code': { hard: { model: 'claude-native-fixture', effort: 'high' } },
    } };
    const profile = { harnesses: { codex: { available: true, subscription: true }, 'claude-code': { available: true, subscription: true } } };
    const candidates = [{ id: 'gpt-native-fixture', provider: 'openai', harness: ['codex'], subscription: ['codex'], tier: 'cheap' },
      { id: 'claude-native-fixture', provider: 'anthropic', harness: ['claude-code'], subscription: ['claude-code'], tier: 'frontier' }];
    fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ candidates }));
    fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify(profile));
    fs.writeFileSync(path.join(root, 'routing-policy.json'), JSON.stringify(selection));
    const env = { ...process.env, MODEL_ROUTER_CONFIG_DIR: root, MODEL_ROUTER_CATALOG: path.join(root, 'catalog.json'),
      MODEL_ROUTER_PROFILE: path.join(root, 'profile.json'), MODEL_ROUTER_SELECTION: path.join(root, 'routing-policy.json'),
      MODEL_ROUTER_DECISIONS: path.join(root, 'decisions.jsonl'), MODEL_ROUTER_ENGINE: path.resolve('scripts/model-router-engine.mjs') };
    const d = await decideNativeTurn('translate these fixture words', 'codex', { env });
    expect(d).toMatchObject({ model: 'gpt-native-fixture', effort: 'low', subscriptionCovered: true });
    expect(() => validateDispatchDecision(d, { selection, profile, candidates,
      nativeModels: [{ slug: d.model, supported_reasoning_levels: [{ effort: 'low' }] }] })).not.toThrow();
    expect(() => validateDispatchDecision(d, { selection, profile, candidates,
      nativeModels: [{ slug: d.model, supported_reasoning_levels: [{ effort: 'high' }] }] })).toThrow(/does not support/);
    for (const harness of ['codex', 'claude-code']) {
      const imageRoute = await decideNativeTurn('', harness, { env, multimodal: true });
      expect(imageRoute).toMatchObject({ taskClass: 'hard', effort: 'high', subscriptionCovered: true });
    }
    selection.reviewedAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(path.join(root, 'routing-policy.json'), JSON.stringify(selection));
    const retained = await decideNativeTurn('translate these fixture words', 'codex', { env });
    expect(retained).toMatchObject({ model: d.model, effort: d.effort, selectionReviewedAt: selection.reviewedAt,
      selectionRouteDigest: d.selectionRouteDigest, selectionEvidence: { reviewedAt: selection.reviewedAt, stale: true, routeDigest: d.selectionRouteDigest } });
    expect(JSON.parse(fs.readFileSync(env.MODEL_ROUTER_SELECTION, 'utf8'))).toEqual(selection);
    expect(() => validateDispatchDecision(retained, { selection, profile, candidates,
      nativeModels: [{ slug: d.model, supported_reasoning_levels: [{ effort: 'low' }] }] })).not.toThrow();
    expect(() => validateDispatchDecision(retained, { selection, profile, candidates,
      nativeModels: [{ slug: d.model, supported_reasoning_levels: [{ effort: 'high' }] }] })).toThrow(/does not support/);
    for (const invalid of [{ ...selection, reviewedAt: 'invalid' }, { ...selection, reviewedAt: '2999-01-01T00:00:00.000Z' },
      { ...selection, schemaVersion: 0 }, { ...selection, routes: [] }]) {
      fs.writeFileSync(env.MODEL_ROUTER_SELECTION, JSON.stringify(invalid));
      await expect(decideNativeTurn('translate these fixture words', 'codex', { env })).rejects.toThrow(/allocation unavailable/);
    }
    expect(fs.readFileSync(env.MODEL_ROUTER_DECISIONS, 'utf8')).not.toContain('fixture words');
  });

  it('requires image capability when the native host declares input modalities', () => {
    expect(() => verifyNativeVision(decision(), [{ slug: 'native-fixture', input_modalities: ['text'] }])).toThrow();
    expect(() => verifyNativeVision(decision(), [{ slug: 'native-fixture', input_modalities: ['text', 'image'] }])).not.toThrow();
    expect(() => verifyNativeVision(decision(), [{ slug: 'native-fixture' }])).not.toThrow();
  });

  it('durable receipt contains only supplied routing metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-receipt-')); roots.push(root);
    const file = path.join(root, 'receipt.jsonl'); appendGatewayReceipt({ model: 'fixture', effort: 'low', modelObserved: false, prompt: 'PRIVATE', reason: 'PRIVATE' }, { env: { MODEL_ROUTER_GATEWAY_RECEIPTS: file } });
    expect(JSON.parse(fs.readFileSync(file))).toEqual({ model: 'fixture', effort: 'low', modelObserved: false });
  });
});
