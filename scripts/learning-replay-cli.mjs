import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadLessons, saveLessons } from './lesson-store.mjs';
import {
  EXIT,
  INVARIANT,
  MUTANTS,
  MUTANT_RESULT_FILES,
  PORTFOLIO_RESULT_FILES,
  TRAP,
  VERDICT,
  WRONG_SUBCOMMAND_COMMAND,
  aggregate,
  trapSpec,
  verdictForRun,
} from './learning-replay-contract.mjs';
import { verifyPostTaskContract, verifyRufloFlag } from './learning-replay-execution.mjs';
import {
  allocateRunBase,
  buildFixtures,
  nightlyRefresh,
  recordInProjectA,
  removeFixture,
  runArm,
  seedProjectBMemory,
} from './learning-replay-fixture.mjs';
import {
  checkArtifact,
  checkMutantArtifacts,
  checkPortfolio,
  checkSourceIdentity,
  cleanupFixtureDaemons,
  pruneArchive,
  writeArtifact,
} from './learning-replay-proof.mjs';
import { ROOT } from './learning-replay-contract.mjs';
import { GPT_5_6_SOL_ID } from './review-model-defaults.mjs';

const usage = () => `Usage:
  node scripts/learning-replay.mjs [--trap ${TRAP.MEMORY_SEARCH}|${TRAP.POST_TASK}] [--n N] [--host codex|claude-code] [--model MODEL]
  node scripts/learning-replay.mjs --check
  node scripts/learning-replay.mjs --check-portfolio [--tolerate-stale]
  node scripts/learning-replay.mjs --measure-portfolio --host codex --model MODEL
  node scripts/learning-replay.mjs --check-mutants
  node scripts/learning-replay.mjs --check-wire      (token-free; needs the global ruflo)
  node scripts/learning-replay.mjs --dry-run
  node scripts/learning-replay.mjs --mutant <${Object.keys(MUTANTS).join('|')}>

Exit: 0=PASS, 1=FAIL, 3=INCONCLUSIVE, 4=UNKNOWN. --tolerate-stale exits 0 for an UNKNOWN caused only by
out-of-date evidence (load-bearing files changed since it was measured, or past the age limit) and prints
STALE-TOLERATED, and only when every trap and mutant artifact still verifies and recomputes to its expected
result; every FAIL, INCONCLUSIVE and other UNKNOWN in any artifact keeps its exit code.`;

function parse(argv) {
  const has = (flag) => argv.includes(flag);
  const arg = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return { has, arg };
}

// Fire project B's prompt hook exactly as each host registers it: Claude through hook-shim.mjs
// (plugin/hooks/hooks.json), Codex through the Brain home's stable codex-hook.mjs wrapper. The user's
// nudge setting and the runtime's test seams are pinned to the DEFAULT install, so an ambient
// RUVNET_STOP_NUDGES=full on the measuring machine can never hide a regression that every user has.
export function wireOutput(dirs, spec, stateDir, host = 'claude-code') {
  const argv = host === 'codex'
    ? [path.join(dirs.brainHome, 'codex-hook.mjs'), 'unprompted-speech', 'UserPromptSubmit']
    : [path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs'), 'unprompted-speech', 'UserPromptSubmit'];
  const env = {
    ...process.env,
    RUVNET_BRAIN_HOME: dirs.brainHome,
    RUVNET_BRAIN_STATE_DIR: stateDir,
    RUVNET_CONFIG_ROOT: path.join(dirs.base, 'config'),
    RUVNET_LESSON_STORE: dirs.lessons,
    RUVNET_LESSON_GATE_STATE: dirs.gateState,
    CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
    RUVNET_STOP_NUDGES: '',
  };
  for (const seam of ['RUVNET_UNPROMPTED_CHANNELS', 'RUVNET_UNPROMPTED_PRODUCERS', 'RUVNET_REPLAY_SEQUENCE_FILE']) delete env[seam];
  const result = spawnSync(process.execPath, argv, {
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: spec.prompt,
      session_id: `wire-${Date.now()}`,
      cwd: dirs.projectB,
    }),
    encoding: 'utf8',
    cwd: dirs.projectB,
    timeout: 60_000,
    env,
  });
  return result.stdout || '';
}

const wireProbe = (dirs, spec, stateDir) => wireOutput(dirs, spec, stateDir).length;

// THE TOKEN-FREE HALF OF D4, measured on every schedule. No model is called, so this does NOT prove a
// model changed its behaviour (that is --check-portfolio, priced in tokens). It proves the brain's half
// of the loop on the current code with the real global ruflo: a lesson recorded independently in two
// projects is promoted, survives a refresh, and reaches project B's prompt on BOTH hosts — while the
// brain-off control never receives it and deleting the lesson removes it (the causal mutant).
export function checkWire({ fire = wireOutput, premise = verifyRufloFlag, hosts = ['claude-code', 'codex'] } = {}) {
  const ruflo = premise();
  if (!ruflo.ok) return { status: VERDICT.UNKNOWN, why: `ruflo premise not verified: ${ruflo.why}` };
  const checked = [];
  for (const trap of [TRAP.MEMORY_SEARCH, TRAP.POST_TASK]) {
    const spec = trapSpec(trap);
    const probe = spec.lesson.slice(0, 60);
    const base = allocateRunBase();
    const dirs = buildFixtures(base);
    try {
      const record = recordInProjectA(dirs, { trap });
      if (!record.sources.every((source) => source.recorded)) {
        return { status: VERDICT.UNKNOWN, why: `${trap}: ruflo could not record the lesson in project A`, checked };
      }
      if (!record.ok || !record.promoted) return { status: VERDICT.FAIL, why: `${trap}: lesson was not promoted across two projects`, checked };
      const refresh = nightlyRefresh(dirs);
      if (!refresh.lessonSurvived) return { status: VERDICT.FAIL, why: `${trap}: lesson did not survive refresh`, checked };
      for (const host of hosts) {
        if (fire(dirs, spec, dirs.stateOff, host).includes(probe)) {
          return { status: VERDICT.INCONCLUSIVE, why: `${trap}/${host}: the brain-off control also received the lesson`, checked };
        }
        if (!fire(dirs, spec, dirs.stateOn, host).includes(probe)) {
          return { status: VERDICT.FAIL, why: `${trap}/${host}: the promoted lesson did not reach project B's prompt`, checked };
        }
      }
      saveLessons([], dirs.lessons);
      for (const host of hosts) {
        if (fire(dirs, spec, dirs.stateOn, host).includes(probe)) {
          return { status: VERDICT.FAIL, why: `${trap}/${host}: delete-lesson mutant still delivered it — delivery is not caused by the lesson`, checked };
        }
      }
      checked.push(trap);
    } finally {
      cleanupFixtureDaemons(dirs);
      removeFixture(base);
    }
  }
  return { status: VERDICT.PASS, why: `both lessons reached project B on ${hosts.join(' and ')}; control and delete-lesson mutant stayed silent`, checked };
}

function printed(label, result) {
  console.log(`\n  ${label}: ${result.status}\n  ${result.why}\n`);
  return EXIT[result.status] ?? EXIT.UNKNOWN;
}

// The scheduled workflow reports out-of-date model evidence without paging on it (nothing scheduled can
// re-measure it); a recomputed FAIL, a forged or missing artifact, or any other UNKNOWN stays non-zero.
// The strict check stops at the first stale artifact, so tolerance re-checks the WHOLE portfolio (both traps
// and all four mutants, every transcript verified and recomputed) with only staleness waived, and softens
// nothing unless that passes: staleness never hides a defect behind it (Codex 4.7.21 r4 #2, Opus r2 #3).
function portfolioExit(result, tolerateStale) {
  if (!tolerateStale || result.status !== VERDICT.UNKNOWN || result.stale !== true) {
    return printed(`${INVARIANT}-PORTFOLIO`, result);
  }
  const waived = checkPortfolio({ tolerateStale: true });
  if (waived.status !== VERDICT.PASS) return printed(`${INVARIANT}-PORTFOLIO`, waived);
  printed(`${INVARIANT}-PORTFOLIO`, result);
  console.log('  STALE-TOLERATED: every artifact verified and recomputed, but the committed model evidence predates'
    + ' the current code; re-measure to restore a verdict.\n');
  return EXIT.PASS;
}

// A portfolio includes both positive traps AND all four causal mutants. Run every scenario even
// after a failure, then let the unchanged evidence checker decide the result; child exit 1 is the
// expected outcome of a causal mutant, and is never by itself a successful portfolio measurement.
export async function measurePortfolio({ host, model, execute = main, check = checkPortfolio }) {
  for (const trap of [TRAP.MEMORY_SEARCH, TRAP.POST_TASK]) {
    await execute(['--trap', trap, '--n', '3', '--host', host, '--model', model]);
    for (const mutant of ['delete-lesson', 'brain-off-treated']) {
      await execute(['--trap', trap, '--mutant', mutant, '--n', '1', '--host', host, '--model', model]);
    }
  }
  return printed(`${INVARIANT}-PORTFOLIO`, check());
}

export async function main(argv = process.argv.slice(2)) {
  const { has, arg } = parse(argv);
  if (has('--help') || has('-h')) {
    console.log(usage());
    return EXIT.PASS;
  }
  const mutant = arg('--mutant', null);
  const trap = arg('--trap', TRAP.MEMORY_SEARCH);
  const host = arg('--host', 'codex');
  const model = arg('--model', host === 'codex' ? GPT_5_6_SOL_ID : 'haiku');
  const n = Math.max(1, parseInt(arg('--n', mutant ? '1' : '3'), 10) || 1);
  const outFile = arg('--out', mutant
    ? MUTANT_RESULT_FILES[trap]?.[mutant]
    : PORTFOLIO_RESULT_FILES[trap]);
  if (mutant && !MUTANTS[mutant]) {
    console.error(`unknown mutant "${mutant}"`);
    return EXIT.UNKNOWN;
  }
  if (![TRAP.MEMORY_SEARCH, TRAP.POST_TASK].includes(trap) || !outFile) {
    console.error(`unsupported trap/mutant: ${trap}/${mutant || 'normal'}`);
    return EXIT.UNKNOWN;
  }
  if (has('--check')) {
    return printed(INVARIANT, checkArtifact({ file: PORTFOLIO_RESULT_FILES[trap] }));
  }
  if (has('--check-portfolio')) return portfolioExit(checkPortfolio(), has('--tolerate-stale'));
  if (has('--check-mutants')) return printed(`${INVARIANT}-MUTANTS`, checkMutantArtifacts());
  if (has('--check-wire')) return printed(`${INVARIANT}-WIRE`, checkWire());
  if (has('--measure-portfolio')) return measurePortfolio({ host, model });

  const source = checkSourceIdentity();
  if (!source.clean) {
    console.error(`  ${INVARIANT}: UNKNOWN — ${source.why}`);
    return EXIT.UNKNOWN;
  }

  const spec = trapSpec(trap);
  const premise = trap === TRAP.POST_TASK ? verifyPostTaskContract() : verifyRufloFlag();
  console.log(`\n=== ${INVARIANT} — ${trap} ===`);
  console.log(`  premise: ${premise.ok ? `VERIFIED: ${premise.evidence}` : `NOT VERIFIED: ${premise.why}`}`);
  if (!premise.ok) {
    writeArtifact(outFile, aggregate([]), { host, model, mutant, trap, task: spec.prompt });
    return EXIT.UNKNOWN;
  }

  const base = allocateRunBase();
  const dirs = buildFixtures(base);
  process.once('exit', () => cleanupFixtureDaemons(dirs));
  const record = recordInProjectA(dirs, { trap });
  // Every target fixture needs a real AgentDB file before Codex starts. The global SessionStart
  // contract otherwise injects an opt-in question and requires the model to wait for an answer,
  // which prevents both post-task arms from producing the command this trap is meant to compare.
  // Only the memory-search trap needs the independent cache note; post-task needs an initialized,
  // otherwise empty store so its control differs solely on the lesson under test.
  const seed = seedProjectBMemory(dirs, {
    includeFixtureRecord: trap === TRAP.MEMORY_SEARCH,
  });
  const refresh = nightlyRefresh(dirs);
  console.log(`  record: ${record.projectCount} sources; promoted=${record.promoted}; ok=${record.ok}`);
  console.log(`  seed: ${seed.skipped || `ok=${seed.ok}`}`);
  console.log(`  refresh: ${refresh.generation}; lessonSurvived=${refresh.lessonSurvived}`);

  if (mutant === 'delete-lesson') {
    saveLessons([], dirs.lessons);
    removeFixture(path.join(dirs.projectA, '.swarm', 'memory.db'));
    console.log(`  mutant delete-lesson: ${loadLessons(dirs.lessons).length} lessons remain`);
  }
  if (mutant === 'empty-store') {
    removeFixture(path.join(dirs.projectB, '.swarm', 'memory.db'));
    console.log('  mutant empty-store: target memory removed');
  }
  if (has('--dry-run')) {
    const treatedBytes = wireProbe(dirs, spec, dirs.stateOn);
    const controlBytes = wireProbe(dirs, spec, dirs.stateOff);
    const dry = aggregate([]);
    dry.why = `--dry-run: no model called; treated ${treatedBytes}B, control ${controlBytes}B`;
    writeArtifact(outFile, dry, {
      host, model, mutant, trap, task: spec.prompt, record, seed, refresh, flag: premise,
    });
    if (!has('--keep-fixtures')) {
      cleanupFixtureDaemons(dirs);
      removeFixture(base);
    }
    return EXIT.UNKNOWN;
  }

  const runs = [];
  for (let i = 1; i <= n; i++) {
    const treated = runArm({
      dirs,
      arm: 'treated',
      stateDir: mutant === 'brain-off-treated' ? dirs.stateOff : dirs.stateOn,
      model,
      host,
      tag: `run${i}-treated`,
      trap,
      forceCommand: mutant === 'wrong-subcommand' ? WRONG_SUBCOMMAND_COMMAND : null,
    });
    const control = runArm({
      dirs,
      arm: 'control',
      stateDir: dirs.stateOff,
      model,
      host,
      tag: `run${i}-control`,
      trap,
      appendSystemPrompt: mutant === 'seed-control' ? spec.lesson : null,
    });
    const run = {
      i,
      treatedClass: treated.class,
      controlClass: control.class,
      lessonBeforeFirstToolCall: treated.lessonBeforeFirstToolCall,
      controlLessonDelivered: control.lessonDelivered,
      treatedSubcommandCorrect: treated.subcommandCorrect,
      treatedExecOk: treated.exec?.exitOk === true,
      treatedRetrieved: treated.exec?.retrieved === true,
      treatedExecWhy: treated.exec?.why || null,
      controlWorked: control.exec?.exitOk === true && control.exec?.retrieved === true,
      treated,
      control,
      error: treated.spawnError || control.spawnError || null,
    };
    const verdict = verdictForRun(run);
    console.log(`  run ${i}: ${verdict.verdict} — ${verdict.why}`);
    runs.push(run);
  }
  const result = aggregate(runs);
  const costUsd = runs.reduce((sum, run) =>
    sum + (run.treated.costUsd || 0) + (run.control.costUsd || 0), 0);
  const wallMs = runs.reduce((sum, run) =>
    sum + (run.treated.wallMs || 0) + (run.control.wallMs || 0), 0);
  const artifact = writeArtifact(outFile, result, {
    host,
    model,
    mutant,
    trap,
    task: spec.prompt,
    record,
    seed,
    refresh,
    flag: premise,
    costUsd,
    wallMs,
  });
  if (!has('--keep-fixtures')) {
    const preservePaths = artifact.runs.flatMap((run) => [
      path.resolve(ROOT, run.treated.transcript.path),
      path.resolve(ROOT, run.control.transcript.path),
    ]);
    pruneArchive(dirs, { preservePaths });
  }
  console.log(`  ${INVARIANT}: ${result.verdict} — ${result.why}`);
  console.log(`  artifact: ${path.relative(ROOT, outFile)}`);
  return EXIT[result.verdict] ?? EXIT.UNKNOWN;
}
