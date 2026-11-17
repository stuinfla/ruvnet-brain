// A minimal client for the server's real protocol, used by the installer to probe through the
// real entry point after a switch. (The installer starts this one process; search never does.)
// The Node it uses is chosen and tested now, not remembered (see node-pick.mjs).
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { pickNode } from './node-pick.mjs';

export function startServer(launcher, env) {
  return connect(spawn(pickNode(env), [launcher], { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
}

/**
 * Starts the server exactly as a host does: the registered launcher by its full path with `server`
 * (`rb5 server`, or `rb5.cmd server` through cmd.exe on Windows), so the launcher's own Node choice
 * and fallback are exercised (review F05).
 */
export function startLauncher(launcher, env) {
  const win = process.platform === 'win32';
  const [cmd, args, extra] = win ? [env.ComSpec || process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcher}" server`], { windowsVerbatimArguments: true }] : [launcher, ['server'], {}];
  return connect(spawn(cmd, args, { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...extra }));
}

function connect(child) {
  const waiting = new Map();
  let seq = 0;
  let stderr = '';
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    } catch {}
  });
  child.stdin.on('error', () => {});
  let gone = null;
  // A server that could not start or has stopped fails every waiting call at once, saying why.
  const fail = (why) => {
    gone = why;
    for (const cb of waiting.values()) cb({ error: { message: why } });
    waiting.clear();
  };
  const exited = new Promise((r) => {
    child.on('exit', (code) => (fail(`the checking server stopped (exit ${code}) ${stderr.trim().slice(-300)}`), r(code)));
    child.on('error', (e) => (fail(`the checking server could not start: ${e.message}`), r(null)));
  });
  function call(method, params, timeoutMs = 30_000) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      if (gone) return reject(new Error(gone));
      const t = setTimeout(() => reject(new Error(`no answer to ${method} within ${timeoutMs} ms; ${stderr.trim()}`)), timeoutMs);
      waiting.set(id, (m) => (clearTimeout(t), m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function close() {
    child.stdin.end();
    const t = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(t);
  }
  return { child, call, close, stderr: () => stderr };
}
