#!/usr/bin/env node
/**
 * ADR Implementation Status Gate (ADR-077 Gate 3)
 *
 * Verifies that every ADR's impl field matches implementation reality
 * - For impl=built: governed files must exist
 * - For impl=proposed: code must NOT exist
 * - For impl=partial: must include completion estimate
 *
 * Runs at pre-release to block bad releases
 *
 * Exit codes:
 *   0 = all impl statuses match code reality
 *   1 = mismatch detected (blocks release)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');

const colors = {
  RED: '\x1b[0;31m',
  GREEN: '\x1b[0;32m',
  YELLOW: '\x1b[1;33m',
  BLUE: '\x1b[0;34m',
  NC: '\x1b[0m',
};

/**
 * Parse ADR frontmatter
 */
function parseADRFrontmatter(content) {
  const lines = content.split('\n');
  const metadata = {};
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        break;
      }
    }

    if (inFrontmatter && i > 0) {
      const match = lines[i].match(/^(\w+):\s*(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2].trim();
        metadata[key] = value;

        // Handle YAML lists (governs:)
        if (key === 'governs') {
          metadata.governs = [];
          let j = i + 1;
          while (j < lines.length) {
            const itemMatch = lines[j].match(/^\s*-\s+(.+)$/);
            if (itemMatch) {
              metadata.governs.push(itemMatch[1].trim());
              j++;
            } else if (lines[j].trim() === '' || lines[j].match(/^[a-z]+:/)) {
              break;
            } else {
              j++;
            }
          }
        }
      }
    }
  }

  return metadata;
}

/**
 * Check if governed files exist
 */
function checkFilesExist(governedPaths) {
  const missing = [];
  const existing = [];

  for (const filePath of governedPaths) {
    const fullPath = path.join(REPO_ROOT, filePath);
    if (fs.existsSync(fullPath)) {
      existing.push(filePath);
    } else {
      missing.push(filePath);
    }
  }

  return { existing, missing };
}

/**
 * Get the last commit date for a file
 */
function getLastCommitDate(filePath) {
  try {
    const output = execSync(`git log -1 --format=%ai "${filePath}"`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Validate a single ADR's implementation status
 */
function validateADRImplementation(adrFile) {
  const fullPath = path.join(ADR_DIR, adrFile);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const metadata = parseADRFrontmatter(content);

  const violations = [];

  // Check impl field exists
  if (!metadata.impl) {
    violations.push({
      type: 'missing-impl',
      message: `${metadata.id} missing impl field`,
      severity: 'warning',
    });
    return violations;
  }

  const impl = metadata.impl.toLowerCase();
  const governs = metadata.governs || [];

  // Check impl=built
  if (impl === 'built') {
    if (governs.length === 0) {
      violations.push({
        type: 'no-governed-files',
        message: `${metadata.id} impl=built but no governs list`,
        severity: 'warning',
      });
    } else {
      const { existing, missing } = checkFilesExist(governs);

      if (missing.length > 0) {
        violations.push({
          type: 'missing-files',
          message: `${metadata.id} impl=built but files missing: ${missing.join(', ')}`,
          files: missing,
          severity: 'error',
        });
      }

      // Check updated date is recent
      if (metadata.updated) {
        const updatedDate = new Date(metadata.updated);
        const now = new Date();
        const daysSinceUpdate = Math.floor((now - updatedDate) / (1000 * 60 * 60 * 24));

        // Warn if update is older than 30 days but no recent commits
        if (daysSinceUpdate > 30 && existing.length > 0) {
          const recentCommit = existing.some(f => {
            const lastCommit = getLastCommitDate(f);
            if (!lastCommit) return false;
            const commitDate = new Date(lastCommit);
            const daysSinceCommit = Math.floor((now - commitDate) / (1000 * 60 * 60 * 24));
            return daysSinceCommit < 30;
          });

          if (!recentCommit) {
            violations.push({
              type: 'stale-update',
              message: `${metadata.id} updated ${daysSinceUpdate} days ago (${metadata.updated})`,
              severity: 'info',
            });
          }
        }
      }
    }
  }

  // Check impl=proposed
  if (impl === 'proposed') {
    const { existing } = checkFilesExist(governs);
    if (existing.length > 0) {
      violations.push({
        type: 'proposed-has-code',
        message: `${metadata.id} impl=proposed but code exists: ${existing.join(', ')}`,
        files: existing,
        severity: 'error',
      });
    }
  }

  // Check impl=partial
  if (impl === 'partial') {
    if (!metadata.completion) {
      violations.push({
        type: 'partial-no-estimate',
        message: `${metadata.id} impl=partial but no completion estimate in frontmatter`,
        severity: 'warning',
      });
    }
  }

  return violations;
}

/**
 * Validate all ADRs
 */
function validateAllADRs() {
  const files = fs.readdirSync(ADR_DIR).filter(f => f.endsWith('.md'));
  const allViolations = [];
  const stats = {
    total: files.length,
    errors: 0,
    warnings: 0,
    passed: 0,
  };

  for (const file of files) {
    const violations = validateADRImplementation(file);
    allViolations.push(...violations.map(v => ({ file, ...v })));

    violations.forEach(v => {
      if (v.severity === 'error') stats.errors++;
      else if (v.severity === 'warning') stats.warnings++;
    });

    if (violations.length === 0) stats.passed++;
  }

  return { violations: allViolations, stats };
}

/**
 * Format and display results
 */
function reportResults(violations, stats) {
  // Group by severity
  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');
  const infos = violations.filter(v => v.severity === 'info');

  console.log(`\n${colors.BLUE}ADR Implementation Status Report${colors.NC}`);
  console.log(`Total ADRs: ${stats.total} | Passed: ${colors.GREEN}${stats.passed}${colors.NC} | Warnings: ${colors.YELLOW}${stats.warnings}${colors.NC} | Errors: ${colors.RED}${stats.errors}${colors.NC}\n`);

  if (errors.length > 0) {
    console.error(`${colors.RED}✗ Errors (blocking release):${colors.NC}`);
    errors.forEach(e => {
      console.error(`  ${e.file}: ${e.message}`);
      if (e.files) {
        e.files.forEach(f => console.error(`    - ${f}`));
      }
    });
    console.error();
  }

  if (warnings.length > 0) {
    console.warn(`${colors.YELLOW}⚠ Warnings:${colors.NC}`);
    warnings.forEach(w => {
      console.warn(`  ${w.file}: ${w.message}`);
    });
    console.warn();
  }

  if (infos.length > 0 && process.env.VERBOSE) {
    console.log(`${colors.BLUE}ℹ Info:${colors.NC}`);
    infos.forEach(i => {
      console.log(`  ${i.file}: ${i.message}`);
    });
    console.log();
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log(`${colors.GREEN}✓ All ADRs have implementation status matching code reality${colors.NC}\n`);
  }

  return errors.length > 0;
}

/**
 * Main execution
 */
async function main() {
  try {
    const { violations, stats } = validateAllADRs();
    const hasErrors = reportResults(violations, stats);

    if (hasErrors) {
      console.error(`${colors.RED}Release gate BLOCKED: implementation status mismatches detected${colors.NC}`);
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error(`${colors.RED}✗ Fatal error:${colors.NC}`, err.message);
    process.exit(1);
  }
}

main();
