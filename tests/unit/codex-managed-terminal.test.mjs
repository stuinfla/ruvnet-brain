import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { parseCodexManagedArguments, runCodexManagedPrimaryTurn, launchCodexManagedTerminal } from '../../scripts/codex-managed-terminal.mjs';
import { runManagedPrompt } from '../../scripts/model-managed-prompt.mjs';
const parent = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const decision = { model: 'native-fixture', effort: 'medium', taskClass: 'medium' };
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true }); });
function native(overrides = {}) {
  return { binary: '/actual/native-codex', prompt: 'Translate yes.', cwd: process.cwd(), env: {},
    decide: vi.fn(async () => decision), verifyDecision: vi.fn(), receipt: vi.fn(), output: vi.fn(),
    executeNative: vi.fn(async () => ({ completed: true, sessionId: parent, modelObserved: true, effortSettingsObserved: true,
      model: decision.model, effort: decision.effort, answer: 'Oui.' })), ...overrides };
}
function terminal() {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  input.isTTY = output.isTTY = true;
  return { input, output, diagnostics, close: () => { input.destroy(); output.destroy(); diagnostics.destroy(); } };
}
describe('controlled Codex input boundary', () => {
  it('preserves literal prompt and supported explicit session/cwd/permission inputs', () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-front-'))); dirs.push(cwd);
    const parsed = parseCodexManagedArguments(['--dangerously-bypass-approvals-and-sandbox', '--cd', cwd, 'resume', parent, 'Translate yes.']);
    expect(parsed).toMatchObject({ sessionId: parent, cwd, ownerBypass: true, initialPrompt: 'Translate yes.' });
    expect(parseCodexManagedArguments(['resume', '01a10c37-acf1-7313-a0dc-1e5886445249']).sessionId).toBe('01a10c37-acf1-7313-a0dc-1e5886445249');
    expect(parseCodexManagedArguments(['--', 'login'])).toMatchObject({ administrative: false, initialPrompt: 'login' });
    expect(parseCodexManagedArguments(['--', '--version'])).toMatchObject({ administrative: false, initialPrompt: '--version' });
  });
  it.each([['-m', 'other'], ['-c', 'model="other"'], ['--remote', 'tcp://other'], ['resume', '--last'], ['fork'], ['agents'], ['--no-alt-screen'], ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-approvals-and-sandbox']])('refuses unsupported interactive inputs without ignoring them: %j', args => {
    expect(() => parseCodexManagedArguments(args)).toThrow();
  });
  it('admin passthrough keeps native arguments, status, subscription environment and owned signals', async () => {
    const child = new EventEmitter(), source = new EventEmitter(); child.kill = vi.fn();
    const spawnNative = vi.fn(() => child);
    const pending = launchCodexManagedTerminal({ binary: '/native/codex', args: ['--version'], cwd: process.cwd(),
      env: { OPENAI_API_KEY: 'not-forwarded', OWNER: 'yes' }, spawnNative, signalSource: source });
    source.emit('SIGTERM'); child.emit('exit', 7, null);
    expect(await pending).toEqual({ code: 7, signal: null }); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnNative.mock.calls[0]).toMatchObject(['/native/codex', ['--version'], { env: { OWNER: 'yes', RNB_TERMINAL_LAUNCH_ACTIVE: '1' }, shell: false }]);
    expect(spawnNative.mock.calls[0][2].env.OPENAI_API_KEY).toBeUndefined(); expect(source.listenerCount('SIGTERM')).toBe(0);
  });
  it('refuses nested invocation and nonterminal interactive execution', async () => {
    await expect(launchCodexManagedTerminal({ binary: '/native', env: { RNB_TERMINAL_LAUNCH_ACTIVE: '1' }, args: ['--version'] })).rejects.toThrow(/recursive/);
    await expect(launchCodexManagedTerminal({ binary: '/native', input: { isTTY: false }, output: { isTTY: true }, env: {} })).rejects.toThrow(/person/);
  });
});
describe('native Codex allocation and resume evidence', () => {
  it('selects every original prompt and requires actual model/effort/session evidence before reporting success', async () => {
    const f = native({ sessionId: parent, prompt: 'Translate yes.\nUNTRUSTED recalled data', decisionPrompt: 'Translate yes.' });
    const result = await runCodexManagedPrimaryTurn(f);
    expect(f.decide).toHaveBeenCalledWith('Translate yes.', 'codex', { env: {} });
    expect(f.executeNative.mock.calls[0][0]).toMatchObject({ sessionId: parent, readOnly: true, env: { RNB_TERMINAL_LAUNCH_ACTIVE: '1' } });
    expect(result.sessionId).toBe(parent); expect(f.receipt).toHaveBeenCalledOnce(); expect(f.output).toHaveBeenCalledWith('Oui.');
  });
  it.each([
    value => { value.completed = false; }, value => { value.modelObserved = false; }, value => { value.effortSettingsObserved = false; },
    value => { value.model = 'unexpected'; }, value => { value.effort = 'unexpected'; }, value => { value.sessionId = other; },
  ])('refuses mismatched or missing execution proof without success receipt %#', async mutate => {
    const f = native({ sessionId: parent }); const execute = f.executeNative;
    f.executeNative = async args => { const value = await execute(args); mutate(value); return value; };
    await expect(runCodexManagedPrimaryTurn(f)).rejects.toThrow(/unproven/); expect(f.receipt).not.toHaveBeenCalled(); expect(f.output).not.toHaveBeenCalled();
  });
  it('absolute monotonic deadline rejects delayed decision and native success before overdue timers can run', async () => {
    let time = 0; const f = native({ timeoutMs: 20, monotonic: () => time, decide: async () => { time = 45; return decision; } });
    await expect(runCodexManagedPrimaryTurn(f)).rejects.toThrow(/deadline/); expect(f.executeNative).not.toHaveBeenCalled();
    time = 0; const g = native({ timeoutMs: 20, monotonic: () => time }); const execute = g.executeNative;
    g.executeNative = async args => { const value = await execute(args); time = 45; return value; };
    await expect(runCodexManagedPrimaryTurn(g)).rejects.toThrow(/deadline/); expect(g.receipt).not.toHaveBeenCalled();
  });
});
describe('actual Codex terminal common prompt seam', () => {
  it('delivers a complete multiline paste once and retains followups entered while routing is busy', async () => {
    const t = terminal(), calls = [], original = 'First paragraph.\r\nSecond paragraph — café.\nThird paragraph.';
    let submitted = false;
    t.output.on('data', chunk => {
      if (!submitted && chunk.toString().includes('Codex> ')) {
        submitted = true;
        setImmediate(() => t.input.write(`\x1b[200~${original}\x1b[201~\n`));
      }
    });
    try {
      await launchCodexManagedTerminal({ binary: '/native', ...t, env: {},
        managedPrompt: async options => {
          calls.push(options.originalPrompt);
          if (calls.length === 1) t.input.write('Queued followup.\n/exit\n');
          await new Promise(resolve => setImmediate(resolve));
          return { sessionId: parent, completed: true, modelObserved: true, model: 'fixture', effort: 'medium' };
        } });
      expect(calls).toEqual([original, 'Queued followup.']);
    } finally { t.close(); }
  });
  it('all ordinary prompts pass through common routing and keep the exact native parent UUID', async () => {
    const t = terminal(), prompts = ['Explain this function.', '/exit'], calls = [], turns = [];
    t.output.on('data', chunk => { if (chunk.toString().includes('Codex> ')) setImmediate(() => t.input.write(prompts.shift() + '\n')); });
    try {
      const result = await launchCodexManagedTerminal({ binary: '/native', args: ['Translate yes.'], ...t, env: {},
        managedPrompt: options => { calls.push(options); return runManagedPrompt({ ...options, recallFn: async () => ({ block: '' }), captureOutcome: () => ({ skipped: 'fixture-consent-off' }) }); },
        primaryTurn: async options => { turns.push(options); return { sessionId: parent, completed: true, modelObserved: true, model: 'fixture', effort: 'medium' }; } });
      expect(calls.map(value => value.originalPrompt)).toEqual(['Translate yes.', 'Explain this function.']);
      expect(turns[0]).toMatchObject({ sessionId: undefined, resume: false, readOnly: true });
      expect(turns[1]).toMatchObject({ sessionId: parent, resume: true, readOnly: true });
      expect(result.sessionId).toBe(parent);
    } finally { t.close(); }
  });
  it('existing-parent substantive prompt cannot bypass common capture/planner refusal or execute original task', async () => {
    const t = terminal(), primaryTurn = vi.fn(), planTask = vi.fn();
    try {
      await expect(launchCodexManagedTerminal({ binary: '/native', args: ['resume', parent, 'Implement a substantial feature.'], ...t, env: {}, primaryTurn,
        managedPrompt: options => runManagedPrompt({ ...options, recallFn: async () => ({ block: '' }), captureContext: async () => [], planTask }) })).rejects.toThrow(/parent transcript required/);
      expect(primaryTurn).not.toHaveBeenCalled(); expect(planTask).not.toHaveBeenCalled();
    } finally { t.close(); }
  });
  it('only explicit approved owner bypass grants guarded workspace writes', async () => {
    const t = terminal(); let observed;
    try {
      await expect(launchCodexManagedTerminal({ binary: '/native', args: ['--dangerously-bypass-approvals-and-sandbox', 'Translate yes.'], ...t, env: {},
        managedPrompt: async options => { observed = options; throw Error('fixture-stop'); } })).rejects.toThrow('fixture-stop');
      expect(observed).toMatchObject({ readOnly: false, permissions: { apiBilling: false, write: true } });
      expect(observed.args).toBeUndefined();
    } finally { t.close(); }
  });
});

describe('owned interactive signal cancellation', () => {
  it.each(['SIGTERM', 'SIGHUP'])('aborts pending managed turn on %s and removes process handlers', async name => {
    const t = terminal(), signalSource = new EventEmitter(); let received, calls = 0;
    try {
      await expect(launchCodexManagedTerminal({ binary: '/native', args: ['Translate yes.'], ...t, env: {}, signalSource,
        managedPrompt: options => { calls++; received = options.signal; return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(Error('fixture-cancelled')), { once: true });
          queueMicrotask(() => signalSource.emit(name));
        }); } })).rejects.toThrow('fixture-cancelled');
      expect(received.aborted).toBe(true); expect(calls).toBe(1); expect(signalSource.listenerCount(name)).toBe(0);
    } finally { t.close(); }
  });
});

it.each(['SIGTERM', 'SIGHUP'])('settles an idle terminal question on %s without launching native work', async name => {
  const t = terminal(), signalSource = new EventEmitter(), managedPrompt = vi.fn();
  t.output.on('data', chunk => { if (chunk.toString().includes('Codex> ')) queueMicrotask(() => signalSource.emit(name)); });
  try {
    await expect(launchCodexManagedTerminal({ binary: '/native', ...t, env: {}, signalSource, managedPrompt })).rejects.toThrow(/abort/i);
    expect(managedPrompt).not.toHaveBeenCalled(); expect(signalSource.listenerCount(name)).toBe(0);
  } finally { t.close(); }
});
