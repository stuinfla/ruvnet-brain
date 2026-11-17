// Wave 4, test 8: facts_ruvnet on the name of a very large repository answers (found on the full corpus:
// facts for RuVector, about 190,000 extract rows, threw "Maximum call stack size exceeded" because the
// rows were spread as call arguments). A fixture repository with over 280,000 extract rows is built and
// asked for its facts by name; the first page comes back within the cap, with the total row count.
// Break (breaks-wave4.mjs): the rows of a repository spread into push() again.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { built, writeRepo } from './wp5-helpers.mjs';
import { openLayeredDirect } from './wave4-helpers.mjs';

test('Wave 4: facts for a repository with hundreds of thousands of rows answers', { timeout: 600_000 }, async (t) => {
  const ctx = setup(t, 'wave4-08');
  const tree = ctx.tree();
  // Four files under the recipe's 1.5 MB file limit; each line is a constant and a signature row.
  const file = (k) => Array.from({ length: 36_000 }, (_, i) => `export const BIG_${k}_${i} = ${i};`).join('\n') + '\n';
  const files = Object.fromEntries([0, 1, 2, 3].map((k) => [`src/big${k}.ts`, file(k)]));
  files['README.md'] = '# huge-repo\n\nA fixture repository with a very large number of extracted rows for the layered store.\n';
  const src = writeRepo(path.join(ctx.tmp('rb5-src-'), 'huge-repo'), { repo: 'huge-repo', commit: 'abcabc123123', date: '2026-11-15' }, files);
  const pack = built(ctx, tree, { sources: [src] });
  const L = await openLayeredDirect(tree, pack);
  t.after(() => L.close());
  const raw = L.raw('facts', { target: 'huge-repo', kind: null, repo: null, cursor: 0 });
  assert.ok(raw.length <= 20_000, `page within the cap (${raw.length})`);
  const p = JSON.parse(raw);
  const total = Number(p.shown.split(' of ')[1]);
  assert.ok(total >= 280_000, `every row of the repository is counted (${total})`);
  assert.ok(p.rows.length > 10 && p.next > 0, 'the first page is filled and pages on');
});
