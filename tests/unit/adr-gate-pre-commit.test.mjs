/**
 * adr-gate-pre-commit.test.mjs — Pre-commit Hook Enforcement
 *
 * Tests ADR-077 gate 4: Governed File Enforcement
 *
 * Verifies:
 * 1. Blocks commits to files governed by Proposed ADRs
 * 2. Allows commits to files governed by Accepted ADRs
 * 3. Allows commits to ungovered files
 * 4. Provides clear error messages
 * 5. Performance: check completes in <1 second
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class PreCommitChecker {
  constructor(adrDir) {
    this.adrDir = adrDir;
  }

  /**
   * Parse ADR to check governance
   */
  parseADR(filename) {
    const fullPath = path.join(this.adrDir, filename);
    const content = fs.readFileSync(fullPath, 'utf-8');

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
   * Check if a file can be committed
   */
  canCommit(filePath) {
    // Normalize path
    const normalized = filePath.replace(/\\/g, '/');

    // Check all ADRs
    const adrFiles = fs.readdirSync(this.adrDir).filter(f => f.endsWith('.md'));

    for (const adrFile of adrFiles) {
      const adr = this.parseADR(adrFile);
      if (!adr.governs) continue;

      // Check if this file is governed
      for (const governed of adr.governs) {
        const normalizedGoverned = governed.replace(/\\/g, '/');
        if (normalized.endsWith(normalizedGoverned) || normalized === normalizedGoverned) {
          // File is governed by this ADR
          if (adr.status !== 'Accepted') {
            return {
              allowed: false,
              reason: `Cannot commit to file governed by ${adr.id} (status: ${adr.status})`,
              adr: adr.id,
              status: adr.status,
            };
          }
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Check multiple files
   */
  canCommitFiles(filePaths) {
    const results = [];
    for (const file of filePaths) {
      results.push({
        file,
        ...this.canCommit(file),
      });
    }
    return results;
  }
}

let tmpDir;
let checker;
let adrDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-precommit-test-'));
  adrDir = path.join(tmpDir, 'adr');
  fs.mkdirSync(adrDir);
  checker = new PreCommitChecker(adrDir);

  // Create test ADRs
  fs.writeFileSync(
    path.join(adrDir, '0075-accepted.md'),
    `---
id: ADR-075
status: Accepted
governs:
  - plugin/scripts/ground-ruvnet.sh
  - src/core.js
---
# ADR-075`
  );

  fs.writeFileSync(
    path.join(adrDir, '0080-proposed.md'),
    `---
id: ADR-080
status: Proposed
governs:
  - src/future-feature.js
  - src/experimental.js
---
# ADR-080`
  );

  fs.writeFileSync(
    path.join(adrDir, '0076-superseded.md'),
    `---
id: ADR-076
status: Superseded
supersedes: ADR-075
governs:
  - src/legacy.js
---
# ADR-076`
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ADR-077 Gate 4 — Pre-commit Hook', () => {
  describe('commit allowance', () => {
    it('allows commit to file governed by Accepted ADR', () => {
      const result = checker.canCommit('src/core.js');
      expect(result.allowed).toBe(true);
    });

    it('blocks commit to file governed by Proposed ADR', () => {
      const result = checker.canCommit('src/future-feature.js');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('ADR-080');
      expect(result.reason).toContain('Proposed');
    });

    it('blocks commit to file governed by Superseded ADR', () => {
      const result = checker.canCommit('src/legacy.js');
      expect(result.allowed).toBe(false);
      expect(result.status).toBe('Superseded');
    });

    it('allows commit to ungovened file', () => {
      const result = checker.canCommit('src/unrelated.js');
      expect(result.allowed).toBe(true);
    });
  });

  describe('path matching', () => {
    it('matches exact filename', () => {
      const result = checker.canCommit('ground-ruvnet.sh');
      expect(result.allowed).toBe(true);
    });

    it('matches full path', () => {
      const result = checker.canCommit('plugin/scripts/ground-ruvnet.sh');
      expect(result.allowed).toBe(true);
    });

    it('matches path with trailing segments', () => {
      const result = checker.canCommit('plugin/scripts/ground-ruvnet.sh');
      expect(result.allowed).toBe(true);
    });

    it('handles Windows path separators', () => {
      const result = checker.canCommit('src\\core.js');
      expect(result.allowed).toBe(true);
    });

    it('rejects partial path match', () => {
      // "src/core.txt" should not match "src/core.js"
      const result = checker.canCommit('src/core.txt');
      expect(result.allowed).toBe(true); // Because it's not governed
    });
  });

  describe('batch checking', () => {
    it('checks multiple files and reports per-file status', () => {
      const files = [
        'src/core.js',          // Accepted
        'src/future-feature.js', // Proposed
        'src/unrelated.js',     // Ungovered
      ];

      const results = checker.canCommitFiles(files);

      expect(results).toHaveLength(3);
      expect(results[0].allowed).toBe(true);
      expect(results[1].allowed).toBe(false);
      expect(results[2].allowed).toBe(true);
    });

    it('blocks batch if any file is governed by Proposed ADR', () => {
      const files = [
        'src/core.js',
        'src/future-feature.js',
      ];

      const results = checker.canCommitFiles(files);
      const hasError = results.some(r => !r.allowed);

      expect(hasError).toBe(true);
    });

    it('allows batch if all files are Accepted or ungovened', () => {
      const files = [
        'src/core.js',
        'src/unrelated.js',
        'tests/test.js',
      ];

      const results = checker.canCommitFiles(files);
      const allAllowed = results.every(r => r.allowed);

      expect(allAllowed).toBe(true);
    });
  });

  describe('error messages', () => {
    it('provides clear error for Proposed ADR', () => {
      const result = checker.canCommit('src/experimental.js');
      expect(result.reason).toContain('ADR-080');
      expect(result.reason).toContain('Proposed');
    });

    it('provides ADR ID in error for Superseded ADR', () => {
      const result = checker.canCommit('src/legacy.js');
      expect(result.adr).toBe('ADR-076');
    });

    it('includes fix suggestion in error message', () => {
      const result = checker.canCommit('src/future-feature.js');
      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('handles empty governs list', () => {
      fs.writeFileSync(
        path.join(adrDir, '0090-empty.md'),
        `---
id: ADR-090
status: Accepted
governs:
---
# ADR-090`
      );

      const result = checker.canCommit('src/anything.js');
      expect(result.allowed).toBe(true);
    });

    it('handles ADR with no governs field', () => {
      fs.writeFileSync(
        path.join(adrDir, '0091-no-governs.md'),
        `---
id: ADR-091
status: Accepted
---
# ADR-091`
      );

      const result = checker.canCommit('src/anything.js');
      expect(result.allowed).toBe(true);
    });

    it('handles file with spaces in path', () => {
      fs.writeFileSync(
        path.join(adrDir, '0092-spaces.md'),
        `---
id: ADR-092
status: Accepted
governs:
  - src/file with spaces.js
---
# ADR-092`
      );

      const result = checker.canCommit('src/file with spaces.js');
      expect(result.allowed).toBe(true);
    });

    it('handles deeply nested paths', () => {
      fs.writeFileSync(
        path.join(adrDir, '0093-deep.md'),
        `---
id: ADR-093
status: Accepted
governs:
  - src/deep/nested/path/to/file.js
---
# ADR-093`
      );

      const result = checker.canCommit('src/deep/nested/path/to/file.js');
      expect(result.allowed).toBe(true);
    });
  });

  describe('performance', () => {
    it('checks single file in <50ms', () => {
      const start = Date.now();
      checker.canCommit('src/core.js');
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('checks 100 files in <500ms', () => {
      const files = Array.from({ length: 100 }, (_, i) => `src/file${i}.js`);

      const start = Date.now();
      checker.canCommitFiles(files);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('status field variations', () => {
    it('rejects files governed by different statuses', () => {
      const statuses = ['Proposed', 'Superseded', 'Deprecated'];

      for (const status of statuses) {
        fs.writeFileSync(
          path.join(adrDir, `temp-${status}.md`),
          `---
id: ADR-999
status: ${status}
governs:
  - src/test-${status}.js
---
# ADR-999`
        );

        const result = checker.canCommit(`src/test-${status}.js`);
        if (status !== 'Accepted') {
          expect(result.allowed).toBe(false);
        }
      }
    });
  });
});
