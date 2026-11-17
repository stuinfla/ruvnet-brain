// Work package 4 (installer) test helpers. Importing this file points HOME, USERPROFILE and the XDG
// folders of this test process (and so of every program it starts) at a fresh temporary folder, so
// no test can reach the live 4.7 home (~/.cache/ruvnet-brain) or any real host setting.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const realHome = os.homedir();
export const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rb5-wp4-userhome-'));
for (const k of ['HOME', 'USERPROFILE']) process.env[k] = FAKE_HOME;
for (const k of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) process.env[k] = path.join(FAKE_HOME, k.toLowerCase());
process.on('exit', () => fs.rmSync(FAKE_HOME, { recursive: true, force: true }));
assert.notEqual(os.homedir(), realHome, 'the test HOME must not be the real one');

/** Refuses any brain home that is not a fresh temporary folder. */
export function assertScratch(home) {
  const tmp = fs.realpathSync(os.tmpdir());
  const real = fs.realpathSync(fs.existsSync(home) ? home : path.dirname(home));
  assert.ok(real.startsWith(tmp + path.sep), `brain home ${home} must be under ${tmp}`);
  assert.ok(!real.includes(`${path.sep}.cache${path.sep}ruvnet-brain`), 'never the live 4.7 home');
}

/** Every file (and empty folder) under dir as relative posix path -> sha256 (or 'dir'). */
export function snapshot(dir, { skip = () => false } = {}) {
  const out = {};
  (function walk(rel) {
    let ents = [];
    try {
      ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && !ents.length && !skip(rel)) out[`${rel}/`] = 'dir';
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip(r)) continue;
      if (e.isDirectory()) walk(r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    }
  })('');
  return out;
}

export function diff(before, after) {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** Pointer fields that identify a state (switchedAt differs between two otherwise equal runs). */
export const pointerOf = (home) => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
    return { app: c.app, pack: c.pack, releaseNumber: c.releaseNumber, previous: c.previous };
  } catch {
    return null;
  }
};

/** The layout of a home that matters for "the same state": every app and pack file, the pointer. */
export const layout = (home) => ({
  files: Object.keys(snapshot(home, { skip: (r) => r === 'state' })).sort(),
  pointer: pointerOf(home),
});

/** A static file server for a release folder (or a function naming it), with HTTP ranges, that records every request. */
export async function serveRelease(dir, { onRequest } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const root = typeof dir === 'function' ? dir() : dir;
    const file = path.join(root, ...decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean));
    const rec = { url: req.url, range: req.headers.range ?? null, served: 0 };
    requests.push(rec);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(rec.range ?? '');
    if (m) start = Number(m[1]);
    const headers = { 'content-length': size - start, 'accept-ranges': 'bytes' };
    if (m) headers['content-range'] = `bytes ${start}-${size - 1}/${size}`;
    res.writeHead(m ? 206 : 200, headers);
    const custom = onRequest?.(rec, { file, size, start, res });
    if (custom) return;
    const s = fs.createReadStream(file, { start });
    s.on('data', (c) => (rec.served += c.length));
    s.pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, requests, close: () => new Promise((r) => server.close(r)) };
}

/** The CLI run without blocking this process, so a stub server in this process can answer it. */
export function cliAsync(tree, home, args, { env = {}, cwd = os.tmpdir() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(tree.root, 'packages', 'cli', 'ruvnet-brain.mjs'), ...args], {
      cwd,
      env: { ...process.env, NODE_NO_WARNINGS: '1', RUVNET_BRAIN5_HOME: home, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', (status, signal) => (clearTimeout(t), resolve({ status, signal, stdout, stderr })));
  });
}

export const KILL_STEP = {
  file: 'packages/cli/install.mjs',
  find: 'function step(j, name, phase) {',
  replace: "function step(j, name, phase) {\n  process.stderr.write(`wp4-step ${name}\\n`);\n  globalThis.__wp4n = (globalThis.__wp4n ?? 0) + 1;\n  if (globalThis.__wp4n === Number(process.env.WP4_KILL_AT)) process.kill(process.pid, 'SIGKILL');",
};
