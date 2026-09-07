import fs from 'node:fs';
import { expect, it } from 'vitest';
const workflow = fs.readFileSync(new URL('../../.github/workflows/model-catalog-refresh.yml', import.meta.url), 'utf8');
it('collects verified catalog changes into a maintenance PR without an alternate promotion authority', () => {
  expect(workflow).toContain('catalog:verify');
  expect(workflow).toContain('gh pr create');
  expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
  expect(workflow).not.toMatch(/gh pr merge|gh workflow run|uses: \.\/\.github\/workflows\//);
  expect(workflow).not.toMatch(/^  (integration|canonical-qa):/m);
  expect(workflow).not.toContain('HEAD:main');
  expect(workflow).toContain('deliberate qualification');
});
