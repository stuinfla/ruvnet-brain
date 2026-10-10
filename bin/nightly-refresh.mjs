#!/usr/bin/env node
// Immutable scheduler target. Platform adapters execute this exact file with Node; this runner
// alone owns the dynamic package-resolution command used to converge corpus and host surfaces.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    || fs.realpathSync(registration.nodePath || '') !== fs.realpathSync(process.execPath)
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

let invocation;
try {
  const modules = registration.updateModules;
  const legacy = ['automatic-update.mjs', 'ruvnet-gate1-pattern.mjs', 'user-settings.mjs'];
  const bridged = [...legacy, 'developer-update-owner.mjs'];
  const currentLegacy = [...bridged, 'developer-update-policy.mjs'];
  if (!modules?.['developer-update-policy.mjs'] && registration.mode === 'developer-suite') throw new Error('suite policy closure is missing');
  if (registration.mode === 'developer-suite' && (!path.isAbsolute(modules['developer-update-policy.mjs'].path) || path.basename(modules['developer-update-policy.mjs'].path) !== 'developer-update-policy.mjs' || path.dirname(modules['developer-update-policy.mjs'].path) !== path.dirname(modules['automatic-update.mjs'].path) || !fs.lstatSync(modules['developer-update-policy.mjs'].path).isFile())) throw new Error('suite policy path identity mismatch');
  if (registration.mode === 'developer-suite' && crypto.createHash('sha256').update(fs.readFileSync(modules['developer-update-policy.mjs'].path)).digest('hex') !== modules['developer-update-policy.mjs'].sha256) throw new Error('suite policy digest mismatch');
  const executionPolicy = registration.mode === 'developer-suite' ? await import(pathToFileURL(modules['developer-update-policy.mjs'].path).href) : null;
  const suite = executionPolicy ? [...new Set([...currentLegacy, ...executionPolicy.EXECUTION_MODULES])] : [];
  const expected = registration.mode === 'developer-suite' ? [suite] : [legacy, bridged, currentLegacy];
  if (!modules || !expected.some(names => Object.keys(modules).sort().join(',') === names.sort().join(','))) throw new Error('registered update module closure is missing');
  for (const [name, item] of Object.entries(modules)) {
    if (!path.isAbsolute(item.path) || path.basename(item.path) !== name
      || path.dirname(item.path) !== path.dirname(modules['automatic-update.mjs'].path)
      || !fs.lstatSync(item.path).isFile()
      || crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex') !== item.sha256) throw new Error('update module digest mismatch');
  }
  if (registration.mode === 'developer-suite') {
    const coordinator = await import(pathToFileURL(modules['developer-update.mjs'].path).href);
    const receipt = await coordinator.runDeveloperUpdate({ mode: 'apply', env: { ...process.env,
      RUVNET_NIGHTLY_IDENTITY: registration.identity, RUVNET_NIGHTLY: '1' } });
    console.log(JSON.stringify(receipt));
    process.exit(0);
  }
  const policy = await import(pathToFileURL(modules['automatic-update.mjs'].path).href);
  process.env.PATH = policy.automaticPath({ nodePath: registration.nodePath });
  invocation = policy.automaticInvocation(['--update', '--no-nightly-prompt'], {
    nodePath: registration.nodePath, packageTarget: registration.packageTarget.spec,
  });
} catch (error) {
  console.error(`RuvNet Brain automatic update refused: ${error.message}`);
  process.exit(1);
}
const allowed = ['PATH', 'HOME', 'USERPROFILE', 'RUVNET_BRAIN_HOME', 'RUVNET_BRAIN_KB',
  'npm_config_cache', 'NO_COLOR', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'];
const childEnv = Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined)
  .map((key) => [key, process.env[key]]));
const result = spawnSync(invocation.executable, invocation.args, {
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
