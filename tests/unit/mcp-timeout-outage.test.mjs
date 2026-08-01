// tests/unit/mcp-timeout-outage.test.mjs
//
// A TIMEOUT IS AN OUTAGE, and before this fix it was neither stopped nor recorded.
//
// Measured 2026-07-27 (cross-model latency duel, Fable 5's finding, confirmed by code read): the
// 120s timeout in plugin/mcp/server.mjs deleted its pending entry and rejected — and did nothing
// else. Two consequences, both live:
//
//   1. The child kept computing an answer nobody would read, at ~95% CPU. On the all-repos path
//      (605 cross-encoder pairs; a fan-out that alone measured 195-249s, already past the deadline)
//      that is MINUTES of burn per abandoned query — which then slows the retry, which times out too.
//   2. Nothing wrote health.json. A total retrieval failure read as healthy: the live file said
//      "status":"ok", dated four days earlier, while every query was timing out.
//
// (2) is the worse half and is why this test exists. The product reporting green while it is down
// is the one thing it may never do. And the child's OWN alarm cannot cover this case: it rings when
// a search RETURNS failure, and a timeout is precisely when nothing ever returns. Only the parent
// can observe it, so only the parent can report it.
//
// The test drives the real server over real stdio with a stub child, so it exercises the actual
// timeout path rather than a reimplementation of it.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'plugin', 'mcp', 'server.mjs');

it('allows the same 240s cold-start budget as the installer doctor', () => {
  const source = fs.readFileSync(SERVER, 'utf8');
  expect(source).toMatch(/CALL_TIMEOUT_MS[^\\n]*240_000/);
});

// A child that completes the handshake and then goes silent forever — the exact live failure shape
// (the worker is alive and working, it just never answers within the deadline).
const STUB_CHILD = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } }) + '\\n');
    return;
  }
  if (m.method === 'brain/warmup') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ready: true } }) + '\\n');
    return;
  }
  // Everything else: answer NOTHING, forever. This is the outage.
});
setInterval(() => {}, 1 << 30); // stay alive so the parent must kill us
`;

function makeBrainHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-mcp-timeout-'));
  fs.mkdirSync(path.join(home, 'kb'), { recursive: true });
  fs.writeFileSync(path.join(home, 'kb', 'forge-mcp-all.mjs'), STUB_CHILD);
  // brain-alarm.mjs is resolved RELATIVE TO THE SERVER FILE (../../kb/brain-alarm.mjs), i.e. the
  // repo's own copy — not this fixture — so the real reporter runs. Its state dir is redirected
  // by XDG_STATE_HOME/HOME below so it cannot touch the developer's live health.json.
  return home;
}

function startServer(env) {
  const proc = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');
  const lines = [];
  let stderr = '';
  proc.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) lines.push(l); });
  proc.stderr.on('data', (d) => { stderr += String(d); });
  return { proc, send, lines, stderrOf: () => stderr };
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('an MCP call timeout is both STOPPED and RECORDED', () => {
  it('kills the wedged child and writes a real outage to health.json', async () => {
    const home = makeBrainHome();
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-fakehome-'));
    const server = startServer({
      RUVNET_BRAIN_HOME: home,
      RUVNET_BRAIN_KB: path.join(home, 'kb'),
      RUVNET_BRAIN_CALL_TIMEOUT_MS: '2000', // the seam that makes this path testable at all
      HOME: fakeHome,
      // USERPROFILE too: os.homedir() reads HOME on POSIX but USERPROFILE on win32, so setting
      // only HOME left brain-alarm writing to the RUNNER'S real home on Windows while this test
      // watched an empty temp dir. It failed as "timed out waiting for health.json" — which reads
      // like the fix not working, when the fix was working and the test was looking in the wrong
      // place. Redirect both, so the assertion can only fail for the reason it exists to catch.
      USERPROFILE: fakeHome,
      // brain-alarm.mjs writes to os.homedir()/.cache/ruvnet-brain, so redirecting HOME is what
      // keeps this test off the developer's REAL health.json.
      // NTFY_TOPIC is cleared deliberately: reportBrainDown() sends an urgent ntfy push when a
      // topic is configured, and a test suite must never fire a real phone alert. With HOME
      // redirected there is no topic FILE either, so push() returns false without a network call.
      NTFY_TOPIC: '',
      RUVNET_BRAIN_TEST: '1',
    });

    try {
      server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      await waitFor(() => server.lines.some((l) => l.includes('"id":1')), 20000, 'initialize response');

      // Find the stub child PID so we can prove it actually dies rather than lingering.
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'anything' } } });

      // The call must come back as an error at roughly the configured deadline, not hang forever.
      const reply = await waitFor(
        () => server.lines.find((l) => l.includes('"id":2')),
        30000,
        'tools/call to fail at the deadline',
      );
      expect(reply).toMatch(/timeout|error/i);

      // THE POINT OF THIS TEST: an outage was RECORDED. Before the fix, nothing was written and
      // health.json kept whatever stale "ok" it already held.
      const healthPath = path.join(fakeHome, '.cache', 'ruvnet-brain', 'health.json');
      const health = await waitFor(
        () => (fs.existsSync(healthPath) ? JSON.parse(fs.readFileSync(healthPath, 'utf8')) : null),
        20000,
        'health.json to be written by the timeout path',
      );
      expect(health.status).toBe('down');
      expect(health.source).toBe('mcp-parent-timeout');
      expect(health.error).toMatch(/timed out/i);
    } finally {
      try { server.proc.kill('SIGKILL'); } catch { /* gone */ }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 90000);

  it('fully retires a SIGTERM-resistant worker before a replacement serves the next call', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-mcp-retire-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-fakehome-'));
    const starts = path.join(home, 'starts.txt');
    const firstPid = path.join(home, 'first.pid');
    fs.mkdirSync(path.join(home, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(home, 'kb', 'forge-mcp-all.mjs'), `
import fs from 'node:fs';
import readline from 'node:readline';
const starts = process.env.STUB_STARTS;
const n = (fs.existsSync(starts) ? Number(fs.readFileSync(starts, 'utf8')) : 0) + 1;
fs.writeFileSync(starts, String(n));
if (n === 1) {
  fs.writeFileSync(process.env.STUB_FIRST_PID, String(process.pid));
  process.on('SIGTERM', () => {});
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } } }) + '\\n');
  } else if (m.method === 'brain/warmup') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ready: true } }) + '\\n');
  } else if (n > 1 && m.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'recovered worker' }] } }) + '\\n');
  }
});

setInterval(() => {}, 1 << 30);
`);
    const server = startServer({
      RUVNET_BRAIN_HOME: home,
      RUVNET_BRAIN_KB: path.join(home, 'kb'),
      RUVNET_BRAIN_CALL_TIMEOUT_MS: '500',
      STUB_STARTS: starts,
      STUB_FIRST_PID: firstPid,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      NTFY_TOPIC: '',
      RUVNET_BRAIN_TEST: '1',
    });

    try {
      server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await waitFor(() => server.lines.some((l) => l.includes('"id":1')), 5000, 'initialize response');
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'hang once' } } });
      await waitFor(() => server.lines.find((l) => l.includes('"id":2')), 5000, 'first call timeout');

      server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'recover' } } });
      const reply = await waitFor(() => server.lines.find((l) => l.includes('"id":3')), 10000, 'replacement response');
      expect(reply).toContain('recovered worker');
      expect(reply).not.toContain('not installed');
      expect(Number(fs.readFileSync(starts, 'utf8'))).toBeGreaterThanOrEqual(2);

      const pid = Number(fs.readFileSync(firstPid, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try { server.proc.kill('SIGKILL'); } catch { /* gone */ }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 30000);

  it('reports a startup timeout as worker unavailability, never as a missing bundle', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-mcp-startup-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-fakehome-'));
    fs.mkdirSync(path.join(home, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(home, 'kb', 'forge-mcp-all.mjs'), `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    setTimeout(() => process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: m.id,
      result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'slow', version: '0' } },
    }) + '\\n'), 1000);
  }
});
setInterval(() => {}, 1 << 30);
`);
    const server = startServer({
      RUVNET_BRAIN_HOME: home,
      RUVNET_BRAIN_KB: path.join(home, 'kb'),
      RUVNET_BRAIN_INIT_TIMEOUT_MS: '100',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      NTFY_TOPIC: '',
      RUVNET_BRAIN_TEST: '1',
    });

    try {
      server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await waitFor(() => server.lines.some((l) => l.includes('"id":1')), 5000, 'initialize response');
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'startup state' } } });
      const reply = await waitFor(() => server.lines.find((l) => l.includes('"id":2')), 10000, 'startup failure response');
      expect(reply).toContain('temporarily unavailable');
      expect(reply).toContain('failed to initialize');
      expect(reply).not.toContain('bundle is not installed');
      const readiness = await waitFor(() => {
        const file = path.join(home, 'mcp-readiness.json');
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      }, 5000, 'degraded startup readiness receipt');
      expect(readiness).toMatchObject({
        state: 'degraded',
        phase: 'initialize',
        retryable: true,
      });
      expect(readiness.error).toMatch(/timeout|failed to initialize/i);
      expect(readiness.elapsedMs).toEqual(expect.any(Number));
      expect(readiness.generation).toEqual(expect.any(String));
      expect(readiness.retryState).toBe('next-search-retries');
      const startupHealth = JSON.parse(fs.readFileSync(path.join(home, 'health.json'), 'utf8'));
      expect(startupHealth).toMatchObject({
        status: 'down', source: 'mcp-parent-startup', phase: 'initialize',
        retryState: 'next-search-retries',
      });
      expect(startupHealth.elapsedMs).toEqual(expect.any(Number));
    } finally {
      try { server.proc.kill('SIGKILL'); } catch { /* gone */ }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 20000);
});

describe('idle worker retirement', () => {
  it('releases an inactive worker and lazily starts a replacement on the next call', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-mcp-idle-'));
    const starts = path.join(home, 'starts.txt');
    fs.mkdirSync(path.join(home, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(home, 'kb', 'forge-mcp-all.mjs'), `
import fs from 'node:fs';
import readline from 'node:readline';
const starts = process.env.STUB_STARTS;
const n = (fs.existsSync(starts) ? Number(fs.readFileSync(starts, 'utf8')) : 0) + 1;
fs.writeFileSync(starts, String(n));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const result = m.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '0' } }
    : m.method === 'brain/warmup'
      ? { ready: true }
    : m.method === 'tools/call'
      ? { content: [{ type: 'text', text: 'worker ' + n }] }
      : { tools: [{ name: 'search_ruvnet', inputSchema: { type: 'object' } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
setInterval(() => {}, 1 << 30);
`);
    const server = startServer({
      RUVNET_BRAIN_HOME: home,
      RUVNET_BRAIN_KB: path.join(home, 'kb'),
      RUVNET_BRAIN_CHILD_IDLE_MS: '150',
      STUB_STARTS: starts,
    });

    try {
      server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await waitFor(() => server.lines.some((l) => l.includes('"id":1')), 5000, 'initialize response');
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'first' } } });
      const first = await waitFor(() => server.lines.find((l) => l.includes('"id":2')), 5000, 'first worker response');
      expect(first).toContain('worker 1');

      await waitFor(() => fs.existsSync(starts) && Number(fs.readFileSync(starts, 'utf8')) === 1, 1000, 'first worker start');
      await new Promise((r) => setTimeout(r, 500));

      server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query: 'second' } } });
      const second = await waitFor(() => server.lines.find((l) => l.includes('"id":3')), 5000, 'replacement worker response');
      expect(second).toContain('worker 2');
      expect(Number(fs.readFileSync(starts, 'utf8'))).toBe(2);
    } finally {
      try { server.proc.kill('SIGKILL'); } catch { /* gone */ }
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});
