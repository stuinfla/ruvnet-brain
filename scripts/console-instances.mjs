// console-instances.mjs — the installer's view of running Consoles: which receipts are real, and how
// to replace an owned Console that is still serving a pre-update runtime without asking anyone.
//
// Two owner-Mac failures (2026-09-30) this exists for:
//  1. Receipts left by Consoles that had long since died (2026-09-16/17) were counted as "stale
//     running" forever, so --doctor said pending-console-restart / FAILING with nothing to restart.
//     A receipt whose pid is gone AND whose port does not answer /api/runtime with the receipt's
//     own identity is debris: it is pruned.
//  2. After a successful --update the installer told the owner to "restart Console". The Console
//     already knows how to replace an owned stale instance of itself (scripts/onboarding-console.mjs
//     launchConsole, state 'stale-running': token-authenticated shutdown, then serve on the same
//     port). The installer now runs exactly that, from the freshly activated runtime, without --open.
//
// Everything here is synchronous because syncHostsAfterUpdate is; the one network probe runs in a
// bounded child node process.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PRODUCT = 'ruvnet-brain-console';
// The same identity fields onboarding-console.mjs sameRuntimeIdentity compares.
const IDENTITY_KEYS = ['product', 'schema', 'apiContract', 'pid', 'port', 'startedAt', 'scope',
  'scriptRealpath', 'runtimeVersion', 'sourceSha256'];

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; } // EPERM: alive, owned by someone else
}

/** GET 127.0.0.1:<port>/api/runtime → parsed JSON, or null. Bounded; never throws. */
export function probeRuntimeSync(port, timeoutMs = 1500) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const code = `const h=require('node:http');const r=h.get({host:'127.0.0.1',port:${port},path:'/api/runtime',timeout:${timeoutMs}},(s)=>{let b='';s.on('data',(c)=>{b+=c;});s.on('end',()=>{if(s.statusCode===200)process.stdout.write(b);process.exit(0);});});r.on('error',()=>process.exit(0));r.on('timeout',()=>{r.destroy();process.exit(0);});`;
  const run = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: timeoutMs + 1000, windowsHide: true });
  try { return run.stdout ? JSON.parse(run.stdout) : null; } catch { return null; }
}

export const sameIdentity = (left, right) => IDENTITY_KEYS.every((key) => left?.[key] === right?.[key]);

/**
 * Console receipts in `receiptDir`, with dead ones pruned. A receipt is dead only when BOTH hold:
 * its pid is not alive, and its port does not answer /api/runtime with the receipt's identity.
 * A receipt with no integer pid cannot be proven dead and is kept (counted as before).
 */
export function readConsoleReceipts(receiptDir, { alive = pidAlive, probe = probeRuntimeSync } = {}) {
  const live = [];
  const pruned = [];
  let names = [];
  try { names = fs.readdirSync(receiptDir).filter((name) => name.endsWith('.json')); }
  catch { return { live, pruned }; } // no receipt directory is the ordinary "no Console" state
  for (const name of names) {
    const file = path.join(receiptDir, name);
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (receipt?.product !== PRODUCT || receipt.schema !== 1) continue;
    if (Number.isInteger(receipt.pid) && receipt.pid > 0 && !alive(receipt.pid)) {
      const answer = probe(receipt.port);
      if (!answer || !sameIdentity(answer, receipt)) {
        try { fs.unlinkSync(file); } catch { /* raced or read-only: still not a running Console */ }
        pruned.push({ file, pid: receipt.pid, port: receipt.port ?? null, startedAt: receipt.startedAt ?? null });
        continue;
      }
    }
    live.push({ file, receipt });
  }
  return { live, pruned };
}

// The replacement Console is a user-facing process, not part of the installer run. It inherits the
// user's environment — provider API keys (ANTHROPIC/OPENAI/OPENROUTER/GEMINI/GOOGLE/XAI) the Console reads,
// HTTP(S)_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS its release fetch needs — minus the flags that describe
// THIS run: the scheduler's nightly identity, test-harness switches, the refresh-run lock token, Node/npm
// process plumbing. A denylist, so nothing the Console legitimately reads is silently lost.
const CONSOLE_ENV_DENY = new Set(['RUVNET_NIGHTLY', 'RUVNET_BRAIN_TEST', 'RUVNET_BRAIN_TEST_LATEST_TAG', 'RUVNET_BRAIN_SCHEDULER_TEST',
  'RUVNET_BRAIN_IMPORT_ONLY', 'RUVNET_BRAIN_NO_UPDATE_FALLBACK', 'RUVNET_STRICT_INSTALL', 'RUVNET_REFRESH_RUN_TOKEN',
  'RUVNET_REFRESH_RECEIPT', 'RUVNET_UPGRADE_NOTICE_FILE', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'INIT_CWD', 'CONSOLE_PORT']);
const CONSOLE_ENV_DENY_PREFIX = /^(?:RUVNET_NIGHTLY_|npm_|VITEST)/;
export function consoleEnv(env = process.env, port) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key, value]) => value != null
    && !CONSOLE_ENV_DENY.has(key) && !CONSOLE_ENV_DENY_PREFIX.test(key)));
  return { ...clean, CONSOLE_PORT: String(port) };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * Replace every owned Console still serving an older runtime by running the activated runtime's own
 * launcher (`<entry> --serve`, never --open) in that Console's scope on that Console's port. The
 * launcher authenticates the shutdown with the private control token from the receipt; we only start
 * it and wait for the receipt to name the new runtime. Returns one result per stale receipt, each
 * with `replaced` and, when false, the exact reason.
 */
export function replaceStaleConsoles({ entry, identity, receiptDir, env = process.env, timeoutMs = 20_000,
  spawnFn = spawn, alive = pidAlive, probe = probeRuntimeSync } = {}) {
  const results = [];
  const { live } = readConsoleReceipts(receiptDir, { alive, probe });
  for (const { file, receipt } of live) {
    if (receipt.sourceSha256 === identity.sourceSha256) continue;
    const where = { scope: receipt.scope ?? null, port: receipt.port ?? null, pid: receipt.pid ?? null };
    const refuse = (reason) => results.push({ ...where, replaced: false, reason });
    if (!Number.isInteger(receipt.pid) || !Number.isInteger(receipt.port) || typeof receipt.scope !== 'string') {
      refuse('its receipt has no pid/port/scope, so it cannot be addressed safely'); continue;
    }
    if (!/^[a-f0-9]{48}$/.test(receipt.controlToken || '')) {
      refuse('its receipt carries no control token, so the installer cannot prove it owns that Console'); continue;
    }
    if (!fs.existsSync(entry)) { refuse(`the activated Console runtime is missing (${entry})`); continue; }
    if (!fs.existsSync(receipt.scope)) { refuse(`its project directory no longer exists (${receipt.scope})`); continue; }
    // The pid is alive (dead ones were pruned by readConsoleReceipts). If its port does not answer with
    // this receipt's identity, it is either a busy Console or a reused pid — we cannot tell which, so we
    // never delete the receipt (that could orphan a live stale Console). Report it at once instead of
    // launching and waiting 20s for a process that may never release anything.
    const answer = probe(receipt.port) || probe(receipt.port);
    if (!answer || !sameIdentity(answer, receipt)) {
      refuse(`pid ${receipt.pid} is alive but port ${receipt.port} does not answer with that Console's identity (busy, or the pid was reused); its receipt was kept — restart Console`);
      continue;
    }
    try {
      const child = spawnFn(process.execPath, [entry, '--serve'], { cwd: receipt.scope, detached: true, stdio: 'ignore',
        windowsHide: true, env: consoleEnv(env, receipt.port) });
      child.on?.('error', () => {});
      child.unref?.();
    } catch (error) { refuse(`could not start the current Console: ${error.message}`); continue; }
    // Done = the scope's receipt names the new runtime from a new live process AND the old process
    // is gone (the launcher falls back to a free port if the old one never lets go — that is not a
    // replacement, it is two Consoles).
    const until = Date.now() + timeoutMs;
    let current = null;
    let oldAlive = true;
    while (Date.now() < until) {
      const seen = readJson(file);
      current = seen?.sourceSha256 === identity.sourceSha256 && seen.pid !== receipt.pid && alive(seen.pid) ? seen : null;
      oldAlive = alive(receipt.pid);
      if (current && !oldAlive) break;
      sleepSync(200);
    }
    const secs = Math.round(timeoutMs / 1000);
    if (current && !oldAlive) { results.push({ ...where, replaced: true, newPid: current.pid, newPort: current.port }); continue; }
    if (current) refuse(`the current Console started (pid ${current.pid}, port ${current.port}) but the old one (pid ${receipt.pid}) did not exit within ${secs}s`);
    else if (oldAlive) refuse(`the old Console (pid ${receipt.pid}) did not release port ${receipt.port} within ${secs}s`);
    else refuse(`the old Console stopped but the current one did not report the new runtime within ${secs}s`);
  }
  return results;
}
