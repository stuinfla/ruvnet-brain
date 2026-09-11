/**
 * adr-gate-validate.test.mjs — ADR state consistency validation gate
 *
 * Tests ADR-077 gate 1: ADR State Consistency Gate
 *
 * Verifies:
 * 1. ADR status matches implementation reality (Proposed/Accepted/Superseded)
 * 2. Governed file changes require Accepted ADR
 * 3. Superseded ADRs have replacement ADR listed
 * 4. Updated date reflects status changes
 * 5. Performance: validation completes in <2 seconds
 * 6. Clear error messages guide fixes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class ADRValidator {
  constructor(adrDir) {
    this.adrDir = adrDir;
  }

  validateAll() {
    const files = fs.readdirSync(this.adrDir).filter(f => f.endsWith('.md'));
    const results = [];

    files.forEach(file => {
      const content = fs.readFileSync(path.join(this.adrDir, file), 'utf8');
      const adr = this.parseADR(file, content);
      const violations = this.validateADR(adr);
      if (violations.length > 0) {
        results.push({ file, adr, violations });
      }
    });

    return results;
  }

  parseADR(filename, content) {
    const lines = content.split('\n');
    const adr = { filename };

    let inFrontmatter = false;
    let frontmatterEnd = 0;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        if (!inFrontmatter) {
          inFrontmatter = true;
        } else {
          frontmatterEnd = i;
          break;
        }
      }

      if (inFrontmatter && i > 0) {
        const match = lines[i].match(/^(\w+):\s*(.+)$/);
        if (match) {
          const key = match[1];
          const value = match[2].trim();

          if (key === 'id') adr.id = value;
          else if (key === 'status') adr.status = value;
          else if (key === 'governs') {
            adr.governs = this.parseYAMLList(lines, i);
          } else if (key === 'supersedes') adr.supersedes = value;
          else if (key === 'impl') adr.impl = value;
          else if (key === 'updated') adr.updated = value;
        }
      }
    }

    return adr;
  }

  parseYAMLList(lines, startIdx) {
    const items = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^\s*-\s+(.+)$/)) {
        const match = line.match(/^\s*-\s+(.+)$/);
        items.push(match[1]);
      } else if (!line.trim().startsWith('-')) {
        break;
      }
    }
    return items;
  }

  validateADR(adr) {
    const violations = [];

    // Check 1: Superseded ADRs must list replacement
    if (adr.status === 'Superseded' && !adr.supersedes) {
      violations.push({
        type: 'missing-supersession',
        message: `${adr.id} is Superseded but no replacement ADR listed`,
        fix: 'List replacement ADR in supersedes field',
      });
    }

    // Check 2: Proposed ADRs should not have impl=built
    if (adr.status === 'Proposed' && adr.impl === 'built') {
      violations.push({
        type: 'impl-mismatch',
        message: `${adr.id} status is Proposed but impl=built (code is live)`,
        fix: 'Change status to Accepted or revert implementation',
      });
    }

    // Check 3: Accepted ADRs with impl=built should have updated date
    if (adr.status === 'Accepted' && adr.impl === 'built' && !adr.updated) {
      violations.push({
        type: 'missing-updated-date',
        message: `${adr.id} is Accepted and impl=built but has no updated date`,
        fix: 'Add updated: YYYY-MM-DD field to frontmatter',
      });
    }

    return violations;
  }

  canCommit(filename) {
    const content = fs.readFileSync(filename, 'utf8');
    const dirname = path.dirname(filename);
    const adrFiles = fs.readdirSync(dirname).filter(f => f.endsWith('.md'));

    let governedBy = null;
    for (const adrFile of adrFiles) {
      const adrContent = fs.readFileSync(path.join(dirname, adrFile), 'utf8');
      const adr = this.parseADR(adrFile, adrContent);
      if (adr.governs && adr.governs.some(g => filename.includes(g))) {
        governedBy = adr;
        break;
      }
    }

    if (governedBy && governedBy.status !== 'Accepted') {
      return {
        allowed: false,
        reason: `Cannot commit to file governed by ${governedBy.id} (status: ${governedBy.status})`,
      };
    }

    return { allowed: true };
  }
}

let tmpDir;
let validator;
let adrDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-validate-test-'));
  adrDir = path.join(tmpDir, 'adr');
  fs.mkdirSync(adrDir);
  validator = new ADRValidator(adrDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ADR-077 Gate 1 — State Consistency', () => {
  describe('low — ADR format parsing', () => {
    it('parses ADR YAML frontmatter correctly', () => {
      const content = `---
id: ADR-075
title: Test ADR
status: Accepted
impl: built
updated: 2026-09-11
governs:
  - plugin/scripts/ground-ruvnet.sh
  - docs/GROUNDING.md
supersedes:
---

# ADR-075 Test`;

      fs.writeFileSync(path.join(adrDir, '0075-test.md'), content);
      const adr = validator.parseADR('0075-test.md', content);

      expect(adr.id).toBe('ADR-075');
      expect(adr.status).toBe('Accepted');
      expect(adr.impl).toBe('built');
      expect(adr.governs).toContain('plugin/scripts/ground-ruvnet.sh');
    });

    it('handles ADRs without optional fields', () => {
      const content = `---
id: ADR-076
title: Test ADR
status: Proposed
---

# ADR-076 Test`;

      fs.writeFileSync(path.join(adrDir, '0076-test.md'), content);
      const adr = validator.parseADR('0076-test.md', content);

      expect(adr.id).toBe('ADR-076');
      expect(adr.impl).toBeUndefined();
      expect(adr.governs).toBeUndefined();
    });
  });

  describe('medium — consistency validation', () => {
    it('passes validation for Accepted ADR with impl=built and updated date', () => {
      const content = `---
id: ADR-075
status: Accepted
impl: built
updated: 2026-09-11
---

# ADR-075`;

      fs.writeFileSync(path.join(adrDir, '0075-test.md'), content);
      const adr = validator.parseADR('0075-test.md', content);
      const violations = validator.validateADR(adr);

      expect(violations).toHaveLength(0);
    });

    it('detects when Superseded ADR has no replacement listed', () => {
      const content = `---
id: ADR-075
status: Superseded
---

# ADR-075`;

      fs.writeFileSync(path.join(adrDir, '0075-test.md'), content);
      const adr = validator.parseADR('0075-test.md', content);
      const violations = validator.validateADR(adr);

      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('missing-supersession');
      expect(violations[0].message).toContain('no replacement ADR');
    });

    it('detects Proposed ADR with impl=built (code went live)', () => {
      const content = `---
id: ADR-076
status: Proposed
impl: built
---

# ADR-076`;

      fs.writeFileSync(path.join(adrDir, '0076-test.md'), content);
      const adr = validator.parseADR('0076-test.md', content);
      const violations = validator.validateADR(adr);

      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('impl-mismatch');
      expect(violations[0].message).toContain('status is Proposed');
    });

    it('warns if Accepted/built ADR lacks updated date', () => {
      const content = `---
id: ADR-075
status: Accepted
impl: built
---

# ADR-075`;

      fs.writeFileSync(path.join(adrDir, '0075-test.md'), content);
      const adr = validator.parseADR('0075-test.md', content);
      const violations = validator.validateADR(adr);

      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].type).toBe('missing-updated-date');
    });

    it('allows Proposed ADR with impl=proposed', () => {
      const content = `---
id: ADR-076
status: Proposed
impl: proposed
---

# ADR-076`;

      fs.writeFileSync(path.join(adrDir, '0076-test.md'), content);
      const adr = validator.parseADR('0076-test.md', content);
      const violations = validator.validateADR(adr);

      expect(violations).toHaveLength(0);
    });
  });

  describe('high — governance enforcement', () => {
    it('blocks commit to file governed by Proposed ADR', () => {
      const adrContent = `---
id: ADR-076
status: Proposed
governs:
  - scripts/memory-ensure.mjs
---

# ADR-076`;

      fs.writeFileSync(path.join(adrDir, '0076-test.md'), adrContent);

      const canCommit = validator.canCommit(path.join(adrDir, '../scripts/memory-ensure.mjs'));
      expect(canCommit.allowed).toBe(false);
      expect(canCommit.reason).toContain('Proposed');
    });

    it('allows commit to file governed by Accepted ADR', () => {
      const adrContent = `---
id: ADR-076
status: Accepted
governs:
  - scripts/memory-ensure.mjs
---

# ADR-076`;

      fs.writeFileSync(path.join(adrDir, '0076-test.md'), adrContent);

      const canCommit = validator.canCommit(path.join(adrDir, '../scripts/memory-ensure.mjs'));
      expect(canCommit.allowed).toBe(true);
    });

    it('blocks commit to file governed by Superseded ADR', () => {
      const adrContent = `---
id: ADR-075
status: Superseded
supersedes: ADR-074
governs:
  - scripts/old-approach.mjs
---

# ADR-075`;

      fs.writeFileSync(path.join(adrDir, '0075-test.md'), adrContent);

      const canCommit = validator.canCommit(path.join(adrDir, '../scripts/old-approach.mjs'));
      expect(canCommit.allowed).toBe(false);
    });

    it('allows commits to uncontrolled files', () => {
      const canCommit = validator.canCommit(path.join(tmpDir, 'random-file.txt'));
      expect(canCommit.allowed).toBe(true);
    });
  });

  describe('numeric — validation performance', () => {
    it('validates all ADRs in <2 seconds', () => {
      for (let i = 0; i < 50; i++) {
        const content = `---
id: ADR-${String(i).padStart(3, '0')}
status: ${i % 3 === 0 ? 'Proposed' : i % 3 === 1 ? 'Accepted' : 'Superseded'}
impl: ${i % 2 === 0 ? 'built' : 'proposed'}
updated: 2026-09-11
governs:
  - file-${i}-a.mjs
  - file-${i}-b.mjs
---

# ADR-${i}`;
        fs.writeFileSync(path.join(adrDir, `000${i}-test.md`), content);
      }

      const start = performance.now();
      const results = validator.validateAll();
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(2000);
    });

    it('checks commit against 100+ ADRs in <100ms', () => {
      for (let i = 0; i < 100; i++) {
        const content = `---
id: ADR-${String(i).padStart(3, '0')}
status: Accepted
governs:
  - file-${i}.mjs
---

# ADR`;
        fs.writeFileSync(path.join(adrDir, `adr-${i}.md`), content);
      }

      const start = performance.now();
      const canCommit = validator.canCommit(path.join(adrDir, '../random-file.txt'));
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('qualitative — error messaging', () => {
    it('provides actionable fix guidance for Superseded/no replacement', () => {
      const content = `---
id: ADR-075
status: Superseded
---

# ADR-075`;

      fs.writeFileSync(path.join(adrDir, '0075-test.md'), content);
      const adr = validator.parseADR('0075-test.md', content);
      const violations = validator.validateADR(adr);

      expect(violations[0].fix).toContain('replacement ADR');
      expect(violations[0].fix.length).toBeGreaterThan(10);
    });

    it('explains impl mismatch clearly', () => {
      const content = `---
id: ADR-076
status: Proposed
impl: built
---

# ADR-076`;

      fs.writeFileSync(path.join(adrDir, '0076-test.md'), content);
      const adr = validator.parseADR('0076-test.md', content);
      const violations = validator.validateADR(adr);

      expect(violations[0].message).toContain('Proposed');
      expect(violations[0].message).toContain('impl=built');
      expect(violations[0].fix).toMatch(/status|revert/i);
    });
  });
});
