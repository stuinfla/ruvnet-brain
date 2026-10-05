import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { controlledClaudeArguments, runControlledClaudeTurn, launchControlledClaudeTerminal, retireControlledClaudeChild, assertClaudeModuleBoundary } from '../../scripts/claude-controlled-terminal.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const decision = { harness: 'claude-code', provider: 'anthropic', subscriptionCovered: true,
  model: 'claude-native-fixture', effort: 'high', taskClass: 'hard' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
  const child = new EventEmitter(), sent = [], receipts = [], outputs = [], launches = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', 1)); };
  const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString()); sent.push(message);
    queueMicrotask(() => {
      if (message.type === 'control_request') {
        const applied = overrides.settings?.(message, sent) || { model: decision.model, effort: decision.effort };
        emit({ type: 'control_response', response: { subtype: overrides.controlError ? 'error' : 'success', request_id: message.request_id,
          response: message.request.subtype === 'initialize' ? {} : { applied, sources: overrides.sources || [] } } });
      }
      if (message.type === 'user') {
        if (overrides.workerCrash) return child.emit('close', 1);
        if (overrides.tool) emit({ type: 'control_request', request_id: 'tool-approval', request: {
          subtype: 'can_use_tool', tool_name: overrides.toolName || 'Bash', input: { command: 'fixture-command' } } });
        else finish();
      }
      if (message.type === 'control_response') finish();
    });
    callback();
  }, final(callback) { callback(); queueMicrotask(() => child.emit('close', overrides.exitCode || 0)); } });
  function finish() {
    emit({ type: 'assistant', session_id: sessionId, message: { model: overrides.observedModel || decision.model,
      content: [{ type: 'text', text: 'native answer' }] } });
    emit({ type: 'result', session_id: overrides.resultSession || sessionId, subtype: overrides.resultSubtype || 'success',
      permission_denials: overrides.denials || [] });
  }
  const options = { binary: '/native/claude', prompt: 'private prompt', sessionId, env: { ANTHROPIC_API_KEY: 'never-forward', PATH: '/native' },
    decide: async () => decision, verifyDecision: () => {}, checkSettings: () => {}, checkAuth: () => {}, checkModules: () => {},
    spawnNative: (binary, args, options) => { launches.push({ binary, args, options }); return child; },
    output: text => outputs.push(text), receipt: value => receipts.push(value), ...overrides.options };
  return { child, sent, receipts, outputs, launches, options };
}

describe('controlled Claude native turn boundary', () => {
  it('preserves classic plugin integration and refuses native modules in default or declared hook files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-module-boundary-'));
    const plugin = path.join(root, 'plugin');
    const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    const settings = { enabledPlugins: { 'brain@fixture': true } }, env = { CLAUDE_CONFIG_DIR: root };
    const manifest = path.join(plugin, '.claude-plugin', 'plugin.json'), hooks = path.join(plugin, 'hooks', 'hooks.json');
    try {
      save(path.join(root, 'plugins', 'installed_plugins.json'), { plugins: { 'brain@fixture': [{ installPath: plugin }] } });
      save(path.join(root, 'plugins', 'known_marketplaces.json'), { fixture: { installLocation: path.join(root, 'marketplace') } });
      save(path.join(root, 'marketplace', '.claude-plugin', 'marketplace.json'), { plugins: [{ name: 'brain', strict: false }] });
      save(manifest, { name: 'brain', hooks: './custom-hooks.json' });
      save(hooks, { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'classic-hook' }] }] } });
      expect(() => assertClaudeModuleBoundary(settings, { env, sessionId })).not.toThrow();
      save(hooks, { modules: ['./rewrite.js'] }); expect(() => assertClaudeModuleBoundary(settings, { env, sessionId })).toThrow(/refused/);
      save(hooks, {}); save(path.join(plugin, 'custom-hooks.json'), { modules: ['./rewrite.js'] });
      expect(() => assertClaudeModuleBoundary(settings, { env, sessionId })).toThrow(/refused/);
      save(manifest, { hooks: ['./custom-hooks.json'] });
      expect(() => assertClaudeModuleBoundary(settings, { env, sessionId })).toThrow(/refused/);
      save(manifest, { hooks: { modules: ['inline'] } });
      expect(() => assertClaudeModuleBoundary(settings, { env, sessionId })).toThrow(/refused/);
      save(manifest, {}); save(path.join(plugin, 'custom-hooks.json'), {}); save(path.join(plugin, 'plugin.json'), { hooks: { modules: ['root-manifest'] } });
      expect(() => assertClaudeModuleBoundary(settings, { env, sessionId })).toThrow(/refused/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses restored dev modules and allocation overrides in native effective settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dev-mod-boundary-'));
    const options = { env: { CLAUDE_CONFIG_DIR: root }, sessionId };
    try {
      for (const key of ['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_PLUGIN_SEED_DIR', 'CLAUDE_CODE_USE_COWORK_PLUGINS', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_EXTRA_BODY']) {
        expect(() => assertClaudeModuleBoundary({ env: { [key]: 'override' } }, options)).toThrow(/refused/);
      }
      const mods = path.join(root, 'dev-mods', sessionId); fs.mkdirSync(mods, { recursive: true }); fs.writeFileSync(path.join(mods, 'mod.js'), 'fixture');
      expect(() => assertClaudeModuleBoundary({}, options)).toThrow(/refused/);
      fs.rmSync(mods, { recursive: true });
      const restored = path.join(root, 'restored'); fs.mkdirSync(restored); fs.writeFileSync(path.join(restored, 'mod.js'), 'fixture');
      const transcripts = path.join(root, 'projects', 'fixture'); fs.mkdirSync(transcripts, { recursive: true });
      fs.writeFileSync(path.join(transcripts, `${sessionId}.jsonl`), JSON.stringify({ type: 'dev-mods', folder: restored }) + '\n');
      expect(() => assertClaudeModuleBoundary({}, options)).toThrow(/refused/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('observes native settings before prompt and actual assistant identity before success, then resumes the same session', async () => {
    const f = fixture(); const result = await runControlledClaudeTurn(f.options);
    expect(f.sent.map(m => m.request?.subtype || m.type)).toEqual(['initialize', 'get_settings', 'user', 'get_settings']);
    expect(f.launches[0].args).toContain('--model'); expect(f.launches[0].args).toContain('--effort');
    expect(f.launches[0].args).not.toContain('--safe-mode');
    expect(f.launches[0].args).toContain('--session-id'); expect(f.launches[0].args).not.toContain('private prompt');
    expect(f.launches[0].options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result).toMatchObject({ sessionId, modelObserved: true, effortSettingsObserved: true, perRequestEffortObserved: false });
    expect(f.receipts.at(-1)).toMatchObject({ status: 'completed', modelObserved: true });
    expect(JSON.stringify(f.receipts)).not.toContain('private prompt');
    expect(f.outputs).toEqual(['native answer']);
    const next = fixture(); await runControlledClaudeTurn({ ...next.options, resume: true });
    expect(next.launches[0].args).toContain('--resume'); expect(next.launches[0].args).not.toContain('--session-id');
    expect(next.sent.find(m => m.type === 'user').session_id).toBe(sessionId);
  });

  it.each(['low', null])('refuses applied effort %s before forwarding a prompt', async effort => {
    const f = fixture({ settings: () => ({ model: decision.model, effort }) });
    await expect(runControlledClaudeTurn(f.options)).rejects.toThrow(/refused/);
    expect(f.sent.some(m => m.type === 'user')).toBe(false); expect(f.child.killed).toBe(true);
  });

  it('rejects native settings control failure and policy changes during startup without forwarding', async () => {
    const f = fixture({ controlError: true }); await expect(runControlledClaudeTurn(f.options)).rejects.toThrow(/refused/);
    expect(f.sent.some(m => m.type === 'user')).toBe(false);
    let checked = 0;
    const g = fixture({ options: { verifyDecision: () => { if (++checked === 2) throw Error('allocation changed'); } } });
    await expect(runControlledClaudeTurn(g.options)).rejects.toThrow(/refused/);
    expect(g.sent.some(m => m.type === 'user')).toBe(false);
    const h = fixture({ sources: [{ source: 'policySettings', settings: { managed: true } }] });
    await expect(runControlledClaudeTurn(h.options)).rejects.toThrow(/refused/);
    expect(h.sent.some(m => m.type === 'user')).toBe(false);
  });

  it.each([{ observedModel: 'wrong-model' }, { resultSession: 'different-session' }, { resultSubtype: 'error_during_execution' },
    { workerCrash: true }, { exitCode: 1 }, { denials: [{ tool_name: 'Bash' }] },
    { settings: (_m, sent) => ({ model: decision.model, effort: sent.some(m => m.type === 'user') ? 'low' : decision.effort }) }])(
    'fails closed on worker execution or post-turn proof failure %#', async overrides => {
      const f = fixture(overrides); await expect(runControlledClaudeTurn(f.options)).rejects.toThrow(/refused/);
      expect(f.receipts.some(r => r.status === 'completed')).toBe(false);
    });

  it('requires a real host tool approval and never escalates native permission mode', async () => {
    const requests = [];
    const f = fixture({ tool: true, options: { approve: async request => { requests.push(request); return true; } } });
    await runControlledClaudeTurn(f.options);
    expect(requests[0]).toMatchObject({ tool_name: 'Bash', input: { command: 'fixture-command' } });
    expect(f.sent.find(m => m.type === 'control_response').response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'fixture-command' } });
    expect(f.launches[0].args).toContain('manual'); expect(f.launches[0].args.join(' ')).not.toMatch(/skip-permissions|bypassPermissions/);
    expect(f.launches[0].args).toContain('Agent,Task');
    expect(f.launches[0].args).toContain('--permission-prompt-tool'); expect(f.launches[0].args).toContain('stdio');
    const g = fixture({ tool: true }); await runControlledClaudeTurn(g.options);
    expect(g.sent.find(m => m.type === 'control_response').response.response.behavior).toBe('deny');
  });

  it.each(['Agent', 'Task'])('refuses unqualified native %s workers even if the host would approve', async toolName => {
    let approvalAttempt = false;
    const f = fixture({ tool: true, toolName, options: { approve: async () => { approvalAttempt = true; return true; } } });
    await expect(runControlledClaudeTurn(f.options)).rejects.toThrow(/refused/);
    expect(approvalAttempt).toBe(false);
    expect(f.sent.some(m => m.type === 'control_response')).toBe(false);
  });

  it('times out a native worker with no proof and aborts without a completed receipt', async () => {
    const f = fixture(); f.child.stdin = new PassThrough();
    await expect(runControlledClaudeTurn({ ...f.options, handshakeMs: 10 })).rejects.toThrow(/refused/);
    expect(f.child.killed).toBe(true); expect(f.receipts).toEqual([]);
    const g = fixture(); g.child.stdin = new PassThrough(); const controller = new AbortController();
    const pending = runControlledClaudeTurn({ ...g.options, signal: controller.signal }); await tick(); controller.abort();
    await expect(pending).rejects.toThrow(/refused/); expect(g.child.killed).toBe(true);
  });

  it('bounds retirement even when the directly owned child ignores TERM and never emits close', async () => {
    const child = new EventEmitter(), signals = [];
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { signals.push(signal); }; child.unref = () => { child.unreferenced = true; };
    await retireControlledClaudeChild(child, { graceMs: 5, killMs: 5 });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']); expect(child.unreferenced).toBe(true);
    expect([child.stdin, child.stdout, child.stderr].every(s => s.destroyed)).toBe(true);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('ignores a late permission answer after overlapping native requests force retirement', async () => {
    let approve;
    const f = fixture({ tool: true, options: { approve: () => new Promise(resolve => { approve = resolve; }) } });
    const pending = runControlledClaudeTurn(f.options); await tick();
    f.child.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'second', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }) + '\n');
    await expect(pending).rejects.toThrow(/refused/); approve(true); await tick();
    expect(f.sent.some(m => m.type === 'control_response')).toBe(false);
    expect(f.receipts.some(r => r.status === 'completed')).toBe(false);
  });

  it('auth checks the exact native binary and rejects inference overrides or slash commands', async () => {
    const calls = [];
    const f = fixture({ options: { checkAuth: (_h, options) => options.probe('claude', ['auth', 'status', '--json'], {}),
      probe: (...args) => calls.push(args) } }); await runControlledClaudeTurn(f.options);
    expect(calls[0][0]).toBe('/native/claude');
    for (const options of [{ prompt: '/model opus' }, { env: { CLAUDE_CODE_EXTRA_BODY: '{}' } }, { env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } }]) {
      const g = fixture(); await expect(runControlledClaudeTurn({ ...g.options, ...options })).rejects.toThrow(/refused/);
      expect(g.launches).toEqual([]);
    }
  });

  it('terminal entry accepts only explicit resume and requires human input; no implicit permission bypass', async () => {
    for (const args of [['--dangerously-skip-permissions'], ['--model', 'opus'], ['--continue'], ['--resume', 'invalid'],
      ['--permission-mode'], ['--permission-mode', 'manual'], ['--permission-mode=bypassPermissions'],
      ['--permission-mode', 'bypassPermissions', '--permission-mode', 'bypassPermissions']]) {
      await expect(launchControlledClaudeTerminal({ args })).rejects.toThrow(/only --resume/);
    }
    await expect(launchControlledClaudeTerminal({ args: ['--resume', sessionId], input: { isTTY: false }, output: { isTTY: true } })).rejects.toThrow(/person/);
    expect(() => controlledClaudeArguments({ ...decision, subscriptionCovered: false }, sessionId)).toThrow(/refused/);
  });

  it.each([['--permission-mode', 'bypassPermissions'], ['--permission-mode', 'bypassPermissions', '--resume', sessionId],
    ['--resume', sessionId, '--permission-mode', 'bypassPermissions']].map(flags => ({ flags })))(
    'honours the exact owner bypass flag at the host while preserving resume and worker refusal %#', async ({ flags }) => {
      const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
      input.isTTY = true; output.isTTY = true;
      let messages = '', observed;
      diagnostics.on('data', chunk => { messages += chunk; });
      await expect(launchControlledClaudeTerminal({ args: [...flags, 'literal initial prompt'], input, output, diagnostics,
        runTurn: async options => {
          observed = options;
          expect(await options.approve({ tool_name: 'Write', input: {} })).toBe(true);
          expect(await options.approve({ tool_name: 'Agent', input: {} })).toBe(false);
          expect(await options.approve({ tool_name: 'Task', input: {} })).toBe(false);
          throw Error('fixture-stop');
        } })).rejects.toThrow('fixture-stop');
      expect(observed.prompt).toBe('literal initial prompt');
      expect(observed.resume).toBe(flags.includes('--resume'));
      expect(observed.sessionId).toBe(flags.includes('--resume') ? sessionId : undefined);
      expect(messages).toContain('Owner permission bypass is active');
      expect(controlledClaudeArguments(decision, sessionId).join(' ')).toContain('--permission-mode manual');
      input.destroy(); output.destroy(); diagnostics.destroy();
    });
});
