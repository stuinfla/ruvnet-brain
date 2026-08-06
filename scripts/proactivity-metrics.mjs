#!/usr/bin/env node
// proactivity-metrics.mjs — ADR-041 detector-layer recall + false-alarm harness.
//
// Spawns the REAL scripts/capability-registry.mjs (a fresh child, so HOME=<scratch> redirects
// os.homedir() at module load — capability-registry.mjs:60) against a ground-truth scratch machine, and
// scores it against the manifest. It never imports the detector; it runs the real process and reads its
// real JSON, so a bug anywhere in the probe path is in scope — which is the whole point (ADR-028's shipped
// "26 hooks off" lies all lived in that probe path).
//
//   detector-recall      = cohort capabilities the detector reports 'off' on the DORMANT machine
//                          ------------------------------------------------------------------------
//                          cohort capabilities the manifest declares dormant            (target >= 0.80)
//   detector-false-alarm = cohort capabilities the detector reports 'off' on the HEALTHY machine
//                          (target = 0 — a verified-healthy machine must raise no dormancy flag)
//
// The registryPath argument exists so the mutation test can point this at a deliberately-broken copy and
// watch the numbers move — the falsifiability ADR-041 demands (a harness that cannot fall on a broken
// detector is not a measurement).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildState, readManifest } from '../tests/helpers/ground-truth-machine.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// THE PAYLOAD COPY. Since ADR-065 the registry ships inside plugin/scripts/ and `scripts/` holds a
// four-line re-export shim. Pointing this at the shim would still MEASURE correctly (the shim runs
// the same code), but proactivity-detector-mutation.test.mjs reads this path's SOURCE to build its
// mutants — and a shim has no `return row(STATE.OFF, …)` to mutate, so every mutation would change
// nothing. That test throws on exactly that ("the target string moved… this test would otherwise run
// an UNMUTATED copy and pass for the wrong reason"), which is how the move was caught. Name the real
// file so both the measurement and its falsifiability proof read the same bytes.
export const REAL_REGISTRY = path.join(REPO, 'plugin', 'scripts', 'capability-registry.mjs');

/** Run the real detector against a scratch machine; return { key: state } for every row it emitted. */
export function runDetector(home, project, registryPath = REAL_REGISTRY) {
  const res = spawnSync(process.execPath, [registryPath, '--json', '--project', project], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (res.status !== 0 || !res.stdout) {
    throw new Error(`detector exited ${res.status}; stderr: ${String(res.stderr).slice(0, 300)}`);
  }
  const rows = JSON.parse(res.stdout);
  const out = {};
  for (const r of rows) if (r && typeof r.key === 'string') out[r.key] = r.state;
  return out;
}

/**
 * Build both ground-truth machines, run the detector against each, and score. Returns the two headline
 * numbers plus the per-capability detail (for a failing assertion to point at). Cleans up its scratch dirs.
 */
export function measure({ registryPath = REAL_REGISTRY } = {}) {
  const manifest = readManifest();
  const cohort = manifest.cohort;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-'));
  try {
    const dormant = buildState('dormant', path.join(root, 'dormant'));
    const healthy = buildState('healthy', path.join(root, 'healthy'));

    const dormantSeen = runDetector(dormant.home, dormant.project, registryPath);
    const healthySeen = runDetector(healthy.home, healthy.project, registryPath);

    // Recall: of the cohort caps the manifest says are dormant, how many did the detector get RIGHT?
    //
    // BOTH LINES USED TO TEST `=== 'off'`, AND THAT MADE THIS HARNESS BLIND TO STATE.IDLE — the very
    // state added on 2026-07-24 because "off" was too coarse. Two failures came from the one literal:
    //
    //   1. SILENT EXCLUSION. A capability the manifest declares `idle` was filtered out of the
    //      denominator entirely, so adding one to the cohort moved no number and the harness reported
    //      an unchanged, healthy-looking 1.00 while measuring strictly less than before. A metric that
    //      quietly ignores what it cannot classify is worse than one that fails.
    //   2. THE MUTANT SURVIVED. MEASURED: deleting learning-enable's staleness check — the exact bug
    //      fixed hours earlier, where a learner holding 457 trajectories and quiet for 30 days reports
    //      ON — left recall at 1.00 and the gate PASSING. The harness could not fall on the precise
    //      defect the pillar exists to catch.
    //
    // EXACT MATCH, not merely "some dormant state", is the bar. A detector answering `off` for an idle
    // capability HAS noticed the dormancy, but it is still wrong in the way that costs the user: OFF
    // points at `turnOn`, which is how "turn this on" got printed beside 457 already-learned patterns.
    // Distinguishing them is the entire reason IDLE was introduced, so the metric must require it.
    const DORMANT_STATES = new Set(['off', 'idle']);
    const dormantKeys = cohort.filter((k) => DORMANT_STATES.has(manifest.states.dormant[k]));
    const recalled = dormantKeys.filter((k) => dormantSeen[k] === manifest.states.dormant[k]);
    const recall = dormantKeys.length ? recalled.length / dormantKeys.length : 1;

    // False alarm: of the cohort, how many did the detector call DORMANT on the HEALTHY machine?
    // `idle` counts here too — telling a user that a working capability has gone quiet is the same
    // broken promise as calling it off, and ADR-028 is explicit that one false alarm costs more trust
    // than ten true ones earn.
    const falseAlarms = cohort.filter((k) => DORMANT_STATES.has(healthySeen[k]));

    return {
      recall,
      falseAlarmCount: falseAlarms.length,
      cohort,
      dormantSeen: Object.fromEntries(cohort.map((k) => [k, dormantSeen[k]])),
      healthySeen: Object.fromEntries(cohort.map((k) => [k, healthySeen[k]])),
      // DERIVED from `recalled`, never restated. It used to carry its own `!== 'off'` predicate, and
      // when the recall rule above was corrected for STATE.IDLE this line kept the old one — so the
      // CLI printed "PASS — recall 1.00" while the test reading missedDormant on the same run saw a
      // miss. Two independent definitions of one fact will always drift; the reported number and the
      // list explaining it must come from the same comparison or one of them is lying.
      missedDormant: dormantKeys.filter((k) => !recalled.includes(k)),
      falseAlarms,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith('proactivity-metrics.mjs');
if (invokedDirectly) {
  const m = measure();
  console.log(JSON.stringify({ recall: m.recall, falseAlarmCount: m.falseAlarmCount,
    dormant: m.dormantSeen, healthy: m.healthySeen }, null, 2));
  const ok = m.recall >= 0.80 && m.falseAlarmCount === 0;
  console.log(ok ? `\nPASS — recall ${m.recall.toFixed(2)} (>=0.80), false-alarm ${m.falseAlarmCount} (=0)`
    : `\nFAIL — recall ${m.recall.toFixed(2)}, false-alarm ${m.falseAlarmCount}; missed=${JSON.stringify(m.missedDormant)} falseAlarms=${JSON.stringify(m.falseAlarms)}`);
  process.exit(ok ? 0 : 1);
}
