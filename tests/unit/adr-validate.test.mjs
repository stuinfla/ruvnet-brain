import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import validateADRReferences from '../../scripts/adr-validate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');

describe('ADR Validation (ADR-081)', () => {
  describe('ADR extraction', () => {
    it('extracts single ADR reference from commit message', async () => {
      const message = 'Fix bug per ADR-0081';
      const result = await validateADRReferences(message, ['scripts/adr-validate.mjs']);
      expect(result.adrs).toBeDefined();
      expect(result.adrs.some((a) => a.adrNumber === 81)).toBe(true);
    });

    it('extracts multiple ADR references', async () => {
      const message = 'Feature: ADR-0081, ADR-0012, ADR-0008';
      const result = await validateADRReferences(message, ['scripts/adr-validate.mjs']);
      expect(result.adrs.length).toBe(3);
      expect(result.adrs.map((a) => a.adrNumber)).toEqual(expect.arrayContaining([81, 12, 8]));
    });

    it('handles ADR with leading zeros', async () => {
      const message = 'Implementation of ADR-0012';
      const result = await validateADRReferences(message, ['scripts/adr-validate.mjs']);
      expect(result.adrs.some((a) => a.adrNumber === 12)).toBe(true);
    });

    it('ignores non-matching patterns', async () => {
      const message = 'Fix using adr-12 or ADR 81 (not valid patterns)';
      const result = await validateADRReferences(message, ['docs/EXAMPLES.md']);
      expect(result.passed).toBe(true);
      expect(result.reason).toBe('non-architecture-commit');
      // adrs field won't exist for non-architecture commits
      expect(result.adrs).toBeUndefined();
    });
  });

  describe('ADR validation', () => {
    it('accepts commit with valid existing ADR', async () => {
      const message = 'Fix: Per ADR-0012 grounding gate on write path';
      const result = await validateADRReferences(message, ['scripts/adr-validate.mjs']);
      expect(result.passed).toBe(true);
      expect(result.adrs.some((a) => a.adrNumber === 12 && a.valid !== false)).toBe(true);
    });

    it('accepts commit with multiple valid ADRs', async () => {
      const message = 'Feature combining ADR-0081, ADR-0012, ADR-0008 principles';
      const result = await validateADRReferences(message, ['scripts/adr-validate.mjs']);
      expect(result.passed).toBe(true);
      expect(result.adrs.length).toBe(3);
      expect(result.adrs.every((a) => a.valid !== false)).toBe(true);
    });

    it('rejects commit with non-existent ADR', async () => {
      const message = 'Feature: ADR-9999 (does not exist)';
      const result = await validateADRReferences(message, ['scripts/adr-validate.mjs']);
      expect(result.passed).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.some((e) => e.adrNumber === 9999)).toBe(true);
    });

    it('accepts Proposed ADR for non-shipping files', async () => {
      // Find a Proposed ADR to test with
      const proposedADRs = fs.readdirSync(ADR_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const content = fs.readFileSync(path.join(ADR_DIR, f), 'utf-8');
          const statusMatch = content.match(/^status:\s*Proposed/im);
          return { file: f, isProposed: !!statusMatch };
        })
        .filter(a => a.isProposed);

      if (proposedADRs.length > 0) {
        // Extract ADR number from filename
        const adrNum = proposedADRs[0].file.match(/^(\d+)-/)[1];
        const message = `Test: ADR-${adrNum}`;
        const result = await validateADRReferences(message, ['tests/unit/example.test.mjs']);
        // Non-shipping files should allow Proposed ADRs
        expect(result.passed).toBe(true);
      }
    });
  });

  describe('non-architecture commits', () => {
    it('allows commits with test-only changes (no ADR required)', async () => {
      const message = 'Fix test edge case';
      const files = ['tests/unit/some-feature.test.mjs', 'tests/integration/api.test.mjs'];
      const result = await validateADRReferences(message, files);
      expect(result.passed).toBe(true);
      expect(result.reason).toBe('non-architecture-commit');
    });

    it('allows commits with doc-only changes (no ADR required)', async () => {
      const message = 'Update README with examples';
      const files = ['docs/USAGE.md', 'README.md'];
      const result = await validateADRReferences(message, files);
      expect(result.passed).toBe(true);
      expect(result.reason).toBe('non-architecture-commit');
    });

    it('allows commits with config-only changes (no ADR required)', async () => {
      const message = 'Update package.json dependencies';
      const files = ['package.json', '.github/workflows/test.yml'];
      const result = await validateADRReferences(message, files);
      expect(result.passed).toBe(true);
      expect(result.reason).toBe('non-architecture-commit');
    });

    it('requires ADR for mixed architecture + test changes', async () => {
      const message = 'Feature implementation';
      const files = ['scripts/new-feature.mjs', 'tests/unit/new-feature.test.mjs'];
      const result = await validateADRReferences(message, files);
      expect(result.passed).toBe(false);
      expect(result.error).toContain('require ADR reference');
    });
  });

  describe('commit message patterns', () => {
    it('accepts ADR anywhere in message', async () => {
      const patterns = [
        'ADR-0081: Implementation plan',
        'Per ADR-0012 the grounding gate should...',
        'Related: ADR-0008, ADR-0009',
        'Feature (ADR-0081) implementation',
      ];

      for (const message of patterns) {
        const result = await validateADRReferences(message, ['scripts/test.mjs']);
        expect(result.passed).toBe(true);
      }
    });

    it('handles case-insensitive matching', async () => {
      const message = 'Per adr-0081 implementation'; // lowercase adr
      const result = await validateADRReferences(message, ['scripts/test.mjs']);
      expect(result.passed).toBe(true);
      expect(result.adrs.some((a) => a.adrNumber === 81)).toBe(true);
    });

    it('extracts ADRs with no other context', async () => {
      const message = 'ADR-0081';
      const result = await validateADRReferences(message, ['scripts/test.mjs']);
      expect(result.passed).toBe(true);
      expect(result.adrs.length).toBe(1);
    });

    it('deduplicates repeated ADR references', async () => {
      const message = 'Feature per ADR-0081, also ADR-0081 again';
      const result = await validateADRReferences(message, ['scripts/test.mjs']);
      expect(result.passed).toBe(true);
      expect(result.adrs.filter((a) => a.adrNumber === 81).length).toBe(1);
    });
  });

  describe('ADR metadata', () => {
    it('extracts status from existing ADR', async () => {
      const message = 'Fix: ADR-0012';
      const result = await validateADRReferences(message, ['scripts/test.mjs']);
      expect(result.passed).toBe(true);
      const adr = result.adrs.find((a) => a.adrNumber === 12);
      expect(adr.status).toBeDefined();
      expect(['Accepted', 'Proposed', 'Superseded', 'Deprecated']).toContain(adr.status);
    });

    it('includes filename in result', async () => {
      const message = 'Fix: ADR-0081';
      const result = await validateADRReferences(message, ['scripts/test.mjs']);
      expect(result.passed).toBe(true);
      const adr = result.adrs.find((a) => a.adrNumber === 81);
      expect(adr.file).toBeDefined();
      expect(adr.file).toMatch(/^0081-/);
    });
  });

  describe('error handling', () => {
    it('provides helpful error message for missing ADR', async () => {
      const message = 'Feature: ADR-9999';
      const result = await validateADRReferences(message, ['scripts/test.mjs']);
      expect(result.passed).toBe(false);
      expect(result.errors[0].error).toContain('not found');
    });

    it('provides helpful hint for architecture commit without ADR', async () => {
      const message = 'Fix architecture issue';
      const result = await validateADRReferences(message, ['scripts/architecture.mjs']);
      expect(result.passed).toBe(false);
      expect(result.hint).toBeDefined();
      expect(result.example).toBeDefined();
    });
  });

  describe('bypass mechanism', () => {
    beforeAll(() => {
      // Set bypass env variable
      process.env.RUVNET_SKIP_ADR_CHECK = '1';
    });

    afterAll(() => {
      // Clean up
      delete process.env.RUVNET_SKIP_ADR_CHECK;
    });

    it('allows bypass with RUVNET_SKIP_ADR_CHECK=1', async () => {
      const message = 'Emergency fix without ADR';
      const result = await validateADRReferences(message, ['scripts/critical.mjs']);
      expect(result.passed).toBe(true);
      expect(result.bypassed).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('accepts normal feature commit with ADR', async () => {
      const message = `Implement ADR-0081 pre-commit validation

This commit adds:
- scripts/adr-validate.mjs validation script
- Pre-commit hook integration
- Comprehensive test suite
- Documentation in ADR-0081

Fixes #42`;
      const files = [
        'scripts/adr-validate.mjs',
        '.git/hooks/pre-commit',
        'tests/unit/adr-validate.test.mjs',
      ];
      const result = await validateADRReferences(message, files);
      expect(result.passed).toBe(true);
      expect(result.adrs.length).toBe(1);
    });

    it('rejects commit with code changes but no ADR', async () => {
      const message = 'Fix edge case in router';
      const files = ['scripts/router.mjs', 'tests/unit/router.test.mjs'];
      const result = await validateADRReferences(message, files);
      expect(result.passed).toBe(false);
    });

    it('accepts commit with multiple ADRs for complex feature', async () => {
      const message = `Comprehensive feature combining principles

Implements ADR-0081 (ADR validation), ADR-0012 (grounding gate),
and ADR-0008 (autonomous loop) to create integrated system.`;
      const files = ['scripts/integrated-system.mjs'];
      const result = await validateADRReferences(message, files);
      expect(result.passed).toBe(true);
      expect(result.adrs.length).toBeGreaterThan(1);
    });
  });
});
