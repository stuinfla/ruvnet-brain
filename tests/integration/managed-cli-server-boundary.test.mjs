import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createStore } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER = path.join(ROOT, 'plugin/mcp/server.mjs');
const children = new Set();
const CODEX = process.env.RUVNET_CODEX_BIN || 'codex';
let wireCodexHost;
beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  ({ wireCodexHost } = await import('../../bin/install.mjs'));
});

async function stopChildren() {
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.stdin.end();
  })));
  children.clear();
}
afterEach(stopChildren);

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-server-boundary-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: project });
  fs.writeFileSync(path.join(project, 'README.md'), 'managed boundary fixture\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: project });
  const home = path.join(root, 'home'); const brain = path.join(home, '.cache/ruvnet-brain');
  fs.mkdirSync(home, { recursive: true });
  // A directory alone is not adoption: exercise the existing canonical-store boundary.
  createStore(path.join(project, '.swarm', 'memory.db'));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')).version;
  fs.cpSync(path.join(ROOT, 'plugin'), path.join(brain, 'versions', version), { recursive: true });
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ version, generation: 1, codeRoot: `versions/${version}` }));
  return { root, project, home, brain };
}

function server(fx, host, registration = { command: process.execPath, args: [SERVER], env: {} }) {
  const child = spawn(registration.command, registration.args, {
    cwd: fx.project,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: fx.home, RUVNET_BRAIN_HOME: fx.brain, RUVNET_BRAIN_PROJECT_DIR: fx.project,
      OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, RUFLO_DAEMON_AUTOSTART: '0', RUVNET_AUTO_UPDATE: 'off',
      RUVNET_BRAIN_SESSION_ID: 'codex-named-fixture-session', RUVNET_HOOK_HOST: host, ...registration.env },
  });
  children.add(child);
  const rl = readline.createInterface({ input: child.stdout });
  const waiters = new Map(); let id = 0;
  rl.on('line', (line) => { const msg = JSON.parse(line); const waiter = waiters.get(msg.id); if (waiter) { waiters.delete(msg.id); waiter(msg); } });
  return { notify(method) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); }, request(method, params = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(requestId); reject(new Error(`timeout waiting for ${method}`)); }, 30_000);
      waiters.set(requestId, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  } };
}

function rows(fx) {
  const db = path.join(fx.project, '.swarm', 'memory.db');
  return JSON.parse(execFileSync('sqlite3', ['-json', db, "select content from memory_entries where namespace='project-progression' order by created_at;"], { encoding: 'utf8' }) || '[]');
}

describe('real MCP managed execution boundary', () => {
  it('repairs the original copied-shell missing manifest and detects the frozen-handler mutant (#384)', async () => {
    const fx = fixture();
    try {
      fs.mkdirSync(path.join(fx.home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(fx.home, '.codex/config.toml'), '');
      const installed = wireCodexHost({ codexDir: path.join(fx.home, '.codex'), serverDir: path.join(fx.home, '.claude/ruvnet-brain/mcp'), announce: false });
      fs.rmSync(path.join(fx.home, '.claude/ruvnet-brain/.claude-plugin'), { recursive: true });
      const registration = { command: process.execPath, args: [installed.serverPath], env: {} };
      const mcp = server(fx, 'codex', registration);
      const tool = (client, name) => client.request('tools/call', { name, arguments: { executable: 'ruflo', argv: ['status'] } });
      expect((await tool(mcp, 'ruvnet_cli_help')).result.isError).not.toBe(true);
      const run = await tool(mcp, 'ruvnet_cli_run'); expect(run.result.isError, run.result.content[0].text).not.toBe(true);
      expect(rows(fx).length).toBeGreaterThanOrEqual(2);
      await stopChildren();
      // Restore the original frozen-handler authorization and call-site in the disposable shell. The
      // native active tree stays healthy: this mutant must reproduce the old resource failure.
      fs.writeFileSync(path.join(path.dirname(installed.serverPath), 'managed-cli-interface.mjs'), fs.readFileSync(path.join(ROOT, 'plugin/mcp/managed-cli-interface.mjs'), 'utf8')
        .replace('const binding = lifecycle.generationBinding || LOCAL_BINDING;', "const binding = 'frozen-shell';"));
      fs.writeFileSync(installed.serverPath, fs.readFileSync(installed.serverPath, 'utf8')
        .replace("import { MANAGED_CLI_TOOLS }", "import { callManagedCli, MANAGED_CLI_TOOLS }")
        .replace('await dispatchManagedCli(params.name,', 'await callManagedCli(params.name,'));
      const mutant = server(fx, 'codex', registration);
      expect((await tool(mutant, 'ruvnet_cli_help')).result.isError).not.toBe(true);
      const refused = await tool(mutant, 'ruvnet_cli_run'); expect(refused.result.isError).toBe(true);
      expect(refused.result.content[0].text).toMatch(/progression adapter version is unreadable/);
    } finally { await stopChildren(); fs.rmSync(fx.root, { recursive: true, force: true }); }
  });
  const codexAvailable = spawnSync(CODEX, ['--version'], { encoding: 'utf8' }).status === 0;
  if (!codexAvailable && process.env.RUVNET_REQUIRE_CODEX_DISCOVERY === '1') {
    throw new Error(`required Codex CLI is unavailable: ${CODEX}`);
  }
  const nativeTest = codexAvailable ? it : it.skip;

  for (const reinstall of [false, true]) {
    nativeTest(`installer ${reinstall ? 'reinstall repairs legacy' : 'fresh install binds'} Codex identity through the native config and persistent MCP path (#381)`, async () => {
      const fx = fixture();
      try {
        const codexDir = path.join(fx.home, '.codex');
        const configPath = path.join(codexDir, 'config.toml');
        const privateConfig = '# user-owned settings\nmodel = "private-model"\n';
        const privateTail = '\n[mcp_servers.private]\ncommand = "private-server"\n';
        fs.mkdirSync(codexDir, { recursive: true });
        fs.writeFileSync(configPath, privateConfig);
        const opts = { codexDir, serverDir: path.join(fx.home, '.claude/ruvnet-brain/mcp'), announce: false };
        const first = wireCodexHost(opts);
        if (reinstall) {
          fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8')
            .replace('env = { RUVNET_HOOK_HOST = "codex" }\n', '') + privateTail);
          expect(wireCodexHost(opts).action).toBe('rewritten');
        }
        const written = fs.readFileSync(configPath, 'utf8');
        expect(written.startsWith(privateConfig)).toBe(true);
        if (reinstall) expect(written.endsWith(privateTail)).toBe(true);
        expect(wireCodexHost(opts).changed).toBe(false);
        expect(fs.readFileSync(configPath, 'utf8')).toBe(written);
        // Codex parses the actual installer output, then its native host launches that registration.
        const registration = JSON.parse(execFileSync(CODEX, ['mcp', 'get', 'ruvnet-brain', '--json'], {
          env: { ...process.env, CODEX_HOME: codexDir }, encoding: 'utf8', timeout: 30_000,
        })).transport;
        expect(registration.args).toEqual([first.serverPath]);
        expect(registration.env).toEqual({ RUVNET_HOOK_HOST: 'codex' });
        // Keep native marketplace refresh and CLI daemons out of this disposable test home.
        const mcp = server(fx, undefined, { command: CODEX,
          args: ['--disable', 'plugins', '-c', 'mcp_servers.ruvnet-brain.env.RUFLO_DAEMON_AUTOSTART="0"', 'app-server'],
          env: { CODEX_HOME: codexDir } });
        const initialized = await mcp.request('initialize', { capabilities: { experimentalApi: true }, clientInfo: { name: 'fixture', version: '1' } });
        expect(initialized.error).toBeUndefined();
        mcp.notify('initialized');
        // No model turn is started; the native client invokes the MCP tools directly.
        const started = await mcp.request('thread/start', { cwd: fx.project, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: 'danger-full-access' });
        expect(started.error).toBeUndefined();
        const threadId = started.result.thread.id;
        const help = await mcp.request('mcpServer/tool/call', { threadId, server: 'ruvnet-brain', tool: 'ruvnet_cli_help', arguments: { executable: 'ruflo', argv: ['status'] } });
        expect(help.result.isError, JSON.stringify(help.result)).not.toBe(true);
        const run = await mcp.request('mcpServer/tool/call', { threadId, server: 'ruvnet-brain', tool: 'ruvnet_cli_run', arguments: { executable: 'ruflo', argv: ['status'], host: 'claude' } });
        expect(run.result.isError, run.result.content?.[0]?.text).not.toBe(true);
        const entries = rows(fx).map((row) => JSON.parse(row.content));
        expect(entries.length).toBeGreaterThanOrEqual(2);
        expect(entries.every((entry) => entry.hostIdentity.host === 'codex')).toBe(true);
      } finally {
        await stopChildren();
        fs.rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }

  it('captures through stdio MCP and reads the exact canonical progression rows', async () => {
    const fx = fixture(); const mcp = server(fx, 'codex');
    await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    const help = await mcp.request('tools/call', { name: 'ruvnet_cli_help', arguments: { executable: 'ruflo', argv: ['status'] } });
    expect(help.result.isError).not.toBe(true);
    const run = await mcp.request('tools/call', { name: 'ruvnet_cli_run', arguments: { executable: 'ruflo', argv: ['status'], host: 'claude' } });
    expect(run.result.isError).not.toBe(true);
    const entries = rows(fx).map((row) => JSON.parse(row.content));
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((entry) => entry.hostIdentity.host === 'codex')).toBe(true);
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('refuses missing trusted host identity even with a Codex-named session id', async () => {
    const fx = fixture(); const mcp = server(fx, undefined);
    await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    const help = await mcp.request('tools/call', { name: 'ruvnet_cli_help', arguments: { executable: 'ruflo', argv: ['status'] } });
    expect(help.result.isError).not.toBe(true);
    const run = await mcp.request('tools/call', { name: 'ruvnet_cli_run', arguments: { executable: 'ruflo', argv: ['status'] } });
    expect(run.result.isError).toBe(true);
    expect(run.result.content[0].text).toMatch(/host identity unavailable|refused/i);
    fs.rmSync(fx.root, { recursive: true, force: true });
  });
});
