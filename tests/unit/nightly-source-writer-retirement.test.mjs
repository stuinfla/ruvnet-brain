import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NIGHTLY_LABEL, launchdPlist, nightlyArtifact } from '../../plugin/scripts/nightly-scheduler.mjs';

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
    const home = path.resolve('fixture-scheduler-home');
    const kbDir = path.join(home, '.cache', 'ruvnet-brain', 'kb');
    const record = { identity: NIGHTLY_LABEL, nodePath: process.execPath,
      runnerPath: path.join(home, '.cache', 'ruvnet-brain', 'scheduler', `nightly-refresh-${'a'.repeat(64)}.mjs`),
      recordPath: path.join(home, '.cache', 'ruvnet-brain', 'scheduler', 'registration.json') };
    expect(NIGHTLY_LABEL).toBe('com.ruvnet.brain-update');
    expect(nightlyArtifact({ platform: 'darwin', env: { HOME: home }, kbDir })).toMatchObject({
      kind: 'launchd', label: NIGHTLY_LABEL, path: path.join(home, 'Library', 'LaunchAgents', `${NIGHTLY_LABEL}.plist`),
    });
    const plist = launchdPlist(record, { env: { HOME: home }, kbDir, logPath: path.join(kbDir, 'update.log') });
    const argv = [...plist.match(/<key>ProgramArguments<\/key><array>([\s\S]*?)<\/array>/)[1]
      .matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]);
    expect(argv).toEqual([record.nodePath, record.runnerPath]);
    expect(plist).toContain(path.join(home, '.npm-global', 'bin'));
    expect(plist).toContain(path.join(home, '.local', 'bin'));
    expect(argv.some((arg) => /nightly-wrapper|self-update|npx/.test(arg))).toBe(false);
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
