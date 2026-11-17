// WP1 sections: the recipe's answer shape, through engine.search.
//   FILES: the first 5 distinct files; each excerpt up to itemChars (8,000) centred on the file's best
//   passage. HISTORY: the first 3 history items, each up to 2,000 characters, kind, reference, date and
//   title in its header. Each section within its budget, the whole result within the cap, no passage
//   sent twice. A per-section "nothing matched" with a reason. The fixed closing line. selfTest from
//   the pack's probes. A new lane and section added by recipe data alone (the lane plug-in socket).
// Breaks: windows removed; distinct-file rule removed; the whole-result cap removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { engineTree, filePassages, historyItem, scratch, wp1Recipe, writePack } from './wp1-helpers.mjs';

const CLOSING = 'When sources disagree: code that exists outranks a measured result, which outranks a correction or negative result, then a decision record, then a README claim, then a plan, then an essay.';
const NAMES = ['alpha', 'bravo', 'charl', 'delta', 'echoo', 'foxtr', 'golfo'];

/** Seven files of 18 passages (about 640 characters each). Every passage says the topic word once;
 *  passage 9 of the first file says it three times, so that passage is the best one overall. */
function corpus() {
  const out = [];
  NAMES.forEach((name, f) => {
    const bodies = Array.from({ length: 18 }, (_, n) => Array.from({ length: 8 }, (_, l) => {
      const hot = l === 0 ? (f === 0 && n === 8 ? 'glimmerdrift glimmerdrift glimmerdrift' : 'glimmerdrift') : 'plain';
      return `pid${name}${n}x${l} ${hot} ${'lorem ipsum dolor sit amet '.repeat(2)}`;
    }));
    out.push(...filePassages(`repo${name}`, `src/${name}_module.rs`, bodies));
  });
  out.push(...filePassages('reposolo', 'docs/quill.md', [['only quillsong lives here']], { kind: 'doc' }));
  return out;
}

const history = () => Array.from({ length: 5 }, (_, i) => historyItem('repoalpha', 'commit', `${i}`.repeat(4) + "abcdef0123456789abcdef0123456789abcd", `2026-11-0${i + 1}`, `glimmerdrift change ${i}`, `hid${i} glimmerdrift ${'commit body text '.repeat(93)}`.slice(0, 1600)));
const markers = (text) => text.match(/\b[ph]id[a-z]*\d+(?:x\d+)?\b/g) ?? [];
const totalChars = (r) => r.sections.reduce((n, s) => n + s.items.reduce((m, i) => m + i.excerpt.length, 0), 0);

test('WP1 sections: FILES, HISTORY, budgets, cap, nothing matched, closing line, probes, plug-in lane', async (t) => {
  const tmp = scratch(t);
  const { analyse, engine } = await engineTree(tmp, 'wp1-sections');
  const passages = corpus();
  const probes = [{ question: 'glimmerdrift', expect: 'repoalpha/src/alpha_module.rs' }];
  const pack = writePack(path.join(tmp(), 'pack'), analyse, { passages, history: history(), probes });
  const h = engine.open(pack);
  t.after(() => engine.close(h));

  const r = engine.search(h, 'glimmerdrift', { detail: 'full' });
  assert.deepEqual(r.sections.map((s) => s.name), ['FILES', 'HISTORY']);
  const [files, hist] = r.sections;

  // FILES: five distinct files, the best passage's file first, each a window centred on its best passage.
  const fileNames = files.items.map((i) => `${i.repo}/${i.path}`);
  assert.equal(fileNames.length, 5);
  assert.equal(new Set(fileNames).size, 5, `FILES must list distinct files: ${fileNames.join(', ')}`);
  assert.equal(fileNames[0], 'repoalpha/src/alpha_module.rs');
  const top = files.items[0];
  assert.ok(top.excerpt.length <= 8000, `FILES item is ${top.excerpt.length} characters, over 8,000`);
  assert.ok(top.excerpt.length > 7000, `FILES item is only ${top.excerpt.length} characters: the window was not filled`);
  const ids = markers(top.excerpt).filter((m) => m.endsWith('x0')).map((m) => Number(m.match(/(\d+)x0$/)[1]));
  assert.ok(ids.includes(8), 'the window holds the best passage');
  const before = ids.filter((n) => n < 8).length;
  const after = ids.filter((n) => n > 8).length;
  assert.ok(before >= 4 && after >= 4 && Math.abs(before - after) <= 1, `window not centred: ${before} passages before, ${after} after`);
  assert.equal(top.lines.start, passages.find((p) => p.header.endsWith(`part${Math.min(...ids) + 1}`) && p.repo === 'repoalpha').start);
  for (const it of files.items) assert.ok(it.excerpt.length <= 8000);

  // HISTORY: first three items, each at most 2,000 characters, with kind, reference, date and title.
  assert.equal(hist.items.length, 3);
  for (const it of hist.items) {
    assert.ok(it.excerpt.length <= 2000 && it.excerpt.length > 1500, `HISTORY item is ${it.excerpt.length} characters`);
    assert.match(it.excerpt, /^repoalpha › history › commit [0-9a-f]{10} › 2026-11-0\d › glimmerdrift change \d\n/);
    assert.match(it.path, /^history\/commit\/[0-9a-f]{40}$/);
    assert.equal(it.standing, 'implemented');
  }

  // Budgets, cap, and no passage sent twice.
  assert.ok(files.items.reduce((n, i) => n + i.excerpt.length, 0) <= 44000);
  assert.ok(totalChars(r) <= 60000, `full result excerpts total ${totalChars(r)} characters, over 60,000`);
  const all = r.sections.flatMap((s) => s.items.flatMap((i) => markers(i.excerpt)));
  assert.equal(all.length, new Set(all).size, 'a passage was sent twice');
  const brief = engine.search(h, 'glimmerdrift');
  assert.equal(brief.detail, 'brief');
  assert.ok(totalChars(brief) <= 24000, `brief result excerpts total ${totalChars(brief)} characters, over 24,000`);
  assert.equal(r.closing, CLOSING);

  // Nothing matched: per section, with a reason, never an error.
  const q = engine.search(h, 'quillsong');
  assert.deepEqual(q.sections[0].items.map((i) => i.path), ['docs/quill.md']);
  assert.deepEqual(q.sections[1], { name: 'HISTORY', items: [], empty: { reason: 'no history item in this pack contains any of: quillsong' } });
  for (const s of engine.search(h, 'what is the and of it').sections) assert.equal(s.empty.reason, 'the question has no searchable words once common words are removed');

  // selfTest runs the pack's probes; a probe whose file is not in the pack fails it.
  assert.equal(engine.selfTest(h).ok, true);
  const badPack = writePack(path.join(tmp(), 'pack'), analyse, { passages, probes: [{ question: 'glimmerdrift', expect: 'repoalpha/src/gone.rs' }] });
  const hb = engine.open(badPack);
  const bad = engine.selfTest(hb);
  engine.close(hb);
  assert.equal(bad.ok, false);
  assert.equal(bad.results[0].pass, false);

  // Plug-in socket: one more lane of an existing kind and its section, from recipe data only.
  const base = wp1Recipe();
  const recipe = wp1Recipe({
    lanes: [...base.lanes, { name: 'playbooks', kind: 'fts5-bm25', optional: true, role: 'playbooks-db', unit: 'playbook' }],
    sections: [...base.sections, { name: 'PLAYBOOKS', lane: 'playbooks', maxItems: 2, itemChars: 1500, budgetChars: { brief: 2000, full: 3000 } }],
  });
  const play = [{ repo: 'repoalpha', path: 'playbooks/glimmer.md', kind: 'playbook', header: 'repoalpha › playbooks/glimmer.md › setup', text: 'repoalpha › playbooks/glimmer.md › setup\n1. install the glimmerdrift tool' }];
  const pp = writePack(path.join(tmp(), 'pack'), analyse, { passages, history: history(), recipe, extra: { 'playbooks.sqlite': { role: 'playbooks-db', rows: play } } });
  const hpp = engine.open(pp);
  const rp = engine.search(hpp, 'glimmerdrift', { detail: 'full' });
  engine.close(hpp);
  assert.deepEqual(rp.sections.map((s) => s.name), ['FILES', 'HISTORY', 'PLAYBOOKS']);
  assert.deepEqual(rp.sections[2].items.map((i) => i.path), ['playbooks/glimmer.md']);
  for (const k of [0, 1]) assert.deepEqual(rp.sections[k].items.map((i) => i.path), r.sections[k].items.map((i) => i.path));
});

test('WP1 sections: the whole result is held to the cap when section budgets add up to more', async (t) => {
  const tmp = scratch(t);
  const { analyse, engine } = await engineTree(tmp, 'wp1-sections');
  const base = wp1Recipe();
  const recipe = wp1Recipe({ sections: [{ ...base.sections[0], itemChars: 12000, budgetChars: { brief: 22000, full: 56000 } }, base.sections[1]] });
  const pack = writePack(path.join(tmp(), 'pack'), analyse, { passages: corpus(), history: history(), recipe });
  const h = engine.open(pack);
  t.after(() => engine.close(h));
  for (const [detail, cap] of [['full', 60000], ['brief', 24000]]) {
    const r = engine.search(h, 'glimmerdrift', { detail });
    const n = totalChars(r);
    assert.ok(n <= cap, `${detail} result excerpts total ${n} characters, over the ${cap} cap`);
    assert.ok(n > cap - 2000, `${detail} result was cut far below its cap (${n})`);
    assert.equal(r.sections[0].items.length, 5, 'trimmed, not dropped');
  }
});
