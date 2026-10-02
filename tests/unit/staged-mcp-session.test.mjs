import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseRetrievalResult } from '../../kb/retrieval-result.mjs';
import { createInstalledMcpSession, createRestartingMcpSession } from '../../scripts/host-install-matrix.mjs';
const roots = [], sessions = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});
function fixture({ timeout = 2000, ignoreTerm = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-session-')); roots.push(root);
  const file = path.join(root, 'trace.jsonl');
  const session = createInstalledMcpSession({ serverPath: path.resolve('tests/fixtures/staged-mcp-session.mjs'),
    env: { ...process.env, SESSION_TRACE: file, IGNORE_TERM: ignoreTerm ? '1' : '0' }, timeout, shutdownTimeout: 50 });
  sessions.push(session);
  return { session, trace: () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
it('reuses one child and initialize; serializes calls and preserves raw MCP results', async () => {
  const f = fixture();
  const results = await Promise.all(['smoke', 'first', 'second'].map((query, i) => f.session.search({ query, k: i ? 10 : 5 })));
  expect(results.map(({ status }) => status)).toEqual([0, 0, 0]);
  expect(results[1].mcpResult.structuredContent).toEqual({ query: 'first', k: 10 });
  await f.session.close();
  const trace = f.trace();
  expect(trace.filter(({ event }) => event === 'initialize')).toHaveLength(1);
  expect(new Set(trace.map(({ pid }) => pid)).size).toBe(1);
  expect(trace.filter(({ event }) => ['search', 'response'].includes(event)).map(({ event }) => event))
    .toEqual(['search', 'response', 'search', 'response', 'search', 'response']);
  expect(() => process.kill(trace[0].pid, 0)).toThrow();
});
it.each(['error', 'exit'])('closes on %s and does not send queued calls', async (query) => {
  const f = fixture();
  const result = await Promise.all([f.session.search({ query }), f.session.search({ query: 'queued' })]);
  expect(result.every(({ error, status }) => error && status !== 0)).toBe(true);
  expect(f.trace().filter(({ event }) => event === 'search').map(({ query }) => query)).toEqual([query]);
  expect(() => process.kill(f.trace()[0].pid, 0)).toThrow();
});
it('times out the active call, cancels queued work and force-reaps an uncooperative child', async () => {
  const f = fixture({ timeout: 200, ignoreTerm: true });
  // Start the child first on a generous bound: under load, spawn + initialize alone can exceed
  // 200ms, and then 'hang' was never sent and this test failed for the wrong reason.
  expect((await f.session.search({ query: 'ready', timeoutMs: 5000 })).status).toBe(0);
  const result = await Promise.all([f.session.search({ query: 'hang' }), f.session.search({ query: 'queued' })]);
  expect(result[0].error.code).toBe('ETIMEDOUT');
  expect(result[1].error).toBeTruthy();
  expect(f.trace().filter(({ event }) => event === 'search').map(({ query }) => query)).toEqual(['ready', 'hang']);
  expect(() => process.kill(f.trace()[0].pid, 0)).toThrow();
});
it('explicit close cancels in-flight and queued work without waiting for the search deadline', async () => {
  const f = fixture(); await f.session.search({ query: 'ready' });
  const active = f.session.search({ query: 'hang' });
  const queued = f.session.search({ query: 'queued' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await f.session.close();
  expect((await active).error).toBeTruthy(); expect((await queued).error).toBeTruthy();
  expect(f.trace().some(({ query }) => query === 'queued')).toBe(false);
});

it('preserves split UTF-8 bytes and their retrieval content digest across stdout chunks', async () => {
  const f = fixture();
  const result = await f.session.search({ query: 'split-utf8', k: 10 });
  expect(result.status).toBe(0);
  const rows = parseRetrievalResult(result.mcpResult, { query: 'split-utf8', k: 10 });
  expect(rows[0].text).toBe('source ─ 🧠 exact');
  expect(result.stdout).toBe('source ─ 🧠 exact');
});

// One slow canary case must fail only itself (4.4.1 preflight: cases 9-18 ETIMEDOUT after one stall).
function restarting({ timeout = 5000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-restart-')); roots.push(root);
  const file = path.join(root, 'trace.jsonl');
  const env = { ...process.env, SESSION_TRACE: file, IGNORE_TERM: '0' };
  const session = createRestartingMcpSession({
    open: () => createInstalledMcpSession({ serverPath: path.resolve('tests/fixtures/staged-mcp-session.mjs'), env, timeout, shutdownTimeout: 50 }),
    warm: (fresh) => fresh.search({ query: 'rewarm', timeoutMs: 2000 }),
  });
  sessions.push(session);
  return { session, trace: () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
it('a plain session turns every case after one timeout into the same timeout (the defect)', async () => {
  const f = fixture({ timeout: 5000 });
  const results = [];
  for (const query of ['first', 'hang', 'after-1', 'after-2']) results.push(await f.session.search({ query, timeoutMs: query === 'hang' ? 200 : 5000 }));
  expect(results.map((r) => r.error?.code ?? r.status)).toEqual([0, 'ETIMEDOUT', 'ETIMEDOUT', 'ETIMEDOUT']);
});
it('a restarting session fails only the slow case, re-warms a fresh worker, then answers the rest', async () => {
  const f = restarting({ timeout: 5000 });
  const results = [];
  for (const query of ['first', 'hang', 'after-1', 'after-2']) results.push(await f.session.search({ query, timeoutMs: query === 'hang' ? 200 : 5000 }));
  expect(results.map((r) => r.error?.code ?? r.status)).toEqual([0, 'ETIMEDOUT', 0, 0]);
  expect(results[2].mcpResult.structuredContent.query).toBe('after-1');
  expect(f.session.restarts).toBe(1);
  const searches = f.trace().filter(({ event }) => event === 'search');
  expect(searches.map(({ query }) => query)).toEqual(['first', 'hang', 'rewarm', 'after-1', 'after-2']);
  expect(new Set(searches.map(({ pid }) => pid)).size).toBe(2);
  await f.session.close();
});
it('keeps ONE worker across a whole lane when nothing fails', async () => {
  const f = restarting();
  for (const query of ['a', 'b', 'c']) expect((await f.session.search({ query })).status).toBe(0);
  expect(f.session.restarts).toBe(0);
  expect(new Set(f.trace().map(({ pid }) => pid)).size).toBe(1);
});
it('a failed re-warm fails that case honestly and the next case tries a fresh worker again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-rewarm-')); roots.push(root);
  const env = { ...process.env, SESSION_TRACE: path.join(root, 'trace.jsonl'), IGNORE_TERM: '0' };
  let warms = 0;
  const session = createRestartingMcpSession({
    open: () => createInstalledMcpSession({ serverPath: path.resolve('tests/fixtures/staged-mcp-session.mjs'), env, timeout: 200, shutdownTimeout: 50 }),
    warm: (fresh) => fresh.search({ query: (warms += 1) === 1 ? 'error' : 'rewarm', timeoutMs: 5000 }),
  });
  sessions.push(session);
  expect((await session.search({ query: 'hang', timeoutMs: 1000 })).error.code).toBe('ETIMEDOUT');
  expect((await session.search({ query: 'x', timeoutMs: 5000 })).error).toBeTruthy();
  expect((await session.search({ query: 'y', timeoutMs: 5000 })).status).toBe(0);
  expect(session.restarts).toBe(2);
});
it('close() ends the lane: later searches are refused, not reopened', async () => {
  const f = restarting();
  await f.session.search({ query: 'a' });
  await f.session.close();
  expect((await f.session.search({ query: 'b' })).error.message).toBe('MCP session closed');
  expect(new Set(f.trace().map(({ pid }) => pid)).size).toBe(1);
});
