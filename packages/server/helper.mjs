// Helper processes for lanes that run native code (architecture 2.2): a recipe lane with
// `process: "helper"` runs in its own process, so a crash in native code cannot take the server down.
// The program is <app>/server/lane-<kind>.mjs. The Node that runs it is chosen and tested at the
// moment the helper starts (the program running now, then `node` in each absolute PATH folder, then
// the usual install locations), never remembered from earlier (defect C1). When no Node works, or the
// helper does not answer, the lane is reported unavailable and search answers without it.
// Protocol: one JSON object per line. {id, type: 'hello'} -> {id, ok}; {id, type: 'search', query,
// detail, section: {name, maxItems, itemChars}} -> {id, ok, items} or {id, ok: false, error}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { MIN_NODE } from '../contract/constants.mjs';

const WIN = process.platform === 'win32';
const USUAL = WIN
  ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')]
  : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
const HELLO_MS = 5000;

const version = (file) =>
  new Promise((resolve) => {
    try {
      execFile(file, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: HELLO_MS, cwd: os.tmpdir(), windowsHide: true }, (err, out) => {
        const [a, b] = String(out ?? '').trim().split('.').map(Number);
        resolve(!err && (a > MIN_NODE[0] || (a === MIN_NODE[0] && b >= MIN_NODE[1])));
      });
    } catch {
      resolve(false); // some start errors (a file that is not a program) are thrown, not reported
    }
  });

/** The first Node that runs and is recent enough, tested now. Throws, naming what was tried. */
export async function chooseNode(env = process.env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const dirs = String(key ? env[key] : '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const tried = [];
  for (const c of new Set([process.execPath, ...dirs.map((d) => path.join(d, WIN ? 'node.exe' : 'node')), ...USUAL])) {
    if (!fs.existsSync(c)) continue;
    if (await version(c)) return c;
    tried.push(c);
  }
  throw new Error(`no working Node ${MIN_NODE.join('.')} or later was found for the helper${tried.length ? ` (tried ${tried.join(', ')})` : ''}`);
}

function startOne(program, packDir, env) {
  return new Promise((resolve) => {
    (async () => {
      const node = await chooseNode(env);
      const child = spawn(node, [program, packDir], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const waiting = new Map();
      let seq = 0;
      let gone = null;
      const fail = (why) => {
        gone = why;
        for (const cb of waiting.values()) cb({ ok: false, error: why });
        waiting.clear();
      };
      child.on('error', (e) => fail(`the helper could not start with ${node}: ${e.message}`));
      child.on('exit', (c) => fail(`the helper stopped (exit ${c})`));
      child.stdin.on('error', () => {});
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const m = JSON.parse(line);
          waiting.get(m.id)?.(m);
          waiting.delete(m.id);
        } catch {}
      });
      const call = (msg, ms) =>
        new Promise((res) => {
          if (gone) return res({ ok: false, error: gone });
          const id = ++seq;
          const t = setTimeout(() => (waiting.delete(id), res({ ok: false, error: `the helper did not answer within ${ms} ms` })), ms);
          waiting.set(id, (m) => (clearTimeout(t), res(m)));
          child.stdin.write(JSON.stringify({ ...msg, id }) + '\n');
        });
      const hello = await call({ type: 'hello' }, HELLO_MS);
      if (!hello.ok) {
        child.kill();
        return resolve({ available: false, reason: hello.error ?? 'the helper did not say hello' });
      }
      resolve({ available: true, node, child, call, alive: () => !gone });
    })().catch((e) => resolve({ available: false, reason: e.message }));
  });
}

/** One helper per helper lane of the recipe. With no helper lane, nothing is ever started. */
export function createHelpers(appDir, packDir, recipe, env = process.env) {
  const specs = recipe.lanes.filter((l) => l.process === 'helper');
  const state = new Map(specs.map((l) => [l.name, { available: false, reason: 'the helper has not started yet' }]));

  async function startLane(spec) {
    const old = state.get(spec.name);
    const program = path.join(appDir, 'server', `lane-${spec.kind}.mjs`);
    const s = fs.existsSync(program) ? await startOne(program, packDir, env) : { available: false, reason: `this app has no helper for lane kind ${spec.kind}` };
    state.set(spec.name, s);
    // The old helper answers what it was already asked (it ends when its input closes), then goes.
    if (old?.child) (old.child.stdin.end(), setTimeout(() => old.child.kill(), 15_000).unref());
    return s;
  }

  /** (Re)starts every helper, choosing Node again. Called by each probe. */
  const restart = () => Promise.all(specs.map(startLane));

  /** Items per helper section: Map name -> { items } | { reason }. A dead helper is started again. */
  async function search(query, detail, ms) {
    const out = new Map();
    for (const sec of recipe.sections) {
      const spec = specs.find((l) => l.name === sec.lane);
      if (!spec) continue;
      let s = state.get(spec.name);
      if (s.available && !s.alive()) s = await startLane(spec);
      if (!s.available) {
        out.set(sec.name, { reason: `lane ${spec.name} is not available: ${s.reason}` });
        continue;
      }
      const r = await s.call({ type: 'search', query, detail, section: { name: sec.name, maxItems: sec.maxItems, itemChars: sec.itemChars ?? null } }, Math.max(ms, 500));
      out.set(sec.name, r.ok ? { items: (r.items ?? []).slice(0, sec.maxItems) } : { reason: `lane ${spec.name} failed: ${r.error}` });
    }
    return out;
  }

  const lanes = () => specs.map((l) => {
    const s = state.get(l.name);
    return s.available && s.alive() ? { name: l.name, available: true } : { name: l.name, available: false, reason: s.available ? 'the helper stopped' : s.reason };
  });
  const stop = () => {
    for (const s of state.values()) s.child?.kill();
  };
  return { any: specs.length > 0, restart, search, lanes, stop };
}
