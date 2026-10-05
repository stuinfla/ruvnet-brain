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

describe('issue #139 — scope is resolved, never hardcoded, and every caller shares one answer', () => {
  it('TEETH: the reporter\'s inversion — user scope moves the learner to HOME', async () => {
    const { learnerCwd, learningScope } = await import('../../plugin/scripts/runtime-preferences.mjs');
    const at = { cwd: path.resolve('/proj'), home: path.resolve('/home') };
    expect(learningScope({ ...at, env: {} }), 'project is the default').toBe('project');
    expect(learnerCwd({ ...at, env: {} }), 'default scope reads the project store').toBe(at.cwd);
    // The case that was broken in both directions and is the whole point of the issue.
    expect(learningScope({ ...at, env: { RUVNET_LEARNING_SCOPE: 'user' } })).toBe('user');
    expect(learnerCwd({ ...at, env: { RUVNET_LEARNING_SCOPE: 'user' } }),
      'user scope must read the HOME store, or the console measures one learner and the flush feeds another')
      .toBe(fs.existsSync(at.home) ? fs.realpathSync.native(at.home) : at.home);
  });

  it('an unrecognised scope falls back to project rather than inventing one', async () => {
    const { learningScope } = await import('../../plugin/scripts/runtime-preferences.mjs');
    for (const bad of ['', 'USER', 'global', 'yes', undefined]) {
      expect(learningScope({ cwd: '/proj', env: { RUVNET_LEARNING_SCOPE: bad } })).toBe('project');
    }
  });

});
