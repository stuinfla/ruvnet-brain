import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as RV from '../../scripts/release-vector.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('release candidate lineage', () => {
  const passResults = [{ state: 'PASS' }];

  it('a dirty candidate can never receive a PASS release verdict', () => {
    expect(RV.verdictWithLineage(passResults, { dirty: true })).toBe('FAIL');
  });

  it('a clean candidate preserves the minimum-vector verdict', () => {
    expect(RV.verdictWithLineage(passResults, { dirty: false })).toBe('PASS');
    expect(RV.verdictWithLineage([{ state: 'UNKNOWN' }], { dirty: false })).toBe('UNKNOWN');
  });

  it('records commit, tree digest, and dirty state as candidate identity', () => {
    const lineage = RV.candidateLineage();
    expect(lineage.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(lineage.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof lineage.dirty).toBe('boolean');
  });
});

describe('release command wording', () => {
  it('calls publication PUBLISHED NOT VERIFIED and never promotes check-only wording', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
    expect(src).toContain('PREFLIGHT PASS — NOT PUBLISHED');
    expect(src).toContain("c.y(c.b('PUBLISHED, NOT VERIFIED'))");
    expect(src).not.toContain("c.g(c.b('✓✓✓ SHIPPED'))");
  });

  it('publishes only through the canonical release path with an explicit npm tag', () => {
    const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
    const provider = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction-provider.mjs'), 'utf8');
    const nightly = fs.readFileSync(path.join(ROOT, 'scripts/self-update.mjs'), 'utf8');
    expect(release).toContain('await runReleaseTransaction');
    expect(provider).toContain("command('npm', ['publish', packagePath, '--tag', `candidate-v${identity.version}`])");
    expect(provider).toContain("command('npm', ['dist-tag', 'add', `${PACKAGE}@${identity.version}`, 'latest'])");
    expect(nightly).not.toMatch(/execFileSync\(['"]npm['"],\s*\[['"]publish['"]/);
    expect(nightly).toContain('self-update is rebuild-only');
  });
});
