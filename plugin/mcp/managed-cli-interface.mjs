import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRuntimePreferences, runtimeChildEnv } from '../scripts/runtime-preferences.mjs';
import { recordManagedCliObservation, recordRegistryLatestObservation } from '../scripts/capability-claim-evidence.mjs';

export const MANAGED_EXECUTABLES = Object.freeze([
  'ruflo',
  'claude-flow',
  'agentic-flow',
  'agentic-qe',
  'ruvector',
  'agent-browser',
  'ruv-swarm',
]);

const MANAGED = new Set(MANAGED_EXECUTABLES);
const REGISTRY_PACKAGES = Object.freeze({
  ruflo: 'ruflo',
  'claude-flow': '@claude-flow/cli',
  'agentic-flow': 'agentic-flow',
  'agentic-qe': 'agentic-qe',
  ruvector: 'ruvector',
  'agent-browser': 'agent-browser',
  'ruv-swarm': 'ruv-swarm',
});
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;
const MAX_ARGS = 256;
const MAX_ARG_BYTES = 8192;
const DEFAULT_FRESH_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const executableSchema = {
  type: 'string',
  enum: [...MANAGED_EXECUTABLES],
  description: 'One of the finite RuvNet ecosystem executables managed by this boundary.',
};

export const MANAGED_CLI_TOOLS = Object.freeze([
  {
    name: 'ruvnet_registry_latest',
    description: 'Read the exact npm registry latest version for a managed RuvNet executable and record a content-bound public-registry receipt.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { executable: executableSchema },
      required: ['executable'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'ruvnet_cli_help',
    description: 'Read a managed CLI interface from the executable itself. Runs only the supplied subcommand path plus --help and records a fresh stamp only after exit 0.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        executable: executableSchema,
        argv: {
          type: 'array',
          description: 'Zero, one, or two literal lowercase subcommand tokens. --help is appended by the server.',
          items: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
          maxItems: 2,
          default: [],
        },
      },
      required: ['executable', 'argv'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'ruvnet_cli_run',
    description: 'Run a managed CLI with a literal argv array and no shell. Refuses unless the matching interface help was read successfully in the last 24 hours.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        executable: executableSchema,
        argv: {
          type: 'array',
          description: 'Literal argv tokens. Shell metacharacters are ordinary argument bytes and are never evaluated.',
          items: { type: 'string', maxLength: MAX_ARG_BYTES },
          maxItems: MAX_ARGS,
        },
      },
      required: ['executable', 'argv'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
]);

function assertExecutable(executable) {
  if (typeof executable !== 'string' || !MANAGED.has(executable)) {
    throw new Error(`unknown managed executable: ${String(executable || '')}`);
  }
  return executable;
}

function literalArgv(argv) {
  if (!Array.isArray(argv) || argv.length > MAX_ARGS) throw new Error('argv must be an array of at most 256 strings');
  return argv.map((arg) => {
    if (typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > MAX_ARG_BYTES) {
      throw new Error('every argv entry must be a literal string of at most 8192 bytes without NUL');
    }
    return arg;
  });
}

export function helpKey(executable, argv) {
  const tool = assertExecutable(executable);
  const args = literalArgv(argv);
  const subcommands = [];
  for (const arg of args) {
    if (!SUBCOMMAND.test(arg)) break;
    subcommands.push(arg);
    if (subcommands.length === 2) break;
  }
  return [tool, ...subcommands].join('.');
}

export function stampKeysForHelp(executable, argv) {
  const tool = assertExecutable(executable);
  const args = literalArgv(argv);
  if (args.length > 2 || args.some((arg) => !SUBCOMMAND.test(arg))) {
    throw new Error('invalid subcommand path: help accepts zero, one, or two lowercase tokens');
  }
  const exact = [tool, ...args].join('.');
  if (args.length < 2) return [exact];
  return [exact, [tool, args[0]].join('.')];
}

function stateDir(env) {
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(env.HOME || os.homedir(), '.cache', 'ruvnet-brain');
  return env.RUVNET_BRAIN_HELP_READ_DIR || path.join(brainHome, 'help-read');
}

function freshStamp(executable, argv, env, now = Date.now()) {
  const stamp = path.join(stateDir(env), helpKey(executable, argv));
  let stat;
  try {
    stat = fs.statSync(stamp);
  } catch {
    return false;
  }
  const configured = Number(env.RUVNET_BRAIN_HELP_MAX_AGE_MS);
  const maxAge = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FRESH_MS;
  return now - stat.mtimeMs < maxAge;
}

function writeStamps(executable, argv, env) {
  const dir = stateDir(env);
  fs.mkdirSync(dir, { recursive: true });
  for (const key of stampKeysForHelp(executable, argv)) {
    const stamp = path.join(dir, key);
    const temporary = path.join(dir, `.${key}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
      fs.writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, stamp);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
    }
  }
}

export function resolveManagedExecutable(executable, env = process.env) {
  if (executable !== 'ruflo') return executable;
  const home = env.HOME || os.homedir();
  const canonical = path.join(home, '.npm-global', 'bin', 'ruflo');
  try {
    fs.accessSync(canonical, fs.constants.X_OK);
    return canonical;
  } catch {
    return executable;
  }
}

function execute(executable, argv, env) {
  return new Promise((resolve) => {
    const child = spawn(resolveManagedExecutable(executable, env), argv, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const append = (chunks, chunk, used) => {
      const remaining = MAX_OUTPUT_BYTES - used;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return used + Math.min(chunk.length, Math.max(remaining, 0));
    };
    child.stdout.on('data', (chunk) => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
    child.stderr.on('data', (chunk) => { stderrBytes = append(stderr, chunk, stderrBytes); });
    const configured = Number(env.RUVNET_BRAIN_MANAGED_CLI_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ code: null, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: '', error: error.message });
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), error: null });
    });
  });
}

function resultOf(executable, argv, result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '');
  const contradictoryFailure = /(?:^|\n)\s*(?:❌|\[ERROR\])|invalid pragma command|key not found/i.test(output);
  if (result.error || result.code !== 0 || contradictoryFailure) {
    const reason = result.error || (contradictoryFailure ? 'fatal output despite exit 0' : `exit ${result.code}`);
    return {
      content: [{ type: 'text', text: output || `${executable} ${argv.join(' ')} failed: ${reason}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: output || `${executable} ${argv.join(' ')} completed successfully` }],
    isError: false,
  };
}

export async function callManagedCli(toolName, args, env = process.env, fetchImpl = globalThis.fetch) {
  try {
    const executable = assertExecutable(args?.executable);
    const argv = literalArgv(args?.argv ?? []);

    if (toolName === 'ruvnet_registry_latest') {
      const packageName = REGISTRY_PACKAGES[executable];
      const registryUrl = `https://registry.npmjs.org/${packageName.replace('/', '%2F')}/latest`;
      const response = await fetchImpl(registryUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`registry latest lookup failed with HTTP ${response.status}`);
      let metadata;
      try { metadata = JSON.parse(body); } catch { throw new Error('registry latest response was not JSON'); }
      const receipt = recordRegistryLatestObservation({
        executable, packageName, version: metadata?.version, registryUrl, responseBody: body, env,
      });
      return {
        content: [{ type: 'text', text: `${packageName} latest version: ${receipt.observedVersion} (registry receipt ${receipt.receiptSha256})` }],
        isError: false,
      };
    }

    if (toolName === 'ruvnet_cli_help') {
      stampKeysForHelp(executable, argv);
      const commandArgv = [...argv, '--help'];
      const execution = await execute(executable, commandArgv, env);
      if (execution.code === 0 && !execution.error) writeStamps(executable, argv, env);
      recordManagedCliObservation({ toolName, executable, argv: commandArgv, execution, env });
      return resultOf(executable, commandArgv, execution);
    }

    if (toolName === 'ruvnet_cli_run') {
      if (!freshStamp(executable, argv, env)) {
        const key = helpKey(executable, argv).replaceAll('.', ' ');
        return {
          content: [{ type: 'text', text: `Read the interface first with ruvnet_cli_help for: ${key}` }],
          isError: true,
        };
      }
      const policy = loadRuntimePreferences({ env, cwd: env.RUVNET_BRAIN_PROJECT_DIR || process.cwd() });
      if (executable === 'agentic-flow' && policy.values.routing !== 'auto') {
        return {
          content: [{
            type: 'text',
            text: policy.values.routing === 'off'
              ? 'Token-smart routing is off in RuvNet Brain Console; agentic-flow was not started.'
              : 'Token-smart routing has not been enabled in RuvNet Brain Console; agentic-flow was not started.',
          }],
          isError: true,
        };
      }
      const isFleetMutation = executable === 'agentic-qe'
        && argv[0] === 'fleet'
        && ['init', 'spawn', 'run'].includes(argv[1]);
      if (isFleetMutation && policy.values.qeFleet !== true) {
        return {
          content: [{
            type: 'text',
            text: policy.values.qeFleet === false
              ? 'The Agentic-QE fleet is off in RuvNet Brain Console; no QE agents were started.'
              : 'The Agentic-QE fleet has not been enabled in RuvNet Brain Console; no QE agents were started.',
          }],
          isError: true,
        };
      }
      const childEnv = (executable === 'agentic-flow' || executable === 'agentic-qe')
        ? runtimeChildEnv({ env, cwd: env.RUVNET_BRAIN_PROJECT_DIR || process.cwd() })
        : env;
      const execution = await execute(executable, argv, childEnv);
      recordManagedCliObservation({ toolName, executable, argv, execution, env });
      return resultOf(executable, argv, execution);
    }

    return {
      content: [{ type: 'text', text: `unknown managed CLI tool: ${String(toolName || '')}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}
