#!/usr/bin/env node
/**
 * coverage-report.mjs — ADR-079 Coverage Gate
 *
 * Generates coverage report and validates thresholds.
 * Blocks merge if coverage drops below minimum.
 *
 * Thresholds:
 *  - Statements: 85% minimum
 *  - Branches: 80% minimum
 *  - Functions: 85% minimum
 *  - Lines: 85% minimum
 *
 * Exit: 0 if all pass, 1 if any threshold breached
 *
 * Usage:
 *   node scripts/coverage-report.mjs                # Generate and validate
 *   node scripts/coverage-report.mjs --write-baseline # Save new baseline
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const THRESHOLDS = {
  statements: 85,
  branches: 80,
  functions: 85,
  lines: 85,
};

function log(color, ...args) {
  console.error(`${COLORS[color]}${args.join(' ')}${COLORS.reset}`);
}

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' });
  } catch (error) {
    log('red', `Command failed: ${cmd}`);
    throw error;
  }
}

function generateCoverageReport() {
  log('blue', 'Generating coverage report...\n');

  try {
    exec('npm run test:cov 2>&1');
  } catch (error) {
    log('red', 'Coverage generation failed');
    throw error;
  }

  const coveragePath = 'coverage/coverage-summary.json';
  if (!existsSync(coveragePath)) {
    log('red', `Coverage report not found at ${coveragePath}`);
    process.exit(1);
  }

  return JSON.parse(readFileSync(coveragePath, 'utf-8'));
}

function validateThresholds(coverage) {
  const total = coverage.total;
  const results = {
    statements: {
      value: total.statements.pct,
      threshold: THRESHOLDS.statements,
      pass: total.statements.pct >= THRESHOLDS.statements,
    },
    branches: {
      value: total.branches.pct,
      threshold: THRESHOLDS.branches,
      pass: total.branches.pct >= THRESHOLDS.branches,
    },
    functions: {
      value: total.functions.pct,
      threshold: THRESHOLDS.functions,
      pass: total.functions.pct >= THRESHOLDS.functions,
    },
    lines: {
      value: total.lines.pct,
      threshold: THRESHOLDS.lines,
      pass: total.lines.pct >= THRESHOLDS.lines,
    },
  };

  return results;
}

function formatCoverageTable(results) {
  const lines = ['', '### Coverage Report', '', '| Metric | Threshold | Actual | Status |', '|--------|-----------|--------|--------|'];

  for (const [metric, data] of Object.entries(results)) {
    const status = data.pass ? '✅' : '❌';
    const actual = data.value.toFixed(1);
    lines.push(`| ${metric.charAt(0).toUpperCase() + metric.slice(1)} | ${data.threshold}% | ${actual}% | ${status} |`);
  }

  lines.push('');
  return lines.join('\n');
}

function compareWithBaseline(current) {
  const baselinePath = '.github/coverage-baseline.json';

  if (!existsSync(baselinePath)) {
    log('gray', 'No baseline found. Creating initial baseline...');
    writeFileSync(baselinePath, JSON.stringify({
      timestamp: new Date().toISOString(),
      coverage: current,
    }, null, 2));
    return { delta: 0, baseline: current };
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const baselineCov = baseline.coverage.total;
  const currentCov = current.total;

  return {
    delta: currentCov.lines.pct - baselineCov.lines.pct,
    baseline: baselineCov,
    current: currentCov,
  };
}

function formatDeltaComment(results, comparison) {
  const lines = [''];
  const allPass = Object.values(results).every((r) => r.pass);

  if (allPass) {
    lines.push('✅ **Coverage Check Passed**');
  } else {
    lines.push('❌ **Coverage Check Failed**');
  }

  lines.push('');
  lines.push(`**Baseline**: ${comparison.baseline.lines.pct.toFixed(1)}% | **Current**: ${comparison.current.lines.pct.toFixed(1)}% | **Delta**: ${comparison.delta >= 0 ? '+' : ''}${comparison.delta.toFixed(1)}%`);
  lines.push('');

  // Add threshold table
  lines.push('| Metric | Threshold | Current | Status |');
  lines.push('|--------|-----------|---------|--------|');

  for (const [metric, data] of Object.entries(results)) {
    const status = data.pass ? '✅' : '❌ BELOW';
    const current = data.value.toFixed(1);
    lines.push(`| ${metric.charAt(0).toUpperCase() + metric.slice(1)} | ${data.threshold}% | ${current}% | ${status} |`);
  }

  lines.push('');

  if (!allPass) {
    lines.push('**❌ Merge blocked due to coverage below threshold.**');
    lines.push('');
    lines.push('Fix: Add tests for untested code to reach the threshold.');
  }

  return lines.join('\n');
}

async function main() {
  log('blue', 'ADR-079 Coverage Reporting Gate');
  log('blue', '─'.repeat(60));

  // Check if we should write new baseline
  const writeBaseline = process.argv.includes('--write-baseline');

  // Generate coverage
  const coverage = generateCoverageReport();
  const results = validateThresholds(coverage);

  // Display report
  log('green', formatCoverageTable(results));

  // Compare with baseline
  const comparison = compareWithBaseline(coverage);

  if (comparison.baseline && comparison.current) {
    const deltaStr = comparison.delta >= 0 ? `+${comparison.delta.toFixed(1)}%` : `${comparison.delta.toFixed(1)}%`;
    log('blue', `Coverage delta: ${deltaStr}`);

    if (comparison.delta < 0) {
      log('yellow', `⚠️  Coverage decreased by ${Math.abs(comparison.delta).toFixed(1)}%`);
    } else {
      log('green', `✅ Coverage improved by ${comparison.delta.toFixed(1)}%`);
    }
  }

  log('gray', formatDeltaComment(results, comparison));

  // Check if all thresholds passed
  const allPass = Object.values(results).every((r) => r.pass);

  if (allPass) {
    log('green', '\n✅ Coverage thresholds validated\n');

    if (writeBaseline) {
      log('blue', 'Writing new baseline...');
      writeFileSync('.github/coverage-baseline.json', JSON.stringify({
        timestamp: new Date().toISOString(),
        coverage: coverage,
      }, null, 2));
      log('green', 'Baseline updated\n');
    }

    process.exit(0);
  } else {
    log('red', '\n❌ Coverage below threshold. Merge blocked.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  log('red', `Fatal error: ${err.message}`);
  process.exit(1);
});
