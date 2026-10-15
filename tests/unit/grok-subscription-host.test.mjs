import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { executeGrokSubscription, grokBillingReceipt, grokSubscriptionEnv,
  probeGrokSubscriptionNative, verifyGrokConfig } from '../../scripts/grok-subscription-host.mjs';

const auth = { _meta: { auth_mode: 'Oidc', subscription_tier: 'SuperGrok', gate: null,
  backend_billed: false, email: 'private@example.com', refresh_token: 'secret' } };
const billing = { subscription_tier: 'SuperGrok', config: {
  onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 } } };
const topup = { rule: { enabled: false } };
const models = { currentModelId: 'grok-test', availableModels: [{ modelId: 'grok-test',
  name: 'Test', _meta: { totalContextTokens: 256000, contextWindows: [256000, 500000],
    reasoningEffort: 'high', reasoningEfforts: [{ id: 'medium', value: 'medium' }] } }] };

function fixture({ initialBilling = billing, finalBilling = billing, controlMismatch = false,
  notifyBilling = false, onRequest = () => {}, retire = true, retirementDelay = 0 } = {}) {
  const requests = []; let child; let billingReads = 0;
  const controls = [{ id: 'model', currentValue: 'grok-test' }, { id: 'reasoning_effort', currentValue: 'medium' }];
  const launch = (_binary, args, options) => {
    expect(args).toEqual(['agent', '--no-leader', 'stdio']);
    expect(options.env.GROK_DISABLE_API_KEY_AUTH).toBe('1'); // sync-version-ignore: subscription-auth opt-out is the fixed environment protocol string
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdout.destroy = child.stderr.destroy = () => { child.pipesDestroyed = true; };
    child.kill = () => {
      child.killed = true;
      if (retire) {
        const complete = () => { child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL'); };
        if (retirementDelay) setTimeout(complete, retirementDelay); else queueMicrotask(complete);
      }
    };
    child.stdin = { write(line) {
      const m = JSON.parse(line); requests.push(m); onRequest(m, child);
      queueMicrotask(() => {
        let result;
        if (m.method === 'initialize') result = { authMethods: [{ id: 'cached_token' }],
          _meta: { modelState: models, agentVersion: 'test' } };
        else if (m.method === 'authenticate') result = auth;
        else if (m.method === '_x.ai/auth/check_subscription') result = { authenticated: true, meta: auth._meta };
        else if (m.method === '_x.ai/auto-topup-rule') result = topup;
        else if (m.method === '_x.ai/billing') result = ++billingReads >= 3 ? finalBilling : initialBilling;
        else if (m.method === 'session/new' || m.method === 'session/load') {
          if (m.method === 'session/load') child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0', method: 'session/update', params: { update: {
              sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARENT_REPLAY' } } } }) + '\n'));
          result = { sessionId: 'session-test', models };
        }
        else if (m.method === 'session/set_config_option') result = { configOptions: controlMismatch ? [] : controls };
        else if (m.method === '_x.ai/session/fork') result = { newSessionId: 'child-test',
          parentSessionId: m.params.sourceSessionId, chatMessagesCopied: 4 };
        else if (m.method === 'session/prompt') {
          if (notifyBilling) child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0',
            method: '_x.ai/billing/update', params: { config: { ...billing.config, prepaidBalance: { val: 10 } } } }) + '\n'));
          child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'session/update',
            params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'GROK_OK' } } } }) + '\n'));
          result = { stopReason: 'end_turn' };
        }
        child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n'));
      });
    } };
    return child;
  };
  return { options: { cwd: '/tmp/grok-fixture', binary: '/tmp/grok', launch,
    run: () => ({ status: 0, stdout: JSON.stringify({ loginPolicy: { apiKeyAuthDisabled: true },
      configSources: { layers: [{ path: '/tmp/config.toml' }] } }) }), read: () => '[models]\ndefault="grok-test"' },
  requests, killed: () => child?.killed, destroyed: () => child?.pipesDestroyed };
}

describe('Grok native subscription adapter', () => {
  it('strips credential and endpoint escapes without exposing account secrets', () => {
    const env = grokSubscriptionEnv({ XAI_API_KEY: 'x', GROK_API_KEY: 'g', GROK_MODELS_BASE_URL: 'bad', PATH: '/bin' });
    expect(env).not.toHaveProperty('XAI_API_KEY'); expect(env).not.toHaveProperty('GROK_API_KEY');
    expect(env).not.toHaveProperty('GROK_MODELS_BASE_URL'); expect(env.GROK_DISABLE_API_KEY_AUTH).toBe('1'); // sync-version-ignore: subscription-auth opt-out is the fixed environment protocol string
    const receipt = grokBillingReceipt(auth, billing, topup);
    expect(receipt.eligible).toBe(true); expect(JSON.stringify(receipt)).not.toMatch(/secret|private@/);
    expect(receipt.atomicReservation).toBe(false);
  });
  it('suppresses the blocking native desktop dictation hook only inside the background worker', () => {
    const parent = { PATH: '/bin', SUPERWHISPER_GROK_HOOK: '/Applications/desktop-hook' };
    expect(grokSubscriptionEnv(parent).SUPERWHISPER_GROK_HOOK).toBe('/dev/null');
    expect(parent.SUPERWHISPER_GROK_HOOK).toBe('/Applications/desktop-hook');
  });
  it.each(['onDemandCap', 'onDemandUsed', 'prepaidBalance'])('rejects nonzero or missing %s before inference', async (key) => {
    const f = fixture({ initialBilling: { ...billing, config: { ...billing.config, [key]: { val: 1 } } } });
    await expect(executeGrokSubscription({ ...f.options, model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('not verified');
    expect(f.requests.some((r) => r.method === 'session/prompt')).toBe(false); expect(f.killed()).toBe(true);
    expect(grokBillingReceipt(auth, { ...billing, config: {} }, topup).eligible).toBe(false);
  });
  it('rejects API billing and unverified auth', () => {
    expect(grokBillingReceipt({ _meta: { ...auth._meta, backend_billed: true } }, billing, topup).eligible).toBe(false);
    expect(grokBillingReceipt({ authenticated: false, meta: auth._meta }, billing, topup).eligible).toBe(false);
  });
  it('matches native successful absent-rule semantics without accepting malformed or enabled top-ups', () => {
    for (const rule of [{}, { rule: null }, { rule: {} }, { rule: { enabled: false } }]) {
      expect(grokBillingReceipt(auth, billing, rule).eligible).toBe(true);
    }
    for (const rule of [undefined, null, [], { raw: 'invalid' }, { rule: 'false' }, { rule: { enabled: true } }]) {
      expect(grokBillingReceipt(auth, billing, rule).eligible).toBe(false);
    }
  });
  it('rejects per-model credential config and inactive API prohibition', () => {
    const f = fixture();
    expect(() => verifyGrokConfig({ ...f.options, env: process.env, read: () => '[model.bad]\napi_key="secret"' })).toThrow('Custom Grok');
    expect(() => verifyGrokConfig({ ...f.options, env: {}, run: () => ({ status: 0, stdout: '{}' }) })).toThrow('prohibition');
  });
  it('probes actual auth/billing without a prompt and always closes native process', async () => {
    const f = fixture(); const result = await probeGrokSubscriptionNative(f.options);
    expect(result).toMatchObject({ eligible: true, plan: 'SuperGrok', inferenceTested: false });
    expect(result.models[0]).toMatchObject({ model: 'grok-test', contextWindow: 256000, efforts: ['medium'] });
    expect(f.requests.some((r) => r.method === 'session/prompt')).toBe(false); expect(f.killed()).toBe(true);
  });
  it('binds model/effort and native fork lineage, checks billing immediately before and after prompt', async () => {
    const f = fixture(); const r = await executeGrokSubscription({ ...f.options, model: 'grok-test', effort: 'medium',
      prompt: 'test', parentSessionId: 'parent-test', parentCwd: '/tmp/parent', contextWindow: 256000 });
    expect(r).toMatchObject({ output: 'GROK_OK', completed: true, model: 'grok-test', effort: 'medium', contextWindow: 256000,
      fork: { parentSessionId: 'parent-test', newSessionId: 'child-test', chatMessagesCopied: 4 } });
    expect(f.requests.filter((x) => x.method === '_x.ai/billing')).toHaveLength(3);
    expect(f.requests.find((x) => x.method === 'session/prompt').params.sessionId).toBe('child-test');
    expect(f.killed()).toBe(true);
  });
  it('refuses unsupported context/thread controls and mismatched receipts', async () => {
    const f = fixture();
    await expect(executeGrokSubscription({ ...f.options, model: 'grok-test', effort: 'medium', prompt: 'test', contextWindow: 500000 })).rejects.toThrow('refusing substitution');
    expect(f.requests.some((x) => x.method === 'session/prompt')).toBe(false);
    await expect(executeGrokSubscription({ ...f.options, model: 'grok-test', effort: 'medium', prompt: 'test', workerThreads: 2 })).rejects.toThrow('thread');
    const mismatch = fixture({ controlMismatch: true });
    await expect(executeGrokSubscription({ ...mismatch.options, model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('receipt mismatch');
  });
  it('fails receipt if paid credits change after inference', async () => {
    const f = fixture({ finalBilling: { ...billing, config: { ...billing.config, prepaidBalance: { val: 1 } } } });
    await expect(executeGrokSubscription({ ...f.options, model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('changed');
    expect(f.killed()).toBe(true);
  });
  it('kills inference immediately when a billing notification changes paid-credit state', async () => {
    const f = fixture({ notifyBilling: true });
    await expect(executeGrokSubscription({ ...f.options, model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('paid-credit state changed');
    expect(f.killed()).toBe(true);
  });
  it.each([
    '[model.bad]\n"api_key"="secret"', 'model.bad.api_key="secret"',
    '[model.bad]\n\'base_url\'="https://invalid"',
    'model = { bad = { api_key = "secret" } }',
    '[model.bad]\n"api\\u005fkey"="secret"',
  ])('rejects semantic credential keys in every TOML spelling: %s', (config) => {
    expect(() => verifyGrokConfig({ ...fixture().options, env: process.env, read: () => config })).toThrow('Custom Grok');
  });
  it('fails closed on malformed TOML or unavailable trusted parser', () => {
    const f = fixture();
    expect(() => verifyGrokConfig({ ...f.options, env: process.env, read: () => '[invalid' })).toThrow('TOML');
    expect(() => verifyGrokConfig({ ...f.options, env: process.env,
      parseRun: () => ({ status: null, error: new Error('missing') }) })).toThrow('TOML');
  });
  it('never inspects, launches or prompts when already aborted', async () => {
    const controller = new AbortController(); controller.abort(); const f = fixture(); let inspected = false;
    await expect(executeGrokSubscription({ ...f.options, signal: controller.signal,
      run: () => { inspected = true; }, model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('aborted');
    expect(inspected).toBe(false); expect(f.requests).toHaveLength(0);
    expect(await probeGrokSubscriptionNative({ ...f.options, signal: controller.signal })).toMatchObject({ eligible: false });
  });
  it('kills and retires a worker aborted while its prompt is pending', async () => {
    const controller = new AbortController();
    const f = fixture({ onRequest: (m) => { if (m.method === 'session/prompt') controller.abort(); } });
    await expect(executeGrokSubscription({ ...f.options, signal: controller.signal,
      model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('aborted');
    expect(f.killed()).toBe(true); expect(f.destroyed()).toBe(true);
    expect(f.requests.filter((r) => r.method === '_x.ai/billing')).toHaveLength(2);
  });
  it('counts synchronous inspection time against the same deadline before native launch', async () => {
    const f = fixture();
    await expect(executeGrokSubscription({ ...f.options, timeoutMs: 10,
      run: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); return f.options.run(); },
      model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('deadline');
    expect(f.requests).toHaveLength(0);
  });
  it('delivers cancellation queued during synchronous inspection before native launch', async () => {
    const controller = new AbortController(); const f = fixture();
    await expect(executeGrokSubscription({ ...f.options, signal: controller.signal,
      run: () => { setTimeout(() => controller.abort(), 0); return f.options.run(); },
      model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('aborted');
    expect(f.requests).toHaveLength(0);
  });
  it('rejects a late prompt response even when the timer callback has not run', async () => {
    const f = fixture({ onRequest: (m) => { if (m.method === 'session/prompt') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    } } });
    await expect(executeGrokSubscription({ ...f.options, timeoutMs: 120,
      model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('deadline');
    expect(f.killed()).toBe(true);
  });
  it('requires confirmed retirement and destroys pipes before reporting success', async () => {
    const f = fixture({ retire: false });
    await expect(executeGrokSubscription({ ...f.options, retirementMs: 10,
      model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('retirement not confirmed');
    expect(f.killed()).toBe(true); expect(f.destroyed()).toBe(true);
    const probe = fixture({ retire: false });
    expect(await probeGrokSubscriptionNative({ ...probe.options, retirementMs: 10 })).toMatchObject({
      eligible: false, reason: 'Grok native process retirement not confirmed' });
  });
  it('does not report success when cleanup exceeds the original deadline', async () => {
    const f = fixture({ retirementDelay: 200 });
    await expect(executeGrokSubscription({ ...f.options, timeoutMs: 150,
      model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('deadline');
    expect(f.destroyed()).toBe(true);
  });

  it('applies the original deadline to postflight without returning a completed receipt', async () => {
    let reads = 0;
    const f = fixture({ onRequest: (m) => { if (m.method === '_x.ai/billing' && ++reads === 3) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    } } });
    await expect(executeGrokSubscription({ ...f.options, timeoutMs: 120,
      model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('deadline');
    expect(f.requests.some((r) => r.method === 'session/prompt')).toBe(true);
    expect(f.killed()).toBe(true);
  });
  it('preserves a valid config string mentioning api_key and never leaks malformed inspection data', () => {
    const f = fixture();
    expect(verifyGrokConfig({ ...f.options, env: process.env,
      read: () => 'description="api_key=example" # harmless text' }).apiKeyAuthDisabled).toBe(true);
    expect(() => verifyGrokConfig({ ...f.options, run: () => ({ status: 0, stdout: 'private-secret' }) }))
      .toThrow('Grok configuration inspection is invalid');
  });

  it('bounds retirement when kill throws, destroys every pipe and releases loop references without unhandled rejections', async () => {
    const cleanup = []; const unhandled = [];
    const listener = (error) => unhandled.push(error);
    process.on('unhandledRejection', listener);
    const f = fixture({ retire: false, onRequest: (_m, child) => {
      child.kill = () => { throw new Error('kill denied fixture'); };
      child.unref = () => { cleanup.push('child-unref'); };
      for (const [name, pipe] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]]) {
        pipe.destroy = () => { cleanup.push(name + '-destroy'); };
        pipe.unref = () => { cleanup.push(name + '-unref'); };
      }
    } });
    try {
      await expect(executeGrokSubscription({ ...f.options, retirementMs: 10,
        model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toMatchObject({
        message: 'Grok native process retirement not confirmed', retirementUnconfirmed: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(cleanup).toEqual(['stdin-destroy', 'stdout-destroy', 'stderr-destroy',
        'child-unref', 'stdin-unref', 'stdout-unref', 'stderr-unref']);
      expect(unhandled).toHaveLength(0);
    } finally { process.removeListener('unhandledRejection', listener); }
  });
  it('attempts all cleanup actions even when one pipe throws and cannot return success', async () => {
    const attempted = [];
    const f = fixture({ onRequest: (_m, child) => {
      child.stdin.destroy = () => { attempted.push('stdin'); throw new Error('destroy failed fixture'); };
      child.stdout.destroy = () => { attempted.push('stdout'); };
      child.stderr.destroy = () => { attempted.push('stderr'); };
    } });
    await expect(executeGrokSubscription({ ...f.options,
      model: 'grok-test', effort: 'medium', prompt: 'test' })).rejects.toThrow('Grok native cleanup failed');
    expect(attempted).toEqual(['stdin', 'stdout', 'stderr']);
  });

});
