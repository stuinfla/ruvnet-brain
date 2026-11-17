// Review F02 (helper part): the Node that starts a helper lane is never a program inside the project.
// The server runs in a project folder on a private copy of Node; the only PATH entry is the absolute
// folder <project>/tools, whose `node` is a working program that leaves a mark when it is run. Once the
// server's own Node is broken (each probe restarts the helper and chooses again), the helper must not
// run the project's program: the lane is reported unavailable and search still answers.
// The helper lane, the emptied usual locations and the Node copy are set up as in wp2-02.
// Break: the helper's selector probes candidates without the project check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readStatus, setup, waitFor } from './helpers.mjs';
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

function nodeCopy(ctx) {
  const dir = ctx.tmp('rb5-node-');
  fs.mkdirSync(path.join(dir, 'bin'));
  const file = path.join(dir, 'bin', 'node');
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

test('F02 a helper lane never runs a Node from inside the project', { skip: WIN && 'POSIX program fixture', timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'integ-server-f02');
  const tree = ctx.tree({ patches: [HELPER, NO_USUAL] });
  const recipe = JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8'));
  const { home } = ctx.installed(tree, {
    recipe: {
      lanes: [...recipe.lanes, { name: 'echo', kind: 'echo-lane', optional: true, process: 'helper' }],
      sections: [...recipe.sections, { name: 'CUES', lane: 'echo', maxItems: 1, budgetChars: { brief: 2000, full: 2000 } }],
    },
    config: { probeIntervalMs: 1500 },
  });

  const project = ctx.tmp('rb5-project-');
  const mark = path.join(ctx.tmp('rb5-mark-'), 'ran');
  fs.mkdirSync(path.join(project, 'tools'));
  const planted = path.join(project, 'tools', 'node');
  fs.writeFileSync(planted, `#!/bin/sh\necho "$0" >> '${mark}'\nexec '${process.execPath}' "$@"\n`);
  fs.chmodSync(planted, 0o755);

  const own = nodeCopy(ctx);
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const srv = await ctx.server(tree, home, { node: own, cwd: project, env: { [pathKey]: path.join(project, 'tools') } });
  await waitFor(() => readStatus(home, srv.pid)?.probe?.ok, 30_000, 'the start-up self-test');

  // The server's own Node goes; the next probe restarts the helper and must choose again.
  const brokenAt = Date.now();
  fs.renameSync(own, `${own}.old`);
  fs.writeFileSync(own, Buffer.from([0, 1, 2, 3, 0x6e, 0x6f, 0x74, 0]));
  fs.chmodSync(own, 0o755);
  await waitFor(() => (readStatus(home, srv.pid)?.probe?.at ?? 0) > brokenAt + 100, 20_000, 'a probe after the break');
  const r = await srv.search(Q);

  assert.equal(fs.existsSync(mark), false, `a program inside the project was run: ${fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8').trim() : ''}`);
  assert.doesNotMatch(section(r.text, 'CUES').block, /helper runs on/, 'the helper must not run on the project\'s program');
  assert.match(section(r.text, 'CUES').header ?? '', /^CUES \(0\) · no match: lane echo is not available: no working Node .*inside the current project, never run/, section(r.text, 'CUES').header);
  assert.equal(r.files[0]?.file, 'beta-memory/src/episode_store.ts', 'search answers without the helper lane');
});
