import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeLesson, saveLessons, loadLessons } from './lesson-store.mjs';
import {
  ROOT,
  REPLAY_PROMPT,
  TRAP,
  classifyCommand,
  classifyPostTaskCommand,
  postTaskSubcommandCorrect,
  subcommandCorrect,
  trapSpec,
} from './learning-replay-contract.mjs';
import {
  executeProducedCommand,
  PROJECT_B_MEMORY_KEY,
  PROJECT_B_MEMORY_VALUE,
  RUFLO_BIN,
} from './learning-replay-execution.mjs';

const CLAUDE_BIN = process.env.RUVNET_CLAUDE_BIN
  || path.join(os.homedir(), '.npm-global', 'bin', 'claude');
const CODEX_BIN = process.env.RUVNET_CODEX_BIN || 'codex';
const sh = (cmd, args, options = {}) => {
  const [binary, argv] = /\.[cm]?js$/i.test(cmd)
    ? [process.execPath, [cmd, ...args]]
    : [cmd, args];
  return spawnSync(binary, argv, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
};
const remove = (target) => {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* already gone */ }
};

export function allocateRunBase(root = path.join(ROOT, '.ruvnet-brain', 'learning-replay')) {
  fs.mkdirSync(root, { recursive: true });
  const base = fs.mkdtempSync(path.join(root, 'run-'));
  const createdAt = new Date().toISOString();
  fs.writeFileSync(path.join(base, 'run-manifest.json'), `${JSON.stringify({
    schema: 1,
    createdAt,
    sequence: Date.now(),
  }, null, 2)}\n`);
  return base;
}

function initMemoryDb(ruflo, db, cwd) {
  return sh(ruflo, ['memory', 'init', '--path', db, '--backend', 'hybrid'], { cwd });
}

function retrieveExact(ruflo, db, cwd, key, expected) {
  const result = sh(ruflo, [
    'memory', 'retrieve', '-k', key, '-n', 'default', '--value-only', '--path', db,
  ], { cwd });
  return {
    exit: result.status,
    matched: result.status === 0 && String(result.stdout || '').includes(expected),
  };
}

export function buildFixtures(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  const dirs = {
    base: baseDir,
    projectA: path.join(baseDir, 'fixture-project-a'),
    projectA2: path.join(baseDir, 'fixture-project-a-independent'),
    projectB: path.join(baseDir, 'fixture-project-b'),
    brainHome: path.join(baseDir, 'brain-home'),
    stateOn: path.join(baseDir, 'state-on'),
    stateOff: path.join(baseDir, 'state-off'),
    transcripts: path.join(baseDir, 'transcripts'),
  };
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });
  dirs.lessons = path.join(baseDir, 'lessons.json');
  dirs.gateState = path.join(baseDir, 'lesson-gate-state.json');
  fs.writeFileSync(path.join(dirs.stateOff, 'brain-off'), JSON.stringify({
    since: new Date().toISOString(),
  }));
  for (const project of [dirs.projectA, dirs.projectA2, dirs.projectB]) {
    sh('git', ['init', '-q'], { cwd: project });
    fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
  }
  return dirs;
}

export function recordInProjectA(dirs, {
  ruflo = RUFLO_BIN,
  trap = TRAP.MEMORY_SEARCH,
} = {}) {
  const spec = trapSpec(trap);
  const sources = [dirs.projectA, dirs.projectA2].map((project, index) => {
    const db = path.join(project, '.swarm', 'memory.db');
    const key = `${spec.memoryKey}-${index + 1}`;
    const init = initMemoryDb(ruflo, db, project);
    const store = sh(ruflo, [
      'memory', 'store', '-k', key, '--value', spec.lesson,
      '-n', 'default', '--path', db,
    ], { cwd: project });
    const readBack = sh(ruflo, [
      'memory', 'search', '-q', spec.recordQuery,
      '-n', 'default', '--path', db, '-t', 'keyword',
    ], { cwd: project });
    const exact = retrieveExact(ruflo, db, project, key, spec.lesson);
    return {
      project: path.basename(project),
      db,
      key,
      initExit: init.status,
      storeExit: store.status,
      readBackExit: readBack.status,
      exactReadExit: exact.exit,
      recorded: exact.matched,
    };
  });
  const lesson = makeLesson({
    id: spec.lessonId,
    statement: spec.lesson,
    trigger: 'assert-fact',
    enforcement: 'checklist',
    origin: 'user-stated',
    status: 'ratified',
    severity: 'high',
    repeatCount: 4,
    projects: sources.map((source) => source.project),
    check: spec.check,
    evidence: sources.map((source) => ({
      observed: `independently recorded in ${source.project} as ${source.key}`,
    })),
  });
  saveLessons([lesson], dirs.lessons);
  const sourcesOk = sources.every((source) => source.initExit === 0
    && source.storeExit === 0 && source.readBackExit === 0 && source.recorded);
  return {
    ok: sourcesOk && loadLessons(dirs.lessons).length === 1 && lesson.projects.length >= 2,
    trap: spec.id,
    sources,
    projectCount: lesson.projects.length,
    promoted: lesson.projects.length >= 2,
    key: sources[0].key,
    storeExit: sources[0].storeExit,
    readBackExit: sources[0].readBackExit,
    lesson,
  };
}

export function seedProjectBMemory(dirs, {
  ruflo = RUFLO_BIN,
  includeFixtureRecord = true,
} = {}) {
  const db = path.join(dirs.projectB, '.swarm', 'memory.db');
  const init = initMemoryDb(ruflo, db, dirs.projectB);
  if (!includeFixtureRecord) {
    return {
      db,
      key: null,
      initExit: init.status,
      storeExit: null,
      exactReadExit: null,
      ok: init.status === 0 && fs.existsSync(db),
      skipped: 'AgentDB initialized; memory-search record not required',
    };
  }
  const store = sh(ruflo, [
    'memory', 'store', '-k', PROJECT_B_MEMORY_KEY,
    '--value', PROJECT_B_MEMORY_VALUE, '-n', 'default', '--path', db,
  ], { cwd: dirs.projectB });
  const exact = retrieveExact(ruflo, db, dirs.projectB, PROJECT_B_MEMORY_KEY, PROJECT_B_MEMORY_VALUE);
  return {
    db,
    key: PROJECT_B_MEMORY_KEY,
    initExit: init.status,
    storeExit: store.status,
    exactReadExit: exact.exit,
    ok: init.status === 0 && store.status === 0 && exact.matched,
  };
}

export function nightlyRefresh(dirs, { ruflo = RUFLO_BIN } = {}) {
  const generation = `d4-refresh-${Date.now()}`;
  const versionDir = path.join(dirs.brainHome, 'versions', generation);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'plugin'), versionDir, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'ci', 'learning-replay-codex-adapter.mjs'),
    path.join(versionDir, 'scripts', 'codex-hook-adapter.mjs'),
  );
  // Codex registrations call this stable, generation-independent wrapper. A fixture that only
  // creates active.json silently falls back to the user's real Brain home and never records the
  // trap's PreToolUse command, making an expensive replay unmeasurable.
  fs.copyFileSync(
    path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'),
    path.join(dirs.brainHome, 'codex-hook.mjs'),
  );
  fs.writeFileSync(path.join(dirs.brainHome, 'active.json'), JSON.stringify({
    codeRoot: versionDir,
    generation,
  }, null, 2));
  fs.writeFileSync(path.join(dirs.brainHome, '.spine-seeded'), generation);
  const db = path.join(dirs.projectA, '.swarm', 'memory.db');
  const distill = sh(ruflo, ['memory', 'distill', 'run', '--path', db], { cwd: dirs.projectA });
  const backup = sh(ruflo, ['memory', 'backup', '--db', db, '--keep', '2'], { cwd: dirs.projectA });
  return {
    generation,
    codeRoot: path.relative(ROOT, versionDir),
    distillExit: distill.status,
    backupExit: backup.status,
    lessonSurvived: loadLessons(dirs.lessons).length === 1,
  };
}

function writeSettings(file, { dirs, stateDir, attemptsFile }) {
  const settings = {
    env: {
      RUVNET_BRAIN_HOME: dirs.brainHome,
      RUVNET_BRAIN_STATE_DIR: stateDir,
      RUVNET_CONFIG_ROOT: path.join(dirs.base, 'config'),
      RUVNET_LESSON_STORE: dirs.lessons,
      RUVNET_LESSON_GATE_STATE: dirs.gateState,
      CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
    },
    hooks: {
      UserPromptSubmit: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: `node ${JSON.stringify(path.join(ROOT, 'plugin', 'scripts', 'hook-shim.mjs'))} unprompted-speech UserPromptSubmit`,
          timeout: 20,
        }],
      }],
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: `node ${JSON.stringify(path.join(ROOT, 'scripts', 'ci', 'learning-replay-recorder.mjs'))} ${JSON.stringify(attemptsFile)}`,
          timeout: 20,
        }],
      }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

export function buildCodexArgv({
  model = 'gpt-5.6-sol',
  prompt = REPLAY_PROMPT,
  appendSystemPrompt = null,
} = {}) {
  const fullPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${prompt}` : prompt;
  return [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--json',
    '--ignore-rules', '--dangerously-bypass-hook-trust', '-m', model,
    '-c', 'model_reasoning_effort="low"',
    '-c', 'shell_environment_policy.inherit="all"',
    fullPrompt,
  ];
}

export function replayRunError(events, result) {
  if (result?.error) return String(result.error.message || result.error);
  const event = events.find((value) => value.type === 'result');
  if (!event?.is_error) return null;
  const status = event.api_error_status ? `HTTP ${event.api_error_status}: ` : '';
  return `${status}${event.result || event.terminal_reason || 'model execution failed'}`;
}

export function parseCodexRunError(events, result) {
  if (result?.error) return String(result.error.message || result.error);
  const failed = events.find((event) => event.type === 'turn.failed');
  if (failed) return String(failed.error?.message || failed.error || 'Codex turn failed');
  if (events.some((event) => event.type === 'turn.completed') && result?.status === 0) return null;
  const error = events.find((event) => event.type === 'item.completed' && event.item?.type === 'error');
  if (error) return String(error.item?.message || error.item?.text || 'Codex execution failed');
  return result?.status && result.status !== 0 ? `Codex exited ${result.status}` : null;
}

export function codexLessonBeforeTool(sequence) {
  const lesson = sequence.find((event) => event.kind === 'lesson');
  const tool = sequence.find((event) => event.kind === 'tool');
  return Boolean(lesson && tool && BigInt(lesson.atNs) < BigInt(tool.atNs));
}

function readJsonLines(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
    : [];
}

export function runArm({
  dirs,
  arm,
  stateDir,
  model,
  host = 'claude-code',
  appendSystemPrompt = null,
  tag,
  forceCommand = null,
  trap = TRAP.MEMORY_SEARCH,
}) {
  const spec = trapSpec(trap);
  const attempts = path.join(dirs.transcripts, `${tag}.attempts.jsonl`);
  const sequenceFile = path.join(dirs.transcripts, `${tag}.sequence.jsonl`);
  const streamFile = path.join(dirs.transcripts, `${tag}.stream.jsonl`);
  let binary;
  let argv;
  if (host === 'codex') {
    binary = CODEX_BIN;
    argv = buildCodexArgv({ model, prompt: spec.prompt, appendSystemPrompt });
  } else {
    const settings = writeSettings(path.join(dirs.base, `settings-${tag}.json`), {
      dirs,
      stateDir,
      attemptsFile: attempts,
    });
    binary = CLAUDE_BIN;
    argv = [
      '-p', spec.prompt, '--model', model, '--tools', 'Bash',
      '--permission-mode', 'bypassPermissions', '--setting-sources', '',
      '--settings', settings, '--output-format', 'stream-json', '--verbose',
      '--include-hook-events', '--no-session-persistence', '--max-budget-usd', '0.30',
    ];
    if (appendSystemPrompt) argv.push('--append-system-prompt', appendSystemPrompt);
  }
  const started = Date.now();
  const result = spawnSync(binary, argv, {
    cwd: dirs.projectB,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      RUVNET_BRAIN_HOME: dirs.brainHome,
      RUVNET_BRAIN_STATE_DIR: stateDir,
      RUVNET_CONFIG_ROOT: path.join(dirs.base, 'config'),
      RUVNET_LESSON_STORE: dirs.lessons,
      RUVNET_LESSON_GATE_STATE: dirs.gateState,
      RUVNET_REPLAY_ATTEMPTS_FILE: attempts,
      RUVNET_REPLAY_SEQUENCE_FILE: sequenceFile,
      RUVNET_REPLAY_LESSON_PROBE: spec.lesson.slice(0, 60),
      RUVNET_REPLAY_RECORDER: path.join(ROOT, 'scripts', 'ci', 'learning-replay-recorder.mjs'),
      CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
    },
  });
  const wallMs = Date.now() - started;
  fs.writeFileSync(streamFile, result.stdout || '');
  if (result.stderr) fs.writeFileSync(path.join(dirs.transcripts, `${tag}.stderr.txt`), result.stderr);
  const events = readJsonLines(streamFile);
  const sequence = readJsonLines(sequenceFile);
  const probe = spec.lesson.slice(0, 60);
  let lessonIndex = -1;
  let firstToolIndex = -1;
  let lessonDelivered = false;
  if (host === 'codex') {
    lessonIndex = sequence.findIndex((event) => event.kind === 'lesson');
    firstToolIndex = sequence.findIndex((event) => event.kind === 'tool');
    lessonDelivered = lessonIndex !== -1;
  } else {
    events.forEach((event, index) => {
      if (lessonIndex === -1 && event.type === 'system' && event.subtype === 'hook_response'
        && typeof event.output === 'string' && event.output.includes(probe)) {
        lessonIndex = index;
        lessonDelivered = true;
      }
      if (firstToolIndex === -1 && event.type === 'assistant'
        && Array.isArray(event.message?.content)
        && event.message.content.some((content) => content.type === 'tool_use')) firstToolIndex = index;
    });
  }
  const attemptLines = readJsonLines(attempts);
  const command = forceCommand != null ? forceCommand : (attemptLines[0]?.command || '');
  const classification = trap === TRAP.POST_TASK
    ? classifyPostTaskCommand(command)
    : classifyCommand(command);
  const subcommand = trap === TRAP.POST_TASK
    ? postTaskSubcommandCorrect(command)
    : subcommandCorrect(command);
  const execution = executeProducedCommand(command, {
    cwd: dirs.projectB,
    base: dirs.base,
    trap,
  });
  const answer = events.find((event) => event.type === 'result');
  return {
    arm,
    tag,
    class: classification,
    subcommandCorrect: subcommand,
    exec: execution,
    command,
    forcedCommand: forceCommand != null,
    attempts: attemptLines.map((attempt) => attempt.command),
    lessonDelivered,
    lessonIndex,
    firstToolIndex,
    lessonBeforeFirstToolCall: host === 'codex'
      ? codexLessonBeforeTool(sequence)
      : lessonDelivered && firstToolIndex > -1 && lessonIndex < firstToolIndex,
    costUsd: answer?.total_cost_usd ?? null,
    wallMs,
    modelUsed: events.find((event) => event.type === 'system' && event.subtype === 'init')?.model
      || events.find((event) => event.type === 'assistant')?.message?.model || model,
    host,
    transcript: path.relative(ROOT, streamFile),
    exit: result.status,
    spawnError: host === 'codex'
      ? parseCodexRunError(events, result)
      : replayRunError(events, result),
  };
}

export function removeFixture(target) {
  remove(target);
}
