import fs from 'node:fs';
import { expect, it } from 'vitest';
const workflow = fs.readFileSync(new URL('../../.github/workflows/model-catalog-refresh.yml', import.meta.url), 'utf8');
it('refreshes and verifies the catalog on main and reports it without any write authority', () => {
  expect(workflow).toContain('catalog:verify');
  expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
  // Report-only (decision D4): the Actions token may not create PRs here, and enabling that is a security setting.
  expect(workflow).not.toMatch(/gh pr (create|merge)|git push|gh workflow run|uses: \.\/\.github\/workflows\//);
  expect(workflow).toMatch(/^permissions:\n  contents: read\n\n/m);
  expect(workflow).not.toMatch(/: write\b/);
  expect(workflow).toContain('name: model-catalog-refresh\n          path: ${{ runner.temp }}/catalog-refresh/');
  expect(workflow).toContain('>> "$GITHUB_STEP_SUMMARY"');
  expect(workflow).toContain('--refresh --router-dir "$RUNNER_TEMP/model-currency" | tee "$RUNNER_TEMP/model-currency.out"');
  expect(workflow).toMatch(/set -o pipefail\n {10}node scripts\/model-currency.mjs --refresh/);
  expect(workflow).toContain('node scripts/model-currency.mjs --summarize "$RUNNER_TEMP/model-currency.out" >> "$GITHUB_STEP_SUMMARY"');
  expect(workflow).not.toMatch(/^  (integration|canonical-qa):/m);
  expect(workflow).not.toContain('HEAD:main');
});
