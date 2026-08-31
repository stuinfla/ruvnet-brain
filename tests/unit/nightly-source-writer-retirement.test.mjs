import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('retired primary-checkout source writer', () => {
  it('does not ship or require the com.ruvnet.brain-nightly LaunchAgent', () => {
    expect(fs.existsSync(path.join(ROOT, 'deploy', 'com.ruvnet.brain-nightly.plist'))).toBe(false);
    const registry = JSON.parse(read('config/scheduled-jobs.json'));
    expect(registry.jobs.some((job) => job.label === 'com.ruvnet.brain-nightly')).toBe(false);
    expect(registry._retired).toContainEqual(expect.objectContaining({
      label: 'com.ruvnet.brain-nightly',
      retired: '2026-08-22',
    }));
  });

  it('keeps the installed-cache updater as the one supported LaunchAgent', () => {
    const installer = read('bin/install.mjs');
    expect(installer).toContain("const NIGHTLY_LABEL = 'com.ruvnet.brain-update'");
    expect(installer).toContain("path.join(os.homedir(), '.npm-global', 'bin')");
    expect(installer).toContain("path.join(os.homedir(), '.local', 'bin')");
  });

  it('guards the wrapper before every executable source mutation', () => {
    const source = read('scripts/nightly-wrapper.sh');
    const executable = source.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    const guard = executable.indexOf('scripts/worktree-integrity.mjs "$WORKTREE_ROOT"');
    const firstApply = executable.indexOf('--apply');
    expect(guard).toBeGreaterThan(-1);
    expect(firstApply).toBeGreaterThan(guard);
    expect(executable).not.toContain('scripts/ingest-new-repos.mjs --apply');
    expect(executable).not.toContain('scripts/self-update.mjs --apply --publish');
  });

  it('does not advertise the retired scheduler in current operator docs', () => {
    for (const file of ['README.md', 'CONTRIBUTING.md', 'docs/ARCHITECTURE-MAP.md', 'docs/NIGHTLY-REFRESH.md']) {
      const source = read(file);
      expect(source, file).not.toContain('deploy/com.ruvnet.brain-nightly.plist');
      expect(source, file).not.toMatch(/launchd `com\.ruvnet\.brain-nightly`/);
    }
  });
});
