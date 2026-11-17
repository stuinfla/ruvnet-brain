// WP2 T3: read_ruvnet returns the requested lines of a file in the pack, capped; a path outside the
// pack is refused. The lines are compared with the fixture file itself, so a rebuilt file that drops
// or shifts a line fails. "Outside" covers paths that leave the pack (.., absolute, drive letters) and
// a private pack's file asked for from a project that is not on that pack's list.
// Break: remove the path check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { THREE, repo, setup } from './helpers.mjs';
import { installPrivate, writeRepo } from './wp2-helpers.mjs';

const read = async (srv, ref, detail) => {
  const res = await srv.call('tools/call', { name: 'read_ruvnet', arguments: { ref, ...(detail ? { detail } : {}) } });
  return { text: res.content.map((c) => c.text).join(''), isError: !!res.isError };
};
/** The fenced text of a read answer, and its cited range. */
function body(text) {
  const m = /^<<<passage-(\S+)$/m.exec(text);
  assert.ok(m, `no fence in: ${text.slice(0, 200)}`);
  const start = text.indexOf('\n', m.index) + 1;
  const range = /· lines (\d+)-(\d+) of (\d+)-(\d+) ·/.exec(text);
  return { text: text.slice(start, text.indexOf(`\npassage-${m[1]}>>>`)), from: Number(range[1]), to: Number(range[2]), last: Number(range[4]) };
}
const fileLines = (file) => fs.readFileSync(file, 'utf8').replace(/\n+$/, '').split('\n');

test('WP2 T3 read_ruvnet reads cited lines, capped, and only inside the pack', { timeout: 300_000 }, async (t) => {
  const ctx = setup(t, 'wp2-03');
  const tree = ctx.tree();
  const src = ctx.tmp('rb5-read-');
  const bigLines = Array.from({ length: 3000 }, (_, i) => `row ${i + 1}: the brackenmoor ledger keeps a careful tally of quillstone shipments, column ${i % 7}`);
  const big = writeRepo(src, 'big-ledger', { 'LEDGER.md': `${bigLines.join('\n')}\n` });
  const { home } = ctx.installed(tree, { sources: [...THREE, big] });
  const notes = writeRepo(src, 'owner-notes', { 'meetings/notes.md': '# Meeting\n\nThe saltmarrow pricing was agreed with the client on Tuesday.\n' });
  const base = ctx.tmp('rb5-projects-');
  const listed = path.join(base, 'client-work');
  const other = path.join(base, 'client-work-old');
  for (const d of [path.join(listed, 'src'), other]) fs.mkdirSync(d, { recursive: true });
  installPrivate(home, tree.build([notes]), 'notes', [listed]);

  const srv = await ctx.server(tree, home, { cwd: other });
  const hnsw = path.join(repo('alpha-vectors'), 'src', 'hnsw_index.rs');

  // The requested lines, exactly as in the source file.
  const part = await read(srv, 'alpha-vectors/src/hnsw_index.rs#L2-5');
  assert.equal(part.isError, false, part.text);
  const pb = body(part.text);
  assert.deepEqual([pb.from, pb.to], [2, 5]);
  assert.equal(pb.text, fileLines(hnsw).slice(1, 5).join('\n'));
  assert.match(part.text, /^alpha-vectors\/src\/hnsw_index\.rs · lines 2-5 of 1-\d+ · commit \S+ · standing implemented · date \S+ · sha256 [0-9a-f]{64}$/m);

  // The whole file when no range is given (blank lines between passages come back too).
  const whole = body((await read(srv, 'alpha-vectors/src/hnsw_index.rs')).text);
  assert.equal(whole.text, fileLines(hnsw).join('\n'));

  // Capped: 3,000 lines (about 270,000 characters) come back within the cap, as whole lines from the
  // start, with the next range to ask for.
  // full: the recipe allows 60,000, but nothing over 44,000 characters reaches the model (the host's limit).
  for (const [detail, cap] of [[undefined, 24_000], ['full', 44_000]]) {
    const r = await read(srv, 'big-ledger/LEDGER.md', detail);
    assert.equal(r.isError, false);
    assert.ok(r.text.length <= cap, `read answer is ${r.text.length} characters, over the ${cap} cap`);
    assert.ok(r.text.length >= cap * 0.8, `the cap is used, not wasted: ${r.text.length} of ${cap}`);
    const b = body(r.text);
    assert.equal(b.from, 1);
    assert.equal(b.text, bigLines.slice(0, b.to).join('\n'), 'whole lines from the first, none skipped');
    assert.match(r.text, new RegExp(`read_ruvnet\\(\\{ ref: "big-ledger/LEDGER\\.md#L${b.to + 1}-3000" \\}\\)`), 'it says which lines to ask for next');
  }
  const tail = body((await read(srv, 'big-ledger/LEDGER.md#L2990-3000')).text);
  assert.equal(tail.text, bigLines.slice(2989).join('\n'));

  // Outside the pack: refused, with nothing quoted.
  for (const ref of ['../PACK.json', 'alpha-vectors/../beta-memory/README.md', '/etc/passwd', 'C:\\Windows\\win.ini', 'alpha-vectors/./README.md', 'alpha-vectors/src/missing.rs', 'README.md', 'owner-notes/meetings/notes.md']) {
    const r = await read(srv, ref);
    assert.equal(r.isError, true, `${ref} must be refused: ${r.text.slice(0, 300)}`);
    assert.match(r.text, /^RuvNet Brain · read_ruvnet refused: /, ref);
    assert.doesNotMatch(r.text, /saltmarrow|<<<passage-/, `${ref}: nothing may be quoted`);
  }
  // The private pack's file is read from its listed project, and only there.
  const srvListed = await ctx.server(tree, home, { cwd: path.join(listed, 'src') });
  const priv = await read(srvListed, 'owner-notes/meetings/notes.md');
  assert.equal(priv.isError, false, priv.text);
  assert.match(body(priv.text).text, /saltmarrow pricing was agreed/);
});
