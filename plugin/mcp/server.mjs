#!/usr/bin/env node
// ruvnet-brain MCP server — the Stable Spine's protocol shell (ADR-023 §4, v2 post-red-team).
//
// v1 was a launcher: spawn forge-mcp-all.mjs with stdio:'inherit' and get out of the way. That froze
// search_ruvnet's behavior at session start. v2 makes THIS process the stable protocol owner:
//
//   • The CLIENT connection (Claude Code ⇄ this process) is never proxied, dropped, or replayed.
//     This file answers initialize / ping / tools/list itself and owns every client id.
//   • The BRAIN runs in a warm CHILD (the KB's own forge-mcp-all.mjs, unchanged) that this process
//     supervises over a PRIVATE handshake: parent sends its OWN initialize with parent-allocated
//     ids and forwards tools/call with id remapping — the client's handshake is never replayed to
//     anyone (red-team findings 7/8: no external-handshake replay, ids remapped both directions).
//   • HOT SWAP: between requests (never mid-flight — finding 9: swap only when pendingCount === 0),
//     the child is respawned when the spine generation changes (active.json) or the brain's own
//     code file changed on disk (KB-track update). The NEXT call answers from the new brain; a call
//     in flight completes on the old one. Claude Code notices nothing.
//   • LEASE (finding 23): this process leases the generation it serves (leases/mcp-<pid>.json,
//     refreshed per call) so update-apply.mjs --gc never collects a tree still being served.
//   • Child death: pending calls get a JSON-RPC error (never a parent exit); the child respawns
//     lazily on the next call. If the brain is absent entirely, tools/call returns an honest
//     soft-error tool result with install guidance — the tool stays registered, never vanishes.
//
// Brain location resolution (unchanged from v1):
//   1) $RUVNET_BRAIN_KB   2) $RUVNET_BRAIN_HOME/kb   3) ~/.cache/ruvnet-brain/kb
// Model cache: $KB_MODEL_CACHE, else <home>/models.
//
// SHELL CONTRACT: this file is boot-frozen (CC spawns it once per session). Changing IT — or the
// tool's declared name/schema — is a shell change, honestly flagged requiresRestart by the release
// classifier. Everything it delegates to updates hot.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { writeOwn as writeOwnReadiness } from '../scripts/mcp-readiness.mjs';
import { callManagedCli, MANAGED_CLI_TOOLS } from './managed-cli-interface.mjs';

const BRAIN_HOME = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain');
const KB = process.env.RUVNET_BRAIN_KB || path.join(BRAIN_HOME, 'kb');
const CHILD_MCP = process.env.RUVNET_BRAIN_CHILD_MCP || path.join(KB, 'forge-mcp-all.mjs');
const ACTIVE = path.join(BRAIN_HOME, 'active.json');
const LEASES = path.join(BRAIN_HOME, 'leases');
const LEASE = path.join(LEASES, `mcp-${process.pid}.json`);
const READINESS = path.join(BRAIN_HOME, 'mcp-readiness.json');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ruvnet-brain', version: '2.0.0' };
// Stable declarations belong to this protocol shell. Capability discovery must never wait for a
// model or vector store; the first operation that needs the worker joins its readiness promise.
const SEARCH_TOOL = {
  name: 'search_ruvnet',
  description: 'Source-grounded knowledge base for the RuvNet ecosystem. The first call may wait while the local search worker becomes ready.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language question or keywords about any part of RuvNet.' },
      k: { type: 'integer', description: 'Number of documents to return (default 6).', default: 6 },
    },
    required: ['query'],
  },
};
const FALLBACK_TOOLS = [SEARCH_TOOL, ...MANAGED_CLI_TOOLS];

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const clientOk = (id, result) => out({ jsonrpc: '2.0', id, result });
const clientErr = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/**
 * ISSUE #133 (second half). This used to write ONE shared file, last writer wins — so a second MCP
 * shell's `degraded` overwrote this one's `ready`, and `--doctor` reported the state of whichever
 * process wrote last as the state of the machine. A process now owns only its own record; the
 * machine-level answer is DERIVED from the live ones by mcp-readiness.mjs. Same fix as everything
 * else closed today: one producer per fact.
 */
function writeReadiness(value) {
  try {
    writeOwnReadiness(BRAIN_HOME, value);
  } catch (error) {
    console.error(`[ruvnet-brain] could not persist MCP readiness: ${error.message}`);
  }
}

function recordStartupFailure({ phase, startedAt, generation, error }) {
  const now = Date.now();
  const fields = {
    state: 'degraded', phase, generation, elapsedMs: now - startedAt,
    retryable: true, retryState: 'next-search-retries',
    error: String(error?.message || error || 'unknown startup failure').slice(0, 500),
  };
  writeReadiness(fields);
  const healthPath = path.join(BRAIN_HOME, 'health.json');
  try {
    fs.mkdirSync(BRAIN_HOME, { recursive: true });
    const tmp = `${healthPath}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({
      status: 'down', source: 'mcp-parent-startup', phase,
      error: fields.error, elapsedMs: fields.elapsedMs, generation,
      retryState: fields.retryState, ts: new Date(now).toISOString(),
    })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, healthPath);
  } catch (writeError) {
    console.error(`[ruvnet-brain] could not persist startup health: ${writeError.message}`);
  }
}

function currentGeneration() {
  const a = readJSON(ACTIVE);
  let brainMtime = 0;
  try { brainMtime = fs.statSync(CHILD_MCP).mtimeMs; } catch { /* brain absent */ }
  return `${a?.generation ?? 0}:${brainMtime}`;
}
function refreshLease() {
  try {
    fs.mkdirSync(LEASES, { recursive: true });
    fs.writeFileSync(LEASE, JSON.stringify({ pid: process.pid, version: readJSON(ACTIVE)?.version ?? null, at: new Date().toISOString() }));
  } catch { /* lease is best-effort */ }
}
process.on('exit', () => { try { fs.rmSync(LEASE, { force: true }); } catch { /* gone */ } });

// ── the warm child + private protocol ───────────────────────────────────────────────────────────
let child = null;            // { proc, generation, nextId, pending: Map<childId, {resolve, reject}> }
let pendingCount = 0;        // client tools/call requests currently in flight (drain gate for swaps)
let childRetirement = Promise.resolve();
let childStartup = null;
let childIdleTimer = null;
const CHILD_TERM_GRACE_MS = 3_000;
const CHILD_INIT_TIMEOUT_MS = Number(process.env.RUVNET_BRAIN_INIT_TIMEOUT_MS) || 60_000;
const CHILD_IDLE_MS = Number(process.env.RUVNET_BRAIN_CHILD_IDLE_MS) || 30 * 60_000;

function clearChildIdleTimer() {
  if (childIdleTimer) clearTimeout(childIdleTimer);
  childIdleTimer = null;
}

function armChildIdleTimer(c = child) {
  clearChildIdleTimer();
  if (!c || CHILD_IDLE_MS <= 0) return;
  childIdleTimer = setTimeout(() => {
    childIdleTimer = null;
    if (child !== c) return;
    if (pendingCount > 0 || c.pending.size > 0 || childStartup) {
      armChildIdleTimer(c);
      return;
    }
    void killChild(`idle for ${CHILD_IDLE_MS / 1000}s`);
  }, CHILD_IDLE_MS);
  childIdleTimer.unref?.();
}

function killChild(reason) {
  clearChildIdleTimer();
  if (!child) return childRetirement;
  const c = child; child = null;
  c.intentionalStop = true;
  for (const [, p] of c.pending) p.reject(new Error(`brain worker ${reason}`));
  c.pending.clear();
  childRetirement = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      resolve();
    };
    c.proc.once('exit', finish);
    const force = setTimeout(() => {
      try { c.proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, CHILD_TERM_GRACE_MS);
    force.unref?.();
  });
  try { c.proc.kill('SIGTERM'); } catch { /* already dead */ }
  return childRetirement;
}

async function ensureChild() {
  const gen = currentGeneration();
  if (child && child.generation !== gen && pendingCount === 0) await killChild('superseded by a newer generation');
  // A concurrent initialize/tools-list/tools-call must join the same readiness promise. Returning
  // `child` while its private initialize or model warmup is still running advertises a half-ready
  // worker and charges cold-start to the first user call.
  if (childStartup) return childStartup;
  if (child) return child;
  await childRetirement;
  if (!fs.existsSync(CHILD_MCP)) return null;

  if (!childStartup) {
    childStartup = (async () => {
      const startedAt = Date.now();
      let phase = 'initialize';
      const env = { ...process.env, KB_DIR: KB };
      if (!env.KB_MODEL_CACHE) env.KB_MODEL_CACHE = path.join(BRAIN_HOME, 'models');
      const proc = spawn(process.execPath, [CHILD_MCP], { stdio: ['pipe', 'pipe', 'inherit'], env });
      const c = { proc, generation: currentGeneration(), nextId: 1, pending: new Map(), intentionalStop: false };
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        let msg; try { msg = JSON.parse(line); } catch { return; }
        const waiter = c.pending.get(msg.id);
        if (waiter) { c.pending.delete(msg.id); waiter.resolve(msg); }
      });
      proc.on('exit', (code, signal) => {
        if (child === c) child = null;
        for (const [, p] of c.pending) p.reject(new Error('brain worker exited'));
        c.pending.clear();
        // A CLEAN EXIT IS NOT A CRASH (issue #133, the sibling of the #122 idle-exit fix).
        //
        // #122 gave the worker a 15-minute idle retirement so a quiet session stops holding 3-15GB.
        // It exits deliberately, with process.exit(0). This handler only knew about
        // `intentionalStop`, which the PARENT sets when IT kills the child — so the worker retiring
        // ITSELF was recorded as `degraded / worker-exit … exited unexpectedly`, and --doctor then
        // exited 1 on a machine where nothing was wrong and the next search would respawn it by
        // design. A fix that frees memory should not make the product report itself broken.
        //
        // Exit 0 with no signal is a deliberate stop — the idle retirement, or stdin EOF when the
        // host goes away. A crash carries a non-zero code or a signal, and still degrades.
        const cleanExit = code === 0 && !signal;
        if (!c.intentionalStop && !cleanExit) {
          writeReadiness({
            state: 'degraded', phase: 'worker-exit', generation: c.generation,
            elapsedMs: Date.now() - startedAt, retryable: true,
            retryState: 'next-search-retries', error: 'brain worker exited unexpectedly',
          });
        }
      });
      proc.on('error', () => { if (child === c) child = null; });
      child = c;

      try {
        await childRequest(c, 'initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ruvnet-brain-shell', version: SERVER_INFO.version },
        }, CHILD_INIT_TIMEOUT_MS, { reportTimeout: false });
        phase = 'warmup';
        const warmed = await childRequest(c, 'brain/warmup', {}, CHILD_INIT_TIMEOUT_MS, { reportTimeout: false });
        // Rolling-upgrade compatibility: 4.0.1 workers predate the private warmup extension. The
        // stable shell is installed before the 700MB KB swap completes, so rejecting -32601 here
        // makes every query fail during the exact in-place upgrade window the shell exists to hide.
        // An older initialized worker is usable (its first query may be cold); any other warmup
        // failure still fails closed.
        const warmupUnsupported = warmed.error?.code === -32601
          || /method not found/i.test(String(warmed.error?.message || ''));
        if (!warmupUnsupported && (warmed.error || warmed.result?.ready !== true)) {
          throw new Error(warmed.error?.message || 'brain worker did not confirm warm readiness');
        }
      } catch (e) {
        await killChild('failed initialize');
        recordStartupFailure({ phase, startedAt, generation: c.generation, error: e });
        throw new Error(`brain worker failed to initialize: ${e.message}`);
      }
      writeReadiness({
        state: 'ready', phase, generation: c.generation,
        workerPid: c.proc.pid, elapsedMs: Date.now() - startedAt,
        retryable: false, retryState: 'none',
      });
      armChildIdleTimer(c);
      return c;
    })();
  }
  const attempt = childStartup;
  try { return await attempt; }
  finally { if (childStartup === attempt) childStartup = null; }
}

// A TIMEOUT IS AN OUTAGE, and it must both STOP and be RECORDED. Measured 2026-07-27: the timeout
// below deleted its pending entry and rejected, and did nothing else — so
//   (a) the child kept computing an answer nobody would ever read, at ~95% CPU, and on the
//       all-repos path (605 cross-encoder pairs, a fan-out that alone exceeds this deadline) that
//       is minutes of burn per abandoned query, which then slows the RETRY, which times out too; and
//   (b) nothing wrote health.json, so a total retrieval failure read as healthy. The live file
//       said "status":"ok" dated four days earlier while every query was timing out.
// (b) is the worse half: the product reporting green while it is down is the one thing it may
// never do. The child's own alarm cannot cover this — it only rings when a search RETURNS failure,
// and a timeout is precisely the case where it never returns at all. Only the parent can see it.
async function onChildTimeout(method, timeoutMs) {
  killChild(`timed out after ${timeoutMs / 1000}s on ${method}`); // stop the burn; ensureChild() respawns
  try {
    const alarm = await import(new URL('../../kb/brain-alarm.mjs', import.meta.url).href);
    await alarm.reportBrainDown({
      error: `brain worker timed out after ${timeoutMs / 1000}s on ${method} (no answer returned)`,
      source: 'mcp-parent-timeout',
    });
  } catch (e) {
    // REPORTED, never swallowed: brain-alarm.mjs lives in the KB, which can legitimately be absent
    // or half-installed — but a health reporter that fails silently is the same lie one layer down.
    console.error(`[ruvnet-brain] timeout on ${method} could not be recorded to health.json: ${e.message}`);
  }
}

// Overridable so the outage path above can actually be TESTED. The default matches the installer's
// real cold-start smoke budget: measured 153s after a cache repair on 2026-07-29. A 120s parent
// deadline killed the model just before it became usable and forced every retry to start cold.
// Steady-state latency remains a separate release gate; this budget prevents a permanent cold loop.
const CALL_TIMEOUT_MS = Number(process.env.RUVNET_BRAIN_CALL_TIMEOUT_MS) || 240_000;

function childRequest(c, method, params, timeoutMs = CALL_TIMEOUT_MS, { reportTimeout = true } = {}) {
  return new Promise((resolve, reject) => {
    const id = c.nextId++;
    const timer = setTimeout(() => {
      c.pending.delete(id);
      reject(new Error(`brain worker timeout on ${method}`));
      if (reportTimeout) void onChildTimeout(method, timeoutMs); // caller never waits on the alarm
    }, timeoutMs);
    c.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    try { c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (e) { clearTimeout(timer); c.pending.delete(id); reject(e); }
  });
}

// ── client protocol ─────────────────────────────────────────────────────────────────────────────
async function handleClient(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications need no answer
  switch (method) {
    case 'initialize':
      // MCP initialize itself stays protocol-fast; normal clients request tools/list immediately
      // afterwards, which joins this readiness promise and does not receive the tool declaration
      // until the worker's query embedder and cross-encoder are warm.
      void ensureChild().catch((e) => {
        console.error(`[ruvnet-brain] worker warmup failed during initialize: ${e.message}`);
      });
      return clientOk(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'ping':
      return clientOk(id, {});
    case 'tools/list': {
      return clientOk(id, { tools: FALLBACK_TOOLS });
    }
    case 'tools/call': {
      if (params?.name === 'ruvnet_cli_help' || params?.name === 'ruvnet_cli_run'
        || params?.name === 'ruvnet_registry_latest') {
        return clientOk(id, await callManagedCli(params.name, params.arguments || {}));
      }
      if (params?.name !== 'search_ruvnet') return clientErr(id, -32602, `unknown tool: ${params?.name}`);
      refreshLease();
      let c;
      try {
        c = await ensureChild();
      } catch (e) {
        return clientOk(id, {
          content: [{ type: 'text', text: `search_ruvnet error: brain worker temporarily unavailable (${e.message})` }],
          isError: true,
        });
      }
      if (!c) {
        return clientOk(id, { content: [{ type: 'text', text: `search_ruvnet error: the brain bundle is not installed at ${KB}. Install it with: npx github:stuinfla/ruvnet-brain  (or set RUVNET_BRAIN_KB to your brain's kb dir).` }], isError: true });
      }
      pendingCount++;
      try {
        const r = await childRequest(c, 'tools/call', params);
        if (r.error) return clientErr(id, r.error.code ?? -32603, r.error.message ?? 'brain worker error');
        return clientOk(id, r.result);
      } catch (e) {
        return clientOk(id, { content: [{ type: 'text', text: `search_ruvnet error: ${e.message}` }], isError: true });
      } finally {
        pendingCount--;
        armChildIdleTimer(c);
      }
    }
    default:
      return clientErr(id, -32601, `unknown method: ${method}`);
  }
}

const clientRl = readline.createInterface({ input: process.stdin });
clientRl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; } // malformed line: ignore, never crash
  handleClient(msg).catch((e) => { if (msg.id !== undefined && msg.id !== null) clientErr(msg.id, -32603, e.message); });
});
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  await killChild(reason);
  process.exit(0);
}
clientRl.on('close', () => { void shutdown('client disconnected'); });
process.once('SIGTERM', () => { void shutdown('parent received SIGTERM'); });
process.once('SIGINT', () => { void shutdown('parent received SIGINT'); });
