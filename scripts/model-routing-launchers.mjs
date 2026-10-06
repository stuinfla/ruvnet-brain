#!/usr/bin/env node
// Permanent POSIX native launchers (macOS/Linux). Windows shell launchers are unsupported.
// Explicit installation only; no login/Keychain changes.
// VS Code Codex APPLICATION settings belong on the UI client; Claude MACHINE settings
// belong on the extension host. A saved setting is not proof an existing process reloaded.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SELF = fileURLToPath(import.meta.url);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const KEYS = { codex: 'chatgpt.cliExecutable', 'claude-code': 'claudeCode.claudeProcessWrapper' };

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Regular file required: ${file}`);
  return fs.realpathSync(file);
}

export function discoverNativeCodex(extensionsRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionsRoot, 'extensions.json'), 'utf8'));
  const entries = manifest.filter((entry) => entry.identifier?.id === 'openai.chatgpt');
  if (entries.length !== 1) throw new Error('Exactly one registered Codex extension required');
  const extension = fs.realpathSync(entries[0].location.path);
  const root = fs.realpathSync(extensionsRoot);
  if (!extension.startsWith(`${root}${path.sep}`)) throw new Error('Registered extension escaped extension root');
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  const binary = regular(path.join(extension, 'bin', `${platform}-${arch}`, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  fs.accessSync(binary, fs.constants.X_OK);
  return binary;
}

export function launcherInvocation({ harness, args, config, launcherPath }) {
  let nativeArgs = [...args]; let binary;
  if (harness === 'codex') binary = discoverNativeCodex(config.extensionsRoot);
  else if (harness === 'claude-code') {
    if (!path.isAbsolute(nativeArgs[0] || '')) throw new Error('Claude wrapper requires the native binary as its first argument');
    binary = regular(nativeArgs.shift());
    const root = fs.realpathSync(config.extensionsRoot);
    if (!binary.startsWith(`${root}${path.sep}`) || path.basename(binary) !== (process.platform === 'win32' ? 'claude.exe' : 'claude')) throw new Error('Claude wrapper binary is not an extension native executable');
  } else throw new Error('Unsupported native host');
  if (binary === fs.realpathSync(launcherPath) || binary === fs.realpathSync(SELF)) throw new Error('Native launcher recursion refused');
  // These extension probes/transport bridges do not submit model turns.
  const probe = nativeArgs.length === 1 && ['--version', '--help'].includes(nativeArgs[0]);
  const bridge = harness === 'codex' && nativeArgs.length === 2 && nativeArgs[0] === 'stdio-to-uds';
  if (probe || bridge) return { command: binary, args: nativeArgs, routed: false };
  regular(config.gatewayPath);
  return { command: config.nodeBinary, args: [config.gatewayPath, '--harness', harness, '--real-binary', binary, '--', ...nativeArgs], routed: true };
}

function atomic(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) regular(file);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  // Windows cannot fsync a directory handle through Node. The file was flushed
  // above and replacement remains atomic; POSIX additionally flushes the directory.
  if (process.platform === 'win32') return;
  const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  regular(file);
  const bytes = fs.readFileSync(file); const target = `${file}.${sha(bytes)}.original`;
  if (fs.existsSync(target)) { if (sha(fs.readFileSync(regular(target))) !== sha(bytes)) throw new Error('Backup digest mismatch'); }
  else { const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o400);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  return target;
}

/** Collect native gateway, policy engine and their literal local dependencies into an immutable snapshot. */
export function runtimeSnapshot(sourceRoot) {
  const root = fs.realpathSync(sourceRoot); const files = new Map();
  const visit = (relative) => {
    relative = relative.split(path.sep).join('/');
    if (files.has(relative)) return;
    const file = regular(path.join(root, relative));
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Runtime dependency escaped source root');
    const bytes = fs.readFileSync(file); files.set(relative, bytes);
    for (const match of bytes.toString().matchAll(/(?:from\s*|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      visit(path.relative(root, path.resolve(path.dirname(file), match[1])));
    }
  };
  for (const relative of ['scripts/model-routing-gateway.mjs', 'scripts/model-router-engine.mjs', 'scripts/metaharness-router.mjs']) visit(relative);
  for (const relative of ['scripts/model-terminal-gateway.mjs', 'scripts/claude-terminal-mod.mjs', 'scripts/model-terminal-launchers.mjs']) {
    if (fs.existsSync(path.join(root, relative))) visit(relative);
  }
  const mod = 'config/model-router/claude-terminal-mod';
  if (fs.existsSync(path.join(root, mod))) {
    for (const relative of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js', 'hooks/routing.js', 'hooks/runtime.js']) visit(`${mod}/${relative}`);
  }
  // The socket adapter must resolve its transport from the same immutable closure.
  // Optional native accelerators are deliberately excluded; ws supports pure JS.
  if (files.has('scripts/model-terminal-gateway.mjs')) {
    const require = createRequire(path.join(root, 'package.json'));
    const packageRoot = path.dirname(regular(require.resolve('ws/package.json')));
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
    if (packageJson.name !== 'ws') throw new Error('Unexpected WebSocket dependency identity');
    for (const relative of ['package.json', 'LICENSE', 'index.js', 'wrapper.mjs', 'browser.js',
      ...fs.readdirSync(path.join(packageRoot, 'lib')).filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`)]) {
      const file = regular(path.join(packageRoot, relative));
      if (!file.startsWith(`${packageRoot}${path.sep}`)) throw new Error('WebSocket dependency escaped package root');
      files.set(`node_modules/ws/${relative}`, fs.readFileSync(file));
    }
  }
  // Freeze the installed managed runner with this runtime; no global-version drift or download.
  if (files.has('scripts/model-routing-controller.mjs')) {
    const require = createRequire(path.join(root, 'package.json'));
    const kitRoot = path.dirname(regular(require.resolve('@pacphi/agentic-kit/package.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(kitRoot, 'package.json')));
    if (manifest.name !== '@pacphi/agentic-kit') throw new Error('Unexpected managed runner identity');
    const collect = relative => {
      const absolute = path.join(kitRoot, relative), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Managed runner dependency symlink refused');
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(absolute)) if (name !== 'node_modules') collect(path.join(relative, name));
      } else if (stat.isFile()) files.set(`node_modules/@pacphi/agentic-kit/${relative.split(path.sep).join('/')}`, fs.readFileSync(absolute));
      else throw new Error('Nonregular managed runner dependency');
    };
    collect('package.json'); collect('src');
  }
  if (files.has('scripts/model-routing-defence.mjs')) {
    const defenceEntry = regular(fileURLToPath(import.meta.resolve('@claude-flow/aidefence')));
    const defenceRoot = path.dirname(path.dirname(defenceEntry));
    const manifest = JSON.parse(fs.readFileSync(path.join(defenceRoot, 'package.json')));
    if (manifest.name !== '@claude-flow/aidefence') throw new Error('Unexpected local defence identity');
    const collect = relative => {
      const absolute = path.join(defenceRoot, relative), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Defence dependency symlink refused');
      if (stat.isDirectory()) { for (const name of fs.readdirSync(absolute)) collect(path.join(relative, name)); }
      else if (stat.isFile()) files.set(`node_modules/@claude-flow/aidefence/${relative.split(path.sep).join('/')}`, fs.readFileSync(absolute));
      else throw new Error('Nonregular defence dependency');
    };
    collect('package.json'); collect('dist');
  }
  for (const name of fs.readdirSync(path.join(root, 'config/model-router'))) {
    if (/\.(?:json|mjs)$/.test(name)) visit(`config/model-router/${name}`);
  }
  const identity = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => [file, sha(bytes)]);
  return { files, identity, digest: sha(JSON.stringify(identity)) };
}

function stableNode() {
  for (const file of ['/opt/homebrew/bin/node', process.execPath]) {
    try { if (fs.realpathSync(file) === fs.realpathSync(process.execPath)) return file; } catch {}
  }
  return process.execPath;
}

/** Terminal routing does not require a VS Code extension installation. */
export function installRoutingRuntime({ sourceRoot, home = os.homedir(), apply = false } = {}) {
  const snapshot = runtimeSnapshot(sourceRoot);
  const runtimeRoot = path.join(home, '.cache/ruvnet-brain/model-routing/versions', snapshot.digest);
  if (apply) for (const [relative, bytes] of snapshot.files) {
    const file = path.join(runtimeRoot, relative);
    if (fs.existsSync(file)) {
      if (sha(fs.readFileSync(regular(file))) !== sha(bytes)) throw new Error('Immutable runtime snapshot mismatch');
    } else atomic(file, bytes);
  }
  return { apply, runtimeRoot, runtimeDigest: snapshot.digest, runtimeFiles: snapshot.identity };
}

export function installNativeLaunchers({ sourceRoot, home = os.homedir(), extensionsRoot = path.join(home, '.vscode-server/extensions'), nodeBinary = stableNode(), apply = false } = {}) {
  // VS Code spawns its executable directly. A .cmd/.sh surrogate is not a proved
  // Windows executable adapter; refuse before writing a misleading registration.
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Permanent native routing launchers support macOS/Linux only; Windows executable adapter is not implemented');
  const snapshot = runtimeSnapshot(sourceRoot);
  const base = path.join(home, '.cache/ruvnet-brain/model-routing');
  const runtime = path.join(base, 'versions', snapshot.digest);
  const runner = path.join(base, 'model-routing-launchers.mjs');
  const configPath = path.join(base, 'launcher-config.json');
  const config = { extensionsRoot: fs.realpathSync(extensionsRoot), nodeBinary: (regular(fs.realpathSync(nodeBinary)), nodeBinary), gatewayPath: path.join(runtime, 'scripts/model-routing-gateway.mjs'), terminalGatewayPath: path.join(runtime, 'scripts/model-terminal-gateway.mjs'), runtimeRoot: runtime, runtimeDigest: snapshot.digest };
  const codexBinary = discoverNativeCodex(config.extensionsRoot);
  const launchers = Object.fromEntries(Object.keys(KEYS).map((host) => [host, path.join(home, '.local/bin', `ruvnet-brain-${host === 'codex' ? 'codex' : 'claude'}-gateway`)]));
  const texts = Object.fromEntries(Object.entries(launchers).map(([host]) => [host, `#!/bin/sh\n# Managed RuvNet Brain native routing launcher\nexec ${shellQuote(config.nodeBinary)} ${shellQuote(runner)} --launch ${shellQuote(host)} --config ${shellQuote(configPath)} --launcher "$0" -- "$@"\n`]));
  for (const [host, file] of Object.entries(launchers)) {
    if (fs.existsSync(file) && !fs.readFileSync(regular(file), 'utf8').includes('# Managed RuvNet Brain native routing launcher')) throw new Error(`Preserving unmanaged launcher: ${file}`);
  }
  const receipt = { apply, launchers, config, codexBinary, settings: Object.fromEntries(Object.entries(KEYS).map(([host, key]) => [key, launchers[host]])), runtimeFiles: snapshot.identity };
  if (!apply) return receipt;
  for (const [relative, bytes] of snapshot.files) {
    const file = path.join(runtime, relative);
    if (fs.existsSync(file)) { if (sha(fs.readFileSync(regular(file))) !== sha(bytes)) throw new Error('Immutable runtime snapshot mismatch'); }
    else atomic(file, bytes);
  }
  for (const file of [runner, configPath, ...Object.values(launchers)]) backup(file);
  atomic(runner, fs.readFileSync(SELF)); atomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  for (const [host, file] of Object.entries(launchers)) atomic(file, texts[host], 0o755);
  return receipt;
}

/** Apply only absent or identical settings. Conflicting user overrides are preserved and disclosed. */
export function updateLauncherSettings(file, requested, { apply = false } = {}) {
  const text = fs.existsSync(file) ? fs.readFileSync(regular(file), 'utf8') : '{}\n';
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error('Settings are JSONC or malformed; refusing a destructive rewrite'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings object required');
  const add = {}; const preserved = {};
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.values(KEYS).includes(key)) throw new Error('Unsupported launcher setting');
    if (settings[key] === undefined || settings[key] === null || settings[key] === '') add[key] = value;
    else if (settings[key] !== value) preserved[key] = settings[key];
  }
  Object.assign(settings, add);
  const changed = Object.keys(add).length > 0;
  const receipt = { file, apply, changed, preservedOverrides: preserved, settings: requested, backup: null };
  if (apply && changed) { receipt.backup = backup(file); atomic(file, `${JSON.stringify(settings, null, 2)}\n`, fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600); }
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--launch') {
    try {
      const harness = argv[1]; const configPath = argv[3]; const launcherPath = argv[5];
      if (argv[2] !== '--config' || argv[4] !== '--launcher' || argv[6] !== '--') throw new Error('Invalid launcher arguments');
      const invocation = launcherInvocation({ harness, args: argv.slice(7), config: JSON.parse(fs.readFileSync(regular(configPath))), launcherPath });
      const child = spawn(invocation.command, invocation.args, { stdio: 'inherit', shell: false, env: process.env });
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
      child.once('error', () => { process.stderr.write('Native routing launcher unavailable\n'); process.exitCode = 1; });
      child.once('exit', (code) => { process.exitCode = code ?? 1; });
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  } else {
    try {
      const apply = argv.includes('--apply'); const sourceAt = argv.indexOf('--source-root');
      if (sourceAt < 0 || !argv[sourceAt + 1] || argv.some((arg, i) => !['--apply', '--source-root'].includes(arg) && i !== sourceAt + 1)) throw new Error('Usage: model-routing-launchers.mjs --source-root ABSOLUTE_PATH [--apply]');
      console.log(JSON.stringify(installNativeLaunchers({ sourceRoot: argv[sourceAt + 1], apply }), null, 2));
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
