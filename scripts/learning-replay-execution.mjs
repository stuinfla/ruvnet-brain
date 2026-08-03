import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandNodes, findInvocations } from '../plugin/scripts/hook-input.mjs';
import { normalizeRufloExecutable, optionValue, TRAP } from './learning-replay-contract.mjs';

export const PROJECT_B_MEMORY_KEY = 'note-caching-strategy';
export const PROJECT_B_MEMORY_VALUE =
  'The caching strategy for this project: responses are memoized in a two-tier LRU, '
  + 'warm tier in memory and cold tier on disk, invalidated by content hash.';
export const RETRIEVAL_EVIDENCE = Object.freeze({
  positive: Object.freeze([PROJECT_B_MEMORY_KEY.slice(0, 12), PROJECT_B_MEMORY_VALUE.slice(0, 20)]),
  negative: Object.freeze([
    /No results found/i,
    /Unknown command/i,
    /Required option missing/i,
    /Usage:\s*claude-flow memory/i,
    /\[ERROR\]/,
  ]),
});

export const RUFLO_BIN = process.env.RUVNET_RUFLO_BIN
  || path.join(os.homedir(), '.npm-global', 'bin', 'ruflo');
const MUTATING_SUBCOMMANDS = new Set([
  'store', 'delete', 'rm', 'purge', 'cleanup', 'compress', 'import', 'export',
  'backup', 'init', 'configure',
]);

function spawnRuflo(bin, args, options) {
  return /\.[cm]?js$/i.test(bin)
    ? spawnSync(process.execPath, [bin, ...args], options)
    : spawnSync(bin, args, options);
}

export function assertRetrieved(out) {
  const text = String(out || '');
  for (const pattern of RETRIEVAL_EVIDENCE.negative) {
    if (pattern.test(text)) return { retrieved: false, why: `output matched failure shape ${pattern}` };
  }
  const hit = RETRIEVAL_EVIDENCE.positive.find((value) => text.includes(value));
  if (!hit) return { retrieved: false, why: 'output names neither the seeded key nor its text' };
  return { retrieved: true, why: `output carries the seeded memory (matched "${hit}")` };
}

export function assertPostTaskPersisted({ args, output, cwd }) {
  const task = optionValue(args, '-t', '--task');
  const agent = optionValue(args, '-a', '--agent');
  const taskId = optionValue(args, '-i', '--task-id')
    || String(output || '').match(/Recording outcome for task:\s*([a-zA-Z0-9_-]+)/)?.[1]
    || null;
  if (!task || !agent || !taskId || !args.includes('--store-results')) {
    return { retrieved: false, why: 'command lacked --task, --agent, --store-results, or a task id' };
  }
  let outcomes;
  let memory;
  try {
    outcomes = JSON.parse(fs.readFileSync(path.join(cwd, '.claude-flow', 'routing-outcomes.json'), 'utf8'));
    memory = JSON.parse(fs.readFileSync(path.join(cwd, '.claude-flow', 'memory', 'store.json'), 'utf8'));
  } catch (error) {
    return { retrieved: false, why: `persistence stores were not readable: ${error.message}` };
  }
  const outcome = (outcomes.outcomes || []).find((row) =>
    row.task === task && row.agent === agent && row.success === true);
  const decision = memory.entries?.[`routing-decision:${taskId}`];
  let value = null;
  try { value = decision ? JSON.parse(decision.value) : null; } catch { /* invalid evidence */ }
  if (!outcome || !decision || value?.task !== task || value?.agent !== agent) {
    return { retrieved: false, why: 'no matching routing outcome and routing-decision row persisted' };
  }
  if (!/\[OK\]\s*Task outcome recorded:\s*SUCCESS/i.test(String(output || ''))) {
    return { retrieved: false, why: 'rows exist but invocation did not report successful recording' };
  }
  return { retrieved: true, why: `routing outcome and routing-decision:${taskId} persisted` };
}

export function executeProducedCommand(cmd, {
  cwd,
  ruflo = RUFLO_BIN,
  base = null,
  trap = TRAP.MEMORY_SEARCH,
} = {}) {
  const reject = (why, extra = {}) => ({
    ran: false,
    argv: null,
    exit: null,
    exitOk: false,
    retrieved: false,
    why,
    output: '',
    ...extra,
  });
  const normalized = normalizeRufloExecutable(cmd);
  const invocations = findInvocations(normalized, ['ruflo', 'claude-flow']);
  if (!invocations.length) return reject('no Ruflo invocation to execute');
  const firstExecutable = path.basename(commandNodes(normalized)[0]?.exe || '').split('@')[0];
  if (invocations.length !== 1 || firstExecutable !== 'ruflo') {
    return reject('corrective command was not the first and only Ruflo invocation');
  }
  const args = invocations[0].args.filter((value) => value !== '');
  if (args.some((value) => ['--help', '-h', '--version', 'version', 'status'].includes(value))) {
    return reject('discovery cannot replace the requested corrective action');
  }
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!['--path', '--db'].includes(value) && !/^--(?:path|db)=/.test(value)) continue;
    const raw = value.includes('=') ? value.slice(value.indexOf('=') + 1) : args[i + 1];
    const absolute = path.resolve(cwd, String(raw || ''));
    const root = base && path.resolve(base);
    if (!root || !(absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
      return reject(`store path ${absolute} is outside the fixture world`, { argv: ['ruflo', ...args] });
    }
  }
  const mutating = args.filter((value) => !value.startsWith('-')).slice(0, 2)
    .find((value) => MUTATING_SUBCOMMANDS.has(value));
  if (mutating) return reject(`refused mutating subcommand "${mutating}"`, { argv: ['ruflo', ...args] });

  const env = { ...process.env };
  delete env.CLAUDE_FLOW_DB_PATH;
  delete env.CLAUDE_FLOW_MEMORY_PATH;
  const result = spawnRuflo(ruflo, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) return reject(`spawn failed: ${result.error.message}`, { argv: ['ruflo', ...args] });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const evidence = trap === TRAP.POST_TASK
    ? assertPostTaskPersisted({ args, output, cwd })
    : assertRetrieved(output);
  return {
    ran: true,
    argv: ['ruflo', ...args],
    exit: result.status,
    exitOk: result.status === 0,
    retrieved: evidence.retrieved,
    why: `exit ${result.status}; ${evidence.why}`,
    output: output.slice(0, 1200),
  };
}

export function verifyRufloFlag(bin = RUFLO_BIN) {
  if (!fs.existsSync(bin)) return { ok: false, why: `Ruflo binary not found at ${bin}` };
  const result = spawnSync(bin, ['memory', 'search', '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0 && !output) return { ok: false, why: `help exited ${result.status} empty` };
  if (!/-q,\s*--query/.test(output)) return { ok: false, why: 'live help lacks -q, --query', help: output };
  if (/\bmemory search\s+"[^"]+"\s*$/m.test(output)) {
    return { ok: false, why: 'live help documents a positional query', help: output };
  }
  return {
    ok: true,
    flag: '-q, --query',
    required: /--query[^\n]*required/i.test(output),
    evidence: output.split('\n').find((line) => /-q,\s*--query/.test(line))?.trim() || '',
  };
}

export function verifyPostTaskContract(bin = RUFLO_BIN) {
  if (!fs.existsSync(bin)) return { ok: false, why: `Ruflo binary not found at ${bin}` };
  const help = spawnRuflo(bin, ['hooks', 'post-task', '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = `${help.stdout || ''}${help.stderr || ''}`;
  if (!/--task\b/.test(output) || !/--agent\b/.test(output) || !/--store-results\b/.test(output)
    || !/Without this \+ --agent, no routing outcome is recorded/.test(output)) {
    return { ok: false, why: 'live help lacks the three-part persistence contract', help: output };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-post-task-premise-'));
  const missing = spawnRuflo(bin, ['hooks', 'post-task', '-i', 'd4-premise-missing', '--success', 'true'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const persisted = fs.existsSync(path.join(dir, '.claude-flow', 'routing-outcomes.json'))
    || fs.existsSync(path.join(dir, '.claude-flow', 'memory', 'store.json'));
  fs.rmSync(dir, { recursive: true, force: true });
  if (missing.status !== 0 || persisted) {
    return { ok: false, why: 'missing-contract probe did not remain successful and non-persistent' };
  }
  return {
    ok: true,
    flag: '--task + --agent + --store-results',
    required: true,
    evidence: 'live help names all flags; success/task-id-only persisted nothing',
    missingExit: missing.status,
  };
}
