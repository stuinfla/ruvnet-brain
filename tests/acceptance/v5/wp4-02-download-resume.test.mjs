// WP4 download with resume: a release served over HTTP has its largest file cut off at a random byte.
// The installer asks for the rest from exactly that byte (an HTTP range), not from the start, and the
// installed file has the signed hash. Break: the resume request is dropped (every retry starts at 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertScratch, cliAsync, serveRelease } from './wp4-helpers.mjs';
import { THREE, setup } from './helpers.mjs';

test('WP4-02 a download cut off part-way resumes from the byte it reached', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp4-02');
  const tree = ctx.tree();
  const pack = tree.build(THREE);
  const blob = crypto.randomBytes(3 * 1024 * 1024 + 17);
  fs.writeFileSync(path.join(pack, 'blob.bin'), blob);
  const rel = tree.release(pack, { number: 1 });
  const size = blob.length;
  const cut = crypto.randomInt(1024, size - 1024);
  let cutDone = false;
  const srv = await serveRelease(rel, {
    onRequest(rec, { file, res }) {
      if (cutDone || path.basename(file) !== 'blob.bin' || rec.range) return false;
      cutDone = true;
      res.write(blob.subarray(0, cut), () => setTimeout(() => res.socket.destroy(), 50));
      rec.served = cut;
      return true;
    },
  });
  t.after(() => srv.close());

  const home = ctx.tmp('rb5-home-');
  assertScratch(home);
  const r = await cliAsync(tree, home, ['install', '--from', srv.url]);
  assert.equal(r.status, 0, `install over HTTP failed: ${r.stdout}\n${r.stderr}`);
  const hits = srv.requests.filter((q) => q.url.endsWith('/blob.bin'));
  assert.ok(cutDone, 'the cut was applied');
  assert.equal(hits.length, 2, `blob.bin must be asked for exactly twice (cut, then resumed): ${JSON.stringify(hits)}`);
  assert.equal(hits[1].range, `bytes=${cut}-`, `the second request must resume at byte ${cut}: ${JSON.stringify(hits)}`);
  const total = hits.reduce((n, q) => n + q.served, 0);
  assert.equal(total, size, `exactly ${size} bytes of blob.bin cross the network, not ${total}`);
  const pointer = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
  const installed = fs.readFileSync(path.join(home, 'packs', pointer.pack, 'blob.bin'));
  assert.equal(crypto.createHash('sha256').update(installed).digest('hex'), crypto.createHash('sha256').update(blob).digest('hex'), 'the installed file has the signed hash');
  assert.ok(srv.requests.every((q) => !q.url.includes('..')), 'no request leaves the release folder');
  t.diagnostic(`cut at byte ${cut} of ${size}; ${srv.requests.length} requests`);
});
