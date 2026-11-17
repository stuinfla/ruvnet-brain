// WP1 T4: a private pack is not searched from a project that is not on its list, and is searched
// from one that is (or from a folder inside one). Not searching is an answer with a reason in every
// section, never an error. A public pack is unaffected. Break: remove the scope check.
// Assumed pack fields (a contract change request): PACK.json `access: "private"` and
// `projects: [absolute folder, ...]`; the caller passes the question's project as options.project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { engineTree, filePassages, historyItem, manifest, scratch, writePack } from './wp1-helpers.mjs';

const Q = 'where are the brindlecove meeting notes';

function makePrivate(dir, projects) {
  const pk = JSON.parse(fs.readFileSync(path.join(dir, 'PACK.json'), 'utf8'));
  const recipeText = fs.readFileSync(path.join(dir, 'RECIPE.json'), 'utf8');
  manifest(dir, Object.fromEntries(pk.files.map((f) => [f.path, f.role])), { recipeText, sources: pk.sources, fields: { access: 'private', projects } });
}

test('WP1 T4 a private pack answers only in its listed projects', async (t) => {
  const tmp = scratch(t);
  const { analyse, engine } = await engineTree(tmp, 'wp1-private-scope');
  const base = tmp('wp1-projects-');
  const listed = path.join(base, 'client-work');
  const other = path.join(base, 'side-project');
  const sibling = path.join(base, 'client-work-old'); // shares the listed folder's name as a prefix
  const opts = {
    passages: filePassages('owner-notes', 'meetings/2026-11-02.md', [['brindlecove meeting notes: pricing agreed']], { kind: 'doc' }),
    history: [historyItem('owner-notes', 'commit', 'a1b2c3d4e5f60718293a', '2026-11-03', 'brindlecove notes added', 'add brindlecove meeting notes')],
    probes: [{ question: 'brindlecove pricing agreed', expect: 'owner-notes/meetings/2026-11-02.md' }],
  };
  const pub = writePack(path.join(tmp(), 'pack'), analyse, opts);
  const priv = writePack(path.join(tmp(), 'pack'), analyse, opts);
  makePrivate(priv, [listed]);

  const h = engine.open(priv);
  t.after(() => engine.close(h));
  const files = (r) => r.sections.flatMap((s) => s.items.map((i) => `${i.repo}/${i.path}`));

  for (const project of [listed, path.join(listed, 'src', 'deep'), `${listed}${path.sep}`]) {
    const r = engine.search(h, Q, { project });
    assert.deepEqual(files(r), ['owner-notes/meetings/2026-11-02.md', 'owner-notes/history/commit/a1b2c3d4e5f60718293a'], `searched from ${project}`);
  }
  for (const project of [other, sibling, path.dirname(listed), undefined]) {
    const r = engine.search(h, Q, project ? { project } : {});
    assert.deepEqual(files(r), [], `a private pack must not be searched from ${project ?? 'no project'}`);
    assert.equal(r.sections.length, 2);
    for (const s of r.sections) assert.match(s.empty.reason, project ? /private pack, searched only from its listed projects; .* is not one of them/ : /private pack and the caller named no project/);
  }
  assert.equal(engine.selfTest(h).ok, true, 'the machinery probe of a private pack still runs');

  const hp = engine.open(pub);
  t.after(() => engine.close(hp));
  assert.equal(files(engine.search(hp, Q, { project: other })).length, 2, 'a public pack answers from any project');
  assert.equal(files(engine.search(hp, Q)).length, 2, 'a public pack answers with no project named');
});
