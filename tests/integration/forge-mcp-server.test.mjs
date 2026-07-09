// tests/integration/forge-mcp-server.test.mjs — kb/forge-mcp.mjs is a SECOND, complete MCP
// JSON-RPC stdio server (single-repo mode), independent of kb/forge-mcp-all.mjs (multi-repo mode).
// It is live, shipped code — referenced by kb/package.json, kb/mcp.snippet.json, and bundled by
// scripts/build-bundle.mjs — yet has ZERO test execution anywhere, not even the conditional
// REQUIRE_BRAIN CI battery (plugin/test/run-tests.mjs only spawns forge-mcp-all.mjs's sibling
// plugin/mcp/server.mjs). Found during the 2026-07-08 coverage-gap pass; not in prior audits.
//
// WHY SUBPROCESS, NOT IMPORT: same reasoning as build-bundle-fence.test.mjs — forge-mcp.mjs has
// top-level side effects (KB_NAME env check + process.exit(2), an unref'd orphan-guard
// setInterval, process.stdin listeners attached at import time). Importing it in-process would
// attach real stdin listeners to the test runner's own process and could exit it.
//
// SCOPE: only the protocol-level paths are exercised here (initialize/ping/tools-list/unknown-
// method/unknown-tool/empty-query/malformed-JSON-line/missing-KB_NAME fail-fast). The tools/call
// SUCCESS path (a real search_kb hit) needs a real built .rvf + .passages.jsonl fixture — out of
// scope for this file; see the .todo below for what that fixture needs to contain.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-server-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Spawns forge-mcp.mjs, writes one JSON-RPC request line, resolves with the first stdout line
// parsed back to an object (or rejects on a timeout — a hang here means the server never responded).
function callOnce(request, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(REPO_ROOT, 'kb/forge-mcp.mjs')], {
      cwd: tmp,
      env: { ...process.env, KB_NAME: 'testkb', KB_DIR: tmp, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out; stderr: ${err}`)); }, 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        child.kill();
        try { resolve(JSON.parse(out.slice(0, nl))); } catch (e) { reject(e); }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => { if (out.indexOf('\n') < 0) { clearTimeout(timer); resolve({ __exitCode: code, __stderr: err }); } });
    if (request) child.stdin.write(JSON.stringify(request) + '\n');
  });
}

describe('forge-mcp.mjs — JSON-RPC protocol surface (subprocess)', () => {
  it('responds to initialize with protocolVersion + serverInfo naming the KB', async () => {
    const res = await callOnce({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.serverInfo.name).toBe('rvf-kb-forge:testkb');
  });

  it('responds to ping with an empty result', async () => {
    const res = await callOnce({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(res.result).toEqual({});
  });

  it('tools/list returns exactly the one search_kb tool with its input schema', async () => {
    const res = await callOnce({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(res.result.tools).toHaveLength(1);
    expect(res.result.tools[0].name).toBe('search_kb');
    expect(res.result.tools[0].inputSchema.required).toEqual(['query']);
  });

  it('returns JSON-RPC error -32601 for an unknown method', async () => {
    const res = await callOnce({ jsonrpc: '2.0', id: 4, method: 'not/a/real/method' });
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toMatch(/method not found/);
  });

  it('returns JSON-RPC error -32602 for tools/call with an unknown tool name', async () => {
    const res = await callOnce({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'not_search_kb', arguments: {} } });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/unknown tool/);
  });

  it('returns JSON-RPC error -32602 for tools/call with an empty/whitespace query', async () => {
    const res = await callOnce({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'search_kb', arguments: { query: '   ' } } });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/query is required/);
  });

  it('silently ignores a malformed JSON line on stdin rather than crashing (no response, no exit)', async () => {
    // Send raw malformed JSON directly, bypassing callOnce's JSON.stringify.
    const child = spawn('node', [path.join(REPO_ROOT, 'kb/forge-mcp.mjs')], {
      cwd: tmp, env: { ...process.env, KB_NAME: 'testkb', KB_DIR: tmp }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stdin.write('{ this is not json\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
    await new Promise((r) => setTimeout(r, 300));
    child.kill();
    expect(JSON.parse(out.trim())).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
  });

  it('fails fast (exit code 2, stderr message) when KB_NAME env is not set', async () => {
    const res = await callOnce(null, { KB_NAME: '' });
    expect(res.__exitCode).toBe(2);
    expect(res.__stderr).toMatch(/KB_NAME env is required/);
  });
});

describe.todo('forge-mcp.mjs — tools/call search_kb SUCCESS path (requires a tiny real fixture: '
  + 'testkb.rvf + testkb.passages.jsonl built via kb/forge-build.mjs against a 1-2 file sample repo)', () => {
  it.todo('returns formatted text with path/title/distance/full-document for each hit, joined by the "====" separator');
  it.todo('honors the k argument to cap the number of returned passages');
  it.todo('returns isError:true with a text message (NOT a JSON-RPC error) when searchKb throws — confirms errors are swallowed into a soft-error tool result, not a protocol-level error');
});

describe.todo('forge-mcp.mjs — orphan guard (SEC-0010 #12) (requires a process-tree harness: spawn a grandchild whose direct parent then exits, letting init/launchd reparent it, and assert self-exit within the 30s interval — flaky/slow enough to gate behind an explicit opt-in env like the REQUIRE_BRAIN tier)', () => {
  it.todo('exits within one interval tick after being re-parented to pid 1');
});
