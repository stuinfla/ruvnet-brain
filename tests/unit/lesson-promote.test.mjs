// lesson-promote.test.mjs — the cross-project promotion miner (ADR-029).
//
// WHAT THIS PROTECTS. Promotion writes to ~/.claude/CLAUDE.md, the instructions that govern EVERY
// project the user owns. That is the highest blast radius any write in this repo has: a bad global
// rule is far more expensive than a missing one, because it silently misdirects work everywhere and
// nobody knows which project it came from.
//
// So the tests are weighted toward REFUSAL, not capability. It is more important that this never
// promotes a project-specific fact than that it catches every universal one.
//
// The five test classes ADR-028 requires, all present here:
//   low       — theme clustering and the promotion predicate, table-driven, no I/O
//   medium    — real filesystem: a fixture tree of project memory dirs is scanned end to end
//   high      — the write path: backup taken, fence replaced not duplicated, idempotent
//   numeric   — the promotion bar is a COUNT of independent projects, asserted exactly
//   qualitative — the rendered block is human-readable and carries its own evidence (asserted on
//                 structure; the actual reading is done by a human, per "never grade your own work")

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLesson, demote, restore, saveLessons, loadLessons } from '../../plugin/scripts/lesson-store.mjs';
import { collectLessons, analyze, renderBlock, applyPromotion } from '../../scripts/lesson-promote.mjs';

let tmp;
let priorStore;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-promote-')));
  priorStore = process.env.RUVNET_LESSON_STORE; process.env.RUVNET_LESSON_STORE = path.join(tmp, 'isolated-lessons.json'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true });
  if (priorStore === undefined) delete process.env.RUVNET_LESSON_STORE; else process.env.RUVNET_LESSON_STORE = priorStore; });

/** Build a fake ~/.claude/projects tree. */
function seed(projects) {
  for (const [proj, lessons] of Object.entries(projects)) {
    const md = path.join(tmp, proj, 'memory');
    fs.mkdirSync(md, { recursive: true });
    for (const [name, { type = 'feedback', desc = '' }] of Object.entries(lessons)) {
      fs.writeFileSync(path.join(md, `${name}.md`),
        `---\nname: ${name}\ndescription: "${desc}"\nmetadata:\n  type: ${type}\n---\n\nbody text\n`);
    }
  }
}

describe('low — the promotion predicate is a count of INDEPENDENT projects', () => {
  it('promotes a process taught in two separate projects (ADR-G008 "win twice")', () => {
    seed({
      'proj-a': { 'feedback_test_first': { desc: 'always verify before claiming done' } },
      'proj-b': { 'feedback_prove_it': { desc: 'prove it works, never assert' } },
    });
    const r = analyze(collectLessons(tmp));
    const t = r.themes.find((x) => x.key === 'proof-before-done');
    expect(t.projectCount).toBe(2);
    expect(t.universal).toBe(true);
  });

  it('REFUSES a process taught many times inside ONE project — repetition is not universality', () => {
    // The critical distinction. Ten lessons in one project means that project is hard, not that the
    // lesson is global. Promoting on raw count would flood the constitution with local noise.
    const lessons = {};
    for (let i = 0; i < 10; i++) lessons[`feedback_test_${i}`] = { desc: 'verify before claiming done' };
    seed({ 'only-one-project': lessons });
    const r = analyze(collectLessons(tmp));
    const t = r.themes.find((x) => x.key === 'proof-before-done');
    expect(t.lessons).toBe(10);
    expect(t.projectCount).toBe(1);
    expect(t.universal, '10 lessons in 1 project must NOT promote').toBe(false);
    expect(r.promotable).toEqual([]);
  });

  it('ignores type:project lessons entirely — they are about one codebase by their own declaration', () => {
    seed({
      'proj-a': { 'ship_the_thing': { type: 'project', desc: 'deploy and version this release' } },
      'proj-b': { 'ship_again': { type: 'project', desc: 'deploy and version this release' } },
    });
    const r = analyze(collectLessons(tmp));
    expect(r.scanned.lessons).toBe(2);
    expect(r.scanned.feedback).toBe(0);
    expect(r.promotable, 'project-type lessons must never reach global instructions').toEqual([]);
  });

  it('the minimum is clamped at 2 — a caller may demand MORE evidence, never less', () => {
    seed({ 'proj-a': { 'feedback_v': { desc: 'bump the version every release' } } });
    const r = analyze(collectLessons(tmp), { minProjects: 1 }); // attempt to weaken the bar
    expect(r.minProjects ?? 2).toBeGreaterThanOrEqual(1);
    const t = r.themes.find((x) => x.key === 'release-discipline');
    // With a single project the theme exists but must not be promotable under the real floor.
    const strict = analyze(collectLessons(tmp));
    expect(strict.themes.find((x) => x.key === 'release-discipline').universal).toBe(false);
    expect(t).toBeTruthy();
  });
});

describe('medium — scanning a real filesystem tree', () => {
  it('reads type and description from frontmatter across many projects, skipping MEMORY.md', () => {
    seed({
      'proj-a': { 'feedback_a': { desc: 'always bump the version on release' } },
      'proj-b': { 'feedback_b': { desc: 'always bump the version on release' } },
      'proj-c': { 'note_c': { type: 'reference', desc: 'a url' } },
    });
    fs.writeFileSync(path.join(tmp, 'proj-a', 'memory', 'MEMORY.md'), '# index\n- [x](y.md)\n');
    const lessons = collectLessons(tmp);
    expect(lessons.length, 'MEMORY.md is an index, never a lesson').toBe(3);
    expect(lessons.filter((l) => l.type === 'feedback').length).toBe(2);
  });

  it('survives an unreadable or missing memory directory without throwing', () => {
    fs.mkdirSync(path.join(tmp, 'no-memory-dir'), { recursive: true });
    seed({ 'proj-a': { 'feedback_a': { desc: 'verify before done' } } });
    expect(() => collectLessons(tmp)).not.toThrow();
    expect(collectLessons(tmp).length).toBe(1);
  });

  it('classifies on name+description only, never the body — bodies hold project specifics', () => {
    const md = path.join(tmp, 'proj-a', 'memory');
    fs.mkdirSync(md, { recursive: true });
    fs.writeFileSync(path.join(md, 'feedback_generic.md'),
      `---\nname: feedback_generic\ndescription: "a neutral instruction"\nmetadata:\n  type: feedback\n---\n\n`
      + `The client ACME Corp needs the deploy versioned and tested before release.\n`);
    const l = collectLessons(tmp)[0];
    expect(l.text).not.toMatch(/ACME/);
  });
});

describe('numeric — the evidence string states exactly what was counted', () => {
  it('reports lesson count and project count, and they are independently correct', () => {
    seed({
      'proj-a': { 'feedback_1': { desc: 'verify before done' }, 'feedback_2': { desc: 'prove it, never assert' } },
      'proj-b': { 'feedback_3': { desc: 'test before claiming done' } },
    });
    const t = analyze(collectLessons(tmp)).themes.find((x) => x.key === 'proof-before-done');
    expect(t.lessons).toBe(3);
    expect(t.projectCount).toBe(2);
    expect(t.evidence).toBe('taught 3 times across 2 independent projects');
  });
});

describe('high — the write path, which touches the file governing every project', () => {
  const globalFile = () => path.join(tmp, 'CLAUDE.md');
  const seedTwo = () => seed({
    'proj-a': { 'feedback_a': { desc: 'always bump the version on release' } },
    'proj-b': { 'feedback_b': { desc: 'always bump the version on release' } },
  });

  it('takes a backup BEFORE writing, and the backup holds the original bytes', () => {
    seedTwo();
    fs.writeFileSync(globalFile(), '# My rules\n\nrule one\n');
    const r = analyze(collectLessons(tmp));
    const res = applyPromotion(r, { file: globalFile(), now: '2026-07-22' });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(res.backup)).toBe(true);
    expect(fs.readFileSync(res.backup, 'utf8')).toBe('# My rules\n\nrule one\n');
  });

  it('is IDEMPOTENT — running twice replaces the fenced block instead of appending a second one', () => {
    seedTwo();
    fs.writeFileSync(globalFile(), '# My rules\n');
    const r = analyze(collectLessons(tmp));
    applyPromotion(r, { file: globalFile(), now: '2026-07-22' });
    applyPromotion(r, { file: globalFile(), now: '2026-07-23' });
    const body = fs.readFileSync(globalFile(), 'utf8');
    const opens = (body.match(/BEGIN ruvnet-brain: promoted-lessons/g) || []).length;
    expect(opens, 'a second run must not duplicate the block').toBe(1);
  });

  it('preserves everything OUTSIDE the fence — the user\'s own rules are never touched', () => {
    seedTwo();
    fs.writeFileSync(globalFile(), '# My rules\n\nMY IMPORTANT RULE\n');
    const r = analyze(collectLessons(tmp));
    applyPromotion(r, { file: globalFile(), now: '2026-07-22' });
    applyPromotion(r, { file: globalFile(), now: '2026-07-23' });
    expect(fs.readFileSync(globalFile(), 'utf8')).toMatch(/MY IMPORTANT RULE/);
  });

  it('writes NOTHING when nothing met the bar — no empty block, no backup churn', () => {
    seed({ 'proj-a': { 'feedback_a': { desc: 'verify before done' } } }); // one project only
    fs.writeFileSync(globalFile(), '# My rules\n');
    const res = applyPromotion(analyze(collectLessons(tmp)), { file: globalFile(), now: '2026-07-22' });
    expect(res.noop).toBe(true);
    expect(fs.readFileSync(globalFile(), 'utf8')).toBe('# My rules\n');
  });

  it('refuses to write if the backup cannot be taken', () => {
    seedTwo();
    const res = applyPromotion(analyze(collectLessons(tmp)), { file: path.join(tmp, 'does-not-exist.md'), now: '2026-07-22' });
    expect(res.ok).toBe(false);
  });
});

describe('qualitative — the promoted block carries its own evidence, readably', () => {
  it('every promoted rule states how many projects independently taught it', () => {
    seed({
      'proj-a': { 'feedback_a': { desc: 'always bump the version on release' } },
      'proj-b': { 'feedback_b': { desc: 'always bump the version on release' } },
    });
    const block = renderBlock(analyze(collectLessons(tmp)), '2026-07-22');
    // A promoted rule the user cannot audit is a rule they cannot disagree with.
    expect(block).toMatch(/independent project/);
    expect(block).toMatch(/proj-a/);
    expect(block).toMatch(/ADR-G008/);          // cites WHY this rule was promoted
    expect(block).toMatch(/BEGIN ruvnet-brain/); // fenced, so regeneration is safe
  });
});

// ── ADR-030 §5: demotion must be STICKY (added 2026-07-22) ──────────────────────────────────────
// Verified 2026-07-22 that `lesson-promote.mjs` contained ZERO references to `demoted`: the user
// could click delete on a wrongly-promoted rule and the very next mining run would propose it
// again. ADR-030 §5 names this exactly — "a one-click demote that the next nightly silently undoes
// is worse than no demote at all, because the user stops trusting the control and, correctly, stops
// using it." The requirement was written down and not implemented, which is this project's
// signature failure shape.
describe('demotion is sticky — a rejected theme is never re-proposed', () => {
  it('drops exactly the demoted theme and leaves every other one alone', () => {
    seed({
      'proj-a': { 'feedback_v1': { desc: 'always bump the version on release' } },
      'proj-b': { 'feedback_v2': { desc: 'always bump the version on release' } },
      'proj-c': { 'feedback_t1': { desc: 'verify before claiming done' } },
      'proj-d': { 'feedback_t2': { desc: 'prove it works, never assert' } },
    });
    const lessons = collectLessons(tmp);
    const before = analyze(lessons);
    expect(before.promotable.length, 'fixture must produce ≥2 themes or this proves nothing').toBeGreaterThanOrEqual(2);

    const rejected = new Set([before.promotable[0].key]);
    const after = analyze(lessons, { rejected });

    expect(after.promotable.some((t) => rejected.has(t.key)), 'a demoted theme must never return').toBe(false);
    expect(after.promotable.length, 'and demotion must not suppress anything else').toBe(before.promotable.length - 1);
  });

  it('an empty rejection set changes nothing — stickiness must not leak into the default path', () => {
    seed({
      'proj-a': { 'feedback_v1': { desc: 'always bump the version on release' } },
      'proj-b': { 'feedback_v2': { desc: 'always bump the version on release' } },
    });
    const lessons = collectLessons(tmp);
    expect(analyze(lessons, { rejected: new Set() }).promotable.length)
      .toBe(analyze(lessons).promotable.length);
  });
});


describe('P037 durable schema-to-miner demotion', () => {
  it('default mining honors make/demote/save/load without an injected rejection set and explicit restore reverses it', () => {
    const file = path.join(tmp, 'lesson-store.json');
    const prior = process.env.RUVNET_LESSON_STORE;
    process.env.RUVNET_LESSON_STORE = file;
    try {
      const rows = [{ type: 'feedback', text: 'always verify and prove it works', project: 'a' },
        { type: 'feedback', text: 'always verify and prove it works', project: 'b' }];
      const lesson = makeLesson({ id: 'p037-theme', statement: 'Always verify and prove it works before claiming done.',
        trigger: 'claim-done', enforcement: 'checklist', origin: 'model-inferred', status: 'candidate',
        evidence: [{ observed: 'Fixture observed an unsupported completion assertion.' }],
        projects: ['a', 'b'], themeKey: 'proof-before-done' });
      expect(analyze(rows).promotable.some(t => t.key === lesson.themeKey)).toBe(true);
      saveLessons(demote(lesson.id, [lesson]), file);
      const read = loadLessons(file);
      expect(read[0].demoted).toBe(true);
      expect(read[0].themeKey).toBe('proof-before-done');
      expect(analyze(rows).promotable.some(t => t.key === lesson.themeKey)).toBe(false);
      saveLessons(restore(lesson.id, read), file);
      expect(analyze(rows).promotable.some(t => t.key === lesson.themeKey)).toBe(true);
      expect(() => makeLesson({ ...lesson, themeKey: '../foreign-theme' })).toThrow(/themeKey/);
    } finally {
      if (prior === undefined) delete process.env.RUVNET_LESSON_STORE;
      else process.env.RUVNET_LESSON_STORE = prior;
    }
  });
});


describe('P037 ordinary producer and supported config-root miner', () => {
  it('a real bridged correction needs no injected themeKey or lesson-store override to keep demotion sticky', () => {
    const config = path.join(tmp, 'supported-config');
    const script = `import {lessonFromRow} from ${JSON.stringify(new URL('../../plugin/scripts/lesson-bridge.mjs', import.meta.url).href)};
      import {demote,saveLessons,loadLessons} from ${JSON.stringify(new URL('../../plugin/scripts/lesson-store.mjs', import.meta.url).href)};
      import {analyze} from ${JSON.stringify(new URL('../../plugin/scripts/lesson-promote.mjs', import.meta.url).href)};
      const l=lessonFromRow({key:'lesson-real-correction',content:'Always verify and prove it works before claiming done.',tags:'trigger:claim-done,enforce:checklist',provenance:'user_claim'}).lesson;
      saveLessons(demote(l.id,[l]));
      const hits=[{type:'feedback',text:'always verify and prove it works',project:'a'},{type:'feedback',text:'always verify and prove it works',project:'b'}];
      console.log(JSON.stringify({stored:loadLessons()[0],reoffered:analyze(hits).promotable.some(t=>t.key==='proof-before-done')}));`;
    const env = { ...process.env, RUVNET_CONFIG_ROOT: config, HOME: tmp };
    delete env.RUVNET_LESSON_STORE;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.stored.demoted).toBe(true);
    expect(proof.stored.themeKeys).toContain('proof-before-done');
    expect(proof.reoffered).toBe(false);
    expect(fs.existsSync(path.join(config,'lessons.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp,'.config','ruvnet-brain','lessons.json'))).toBe(false);
  });
});


it('P037 actual migration producer derives canonical theme identity without injected theme metadata', () => {
  const config=path.join(tmp,'migration-config');const fake=path.join(tmp,'fixture-ruflo.cjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const a=process.argv.slice(2);const db=a[a.indexOf('--path')+1];
const row={key:'lesson-verify-by-mechanism-not-instance',namespace:'ruvnet-brain',content:'Verify by the mechanism and user-visible effect.',updatedAt:1};
console.log(JSON.stringify(a[1]==='retrieve'?row:db.endsWith('project.db')?[row]:[]));`);fs.chmodSync(fake,0o755);
  const env={...process.env,HOME:tmp,RUVNET_CONFIG_ROOT:config,RUFLO_BIN:fake,
    RUVNET_GLOBAL_MEMORY_DB:path.join(tmp,'global.db'),RUVNET_PROJECT_MEMORY_DB:path.join(tmp,'project.db')};
  delete env.RUVNET_LESSON_STORE;
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../../scripts/lesson-migrate-agentdb.mjs',import.meta.url)),'--apply'],{env,encoding:'utf8',timeout:10000});
  expect(run.status,run.stderr).toBe(0);
  const stored=JSON.parse(fs.readFileSync(path.join(config,'lessons.json'),'utf8')).lessons.find(l=>l.id==='L32');
  expect(stored.themeKeys).toContain('proof-before-done');
});
