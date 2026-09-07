#!/usr/bin/env node
// Immutable scheduler target. Platform adapters execute this exact file with Node; this runner
// alone owns the dynamic package-resolution command used to converge corpus and host surfaces.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runnerPath = path.resolve(fileURLToPath(import.meta.url));
const registrationPath = String((process.argv[2] === '--registration' ? process.argv[3] : null) || process.env.RUVNET_NIGHTLY_REGISTRATION
  || path.join(path.dirname(runnerPath), 'registration.json'));
let registration;
try {
  if (!path.isAbsolute(registrationPath)) throw new Error('registration path is missing or not absolute');
  registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  const runnerSha256 = crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex');
  if (registration.schemaVersion !== 2 || registration.kind !== 'ruvnet-brain-nightly-scheduler'
    || (registration.identity !== 'com.ruvnet.brain-update'
      && !/^com\.ruvnet\.brain-update\.proof-[A-Za-z0-9._-]+$/.test(registration.identity || ''))
    || path.resolve(registration.runnerPath || '') !== runnerPath
    || registration.runnerSha256 !== runnerSha256
    || path.resolve(registration.nodePath || '') !== path.resolve(process.execPath)
    || !Array.isArray(registration.argv) || registration.argv.length !== 0
    || !registration.packageTarget || typeof registration.packageTarget.spec !== 'string') {
    throw new Error('registration does not bind this exact runner and Node executable');
  }
  if (registration.packageTarget.sha256 !== null) {
    if (!path.isAbsolute(registration.packageTarget.spec)
      || !/^[a-f0-9]{64}$/.test(registration.packageTarget.sha256)
      || crypto.createHash('sha256').update(fs.readFileSync(registration.packageTarget.spec)).digest('hex')
        !== registration.packageTarget.sha256) throw new Error('registered package target digest mismatch');
  } else if (registration.packageTarget.spec !== 'ruvnet-brain@latest') {
    throw new Error('unhashed package target is not the production latest channel');
  }
  const proof = /^com\.ruvnet\.brain-update\.proof-[A-Za-z0-9._-]+$/.test(registration.identity);
  if (proof) {
    const bundleStat = fs.lstatSync(registration.bundleTarget?.spec || '');
    if (!registration.bundleTarget || !path.isAbsolute(registration.bundleTarget.spec)
      || !registration.bundleTarget.spec.endsWith('.zip')
      || !bundleStat.isFile() || bundleStat.isSymbolicLink()
      || !/^[a-f0-9]{64}$/.test(registration.bundleTarget.sha256)
      || crypto.createHash('sha256').update(fs.readFileSync(registration.bundleTarget.spec)).digest('hex')
        !== registration.bundleTarget.sha256) throw new Error('registered bundle target digest mismatch');
  } else if (registration.bundleTarget !== null && registration.bundleTarget !== undefined) {
    throw new Error('production nightly registration cannot pin a local bundle');
  }
} catch (error) {
  console.error(`RuvNet Brain nightly refresh registration is invalid: ${error.message}`);
  process.exit(1);
}

const allowedEnvironment = ['PATH', 'HOME', 'USERPROFILE', 'RUVNET_BRAIN_HOME', 'RUVNET_BRAIN_KB', 'npm_config_cache', 'NO_COLOR', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'];
if (registration.environment !== undefined && (!registration.environment || Array.isArray(registration.environment)
  || Object.entries(registration.environment).some(([key, value]) => !allowedEnvironment.includes(key) || typeof value !== 'string'))) {
  console.error('Invalid registered nightly environment'); process.exit(1);
}
Object.assign(process.env, registration.environment || {});

const npxName = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const adjacent = path.join(path.dirname(process.execPath), npxName);
const npx = fs.existsSync(adjacent) ? adjacent : npxName;
const argv = ['--yes', registration.packageTarget.spec, '--update', '--no-nightly-prompt'];
let executable = npx;
let launchArgs = argv;
if (process.platform === 'win32') {
  // This content-addressed runner is copied alone: keep its dependency closure standalone.
  // Like rufloInvocation, execute the managed package's declared JS entry, never a .cmd shell.
  try {
    const shim = fs.existsSync(adjacent) ? adjacent : String(process.env.PATH || '')
      .split(path.delimiter).filter(Boolean).map(dir => path.join(dir, npxName))
      .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!shim) throw new Error('managed npm npx shim is missing');
    const packageRoot = fs.realpathSync(path.join(path.dirname(fs.realpathSync(shim)), 'node_modules', 'npm'));
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const declared = manifest.bin?.npx;
    if (manifest.name !== 'npm' || typeof declared !== 'string' || !declared
      || path.isAbsolute(declared) || path.win32.isAbsolute(declared) || declared.split(/[\\/]/).includes('..')) {
      throw new Error('managed npm package has no safe declared npx entry');
    }
    const entry = fs.realpathSync(path.resolve(packageRoot, declared));
    const relative = path.relative(packageRoot, entry);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) {
      throw new Error('managed npm npx entry escapes its package');
    }
    executable = process.execPath;
    launchArgs = [entry, ...argv];
  } catch (error) {
    console.error(`RuvNet Brain nightly refresh could not resolve managed npm: ${error.message}`);
    process.exit(1);
  }
}
const allowed = ['PATH', 'HOME', 'USERPROFILE', 'RUVNET_BRAIN_HOME', 'RUVNET_BRAIN_KB',
  'npm_config_cache', 'NO_COLOR', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'];
const childEnv = Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined)
  .map((key) => [key, process.env[key]]));
const result = spawnSync(executable, launchArgs, {
  stdio: 'inherit',
  shell: false,
  env: { ...childEnv, RUVNET_NIGHTLY: '1',
    RUVNET_NIGHTLY_REGISTRATION: registrationPath,
    RUVNET_NIGHTLY_IDENTITY: registration.identity,
    RUVNET_NIGHTLY_NODE_PATH: registration.nodePath,
    RUVNET_NIGHTLY_RUNNER_PATH: registration.runnerPath,
    RUVNET_NIGHTLY_RUNNER_SHA256: registration.runnerSha256,
  },
});

if (result.error) {
  console.error(`RuvNet Brain nightly refresh could not start: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
