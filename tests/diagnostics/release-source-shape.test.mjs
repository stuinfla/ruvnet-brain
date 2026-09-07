// Source-shape diagnostics only; behavioral release authority is tested in unit suites.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
describe('release source-shape diagnostics', () => {
  it('is load-bearing before any remote mutation in the canonical publisher', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/release.mjs'), 'utf8');
    const guard = source.indexOf('validateProtectedPublishInvocation({ root: ROOT })');
    const publish = source.indexOf('const finalReceipt = await runReleaseTransaction');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(publish);
    expect(source).not.toContain("runOrDie('git push'");
    expect(source).toContain('PROTECTED RELEASE GATE FAILED');
  });
  it('the customer-facing banner emits exactly ONE version', () => {
    const core = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'session-start-core.mjs'), 'utf8');
    // Issue #77: the banner printed the plugin version AND the bundle tag, making every user
    // adjudicate whether their own install was out of sync.
    expect(core).not.toMatch(/RuvNet Brain active \(v\$\{bannerVersion\}\$\{kbVersion/);
    expect(core, 'divergence belongs on the maintainer channel, not in the user banner')
      .toMatch(/MAINTAINER ONLY: the shipped generation is split/);
  });
});
