import fs from 'node:fs';
import { expect, it } from 'vitest';
it('runs reviewed release qualification from the same exact source on all platforms', () => {
  const source = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const platform of ['linux', 'macos', 'windows']) {
    const job = source.split(`  release-acceptance-${platform}:`)[1].split(/\n  [a-z][a-z-]*:/)[0];
    expect(job).toContain('ref: ${{ inputs.candidate_sha || github.sha }}');
    expect(job).toContain(`release-qualification.mjs --platform ${platform}`);
    expect(job).not.toContain('tests/unit');
  }
});
