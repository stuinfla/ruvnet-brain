#!/usr/bin/env node
// Explicit per-user terminal integration. Native binaries and authentication remain user owned.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyTerminalArguments, validateUpstreamSocket, terminalTempRoot } from './model-terminal-gateway.mjs';
import { nativeGatewayLaunch } from './model-routing-gateway.mjs';
import { subscriptionEnvironment, assertSubscriptionAuth } from './model-router-dispatch.mjs';

const SELF = fileURLToPath(import.meta.url);
const MARKER = '# Managed RuvNet Brain terminal launcher';
const START = '# >>> RuvNet Brain terminal routing >>>';
const END = '# <<< RuvNet Brain terminal routing <<<';
const quote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const digest = (v) => crypto.createHash('sha256').update(v).digest('hex');

function regular(file, { privateFile = false } = {}) {
  if (!path.isAbsolute(file || '')) throw new Error('Absolute file path required');
  const stat = fs.lstatSync(file);
  const ownerAllowed = stat.uid === process.getuid?.() || (!privateFile && stat.uid === 0);
  if (!stat.isFile() || stat.isSymbolicLink() || !ownerAllowed ||
      (privateFile && (stat.mode & 0o077))) throw new Error(`Owned regular file required: ${file}`);
  return fs.realpathSync(file);
}
function executable(file) {
  const result = regular(fs.realpathSync(file)); fs.accessSync(result, fs.constants.X_OK); return result;
}
function nativeExecutable(file) {
  const result = executable(file), fd = fs.openSync(result, 'r');
  const header = Buffer.alloc(512);
  try {
    if (header.subarray(0, fs.readSync(fd, header, 0, header.length, 0)).toString().includes(MARKER)) throw new Error('Native terminal launcher recursion refused');
  } finally { fs.closeSync(fd); }
  return result;
}
function atomic(file, content, mode = 0o600, replaceLink = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && !replaceLink) regular(file);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try { fs.writeFileSync(fd, content); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function canonicalEntry(file, binary, replace) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { file, symlink: false }; throw error; }
  if (stat.uid !== process.getuid?.()) throw new Error(`Preserving foreign canonical terminal entry: ${file}`);
  if (stat.isSymbolicLink()) {
    if (fs.realpathSync(file) !== binary) throw new Error(`Preserving unrelated canonical terminal link: ${file}`);
    return { file, symlink: true, link: fs.readlinkSync(file) };
  }
  regular(file);
  if (fs.realpathSync(file) === binary) throw new Error('Separate native binary required before replacing canonical terminal entry');
  if (!fs.readFileSync(file, 'utf8').includes(MARKER) && !replace) throw new Error(`Preserving unmanaged canonical terminal entry: ${file}`);
  return { file, symlink: false };
}
function backupCanonical(entry) {
  if (!entry.symlink) return backup(entry.file);
  const target = `${entry.file}.${digest(entry.link)}.original`;
  try { fs.symlinkSync(entry.link, target); } catch (error) {
    if (error.code !== 'EEXIST' || !fs.lstatSync(target).isSymbolicLink() || fs.lstatSync(target).uid !== process.getuid?.() || fs.readlinkSync(target) !== entry.link) throw new Error('Canonical link backup mismatch');
  }
  return target;
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(regular(file)); const target = `${file}.${digest(bytes)}.original`;
  if (fs.existsSync(target)) {
    if (digest(fs.readFileSync(regular(target))) !== digest(bytes)) throw new Error('Backup digest mismatch');
  } else fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o400 });
  return target;
}

/** Follow only the native daemon's known user-owned locator, then validate the actual private endpoint. */
export function resolveTerminalUpstream({ codexHome = path.join(os.homedir(), '.codex'), uid = process.getuid?.(),
  daemonRoot = terminalTempRoot() } = {}) {
  if (!path.isAbsolute(codexHome) || !path.isAbsolute(daemonRoot) || uid == null) throw new Error('Absolute owned socket locator required');
  const home = fs.realpathSync(codexHome);
  const directory = path.join(home, 'app-server-control');
  const d = fs.lstatSync(directory);
  if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== uid || (d.mode & 0o022)) throw new Error('Native socket locator directory is not owned and protected');
  const locator = path.join(directory, 'app-server-control.sock');
  const s = fs.lstatSync(locator);
  if (!s.isSymbolicLink()) return validateUpstreamSocket(locator, { uid });
  if (s.uid !== uid) throw new Error('Native socket locator is foreign');
  const actual = fs.realpathSync(locator);
  const expected = path.join(fs.realpathSync(daemonRoot), `codex-daemon-${uid}`);
  if (path.dirname(actual) !== expected || !/^[a-f0-9]{64}$/.test(path.basename(actual))) throw new Error('Native socket locator escaped the known daemon endpoint');
  return validateUpstreamSocket(actual, { uid });
}

function unmanagedShellNames(text) {
  return ['codex', 'claude'].filter((name) => new RegExp(`(?:^|\\n)\\s*(?:alias\\s+${name}\\s*=|(?:function\\s+)?${name}\\s*\\(\\s*\\)|function\\s+${name}\\s*(?:\\{|\\n))`).test(text));
}
export function terminalShellPlan(text, sourcePath, launchers) {
  const starts = text.split(START).length - 1, ends = text.split(END).length - 1;
  if (starts !== ends || starts > 1) throw new Error('Malformed managed terminal shell block');
  const block = starts ? text.slice(text.indexOf(START), text.indexOf(END) + END.length) : null;
  const outside = block ? text.replace(block, '') : text;
  const conflicts = unmanagedShellNames(outside);
  const lines = [MARKER];
  for (const name of ['codex', 'claude']) {
    if (launchers[name] && !conflicts.includes(name)) lines.push(`function ${name}() { ${quote(launchers[name])} "$@"; }`);
  }
  const managed = `${START}\nsource ${quote(sourcePath)}\n${END}`;
  return { conflicts, source: lines.join('\n') + '\n', zshrc: block ? text.replace(block, managed) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${managed}\n` };
}

/** Runtime is supplied by the snapshot installer; this module does not rebuild or mutate it. */
export function installTerminalLaunchers({ home = os.homedir(), nodeBinary = process.execPath, runtimeRoot,
  runtimeDigest, realCodex, realClaude, apply = false, manageZsh = true,
  replaceCanonicalEntries = [] } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Terminal launchers require macOS or Linux');
  if (!path.isAbsolute(home) || !path.isAbsolute(runtimeRoot || '') || !/^[a-f0-9]{64}$/.test(runtimeDigest || '')) throw new Error('Absolute home and identified runtime required');
  const configPath = path.join(home, '.cache/ruvnet-brain/model-routing/terminal-launcher-config.json');
  const previous = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(regular(configPath), 'utf8')) : null;
  if (previous && previous.managedBy !== 'ruvnet-brain-terminal-launchers') throw new Error('Preserving unmanaged terminal configuration');
  realCodex ??= previous?.realCodex || path.join(home, '.local/bin/codex');
  const runner = regular(path.join(runtimeRoot, 'scripts/model-terminal-launchers.mjs'));
  const config = { schemaVersion: 1, managedBy: 'ruvnet-brain-terminal-launchers', runtimeDigest, runtimeRoot: fs.realpathSync(runtimeRoot), nodeBinary: executable(nodeBinary),
    runner, realCodex: nativeExecutable(realCodex), gatewayPath: regular(path.join(runtimeRoot, 'scripts/model-terminal-gateway.mjs')) };
  if (realClaude) {
    config.realClaude = nativeExecutable(realClaude);
    config.claudeHelperPath = regular(path.join(runtimeRoot, 'scripts/claude-terminal-mod.mjs'));
    config.enginePath = regular(path.join(runtimeRoot, 'scripts/model-router-engine.mjs'));
  }
  const launchers = { codex: path.join(home, '.local/bin/ruvnet-brain-codex-terminal') };
  if (realClaude) launchers.claude = path.join(home, '.local/bin/ruvnet-brain-claude-terminal');
  if (!Array.isArray(replaceCanonicalEntries) || replaceCanonicalEntries.some(host => !Object.hasOwn(launchers, host))) throw new Error('Explicit installed host names required for canonical entry migration');
  const canonicalEntries = Object.fromEntries(Object.keys(launchers).map(host => [host, path.join(home, '.local/bin', host)]));
  const canonical = Object.entries(canonicalEntries).map(([host, file]) => canonicalEntry(file, config[host === 'codex' ? 'realCodex' : 'realClaude'], replaceCanonicalEntries.includes(host)));
  const contents = Object.fromEntries(Object.entries(launchers).map(([host, file]) => [file,
    `#!/bin/sh\n${MARKER}\nexec ${quote(config.nodeBinary)} ${quote(runner)} --launch ${quote(host)} --config ${quote(configPath)} -- "$@"\n`]));
  for (const [host, file] of Object.entries(canonicalEntries)) contents[file] = contents[launchers[host]];
  const shellSource = path.join(home, '.config/ruvnet-brain/terminal-routing.zsh');
  const zshrc = path.join(home, '.zshrc');
  const shell = terminalShellPlan(fs.existsSync(zshrc) ? fs.readFileSync(regular(zshrc), 'utf8') : '', shellSource, launchers);
  for (const file of [...Object.values(launchers), shellSource]) {
    if (fs.existsSync(file) && !fs.readFileSync(regular(file), 'utf8').includes(MARKER)) throw new Error(`Preserving unmanaged terminal integration: ${file}`);
  }
  for (const binary of [config.realCodex, config.realClaude].filter(Boolean)) {
    if ([runner, ...Object.keys(contents)].includes(binary)) throw new Error('Native terminal launcher recursion refused');
  }
  const receipt = { apply, launchers, canonicalEntries, configPath, config, shellSource, shellConflicts: shell.conflicts, backups: [],
    claudeEnforcementScope: realClaude ? 'Controlled native prompt boundary; model observations and effective effort settings checked for each completed turn' : null };
  if (!apply) return receipt;
  for (const file of [configPath, ...Object.values(launchers), ...(manageZsh ? [shellSource, zshrc] : [])]) {
    const original = backup(file); if (original) receipt.backups.push(original);
  }
  for (const entry of canonical) { const original = backupCanonical(entry); if (original) receipt.backups.push(original); }
  atomic(configPath, JSON.stringify(config, null, 2) + '\n');
  for (const [file, content] of Object.entries(contents)) atomic(file, content, 0o755, canonical.some(entry => entry.file === file && entry.symlink));
  if (manageZsh) { atomic(shellSource, shell.source); atomic(zshrc, shell.zshrc, fs.existsSync(zshrc) ? fs.statSync(zshrc).mode & 0o777 : 0o600); }
  return receipt;
}

/** Supported native start is idempotent; never stop, restart, update or own the shared daemon. */
export function ensureTerminalDaemon(binary, env = process.env, { exec = execFileSync } = {}) {
  try {
    exec(binary, ['app-server', 'daemon', 'start'], { env: subscriptionEnvironment(env), timeout: 10000,
      stdio: 'ignore', shell: false, maxBuffer: 65536 });
  } catch { throw new Error('Native Codex daemon start unavailable; terminal launch blocked'); }
}
export function terminalInvocation({ host, args = [], config, env = process.env, daemonExec = execFileSync }) {
  if (config.schemaVersion !== 1 || env.RNB_TERMINAL_LAUNCH_ACTIVE) throw new Error('Invalid or recursive terminal launch');
  const binary = nativeExecutable(host === 'codex' ? config.realCodex : config.realClaude);
  if (host !== 'codex') throw new Error('Use guarded native Claude launch');
  const mode = classifyTerminalArguments(args);
  if (mode === 'admin') return { command: binary, args: [...args], routed: false };
  // Validate provider/transport overrides before native daemon startup has any side effect.
  nativeGatewayLaunch({ harness: 'codex', realBinary: binary, args: ['app-server', ...args], env: subscriptionEnvironment(env) });
  ensureTerminalDaemon(binary, env, { exec: daemonExec });
  const upstream = resolveTerminalUpstream({ codexHome: env.CODEX_HOME || path.join(os.homedir(), '.codex') });
  return { command: executable(config.nodeBinary), args: [regular(config.gatewayPath), '--real-binary', binary, '--upstream-socket', upstream, '--', ...args], routed: true };
}

export function verifyNativeWorkerAncestry(workerPid, nativePid, { uid = process.getuid?.() } = {}) {
  if (![workerPid, nativePid, uid].every(Number.isSafeInteger) || workerPid <= 0 || nativePid <= 0) return false;
  let current = workerPid;
  for (let depth = 0; depth < 12; depth++) {
    let result;
    try { result = execFileSync('/bin/ps', ['-o', 'uid=,ppid=', '-p', String(current)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return false; }
    const match = /^(\d+)\s+(\d+)$/.exec(result);
    if (!match || Number(match[1]) !== uid) return false;
    if (current === nativePid) return true;
    const parent = Number(match[2]); if (parent <= 1 || parent === current) return false;
    current = parent;
  }
  return false;
}
export function validateClaudeReadiness(file, { nonce, pluginDir, modDigest, pid, startedAt, now = Date.now() }) {
  const receipt = JSON.parse(fs.readFileSync(regular(file, { privateFile: true }), 'utf8'));
  const observed = Date.parse(receipt.observedAt);
  if (receipt.schemaVersion !== 1 || receipt.nonce !== nonce || receipt.pluginRoot !== fs.realpathSync(pluginDir) ||
      receipt.modDigest !== modDigest || !verifyNativeWorkerAncestry(receipt.pid, pid) || receipt.status !== 'ready' ||
      !/^2\.1\.\d+$/.test(receipt.nativeVersion || '') || Number(receipt.nativeVersion.split('.')[2]) < 287 ||
      typeof receipt.sessionId !== 'string' || !receipt.sessionId || !Number.isFinite(observed) ||
      observed < startedAt || observed > now || now - observed > 10000) throw new Error('Native Claude hook activation receipt invalid');
  return receipt;
}
function exitOf(child) {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
}
function forwardSignals(child, source) {
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => child.kill(signal)]));
  handlers.forEach((handler, signal) => source.on(signal, handler));
  return () => handlers.forEach((handler, signal) => source.removeListener(signal, handler));
}

export function validateClaudeTerminalSettings({ env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  for (const key of ['CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_HOOKS', 'DISABLE_CLAUDE_CODE_MODS']) {
    if (env[key] && !['0', 'false'].includes(env[key])) throw new Error('Claude environment disables native routing hooks');
  }
  const files = new Set([path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
    process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json']);
  let directory = path.resolve(cwd);
  while (true) {
    for (const name of ['settings.json', 'settings.local.json']) files.add(path.join(directory, '.claude', name));
    if (directory === path.dirname(directory)) break;
    directory = path.dirname(directory);
  }
  const billing = /^(?:OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|CODEX_API_KEY|CLAUDE_CODE_SAFE_MODE|CLAUDE_CODE_SIMPLE|CLAUDE_CODE_DISABLE_HOOKS|DISABLE_CLAUDE_CODE_MODS)$/;
  const unsafe = (value) => value && typeof value === 'object' && Object.entries(value).some(([key, entry]) => {
    if (key === 'env') return !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((name) => billing.test(name));
    // The user's native modelSettings are ordinary model-keyed effort settings; the mod selects each turn.
    if (key === 'modelSettings') return !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.entries(entry).some(([model, settings]) =>
      !/^claude-[a-z0-9][a-z0-9.-]*$/.test(model) || !settings || typeof settings !== 'object' || Array.isArray(settings) ||
      Object.entries(settings).some(([name, level]) => name !== 'effortLevel' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(level)));
    return /^(?:apiKeyHelper|api_?key|base_?url|auth_?token|customHeaders|modelProvider|model_providers|alwaysThinkingEnabled|maxEffortLevel)$/i.test(key) ||
      key === 'fastMode' && entry !== false || unsafe(entry);
  });
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Claude settings must be regular files');
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Claude settings unavailable or malformed'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || unsafe(settings)) throw new Error('Claude settings conflict with native subscription routing');
  }
  return [...files];
}
export function validateClaudeTerminalArguments(args) {
  const flags = new Set(['--continue', '-c', '--resume', '-r', '--fork-session', '--no-session-persistence',
    '--verbose', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);
  const values = new Set(['--permission-mode', '--session-id', '--add-dir']);
  const commands = new Set(['agents', 'remote-control', 'setup-token', 'serve', 'web', 'bridge', 'completion',
    'attach', 'auto-mode', 'gateway', 'import', 'logs', 'purge', 'respawn', 'rm', 'stop', 'kill', 'ultrareview']);
  const options = [], prompts = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { prompts.push(...args.slice(index + 1)); break; }
    if (values.has(arg)) { if (!args[++index] || args[index].startsWith('-')) throw new Error('Claude terminal flag requires a value'); options.push(arg, args[index]); continue; }
    if (arg.startsWith('-') && !flags.has(arg) || commands.has(arg)) throw new Error('Claude terminal arguments conflict with guarded native routing');
    if (flags.has(arg)) {
      options.push(arg);
      if (['--resume', '-r'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('-')) options.push(args[++index]);
    } else prompts.push(arg);
  }
  return { options, prompts };
}

function claudeAdministrativeArguments(args) {
  const administrativeArgs = args[0] === '--permission-mode' && args[1] === 'bypassPermissions' ? args.slice(2) : args;
  const information = new Set(['--help', '-h', '--version', '-v']);
  const ownerPermissionFlags = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']);
  return administrativeArgs.some(arg => information.has(arg)) &&
    administrativeArgs.every(arg => information.has(arg) || ownerPermissionFlags.has(arg)) ||
    ['auth', 'mcp', 'plugin', 'plugins', 'update', 'upgrade', 'doctor', 'install'].includes(administrativeArgs[0]);
}

/** Native plugin startup only: an unloaded/crashed native worker may skip subsequent hooks. */
export async function runClaudeTerminal({ config, args = [], env = process.env, startupMs = 10000,
  tempRoot = os.tmpdir(), cwd = process.cwd(), signalSource = process, diagnostics = process.stderr } = {}) {
  if (env.RNB_TERMINAL_LAUNCH_ACTIVE) throw new Error('Native terminal launcher recursion refused');
  if (!Number.isFinite(startupMs) || startupMs <= 0 || startupMs > 60000) throw new Error('Bounded native hook startup deadline required');
  const binary = nativeExecutable(config.realClaude), clean = subscriptionEnvironment(env);
  if (claudeAdministrativeArguments(args)) {
    const child = spawn(binary, args, { env: clean, cwd, stdio: 'inherit', shell: false });
    const unforward = forwardSignals(child, signalSource);
    try { return await exitOf(child); } finally { unforward(); }
  }
  const parsed = validateClaudeTerminalArguments(args);
  validateClaudeTerminalSettings({ env: clean, cwd });
  assertSubscriptionAuth('claude-code', { env: clean, probe: (_name, probeArgs, options) => execFileSync(binary, probeArgs, { ...options, cwd }) });
  const { prepareClaudeTerminalMod } = await import(pathToFileURL(regular(config.claudeHelperPath)).href);
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(tempRoot), 'rnb-claude-')); fs.chmodSync(directory, 0o700);
  let child, unforward = () => {}, timer, killer;
  try {
    const prepared = prepareClaudeTerminalMod({ destination: path.join(directory, 'plugin'), nodePath: executable(config.nodeBinary),
      helperPath: regular(config.claudeHelperPath), enginePath: regular(config.enginePath) });
    const receiptPath = path.join(directory, 'ready.json'), nonce = crypto.randomBytes(32).toString('hex'), startedAt = Date.now();
    Object.assign(clean, { RNB_TERMINAL_LAUNCH_ACTIVE: '1', RNB_CLAUDE_MOD_NONCE: nonce, RNB_CLAUDE_MOD_RECEIPT: receiptPath });
    child = spawn(binary, [...parsed.options, '--plugin-dir', prepared.pluginDir, '--', ...parsed.prompts], { env: clean, cwd, stdio: 'inherit', shell: false });
    const exited = exitOf(child); unforward = forwardSignals(child, signalSource);
    let failure, readiness;
    const guard = new Promise((resolve) => {
      const check = () => {
        try {
          if (fs.existsSync(receiptPath)) { readiness = validateClaudeReadiness(receiptPath, { nonce, ...prepared, pid: child.pid, startedAt }); resolve(); return; }
          if (Date.now() - startedAt >= startupMs) throw new Error('Native Claude hook activation was not acknowledged');
          timer = setTimeout(check, 25);
        } catch (error) { failure = error; resolve(); }
      }; check();
    });
    const early = await Promise.race([guard.then(() => null), exited]);
    if (early && !readiness) throw new Error('Native Claude exited before hook activation');
    if (failure) {
      child.kill('SIGTERM'); killer = setTimeout(() => child.kill('SIGKILL'), 1000);
      await exited; throw failure;
    }
    diagnostics.write('[native-terminal-routing] Claude startup hooks acknowledged; continuing worker enforcement is not established by this receipt.\n');
    return { ...(early || await exited), readinessReceipt: readiness };
  } finally {
    clearTimeout(timer); clearTimeout(killer); unforward();
    if (child && child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function runTerminalLauncher({ host, args = [], config, env = process.env, signalSource = process } = {}) {
  if (host === 'claude') {
    if (claudeAdministrativeArguments(args)) return runClaudeTerminal({ config, args, env, signalSource });
    if (env.RNB_TERMINAL_LAUNCH_ACTIVE) throw new Error('Native terminal launcher recursion refused');
    const { launchControlledClaudeTerminal } = await import('./claude-controlled-terminal.mjs');
    await launchControlledClaudeTerminal({ binary: nativeExecutable(config.realClaude), args, env, cwd: process.cwd() });
    return { code: 0, signal: null };
  }
  if (host !== 'codex') throw new Error('Unsupported terminal host');
  const classification = classifyTerminalArguments(args);
  if (classification === 'interactive') {
    if (env.RNB_TERMINAL_LAUNCH_ACTIVE) throw new Error('Native terminal launcher recursion refused');
    const { launchManagedCodexTerminal } = await import('./codex-managed-terminal.mjs');
    await launchManagedCodexTerminal({ binary: nativeExecutable(config.realCodex), args, env, cwd: process.cwd() });
    return { code: 0, signal: null };
  }
  const invocation = terminalInvocation({ host, args, config, env });
  const child = spawn(invocation.command, invocation.args, { env: { ...subscriptionEnvironment(env), RNB_TERMINAL_LAUNCH_ACTIVE: '1' }, stdio: 'inherit', shell: false });
  const unforward = forwardSignals(child, signalSource);
  try { return await exitOf(child); } finally { unforward(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (argv[0] !== '--launch' || argv[2] !== '--config' || argv[4] !== '--') throw new Error('Explicit host/config terminal launcher required');
    const config = JSON.parse(fs.readFileSync(regular(argv[3], { privateFile: true }), 'utf8'));
    return runTerminalLauncher({ host: argv[1], args: argv.slice(5), config });
  }).then(({ code, signal }) => {
    if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1;
  }).catch((error) => { process.stderr.write(`[native-terminal-routing] ${error.message}\n`); process.exitCode = 1; });
}
