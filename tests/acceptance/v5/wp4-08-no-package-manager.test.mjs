// WP4 no package manager: during an install and an update, no npm, npx, pnpm, yarn, bun or corepack
// is started. Two watches: every child_process call in the whole Node process tree is logged (a
// preload carried by NODE_OPTIONS), and stub programs with those names sit first on PATH and leave a
// mark if run. Positive control: the installer's one real-server check does appear in the log.
// Break: the installer runs `npm --version`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertScratch } from './wp4-helpers.mjs';
import { THREE, repo, setup } from './helpers.mjs';

const MANAGERS = ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'corepack'];

function stubs(dir, marks) {
  for (const n of MANAGERS) {
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, `${n}.cmd`), `@echo ran> "${path.join(marks, n)}"\r\n`);
    else {
      fs.writeFileSync(path.join(dir, n), `#!/bin/sh\necho ran > '${path.join(marks, n)}'\n`);
      fs.chmodSync(path.join(dir, n), 0o755);
    }
  }
}

test('WP4-08 install and update start no package manager', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp4-08');
  const tree = ctx.tree();
  const rel1 = tree.release(tree.build(THREE), { number: 1, version: '5.0.1' });
  const rel2 = tree.release(tree.build([...THREE, repo('delta-graph')]), { number: 2, version: '5.0.2' });
  const bin = ctx.tmp('rb5-bin-');
  const marks = ctx.tmp('rb5-marks-');
  stubs(bin, marks);
  const logFile = path.join(ctx.tmp('rb5-log-'), 'spawns.jsonl');
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    WP4_SPAWN_LOG: logFile,
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(import.meta.dirname, 'wp4-spawn-log.mjs')).href}`,
    [pathKey]: bin + path.delimiter + process.env[pathKey],
  };
  const home = ctx.tmp('rb5-home-');
  assertScratch(home);
  for (const [verb, rel] of [['install', rel1], ['update', rel2]]) {
    const r = tree.cli(home, [verb, '--from', rel], { env });
    assert.equal(r.status, 0, `${verb}: ${r.stderr}`);
  }
  const spawns = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const servers = spawns.filter((s) => s.args.some((a) => a.endsWith(path.join('plugin', 'claude', 'launch.mjs'))));
  assert.equal(servers.length, 2, `positive control: exactly one real-server check per run must be logged: ${JSON.stringify(spawns)}`);
  const pm = spawns.filter((s) => [s.file, ...s.args].some((x) => MANAGERS.includes(path.basename(x).replace(/\.(cmd|exe)$/i, ''))));
  assert.deepEqual(pm, [], 'a package manager was started');
  const notNode = spawns.filter((s) => !/^node(\.exe)?$/i.test(path.basename(s.file)));
  assert.deepEqual(notNode, [], 'every program started must be Node itself');
  assert.deepEqual(fs.readdirSync(marks), [], `a package manager stub on PATH was run: ${fs.readdirSync(marks)}`);
  t.diagnostic(`${spawns.length} child processes logged, all Node: ${spawns.map((s) => s.args.at(-1) ?? s.args.join(' ')).join(', ')}`);
});
