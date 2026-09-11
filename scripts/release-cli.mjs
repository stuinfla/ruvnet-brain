#!/usr/bin/env node
// scripts/release-cli.mjs — One-command release automation
//
// USAGE:
//   npm run release -- patch     # bumps 4.3.22 → 4.3.23
//   npm run release -- minor     # bumps 4.3.22 → 4.4.0
//   npm run release -- major     # bumps 4.3.22 → 5.0.0
//   npm run release -- 4.3.23    # sets explicit version
//
// GATES (run in order, fail-fast):
//   1. working tree clean (no uncommitted changes)
//   2. on main or release branch (not a feature branch)
//   3. full test suite passes (npm test)
//   4. unit gates pass (npm run test:unit)
//   5. version sync check passes (all surfaces agree)
//   6. git tag does not exist (prevent accidental re-release)
//   7. create tag and commit with bumped version
//   8. print proof: git tag and package.json version
//
// Gates 1-6 are read-only (no mutations). Gate 7 mutates (tag + commit).
// On failure, stop and print the failure reason; re-run after fixing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function die(message, code = 1) {
  console.error(`\n${c.r('✗')} ${message}\n`);
  process.exit(code);
}

function step(label) {
  console.log(`\n${c.b('▸')} ${label}`);
}

function ok(message) {
  console.log(`  ${c.g('✓')} ${message}`);
}

// Parse the bump type or explicit version
const bumpArg = process.argv[2];
if (!bumpArg) {
  console.error(`\nUSAGE:
  npm run release -- patch    # 4.3.22 → 4.3.23
  npm run release -- minor    # 4.3.22 → 4.4.0
  npm run release -- major    # 4.3.22 → 5.0.0
  npm run release -- 4.3.23   # set exact version
\n`);
  process.exit(2);
}

// Gate 1: working tree clean
step('GATE 1: working tree clean');
try {
  const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (status) {
    die(`working tree has uncommitted changes:\n${status}`);
  }
  ok('no uncommitted changes');
} catch (error) {
  die(`git status failed: ${error.message}`);
}

// Gate 2: on main or release branch
step('GATE 2: on main or release branch');
try {
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!/^(main|release\/)/.test(branch)) {
    die(`not on main or release branch; on ${branch} instead`);
  }
  ok(`on branch ${branch}`);
} catch (error) {
  die(`git branch check failed: ${error.message}`);
}

// Get current version
const pluginJson = path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json');
const pluginDoc = JSON.parse(fs.readFileSync(pluginJson, 'utf8'));
const currentVersion = pluginDoc.version;

// Parse and compute new version
let newVersion;
if (/^\d+\.\d+\.\d+/.test(bumpArg)) {
  // Explicit version
  newVersion = bumpArg;
} else if (['patch', 'minor', 'major'].includes(bumpArg)) {
  // Semantic bump
  const parts = currentVersion.split(/[.-]/);
  const [major, minor, patch] = parts.slice(0, 3).map(Number);
  let [newMajor, newMinor, newPatch] = [major, minor, patch];

  if (bumpArg === 'patch') newPatch++;
  else if (bumpArg === 'minor') { newMinor++; newPatch = 0; }
  else if (bumpArg === 'major') { newMajor++; newMinor = 0; newPatch = 0; }

  newVersion = `${newMajor}.${newMinor}.${newPatch}`;
  // Preserve pre-release suffix if present
  if (parts.length > 3) newVersion += `-${parts.slice(3).join('.')}`;
} else {
  die(`invalid bump type: ${bumpArg} (use: patch, minor, major, or X.Y.Z)`);
}

console.log(`\n${c.b('Release')} ${currentVersion} ${c.dim('→')} ${c.b(newVersion)}\n`);

// Gate 3: full test suite passes
step('GATE 3: full test suite (npm test)');
const testRun = spawnSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' });
if (testRun.status !== 0) {
  die('npm test failed; fix failures and re-run');
}
ok('npm test passed');

// Gate 4: unit gates pass
step('GATE 4: unit gates (npm run test:unit)');
const unitRun = spawnSync('npm', ['run', 'test:unit'], { cwd: ROOT, stdio: 'inherit' });
if (unitRun.status !== 0) {
  die('npm run test:unit failed; fix failures and re-run');
}
ok('npm run test:unit passed');

// Gate 5: version sync check
step('GATE 5: version sync check');
const syncCheck = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-version.mjs'), '--check'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (syncCheck.status !== 0) {
  die('version sync check failed (surfaces disagree on current version)');
}
ok('all version surfaces agree');

// Gate 6: git tag does not exist
step('GATE 6: release tag does not exist');
const tagName = `v${newVersion}`;
try {
  const tagExists = execSync(`git rev-parse ${tagName}`, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  die(`tag ${tagName} already exists; cannot create duplicate release`);
} catch (error) {
  // Tag does not exist — this is what we want
  ok(`tag ${tagName} is available`);
}

// Gate 7: set version and create tag
step('GATE 7: set version and create release tag');

// Set the version
const setVersionRun = spawnSync(process.execPath, [path.join(ROOT, 'scripts/set-version.mjs'), newVersion], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (setVersionRun.status !== 0) {
  die('version:set failed');
}

// Commit version bump
try {
  execSync(`git add plugin/.claude-plugin/plugin.json package.json package-lock.json`, { cwd: ROOT, stdio: 'inherit' });
  execSync(`git commit -m "chore(release): bump to ${newVersion}"`, { cwd: ROOT, stdio: 'inherit' });
  ok(`committed version bump: ${newVersion}`);
} catch (error) {
  die(`git commit failed: ${error.message}`);
}

// Create annotated tag
try {
  execSync(`git tag -a ${tagName} -m "Release ${newVersion}"`, { cwd: ROOT, stdio: 'inherit' });
  ok(`created tag ${tagName}`);
} catch (error) {
  die(`git tag failed: ${error.message}`);
}

// Gate 8: print proof
step('PROOF');
try {
  const tagCommit = execSync(`git rev-parse ${tagName}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pkgVersion = pkgJson.version;

  console.log(`
${c.g('✓✓✓ RELEASE READY')}

  ${c.b('Version')}:  ${c.g(newVersion)}
  ${c.b('Tag')}:      ${c.g(tagName)}
  ${c.b('Commit')}:   ${tagCommit.slice(0, 8)}
  ${c.b('package.json')}: ${pkgVersion}

Next steps:
  • Push to GitHub: ${c.dim('git push origin main ' + tagName)}
  • Trigger protected-release workflow with:
    ${c.dim('gh workflow run protected-release.yml -f candidate_sha=' + tagCommit.slice(0, 40) + ' -f version=' + newVersion)}

`);
} catch (error) {
  die(`proof verification failed: ${error.message}`);
}
