import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER = path.join(ROOT, 'plugin/mcp/server.mjs');
const children = new Set();

afterEach(() => { for (const child of children) child.kill('SIGTERM'); children.clear(); });

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
  const home = path.join(root, 'home'); const brain = path.join(root, 'brain');
  fs.mkdirSync(home, { recursive: true });
  return { root, project, home, brain };
}

function server(fx, host) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: fx.project,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: fx.home, RUVNET_BRAIN_HOME: fx.brain, RUVNET_BRAIN_PROJECT_DIR: fx.project, RUVNET_HOOK_HOST: host },
  });
  children.add(child);
  const rl = readline.createInterface({ input: child.stdout });
  const waiters = new Map(); let id = 0;
  rl.on('line', (line) => { const msg = JSON.parse(line); const waiter = waiters.get(msg.id); if (waiter) { waiters.delete(msg.id); waiter(msg); } });
  return { request(method, params = {}) {
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

  it('refuses an adopted project when the MCP launch has no trusted host identity', async () => {
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
