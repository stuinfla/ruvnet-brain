// WP2 T2: a helper process for a native lane is started with a Node that is tested at start time;
// when the first candidate (the program the server runs on) is a broken program, the second (`node`
// on PATH) is used; when none works, the lane is reported unavailable and search still answers.
// No native lane ships yet, so the test adds one, in its scratch copy only: a helper program for lane
// kind "echo-lane" that answers one CUES item naming the Node it runs on, and a recipe with that lane.
// The server runs on a private copy of Node (as in S2); "broken" is that copy replaced by garbage bytes.
// The usual install locations are emptied in the scratch copy, so "none works" can be arranged here.
// Break: start the helper with the Node path remembered when the server started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readStatus, setup, waitFor, writeConfig } from './helpers.mjs';
import { section } from './wp2-helpers.mjs';

const WIN = process.platform === 'win32';
const HELPER = {
  file: 'packages/server/lane-echo-lane.mjs',
  create: `import crypto from 'node:crypto';
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  const out = (o) => process.stdout.write(JSON.stringify({ id: m.id, ...o }) + '\\n');
  if (m.type === 'hello') return out({ ok: true });
  const excerpt = 'helper runs on: ' + process.argv0;
  out({ ok: true, items: [{ repo: 'echo-lane', path: 'node.txt', lines: { start: 1, end: 1 }, hash: crypto.createHash('sha256').update(excerpt).digest('hex'), standing: 'implemented', date: null, commit: 'helper', excerpt }] });
});
`,
};
const NO_USUAL = { file: 'packages/server/helper.mjs', find: "const USUAL = WIN\n  ? [path.join(process.env.ProgramFiles ?? 'C:\\\\Program Files', 'nodejs', 'node.exe')]\n  : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];", replace: 'const USUAL = [];' };
const Q = 'tidewrack episode store';

/** A private, runnable copy of this Node installation (the program plus a libnode beside it). */
function nodeCopy(ctx) {
  const dir = ctx.tmp('rb5-node-');
  fs.mkdirSync(path.join(dir, 'bin'));
  const file = path.join(dir, 'bin', WIN ? 'node.exe' : 'node');
  fs.copyFileSync(process.execPath, file);
  const lib = path.join(path.dirname(path.dirname(fs.realpathSync(process.execPath))), 'lib');
  for (const n of fs.existsSync(lib) ? fs.readdirSync(lib).filter((x) => x.startsWith('libnode.')) : []) {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(lib, n), path.join(dir, 'lib', n));
  }
  fs.chmodSync(file, 0o755);
  assert.equal(spawnSync(file, ['--version'], { encoding: 'utf8' }).stdout.trim(), process.version);
  return file;
}

/** What a package manager leaves behind at the old path, as far as a new start is concerned. */
function breakProgram(file) {
  fs.renameSync(file, `${file}.old`);
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 0x6e, 0x6f, 0x74, 0x20, 0x6e, 0x6f, 0x64, 0x65, 0]));
  fs.chmodSync(file, 0o755);
}

const cues = (r) => section(r.text, 'CUES');

test('WP2 T2 helper lanes choose a working Node when they start', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp2-02');
  const tree = ctx.tree({ patches: [HELPER, NO_USUAL] });
  const recipe = JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8'));
  const { home } = ctx.installed(tree, {
    recipe: {
      lanes: [...recipe.lanes, { name: 'echo', kind: 'echo-lane', optional: true, process: 'helper' }],
      sections: [...recipe.sections, { name: 'CUES', lane: 'echo', maxItems: 1, budgetChars: { brief: 2000, full: 2000 } }],
    },
  });
  writeConfig(home, { probeIntervalMs: 1500 });
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const goodDir = path.dirname(fs.realpathSync(process.execPath));
  const goodNode = path.join(goodDir, WIN ? 'node.exe' : 'node');

  // 1. The program the server runs on works: it runs the helper too.
  const first = nodeCopy(ctx);
  const srv = await ctx.server(tree, home, { node: first, env: { [pathKey]: goodDir } });
  await waitFor(() => readStatus(home, srv.pid)?.probe?.ok, 30_000, 'the start-up self-test');
  const r1 = await srv.search(Q);
  assert.equal(r1.mode, 'MODE · normal', r1.text.slice(0, 300));
  assert.match(cues(r1).block, new RegExp(`helper runs on: ${fs.realpathSync(first).replace(/[\\.]/g, '\\$&')}`), `the helper runs on the server's own Node first:\n${cues(r1).block}`);
  assert.match(tree.hook(home).line, /RuvNet Brain OK/);

  // 2. That program is replaced by a broken one; the next start of the helper (each probe restarts
  //    it) must test it, find it broken, and use `node` on PATH.
  const brokenAt = Date.now();
  breakProgram(first);
  await waitFor(() => (readStatus(home, srv.pid)?.probe?.at ?? 0) > brokenAt + 100, 20_000, 'a probe after the break');
  const r2 = await srv.search(Q);
  assert.equal(r2.mode, 'MODE · normal', r2.text.slice(0, 300));
  assert.equal(r2.files[0]?.file, 'beta-memory/src/episode_store.ts');
  assert.match(cues(r2).block, new RegExp(`helper runs on: ${goodNode.replace(/[\\.]/g, '\\$&')}`), `the second candidate (node on PATH) must run the helper when the first is broken:\n${cues(r2).block}`);
  assert.deepEqual(readStatus(home, srv.pid).lanes.find((l) => l.name === 'echo'), { name: 'echo', available: true });
  await srv.close();

  // 3. No candidate works: the lane is unavailable, search still answers, health says DEGRADED.
  const lone = nodeCopy(ctx);
  const empty = ctx.tmp('rb5-nopath-');
  const srv2 = await ctx.server(tree, home, { node: lone, env: { [pathKey]: empty } });
  await waitFor(() => readStatus(home, srv2.pid)?.probe?.ok, 30_000, 'the start-up self-test');
  const brokenAt2 = Date.now();
  breakProgram(lone);
  await waitFor(() => (readStatus(home, srv2.pid)?.probe?.at ?? 0) > brokenAt2 + 100, 20_000, 'a probe after the break');
  const r3 = await srv2.search(Q);
  assert.equal(r3.isError, false, r3.text.slice(0, 300));
  assert.equal(r3.mode, 'MODE · normal', r3.mode);
  assert.equal(r3.files[0]?.file, 'beta-memory/src/episode_store.ts', 'search answers without the helper lane');
  assert.match(cues(r3).header ?? '', /^CUES \(0\) · no match: lane echo is not available: no working Node .* was found for the helper/, `CUES must say why: ${cues(r3).header}`);
  assert.doesNotMatch(r3.header, /lanes: .*echo/, `the header must not list the echo lane: ${r3.header}`);
  assert.equal(readStatus(home, srv2.pid).lanes.find((l) => l.name === 'echo')?.available, false);
  assert.match(tree.hook(home).line, /DEGRADED.*lane echo unavailable/, 'health names the unavailable lane');
});
