// Wave 2: contract 1.1 is additive. A pack built at contract-v1 (fixtures/contract-v1-pack, built by the
// contract-v1 builder with the contract-v1 recipe, which names no delivery numbers) still opens, passes
// its probes, searches and formats; the new schema properties refuse a typo instead of ignoring it;
// the gate-result and probe-receipt schemas accept what the rail writes; the engine exports read();
// and a private pack's project list is compared on real paths (symbolic links resolved).
// Breaks: the engine requires delivery numbers; the delivery maximum is dropped from the schema; the
// gate-result schema stops requiring a score; engine.read finds nothing; the scope check compares
// paths as given.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';

const V1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contract-v1-pack');
// The pack's passage store is committed as lexical.db.fixture, not lexical.db: a tracked *.db is what the
// release prepush stray-file check refuses (a working database committed by accident), and this one is a
// frozen fixture. The bytes are the contract-v1 builder's, unchanged (PACK.json's sha256 still holds);
// copying the fixture into a working pack restores the name the pack format requires.
function copyV1Pack(dest) {
  fs.cpSync(V1, dest, { recursive: true });
  fs.renameSync(path.join(dest, 'lexical.db.fixture'), path.join(dest, 'lexical.db'));
}

async function modules(tree) {
  const at = (...p) => import(pathToFileURL(path.join(tree.root, 'packages', ...p)).href);
  return { engine: await at('engine', 'index.mjs'), validate: await at('contract', 'validate.mjs'), format: await at('server', 'format.mjs'), constants: await at('contract', 'constants.mjs') };
}

test('Wave 2: a contract-v1 pack still opens, passes its probes, searches and formats', { timeout: 120_000 }, async (t) => {
  const ctx = setup(t, 'wave2-contract');
  const tree = ctx.tree();
  const { engine, validate, format, constants } = await modules(tree);
  assert.equal(constants.CONTRACT_VERSION, '1.3');
  const pack = path.join(ctx.tmp('rb5-v1-'), 'pack');
  copyV1Pack(pack);
  const recipe = JSON.parse(fs.readFileSync(path.join(pack, 'RECIPE.json'), 'utf8'));
  assert.equal(recipe.result.delivery, undefined, 'the fixture is a contract-v1 recipe: no delivery numbers');
  assert.deepEqual(validate.problems('recipe', recipe), [], 'a contract-v1 recipe is still valid');
  let h;
  try {
    h = engine.open(pack);
    const self = engine.selfTest(h);
    assert.equal(self.ok, true, `the contract-v1 pack must pass its own probes: ${JSON.stringify(self.results)}`);
    const r = engine.search(h, 'alpha vectors embeddings', { detail: 'full' });
    assert.ok(r.sections.find((s) => s.name === 'FILES').items.some((i) => `${i.repo}/${i.path}` === 'alpha-vectors/README.md'), 'the contract-v1 pack must still search');
    const text = format.format(r, recipe);
    assert.ok(text.includes('alpha-vectors/README.md · lines') && text.length <= 44_000, 'and its result still formats within the ceiling');
    const rows = engine.read(h, 'alpha-vectors', 'README.md');
    assert.ok(rows.length >= 1 && rows.every((x) => typeof x.text === 'string'), `engine.read returns the file's passages: ${rows.length}`);
    assert.deepEqual(engine.read(h, 'alpha-vectors', 'no-such-file.md'), []);
  } finally {
    if (h) engine.close(h);
  }
});

test('Wave 2: the contract 1.1 additions refuse typos and accept what the system writes', { timeout: 60_000 }, async (t) => {
  const ctx = setup(t, 'wave2-contract');
  const tree = ctx.tree();
  const { validate, constants } = await modules(tree);
  const base = JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8'));
  assert.deepEqual(validate.problems('recipe', base), [], 'the recipe of record is valid');
  assert.deepEqual(base.result.delivery, { maxChars: 44_000, maxTokens: 20_000 });
  const bad = (edit) => validate.problems('recipe', edit(structuredClone(base))).length > 0;
  assert.ok(bad((r) => ((r.query = { extraTerms: 'apend' }), r)), 'query.extraTerms must be append or off');
  assert.ok(!bad((r) => ((r.query = { extraTerms: 'append' }), r)), 'query.extraTerms append is valid');
  assert.ok(bad((r) => ((r.lanes[0].process = 'subprocess'), r)), 'a lane process must be inline or helper');
  assert.ok(!bad((r) => ((r.lanes[0].process = 'helper'), r)), 'a helper lane is valid');
  assert.ok(bad((r) => ((r.result.delivery = { maxChars: 60_000, maxTokens: 20_000 }), r)), 'a delivery above what the host delivers is refused');
  assert.ok(bad((r) => ((r.result.delivery = { maxChars: '44000' }), r)), 'delivery numbers are integers');

  const gate = { schema: 'ruvnet-brain/gate-result', version: 1, release: 'a'.repeat(64), pack: 'g-1', passed: true, score: { hit: 9, of: 10 }, rule: 'fixture', at: new Date().toISOString() };
  assert.deepEqual(validate.problems('gate-result', gate), []);
  const { score, ...noScore } = gate;
  assert.ok(score && validate.problems('gate-result', noScore).length > 0, 'a gate result without a score is refused');
  const receipt = { schema: 'ruvnet-brain/probe-receipt', version: 1, os: 'macos', node: 'v24.0.0', release: 'b'.repeat(64), releaseNumber: 1, app: '5.0.0', pack: 'g-1', install: { exit: 0, tail: '' }, probes: [{ question: 'q', expect: 'r/x', pass: true, mode: 'MODE · normal' }], doctor: { exit: 0, line: '[RuvNet Brain OK]' }, ok: true, error: null, at: new Date().toISOString() };
  assert.deepEqual(validate.problems('probe-receipt', receipt), []);
  assert.ok(validate.problems('probe-receipt', { ...receipt, os: 'beos' }).length > 0, 'a receipt names one of the three operating systems');
  assert.equal(constants.DEFAULTS.pageTopic, null, 'paging is off unless state/config.json names a topic');
});

test('Wave 2: a private pack’s projects are compared on real paths', { skip: process.platform === 'win32' ? 'symbolic links need privileges on Windows' : false, timeout: 60_000 }, async (t) => {
  const ctx = setup(t, 'wave2-contract');
  const tree = ctx.tree();
  const { engine } = await modules(tree);
  const base = ctx.tmp('rb5-real-');
  const real = path.join(base, 'client-work');
  fs.mkdirSync(path.join(real, 'src'), { recursive: true });
  const link = path.join(base, 'linked-work');
  fs.symlinkSync(real, link);
  const hits = (projects, project) => {
    const pack = path.join(ctx.tmp('rb5-priv-'), 'pack');
    copyV1Pack(pack);
    const file = path.join(pack, 'PACK.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), access: 'private', projects }, null, 2));
    const h = engine.open(pack);
    try {
      return engine.search(h, 'alpha vectors embeddings', { project }).sections.find((s) => s.name === 'FILES').items.length;
    } finally {
      engine.close(h);
    }
  };
  assert.ok(hits([real], link) > 0, 'a project reached through a link to a listed folder is that folder');
  assert.ok(hits([link], path.join(real, 'src')) > 0, 'a listed link names the folder it points to');
  assert.equal(hits([real], path.join(base, 'elsewhere')), 0, 'an unlisted folder is still refused');
});
