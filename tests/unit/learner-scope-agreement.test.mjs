import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ISSUE #136 — three files disagreed about WHICH LEARNER they meant.
 *
 * `ruflo hooks intelligence --status` reports `Data Dir: <cwd>/.claude-flow/neural`, so the learner is
 * PROJECT-SCOPED. Measured on one machine in one minute:
 *
 *     ~/.claude-flow/neural          3,167 trajectories · last trained 10.2 DAYS ago   ← what the card read
 *     <project>/.claude-flow/neural 13,607 trajectories · last trained  3.7 days ago   ← the live one
 *
 * So the console reported "Your learner has gone quiet" about a store nothing writes to, while the
 * served project's learner held four times the data. And the REMEDY trained `$HOME` — the store the
 * card does not read — so its own button could never clear the finding it was offered for.
 *
 * This is #104 ("it measures one queue and drains another") and #134 (cwd drift) arriving a third
 * time, in a third file. `onboarding-console.mjs` already carries the verdict on this exact mistake
 * at its refresh-child spawn: *"cwd = the SERVED project, NOT REPO … it was a real console-honesty
 * bug"*. Same rule, same file, different call site.
 *
 * The property is agreement: reader, remedy and label must all mean the served project. Asserted in
 * source because the alternative — spawning `ruflo` three ways — measures one laptop's stores rather
 * than the product's wiring.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The spawn options for the learner call in a file — the block that decides which store is read. */
function learnerSpawnBlock(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  return src.slice(i, i + 600).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

describe('issue #136 — reader, remedy and label all mean the SERVED project', () => {
  it('the console probes the learner in the served project, never $HOME', () => {
    const src = read('scripts/onboarding-console.mjs');
    const block = learnerSpawnBlock(src, "['hooks', 'intelligence', '--status']");
    expect(block, 'sanity: the learner probe must still exist').toBeTruthy();
    expect(block, 'cwd: SYSTEM_HOME reads a store nothing writes to').not.toMatch(/cwd:\s*SYSTEM_HOME/);
    // SUPERSEDED BY #139: this line used to require `cwd: process.cwd()`. That was #136's fix, and
    // @ObiWanKenobi correctly identified it as a hardcode in the opposite direction — right only
    // because `project` is the default, and inverted under RUVNET_LEARNING_SCOPE=user. The contract
    // is now RESOLUTION, not a particular hardcode, so the assertion moved with it. A test pinning
    // a hardcode is a test that defends the bug.
    expect(block, 'the learner cwd must be RESOLVED from the configured scope (#139)').toMatch(/learnerCwd\(/);
  });

  it('TEETH: the remedy trains the SAME store the card reads', () => {
    // The load-bearing half. If the card reads the project and the button trains $HOME, the finding
    // is unclearable by its own remedy — the user presses it, nothing changes, and the console has
    // taught them to distrust it.
    const src = read('scripts/health-repair.mjs');
    const block = learnerSpawnBlock(src, "['hooks', 'intelligence', '--train']");
    expect(block, 'sanity: the training remedy must still exist').toBeTruthy();
    expect(block, 'cwd: HOME cannot clear a project-scoped finding').not.toMatch(/cwd:\s*HOME\b/);
    expect(block).toMatch(/cwd:\s*PROJECT\b/);
    // …and PROJECT must be the same rule learn-flush and learn-capture resolve (#134).
    expect(src).toMatch(/const PROJECT = process\.env\.RUVNET_BRAIN_PROJECT_DIR \|\| process\.cwd\(\)/);
  });

  it('the label does not claim account scope for a project-scoped reading', () => {
    const src = read('scripts/console-engine.mjs');
    const i = src.indexOf('learning:train');
    expect(i, 'sanity: the recommendation must still exist').toBeGreaterThan(-1);
    expect(src.slice(i, i + 700), '"every project · your account" over a project reading is a false claim')
      .not.toMatch(/scope:\s*'user'/);
  });

  it('TEETH: the detector fires on the shapes that shipped broken', () => {
    // Without this the three assertions above could pass against any file that simply lacks the
    // marker — a rename would make them vacuous rather than red.
    const broken = "spawnSync(ruflo,\n  ['hooks', 'intelligence', '--status'],\n  { cwd: SYSTEM_HOME }";
    expect(learnerSpawnBlock(broken, "['hooks', 'intelligence', '--status']")).toMatch(/cwd:\s*SYSTEM_HOME/);
    expect(learnerSpawnBlock('nothing here', "['hooks', 'intelligence', '--status']")).toBe('');
  });
});

/**
 * ISSUE #139 (@ObiWanKenobi) — #136's FIX WAS A HARDCODE IN THE OPPOSITE DIRECTION.
 *
 * #136 read the learner with `cwd: SYSTEM_HOME`; the fix changed it to `cwd: process.cwd()`. In the
 * reporter's words: "Both are hardcodes. Neither asks which scope is actually in effect...
 * `process.cwd()` happens to be correct only because `project` is the default. Set
 * `RUVNET_LEARNING_SCOPE=user` and the bug inverts: the flush feeds `~/.claude-flow/neural` while
 * the console reads `<project>/.claude-flow/neural`. Same card, same false positive, opposite
 * direction."
 *
 * He also flagged the hazard that makes it newly dangerous rather than merely wrong: ruflo v3.38.9
 * made `hooks intelligence --train` REAL (ruvnet/ruflo#2940 was a no-op). A remedy that trains the
 * wrong store now MOVES that store's lastAdaptation to 0s, so the stale card silently self-clears
 * while the learner the operator actually uses is untouched. Previously the same mistake was
 * harmless: the button did nothing and the card stayed up.
 *
 * The tests above assert the SHAPE of three files. These assert the BEHAVIOUR of the one resolver
 * they now share, in both scopes — because agreement by coincidence is what #104, #134, #136 and
 * now #139 have each been.
 */
describe('issue #139 — scope is resolved, never hardcoded, and every caller shares one answer', () => {
  it('TEETH: the reporter\'s inversion — user scope moves the learner to HOME', async () => {
    const { learnerCwd, learningScope } = await import('../../plugin/scripts/runtime-preferences.mjs');
    const at = { cwd: '/proj', home: '/home' };
    expect(learningScope({ ...at, env: {} }), 'project is the default').toBe('project');
    expect(learnerCwd({ ...at, env: {} }), 'default scope reads the project store').toBe('/proj');
    // The case that was broken in both directions and is the whole point of the issue.
    expect(learningScope({ ...at, env: { RUVNET_LEARNING_SCOPE: 'user' } })).toBe('user');
    expect(learnerCwd({ ...at, env: { RUVNET_LEARNING_SCOPE: 'user' } }),
      'user scope must read the HOME store, or the console measures one learner and the flush feeds another')
      .toBe('/home');
  });

  it('an unrecognised scope falls back to project rather than inventing one', async () => {
    const { learningScope } = await import('../../plugin/scripts/runtime-preferences.mjs');
    for (const bad of ['', 'USER', 'global', 'yes', undefined]) {
      expect(learningScope({ cwd: '/proj', env: { RUVNET_LEARNING_SCOPE: bad } })).toBe('project');
    }
  });

  it('TEETH: no learner call site hardcodes a cwd any more — all three call the resolver', () => {
    // The durable half. A shared resolver that two of three callers ignore is exactly the state
    // #139 describes, so the check is on ADOPTION, not availability.
    const sites = [
      ['scripts/onboarding-console.mjs', "['hooks', 'intelligence', '--status']"],
      ['scripts/health-repair.mjs', "['hooks', 'intelligence', '--train']"],
    ];
    for (const [rel, marker] of sites) {
      const src = read(rel);
      const i = src.indexOf(marker);
      expect(i, `${rel}: the call must still exist`).toBeGreaterThan(-1);
      const block = src.slice(i, i + 400);
      expect(block, `${rel} must resolve the learner cwd, not hardcode it`).toMatch(/learnerCwd\(/);
      expect(block, `${rel} must not pin SYSTEM_HOME or a bare process.cwd()`)
        .not.toMatch(/cwd:\s*(SYSTEM_HOME|process\.cwd\(\))/);
    }
    // …and the WRITER resolves through the same module, so all three agree by construction.
    expect(read('plugin/scripts/learn-flush.mjs')).toMatch(/learningScope\(\{ cwd: PROJECT \}\)/);
  });
});
