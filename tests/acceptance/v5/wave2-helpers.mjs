// Wave 2 end-to-end helpers: a temporary user folder with stand-in host settings, the registered
// search server started by its registered command (the absolute launcher), a local receiver for the
// owner page, and the fixture text that makes a result exceed what the host delivers.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { client, parseResult } from './helpers.mjs';
import { fakeHosts } from './wp7-helpers.mjs';

/** A temporary user folder laid out as a host expects (~/.claude, ~/.claude.json, ~/.codex), with
 *  some settings of the user's own, and the environment that points every host lookup at it. */
export function userWithHosts(ctx) {
  const user = ctx.tmp('rb5-e2e-user-');
  const f = fakeHosts(user);
  fs.renameSync(path.join(user, 'claude'), path.join(user, '.claude'));
  fs.renameSync(path.join(user, 'codex'), path.join(user, '.codex'));
  fs.renameSync(f.claude.state, path.join(user, '.claude', '.claude.json'));
  const env = { HOME: user, USERPROFILE: user, CLAUDE_CONFIG_DIR: path.join(user, '.claude'), CODEX_HOME: path.join(user, '.codex') };
  return { user, env, settings: path.join(user, '.claude', 'settings.json'), state: path.join(user, '.claude', '.claude.json') };
}

/** The entries the installer registered: the prompt hook command and the search server command. */
export function registered(u) {
  const settings = JSON.parse(fs.readFileSync(u.settings, 'utf8'));
  const hook = settings.hooks.UserPromptSubmit.map((g) => g.hooks[0]).find((h) => /bin\/rb5" hook/.test(h.command));
  const server = JSON.parse(fs.readFileSync(u.state, 'utf8')).mcpServers?.['ruvnet-brain'];
  return { hook, server };
}

/** Starts the registered server exactly as the host would: its command and args, from `cwd`. */
export async function serveRegistered(t, server, { cwd, env }) {
  const e = { ...process.env, NODE_NO_WARNINGS: '1', ...env };
  delete e.RUVNET_BRAIN5_HOME; // the launcher finds the brain home from its own place
  const child = spawn(server.command, server.args, { cwd, env: e, stdio: ['pipe', 'pipe', 'pipe'] });
  const c = client(child);
  const close = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    child.stdin.end();
    const k = setTimeout(() => child.kill('SIGKILL'), 5000);
    await c.exited;
    clearTimeout(k);
  };
  t.after(close);
  await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v5-wave2-e2e', version: '1' } }, 60_000);
  return {
    child,
    close,
    async search(query, args = {}) {
      const t0 = Date.now();
      return parseResult(await c.call('tools/call', { name: 'search_ruvnet', arguments: { query, ...args } }, 60_000), Date.now() - t0);
    },
  };
}

/** A local https-free stand-in for the page topic: records every POST body. */
export async function pageReceiver(t) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push(body);
      res.end('ok');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return { url: `http://127.0.0.1:${srv.address().port}/topic`, got };
}

/** Dense code-like text: long lines of short tokens, so a result passes the token ceiling before the
 *  character one (the worst case measured on the host). */
export function denseFile(k) {
  const L = 'abcdefghijklmnopqrstuvwxyz';
  const rows = [`// stormglass kernel ${k}: ${['zorvane', 'quillmarsh', 'tethrin'][k % 3]}${k}`];
  for (let i = 0; i < 160; i++) {
    let s = '';
    for (let j = 0; s.length < 110; j++) s += `${L[(i + j) % 26]}${(i * j) % 10}=${L[(i * 3 + j) % 26]}${j % 10}+${L[(j * 7) % 26]};`;
    rows.push(`let s${i}_${k}=[${s}];`);
  }
  return rows.join('\n') + '\n';
}

/** Estimated tokens, as the host's ceiling counts them (contract/delivery.mjs). */
export const tokens = (t) => Math.max(Math.ceil(t.length / 3), (t.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) ?? []).length);
