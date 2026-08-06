#!/usr/bin/env node
// runtime-preferences.mjs — one policy boundary for every live Brain control.
//
// The console records intent. Runtime code asks this module what is allowed. Keeping that read in
// one place prevents routing, QE, learning, and first-open initialization from each inventing a
// subtly different default. Secrets are deliberately separate: ordinary settings and their backup
// journal must never contain an API key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_HOME = os.homedir();
const PROJECT_FILE = '.swarm/ruvnet-brain-settings.json';
const PROJECT_KEYS = Object.freeze([
  'routing',
  'qeFleet',
  'learningScope',
  'autoApply',
  'advocacy',
  'provider',
]);

const readJSON = (file) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

export function preferencePaths({ env = process.env, cwd = process.cwd() } = {}) {
  const home = env.HOME || DEFAULT_HOME;
  return {
    config: env.RUVNET_BRAIN_CONFIG_FILE
      || path.join(home, '.claude', 'ruvnet-brain', 'config.json'),
    settings: env.RUVNET_SETTINGS_FILE
      || path.join(home, '.config', 'ruvnet-brain', 'settings.json'),
    secrets: env.RUVNET_BRAIN_SECRETS_FILE
      || path.join(home, '.config', 'ruvnet-brain', 'secrets.enc.json'),
    project: env.RUVNET_BRAIN_PROJECT_SETTINGS_FILE
      || path.join(cwd, PROJECT_FILE),
    ageIdentity: env.SOPS_AGE_KEY_FILE
      || path.join(home, '.config', 'sops', 'age', 'keys.txt'),
  };
}

function validConfig(raw = {}) {
  return {
    provider: ['auto', 'anthropic', 'openai', 'codex', 'google', 'xai'].includes(raw.provider)
      ? raw.provider : null,
    routing: raw.routing === 'auto' || raw.routing === 'off' ? raw.routing : null,
    qeFleet: typeof raw.qeFleet === 'boolean' ? raw.qeFleet : null,
    nightly: typeof raw.nightly === 'boolean' ? raw.nightly : null,
  };
}

function validSettings(raw = {}) {
  const source = raw.settings && typeof raw.settings === 'object' ? raw.settings : raw;
  return {
    learningScope: ['off', 'project', 'user'].includes(source.learningScope)
      ? source.learningScope : 'project',
    autoApply: source.autoApply === true,
    newProjectDefaults: source.newProjectDefaults === true,
    advocacy: Number.isInteger(source.advocacy) && source.advocacy >= 1 && source.advocacy <= 5
      ? source.advocacy : 3,
    // ADR-063 / issue #103. Unknown keys are DROPPED by this function, so a setting absent here is
    // silently unreadable no matter what the Console writes — which is how the first cut of the
    // managed-memory boundary read `advise` even when the file said `block`.
    //
    // NOTE THE DUPLICATION, deliberately not "fixed" here: scripts/user-settings.mjs SETTINGS_SCHEMA
    // is the authority for these keys and this is a second enumeration of it. Deriving one from the
    // other is the obvious move and it is the WRONG one — this file ships inside plugin/, that one
    // does not, so the import would resolve in the checkout and throw ERR_MODULE_NOT_FOUND on a real
    // install. Same trap as kb/forge-update.mjs reaching for ../scripts. The honest fix is a drift
    // test that reads both files, not a bridge that breaks installs.
    managedMemoryBoundary: ['advise', 'read-only', 'block'].includes(source.managedMemoryBoundary)
      ? source.managedMemoryBoundary : 'advise',
  };
}

function validProject(raw = {}) {
  const out = {};
  if (raw.routing === 'auto' || raw.routing === 'off') out.routing = raw.routing;
  if (typeof raw.qeFleet === 'boolean') out.qeFleet = raw.qeFleet;
  if (['off', 'project', 'user'].includes(raw.learningScope)) out.learningScope = raw.learningScope;
  if (typeof raw.autoApply === 'boolean') out.autoApply = raw.autoApply;
  if (Number.isInteger(raw.advocacy) && raw.advocacy >= 1 && raw.advocacy <= 5) out.advocacy = raw.advocacy;
  if (['auto', 'anthropic', 'openai', 'codex', 'google', 'xai'].includes(raw.provider)) out.provider = raw.provider;
  return out;
}

export function loadRuntimePreferences(options = {}) {
  const paths = preferencePaths(options);
  const config = validConfig(readJSON(paths.config) || {});
  const settings = validSettings(readJSON(paths.settings) || {});
  const projectRaw = readJSON(paths.project);
  const project = projectRaw ? validProject(projectRaw.values || projectRaw) : {};
  return {
    values: { ...config, ...settings, ...project },
    chosen: {
      routing: config.routing !== null || Object.hasOwn(project, 'routing'),
      qeFleet: config.qeFleet !== null || Object.hasOwn(project, 'qeFleet'),
      nightly: config.nightly !== null,
    },
    paths,
    projectInherited: !!projectRaw,
  };
}

function commandExists(command, env) {
  const probe = spawnSync(command, ['--version'], {
    env,
    encoding: 'utf8',
    shell: false,
    timeout: 3000,
  });
  return !probe.error && probe.status === 0;
}

function decryptSecrets(paths, env) {
  if (!fs.existsSync(paths.secrets) || !commandExists('sops', env)) return {};
  const run = spawnSync('sops', ['decrypt', '--input-type', 'json', '--output-type', 'json', paths.secrets], {
    env,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });
  if (run.status !== 0) return {};
  return readJSONString(run.stdout);
}

function readJSONString(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function openRouterCredentialStatus(options = {}) {
  const env = options.env || process.env;
  if (typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim()) {
    return { configured: true, source: 'environment', legacyPlaintext: false };
  }
  const paths = preferencePaths(options);
  const encrypted = decryptSecrets(paths, env);
  if (typeof encrypted.OPENROUTER_API_KEY === 'string' && encrypted.OPENROUTER_API_KEY.trim()) {
    return { configured: true, source: 'sops-age', legacyPlaintext: false };
  }
  const legacy = readJSON(paths.config);
  return {
    configured: typeof legacy?.openrouterKey === 'string' && legacy.openrouterKey.trim().length > 8,
    source: legacy?.openrouterKey ? 'legacy-plaintext' : null,
    legacyPlaintext: !!legacy?.openrouterKey,
  };
}

export function runtimeChildEnv(options = {}) {
  const env = { ...(options.env || process.env) };
  if (typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim()) return env;
  const paths = preferencePaths({ ...options, env });
  const encrypted = decryptSecrets(paths, env);
  if (typeof encrypted.OPENROUTER_API_KEY === 'string' && encrypted.OPENROUTER_API_KEY.trim()) {
    env.OPENROUTER_API_KEY = encrypted.OPENROUTER_API_KEY.trim();
    return env;
  }
  // Read-only migration compatibility. The legacy value is consumed but never copied into a new
  // file or returned to the caller; the console marks it for migration.
  const legacy = readJSON(paths.config);
  if (typeof legacy?.openrouterKey === 'string' && legacy.openrouterKey.trim()) {
    env.OPENROUTER_API_KEY = legacy.openrouterKey.trim();
  }
  return env;
}

function ageRecipient(identityFile, env) {
  if (!fs.existsSync(identityFile) || !commandExists('age-keygen', env)) return null;
  const run = spawnSync('age-keygen', ['-y', identityFile], {
    env,
    encoding: 'utf8',
    shell: false,
    timeout: 5000,
  });
  return run.status === 0 ? run.stdout.trim() : null;
}

export function saveOpenRouterCredential(secret, options = {}) {
  if (typeof secret !== 'string' || secret.trim().length < 9) {
    return { ok: false, log: 'OpenRouter key was not saved — enter a complete key.' };
  }
  const env = options.env || process.env;
  const paths = preferencePaths({ ...options, env });
  if (!commandExists('sops', env) || !commandExists('age-keygen', env)) {
    return { ok: false, log: 'OpenRouter key was not saved — SOPS and age are required for encrypted storage. OPENROUTER_API_KEY in your environment remains supported.' };
  }
  const recipient = ageRecipient(paths.ageIdentity, env);
  if (!recipient) {
    return { ok: false, log: 'OpenRouter key was not saved — no SOPS age identity is configured. Set SOPS_AGE_KEY_FILE or use OPENROUTER_API_KEY.' };
  }
  const input = JSON.stringify({ OPENROUTER_API_KEY: secret.trim() });
  const run = spawnSync('sops', [
    'encrypt',
    '--input-type', 'json',
    '--output-type', 'json',
    '--age', recipient,
    '/dev/stdin',
  ], {
    env,
    input,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });
  if (run.status !== 0 || !run.stdout.trim()) {
    return { ok: false, log: 'OpenRouter key was not saved — SOPS encryption failed. The plaintext was not written to disk.' };
  }
  try {
    fs.mkdirSync(path.dirname(paths.secrets), { recursive: true, mode: 0o700 });
    let backup = null;
    if (fs.existsSync(paths.secrets)) {
      backup = `${paths.secrets}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(paths.secrets, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    }
    const tmp = `${paths.secrets}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, run.stdout, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, paths.secrets);
    fs.chmodSync(paths.secrets, 0o600);
    return {
      ok: true,
      log: 'OpenRouter key saved with SOPS+age encryption.',
      path: paths.secrets,
      backup,
      existed: backup !== null,
    };
  } catch {
    return { ok: false, log: 'OpenRouter key was encrypted but could not be saved. No plaintext file was created.' };
  }
}

export function seedProjectDefaults(options = {}) {
  const state = loadRuntimePreferences(options);
  if (!state.values.newProjectDefaults) return { ok: true, action: 'disabled', path: state.paths.project };
  const cwd = options.cwd || process.cwd();
  const looksLikeProject = ['.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod']
    .some((name) => fs.existsSync(path.join(cwd, name)));
  if (!looksLikeProject && options.env?.RUVNET_ALLOW_NONPROJECT_DEFAULTS !== '1') {
    return { ok: true, action: 'not-a-project', path: state.paths.project };
  }
  if (fs.existsSync(state.paths.project)) return { ok: true, action: 'already-initialized', path: state.paths.project };
  const values = {};
  for (const key of PROJECT_KEYS) {
    const value = state.values[key];
    if (value !== null && value !== undefined) values[key] = value;
  }
  const payload = {
    version: 1,
    inheritedAt: new Date().toISOString(),
    source: 'user-defaults',
    values,
  };
  try {
    fs.mkdirSync(path.dirname(state.paths.project), { recursive: true, mode: 0o700 });
    fs.writeFileSync(state.paths.project, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { ok: true, action: 'created', path: state.paths.project, values };
  } catch (error) {
    if (error?.code === 'EEXIST') return { ok: true, action: 'already-initialized', path: state.paths.project };
    return { ok: false, action: 'failed', path: state.paths.project, error: error?.message || String(error) };
  }
}

if (process.argv.includes('--learning-scope')) {
  process.stdout.write(`${loadRuntimePreferences().values.learningScope}\n`);
} else if (process.argv.includes('--managed-memory-boundary')) {
  // ADR-063 / issue #103. hijack-ruvnet.sh is POSIX sh and must not parse JSON, so it asks here —
  // the same idiom learn-capture.sh already uses for --learning-scope. Falls back to the shipped
  // default rather than erroring: a hook that cannot read a preference must never refuse a command
  // because of it, so an unreadable settings file degrades to `advise`, which blocks nothing.
  process.stdout.write(`${loadRuntimePreferences().values.managedMemoryBoundary || 'advise'}\n`);
} else if (process.argv.includes('--seed-project')) {
  const result = seedProjectDefaults();
  if (!result.ok) process.exitCode = 1;
}
