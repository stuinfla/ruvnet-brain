import fs from 'node:fs';
import { expect, it } from 'vitest';
it('runs reviewed release qualification from the same exact source on all platforms', () => {
  const source = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  // workflow_call.outputs uses the same names at deeper indentation. Inspect the
  // actual jobs map so an output label can never masquerade as a checkout job.
  const jobs = source.split(/^jobs:\s*$/m)[1];
  expect(jobs, 'the release workflow has no jobs map').toBeTruthy();
  for (const platform of ['linux', 'macos', 'windows']) {
    const job = jobs.split(new RegExp(`^  release-acceptance-${platform}:\\s*$`, 'm'))[1]
      ?.split(/^  [a-z][a-z-]*:\s*$/m)[0];
    expect(job, `release acceptance ${platform} job is missing`).toBeTruthy();
    expect(job).toContain('ref: ${{ inputs.candidate_sha || github.sha }}');
    expect(job).toContain(`release-qualification.mjs --platform ${platform}`);
    expect(job).not.toContain('tests/unit');
  }
});
