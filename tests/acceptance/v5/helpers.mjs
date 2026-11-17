// Shared harness for the version 5 walking-skeleton acceptance tests (S1-S14).
// Every test works on a scratch copy of packages/ and recipe/ in a temp folder, with a signing key
// generated at test time (it signs nothing real). It drives only public entry points: the builder,
// release and CLI programs, the server over its real stdio protocol, and the hook command string.
// When V5_BREAK names a break from breaks.mjs for this test, that patch is applied to the copy.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BREAKS } from './breaks.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = path.join(ROOT, 'tests', 'acceptance', 'v5', 'fixtures', 'repos');
export const repo = (name) => path.join(FIXTURES, name);
export const THREE = ['alpha-vectors', 'beta-memory', 'gamma-swarm'].map(repo);
export const HOME_ENV = 'RUVNET_BRAIN5_HOME';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

function applyPatch(root, pt) {
  const file = path.join(root, pt.file);
  if (pt.create !== undefined) return fs.writeFileSync(file, pt.create);
  const text = fs.readFileSync(file, 'utf8');
  const n = text.split(pt.find).length - 1;
  if (n !== 1) throw new Error(`patch anchor in ${pt.file} matched ${n} times: ${pt.find.slice(0, 80)}`);
  fs.writeFileSync(file, text.replace(pt.find, () => pt.replace));
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a?.[k], v);
  return out;
}

export const newKeys = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicPem: publicKey.export({ type: 'spki', format: 'pem' }) };
};

const childEnv = (home, extra = {}) => ({ ...process.env, NODE_NO_WARNINGS: '1', [HOME_ENV]: home, ...extra });

function client(child) {
  const waiting = new Map();
  let seq = 0;
  let stderr = '';
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-6000)));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const call = (method, params, timeoutMs = 30_000) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer to ${method} within ${timeoutMs} ms; server stderr: ${stderr.trim().slice(-500)}`)), timeoutMs);
      waiting.set(id, (m) => (clearTimeout(t), m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  return { call, exited, stderr: () => stderr };
}

const CITE = /^\d+\. (\S+) · lines (\d+)-(\d+) · commit (\S+) · standing (\S+) · date (\S+) · sha256 ([0-9a-f]{64})$/;

export function parseResult(res, ms) {
  const text = res?.content?.map((c) => c.text).join('') ?? '';
  const lines = text.split('\n');
  const files = lines.map((l) => CITE.exec(l)).filter(Boolean).map((m) => ({ file: m[1], start: Number(m[2]), end: Number(m[3]), commit: m[4], standing: m[5], date: m[6], hash: m[7] }));
  return { text, isError: !!res?.isError, header: lines[0], mode: lines[1], files, ms, raw: res };
}

/** One per test: tracks temp folders and servers and removes them afterwards. */
export function setup(t, testId) {
  const dirs = [];
  const servers = [];
  const ctx = {
    tmp(prefix = 'rb5-') {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.push(d);
      return d;
    },

    tree({ patches = [], keys = null } = {}) {
      const root = ctx.tmp('rb5-tree-');
      fs.cpSync(path.join(ROOT, 'packages'), path.join(root, 'packages'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'recipe'), path.join(root, 'recipe'), { recursive: true });
      const k = keys ?? newKeys();
      fs.mkdirSync(path.join(root, 'packages', 'contract', 'keys'), { recursive: true });
      fs.writeFileSync(path.join(root, 'packages', 'contract', 'keys', 'release-public.pem'), k.publicPem);
      fs.writeFileSync(path.join(root, 'test-signing-key.pem'), k.privatePem);
      for (const pt of patches) applyPatch(root, pt);
      const brk = process.env.V5_BREAK && BREAKS[process.env.V5_BREAK];
      if (brk && brk.test === testId) for (const pt of brk.patches) applyPatch(root, pt);
      return makeTree(ctx, root, k);
    },

    async server(tree, home, { node = process.execPath, cwd = os.tmpdir(), env = {} } = {}) {
      const child = spawn(node, [path.join(tree.plugin, 'launch.mjs')], { cwd, env: childEnv(home, env), stdio: ['pipe', 'pipe', 'pipe'] });
      const c = client(child);
      const s = {
        child,
        pid: child.pid,
        call: c.call,
        stderr: c.stderr,
        async search(query, args = {}, timeoutMs = 30_000) {
          const t0 = Date.now();
          const res = await c.call('tools/call', { name: 'search_ruvnet', arguments: { query, ...args } }, timeoutMs);
          return parseResult(res, Date.now() - t0);
        },
        async close() {
          if (child.exitCode !== null || child.signalCode) return;
          child.stdin.end();
          const k = setTimeout(() => child.kill('SIGKILL'), 5000);
          await c.exited;
          clearTimeout(k);
        },
      };
      servers.push(s);
      await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v5-acceptance', version: '1' } });
      return s;
    },

    /** Build, sign and install the three fixture repositories into a fresh home. */
    installed(tree, { sources = THREE, recipe, config, number = 1 } = {}) {
      const pack = tree.build(sources, { recipe });
      const rel = tree.release(pack, { number });
      const home = ctx.tmp('rb5-home-');
      if (config) writeConfig(home, config);
      const r = tree.cli(home, ['install', '--from', rel]);
      assert.equal(r.status, 0, `install failed: ${r.stdout}\n${r.stderr}`);
      return { home, pack, rel };
    },
  };
  t.after(async () => {
    for (const s of servers) await s.close().catch(() => {});
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return ctx;
}

export function writeConfig(home, values) {
  const file = path.join(home, 'state', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...cur, ...values }));
}

export const readStatus = (home, pid) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'state', 'status', `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
};

export const readPointerRaw = (home) => fs.readFileSync(path.join(home, 'current.json'), 'utf8');

function makeTree(ctx, root, keys) {
  const pkg = (...p) => path.join(root, 'packages', ...p);
  const node = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180_000, ...opts });
  const tree = {
    root,
    keys,
    plugin: pkg('plugin', 'claude'),
    build(sources, { recipe } = {}) {
      let recipePath = path.join(root, 'recipe', 'RECIPE.json');
      if (recipe) {
        recipePath = path.join(ctx.tmp('rb5-recipe-'), 'RECIPE.json');
        fs.writeFileSync(recipePath, JSON.stringify(deepMerge(JSON.parse(fs.readFileSync(path.join(root, 'recipe', 'RECIPE.json'), 'utf8')), recipe), null, 2));
      }
      const out = path.join(ctx.tmp('rb5-pack-'), 'pack');
      const r = node([pkg('builder', 'build.mjs'), '--recipe', recipePath, '--out', out, ...sources], { env: childEnv(os.tmpdir()) });
      assert.equal(r.status, 0, `build failed: ${r.stdout}\n${r.stderr}`);
      return out;
    },
    reassemble(packDir) {
      const r = node([pkg('builder', 'assemble.mjs'), packDir], { env: childEnv(os.tmpdir()) });
      assert.equal(r.status, 0, `assemble failed: ${r.stderr}`);
    },
    release(packDir, { number = 1, version, keyPem = keys.privatePem } = {}) {
      const keyFile = path.join(ctx.tmp('rb5-key-'), 'k.pem');
      fs.writeFileSync(keyFile, keyPem);
      const out = path.join(ctx.tmp('rb5-rel-'), 'release');
      const args = [pkg('release', 'release.mjs'), '--pack', packDir, '--out', out, '--key', keyFile, '--release-number', String(number)];
      if (version) args.push('--app-version', version);
      const r = node(args, { env: childEnv(os.tmpdir()) });
      assert.equal(r.status, 0, `release failed: ${r.stdout}\n${r.stderr}`);
      return out;
    },
    cli(home, args, { cwd = os.tmpdir(), env = {} } = {}) {
      return node([pkg('cli', 'ruvnet-brain.mjs'), ...args], { cwd, env: childEnv(home, env) });
    },
    hookCommand() {
      const hooks = JSON.parse(fs.readFileSync(path.join(tree.plugin, 'hooks', 'hooks.json'), 'utf8'));
      return hooks.hooks.UserPromptSubmit[0].hooks[0].command.replaceAll('${CLAUDE_PLUGIN_ROOT}', tree.plugin);
    },
    /** Runs the exact hook command through the platform shell, as the host does. */
    hook(home, { cwd = os.tmpdir(), pathPrefix = null, env: extra = {} } = {}) {
      const env = childEnv(home, { CLAUDE_PLUGIN_ROOT: tree.plugin, ...extra });
      if (pathPrefix) {
        const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
        env[key] = pathPrefix + path.delimiter + (env[key] ?? '');
      }
      const r = spawnSync(tree.hookCommand(), { shell: true, cwd, env, encoding: 'utf8', timeout: 30_000 });
      return { line: (r.stdout ?? '').trim(), status: r.status, stderr: r.stderr ?? '' };
    },
  };
  return tree;
}

/** A live process that is not a server, for "stale heartbeat" evidence. */
export function sleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
}
