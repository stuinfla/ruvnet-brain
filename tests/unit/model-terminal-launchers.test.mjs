import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { terminalTempRoot } from '../../scripts/model-terminal-gateway.mjs';
import { installTerminalLaunchers, terminalShellPlan, terminalInvocation, resolveTerminalUpstream,
  runClaudeTerminal, validateClaudeReadiness, validateClaudeTerminalSettings, validateClaudeTerminalArguments,
  verifyNativeWorkerAncestry } from '../../scripts/model-terminal-launchers.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const shortTemp = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function directory(tempRoot = os.tmpdir(), prefix = 'rnbtl-') {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(tempRoot), prefix));
  fs.chmodSync(dir, 0o700); cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function binary(dir, content) {
  const file = path.join(dir, 'native'); fs.writeFileSync(file, `#!${process.execPath}\n${content}`, { mode: 0o755 }); return file;
}
const options = (home) => ({ home, runtimeRoot: root, runtimeDigest: 'a'.repeat(64), realCodex: process.execPath });

describe('per-user native terminal installation', () => {
  it('plans without mutation; preserves native binaries and unrelated shell data with backups', () => {
    const home = directory(); const zshrc = path.join(home, '.zshrc');
    const original = 'export USER_SETTING=kept\nalias codex="custom"\nfunction claude() { custom; }\n'; fs.writeFileSync(zshrc, original);
    const planned = installTerminalLaunchers(options(home)); expect(planned.shellConflicts).toEqual(['codex', 'claude']);
    expect(fs.existsSync(planned.configPath)).toBe(false);
    const nativeBefore = fs.readFileSync(process.execPath);
    const installed = installTerminalLaunchers({ ...options(home), realClaude: process.execPath, apply: true });
    const nativeAfter = fs.readFileSync(process.execPath);
    expect(nativeAfter.length).toBe(nativeBefore.length);
    expect(createHash('sha256').update(nativeAfter).digest('hex')).toBe(createHash('sha256').update(nativeBefore).digest('hex'));
    expect(fs.readFileSync(zshrc, 'utf8')).toContain(original);
    expect(fs.readFileSync(installed.shellSource, 'utf8')).not.toContain('function');
    expect(installed.backups.some((file) => fs.readFileSync(file, 'utf8') === original)).toBe(true);
    const second = installTerminalLaunchers({ ...options(home), realClaude: process.execPath, apply: true });
    expect(fs.readFileSync(zshrc, 'utf8').split('# >>> RuvNet Brain').length).toBe(2);
    expect(fs.statSync(second.configPath).mode & 0o777).toBe(0o600);
  });
  it('refuses unmanaged launcher/source or malformed shell blocks without modifying them', () => {
    const home = directory(); const file = path.join(home, '.local/bin/ruvnet-brain-codex-terminal');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'user override');
    expect(() => installTerminalLaunchers({ ...options(home), apply: true })).toThrow(/unmanaged/);
    expect(fs.readFileSync(file, 'utf8')).toBe('user override');
    expect(() => terminalShellPlan('# >>> RuvNet Brain terminal routing >>>', '/source', {})).toThrow(/Malformed/);
  });
  it('executes the installed launcher and sourced zsh function across a different project with verbatim arguments and status', () => {
    const home = directory(); const log = path.join(home, 'argv.json');
    const native = binary(home, `require('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2), api:process.env.OPENAI_API_KEY})); process.exit(7);`);
    const installed = installTerminalLaunchers({ ...options(home), realCodex: native, apply: true });
    const result = spawnSync(installed.launchers.codex, ['login', 'status', 'space quote\' $literal'], { cwd: directory(), encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'must disappear' } });
    expect(result.status).toBe(7); expect(JSON.parse(fs.readFileSync(log))).toEqual({ argv: ['login', 'status', 'space quote\' $literal'] });
    if (!fs.existsSync('/bin/zsh')) return; // Native zsh integration runs on hosts with zsh installed.
    const shell = spawnSync('/bin/zsh', ['-c', 'source "$1"; codex --version', 'test', installed.shellSource], { encoding: 'utf8', cwd: directory() });
    expect(shell.status).toBe(7); expect(JSON.parse(fs.readFileSync(log)).argv).toEqual(['--version']);
  });
});

describe('known native daemon locator', () => {
  async function fixture() {
    const base = directory(shortTemp, 't'); const codexHome = path.join(base, 'home');
    const control = path.join(codexHome, 'app-server-control'); fs.mkdirSync(control, { recursive: true, mode: 0o700 });
    const daemon = path.join(base, `codex-daemon-${process.getuid()}`); fs.mkdirSync(daemon, { mode: 0o700 });
    const actual = path.join(daemon, 'a'.repeat(64)); const server = net.createServer();
    await new Promise((resolve) => server.listen(actual, resolve)); fs.chmodSync(actual, 0o600);
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const locator = path.join(control, 'app-server-control.sock'); fs.symlinkSync(actual, locator);
    return { base, codexHome, actual, locator, daemon };
  }
  it('resolves a private daemon locator using the platform root by default', async () => {
    const f = await fixture(), realpath = fs.realpathSync;
    const lookup = vi.spyOn(fs, 'realpathSync').mockImplementation((file, ...args) =>
      file === terminalTempRoot() ? f.base : realpath(file, ...args));
    try {
      expect(resolveTerminalUpstream({ codexHome: f.codexHome })).toBe(f.actual);
      expect(lookup).toHaveBeenCalledWith(terminalTempRoot());
    } finally { lookup.mockRestore(); }
  });
  it('resolves only known owned private hash-named endpoints and refuses foreign/misplaced targets', async () => {
    const f = await fixture(); expect(resolveTerminalUpstream({ codexHome: f.codexHome, daemonRoot: f.base })).toBe(f.actual);
    expect(() => resolveTerminalUpstream({ codexHome: f.codexHome, daemonRoot: f.base, uid: process.getuid() + 1 })).toThrow();
    fs.chmodSync(f.daemon, 0o755); expect(() => resolveTerminalUpstream({ codexHome: f.codexHome, daemonRoot: f.base })).toThrow(/private/);
    fs.chmodSync(f.daemon, 0o700); fs.unlinkSync(f.locator); fs.symlinkSync(process.execPath, f.locator);
    expect(() => resolveTerminalUpstream({ codexHome: f.codexHome, daemonRoot: f.base })).toThrow(/escaped/);
  });
  it('admin bypass needs no socket while inference and unsupported transports fail before launch', () => {
    const config = { schemaVersion: 1, realCodex: process.execPath, nodeBinary: process.execPath, gatewayPath: path.join(root, 'scripts/model-terminal-gateway.mjs') };
    const calls = []; const daemonExec = (...args) => calls.push(args);
    expect(terminalInvocation({ host: 'codex', args: ['login', 'status'], config, env: {}, daemonExec }).routed).toBe(false);
    expect(() => terminalInvocation({ host: 'codex', args: ['exec', 'hello'], config, env: {}, daemonExec })).toThrow(/no proved/);
    expect(() => terminalInvocation({ host: 'codex', args: ['--profile', 'custom'], config, env: {}, daemonExec })).toThrow();
    expect(() => terminalInvocation({ host: 'codex', args: ['-c', 'model_provider="custom"'], config, env: {}, daemonExec })).toThrow();
    expect(calls).toEqual([]);
    expect(() => terminalInvocation({ host: 'codex', args: [], config, env: { CODEX_HOME: path.join(directory(), 'missing') }, daemonExec })).toThrow();
    expect(() => terminalInvocation({ host: 'codex', args: ['--version'], config, env: { RNB_TERMINAL_LAUNCH_ACTIVE: '1' } })).toThrow(/recursive/);
  });
  it('passes an actual private endpoint and every native argument verbatim into the gateway CLI', async () => {
    const home = directory(shortTemp); const control = path.join(home, 'app-server-control'); fs.mkdirSync(control, { mode: 0o700 });
    const actual = path.join(control, 'app-server-control.sock'); const server = net.createServer();
    await new Promise((resolve) => server.listen(actual, resolve)); fs.chmodSync(actual, 0o600);
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const gatewayPath = path.join(root, 'scripts/model-terminal-gateway.mjs');
    const args = ['resume', '--last', '--no-alt-screen', '-C', 'spaces \' literal'];
    const starts = [];
    const invocation = terminalInvocation({ host: 'codex', args, env: { CODEX_HOME: home, OPENAI_API_KEY: 'must disappear' }, daemonExec: (...values) => starts.push(values),
      config: { schemaVersion: 1, realCodex: process.execPath, nodeBinary: process.execPath, gatewayPath } });
    expect(starts).toEqual([[fs.realpathSync(process.execPath), ['app-server', 'daemon', 'start'], { env: { CODEX_HOME: home }, timeout: 10000, stdio: 'ignore', shell: false, maxBuffer: 65536 }]]);
    expect(invocation).toEqual({ command: fs.realpathSync(process.execPath), args: [gatewayPath, '--real-binary', fs.realpathSync(process.execPath), '--upstream-socket', actual, '--', ...args], routed: true });
  });
  it('starts before resolving a missing cold locator, preserves warm endpoint and refuses failed or unmaterialized startup', async () => {
    const f = await fixture(); fs.unlinkSync(f.locator);
    const config = { schemaVersion: 1, realCodex: process.execPath, nodeBinary: process.execPath, gatewayPath: path.join(root, 'scripts/model-terminal-gateway.mjs') };
    const request = { host: 'codex', args: [], config, env: { CODEX_HOME: f.codexHome } };
    let starts = 0;
    const cold = terminalInvocation({ ...request, daemonExec: () => { expect(fs.existsSync(f.locator)).toBe(false); starts++; fs.renameSync(f.actual, f.locator); } });
    expect(starts).toBe(1); expect(cold.args).toContain(f.locator);
    const inode = fs.lstatSync(f.locator).ino;
    const warm = terminalInvocation({ ...request, daemonExec: () => { starts++; } });
    expect(starts).toBe(2); expect(fs.lstatSync(f.locator).ino).toBe(inode); expect(warm.args).toEqual(cold.args);
    expect(() => terminalInvocation({ ...request, daemonExec: () => { throw new Error('private provider details'); } })).toThrow('Native Codex daemon start unavailable; terminal launch blocked');
    fs.chmodSync(f.locator, 0o660); expect(() => terminalInvocation({ ...request, daemonExec: () => {} })).toThrow(/private Unix socket/);
    fs.unlinkSync(f.locator); expect(() => terminalInvocation({ ...request, daemonExec: () => {} })).toThrow();
  });
});

describe('Claude native startup guard', () => {
  it.each([['--dangerously-skip-permissions', '--version'], ['--allow-dangerously-skip-permissions', '--help'],
    ['-h', '--dangerously-skip-permissions'], ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '-v']])('passes owner permission flags with information-only checks verbatim: %j', async (...args) => {
    const dir = directory(), log = path.join(dir, 'argv.json');
    const native = binary(dir, `require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));process.exit(7);`);
    const result = await runClaudeTerminal({ config: { realClaude: native }, args, cwd: dir, env: {}, signalSource: new EventEmitter() });
    expect(result).toEqual({ code: 7, signal: null }); expect(JSON.parse(fs.readFileSync(log))).toEqual(args);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('rnb-claude-'))).toBe(false);
  });
  it.each([['--dangerously-skip-permissions', '--version', 'prompt'], ['--dangerously-skip-permissions', '--', '--version'],
    ['--dangerously-skip-permissions', '--version', '--model=opus'], ['--dangerously-skip-permissions', '--version', '-p', 'prompt'],
    ['--dangerously-skip-permissions']])('never uses information passthrough for prompt or unqualified arguments: %j', async (...args) => {
    const dir = directory(), log = path.join(dir, 'argv.json');
    const native = binary(dir, `require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));process.exit(7);`);
    await expect(runClaudeTerminal({ config: { realClaude: native }, args, cwd: dir,
      env: { CLAUDE_CODE_DISABLE_HOOKS: '1' } })).rejects.toThrow(/conflict|disables/);
    expect(fs.existsSync(log)).toBe(false);
  });
  function fixture(mode) {
    const dir = directory(); const configDir = path.join(dir, 'config'); fs.mkdirSync(configDir);
    const native = binary(dir, `
      const fs=require('fs');
      if(process.argv[2]==='auth') {console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));process.exit(0)}
      (async()=>{if(${JSON.stringify(mode)}!=='missing') {
      const helper=await import(${JSON.stringify(path.join(root, 'scripts/claude-terminal-mod.mjs'))});
      const pluginRoot=process.argv[3];
      const receipt={schemaVersion:1,nonce:process.env.RNB_CLAUDE_MOD_NONCE,pluginRoot,modDigest:helper.terminalModDigest(pluginRoot),pid:process.pid,status:'ready',nativeVersion:'2.1.287',sessionId:'fixture',observedAt:new Date().toISOString()};
      if(${JSON.stringify(mode)}==='bad')receipt.nonce='wrong';
      fs.writeFileSync(process.env.RNB_CLAUDE_MOD_RECEIPT,JSON.stringify(receipt),{mode:0o600});
      }setTimeout(()=>process.exit(7),250)})();`);
    const config = { realClaude: native, nodeBinary: process.execPath, claudeHelperPath: path.join(root, 'scripts/claude-terminal-mod.mjs'), enginePath: path.join(root, 'scripts/model-router-engine.mjs') };
    return { config, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, cwd: dir, tempRoot: dir, startupMs: 100, signalSource: new EventEmitter(), diagnostics: new PassThrough() };
  }
  it('accepts bound live receipt, preserves native status, and cleans owned launch data', async () => {
    const f = fixture('ready'); const result = await runClaudeTerminal(f);
    expect(result.code).toBe(7); expect(result.readinessReceipt.nativeVersion).toBe('2.1.287');
    expect(fs.readdirSync(f.tempRoot).some((name) => name.startsWith('rnb-claude-'))).toBe(false);
  });
  it.each(['missing', 'bad'])('terminates only its own child on %s receipt', async (mode) => {
    const f = fixture(mode); await expect(runClaudeTerminal(f)).rejects.toThrow(/activation/);
    expect(fs.readdirSync(f.tempRoot).some((name) => name.startsWith('rnb-claude-'))).toBe(false);
  });
  it('refuses unsafe config, malformed receipt, foreign process and unqualified flags', () => {
    const home = directory(); fs.mkdirSync(path.join(home, '.claude'));
    const file = path.join(home, '.claude/settings.json'); fs.writeFileSync(file, JSON.stringify({ apiKeyHelper: 'secret command' }));
    expect(() => validateClaudeTerminalSettings({ home, cwd: home, env: {} })).toThrow(/conflict/);
    fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'private' } }));
    expect(() => validateClaudeTerminalSettings({ home, cwd: home, env: {} })).toThrow(/conflict/);
    fs.writeFileSync(file, JSON.stringify({ fastMode: true })); expect(() => validateClaudeTerminalSettings({ home, cwd: home, env: {} })).toThrow(/conflict/);
    fs.writeFileSync(file, JSON.stringify({ env: { RUFLO_HARNESS_LOOP: '1' }, modelSettings: { 'claude-sonnet-5': { effortLevel: 'medium' } } }));
    expect(() => validateClaudeTerminalSettings({ home, cwd: home, env: {} })).not.toThrow();
    fs.writeFileSync(file, JSON.stringify({ modelSettings: { 'claude-sonnet-5': { apiKeyHelper: 'refused' } } }));
    expect(() => validateClaudeTerminalSettings({ home, cwd: home, env: {} })).toThrow(/conflict/);
    fs.writeFileSync(file, '{'); expect(() => validateClaudeTerminalSettings({ home, cwd: home, env: {} })).toThrow(/malformed/);
    for (const arg of ['--bare', '--settings', '--model=opus', '--plugin-dir', '--remote-control', '-p', 'setup-token']) expect(() => validateClaudeTerminalArguments([arg])).toThrow();
    expect(() => validateClaudeTerminalArguments(['--resume', 'session', '--permission-mode', 'default'])).not.toThrow();
    expect(validateClaudeTerminalArguments(['--resume', 'session', '--permission-mode', 'default', 'initial prompt'])).toEqual({ options: ['--resume', 'session', '--permission-mode', 'default'], prompts: ['initial prompt'] });
    expect(() => validateClaudeTerminalSettings({ home, cwd: home, env: { CLAUDE_CODE_SAFE_MODE: '1' } })).toThrow(/disables/);
    expect(verifyNativeWorkerAncestry(process.pid, process.pid)).toBe(true);
    expect(verifyNativeWorkerAncestry(process.pid, process.pid + 100000)).toBe(false);
    fs.writeFileSync(file, '{}', { mode: 0o600 }); expect(() => validateClaudeReadiness(file, {})).toThrow();
  });
});
