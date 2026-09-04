import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/model-catalog-refresh.yml'), 'utf8');

describe('issue #238 — model catalog refresh has an owner through protected main', () => {
  it('runs weekly with enough recovery time before the 14-day freshness wall', () => {
    expect(workflow).toContain("cron: '13 9 * * 1'");
    expect(workflow).toContain('workflow_dispatch: {}');
  });

  it('refreshes and verifies facts before creating a maintenance commit', () => {
    expect(workflow.indexOf('npm run catalog:refresh')).toBeLessThan(workflow.indexOf('npm run catalog:verify'));
    expect(workflow.indexOf('npm run catalog:verify')).toBeLessThan(workflow.indexOf('git commit -m'));
  });

  it('uses one PR and the required checks instead of bypassing branch protection', () => {
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('gh workflow run integration-linux.yml');
    expect(workflow).toContain('gh workflow run canonical-qa.yml');
    expect(workflow).toContain('gh workflow run ci.yml');
    expect(workflow).toContain("--json autoMergeRequest");
    expect(workflow).toContain('gh pr merge "$pr_number" --auto --squash');
    expect(workflow).not.toMatch(/push origin (main|HEAD:main)/);
  });
});
