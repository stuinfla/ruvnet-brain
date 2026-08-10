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
    expect(block, 'the served project is what process.cwd() names for this server').toMatch(/cwd:\s*process\.cwd\(\)/);
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
