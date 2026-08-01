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
  it('never calls a check-only preflight SHIPPED', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
    expect(src).toContain('PREFLIGHT PASS — NOT PUBLISHED');
    expect(src).toMatch(/PUBLISH\s*\\?[\s\S]*SHIPPED[\s\S]*PREFLIGHT PASS — NOT PUBLISHED/);
  });

  it('publishes only through the canonical release path with an explicit npm tag', () => {
    const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
    const nightly = fs.readFileSync(path.join(ROOT, 'scripts/self-update.mjs'), 'utf8');
    expect(release).toContain("runOrDie('npm publish', 'npm', ['publish', '--tag', 'latest'])");
    expect(nightly).not.toMatch(/execFileSync\(['"]npm['"],\s*\[['"]publish['"]/);
    expect(nightly).toContain('self-update is rebuild-only');
  });
});
