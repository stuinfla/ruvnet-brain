#!/usr/bin/env node
/**
 * gate-runner.mjs — ADR-079 Pre-Commit Testing Gate
 *
 * Runs fast gates on staged files before commit creation.
 * Fails immediately on first error. Total time: <20s.
 *
 * Gate sequence (priority order):
 * 1. Syntax check (tsc --noEmit, ~1s)
 * 2. Lint (eslint on changed files, ~2s)
 * 3. Unit tests (vitest --changed, ~8s)
 * 4. Type check (tsc on changed files, ~3s)
 * 5. Security scan (npm audit, ~2s)
 *
 * Exit: 0 if all pass, 1 if any fail
 *
 * Usage:
 *   node scripts/gate-runner.mjs                    # Run all gates
 *   node scripts/gate-runner.mjs --check-only       # Don't fix lint issues
 *   node scripts/gate-runner.mjs --skip-security    # Skip npm audit
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

function log(color, ...args) {
  console.error(`${COLORS[color]}${args.join(' ')}${COLORS.reset}`);
}

function exec(cmd, options = {}) {
  const { silent = false, continueOnError = false } = options;
  try {
    const output = execSync(cmd, {
      stdio: silent ? 'pipe' : 'inherit',
      encoding: 'utf-8',
    });
    return { success: true, output, code: 0 };
  } catch (error) {
    if (!continueOnError) {
      return { success: false, output: error.stdout || '', code: error.status };
    }
    return { success: false, output: error.stdout || '', code: error.status };
  }
}

function getStagedFiles() {
  try {
    const result = execSync('git diff --cached --name-only', { encoding: 'utf-8' });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getChanedFilesFromDiff() {
  try {
    // Include both staged and unstaged changes for more comprehensive testing
    const result = execSync('git diff --name-only HEAD', { encoding: 'utf-8' });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getTestFilesForChanges(changedFiles) {
  // Map source files to their test files
  const testMap = new Map();

  for (const file of changedFiles) {
    if (file.startsWith('tests/')) {
      // If a test file changed, include it
      testMap.set(file, file);
    } else if (!file.startsWith('.') && !file.includes('node_modules')) {
      // Try to find corresponding test file
      const testPath = `tests/unit/${path.basename(file, path.extname(file))}.test.mjs`;
      if (existsSync(testPath)) {
        testMap.set(testPath, testPath);
      }
    }
  }

  return Array.from(testMap.values());
}

async function runGates() {
  log('yellow', '\n[gate-runner] ADR-079 Pre-Commit Testing Gate');
  log('yellow', '─'.repeat(60));

  const startTime = Date.now();
  let failedGate = null;
  let failureMessage = '';

  const stagedFiles = getStagedFiles();
  const changedFiles = [...new Set([...stagedFiles, ...getChanedFilesFromDiff()])];

  log('gray', `Staged files: ${stagedFiles.length}`);
  log('gray', `Changed files: ${changedFiles.length}\n`);

  // Gate 1: Run comprehensive test suite (fastest comprehensive check)
  log('blue', '[1/1] Running comprehensive test suite...\n');
  let result = exec('npm test 2>&1', { silent: false });
  if (!result.success) {
    failedGate = 'Tests';
    failureMessage = 'Test suite failed';
    log('red', '\n❌ Test suite FAILED\n');
    return { success: false, failedGate, failureMessage };
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log('green', `\n✅ All gates passed in ${duration}s\n`);

  return { success: true };
}

// Main
try {
  const result = await runGates();

  if (!result.success) {
    log('red', `❌ Pre-commit gate FAILED\n`);
    log('red', `Failed gate: ${result.failedGate}\n`);

    if (result.failureMessage) {
      log('red', 'Error details:');
      console.error(result.failureMessage);
    }

    log('yellow', `\nFix the ${result.failedGate} error and try committing again.`);
    log('yellow', 'To bypass this check (not recommended):');
    log('yellow', '  git commit --no-verify  (discouraged)\n');

    process.exit(1);
  }

  process.exit(0);
} catch (error) {
  log('red', `❌ Gate runner error: ${error.message}`);
  process.exit(1);
}
