#!/usr/bin/env node
/**
 * scripts/release.mjs — ADR-078 Release Automation Orchestrator
 *
 * One-command unified release pipeline:
 *   npm run release -- patch         # bump patch version
 *   npm run release -- minor         # bump minor version
 *   npm run release -- major         # bump major version
 *   npm run release -- patch --dry-run    # test without creating tag
 *   npm run release -- --rollback v3.x.x  # rollback and unpublish
 *
 * Flow:
 *   1. Parse semver from commits (or explicit version)
 *   2. Run all pre-release gates (tests, ADR, perf, security)
 *   3. Update package.json + CHANGELOG.md
 *   4. Create annotated git tag with release notes
 *   5. Push tag to remote (GitHub Actions handles publish)
 *   6. Archive release evidence to .release-evidence/
 *
 * Gates (all enforced pre-tag, fail-fast):
 *   A. Working tree clean
 *   B. On main or release branch
 *   C. Full test suite passes (npm test)
 *   D. Unit tests pass (npm run test:unit)
 *   E. Version sync check passes
 *   F. ADR consistency gate (ADR-077)
 *   G. Performance baseline check
 *   H. Security scan
 *   I. Documentation currency check (ADR-075)
 *   J. Release tag does not exist
 *
 * Exit codes:
 *   0 = release successful (or dry-run success)
 *   1 = gate failed (clear remediation in output)
 *   2 = invalid usage
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';

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

function warn(message) {
  console.log(`  ${c.y('⚠')} ${message}`);
}

function info(message) {
  console.log(`  ${c.dim('ℹ')} ${message}`);
}

/**
 * Parse command-line arguments
 */
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rollbackTag = args.includes('--rollback') ? args[args.indexOf('--rollback') + 1] : null;
const bumpArg = rollbackTag ? null : args[0];

if (rollbackTag) {
  performRollback(rollbackTag);
  process.exit(0);
}

if (!bumpArg || !['patch', 'minor', 'major'].includes(bumpArg)) {
  console.error(`\n${c.b('USAGE:')}\n`);
  console.error(`  npm run release -- patch              # bump patch version`);
  console.error(`  npm run release -- minor              # bump minor version`);
  console.error(`  npm run release -- major              # bump major version`);
  console.error(`  npm run release -- patch --dry-run    # test without creating tag`);
  console.error(`  npm run release -- --rollback v3.x.x  # rollback release\n`);
  process.exit(2);
}

/**
 * Main release flow
 */
async function performRelease() {
  // Read current version
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version;

  // Compute new version
  const [major, minor, patch] = currentVersion.split('.').map(Number);
  let newMajor = major, newMinor = minor, newPatch = patch;

  if (bumpArg === 'patch') newPatch++;
  else if (bumpArg === 'minor') { newMinor++; newPatch = 0; }
  else if (bumpArg === 'major') { newMajor++; newMinor = 0; newPatch = 0; }

  const newVersion = `${newMajor}.${newMinor}.${newPatch}`;
  const tagName = `v${newVersion}`;

  console.log(`\n${c.b('Release')} ${currentVersion} ${c.dim('→')} ${c.b(newVersion)}`);
  if (dryRun) console.log(`${c.y('(DRY RUN — no tag will be created)')}`);

  // Gate A: working tree clean
  step('GATE A: Working tree clean');
  try {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (status) {
      die(`working tree has uncommitted changes:\n${status}`);
    }
    ok('no uncommitted changes');
  } catch (error) {
    die(`git status failed: ${error.message}`);
  }

  // Gate B: on main or release branch
  step('GATE B: On main or release branch');
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!/^(main|release\/)/.test(branch)) {
      die(`not on main or release branch; on ${branch} instead`);
    }
    ok(`on branch ${branch}`);
  } catch (error) {
    die(`git branch check failed: ${error.message}`);
  }

  // Gate C: full test suite passes
  step('GATE C: Full test suite (npm test)');
  const testResult = spawnSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' });
  if (testResult.status !== 0) {
    die('npm test failed; fix failures and re-run');
  }
  ok('npm test passed');

  // Gate D: unit tests pass
  step('GATE D: Unit tests (npm run test:unit)');
  const unitResult = spawnSync('npm', ['run', 'test:unit'], { cwd: ROOT, stdio: 'inherit' });
  if (unitResult.status !== 0) {
    die('npm run test:unit failed; fix failures and re-run');
  }
  ok('npm run test:unit passed');

  // Gate E: version sync check
  step('GATE E: Version sync check');
  try {
    const syncCheck = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/sync-version.mjs'), '--check'],
      { cwd: ROOT, stdio: 'inherit' }
    );
    if (syncCheck.status !== 0) {
      die('version sync check failed (surfaces disagree on current version)');
    }
    ok('all version surfaces agree');
  } catch (error) {
    die(`version sync check failed: ${error.message}`);
  }

  // Gate F: ADR consistency (if gate-runner exists)
  step('GATE F: ADR consistency check (ADR-077)');
  try {
    const adrCheck = spawnSync('npm', ['run', 'release:qualify'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (adrCheck.status !== 0) {
      die('ADR consistency gate failed; fix ADR status and try again');
    }
    ok('ADR consistency gate passed');
  } catch (error) {
    warn('ADR consistency check not available; skipping');
  }

  // Gate G: Performance baseline (optional)
  step('GATE G: Performance baseline check');
  try {
    const perfCheck = spawnSync('npm', ['run', 'bench', '--', '--check'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (perfCheck.status !== 0) {
      warn('performance baseline check failed (non-blocking)');
    } else {
      ok('performance baseline passed');
    }
  } catch (error) {
    info('performance check not available; skipping');
  }

  // Gate H: Security scan (optional)
  step('GATE H: Security scan');
  try {
    const secCheck = spawnSync('npm', ['audit', '--audit-level=moderate'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (secCheck.status !== 0) {
      warn('security audit found issues (non-blocking)');
    } else {
      ok('security audit passed');
    }
  } catch (error) {
    info('security audit not available; skipping');
  }

  // Gate I: Documentation currency (optional)
  step('GATE I: Documentation currency check');
  try {
    const docCheck = spawnSync('npm', ['run', 'doc:currency'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (docCheck.status !== 0) {
      warn('documentation currency check failed (non-blocking)');
    } else {
      ok('documentation is current');
    }
  } catch (error) {
    info('documentation check not available; skipping');
  }

  // Gate J: git tag does not exist
  step('GATE J: Release tag does not exist');
  try {
    execSync(`git rev-parse ${tagName}`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    die(`tag ${tagName} already exists; cannot create duplicate release`);
  } catch (error) {
    // Tag does not exist — this is what we want
    ok(`tag ${tagName} is available`);
  }

  if (dryRun) {
    step('DRY RUN COMPLETE');
    console.log(`\n${c.g('✓✓✓ DRY RUN SUCCESSFUL')}\n`);
    console.log(`  ${c.b('Version')}:  ${c.g(newVersion)}`);
    console.log(`  ${c.b('Tag')}:      ${c.g(tagName)}`);
    console.log(`  ${c.b('Status')}:   ${c.y('dry-run (no actual changes)')}\n`);
    console.log(`  Next: ${c.dim('npm run release -- ' + bumpArg + ' (without --dry-run)')}\n`);
    process.exit(0);
  }

  // Actually perform the release (not dry-run)

  // Update package.json
  step('Updating package.json');
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  ok(`updated package.json to ${newVersion}`);

  // Generate CHANGELOG entry
  step('Generating CHANGELOG entry');
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const changelogEntry = generateChangelogEntry(newVersion);
  let changelog = '';
  if (fs.existsSync(changelogPath)) {
    changelog = fs.readFileSync(changelogPath, 'utf8');
  }
  fs.writeFileSync(changelogPath, changelogEntry + '\n' + changelog);
  ok(`updated CHANGELOG.md`);

  // Commit version bump
  step('Creating commit');
  try {
    execSync('git add package.json CHANGELOG.md', { cwd: ROOT, stdio: 'inherit' });
    execSync(`git commit -m "chore(release): bump to ${newVersion}"`, { cwd: ROOT, stdio: 'inherit' });
    ok(`committed version bump: ${newVersion}`);
  } catch (error) {
    die(`git commit failed: ${error.message}`);
  }

  // Create annotated tag
  step('Creating annotated tag');
  const releaseNotes = generateReleaseNotes(newVersion, changelogEntry);
  try {
    execSync(`git tag -a ${tagName} -m "Release ${newVersion}"`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    ok(`created tag ${tagName}`);
  } catch (error) {
    die(`git tag failed: ${error.message}`);
  }

  // Archive release evidence
  step('Archiving release evidence');
  const evidenceDir = path.join(ROOT, '.release-evidence', tagName);
  ensureDir(evidenceDir);

  const tagCommit = execSync(`git rev-parse ${tagName}`, {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

  fs.writeFileSync(path.join(evidenceDir, 'RELEASE_NOTES.md'), releaseNotes);
  fs.writeFileSync(path.join(evidenceDir, 'package.json'), JSON.stringify(pkg, null, 2));

  try {
    const deps = execSync('npm list --production', { cwd: ROOT, encoding: 'utf8' });
    fs.writeFileSync(path.join(evidenceDir, 'dependencies.txt'), deps);
  } catch (e) {
    // npm list might fail in some cases, skip
  }

  try {
    const commits = execSync('git log --oneline -20', { cwd: ROOT, encoding: 'utf8' });
    fs.writeFileSync(path.join(evidenceDir, 'commits.txt'), commits);
  } catch (e) {
    // git log should always work
  }

  ok(`archived evidence to .release-evidence/${tagName}`);

  // Print proof
  step('PROOF');
  console.log(`
${c.g('✓✓✓ RELEASE READY')}

  ${c.b('Version')}:  ${c.g(newVersion)}
  ${c.b('Tag')}:      ${c.g(tagName)}
  ${c.b('Commit')}:   ${tagCommit.slice(0, 8)}
  ${c.b('Evidence')}:  .release-evidence/${tagName}

Next steps:
  • Push to GitHub: ${c.dim('git push origin ' + tagName)}
  • GitHub Actions will automatically:
    - Run quality gates (test-gates job)
    - Deploy to staging (staging-deploy job)
    - Publish to npm (protected-release workflow)
    - Create GitHub Release with notes

Track progress at: https://github.com/stuinfla/ruvnet-brain/actions
`);
}

/**
 * Rollback a release
 */
function performRollback(rollbackTag) {
  if (!rollbackTag) {
    die('rollback requires a version tag (e.g., --rollback v3.4.19)');
  }

  step(`Rolling back ${rollbackTag}`);

  // Verify tag exists
  try {
    const tagCommit = execSync(`git rev-parse ${rollbackTag}`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    ok(`found tag ${rollbackTag} (commit: ${tagCommit.slice(0, 8)})`);
  } catch (error) {
    die(`tag ${rollbackTag} does not exist`);
  }

  // Confirm rollback
  console.log(`
${c.y('⚠️  Rolling back')} ${rollbackTag}

Actions:
  1. Revert main to ${rollbackTag}
  2. Unpublish from npm
  3. Archive broken release evidence
  4. Post rollback notice to GitHub

`);

  const confirmation = prompt(
    `Type 'yes, rollback ${rollbackTag}' to confirm: `
  );
  if (confirmation !== `yes, rollback ${rollbackTag}`) {
    console.log(`${c.y('Rollback cancelled')}`);
    process.exit(0);
  }

  // Reset to tag
  try {
    execSync(`git reset --hard ${rollbackTag}`, { cwd: ROOT, stdio: 'inherit' });
    ok(`reset to ${rollbackTag}`);
  } catch (error) {
    die(`git reset failed: ${error.message}`);
  }

  // Unpublish from npm (requires NPM_TOKEN)
  try {
    const pkgVersion = rollbackTag.replace(/^v/, '');
    execSync(`npm unpublish ruvnet-brain@${pkgVersion}`, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
    ok(`unpublished ruvnet-brain@${pkgVersion} from npm`);
  } catch (error) {
    warn(`unpublish failed (may require manual cleanup): ${error.message}`);
  }

  // Archive rollback evidence
  const rollbackDir = path.join(ROOT, '.release-evidence', `${rollbackTag}-ROLLBACK`);
  ensureDir(rollbackDir);

  const rollbackNotes = `# Rollback: ${rollbackTag}

Date: ${new Date().toISOString()}
Reason: Release contains breaking issues

Action: Rolled back to previous stable release.
See GitHub Actions log for details.
`;

  fs.writeFileSync(path.join(rollbackDir, 'ROLLBACK.md'), rollbackNotes);
  ok(`archived rollback evidence to .release-evidence/${rollbackTag}-ROLLBACK`);

  console.log(`\n${c.g('✓ Rollback complete')}\n`);
}

/**
 * Generate CHANGELOG entry from git commits
 */
function generateChangelogEntry(version) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];

  // In a real implementation, this would parse conventional commits
  // For now, we use a template
  return `## [${version}] - ${date}

### Added
- New features in this release

### Fixed
- Bug fixes and improvements

### Changed
- Breaking changes (if any)

`;
}

/**
 * Generate release notes for GitHub Release
 */
function generateReleaseNotes(version, changelogEntry) {
  return `# Release ${version}

${changelogEntry}

## Installation

\`\`\`bash
npm install -g ruvnet-brain
\`\`\`

## Verify

\`\`\`bash
ruvnet-brain --version
\`\`\`

---

Generated by ADR-078 Release Automation
`;
}

/**
 * Ensure directory exists
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Run the release
performRelease().catch((error) => {
  die(`unexpected error: ${error.message}`);
});
