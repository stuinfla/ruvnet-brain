/**
 * test-utils.mjs — ADR-079 Test Traceability Utilities
 *
 * Provides utilities for linking tests to requirements (ADRs, issues).
 * Supports @requirement decorator, test grouping, and traceability reports.
 *
 * Usage:
 *
 * import { describe, it, expect, test, tag } from 'vitest';
 * import { withRequirement } from '#test-utils';
 *
 * describe('Memory recall — ADR-076', () => {
 *   test('should recall last checkpoint', async () => {
 *     const cp = await recall();
 *     expect(cp).toBeDefined();
 *   }, { requirement: 'ADR-076' });
 *
 *   it('should include timestamps', () => {
 *     expect(checkpoint.timestamp).toBeDefined();
 *   });
 * });
 */

import { describe, it, expect } from 'vitest';

/**
 * Test metadata storage
 * Maps test name to requirements, issues, categories
 */
const testMetadata = new Map();

/**
 * Register a test with requirement metadata
 * @param {string} name - Test name
 * @param {object} metadata - { requirement: 'ADR-XXX', issue: '#123', category: 'critical' }
 */
export function tag(name, metadata = {}) {
  testMetadata.set(name, metadata);
  return metadata;
}

/**
 * Wrapper for tests that links to requirements
 * @param {string} name - Test name
 * @param {function} fn - Test function
 * @param {object} options - { requirement, issue, category, skip, only }
 */
export function test(name, fn, options = {}) {
  const { requirement, issue, category, skip, only } = options;

  if (requirement || issue || category) {
    tag(name, { requirement, issue, category });
  }

  const itFn = only ? it.only : skip ? it.skip : it;
  return itFn(name, fn);
}

/**
 * Create a requirement group (describe block with metadata)
 * @param {string} name - Group name
 * @param {string} requirement - ADR/issue requirement
 * @param {function} fn - Test function containing describe/it blocks
 */
export function requirementGroup(name, requirement, fn) {
  return describe(`${name} — ${requirement}`, () => {
    // Wrap the describe function to auto-tag all tests in this group
    const originalIt = it;
    const originalDescribe = describe;

    globalThis.describe = (subName, subFn) => {
      return originalDescribe(subName, subFn);
    };

    globalThis.it = (testName, testFn) => {
      tag(`${name}/${subName}`, { requirement });
      return originalIt(testName, testFn);
    };

    try {
      fn();
    } finally {
      // Restore
      globalThis.describe = originalDescribe;
      globalThis.it = originalIt;
    }
  });
}

/**
 * Generate a traceability report showing test coverage by requirement
 * @param {object} testResults - Vitest results object
 * @returns {string} Formatted report
 */
export function generateTraceabilityReport(testResults = {}) {
  const byRequirement = new Map();

  // Group tests by requirement
  for (const [testName, metadata] of testMetadata.entries()) {
    const req = metadata.requirement || 'uncategorized';
    if (!byRequirement.has(req)) {
      byRequirement.set(req, {
        requirement: req,
        tests: [],
        passed: 0,
        failed: 0,
        total: 0,
      });
    }

    const group = byRequirement.get(req);
    group.tests.push({ name: testName, ...metadata });
    group.total += 1;
  }

  // Generate report lines
  const lines = [
    '',
    'Test Coverage by Requirement',
    '─'.repeat(60),
    '',
  ];

  for (const [, group] of byRequirement.entries()) {
    const pct = group.total > 0 ? ((group.passed / group.total) * 100).toFixed(0) : 0;
    const status = group.failed > 0 ? '⚠️ ' : '✅';
    lines.push(
      `${status} ${group.requirement.padEnd(20)} ${group.passed}/${group.total} passed (${pct}%)`,
    );

    // Show test names for failed requirements
    if (group.failed > 0) {
      for (const test of group.tests) {
        if (test.status === 'failed') {
          lines.push(`   ├─ ❌ ${test.name}`);
        }
      }
    }
  }

  lines.push('');
  const totalPassed = Array.from(byRequirement.values()).reduce((s, g) => s + g.passed, 0);
  const totalTests = Array.from(byRequirement.values()).reduce((s, g) => s + g.total, 0);
  const totalPct = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(0) : 0;

  lines.push(`Coverage: ${totalPassed}/${totalTests} tests passing (${totalPct}%)`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Check if a test requirement is satisfied
 * @param {string} requirement - ADR/issue ID
 * @returns {boolean} True if at least one test exists for this requirement
 */
export function hasRequirementCoverage(requirement) {
  for (const metadata of testMetadata.values()) {
    if (metadata.requirement === requirement) {
      return true;
    }
  }
  return false;
}

/**
 * Get all tests for a requirement
 * @param {string} requirement - ADR/issue ID
 * @returns {array} Array of test names
 */
export function getRequirementTests(requirement) {
  const tests = [];
  for (const [name, metadata] of testMetadata.entries()) {
    if (metadata.requirement === requirement) {
      tests.push(name);
    }
  }
  return tests;
}

/**
 * Verify all governed files have tests
 * @param {array} governedFiles - Files that ADR governs
 * @param {array} testFiles - Test files that exist
 * @returns {object} { missing: [], verified: [] }
 */
export function verifyGovernedFileCoverage(governedFiles = [], testFiles = []) {
  const missing = [];
  const verified = [];

  for (const file of governedFiles) {
    const baseName = file.split('/').pop().replace(/\.[^.]+$/, '');
    const hasTest = testFiles.some((t) => t.includes(baseName));

    if (hasTest) {
      verified.push(file);
    } else {
      missing.push(file);
    }
  }

  return { missing, verified };
}

export default {
  tag,
  test,
  requirementGroup,
  generateTraceabilityReport,
  hasRequirementCoverage,
  getRequirementTests,
  verifyGovernedFileCoverage,
};
