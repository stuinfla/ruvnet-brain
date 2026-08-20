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

const usage = () => `Usage:
  node scripts/learning-replay.mjs [--trap ${TRAP.MEMORY_SEARCH}|${TRAP.POST_TASK}] [--n N] [--host codex|claude-code] [--model MODEL]
  node scripts/learning-replay.mjs --check
  node scripts/learning-replay.mjs --check-portfolio
  node scripts/learning-replay.mjs --check-mutants
  node scripts/learning-replay.mjs --dry-run
  node scripts/learning-replay.mjs --mutant <${Object.keys(MUTANTS).join('|')}>

Exit: 0=PASS, 1=FAIL, 3=INCONCLUSIVE, 4=UNKNOWN.`;

function parse(argv) {
  const has = (flag) => argv.includes(flag);
  const arg = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return { has, arg };
}

function wireProbe(dirs, spec, stateDir) {
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs'),
    'unprompted-speech', 'UserPromptSubmit',
  ], {
    input: JSON.stringify({
      prompt: spec.prompt,
      session_id: `dry-${Date.now()}`,
      cwd: dirs.projectB,
    }),
    encoding: 'utf8',
    cwd: dirs.projectB,
    env: {
      ...process.env,
      RUVNET_BRAIN_HOME: dirs.brainHome,
      RUVNET_BRAIN_STATE_DIR: stateDir,
      RUVNET_CONFIG_ROOT: path.join(dirs.base, 'config'),
      RUVNET_LESSON_STORE: dirs.lessons,
      RUVNET_LESSON_GATE_STATE: dirs.gateState,
      CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
    },
  });
  return (result.stdout || '').length;
}

function printed(label, result) {
  console.log(`\n  ${label}: ${result.status}\n  ${result.why}\n`);
  return EXIT[result.status] ?? EXIT.UNKNOWN;
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
  const model = arg('--model', host === 'codex' ? 'gpt-5.6-sol' : 'haiku');
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
  if (has('--check-portfolio')) return printed(`${INVARIANT}-PORTFOLIO`, checkPortfolio());
  if (has('--check-mutants')) return printed(`${INVARIANT}-MUTANTS`, checkMutantArtifacts());

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
