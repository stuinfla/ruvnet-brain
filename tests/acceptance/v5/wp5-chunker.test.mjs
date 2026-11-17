// WP5 chunker pins (RECIPE-FINAL 2.1, ported from forge-chunk-v2 / forge-chunk-code-v2): one passage
// per symbol or heading section, at most the recipe's token cap, first line `repo › path › symbol`
// plus a label line (kept in the indexed subject, not in the cited text), whole source bodies (not
// opening comments), every line of every file in exactly one passage, and a folder named `v2` indexed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SEP, built, query, readJson, setup, sha256, units, writeRepo } from './wp5-helpers.mjs';

const R = 'wp5-omega';
const words = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} section text quillmoss${i} line ${i} with several plain words here`).join('\n');
const longFn = ['/// Walks every step of the long path (fixture).', '/// Second line of the opening comment.', 'pub fn long_walk(start: u32) -> u32 {',
  ...Array.from({ length: 160 }, (_, i) => `    let step_${i} = cobaltfern_${i} + ${i};`), '    finishmarker_tallowspire(step_159)', '}', ''].join('\n');
const shape = (name, n) => [`/// ${name} doc line.`, `pub fn ${name}(v: u32) -> u32 {`, ...Array.from({ length: n }, (_, i) => `    let ${name}_value_${i} = v * ${i} + sablecrest;`), '    v', '}'].join('\n');
// one 4,439-character line (under the reference's 5,000-character minified-file rule) of about 1,050 tokens
const WIDE = Array.from({ length: 350 }, (_, i) => `loomspire${i}`).join(' ');

const OMEGA = {
  'v2/src/engine.rs': '// v2 engine (fixture)\npub fn velvetcrane_route(x: u32) -> u32 {\n    x + 1\n}\n',
  'src/long_walk.rs': longFn,
  'src/shapes.rs': `${shape('first_shape', 22)}\n\n${shape('second_shape', 22)}\n`,
  'docs/GUIDE.md': `# Alpha\n\n${words('alpha', 22)}\n\n# Beta\n\n${words('beta', 22)}\n\n## Beta Inner\n\nShort inner text.\n`,
  'notes/wide.txt': `${WIDE}\n`,
};

test('WP5 chunker: symbol and section passages, token cap, header, whole bodies, v2 indexed', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp5-chunker');
  const tree = ctx.tree();
  const src = writeRepo(path.join(ctx.tmp('rb5-src-'), R), { repo: R, commit: '0a0a0a0a0a0a', date: '2026-11-15' }, OMEGA);
  const pack = built(ctx, tree, { sources: [src] });
  const all = units(pack);
  const cap = readJson(path.join(pack, 'RECIPE.json')).units.passage.symbolChunker.maxTokens;
  assert.equal(cap, 480, 'the recipe cap of record is 480 tokens');

  // folders named v2 are not skipped
  const v2 = all.filter((u) => u.path === 'v2/src/engine.rs');
  assert.equal(v2.length, 1, 'v2/src/engine.rs must be indexed as exactly one passage');
  assert.equal(v2[0].header, `${R}${SEP}v2/src/engine.rs${SEP}velvetcrane_route`);

  // the cap, with a magnitude: long passages are filled close to it, none is over it
  for (const u of all) assert.ok(u.tokens > 0 && u.tokens <= cap, `${u.path}:${u.start_line} has ${u.tokens} tokens (cap ${cap})`);
  const walk = all.filter((u) => u.path === 'src/long_walk.rs');
  assert.ok(walk.length >= 3 && walk.length <= 8, `the 165-line function splits into 3 to 8 passages, got ${walk.length}`);
  assert.ok(Math.max(...walk.map((u) => u.tokens)) >= cap * 0.75, 'line packing fills passages to at least three quarters of the cap');

  // whole bodies: the function's last statement is stored, not only its opening comment
  const lines = OMEGA['src/long_walk.rs'].split('\n');
  const last = lines.indexOf('    finishmarker_tallowspire(step_159)') + 1;
  assert.ok(walk.some((u) => u.start_line <= last && u.end_line >= last && u.text.includes('finishmarker_tallowspire')), 'the last line of the long function is in a passage');
  assert.equal(walk[0].start_line, 1, 'the opening comment starts the first passage');
  for (const u of walk) assert.equal(u.symbol, 'long_walk', 'continuation passages keep the symbol');
  assert.ok(walk.slice(1).every((u) => u.header === `${R}${SEP}src/long_walk.rs${SEP}long_walk`));

  // exact text and hash: text is the cited source lines, hash is their sha256
  for (const u of all.filter((x) => x.path !== 'notes/wide.txt')) {
    const src2 = OMEGA[u.path].split('\n').slice(u.start_line - 1, u.end_line).join('\n');
    assert.equal(u.text, src2, `${u.path}:${u.start_line}-${u.end_line} text is exactly the cited lines`);
    assert.equal(u.hash, sha256(src2));
  }

  // unit boundaries: one passage per symbol when each symbol is over the grouping target
  const shapes = all.filter((u) => u.path === 'src/shapes.rs').map((u) => [u.symbol, u.start_line, u.end_line]);
  assert.deepEqual(shapes, [['first_shape', 1, 26], ['second_shape', 28, 53]]);
  const guide = all.filter((u) => u.path === 'docs/GUIDE.md').map((u) => [u.header, u.start_line, u.end_line]);
  assert.deepEqual(guide, [
    [`${R}${SEP}docs/GUIDE.md${SEP}Alpha`, 1, 24],
    [`${R}${SEP}docs/GUIDE.md${SEP}Beta`, 26, 49],
    [`${R}${SEP}docs/GUIDE.md${SEP}Beta > Beta Inner`, 51, 53],
  ]);

  // the label line follows the header in the indexed subject and is never in the cited text
  for (const u of all) {
    assert.match(u.label, /^\[[a-z]+, [a-z]+/, `${u.path} label line`);
    assert.ok(!u.text.startsWith(u.header), 'the header is not part of the cited text');
  }

  // coverage: every non-blank line of every file lies in exactly one passage (pieces share their line)
  for (const [rel, text] of Object.entries(OMEGA)) {
    const mine = all.filter((u) => u.path === rel);
    const seen = new Map();
    for (const u of mine) for (let n = u.start_line; n <= u.end_line; n++) seen.set(n, (seen.get(n) ?? new Set()).add(u.id));
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      assert.ok(seen.has(i + 1), `${rel}:${i + 1} is in no passage`);
      if (rel !== 'notes/wide.txt') assert.equal(seen.get(i + 1).size, 1, `${rel}:${i + 1} is in more than one passage`);
    });
  }

  // a single over-long line is split into pieces that each fit and join back to the line
  const pieces = all.filter((u) => u.path === 'notes/wide.txt').sort((a, b) => a.piece - b.piece);
  assert.equal(pieces.length, 3, 'the 350-word line is split into exactly 3 pieces');
  assert.equal(pieces.map((u) => u.text).join(''), WIDE);

  // manifest: per-source counts match the index
  const m = readJson(path.join(pack, 'manifest.json'));
  assert.equal(m.sources[0].passages, all.length);
  assert.equal(query(pack, 'lexical.db', 'SELECT count(*) AS n FROM fts')[0].n, all.length);
  assert.equal(fs.existsSync(path.join(pack, 'history.db')), false, 'no history export, no history store');
});
