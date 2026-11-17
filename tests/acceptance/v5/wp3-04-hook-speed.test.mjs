// WP3-04 the prompt hook is cheap: the shim's exact hook command, run through the platform shell as
// the host runs it, finishes in under 150 ms at the 95th percentile over 200 runs, and starts no
// other program (every child_process call in the hook's process is logged by a preload carried by
// NODE_OPTIONS). The evidence is a realistic home: installed, two live servers.
// Break: the hook starts a program.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { status, wp3 } from './wp3-helpers.mjs';

const RUNS = Number(process.env.WP3_HOOK_RUNS ?? 200);
const BUDGET_MS = 150;
const OWN_MS = 50;

test('WP3-04 the hook takes under 150 ms at p95 and starts no other program', { timeout: 300_000 }, async (t) => {
  const { ctx, tree, livePid, home } = wp3(t, 'wp3-04');
  const h = home({ servers: [status(livePid()), status(livePid())] });

  const log = path.join(ctx.tmp('rb5-wp3-log-'), 'spawns.jsonl');
  const watched = tree.hook(h, { env: { WP4_SPAWN_LOG: log, NODE_OPTIONS: `--import=${pathToFileURL(path.join(import.meta.dirname, 'wp4-spawn-log.mjs')).href}` } });
  assert.match(watched.line, /^\[RuvNet Brain OK · knowledge of 14 Nov · search_ruvnet ready\]$/, `the watched run prints the verdict: ${watched.line} ${watched.stderr}`);
  const spawns = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.deepEqual(spawns, [], `the hook started a program: ${spawns.join(' | ')}`);

  // The hook and a bare Node start, interleaved, through the same shell: the median of the paired
  // differences is the hook's own work (robust to load spikes that hit both). The absolute 150 ms
  // is judged where a bare Node start leaves room for it (the CI machines); where Node alone starts
  // slower than 100 ms at p95 it is reported, not judged (WP3_HOOK_STRICT=1 judges it anyway).
  const hook = [];
  const bare = [];
  const bareCmd = `"${process.execPath}" -e 0`;
  const time = (fn) => {
    const t0 = process.hrtime.bigint();
    const r = fn();
    return [Number(process.hrtime.bigint() - t0) / 1e6, r];
  };
  for (let i = 0; i < RUNS; i++) {
    const [ms, r] = time(() => tree.hook(h));
    hook.push(ms);
    assert.equal(r.line, watched.line, `run ${i} printed a different line`);
    bare.push(time(() => spawnSync(bareCmd, { shell: true }))[0]);
  }
  const p95 = (a) => [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.95) - 1];
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const own = med(hook.map((x, i) => x - bare[i]));
  const judged = p95(bare) < 100 || process.env.WP3_HOOK_STRICT === '1';
  t.diagnostic(`hook over ${RUNS} runs: median ${med(hook).toFixed(1)} ms, p95 ${p95(hook).toFixed(1)} ms; bare Node start: median ${med(bare).toFixed(1)} ms, p95 ${p95(bare).toFixed(1)} ms; the hook's own cost (median paired difference) ${own.toFixed(1)} ms; 1-minute load ${os.loadavg()[0].toFixed(1)}; absolute budget ${judged ? 'judged' : 'not judged here (bare Node p95 over 100 ms)'}`);
  assert.ok(own < OWN_MS, `the hook's own work adds ${own.toFixed(1)} ms (median) over a bare Node start, over ${OWN_MS} ms`);
  if (judged) assert.ok(p95(hook) < BUDGET_MS, `the hook's p95 is ${p95(hook).toFixed(1)} ms, over the ${BUDGET_MS} ms budget`);
});
