// A minimal client for the server's real protocol, used by the installer to probe through the
// real entry point after a switch. (The installer starts this one process; search never does.)
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function startServer(launcher, env) {
  const child = spawn(process.execPath, [launcher], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const exited = new Promise((r) => child.on('exit', r));
  function call(method, params, timeoutMs = 30_000) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
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
