// S1 end to end: build, sign, install from a folder, start the server, ask over the real protocol,
// get the expected fixture file with a citation. Also: typed "no match", the same first five files
// in separate processes, the health line and doctor say OK, uninstall keeps private/.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, setup, waitFor } from './helpers.mjs';

const Q = 'how does the quillfeather index descend its layers with marrowlight';

test('S1 end to end', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 's01');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);

  const srv = await ctx.server(tree, home);
  const r = await srv.search(Q);
  assert.equal(r.isError, false, r.text);
  assert.equal(r.mode, 'MODE · normal', `answer must not be in safe mode: ${r.mode}`);
  assert.equal(r.files[0]?.file, 'alpha-vectors/src/hnsw_index.rs', `expected the hnsw_index.rs file first; got ${JSON.stringify(r.files.map((f) => f.file))}`);
  assert.equal(r.raw.structuredContent, undefined, 'result text must not be sent twice');
  for (const f of r.files) {
    const local = path.join(FIXTURES, ...f.file.split('/'));
    assert.ok(fs.existsSync(local), `cited file does not exist: ${f.file}`);
    const cited = fs.readFileSync(local, 'utf8').split('\n').slice(f.start - 1, f.end).join('\n');
    assert.ok(r.text.includes(cited), `excerpt of ${f.file} lines ${f.start}-${f.end} is not the cited source text`);
    assert.equal(f.hash, crypto.createHash('sha256').update(cited).digest('hex'), `content hash of ${f.file} does not match the cited lines`);
    const src = JSON.parse(fs.readFileSync(path.join(FIXTURES, f.file.split('/')[0], '.source.json'), 'utf8'));
    assert.equal(f.commit, src.commit);
    assert.equal(f.date, src.date);
    assert.ok(['implemented', 'claimed'].includes(f.standing), `standing ${f.standing}`);
  }

  const none = await srv.search('xyzzyplover frobnicatewump');
  assert.equal(none.isError, false, 'nothing matched is an answer, not an error');
  assert.match(none.text, /FILES \(0\) · no match: no passage in this pack contains any of: xyzzyplover, frobnicatewump/);

  const firstFive = r.files.slice(0, 5).map((f) => f.file);
  for (let i = 0; i < 2; i++) {
    const other = await ctx.server(tree, home);
    const again = await other.search(Q);
    assert.deepEqual(again.files.slice(0, 5).map((f) => f.file), firstFive, 'same question, same pack, separate process: same first five files');
    await other.close();
  }

  const line = await waitFor(() => (tree.hook(home).line.includes('RuvNet Brain OK') ? tree.hook(home).line : null), 10_000, 'the OK health line');
  assert.match(line, /^\[RuvNet Brain OK · knowledge of 14 Nov · search_ruvnet ready\]$/);
  const doc = tree.cli(home, ['doctor']);
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);

  await srv.close();
  fs.mkdirSync(path.join(home, 'private', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(home, 'private', 'mine', 'notes.txt'), 'private text');
  const u = tree.cli(home, ['uninstall']);
  assert.equal(u.status, 0, u.stdout + u.stderr);
  assert.match(u.stdout, /nothing listed remains/);
  for (const gone of ['current.json', 'app', 'packs', 'state']) assert.equal(fs.existsSync(path.join(home, gone)), false, `${gone} should be removed`);
  assert.equal(fs.readFileSync(path.join(home, 'private', 'mine', 'notes.txt'), 'utf8'), 'private text');
});
