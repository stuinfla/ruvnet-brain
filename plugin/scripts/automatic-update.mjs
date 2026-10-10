// Owner-only automatic update policy. Project settings and inherited package-manager paths
// cannot choose executable code or relax the signed corpus updater's compatibility checks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { developerCoordinatorOwner } from './developer-update-owner.mjs';
import { SETTINGS_VERSION, validate, saveSettings } from './user-settings.mjs';

export const ownerSettingsPath = (home = os.homedir()) => path.join(home, '.config', 'ruvnet-brain', 'settings.json');
export function updateSource({ home = os.homedir(), read = fs.readFileSync, validatePolicy = validate } = {}) {
  const file = ownerSettingsPath(home);
  let descriptor; let captured;
  try {
    let before;
    try { before = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return 'latest'; throw error; }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('owner settings must be a regular file, not a symlink');
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino
      || (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022)))) {
      throw new Error('owner settings identity or permissions are unsafe');
    }
    captured = JSON.parse(read(descriptor, 'utf8'));
  } catch (error) { throw new Error(`owner update settings are unreadable or invalid: ${error.message}`); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  if (!captured || Array.isArray(captured) || captured.version !== SETTINGS_VERSION
    || !captured.settings || Array.isArray(captured.settings) || typeof captured.settings !== 'object') {
    throw new Error('automatic update source is unproven: owner settings envelope is invalid or from another version');
  }
  const state = validatePolicy(captured.settings);
  if (!state.ok) throw new Error('automatic update source is unproven: owner settings are invalid');
  const source = state.values.updateSource;
  if (!['latest', 'installed'].includes(source)) throw new Error('automatic update source is not supported by this runtime');
  return source;
}

export function saveUpdateSource(source, { home = os.homedir() } = {}) {
  if (!['latest', 'installed'].includes(source)) throw new Error('--update-source must be latest or installed');
  const result = saveSettings({ updateSource: source }, { file: ownerSettingsPath(home) });
  if (!result.ok || result.values.updateSource !== source) throw new Error(result.log || 'update source was not persisted');
  return result;
}

export function automaticPath({ nodePath = process.execPath, home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const paths = [path.dirname(nodePath), path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin')];
  if (platform === 'win32') {
    const system = env.SystemRoot || env.SYSTEMROOT;
    if (system && path.win32.isAbsolute(system)) paths.push(system, path.join(system, 'System32'));
  } else paths.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return [...new Set(paths)].join(path.delimiter);
}

export function stableNode({ executable = process.execPath, explicit, realpath = fs.realpathSync, run = spawnSync } = {}) {
  let candidate = explicit || executable;
  if (!explicit) {
    const cellar = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/.exec(executable);
    if (cellar) candidate = path.join(cellar[1], 'opt', cellar[2], 'bin', 'node');
    else if (/[\\/](?:\.nvm[\\/]versions|\.npm[\\/]_npx|\.volta[\\/]tools[\\/]image|\.fnm[\\/]node-versions)[\\/]/.test(executable)) {
      throw new Error('automatic updates need a stable Node path; pass --nightly-node /absolute/stable/node');
    }
  }
  if (!path.isAbsolute(candidate)) throw new Error('nightly Node path must be absolute');
  try {
    if (realpath(candidate) !== realpath(executable)) throw new Error('selected Node does not resolve to the running installer Node');
  } catch (error) { throw new Error(`stable Node is unavailable or mismatched: ${error.message}`); }
  const version = run(candidate, ['--version'], { encoding: 'utf8', timeout: 5000,
    env: { PATH: automaticPath({ nodePath: candidate }), SystemRoot: process.env.SystemRoot || '' } });
  if (version.error || version.status !== 0 || !/^v(\d+)\./.test(String(version.stdout).trim())
    || Number(/^v(\d+)\./.exec(String(version.stdout).trim())[1]) < 18) throw new Error('automatic updates require supported Node 18 or newer');
  return candidate;
}

export function installedUpdater({ home = os.homedir(), platform = process.platform } = {}) {
  const root = path.join(home, '.npm-global', ...(platform === 'win32' ? [] : ['lib']), 'node_modules', 'ruvnet-brain');
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const declared = manifest.bin?.['ruvnet-brain'];
  if (manifest.name !== 'ruvnet-brain' || typeof declared !== 'string' || !declared
    || path.isAbsolute(declared) || path.win32.isAbsolute(declared) || declared.split(/[\\/]/).includes('..')) {
    throw new Error('installed update source has no safe declared Brain entrypoint');
  }
  const actualRoot = fs.realpathSync(root);
  const entry = fs.realpathSync(path.resolve(root, declared));
  const relative = path.relative(actualRoot, entry);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) {
    throw new Error('installed Brain entrypoint escapes its owner installation');
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
  return { entry, version: manifest.version, sha256 };
}

export function automaticInvocation(args, { source = updateSource(), home = os.homedir(), nodePath = process.execPath,
  packageTarget = 'ruvnet-brain@latest' } = {}) {
  if (packageTarget === 'ruvnet-brain@latest') {
    const coordinator = developerCoordinatorOwner({ home });
    if (coordinator.active) {
      if (!coordinator.ready) throw new Error(`coordinated updater is not ready: ${coordinator.reason}`);
      return { executable: nodePath, args: [coordinator.entry, '--apply'], source: 'developer-suite', coordinator };
    }
  }
  if (source === 'installed') {
    if (packageTarget !== 'ruvnet-brain@latest') throw new Error('installed mode cannot select a proof tarball');
    const installed = installedUpdater({ home });
    return { executable: nodePath, args: [installed.entry, ...args], source, installed };
  }
  if (source !== 'latest') throw new Error('invalid automatic update source');
  const name = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const ownerNpx = path.join(home, '.npm-global', 'bin', name);
  const adjacent = fs.existsSync(ownerNpx) ? ownerNpx : path.join(path.dirname(nodePath), name);
  if (process.platform === 'win32') {
    try {
      const shim = fs.existsSync(adjacent) ? adjacent : automaticPath({ nodePath, home }).split(path.delimiter)
        .map(dir => path.join(dir, name)).find(candidate => fs.existsSync(candidate));
      if (!shim) throw new Error('managed npm npx shim is missing');
      const root = fs.realpathSync(path.join(path.dirname(fs.realpathSync(shim)), 'node_modules', 'npm'));
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const declared = manifest.bin?.npx;
      if (manifest.name !== 'npm' || typeof declared !== 'string' || !declared || path.isAbsolute(declared)
        || path.win32.isAbsolute(declared) || declared.split(/[\\/]/).includes('..')) throw new Error('unsafe npm npx entry');
      const entry = fs.realpathSync(path.resolve(root, declared));
      const relative = path.relative(root, entry);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) {
        throw new Error('managed npm npx entry escapes its package');
      }
      return { executable: nodePath, args: [entry, '--yes', packageTarget, ...args], source };
    } catch (error) { throw new Error(`could not resolve managed npm: ${error.message}`); }
  }
  return { executable: fs.existsSync(adjacent) ? adjacent : name,
    args: ['--yes', packageTarget, ...args], source };
}
