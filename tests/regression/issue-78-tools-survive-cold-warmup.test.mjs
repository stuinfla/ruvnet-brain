import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ISSUE #78 — `search_ruvnet` must not disappear when a cold worker's warmup outlives the host's
 * tools/list deadline.
 *
 * WHY THIS FILE EXISTS AT ALL. #78 already had a proof:
 * tests/acceptance/issue-78-codex-cold-mcp.acceptance.test.mjs, which drives a REAL Codex binary.
 * That test is the better evidence when it can run — and on 2026-08-06 it could not run, because
 * the Codex account was out of credits:
 *
 *     {"type":"error","message":"You've hit your usage limit. … try again at Aug 7th, 2026 11:33 PM."}
 *
 * So the ONLY proof of this issue's core claim was gated on a third party's billing state. That is
 * not a property of our product, and a claim we can only substantiate on days when someone else's
 * quota allows it is not a claim we can honestly make on release day.
 *
 * This test measures the same guarantee at the protocol boundary, with no host, no network, and no
 * account: it speaks MCP to the real plugin/mcp/server.mjs over stdio.
 *
 * HOW IT FAILS ON BROKEN CODE (a test that cannot fail is not a test). The fake worker answers
 * `initialize` and then NEVER answers `brain/warmup`. The server's own warmup budget is
 * CHILD_INIT_TIMEOUT_MS = 60s (server.mjs:124), so any implementation that made tools/list — or a
 * managed-CLI call — wait on readiness would answer no sooner than 60 SECONDS. The bounds below are
 * an order of magnitude under that, so this file goes red the moment tools/list starts awaiting the
 * child. The assertion bounds MAGNITUDE, not merely direction.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER = path.join(ROOT, 'plugin', 'mcp', 'server.mjs');

// An order of magnitude under the server's own 60s warmup budget: comfortably above real answer
// latency (measured in milliseconds — these three replies never touch the worker), and far below
// what a readiness-awaiting implementation could possibly achieve.
const COLD_ANSWER_BUDGET_MS = 10_000;

const temps = [];
const procs = [];

afterEach(() => {
  for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// A worker that comes up and then STALLS FOREVER on warmup — the exact cold-start shape #78 reports.
const STALLED_WORKER = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  if (msg.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: {} });
  if (msg.method === 'brain/warmup') return;            // never answers — this IS the bug's condition
  if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'warm-only' }] });
});
`;

function startServer() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-issue78-proto-'));
  temps.push(root);
  const kb = path.join(root, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), STALLED_WORKER);

  const proc = spawn(process.execPath, [SERVER], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RUVNET_BRAIN_HOME: path.join(root, 'brain'),
      RUVNET_BRAIN_KB: kb,
      RUVNET_BRAIN_PROJECT_SETTINGS_FILE: path.join(root, 'absent.json'),
    },
  });
  procs.push(proc);

  // Buffer stdout and hand back whole JSON lines keyed by request id.
  const waiters = new Map();
  const seen = new Map();
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined || msg.id === null) continue;
      seen.set(msg.id, msg);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });

  const request = (id, method, params) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    if (seen.has(id)) return Promise.resolve(seen.get(id));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no reply to ${method} within ${COLD_ANSWER_BUDGET_MS}ms — the server is waiting on a warmup that never completes, which is issue #78`)),
        COLD_ANSWER_BUDGET_MS,
      );
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  };
  return { request };
}

describe('issue #78 — Brain tools stay declared and callable through a stalled cold warmup', () => {
  it('answers initialize, tools/list, and a managed-CLI call while warmup never completes', async () => {
    const { request } = startServer();
    const started = performance.now();

    const init = await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    expect(init.result?.protocolVersion, 'initialize must stay protocol-fast').toBeTruthy();

    // THE ISSUE ITSELF: the tool must be declared even though the worker behind it is still cold.
    const list = await request(2, 'tools/list', {});
    const names = (list.result?.tools || []).map((t) => t.name);
    expect(names, 'search_ruvnet vanishing from tools/list IS issue #78').toContain('search_ruvnet');
    expect(names).toContain('ruvnet_cli_help');
    expect(names).toContain('ruvnet_cli_run');

    // And a managed-CLI tool must actually EXECUTE during the stall — server.mjs:313 answers these
    // without touching the child, so being listed and being callable are separate facts and both
    // are part of the report.
    const call = await request(3, 'tools/call', { name: 'ruvnet_cli_help', arguments: { executable: 'agentic-qe', argv: [] } });
    expect(call.result, 'a listed-but-uncallable tool is the same outage wearing a disguise').toBeTruthy();
    expect(call.error).toBeUndefined();

    const elapsedMs = performance.now() - started;
    // The magnitude bound. The worker's warmup is still pending right now and will be for 60s.
    expect(elapsedMs, 'these three replies must never wait on worker readiness').toBeLessThan(COLD_ANSWER_BUDGET_MS);
  }, 40_000);
});
