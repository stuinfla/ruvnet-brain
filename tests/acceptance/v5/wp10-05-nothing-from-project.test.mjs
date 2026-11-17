// WP10-05 the guard never runs or reads a file from the project. A project planted with look-alikes of
// everything the guard loads (its data file, the engine it opens to verify a citation, the health and
// contract modules, scripts, a stamp folder) is run from as the current folder, with NODE_PATH aimed at
// it: nothing planted runs (each would leave a marker), and the guard's product names come from beside
// the guard (the planted data names no product, yet the write is still refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { Q, TERM_TEXT, emptyTranscript, guard, okServer, transcript, writeMsg } from './wp10-helpers.mjs';

test('WP10-05 nothing from the project runs or is read by the guard', { timeout: 240_000 }, async (t) => {
  const ctx = setup(t, 'wp10-05');
  const tree = ctx.tree();
  const { home } = ctx.installed(tree);
  assert.equal(tree.cli(home, ['guard', 'on']).status, 0);
  const srv = await okServer(ctx, tree, home);
  const project = ctx.tmp('rb5-project-');
  const marker = path.join(project, 'RAN');
  const evil = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, __filename + '\\n');\n`;
  const evilEsm = `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, import.meta.url + '\\n');\nexport const open = () => null, read = () => [], close = () => {}, assessHome = () => ({ state: 'ok' });\n`;
  const plant = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  };
  const quiet = JSON.stringify({ terms: ['zzzz'], override: 'x', freshMinutes: 1, toolSuffix: 'x', resultHeader: 'x', logMax: 1 });
  for (const rel of ['guard.json', 'packages/guard/guard.json', 'guard/guard.json']) plant(rel, quiet);
  for (const rel of ['engine/index.mjs', 'packages/engine/index.mjs', 'health/assess.mjs', 'packages/health/assess.mjs', 'contract/home.mjs', 'packages/contract/home.mjs', 'scripts/ascii-drift.mjs', 'guard.mjs']) plant(rel, evilEsm);
  for (const rel of ['node_modules/fs/index.js', 'node_modules/path/index.js', 'index.js']) plant(rel, evil);
  plant('.ruvnet-brain/grounded/ruflo', 'stamp');
  const run = (tr) => guard(tree, home, writeMsg(path.join(project, 'adapter.ts'), TERM_TEXT, tr), { cwd: project, env: { NODE_PATH: path.join(project, 'node_modules') } });

  const refused = run(emptyTranscript(project));
  assert.equal(refused.status, 2, `the guard's product names must come from beside it, not the project: ${refused.stdout}`);
  const real = await srv.call('tools/call', { name: 'search_ruvnet', arguments: { query: Q } });
  const allowed = run(transcript(project, { content: real.content }));
  assert.equal(allowed.status, 0, `a real search passes (the engine is opened from beside the guard): ${allowed.stderr}`);
  assert.equal(fs.existsSync(marker), false, `a project file ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
  await srv.close();
});
