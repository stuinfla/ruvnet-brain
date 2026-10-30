// Proof that the Codex boot surface a release changed is the surface a FRESH Codex session will load (issue #391,
// ADR-0070, ADR-0051). A receipt that names `scripts/hook-shim.mjs`, `mcp/server.mjs` or `skills/` as changed used to stay
// restartScope:'unproven' forever, because only the two hook-declaration files could be cleared. Each path is proven by
// the strongest evidence that can be gathered without a Codex relaunch, and any path with no prover stays unproven,
// NAMED in the result:
//   hooks/codex-hooks.json, hooks/hooks.json  the fresh-declarations proof (scripts/codex-fresh-host-proof.mjs)
//   skills/                                    that proof plus a byte-identical skills/ tree
//   scripts/hook-shim.mjs                      byte-identical AND a real run of the INSTALLED shim with an unknown hook
//                                              id (it exits 0 doing nothing and lists its roles; every registered Codex
//                                              role must be listed)
//   mcp/server.mjs                             byte-identical AND a real stdio initialize + tools/list that must
//                                              include search_ruvnet
// The result ALWAYS reports windows that are already open as `unproven` and a host relaunch as `not-observed`. It is
// read-only: both real processes run against an isolated temporary HOME and brain home (the MCP server leases its
// generation while running), under a hard deadline, and the temp tree is removed. It never touches a receipt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shellDiff } from '../plugin/scripts/host-shell-boundary.mjs';

export const BOOT_REASON_PREFIX = 'boot-level declarations changed: ';
export const PROVABLE_PATHS = Object.freeze(['hooks/codex-hooks.json', 'hooks/hooks.json', 'skills/',
  'scripts/hook-shim.mjs', 'mcp/server.mjs']);
const MAX_CAPTURE = 64 * 1024;

/** The changed paths a machine-generated sessionSafetyReason names, or [] when it names none. */
export function parseChangedPaths(reason) {
  if (typeof reason !== 'string' || !reason.startsWith(BOOT_REASON_PREFIX)) return [];
  return reason.slice(BOOT_REASON_PREFIX.length).split(', ').map((entry) => entry.trim()).filter(Boolean);
}

/** The hook roles a Codex hooks file registers: the id after the timeout in each `... <timeoutMs> <role> [event]` command. */
export function registeredCodexRoles(hooksFile) {
  const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const roles = new Set();
  for (const groups of Object.values(parsed.hooks || {})) {
    for (const group of groups) {
      for (const handler of group.hooks || []) {
        const match = /"\s+\d+\s+([a-z][a-z0-9-]*)(?:\s+\S+)?\s*$/.exec(String(handler.command || ''));
        if (match) roles.add(match[1]);
      }
    }
  }
  return [...roles];
}

// Windows cannot start node (or resolve DLLs, temp, shells) without these; copied only when present, never a secret.
const WINDOWS_NEEDS = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT'];
const IS_WIN = process.platform === 'win32';

/** SIGKILL the probe's whole process group (it is spawned detached, so it leads one); the child alone on Windows. */
function killTree(child) {
  try {
    if (!IS_WIN && Number.isInteger(child?.pid) && child.pid > 1) process.kill(-child.pid, 'SIGKILL');
    else child?.kill('SIGKILL');
  } catch { try { child?.kill('SIGKILL'); } catch { /* gone */ } }
}

export function isolatedEnv(tmp, extra = {}, source = process.env) {
  const needs = {};
  for (const name of WINDOWS_NEEDS) if (source[name]) needs[name] = source[name];
  const env = { ...needs, PATH: source.PATH || source.Path || '', HOME: tmp, USERPROFILE: tmp, TMPDIR: tmp,
    RUVNET_BRAIN_HOME: path.join(tmp, 'brain'), RUVNET_BRAIN_STATE_DIR: path.join(tmp, 'state'),
    XDG_CACHE_HOME: path.join(tmp, 'xdg'), XDG_CONFIG_HOME: path.join(tmp, 'xdgc'), CODEX_HOME: path.join(tmp, 'codex'),
    RUVNET_BRAIN_KB: path.join(tmp, 'kb'), RUVNET_NIGHTLY: '', ...extra };
  if (IS_WIN) { env.TEMP = tmp; env.TMP = tmp; }   // USERPROFILE is already the isolated tmp; TEMP/TMP must not point at the real profile
  return env;
}

function runBounded(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let timedOut = false; let settled = false;
    const child = spawn(process.execPath, args, { cwd, env, detached: !IS_WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout: out, stderr: err, timedOut, ...result }); };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout.on('data', (b) => { if (out.length < MAX_CAPTURE) out += b; });
    child.stderr.on('data', (b) => { if (err.length < MAX_CAPTURE) err += b; });
    child.once('error', (error) => finish({ code: null, signal: null, spawnError: error.message }));
    child.once('close', (code, signal) => { killTree(child); finish({ code, signal }); });
  });
}

/** Run the INSTALLED shim with an id it does not know. Proven only by exit 0 plus a role list covering every registered role. */
export async function runShimProbe({ installedRoot, roles, tmp, timeoutMs }) {
  const shim = path.join(installedRoot, 'scripts', 'hook-shim.mjs');
  const started = Date.now();
  const run = await runBounded([shim, 'boot-surface-proof-unknown-hook'], { cwd: tmp, env: isolatedEnv(tmp), timeoutMs });
  const elapsedMs = Date.now() - started;
  if (run.timedOut) return { ok: false, elapsedMs, reason: `the installed hook shim did not exit within ${timeoutMs} ms and was killed` };
  if (run.spawnError) return { ok: false, elapsedMs, reason: `the installed hook shim could not start: ${run.spawnError}` };
  if (run.code !== 0) return { ok: false, elapsedMs, reason: `the installed hook shim exited ${run.code ?? run.signal} for an unknown hook id (expected 0)` };
  const listed = /known:\s*([^\n]*)/.exec(run.stderr)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) || [];
  const missing = roles.filter((role) => !listed.includes(role));
  if (!listed.length) return { ok: false, elapsedMs, reason: 'the installed hook shim listed no hook roles' };
  if (missing.length) return { ok: false, elapsedMs, listed, reason: `the installed hook shim does not list registered Codex role(s): ${missing.join(', ')}` };
  return { ok: true, elapsedMs, rolesListed: listed.length, rolesRegistered: roles.length };
}

const STUB_WORKER = "require('node:fs').writeFileSync(process.env.RNB_PROOF_MARKER,String(process.pid));process.exit(0);\n";

/** Real stdio MCP handshake against the INSTALLED server: initialize, tools/list. Never starts the real search worker. */
export async function runMcpProbe({ installedRoot, tmp, timeoutMs }) {
  const server = path.join(installedRoot, 'mcp', 'server.mjs');
  const stub = path.join(tmp, 'stub-worker.cjs'); const marker = path.join(tmp, 'worker-started');
  fs.writeFileSync(stub, STUB_WORKER);
  const env = isolatedEnv(tmp, { RUVNET_BRAIN_CHILD_MCP: stub, RNB_PROOF_MARKER: marker });
  const started = Date.now();
  return await new Promise((resolve) => {
    let buffer = ''; let settled = false; let timedOut = false;
    const replies = new Map(); let stderr = '';
    const child = spawn(process.execPath, [server], { cwd: tmp, env, detached: !IS_WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => killTree(child);
    const deadline = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const send = (message) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); } catch { /* exit handler reports */ } };
    const done = (result) => { if (settled) return; settled = true; clearTimeout(deadline); resolve({ elapsedMs: Date.now() - started, ...result }); };
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== undefined) replies.set(message.id, message);
        if (message.id === 1) { send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/list', params: {} }); }
        if (message.id === 2) {
          // initialize launches the warm search worker in the background (plugin/mcp/server.mjs `void ensureChild()`); the
          // stub worker records that it was launched, so the result reports the fact instead of assuming it.
          setTimeout(() => { try { child.stdin.end(); } catch { /* gone */ } }, 400);
        }
      }
    });
    child.stderr.on('data', (b) => { if (stderr.length < MAX_CAPTURE) stderr += b; });
    child.once('error', (error) => done({ ok: false, reason: `the installed MCP server could not start: ${error.message}` }));
    child.once('close', (code, signal) => {
      killTree(child);
      const leaseLeft = fs.existsSync(path.join(tmp, 'brain', 'leases')) && fs.readdirSync(path.join(tmp, 'brain', 'leases')).length > 0;
      const initialize = replies.get(1); const list = replies.get(2);
      const workerStarted = fs.existsSync(marker);
      const base = { exit: code ?? signal, leaseLeftBehind: leaseLeft, initializeStartsWarmWorker: workerStarted };
      if (timedOut) return done({ ok: false, ...base, reason: `the installed MCP server did not finish an initialize + tools/list within ${timeoutMs} ms and was killed` });
      if (!initialize?.result) return done({ ok: false, ...base, reason: 'the installed MCP server did not answer initialize' });
      const names = Array.isArray(list?.result?.tools) ? list.result.tools.map((tool) => tool?.name) : null;
      if (!names) return done({ ok: false, ...base, reason: 'the installed MCP server did not answer tools/list' });
      if (!names.includes('search_ruvnet')) return done({ ok: false, ...base, tools: names, reason: 'the installed MCP server tools/list does not include search_ruvnet' });
      if (leaseLeft) return done({ ok: false, ...base, tools: names, reason: 'the installed MCP server left its lease file behind after exit' });
      return done({ ok: true, ...base, tools: names.length });
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'boot-surface-proof', version: '1' } } });
  });
}

/**
 * @param {object} o
 * @param {string[]} o.changedPaths        paths the convergence receipt names as changed at boot level
 * @param {string} o.releasedPluginRoot    the release being converged to (its plugin/ directory)
 * @param {string} o.installedPluginRoot   the plugin tree Codex loads (its plugin cache for the active version)
 * @param {object} [o.declarations]        a probeFreshCodexDeclarations() result; required for the declaration paths
 */
export async function proveCodexBootSurface({ changedPaths, releasedPluginRoot, installedPluginRoot, declarations = null, timeoutMs = 15_000 } = {}) {
  const proven = []; const unproven = [];
  const result = (extra = {}) => ({ ok: !extra.error && changedPaths?.length > 0 && unproven.length === 0,
    state: !extra.error && changedPaths?.length > 0 && unproven.length === 0 ? 'boot-surface-ready' : 'boot-surface-unproven',
    scope: 'fresh-codex-boot-surface', changed: changedPaths || [], proven, unproven,
    reason: extra.error || (unproven.length ? unproven.map((u) => `${u.path}: ${u.reason}`).join('; ') : null),
    existingWindows: 'unproven', hostRelaunch: 'not-observed', inferenceRequests: 0, ...extra.detail });
  if (!Array.isArray(changedPaths) || !changedPaths.length) return result({ error: 'no changed boot-level paths are recorded, so there is nothing to prove' });
  if (!releasedPluginRoot || !installedPluginRoot) return result({ error: 'the released or installed plugin root is unknown' });
  let diff;
  try { diff = new Set(shellDiff(installedPluginRoot, releasedPluginRoot)); }
  catch (error) { return result({ error: `the installed and released plugin trees could not be compared: ${error.message}` }); }
  const identical = (rel) => !diff.has(rel);
  const declarationsReady = declarations?.ok === true && declarations.state === 'fresh-declarations-ready';
  const wants = (rel) => changedPaths.includes(rel);
  let tmp = null; let shim = null; let mcp = null;
  try {
    if (wants('scripts/hook-shim.mjs') || wants('mcp/server.mjs')) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-boot-proof-'));
      for (const dir of ['brain', 'state', 'xdg', 'xdgc', 'codex', 'kb']) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    }
    for (const rel of changedPaths) {
      if (!PROVABLE_PATHS.includes(rel)) { unproven.push({ path: rel, reason: 'no prover exists for this path; it stays unproven' }); continue; }
      if (rel === 'hooks/codex-hooks.json' || rel === 'hooks/hooks.json') {
        if (declarationsReady) proven.push({ path: rel, evidence: 'fresh-declarations-ready' });
        else unproven.push({ path: rel, reason: `fresh Codex hook declarations are not proven${declarations?.reason ? ` (${declarations.reason})` : ''}` });
      } else if (rel === 'skills/') {
        if (!identical(rel)) unproven.push({ path: rel, reason: 'the installed skills/ tree is not byte-identical to the release' });
        else if (!declarationsReady) unproven.push({ path: rel, reason: `fresh Codex declarations are not proven${declarations?.reason ? ` (${declarations.reason})` : ''}` });
        else proven.push({ path: rel, evidence: 'byte-identical skills/ tree plus fresh-declarations-ready' });
      } else if (rel === 'scripts/hook-shim.mjs') {
        if (!identical(rel)) { unproven.push({ path: rel, reason: 'the installed hook shim is not byte-identical to the release' }); continue; }
        let roles;
        try { roles = registeredCodexRoles(path.join(installedPluginRoot, 'hooks', 'codex-hooks.json')); }
        catch (error) { unproven.push({ path: rel, reason: `the registered Codex roles could not be read: ${error.message}` }); continue; }
        shim = await runShimProbe({ installedRoot: installedPluginRoot, roles, tmp, timeoutMs });
        if (shim.ok) proven.push({ path: rel, evidence: `byte-identical; real run exited 0 and listed all ${shim.rolesRegistered} registered Codex roles` });
        else unproven.push({ path: rel, reason: shim.reason });
      } else if (rel === 'mcp/server.mjs') {
        if (!identical(rel)) { unproven.push({ path: rel, reason: 'the installed MCP server is not byte-identical to the release' }); continue; }
        mcp = await runMcpProbe({ installedRoot: installedPluginRoot, tmp, timeoutMs });
        if (mcp.ok) proven.push({ path: rel, evidence: `byte-identical; real stdio initialize + tools/list returned ${mcp.tools} tools including search_ruvnet` });
        else unproven.push({ path: rel, reason: mcp.reason });
      }
    }
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  return result({ detail: { ...(shim ? { shim } : {}), ...(mcp ? { mcp } : {}) } });
}
