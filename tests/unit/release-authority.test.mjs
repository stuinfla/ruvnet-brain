import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectPublisherActions,
  findUnauthorizedPublishers,
} from '../../scripts/release-authority.mjs';
import { REQUIRED_CHECKS } from '../../scripts/release-proof.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('issue #77 — one protected publisher', () => {
  it('detects JavaScript GitHub and npm publication actions outside the canonical publisher', () => {
    const source = `
      execFileSync(GH, ['release', 'create', tag]);
      execFileSync('npm', ['publish', '--tag', 'latest']);
      execFileSync('npm', ['dist-tag', 'add', spec, 'latest']);
    `;
    expect(detectPublisherActions('scripts/self-update.mjs', source).map((item) => item.action))
      .toEqual(['github-release-create', 'npm-publish', 'npm-dist-tag']);
  });

  it('detects shell publication actions but ignores comments describing them', () => {
    const source = `
      # gh release create is forbidden here
      npm publish --tag candidate
      npm dist-tag add ruvnet-brain@1 candidate
    `;
    expect(detectPublisherActions('scripts/rogue.sh', source).map((item) => item.action))
      .toEqual(['npm-publish', 'npm-dist-tag']);
  });

  it('allows the same operations only in scripts/release.mjs', () => {
    const source = `runOrDie('npm publish', 'npm', ['publish', '--tag', 'candidate']);`;
    expect(detectPublisherActions('scripts/release.mjs', source)).toEqual([]);
  });

  it('the checked-in production tree has no second publisher', () => {
    expect(findUnauthorizedPublishers(ROOT)).toEqual([]);
  });

  it('the release seal names a real serialized exact-artifact CI job', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(REQUIRED_CHECKS).toContain('release-qe');
    expect(workflow).toMatch(/^  release-qe:\s*$/m);
    expect(workflow).toContain('node scripts/release-authority.mjs');
    expect(workflow).toContain('tests/qe/release/vitest.config.mjs');
    expect(workflow).toContain('--maxWorkers=1');
  });

  it('MUTANT: reintroducing one npm publisher into self-update is rejected', () => {
    const mutant = `execFileSync('npm', ['publish', '--tag', 'latest']);`;
    expect(detectPublisherActions('scripts/self-update.mjs', mutant)).toMatchObject([
      { file: 'scripts/self-update.mjs', action: 'npm-publish' },
    ]);
  });
});
