// S13 off-switch: with auto-update turned off through the CLI, a recorded network stub receives zero
// requests over a simulated day (the update timer compressed to 50 ms: 30 ticks against the default
// 4-hour interval's 6 per day). Control: switched on, the same stub is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setup, sleep, waitFor, writeConfig } from './helpers.mjs';

test('S13 auto-update off means no network request', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's13');
  const tree = ctx.tree();
  const hits = [];
  const stub = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ releaseNumber: 99 }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const { home } = ctx.installed(tree);

  const off = tree.cli(home, ['config', 'auto-update', 'off']);
  assert.equal(off.status, 0, off.stderr);
  writeConfig(home, { updateUrl: `http://127.0.0.1:${stub.address().port}/`, updateIntervalMs: 50 });
  const srv = await ctx.server(tree, home);
  await sleep(1500);
  await srv.close();
  assert.equal(hits.length, 0, `with auto-update off the network stub must receive zero requests; it received ${hits.length}`);

  const on = tree.cli(home, ['config', 'auto-update', 'on']);
  assert.equal(on.status, 0, on.stderr);
  const srv2 = await ctx.server(tree, home);
  await waitFor(() => hits.length > 0, 10_000, 'the control run to reach the stub');
  await srv2.close();
  const check = JSON.parse(fs.readFileSync(path.join(home, 'state', 'update-check.json'), 'utf8'));
  assert.equal(check.available, true, 'the control run read the offered release number');
  t.diagnostic(`off: 0 requests; on: ${hits.length} requests`);
});
