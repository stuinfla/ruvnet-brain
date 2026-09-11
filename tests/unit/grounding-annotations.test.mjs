// tests/unit/grounding-annotations.test.mjs — search_ruvnet must DECLARE that it is read-only.
//
// Observed 2026-09-11 in a live Claude Code session at worktree HEAD 2eef2024: plan mode refused
// search_ruvnet three times ("Cannot call search_ruvnet while in plan mode"). The three managed-CLI
// tools in the same server carried `annotations` and were callable; search_ruvnet carried none, and
// a host that must assume the worst assumed it could mutate. The one tool whose job is grounding a
// plan in rUv's real source was unavailable at exactly the moment a plan gets written.
//
// This asserts the declaration ON THE WIRE (spawn the protocol shell, speak JSON-RPC, read
// tools/list) rather than grepping the source, because the shell is free to rewrite the list it
// publishes and a source grep would not notice.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

function toolsList() {
  return new Promise((resolve, reject) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-shell-'));
    const child = spawn('node', [path.join(REPO_ROOT, 'plugin/mcp/server.mjs')], {
      cwd: home,
      env: {
        ...process.env,
        RUVNET_BRAIN_HOME: home,
        RUVNET_BRAIN_KB: path.join(home, 'kb'),   // absent on purpose: tools/list must not need it
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const done = (fn, v) => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(home, { recursive: true, force: true }); fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`timed out; stderr: ${err}`)), 15_000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result?.tools) return done(resolve, msg.result.tools);
      }
    });
    child.on('error', (e) => done(reject, e));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });
}

describe('search_ruvnet declares its behaviour to the host', () => {
  it('publishes readOnlyHint so plan mode can call it', async () => {
    const tools = await toolsList();
    const search = tools.find((t) => t.name === 'search_ruvnet');
    expect(search, 'search_ruvnet must be registered').toBeTruthy();
    expect(search.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true,
    });
  }, 30_000);

  it('leaves the mutating managed CLI honestly annotated as NOT read-only', async () => {
    // The point of an annotation is that it discriminates. If every tool claimed readOnlyHint the
    // declaration would carry no information and a host could not protect anything.
    const tools = await toolsList();
    const run = tools.find((t) => t.name === 'ruvnet_cli_run');
    expect(run?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const registry = tools.find((t) => t.name === 'ruvnet_registry_latest');
    expect(registry?.annotations).toMatchObject({ readOnlyHint: true });
  }, 30_000);

  it('declares every registered tool — an unannotated tool is a "may mutate" claim by omission', async () => {
    const tools = await toolsList();
    const missing = tools.filter((t) => !t.annotations || typeof t.annotations.readOnlyHint !== 'boolean');
    expect(missing.map((t) => t.name)).toEqual([]);
  }, 30_000);
});
