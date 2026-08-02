import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInvocations } from '../plugin/scripts/hook-input.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INVARIANT = 'LEARNING-REPLAY';
export const VERDICT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNKNOWN: 'UNKNOWN',
  INCONCLUSIVE: 'INCONCLUSIVE',
});
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INCONCLUSIVE: 3, UNKNOWN: 4 });
export const RESULT_FILE = path.join(ROOT, 'data', 'learning-replay-result.json');
export const POST_TASK_RESULT_FILE = path.join(ROOT, 'data', 'learning-replay-post-task-result.json');
export const TRAP = Object.freeze({
  MEMORY_SEARCH: 'memory-search-query',
  POST_TASK: 'hooks-post-task-persistence',
});

export const REPLAY_PROMPT =
  'Earlier in this project someone recorded a note about the caching strategy. '
  + "Recall it from this project's agent memory with the ruflo CLI. "
  + 'Run the recall command now, then tell me what you ran.';
export const LESSON_STATEMENT =
  'When you look something up in agent memory with the ruflo CLI, run exactly '
  + '`ruflo memory search -q "<query>" --path .swarm/memory.db` as the first and only Ruflo invocation; '
  + 'a bare quoted phrase placed after the subcommand is rejected.';
export const POST_TASK_PROMPT =
  'Record successful completion of the release retry-budget investigation in ruflo hooks learning, '
  + 'assign it to the tester agent, and persist the routing decision for later sessions. '
  + 'Use the terminal CLI, not an MCP tool. Do not inspect help or run any setup command. '
  + 'Run exactly one post-task command now, then tell me what you ran.';
export const POST_TASK_LESSON =
  'A ruflo hooks post-task call persists a reusable routing outcome only when it includes all three: '
  + '--task with the task description, --agent with the executor, and --store-results; a success/task-id alone '
  + 'may print success but does not create the routing decision that later learning reads.';

export function trapSpec(id = TRAP.MEMORY_SEARCH) {
  if (id === TRAP.POST_TASK) {
    return {
      id,
      lessonId: 'FX-D4-ruflo-hooks-post-task-persistence',
      prompt: POST_TASK_PROMPT,
      lesson: POST_TASK_LESSON,
      memoryKey: 'lesson-ruflo-hooks-post-task-persistence',
      recordQuery: 'ruflo hooks post task routing persistence',
      check: 'the produced ruflo hooks post-task command includes --task, --agent, and --store-results',
    };
  }
  return {
    id: TRAP.MEMORY_SEARCH,
    lessonId: 'FX-D4-ruflo-memory-search-flag',
    prompt: REPLAY_PROMPT,
    lesson: LESSON_STATEMENT,
    memoryKey: 'lesson-ruflo-memory-search-flag',
    recordQuery: 'ruflo CLI memory query flag',
    check: 'the produced ruflo memory search command delivers its query through -q/--query',
  };
}

export const LOAD_BEARING = Object.freeze([
  'scripts/learning-replay.mjs',
  'scripts/learning-replay-contract.mjs',
  'scripts/learning-replay-execution.mjs',
  'scripts/learning-replay-fixture.mjs',
  'scripts/learning-replay-proof.mjs',
  'scripts/learning-replay-cli.mjs',
  'scripts/ci/learning-replay-recorder.mjs',
  'scripts/ci/learning-replay-codex-adapter.mjs',
  'scripts/lesson-store.mjs',
  'plugin/scripts/lesson-store.mjs',
  'plugin/scripts/lesson-gate.mjs',
  'plugin/scripts/lesson-command-scope.mjs',
  'plugin/scripts/lesson-presentation.mjs',
  'plugin/scripts/lesson-hooks.sh',
  'plugin/scripts/unprompted-runtime.mjs',
  'plugin/scripts/hook-shim.mjs',
  'plugin/scripts/hook-input.mjs',
]);

export function classifyCommand(cmd) {
  const invocations = findInvocations(String(cmd || ''), ['ruflo', 'claude-flow']);
  if (!invocations.length) return 'none';
  let sawPositional = false;
  for (const inv of invocations) {
    const args = inv.args.filter((a) => a !== '');
    if (args.some((a) => a === '-q' || a === '--query' || a.startsWith('--query='))) return 'flagged';
    const bare = [];
    for (let i = 0; i < args.length; i++) {
      const value = args[i];
      if (value.startsWith('-')) {
        if (!value.includes('=') && args[i + 1] && !args[i + 1].startsWith('-')) i++;
        continue;
      }
      bare.push(value);
    }
    const queryish = (value) => /\s/.test(value) || value.length > 24;
    if (bare.length >= 3 || bare.slice(1).some(queryish)) sawPositional = true;
  }
  return sawPositional ? 'positional' : 'other';
}

export function subcommandCorrect(cmd) {
  for (const inv of findInvocations(String(cmd || ''), ['ruflo', 'claude-flow'])) {
    const words = inv.args.filter((a) => a !== '' && !a.startsWith('-'));
    const memory = words.indexOf('memory');
    if (memory !== -1 && words[memory + 1] === 'search') return true;
  }
  return false;
}

export const carriesToken = (classification) => classification === 'flagged';

export function optionValue(args, short, long) {
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === short || value === long) {
      return args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null;
    }
    if (value.startsWith(`${long}=`)) return value.slice(long.length + 1);
  }
  return null;
}

export function classifyPostTaskCommand(cmd) {
  const invocations = findInvocations(String(cmd || ''), ['ruflo', 'claude-flow']);
  if (!invocations.length) return 'none';
  let sawPostTask = false;
  for (const inv of invocations) {
    const args = inv.args.filter(Boolean);
    const hooks = args.indexOf('hooks');
    if (hooks === -1 || args[hooks + 1] !== 'post-task') continue;
    sawPostTask = true;
    const task = optionValue(args, '-t', '--task');
    const agent = optionValue(args, '-a', '--agent');
    const store = args.includes('--store-results')
      || args.some((a) => a.startsWith('--store-results=') && !/=false$/i.test(a));
    if (task && agent && store) return 'flagged';
  }
  return sawPostTask ? 'partial' : 'other';
}

export function postTaskSubcommandCorrect(cmd) {
  return findInvocations(String(cmd || ''), ['ruflo', 'claude-flow']).some((inv) => {
    const words = inv.args.filter((a) => a !== '' && !a.startsWith('-'));
    const hooks = words.indexOf('hooks');
    return hooks !== -1 && words[hooks + 1] === 'post-task';
  });
}

export function verdictForRun(run) {
  const {
    treatedClass, controlClass, lessonBeforeFirstToolCall, error,
    treatedSubcommandCorrect, treatedExecOk, treatedRetrieved, treatedExecWhy, controlWorked,
  } = run;
  if (error) return { verdict: VERDICT.UNKNOWN, why: `harness could not measure this run: ${error}` };
  if (controlClass === 'none') {
    return { verdict: VERDICT.UNKNOWN, why: 'the control arm produced no ruflo invocation at all — there is no comparable artifact to difference against' };
  }
  if (treatedClass === 'none') return { verdict: VERDICT.FAIL, why: 'the treated arm produced no ruflo invocation at all' };
  if (carriesToken(controlClass) || controlWorked === true) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      why: carriesToken(controlClass)
        ? `the CONTROL arm produced the token (${controlClass}) — the model would have got it right without the lesson, so this trap measured nothing`
        : `the CONTROL arm's command EXECUTED AND RETRIEVED (class "${controlClass}") — the model would have got it right without the lesson, so this trap measured nothing`,
    };
  }
  if (!carriesToken(treatedClass)) return { verdict: VERDICT.FAIL, why: `treated arm produced "${treatedClass}", not the token` };
  if (treatedSubcommandCorrect !== true) {
    return { verdict: VERDICT.FAIL, why: 'treated arm carried the token on the WRONG SUBCOMMAND — the corrective action is unusable' };
  }
  if (treatedExecOk !== true) {
    return { verdict: VERDICT.FAIL, why: `treated arm's produced command did not execute successfully: ${treatedExecWhy || 'not executed'}` };
  }
  if (treatedRetrieved !== true) {
    return { verdict: VERDICT.FAIL, why: `treated arm's command exited 0 but RETRIEVED NOTHING: ${treatedExecWhy || 'no retrieval evidence'}` };
  }
  if (lessonBeforeFirstToolCall !== true) {
    return { verdict: VERDICT.FAIL, why: 'treated arm carried the token but the lesson was NOT observed before the first tool call' };
  }
  return { verdict: VERDICT.PASS, why: `treated "${treatedClass}" vs control "${controlClass}"; the produced command executed and returned the required outcome` };
}

export function aggregate(runs, { threshold = 2 / 3 } = {}) {
  const perRun = runs.map((run) => ({ ...run, ...verdictForRun(run) }));
  const n = perRun.length;
  const passes = perRun.filter((run) => run.verdict === VERDICT.PASS).length;
  const fails = perRun.filter((run) => run.verdict === VERDICT.FAIL).length;
  const unknowns = perRun.filter((run) => run.verdict === VERDICT.UNKNOWN).length;
  const controlTokenRuns = perRun.filter((run) => carriesToken(run.controlClass)).length;
  const controlWorkedRuns = perRun.filter((run) => run.controlWorked === true).length;
  const treatedTokenRuns = perRun.filter((run) => carriesToken(run.treatedClass)).length;
  const treatedSubcommandRuns = perRun.filter((run) => run.treatedSubcommandCorrect === true).length;
  const treatedExecutedRuns = perRun.filter((run) => run.treatedExecOk === true).length;
  const treatedRetrievedRuns = perRun.filter((run) => run.treatedRetrieved === true).length;
  let verdict;
  let why;
  if (n === 0) {
    verdict = VERDICT.UNKNOWN;
    why = 'zero runs executed — an empty run is not a pass';
  } else if (controlTokenRuns > 0 || controlWorkedRuns > 0) {
    verdict = VERDICT.INCONCLUSIVE;
    why = `${controlTokenRuns}/${n} CONTROL run(s) produced the token and ${controlWorkedRuns}/${n} executed+retrieved — the trap is invalid`;
  } else if (passes / n >= threshold) {
    verdict = VERDICT.PASS;
    why = `${passes}/${n} runs passed (bar ${Math.ceil(threshold * n)}/${n})`;
  } else if (unknowns > 0) {
    verdict = VERDICT.UNKNOWN;
    const error = perRun.map((run) => run.error).find(Boolean);
    why = error
      ? `${unknowns}/${n} run(s) could not be measured; executor error: ${error}`
      : `${unknowns}/${n} run(s) could not be measured; ${passes}/${n} passed`;
  } else {
    verdict = VERDICT.FAIL;
    why = `${passes}/${n} runs passed — below the ${Math.ceil(threshold * n)}/${n} bar`;
  }
  if (verdict === VERDICT.PASS && (controlTokenRuns > 0 || controlWorkedRuns > 0)) {
    throw new Error('LEARNING-REPLAY: refusing PASS while a control succeeded');
  }
  const brokenPass = perRun.find((run) => run.verdict === VERDICT.PASS
    && (run.treatedSubcommandCorrect !== true || run.treatedExecOk !== true || run.treatedRetrieved !== true));
  if (brokenPass) throw new Error(`LEARNING-REPLAY: unusable PASS run ${brokenPass.i}`);
  return {
    verdict, why, n, passes, fails, unknowns,
    controlTokenRuns, controlWorkedRuns, treatedTokenRuns,
    treatedSubcommandRuns, treatedExecutedRuns, treatedRetrievedRuns,
    rate: n ? +(passes / n).toFixed(4) : 0,
    runs: perRun,
  };
}

export const WRONG_SUBCOMMAND_COMMAND = 'ruflo recall -q "caching strategy"';
export const MUTANTS = Object.freeze({
  'delete-lesson': 'delete the recorded lesson after refresh',
  'brain-off-treated': 'run the treated arm with the brain disabled',
  'seed-control': 'pre-seed the control arm with the lesson',
  'wrong-subcommand': 'substitute the treated artifact with a right flag on a wrong verb',
  'empty-store': 'remove the seeded target memory before the gate runs',
});
export const MUTANT_RESULT_FILES = Object.freeze({
  [TRAP.MEMORY_SEARCH]: Object.freeze({
    'delete-lesson': path.join(ROOT, 'data', 'learning-replay-delete-lesson-result.json'),
    'brain-off-treated': path.join(ROOT, 'data', 'learning-replay-brain-off-result.json'),
  }),
  [TRAP.POST_TASK]: Object.freeze({
    'delete-lesson': path.join(ROOT, 'data', 'learning-replay-post-task-delete-lesson-result.json'),
    'brain-off-treated': path.join(ROOT, 'data', 'learning-replay-post-task-brain-off-result.json'),
  }),
});
export const PORTFOLIO_RESULT_FILES = Object.freeze({
  [TRAP.MEMORY_SEARCH]: RESULT_FILE,
  [TRAP.POST_TASK]: POST_TASK_RESULT_FILE,
});
