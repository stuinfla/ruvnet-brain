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

const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec';
/** When process `pid` started (epoch ms, UTC, 1 s resolution), or null when it cannot be read. */
let clockTicks = null;
/**
 * Linux: boot-relative start (/proc/<pid>/stat field 22, clock ticks since boot) anchored at the kernel's
 * boot time (/proc/stat btime) — not `ps lstart`, which a forward wall-clock jump would push later.
 */
export function linuxProcessStartMs(pid, { readFile = fs.readFileSync, spawn = spawnSync } = {}) {
  try {
    const stat = String(readFile(`/proc/${pid}/stat`, 'utf8'));
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // field 3 onward (comm may hold spaces)
    const startTicks = Number(fields[22 - 3]);
    const btime = Number(String(readFile('/proc/stat', 'utf8')).match(/^btime\s+(\d+)/m)?.[1]);
    if (clockTicks === null) clockTicks = Number(String(spawn('getconf', ['CLK_TCK'], { encoding: 'utf8' })?.stdout || '').trim()) || 100;
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    return btime * 1000 + Math.round((startTicks * 1000) / clockTicks);
  } catch { return null; }
}

export function processStartMs(pid, { spawn = spawnSync, platform = process.platform, readFile } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'linux') {
    const linux = linuxProcessStartMs(pid, { spawn, ...(readFile ? { readFile } : {}) });
    if (linux !== null) return linux;
  }
  const run = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('ddd MMM d HH:mm:ss yyyy',[Globalization.CultureInfo]::InvariantCulture)`],
    { encoding: 'utf8', windowsHide: true })
    : spawn('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
  if (run?.status !== 0) return null;
  const m = String(run.stdout || '').trim().match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!m || MONTHS.indexOf(m[1]) % 3 !== 0) return null;
  return Date.UTC(+m[6], MONTHS.indexOf(m[1]) / 3, +m[2], +m[3], +m[4], +m[5]);
}

/**
 * A live pid that is NOT the receipt's Console: the process now holding that pid started after the
 * Console wrote its receipt (a Console's process always starts before it records startedAt). Two seconds
 * of slack cover the 1 s resolution of the start time. Unreadable start time = not provably reused.
 */
export function pidReused(receipt, { startMs = processStartMs } = {}) {
  const recorded = Date.parse(receipt?.startedAt || '');
  const started = startMs(receipt?.pid);
  return Number.isFinite(recorded) && Number.isFinite(started) && started > recorded + 2_000;
}

/**
 * Console receipts in `receiptDir`, with dead ones pruned. A receipt is dead when its port does not
 * answer /api/runtime with the receipt's identity AND either its pid is not alive or that pid now
 * belongs to a process that started after the receipt was written (pid reuse). A busy live Console
 * (pid alive, same process) is never pruned. A receipt with no integer pid cannot be proven dead.
 */
export function readConsoleReceipts(receiptDir, { alive = pidAlive, probe = probeRuntimeSync, startMs = processStartMs } = {}) {
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
    if (Number.isInteger(receipt.pid) && receipt.pid > 0) {
      const dead = !alive(receipt.pid);
      const reused = !dead && pidReused(receipt, { startMs });
      if (dead || reused) {
        const answer = probe(receipt.port);
        if (!answer || !sameIdentity(answer, receipt)) {
          try { fs.unlinkSync(file); } catch { /* raced or read-only: still not a running Console */ }
          pruned.push({ file, pid: receipt.pid, port: receipt.port ?? null, startedAt: receipt.startedAt ?? null,
            reason: dead ? 'pid not alive' : 'pid reused by a process started after the receipt' });
          continue;
        }
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
  'RUVNET_REFRESH_RECEIPT', 'RUVNET_UPGRADE_NOTICE_FILE', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'INIT_CWD', 'CONSOLE_PORT',
  // The launching host session's own identity (the spine version it booted, the hook host, its Node).
  'RUVNET_BRAIN_ACTIVE_VERSION', 'RUVNET_HOOK_HOST', 'RUVNET_NODE_BIN']);
// CLAUDE* describes the Claude Code SESSION that ran the installer (CLAUDECODE, CLAUDE_PROJECT_DIR,
// CLAUDE_PLUGIN_ROOT, CLAUDE_SESSION_ID, CLAUDE_CODE_*): stale for a long-lived Console. CLAUDE_CONFIG_DIR
// is the user's configuration location, not session state, and is kept (host-update.mjs forwards it too).
const CONSOLE_ENV_DENY_PREFIX = /^(?:RUVNET_NIGHTLY_|npm_|VITEST|CLAUDE(?!_CONFIG_DIR$))/;
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
