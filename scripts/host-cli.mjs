// host-cli.mjs — run the `claude` / `codex` CLI from the installer, tolerating a binary that is
// briefly absent because the host is updating itself.
//
// 2026-09-30, owner's Mac: Claude Code self-updated during `npx ruvnet-brain --update`;
// ~/.npm-global/bin/claude was missing for a few seconds and the installer printed raw
// "No such file or directory" shell errors. A missing binary is now retried with a short bounded
// backoff (3 tries over ~20s by default) and, if it never comes back, reported as ONE clear line.
// Raw stderr from a missing-binary attempt is swallowed; stderr from a real run is passed through.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
export const HOST_CLI_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000]);
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
// CLIs this process has seen working. Only a CLI that was here (or whose PATH link still exists)
// can be "transiently" missing; one that was never installed fails at once, with no 20s wait.
const SEEN = new Set();
// CLIs that stayed missing through one full wait: gone for this process. A permanently dangling link
// must not cost ~20s on EVERY later call — one bounded wait per process, then fail at once.
const GONE = new Set();

/** The binary's real path, or null when it is not on PATH or its link points at nothing. */
export function resolveHostCli(cmd, { spawn = spawnSync } = {}) {
  const probe = IS_WIN
    ? spawn('where', [cmd], { encoding: 'utf8' })
    : spawn('sh', ['-c', 'command -v -- "$1"', 'sh', cmd], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  const found = String(probe.stdout || '').split(/\r?\n/).find(Boolean);
  if (!found) return null;
  if (!IS_WIN && !found.includes('/')) { SEEN.add(cmd); return found; } // builtin/function: nothing to stat
  try { const real = fs.realpathSync(found); SEEN.add(cmd); return real; }
  catch { return null; } // dangling link mid-update
}

/** A PATH entry named `cmd` exists (even as a link that currently points nowhere). */
export function hostCliOnPath(cmd, { env = process.env } = {}) {
  const names = IS_WIN ? [cmd, `${cmd}.cmd`, `${cmd}.exe`] : [cmd];
  for (const dir of String(env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean)) {
    for (const name of names) { try { fs.lstatSync(`${dir}/${name}`); return true; } catch { /* next */ } }
  }
  return false;
}

/**
 * Is the CLI usable? A link that exists but points nowhere is a host mid-self-update: wait for it
 * (same bounded backoff). A CLI that is simply not installed returns at once, with no wait.
 */
export function waitForHostCli(cmd, { delays = HOST_CLI_RETRY_DELAYS_MS, sleep = sleepSync, resolve = resolveHostCli,
  onPath = hostCliOnPath } = {}) {
  if (resolve(cmd)) { GONE.delete(cmd); return { present: true, waited: false }; }
  if (!onPath(cmd)) return { present: false, waited: false };
  const waited = Math.round(delays.reduce((sum, ms) => sum + ms, 0) / 1000);
  const message = `the \`${cmd}\` command is on PATH but points at nothing (checked for ${waited}s — it may be updating itself)`;
  if (GONE.has(cmd)) return { present: false, waited: false, message };
  for (const ms of delays) {
    sleep(ms);
    if (resolve(cmd)) return { present: true, waited: true };
  }
  GONE.add(cmd);
  return { present: false, waited: true, message };
}

const MISSING_TEXT = /(?:No such file or directory|command not found|ENOENT|is not recognized as an internal or external command)/i;

/** True when this attempt failed because the CLI itself could not be executed. */
export function missingBinaryAttempt(result, cmd, { resolve = resolveHostCli } = {}) {
  if (result?.error?.code === 'ENOENT') return true;
  if (result?.error || result?.status === 0) return false;
  // 127 is the shell's "could not execute" — but only when the binary really is gone; a CLI that
  // resolves and itself exits 127 ran, and its failure is its own.
  if (result?.status === 127) return !resolve(cmd);
  // A run that started and failed for its own reasons is not "missing"; only a failure whose text
  // says a file was missing AND whose binary no longer resolves is.
  return MISSING_TEXT.test(String(result?.stderr || '')) && !resolve(cmd);
}

/**
 * spawnSync-compatible. Extra fields on the returned object: `attempts`, and on exhaustion
 * `missingBinary: true` plus `message` (the one line to print). With stdio 'inherit' (the default),
 * stdin/stdout stay inherited; stderr is captured so a missing-binary attempt prints nothing.
 */
export function runHostCli(cmd, args, {
  delays = HOST_CLI_RETRY_DELAYS_MS, sleep = sleepSync, spawn = spawnSync, resolve = resolveHostCli,
  onPath = hostCliOnPath, stdio = 'inherit', echoStderr = (text) => process.stderr.write(text), ...opts
} = {}) {
  const inherit = stdio === 'inherit';
  const spawnOpts = { shell: IS_WIN, ...opts, stdio: inherit ? ['inherit', 'inherit', 'pipe'] : stdio };
  if (inherit && !spawnOpts.encoding) spawnOpts.encoding = 'utf8';
  let result;
  if (GONE.has(cmd)) delays = []; // already waited once this process: one attempt, no backoff
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) sleep(delays[attempt - 1]);
    result = spawn(cmd, args, spawnOpts);
    const missing = missingBinaryAttempt(result, cmd, { resolve });
    if (!missing) { SEEN.add(cmd); GONE.delete(cmd); }
    // Never installed (not seen this run, no PATH entry at all): the caller's own "not found"
    // handling applies at once, exactly as before.
    if (!missing || (attempt === 0 && !SEEN.has(cmd) && !onPath(cmd))) {
      if (inherit && result?.stderr) echoStderr(String(result.stderr));
      return Object.assign(result ?? {}, { attempts: attempt + 1 });
    }
  }
  const waited = Math.round(delays.reduce((sum, ms) => sum + ms, 0) / 1000);
  GONE.add(cmd);
  return Object.assign(result ?? {}, {
    attempts: delays.length + 1,
    missingBinary: true,
    message: delays.length
      ? `the \`${cmd}\` command was not available (tried ${delays.length + 1} times over ${waited}s — it may be updating itself); skipped \`${cmd} ${args.join(' ')}\``
      : `the \`${cmd}\` command is still not available (it already stayed missing through a wait earlier in this run); skipped \`${cmd} ${args.join(' ')}\``,
  });
}

/** Test seam: forget which CLIs this process has seen. */
export function resetSeenHostClis() { SEEN.clear(); GONE.clear(); }
