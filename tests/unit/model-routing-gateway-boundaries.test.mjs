import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { connectNativeGateway } from '../../scripts/model-routing-gateway.mjs';
const gateways = [];
afterEach(() => { for (const g of gateways.splice(0)) g.close(); });
const decision = () => ({ harness: 'codex', model: 'native-fixture', effort: 'high', taskClass: 'hard', subscriptionCovered: true });
const turn = () => ({ id: 9, method: 'turn/start', params: { threadId: 'existing-thread', input: [{ type: 'text', text: 'PRIVATE PROMPT' }] } });
function lines(stream, collect) {
  let buffer = '';
  stream.on('data', (b) => { buffer += b; let at;
    while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); collect(JSON.parse(line)); }
  });
}
function fixture(harness, options = {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough(), sent = [], received = [], receipts = [];
  lines(child.stdin, (m) => sent.push(m)); lines(output, (m) => received.push(m));
  const gateway = connectNativeGateway({ harness, child, input, output, diagnostics, timeoutMs: 40,
    decide: decision, verifyDecision: () => {}, receipt: (r) => receipts.push(r), ...options }); gateways.push(gateway);
  const respond = (m) => child.stdout.write(JSON.stringify(m) + '\n');
  return { ...gateway, child, input, sent, received, receipts, respond,
    send: (m) => input.write(JSON.stringify(m) + '\n'), reply: (m, result) => respond({ id: m.id, result }) };
}
function autoCodex(f) {
  f.child.stdin.on('data', (b) => {
    const m = JSON.parse(b.toString());
    if (m.method === 'account/read') f.reply(m, { account: { type: 'chatgpt' } });
    if (m.method === 'config/read') f.reply(m, { config: { model_provider: 'openai', openai_base_url: null } });
    if (m.method === 'thread/read') f.reply(m, { thread: { id: m.params.threadId, modelProvider: 'openai', cwd: '/tmp' } });
    if (m.method === 'account/rateLimits/read') f.reply(m, { ordinaryUsageAllowed: true });
  });
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
describe('native gateway shared-backend and disconnect boundaries', () => {
  it.each(['serviceTier', 'service_tier', 'serviceTierForTurn', 'service_tier_for_turn'])('rejects explicit priority %s before any turn or settings mutation reaches the backend', async (key) => {
    const f = fixture('codex'); autoCodex(f);
    for (const message of [
      { ...turn(), params: { ...turn().params, [key]: 'priority' } },
      { id: 'thread', method: 'thread/start', params: { [key]: 'priority' } },
      { id: 'config', method: 'thread/resume', params: { config: { [key]: 'priority' } } },
      { id: 'settings', method: 'turn/settings/update', params: { [key]: 'priority' } },
      { id: 'write', method: 'config/value/write', params: { keyPath: key, value: 'priority' } },
      { id: 'batch', method: 'config/batchWrite', params: { edits: [{ keyPath: key, value: 'priority' }] } },
    ]) f.send(message);
    await f.idle();
    expect(f.sent).toEqual([]); expect(f.received).toHaveLength(6);
    expect(f.received.every((m) => m.error?.code === -32001)).toBe(true);
    expect(f.receipts.some((r) => r.status === 'turn-forwarded')).toBe(false);
  });

  it.each([null, 'default'])('normalizes an accepted native serviceTierForTurn %s to standard', async (serviceTierForTurn) => {
    const f = fixture('codex'); autoCodex(f);
    const request = turn(); request.params.serviceTierForTurn = serviceTierForTurn;
    f.send(request); await f.idle();
    expect(f.sent.at(-1)).toMatchObject({ method: 'turn/start', params: { serviceTier: 'default', serviceTierForTurn: 'default' } });
  });

  it('checks project-layer configuration at the actual thread cwd and preserves an explicit turn cwd', async () => {
    for (const override of [undefined, '/tmp/override-project']) {
      const f = fixture('codex');
      f.child.stdin.on('data', (chunk) => {
        const m = JSON.parse(chunk.toString());
        if (m.method === 'account/read') f.reply(m, { account: { type: 'chatgpt' } });
        if (m.method === 'thread/read') f.reply(m, { thread: { id: m.params.threadId, modelProvider: 'openai', cwd: '/tmp/thread-project' } });
        if (m.method === 'config/read') f.reply(m, { config: { model_provider: null, chatgpt_base_url: 'https://chatgpt.com/backend-api/' } });
        if (m.method === 'account/rateLimits/read') f.reply(m, { ordinaryUsageAllowed: true });
      });
      const request = turn(); if (override) request.params.cwd = override;
      f.send(request); await f.idle();
      expect(f.sent.find((m) => m.method === 'config/read').params.cwd).toBe(override ?? '/tmp/thread-project');
      expect(f.sent.findIndex((m) => m.method === 'thread/read')).toBeLessThan(f.sent.findIndex((m) => m.method === 'config/read'));
      expect(f.sent.at(-1).method).toBe('turn/start');
    }
  });
  it('requires actual backend canonical provider and thread provider before every new turn', async () => {
    for (const variant of ['custom-provider', 'custom-openai-endpoint', 'flattened-endpoint', 'base-url-override', 'chatgpt-endpoint', 'foreign-thread', 'unknown-provider']) {
      const f = fixture('codex');
      f.child.stdin.on('data', (chunk) => {
        const m = JSON.parse(chunk.toString());
        if (m.method === 'account/read') f.reply(m, { account: { type: 'chatgpt' } });
        if (m.method === 'config/read') f.reply(m, { config: {
          model_provider: variant === 'custom-provider' ? 'foreign' : variant === 'unknown-provider' ? 'unknown' : 'openai',
          ...(variant === 'custom-openai-endpoint' ? { model_providers: { openai: { base_url: 'https://untrusted.invalid', api_key: 'PRIVATE' } } } : {}),
          ...(variant === 'flattened-endpoint' ? { 'model_providers.openai.base_url': 'https://untrusted.invalid' } : {}),
          ...(variant === 'base-url-override' ? { openai_base_url: 'https://untrusted.invalid' } : {}),
          ...(variant === 'chatgpt-endpoint' ? { chatgpt_base_url: 'https://untrusted.invalid' } : {}),
        } });
        if (m.method === 'thread/read') f.reply(m, { thread: { id: m.params.threadId, modelProvider: variant === 'foreign-thread' ? 'foreign' : 'openai', cwd: '/tmp' } });
        if (m.method === 'account/rateLimits/read') f.reply(m, { ordinaryUsageAllowed: true });
      });
      f.send(turn()); await f.idle();
      expect(f.sent.some((m) => m.method === 'turn/start')).toBe(false);
      expect(f.received.at(-1)).toMatchObject({ id: 9, error: { code: -32001 } });
      expect(JSON.stringify(f.receipts) + JSON.stringify(f.received)).not.toContain('PRIVATE');
    }
  });

  it('overrides inherited daemon priority and Fast with both native standard turn fields', async () => {
    const f = fixture('codex');
    f.child.stdin.on('data', (chunk) => {
      const m = JSON.parse(chunk.toString());
      if (m.method === 'account/read') f.reply(m, { account: { type: 'chatgpt' } });
      if (m.method === 'config/read') f.reply(m, { config: { model_provider: null, service_tier: 'priority',
        features: { fast_mode: true }, chatgpt_base_url: 'https://chatgpt.com/backend-api/' } });
      if (m.method === 'thread/read') f.reply(m, { thread: { id: m.params.threadId, modelProvider: 'openai', cwd: '/tmp' } });
      if (m.method === 'account/rateLimits/read') f.reply(m, { ordinaryUsageAllowed: true });
    });
    f.send(turn()); await f.idle();
    expect(f.sent.at(-1)).toMatchObject({ method: 'turn/start', params: { serviceTier: 'default', serviceTierForTurn: 'default' } });
    expect(f.receipts).toContainEqual(expect.objectContaining({ status: 'turn-forwarded', serviceMode: 'standard', allowanceVerified: true }));
  });

  it('binds steering to exact accepted native turn ID and ignores unrelated completions', async () => {
    const f = fixture('codex'); autoCodex(f); f.send(turn()); await f.idle();
    f.respond({ id: 9, result: { turn: { id: 'active-native-turn' } } });
    const steer = { id: 'steer', method: 'turn/steer', params: { threadId: 'existing-thread', expectedTurnId: 'active-native-turn', input: turn().params.input } };
    for (const expectedTurnId of [undefined, 'stale-native-turn']) {
      f.send({ ...steer, params: { ...steer.params, expectedTurnId } }); await f.idle();
      expect(f.sent.filter((m) => m.method === 'turn/steer')).toHaveLength(0);
    }
    f.respond({ method: 'turn/completed', params: { threadId: 'existing-thread', turn: { id: 'older-native-turn' } } });
    f.send(steer); await f.idle(); expect(f.sent.at(-1)).toEqual(steer);
    f.respond({ method: 'turn/completed', params: { threadId: 'existing-thread', turn: { id: 'active-native-turn' } } });
    f.send(steer); await f.idle(); expect(f.sent.filter((m) => m.method === 'turn/steer')).toHaveLength(1);
  });

  it('refuses every unqualified inference surface while retaining non-inference controls', () => {
    const f = fixture('codex');
    const refused = ['review/start', 'thread/queue/add', 'thread/queue/update', 'thread/queue/start', 'thread/realtime/start',
      'thread/realtime/appendAudio', 'thread/realtime/appendSpeech', 'thread/realtime/appendText', 'thread/goal/set',
      'thread/goal/create', 'thread/goal/resume', 'thread/compact/start', 'turn/addUserMessage', 'thread/startAeon'];
    for (const method of refused) f.send({ id: method, method, params: { private: 'PRIVATE' } });
    expect(f.sent).toEqual([]); expect(f.received.map((m) => m.id)).toEqual(refused);
    expect(JSON.stringify(f.received)).not.toContain('PRIVATE');
    const allowed = ['thread/queue/list', 'thread/queue/delete', 'thread/realtime/stop', 'turn/interrupt'];
    for (const method of allowed) f.send({ id: method, method, params: {} });
    expect(f.sent.map((m) => m.method)).toEqual(allowed);
  });

  it.each(['end', 'error'])('client %s immediately cancels pending work without shutting down shared backend', async (event) => {
    let resolve; const f = fixture('codex', { decide: () => new Promise((r) => { resolve = r; }) });
    autoCodex(f); f.send(turn()); await tick();
    if (event === 'end') f.input.end(); else f.input.emit('error', new Error('private transport error'));
    await f.idle(); resolve(decision()); await tick();
    expect(f.sent).toEqual([]); expect(f.child.stdin.writableEnded).toBe(true);
    expect(f.receipts.some((r) => r.status === 'turn-forwarded')).toBe(false);
  });

});
