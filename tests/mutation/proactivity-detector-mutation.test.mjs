// ADR-041 mutation tests — the falsifiability proof.
//
// "A test that cannot fail on broken code is not a test" (house rule). A recall/false-alarm number from
// a fixture is only admissible if it FALLS when the detector is broken. Here we take the REAL
// capability-registry.mjs, apply ONE targeted mutation, run the same harness against the mutant, and
// assert the number moves the way a real defect would move it. Each mutation also asserts it changed
// something (mutant !== original), so a refactor that relocates the target string fails LOUDLY rather
// than silently running an unmutated copy.
//
// The mutant is written INTO plugin/scripts/ (its relative sibling imports resolve there) with a name that
// ends in "capability-registry.mjs" (so its own invokedDirectly CLI guard fires — registry.mjs:687), and is
// removed in a finally + afterEach. It moved from scripts/ to plugin/scripts/ with the registry itself
// (ADR-065): the mutant must sit beside the REAL nightly-controller/hook-registry/memory-doctor it
// statically and lazily imports, not beside the re-export shims that now stand at the old path.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, REAL_REGISTRY } from '../../scripts/proactivity-metrics.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MUTANT = path.join(REPO, 'plugin', 'scripts', '_mutant-capability-registry.mjs');

function withMutant(mutate, fn) {
  const src = fs.readFileSync(REAL_REGISTRY, 'utf8');
  const mutated = mutate(src);
  if (mutated === src) {
    throw new Error('mutation changed nothing — the target string moved. This test would otherwise run an UNMUTATED copy and pass for the wrong reason.');
  }
  fs.writeFileSync(MUTANT, mutated);
  try { return fn(); } finally { fs.rmSync(MUTANT, { force: true }); }
}

afterEach(() => { try { fs.rmSync(MUTANT, { force: true }); } catch { /* best effort */ } });

describe('ADR-041 mutation — the harness must fall on a broken detector', () => {
  it('baseline: the TRUE detector scores recall 1.00, false-alarm 0', () => {
    const m = measure();
    expect(m.recall).toBe(1);
    expect(m.falseAlarmCount).toBe(0);
  });

  // capability-registry.mjs:571 — the no-hook branch that reports a dormant session-capture as OFF.
  it('FALSE-NEGATIVE mutant (session-capture OFF -> UNKNOWN) drops recall below the 0.80 bar', () => {
    withMutant(
      (s) => s.replace(
        "return row(STATE.OFF, 'no hook that saves session state is registered at either boundary",
        "return row(STATE.UNKNOWN, 'no hook that saves session state is registered at either boundary"),
      () => {
        const m = measure({ registryPath: MUTANT });
        expect(m.dormantSeen['session-capture']).not.toBe('off');   // detector now blind to this dormancy
        expect(m.recall).toBeLessThan(0.80);                        // 1/2 = 0.50 — acceptance test would REJECT
      });
  });

  // capability-registry.mjs:569 — the both-boundaries branch that reports a healthy session-capture as ON.
  it('FALSE-POSITIVE mutant (session-capture ON -> OFF) makes false-alarm nonzero — proving 0 is a measurement, not a tautology', () => {
    withMutant(
      (s) => s.replace('if (pre && end) return row(STATE.ON,', 'if (pre && end) return row(STATE.OFF,'),
      () => {
        const m = measure({ registryPath: MUTANT });
        expect(m.healthySeen['session-capture']).toBe('off');       // healthy machine wrongly flagged
        expect(m.falseAlarmCount).toBeGreaterThanOrEqual(1);        // zero-alarm gate would REJECT
      });
  });
});
