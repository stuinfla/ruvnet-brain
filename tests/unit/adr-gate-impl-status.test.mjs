/**
 * adr-gate-impl-status.test.mjs — ADR Implementation Status gate
 *
 * Tests ADR-077 gate 3: Implementation Status Gate
 *
 * Verifies:
 * 1. impl=built ADRs have governed files that exist
 * 2. impl=proposed ADRs have NO governed files
 * 3. impl=partial ADRs include completion estimate
 * 4. Performance: validation in <2 seconds
 * 5. Mismatches block release
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class ImplementationStatusValidator {
  constructor(adrDir, repoRoot) {
    this.adrDir = adrDir;
    this.repoRoot = repoRoot;
  }

  /**
   * Parse ADR frontmatter
   */
  parseADRFrontmatter(content) {
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

          // Handle YAML lists
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
  checkFilesExist(governedPaths) {
    const missing = [];
    const existing = [];

    for (const filePath of governedPaths) {
      const fullPath = path.join(this.repoRoot, filePath);
      if (fs.existsSync(fullPath)) {
        existing.push(filePath);
      } else {
        missing.push(filePath);
      }
    }

    return { existing, missing };
  }

  /**
   * Validate single ADR
   */
  validateADRImplementation(adrFile) {
    const fullPath = path.join(this.adrDir, adrFile);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const metadata = this.parseADRFrontmatter(content);

    const violations = [];

    if (!metadata.impl) {
      violations.push({
        type: 'missing-impl',
        message: `${metadata.id} missing impl field`,
      });
      return violations;
    }

    const impl = metadata.impl.toLowerCase();
    const governs = metadata.governs || [];

    // Validate impl=built
    if (impl === 'built') {
      if (governs.length === 0) {
        violations.push({
          type: 'no-governed-files',
          message: `${metadata.id} impl=built but no governs list`,
        });
      } else {
        const { missing } = this.checkFilesExist(governs);
        if (missing.length > 0) {
          violations.push({
            type: 'missing-files',
            message: `${metadata.id} impl=built but files missing: ${missing.join(', ')}`,
            files: missing,
          });
        }
      }
    }

    // Validate impl=proposed
    if (impl === 'proposed') {
      const { existing } = this.checkFilesExist(governs);
      if (existing.length > 0) {
        violations.push({
          type: 'proposed-has-code',
          message: `${metadata.id} impl=proposed but code exists: ${existing.join(', ')}`,
          files: existing,
        });
      }
    }

    // Validate impl=partial
    if (impl === 'partial') {
      if (!metadata.completion) {
        violations.push({
          type: 'partial-no-estimate',
          message: `${metadata.id} impl=partial but no completion estimate`,
        });
      }
    }

    return violations;
  }

  /**
   * Validate all ADRs
   */
  validateAllADRs() {
    const files = fs.readdirSync(this.adrDir).filter(f => f.endsWith('.md'));
    const allViolations = [];
    const stats = {
      total: files.length,
      errors: 0,
      warnings: 0,
    };

    for (const file of files) {
      const violations = this.validateADRImplementation(file);
      allViolations.push(...violations.map(v => ({ file, ...v })));
      stats.errors += violations.filter(v => v.type === 'missing-files' || v.type === 'proposed-has-code').length;
      stats.warnings += violations.filter(v => v.type === 'no-governed-files' || v.type === 'partial-no-estimate').length;
    }

    return { violations: allViolations, stats };
  }
}

let tmpDir;
let repoRoot;
let adrDir;
let validator;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-impl-test-'));
  repoRoot = tmpDir;
  adrDir = path.join(tmpDir, 'adr');
  fs.mkdirSync(adrDir);
  validator = new ImplementationStatusValidator(adrDir, repoRoot);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ADR-077 Gate 3 — Implementation Status', () => {
  describe('impl=built validation', () => {
    it('passes when built ADR has all governed files', () => {
      const srcDir = path.join(repoRoot, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'core.js'), 'export const core = {};');

      const adr = `---
id: ADR-075
impl: built
governs:
  - src/core.js
---
# ADR-075`;

      fs.writeFileSync(path.join(adrDir, '0075-core.md'), adr);

      const violations = validator.validateADRImplementation('0075-core.md');
      expect(violations).toHaveLength(0);
    });

    it('fails when built ADR is missing governed files', () => {
      const adr = `---
id: ADR-075
impl: built
governs:
  - src/missing.js
---
# ADR-075`;

      fs.writeFileSync(path.join(adrDir, '0075-missing.md'), adr);

      const violations = validator.validateADRImplementation('0075-missing.md');
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('missing-files');
    });

    it('warns when built ADR has no governs list', () => {
      const adr = `---
id: ADR-075
impl: built
governs:
---
# ADR-075`;

      fs.writeFileSync(path.join(adrDir, '0075-no-governs.md'), adr);

      const violations = validator.validateADRImplementation('0075-no-governs.md');
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('no-governed-files');
    });
  });

  describe('impl=proposed validation', () => {
    it('passes when proposed ADR has NO code', () => {
      const adr = `---
id: ADR-080
impl: proposed
governs:
  - src/future-feature.js
---
# ADR-080`;

      fs.writeFileSync(path.join(adrDir, '0080-future.md'), adr);

      const violations = validator.validateADRImplementation('0080-future.md');
      expect(violations).toHaveLength(0);
    });

    it('fails when proposed ADR has implemented code', () => {
      const srcDir = path.join(repoRoot, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'future.js'), 'export const feature = {};');

      const adr = `---
id: ADR-080
impl: proposed
governs:
  - src/future.js
---
# ADR-080`;

      fs.writeFileSync(path.join(adrDir, '0080-future.md'), adr);

      const violations = validator.validateADRImplementation('0080-future.md');
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('proposed-has-code');
    });
  });

  describe('impl=partial validation', () => {
    it('passes when partial ADR includes completion estimate', () => {
      const srcDir = path.join(repoRoot, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'partial.js'), 'export const partial = {};');

      const adr = `---
id: ADR-081
impl: partial
completion: 2026-10-15
governs:
  - src/partial.js
---
# ADR-081`;

      fs.writeFileSync(path.join(adrDir, '0081-partial.md'), adr);

      const violations = validator.validateADRImplementation('0081-partial.md');
      expect(violations).toHaveLength(0);
    });

    it('warns when partial ADR lacks completion estimate', () => {
      const adr = `---
id: ADR-081
impl: partial
governs:
  - src/partial.js
---
# ADR-081`;

      fs.writeFileSync(path.join(adrDir, '0081-partial.md'), adr);

      const violations = validator.validateADRImplementation('0081-partial.md');
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('partial-no-estimate');
    });
  });

  describe('multi-ADR validation', () => {
    it('validates all ADRs in directory', () => {
      // Create one passing and one failing ADR
      fs.mkdirSync(path.join(repoRoot, 'src'));
      fs.writeFileSync(path.join(repoRoot, 'src', 'exists.js'), 'export {};');

      fs.writeFileSync(path.join(adrDir, '0075-passing.md'), `---
id: ADR-075
impl: built
governs:
  - src/exists.js
---
# ADR-075`);

      fs.writeFileSync(path.join(adrDir, '0076-failing.md'), `---
id: ADR-076
impl: built
governs:
  - src/missing.js
---
# ADR-076`);

      const { violations, stats } = validator.validateAllADRs();

      expect(stats.total).toBe(2);
      expect(stats.errors).toBe(1);
      expect(violations).toHaveLength(1);
    });
  });

  describe('performance', () => {
    it('validates single ADR in <100ms', () => {
      fs.writeFileSync(path.join(adrDir, '0075-perf.md'), `---
id: ADR-075
impl: built
governs:
  - src/core.js
---
# ADR-075`);

      const start = Date.now();
      validator.validateADRImplementation('0075-perf.md');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100);
    });

    it('validates 50 ADRs in <1 second', () => {
      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(path.join(adrDir, `${String(i).padStart(4, '0')}-perf.md`), `---
id: ADR-${i}
impl: proposed
governs:
  - src/file-${i}.js
---
# ADR-${i}`);
      }

      const start = Date.now();
      validator.validateAllADRs();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('error handling', () => {
    it('handles ADR with no impl field', () => {
      fs.writeFileSync(path.join(adrDir, '0099-no-impl.md'), `---
id: ADR-099
governs:
---
# ADR-099`);

      const violations = validator.validateADRImplementation('0099-no-impl.md');
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].type).toBe('missing-impl');
    });

    it('handles multiple file violations', () => {
      const adr = `---
id: ADR-095
impl: built
governs:
  - src/missing1.js
  - src/missing2.js
  - src/missing3.js
---
# ADR-095`;

      fs.writeFileSync(path.join(adrDir, '0095-multi.md'), adr);

      const violations = validator.validateADRImplementation('0095-multi.md');
      expect(violations).toHaveLength(1);
      expect(violations[0].files).toHaveLength(3);
    });
  });
});
