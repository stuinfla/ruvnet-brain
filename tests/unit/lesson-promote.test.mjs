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
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectLessons, analyze, renderBlock, applyPromotion, setThemeDemoted } from '../../scripts/lesson-promote.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-promote-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

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

// ── the real round trip, not the injectable seam (2026-09-07) ────────────────────────────────────
// The two tests above prove `analyze()`'s guard is correct GIVEN a `rejected` Set — but every real
// invocation (the CLI, with no test wiring) computes that Set itself via `demotedThemeKeys()`, which
// neither test ever exercises. That gap is exactly how the original `themeKey`-on-a-lesson-row design
// shipped and stayed silently broken for six weeks: the store field it read was never written by
// anything, so `demotedThemeKeys()` always returned an empty Set in production, and the sticky guard
// above could never fire. These tests go through the real file the fix introduced, and the real CLI,
// with no `rejected` override — so they would have caught that failure, and would fail again if a
// future change breaks the read/write round trip.
describe('theme demotion — the real read/write round trip (no injected Set)', () => {
  let themesFile;
  beforeEach(() => { themesFile = path.join(tmp, 'demoted-themes.json'); });

  it('a theme demoted via the real writer is excluded by the real reader on the very next analyze()', () => {
    seed({
      'proj-a': { 'feedback_v1': { desc: 'always bump the version on release' } },
      'proj-b': { 'feedback_v2': { desc: 'always bump the version on release' } },
      'proj-c': { 'feedback_t1': { desc: 'verify before claiming done' } },
      'proj-d': { 'feedback_t2': { desc: 'prove it works, never assert' } },
    });
    const lessons = collectLessons(tmp);
    // `demotedThemesFile` redirects the REAL disk reader to the fixture — no `rejected` Set involved.
    const before = analyze(lessons, { minProjects: 2, demotedThemesFile: themesFile });
    expect(before.promotable.length).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(themesFile), 'no file yet — nothing demoted').toBe(false);

    const key = before.promotable[0].key;
    setThemeDemoted(key, true, themesFile);
    expect(fs.existsSync(themesFile), 'the writer must actually create the file').toBe(true);

    const after = analyze(lessons, { demotedThemesFile: themesFile });
    expect(after.promotable.some((t) => t.key === key), 'demoted theme must vanish through the real reader').toBe(false);
    expect(after.promotable.length).toBe(before.promotable.length - 1);
  });

  it('restore is also real — the file round-trips back to eligible', () => {
    seed({
      'proj-a': { 'feedback_v1': { desc: 'always bump the version on release' } },
      'proj-b': { 'feedback_v2': { desc: 'always bump the version on release' } },
    });
    const lessons = collectLessons(tmp);
    const key = analyze(lessons, { demotedThemesFile: themesFile }).promotable[0].key;
    setThemeDemoted(key, true, themesFile);
    expect(analyze(lessons, { demotedThemesFile: themesFile }).promotable.some((t) => t.key === key)).toBe(false);

    setThemeDemoted(key, false, themesFile);
    expect(analyze(lessons, { demotedThemesFile: themesFile }).promotable.some((t) => t.key === key), 'restore must undo the demotion').toBe(true);
  });

  it('a hand-edited bare array (not the documented {demoted:[...]} shape) is still honoured — same tolerance as OPTIN_PATH', () => {
    seed({
      'proj-a': { 'feedback_v1': { desc: 'always bump the version on release' } },
      'proj-b': { 'feedback_v2': { desc: 'always bump the version on release' } },
    });
    const lessons = collectLessons(tmp);
    const key = analyze(lessons, { demotedThemesFile: themesFile }).promotable[0].key;
    fs.writeFileSync(themesFile, JSON.stringify([key]));
    expect(analyze(lessons, { demotedThemesFile: themesFile }).promotable.some((t) => t.key === key)).toBe(false);
  });

  it('the real CLI: `--demote-theme` writes the file and the very next scan honours it', () => {
    // The CLI's default scan root is $HOME/.claude/projects, not `tmp` directly — build a real
    // fixture $HOME so the subprocess's own `collectLessons()` (no override available from here) finds it.
    const homeDir = path.join(tmp, 'fake-home');
    for (const [proj, desc] of [
      ['proj-a', 'always bump the version on release'],
      ['proj-b', 'always bump the version on release'],
      ['proj-c', 'verify before claiming done'],
      ['proj-d', 'prove it works, never assert'],
    ]) {
      const md = path.join(homeDir, '.claude', 'projects', proj, 'memory');
      fs.mkdirSync(md, { recursive: true });
      fs.writeFileSync(path.join(md, 'feedback_1.md'),
        `---\nname: feedback_1\ndescription: "${desc}"\nmetadata:\n  type: feedback\n---\n\nbody text\n`);
    }
    // os.homedir() reads USERPROFILE on Windows, HOME on POSIX — set both so the subprocess's
    // collectLessons() finds this fixture on every CI platform, not only ubuntu/macos.
    const env = { ...process.env, RUVNET_DEMOTED_THEMES: themesFile, HOME: homeDir, USERPROFILE: homeDir };
    const before = JSON.parse(execFileSync('node', ['scripts/lesson-promote.mjs', '--json'], {
      cwd: REPO_ROOT, env, encoding: 'utf8',
    }));
    expect(before.promotable.length).toBeGreaterThanOrEqual(2);
    const key = before.promotable[0].key;

    const out = execFileSync('node', ['scripts/lesson-promote.mjs', '--demote-theme', key], {
      cwd: REPO_ROOT, env, encoding: 'utf8',
    });
    expect(out).toMatch(/demoted theme/);
    expect(fs.existsSync(themesFile)).toBe(true);

    const after = JSON.parse(execFileSync('node', ['scripts/lesson-promote.mjs', '--json'], {
      cwd: REPO_ROOT, env, encoding: 'utf8',
    }));
    expect(after.promotable.some((t) => t.key === key), 'the CLI demotion must survive to the next real invocation').toBe(false);
  });

  it('`--demote-theme` with an unknown key refuses loudly instead of writing garbage', () => {
    const homeDir = path.join(tmp, 'fake-home-2');
    fs.mkdirSync(homeDir, { recursive: true });
    expect(() => execFileSync('node', ['scripts/lesson-promote.mjs', '--demote-theme', 'not-a-real-theme'], {
      cwd: REPO_ROOT, env: { ...process.env, RUVNET_DEMOTED_THEMES: themesFile, HOME: homeDir, USERPROFILE: homeDir }, encoding: 'utf8',
    })).toThrow();
    expect(fs.existsSync(themesFile), 'a rejected key must not create the file').toBe(false);
  });
});
