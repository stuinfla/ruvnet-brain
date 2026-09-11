#!/usr/bin/env node
/**
 * ADR Validation Script (ADR-081)
 *
 * Validates that architecture commits link to Architecture Decision Records.
 * - Parses commit message for ADR-NNNN pattern
 * - Verifies ADRs exist in docs/adr/
 * - Checks ADR status (blocks Proposed ADRs for shipping code)
 * - Supports bypass via RUVNET_SKIP_ADR_CHECK=1
 *
 * Exit codes:
 *   0 = validation passed
 *   1 = validation failed (no ADR when required)
 *   2 = ADR reference error (doesn't exist, wrong status)
 *   3 = internal error (file system, parse error)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

/**
 * Colors for terminal output
 */
const colors = {
  RED: '\x1b[0;31m',
  GREEN: '\x1b[0;32m',
  YELLOW: '\x1b[1;33m',
  BLUE: '\x1b[0;34m',
  NC: '\x1b[0m', // No Color
};

/**
 * Parse commit message and extract ADR references
 * Matches pattern: ADR-NNNN or ADR-0NNN
 */
function extractADRReferences(message) {
  const adrPattern = /ADR-(\d{4})(?!\d)/gi;
  const matches = [...message.matchAll(adrPattern)];
  const adrNumbers = matches.map((m) => parseInt(m[1], 10));
  return [...new Set(adrNumbers)]; // unique
}

/**
 * Load ADR metadata from YAML frontmatter
 */
function loadADRMetadata(adrNumber) {
  const paddedNumber = String(adrNumber).padStart(4, '0');
  const fileName = `${paddedNumber}-*.md`;
  const pattern = new RegExp(`^${paddedNumber}-`, 'i');

  try {
    const files = fs.readdirSync(ADR_DIR);
    const adrFile = files.find((f) => pattern.test(f));

    if (!adrFile) {
      return { exists: false };
    }

    const filePath = path.join(ADR_DIR, adrFile);
    const content = fs.readFileSync(filePath, 'utf-8');

    // Extract YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return { exists: true, status: 'unknown' };
    }

    const frontmatter = frontmatterMatch[1];
    const statusMatch = frontmatter.match(/^status:\s*(.+?)$/im);
    const status = statusMatch ? statusMatch[1].trim() : 'unknown';

    return {
      exists: true,
      status,
      file: adrFile,
      filePath,
    };
  } catch (err) {
    throw new Error(`Error reading ADR ${paddedNumber}: ${err.message}`);
  }
}

/**
 * Get files being committed (from git staging area)
 * This is a simplified version for pre-commit hook usage
 */
function getStagedFiles() {
  try {
    // Try to get staged files from git
    // In a pre-commit hook, we can check git diff-index
    const output = execSync('git diff-index --cached --name-only HEAD 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output ? output.split('\n') : [];
  } catch {
    // If git command fails, assume we're in pre-commit context
    return [];
  }
}

/**
 * Check if commit touches only non-architecture files
 * (tests, docs, config)
 */
function isNonArchitectureCommit(files) {
  const nonArchPatterns = [
    /^tests\//,
    /^docs\/(?!adr\/)/,
    /\.md$/,
    /^config\//,
    /^\.github\//,
    /\.json$/,
  ];

  if (files.length === 0) return false; // Cannot determine, be conservative

  return files.every((file) =>
    nonArchPatterns.some((pattern) => pattern.test(file))
  );
}

/**
 * Check if code would be shipped (in package.json files array)
 */
function wouldShip(changedFiles) {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8')
    );
    const filesArray = packageJson.files || [];

    return changedFiles.some((file) => {
      // Check if file matches any pattern in package.json files array
      return filesArray.some((pattern) => {
        // Simple glob support: "scripts/" matches "scripts/foo.mjs"
        if (pattern.endsWith('/')) {
          return file.startsWith(pattern);
        }
        // Exact match or wildcard
        if (pattern === '!' + file) return false; // Exclusion
        if (pattern === file) return true;
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
          return regex.test(file);
        }
        return false;
      });
    });
  } catch (err) {
    console.error(`${colors.YELLOW}Warning: Could not read package.json: ${err.message}${colors.NC}`);
    return false;
  }
}

/**
 * Main validation function
 */
export async function validateADRReferences(commitMessage, changedFiles = []) {
  const bypassEnv = process.env.RUVNET_SKIP_ADR_CHECK === '1';

  if (bypassEnv) {
    console.log(
      `${colors.YELLOW}⚠  ADR validation BYPASSED (RUVNET_SKIP_ADR_CHECK=1)${colors.NC}`
    );
    return { passed: true, bypassed: true };
  }

  // Extract ADR references
  const adrNumbers = extractADRReferences(commitMessage);

  // Check if this is a non-architecture commit (test, doc, config only)
  const isNonArch = isNonArchitectureCommit(changedFiles);

  // If no ADRs referenced
  if (adrNumbers.length === 0) {
    if (isNonArch) {
      // OK: non-architecture commit can skip ADR
      return { passed: true, reason: 'non-architecture-commit' };
    }

    // FAIL: architecture commit must reference ADR
    return {
      passed: false,
      error: 'Architecture changes require ADR reference',
      hint: 'Add ADR-NNNN to commit message',
      example: 'Implement feature ADR-0081: ...',
    };
  }

  // Validate each ADR
  const results = [];
  for (const adrNumber of adrNumbers) {
    const metadata = loadADRMetadata(adrNumber);

    if (!metadata.exists) {
      results.push({
        adrNumber,
        valid: false,
        error: `ADR-${String(adrNumber).padStart(4, '0')} not found in docs/adr/`,
      });
      continue;
    }

    // Check if Proposed ADR is being shipped
    if (metadata.status === 'Proposed' && wouldShip(changedFiles)) {
      results.push({
        adrNumber,
        valid: false,
        error: `ADR-${String(adrNumber).padStart(4, '0')} is Proposed; cannot ship code without accepted decision`,
        file: metadata.file,
      });
      continue;
    }

    results.push({
      adrNumber,
      valid: true,
      status: metadata.status,
      file: metadata.file,
    });
  }

  // Check if all ADRs are valid
  const allValid = results.every((r) => r.valid);

  if (!allValid) {
    const errors = results.filter((r) => !r.valid);
    return {
      passed: false,
      errors,
      adrs: results,
    };
  }

  return {
    passed: true,
    adrs: results,
    count: adrNumbers.length,
  };
}

/**
 * Format validation result for display
 */
function formatResult(result) {
  if (result.passed) {
    if (result.bypassed) {
      return `${colors.YELLOW}⚠  Validation bypassed${colors.NC}`;
    }
    if (result.reason === 'non-architecture-commit') {
      return `${colors.GREEN}✓ Non-architecture commit (ADR not required)${colors.NC}`;
    }
    const adrList = result.adrs.map((a) => `ADR-${String(a.adrNumber).padStart(4, '0')}`).join(', ');
    return `${colors.GREEN}✓ ADR validation passed (${adrList})${colors.NC}`;
  }

  // Failed validation
  let output = `${colors.RED}✗ ADR validation failed${colors.NC}\n`;

  if (result.error) {
    output += `\n${colors.RED}Error:${colors.NC} ${result.error}\n`;
    if (result.hint) {
      output += `${colors.YELLOW}Hint:${colors.NC} ${result.hint}\n`;
    }
    if (result.example) {
      output += `${colors.BLUE}Example:${colors.NC} ${result.example}\n`;
    }
  }

  if (result.errors) {
    output += `\n${colors.RED}Invalid ADR references:${colors.NC}\n`;
    for (const err of result.errors) {
      const adrId = `ADR-${String(err.adrNumber).padStart(4, '0')}`;
      output += `  ${adrId}: ${err.error}\n`;
      if (err.file) {
        output += `    File: ${err.file}\n`;
      }
    }
  }

  return output;
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(`${colors.RED}Usage: adr-validate.mjs <commit-message> [changed-files...]${colors.NC}`);
    console.error('');
    console.error('Args:');
    console.error('  <commit-message> : Git commit message to validate');
    console.error('  [changed-files]  : Space-separated list of changed file paths (optional)');
    process.exit(3);
  }

  const commitMessage = args[0];
  const changedFiles = args.slice(1);

  try {
    const result = await validateADRReferences(commitMessage, changedFiles);

    console.log(formatResult(result));
    process.exit(result.passed ? 0 : result.error ? 1 : 2);
  } catch (err) {
    console.error(`${colors.RED}✗ Validation error: ${err.message}${colors.NC}`);
    process.exit(3);
  }
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`${colors.RED}Fatal error: ${err.message}${colors.NC}`);
    process.exit(3);
  });
}

export default validateADRReferences;
