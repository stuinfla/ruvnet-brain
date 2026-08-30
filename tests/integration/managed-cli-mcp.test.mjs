import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { MANAGED_CLI_TOOLS } from '../../plugin/mcp/managed-cli-interface.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SERVER = path.join(REPO, 'plugin/mcp/server.mjs');
const children = new Set();

afterEach(() => {
  for (const child of children) child.kill('SIGTERM');
  children.clear();
});

function fixture({ withBrain = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-cli-mcp-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls.jsonl');
  const warmup = path.join(root, 'warmup.txt');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, 'ruflo');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.MANAGED_CLI_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'fail') process.exit(9);
console.log(JSON.stringify(process.argv.slice(2)));
`);
  fs.chmodSync(executable, 0o755);
  for (const name of ['agentic-flow', 'agentic-qe']) {
    fs.symlinkSync('ruflo', path.join(bin, name));
  }
  const kb = path.join(root, withBrain ? 'kb' : 'absent-kb');
  if (withBrain) {
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), `import readline from 'node:readline';
import fs from 'node:fs';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'brain/warmup') fs.writeFileSync(process.env.WARMUP_MARKER, 'ready');
  const result = msg.method === 'brain/warmup'
    ? { ready: true }
    : msg.method === 'tools/list'
    ? { tools: [{ name: 'search_ruvnet', description: 'live child description', inputSchema: { type: 'object' } }] }
    : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`);
  }
  return { root, home, bin, calls, kb, warmup };
}

function fatalFixture() {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.bin, 'ruflo'), `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  console.log('memory store help');
  process.exit(0);
}
console.log('[OK] Data stored successfully');
console.error('❌ Invalid PRAGMA command: wal_checkpoint(passive)');
process.exit(0);
`);
  return fx;
}

function readinessFixture() {
  const fx = fixture({ withBrain: true });
  const starts = path.join(fx.root, 'starts.txt');
  const warmups = path.join(fx.root, 'warmups.txt');
  fs.writeFileSync(path.join(fx.kb, 'forge-mcp-all.mjs'), `import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(process.env.STARTS_MARKER, '1\\n');
let ready = false;
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    setTimeout(() => reply(msg.id, { result: { protocolVersion: '2024-11-05', capabilities: {} } }), 150);
  } else if (msg.method === 'brain/warmup') {
    fs.appendFileSync(process.env.WARMUPS_MARKER, '1\\n');
    setTimeout(() => { ready = true; reply(msg.id, { result: { ready: true } }); }, 150);
  } else if (msg.method === 'tools/call') {
    if (!ready) reply(msg.id, { error: { code: -32002, message: 'worker is not ready' } });
    else reply(msg.id, { result: { content: [{ type: 'text', text: 'ready result' }] } });
  }
});
`);
  return { ...fx, starts, warmups };
}

function crashingFixture() {
  const fx = fixture({ withBrain: true });
  fs.writeFileSync(path.join(fx.kb, 'forge-mcp-all.mjs'), `import readline from 'node:readline';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {} });
  if (msg.method === 'brain/warmup') {
    reply(msg.id, { ready: true });
    setTimeout(() => process.exit(19), 50);
  }
});
`);
  return fx;
}

function shutdownFixture() {
  const fx = fixture({ withBrain: true });
  const workerPid = path.join(fx.root, 'worker.pid');
  fs.writeFileSync(path.join(fx.kb, 'forge-mcp-all.mjs'), `import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(process.env.WORKER_PID_MARKER, String(process.pid));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {} });
  if (msg.method === 'brain/warmup') reply(msg.id, { ready: true });
});
setInterval(() => {}, 1 << 30);
`);
  return { ...fx, workerPid };
}

function startServer(fx, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: fx.home,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH || ''}`,
      MANAGED_CLI_CALLS: fx.calls,
      WARMUP_MARKER: fx.warmup,
      RUVNET_BRAIN_HOME: path.join(fx.root, 'brain'),
      RUVNET_BRAIN_KB: fx.kb,
      RUVNET_BRAIN_PROJECT_SETTINGS_FILE: path.join(fx.root, 'absent-project-settings.json'),
      ...extraEnv,
    },
  });
  children.add(child);
  const rl = readline.createInterface({ input: child.stdout });
  let id = 0;
  const waiting = new Map();
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    const waiter = waiting.get(msg.id);
    if (waiter) {
      waiting.delete(msg.id);
      waiter.resolve(msg);
    }
  });
  child.on('exit', (code) => {
    for (const waiter of waiting.values()) waiter.reject(new Error(`server exited ${code}`));
    waiting.clear();
  });
  return {
    child,
    request(method, params = {}) {
      const requestId = ++id;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          reject(new Error(`timeout waiting for ${method}`));
        }, 10_000);
        waiting.set(requestId, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject,
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      return response;
    },
  };
}

function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

describe('ruvnet-brain MCP structured managed-CLI boundary', () => {
  it('returns the stable tool catalog without waiting for a cold worker warmup', async () => {
    const fx = fixture({ withBrain: true });
    fs.writeFileSync(path.join(fx.kb, 'forge-mcp-all.mjs'), `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'brain/warmup') return setTimeout(() => respond({ ready: true }), 1200);
  if (msg.method === 'initialize') return respond({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'slow', version: '0' } });
  if (msg.method === 'tools/call') return respond({ content: [{ type: 'text', text: 'grounded' }] });
  return respond({ tools: [{ name: 'search_ruvnet', inputSchema: { type: 'object' } }] });
});
`);
    const mcp = startServer(fx);

    await mcp.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cold-client', version: '1' },
    });
    const started = performance.now();
    const listed = await mcp.request('tools/list');
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(500);
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      'search_ruvnet', ...MANAGED_CLI_TOOLS.map((tool) => tool.name),
    ]);

    const searched = await mcp.request('tools/call', {
      name: 'search_ruvnet', arguments: { query: 'join the cold readiness attempt' },
    });
    expect(searched.result.content[0].text).toBe('grounded');
  });

  it('persists a live ready receipt only after worker initialization and warmup complete', async () => {
    const fx = fixture({ withBrain: true });
    const mcp = startServer(fx);

    await mcp.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'receipt-client', version: '1' },
    });
    await mcp.request('tools/call', {
      name: 'search_ruvnet', arguments: { query: 'prove readiness' },
    });

    const receipt = JSON.parse(fs.readFileSync(path.join(fx.root, 'brain', 'mcp-readiness.json'), 'utf8'));
    expect(receipt).toMatchObject({
      state: 'ready',
      phase: 'warmup',
      pid: mcp.child.pid,
      retryable: false,
    });
    expect(receipt.generation).toEqual(expect.any(String));
    expect(receipt.workerPid).toEqual(expect.any(Number));
    expect(receipt.elapsedMs).toEqual(expect.any(Number));
    expect(new Date(receipt.at).toString()).not.toBe('Invalid Date');
  });

  it('keeps search_ruvnet declared and returns explicit install guidance when the KB is absent', async () => {
    const mcp = startServer(fixture());
    const listed = await mcp.request('tools/list');
    expect(listed.result.tools.map((tool) => tool.name)).toContain('search_ruvnet');
    const searched = await mcp.request('tools/call', {
      name: 'search_ruvnet', arguments: { query: 'missing bundle' },
    });
    expect(searched.result.isError).toBe(true);
    expect(searched.result.content[0].text).toMatch(/bundle is not installed/i);
  });

  it('makes concurrent first searches share one initialize-and-warmup attempt', async () => {
    const fx = readinessFixture();
    const mcp = startServer(fx, { STARTS_MARKER: fx.starts, WARMUPS_MARKER: fx.warmups });
    await mcp.request('initialize', {});
    const [first, second] = await Promise.all([
      mcp.request('tools/call', { name: 'search_ruvnet', arguments: { query: 'first' } }),
      mcp.request('tools/call', { name: 'search_ruvnet', arguments: { query: 'second' } }),
    ]);
    expect(first.result.content[0].text).toBe('ready result');
    expect(second.result.content[0].text).toBe('ready result');
    expect(fs.readFileSync(fx.starts, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.readFileSync(fx.warmups, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('warms exactly one replacement after the active generation changes', async () => {
    const fx = readinessFixture();
    const brainHome = path.join(fx.root, 'brain');
    fs.mkdirSync(brainHome, { recursive: true });
    fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({ generation: 1 }));
    const mcp = startServer(fx, { STARTS_MARKER: fx.starts, WARMUPS_MARKER: fx.warmups });
    await mcp.request('tools/call', { name: 'search_ruvnet', arguments: { query: 'one' } });
    fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({ generation: 2 }));
    await mcp.request('tools/call', { name: 'search_ruvnet', arguments: { query: 'two' } });
    expect(fs.readFileSync(fx.starts, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(fs.readFileSync(fx.warmups, 'utf8').trim().split('\n')).toHaveLength(2);
    const receipt = JSON.parse(fs.readFileSync(path.join(brainHome, 'mcp-readiness.json'), 'utf8'));
    expect(receipt.generation).toMatch(/^2:/);
  });

  it('retracts live readiness after a warmed worker crashes', async () => {
    const fx = crashingFixture();
    const mcp = startServer(fx);
    await mcp.request('initialize', {});
    const readinessPath = path.join(fx.root, 'brain', 'mcp-readiness.json');
    const deadline = Date.now() + 3000;
    let receipt = null;
    while (Date.now() < deadline) {
      try { receipt = JSON.parse(fs.readFileSync(readinessPath, 'utf8')); } catch { /* not written yet */ }
      if (receipt?.state === 'degraded') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(receipt).toMatchObject({ state: 'degraded', phase: 'worker-exit', retryable: true });
  });

  it('fully retires the warmed worker when the protocol shell receives SIGTERM', async () => {
    const fx = shutdownFixture();
    const mcp = startServer(fx, { WORKER_PID_MARKER: fx.workerPid });
    await mcp.request('initialize', {});
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(fx.workerPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const workerPid = Number(fs.readFileSync(fx.workerPid, 'utf8'));
    const exited = new Promise((resolve) => mcp.child.once('exit', resolve));
    mcp.child.kill('SIGTERM');
    await exited;
    let workerAlive = true;
    const workerDeadline = Date.now() + 1000;
    while (workerAlive && Date.now() < workerDeadline) {
      try { process.kill(workerPid, 0); } catch { workerAlive = false; }
      if (workerAlive) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (workerAlive) {
      try { process.kill(workerPid, 'SIGKILL'); } catch { /* already stopped */ }
    }
    expect(workerAlive).toBe(false);
  });

  it('advertises the two schema-validated tools through the actual tools/list protocol', async () => {
    const mcp = startServer(fixture());
    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const listed = await mcp.request('tools/list');
    const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
    expect(tools.has('search_ruvnet')).toBe(true);
    expect(tools.has('ruvnet_cli_help')).toBe(true);
    expect(tools.has('ruvnet_cli_run')).toBe(true);
    expect(tools.get('ruvnet_cli_help').inputSchema.properties.executable.enum).toHaveLength(7);
    expect(tools.get('ruvnet_cli_run').inputSchema.properties.argv.type).toBe('array');
  });

  it('keeps protocol-shell declarations independent of worker discovery', async () => {
    const fx = fixture({ withBrain: true });
    const mcp = startServer(fx);
    const listed = await mcp.request('tools/list');
    const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
    expect(tools.get('search_ruvnet').description).toMatch(/first call may wait/i);
    expect(fs.existsSync(fx.warmup)).toBe(false);
    expect(tools.has('ruvnet_cli_help')).toBe(true);
    expect(tools.has('ruvnet_cli_run')).toBe(true);
  });

  it('fails closed for unknown names and for a run without a fresh successful help stamp', async () => {
    const fx = fixture();
    const mcp = startServer(fx);
    const unknown = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'unknown-cli', argv: ['memory', 'search'] },
    });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toMatch(/unknown managed executable/i);

    const unstamped = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'ruflo', argv: ['memory', 'search', '-q', 'x'] },
    });
    expect(unstamped.result.isError).toBe(true);
    expect(unstamped.result.content[0].text).toMatch(/read the interface first/i);
    expect(lines(fx.calls)).toEqual([]);
  });

  it('stamps only after successful help, then executes literal argv with shell metacharacters inert', async () => {
    const fx = fixture();
    const mcp = startServer(fx);

    const helped = await mcp.request('tools/call', {
      name: 'ruvnet_cli_help',
      arguments: { executable: 'ruflo', argv: ['memory', 'search'] },
    });
    expect(helped.result.isError).not.toBe(true);
    expect(lines(fx.calls)).toEqual([['memory', 'search', '--help']]);

    const injected = path.join(fx.root, 'must-not-exist');
    const run = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: {
        executable: 'ruflo',
        argv: ['memory', 'search', ';', 'touch', injected, '$(touch nope)', '|', 'cat'],
      },
    });
    expect(run.result.isError).not.toBe(true);
    expect(lines(fx.calls)[1]).toEqual([
      'memory', 'search', ';', 'touch', injected, '$(touch nope)', '|', 'cat',
    ]);
    expect(fs.existsSync(injected)).toBe(false);
    expect(fs.existsSync(path.join(REPO, 'nope'))).toBe(false);
  });

  it('enforces live routing and QE-fleet choices before either real executable starts', async () => {
    const fx = fixture();
    const configDir = path.join(fx.home, '.claude', 'ruvnet-brain');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      routing: 'off',
      qeFleet: false,
    }));
    const mcp = startServer(fx);

    for (const [executable, helpArgv] of [
      ['agentic-flow', []],
      ['agentic-qe', ['fleet', 'run']],
    ]) {
      const helped = await mcp.request('tools/call', {
        name: 'ruvnet_cli_help',
        arguments: { executable, argv: helpArgv },
      });
      expect(helped.result.isError).not.toBe(true);
    }
    const before = lines(fx.calls).length;
    const routedOff = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'agentic-flow', argv: ['--agent', 'researcher', '--task', 'x'] },
    });
    expect(routedOff.result.isError).toBe(true);
    expect(routedOff.result.content[0].text).toMatch(/routing is off/i);
    const fleetOff = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'agentic-qe', argv: ['fleet', 'run', 'test', '--target', '.'] },
    });
    expect(fleetOff.result.isError).toBe(true);
    expect(fleetOff.result.content[0].text).toMatch(/fleet is off/i);
    expect(lines(fx.calls)).toHaveLength(before);

    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      routing: 'auto',
      qeFleet: true,
    }));
    const routedOn = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'agentic-flow', argv: ['--agent', 'researcher', '--task', 'x'] },
    });
    expect(routedOn.result.isError).not.toBe(true);
    const fleetOn = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'agentic-qe', argv: ['fleet', 'run', 'test', '--target', '.'] },
    });
    expect(fleetOn.result.isError).not.toBe(true);
    expect(lines(fx.calls).slice(-2)).toEqual([
      ['--agent', 'researcher', '--task', 'x'],
      ['fleet', 'run', 'test', '--target', '.'],
    ]);
  });

  it('fails closed when a CLI exits zero but reports a fatal persistence error', async () => {
    const fx = fatalFixture();
    const mcp = startServer(fx);
    const helped = await mcp.request('tools/call', {
      name: 'ruvnet_cli_help',
      arguments: { executable: 'ruflo', argv: ['memory', 'store'] },
    });
    expect(helped.result.isError).not.toBe(true);
    const run = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'ruflo', argv: ['memory', 'store', '-k', 'proof', '--value', 'x'] },
    });
    expect(run.result.isError).toBe(true);
    expect(run.result.content[0].text).toMatch(/invalid pragma/i);
  });

  it('does not stamp a failed help call and rejects a stale stamp', async () => {
    const fx = fixture();
    const mcp = startServer(fx);
    const failed = await mcp.request('tools/call', {
      name: 'ruvnet_cli_help',
      arguments: { executable: 'ruflo', argv: ['fail'] },
    });
    expect(failed.result.isError).toBe(true);

    const afterFailure = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'ruflo', argv: ['fail'] },
    });
    expect(afterFailure.result.isError).toBe(true);

    const helped = await mcp.request('tools/call', {
      name: 'ruvnet_cli_help',
      arguments: { executable: 'ruflo', argv: ['memory', 'search'] },
    });
    expect(helped.result.isError).not.toBe(true);
    const stamp = path.join(fx.root, 'brain', 'help-read', 'ruflo.memory.search');
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(stamp, stale, stale);

    const afterStale = await mcp.request('tools/call', {
      name: 'ruvnet_cli_run',
      arguments: { executable: 'ruflo', argv: ['memory', 'search'] },
    });
    expect(afterStale.result.isError).toBe(true);
    expect(afterStale.result.content[0].text).toMatch(/read the interface first/i);
  });

  it('replaces a hostile stamp symlink without following it', async () => {
    const fx = fixture();
    const stampDir = path.join(fx.root, 'brain', 'help-read');
    const stamp = path.join(stampDir, 'ruflo.memory.search');
    const victim = path.join(fx.root, 'victim.txt');
    fs.mkdirSync(stampDir, { recursive: true });
    fs.writeFileSync(victim, 'must remain intact');
    fs.symlinkSync(victim, stamp);

    const mcp = startServer(fx);
    const helped = await mcp.request('tools/call', {
      name: 'ruvnet_cli_help',
      arguments: { executable: 'ruflo', argv: ['memory', 'search'] },
    });

    expect(helped.result.isError).not.toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('must remain intact');
    expect(fs.lstatSync(stamp).isSymbolicLink()).toBe(false);
    expect(fs.statSync(stamp).isFile()).toBe(true);
  });
});
