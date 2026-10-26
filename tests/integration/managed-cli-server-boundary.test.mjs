import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createStore } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER = path.join(ROOT, 'plugin/mcp/server.mjs');
const children = new Set();
// Native zero-model administration must not enter the routed conversation frontdoor.
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { wireCodexHost, codexAdministrativeProbeBinary } = await import('../../bin/install.mjs');
const CODEX = process.env.RUVNET_CODEX_BIN || codexAdministrativeProbeBinary();

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
  const waiters = new Map(); let id = 0; let terminalError;
  let stderr = Buffer.alloc(0);
  child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr = Buffer.concat([stderr, chunk.subarray(0, 4096 - stderr.length)]); });
  const failed = message => {
    // Retain bounded evidence without echoing credentials or arbitrary native configuration.
    terminalError = new Error(`${message}; stderr sha256=${createHash('sha256').update(stderr).digest('hex')}`);
    for (const waiter of waiters.values()) waiter.fail(terminalError);
    waiters.clear();
  };
  child.once('error', error => failed(`MCP subprocess failed (${error.code || 'unknown'})`));
  child.once('close', (code, signal) => failed(`MCP subprocess closed (${code ?? signal ?? 'unknown'})`));
  rl.on('line', (line) => { const msg = JSON.parse(line); const waiter = waiters.get(msg.id); if (waiter) { waiters.delete(msg.id); waiter(msg); } });
  return { notify(method) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); }, request(method, params = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      if (terminalError) return reject(terminalError);
      const timer = setTimeout(() => { waiters.delete(requestId); reject(new Error(`timeout waiting for ${method}`)); }, 30_000);
      const waiter = msg => { clearTimeout(timer); resolve(msg); };
      waiter.fail = error => { clearTimeout(timer); reject(new Error(`${method}: ${error.message}`)); };
      waiters.set(requestId, waiter);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  } };
}

function rows(fx) {
  const db = path.join(fx.project, '.swarm', 'memory.db');
  return JSON.parse(execFileSync('sqlite3', ['-json', db, "select content from memory_entries where namespace='project-progression' order by created_at;"], { encoding: 'utf8' }) || '[]');
}

describe('real MCP managed execution boundary', () => {
  it('rejects a closed native transport promptly without echoing credential-like stderr', async () => {
    const fx = fixture();
    try {
      const mcp = server(fx, 'codex', { command: process.execPath,
        args: ['-e', "process.stderr.write('OPENAI_API_KEY=synthetic-secret');process.exit(7)"], env: {} });
      const error = await mcp.request('initialize').catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/^initialize: MCP subprocess closed \(7\); stderr sha256=[a-f0-9]{64}$/);
      expect(error.message).not.toContain('synthetic-secret');
    } finally { await stopChildren(); fs.rmSync(fx.root, { recursive: true, force: true }); }
  });
  it('repairs the original copied-shell missing manifest (#384)', async () => {
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
      // No progression capture exists any more (owner ruling 2026-10-12), so nothing is written to the store here.
      expect(rows(fx)).toEqual([]);
      expectNoInstallInProject(fx);
    } finally { await stopChildren(); fs.rmSync(fx.root, { recursive: true, force: true }); }
  }, 120_000); // two real ruflo boots through the MCP server
  // Deterministic: a fake `ruflo` first on PATH records the environment and cwd it was started with. The
  // real self-update only fires when a newer ruflo exists, so only a recorder can prove the flags are always
  // passed. Inherited values are removed first, so the product, not this shell, must supply them.
  // POSIX only: the fake is a node shebang script; Windows needs a .cmd shim, covered by spawnSpec's own tests.
  it.skipIf(process.platform === 'win32')('starts ruflo with self-update and the daemon off, in the project directory, for help AND run (S1)', async () => {
    const fx = fixture();
    try {
      const bin = path.join(fx.root, 'fake-bin'); const log = path.join(fx.root, 'ruflo-env.jsonl');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'ruflo'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), update: process.env.CLAUDE_FLOW_AUTO_UPDATE ?? null, daemon: process.env.RUFLO_DAEMON_AUTOSTART ?? null }) + '\\n');\nconsole.log('ok');\n`, { mode: 0o755 });
      const mcp = server(fx, 'codex', { command: process.execPath, args: [SERVER],
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUFLO_BIN: undefined, CLAUDE_FLOW_AUTO_UPDATE: undefined, RUFLO_DAEMON_AUTOSTART: undefined } });
      const tool = (name) => mcp.request('tools/call', { name, arguments: { executable: 'ruflo', argv: ['status'] } });
      const help = await tool('ruvnet_cli_help'); expect(help.result.isError, help.result.content?.[0]?.text).not.toBe(true);
      const run = await tool('ruvnet_cli_run'); expect(run.result.isError, run.result.content?.[0]?.text).not.toBe(true);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(calls).toEqual([
        { argv: ['status', '--help'], cwd: fx.project, update: 'false', daemon: '0' },
        { argv: ['status'], cwd: fx.project, update: 'false', daemon: '0' },
      ]);
    } finally { await stopChildren(); fs.rmSync(fx.root, { recursive: true, force: true }); }
  }, 60_000);

  /** ruflo's self-update writes these into its cwd (ruflo-bin.mjs RUFLO_CWD_ARTIFACTS); none may land in the project. */
  const expectNoInstallInProject = (fx) => {
    for (const name of ['node_modules', 'package.json', 'package-lock.json']) {
      expect(fs.existsSync(path.join(fx.project, name)), `${name} written into the user's project`).toBe(false);
    }
  };

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
        expect(rows(fx)).toEqual([]);
        expectNoInstallInProject(fx); // measured before 4.7.21 under Codex: a 1.3 GB self-update into the project
      } finally {
        await stopChildren();
        fs.rmSync(fx.root, { recursive: true, force: true });
      }
      // Explicit: a Codex app-server boot plus two real ruflo boots measured 21-25 s on the first call; the 5 s
      // default is a load flake, and 120 s still fails a real hang.
    }, 120_000);
  }

  it('keeps real Ruflo memory store/retrieve active through MCP', async () => {
    const fx = fixture(); const mcp = server(fx, 'codex', { command: process.execPath, args: [SERVER], env: {} });
    try {
      const tool = (name, argv) => mcp.request('tools/call', { name, arguments: { executable: 'ruflo', argv } });
      const db = path.join(fx.project, '.swarm/memory.db'); const key = 'ordinary-suspended-memory'; const value = 'Explicit ordinary AgentDB checkpoint remains active';
      for (const command of ['store', 'retrieve']) expect((await tool('ruvnet_cli_help', ['memory', command])).result.isError).not.toBe(true);
      const stored = await tool('ruvnet_cli_run', ['memory', 'store', '--key', key, '--value', value, '--namespace', 'fixture-memory', '--path', db]);
      expect(stored.result.isError, stored.result.content?.[0]?.text).not.toBe(true);
      const retrieved = await tool('ruvnet_cli_run', ['memory', 'retrieve', '--key', key, '--namespace', 'fixture-memory', '--value-only', '--path', db]);
      expect(retrieved.result.isError, retrieved.result.content?.[0]?.text).not.toBe(true); expect(retrieved.result.structuredContent.stdout).toContain(value);
      const exact = JSON.parse(execFileSync('sqlite3', ['-json', db, "select key,content from memory_entries where namespace='fixture-memory' and key='ordinary-suspended-memory';"], { encoding: 'utf8' }));
      expect(exact).toEqual([{ key, content: value }]); expect(rows(fx)).toEqual([]);
      expectNoInstallInProject(fx);
    } finally { await stopChildren(); fs.rmSync(fx.root, { recursive: true, force: true }); }
  }, 120_000); // four real ruflo boots through the MCP server

;
});
