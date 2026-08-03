import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('protected release channel contract', () => {
  it('builds and signs before the staged transaction promotes GitHub, npm, then verifies', () => {
    const release = read('scripts/release.mjs');
    const transaction = read('scripts/release-transaction.mjs');
    const build = release.indexOf("runOrDie('build release bundle'");
    const sign = release.indexOf("runOrDie('sign release bundle'");
    const transactionStart = release.indexOf('const finalReceipt = await runReleaseTransaction');
    const github = transaction.indexOf('adapter.publishDraftNonLatest');
    const npm = transaction.indexOf('adapter.promoteNpm');
    const verify = transaction.indexOf('adapter.finalize');

    expect(build).toBeGreaterThanOrEqual(0);
    expect(sign).toBeGreaterThan(build);
    expect(transactionStart).toBeGreaterThan(sign);
    expect(github).toBeGreaterThanOrEqual(0);
    expect(npm).toBeGreaterThan(github);
    expect(verify).toBeGreaterThan(npm);
  });

  it('fails closed on tag/SHA mismatch and requires all signed assets', () => {
    const release = read('scripts/release.mjs');
    const transaction = read('scripts/release-transaction.mjs');
    const provider = read('scripts/release-transaction-provider.mjs');
    expect(transaction).toContain("exact(github.sha, identity.candidateSha, 'GitHub candidate SHA')");
    expect(provider).toContain('refusing to replace staged asset with different bytes');
    expect(release).toContain('`${zip}.sig`');
    expect(release).toContain('`${zip}.sha256`');
    expect(provider).not.toContain("'--clobber'");
  });
});

describe('package-lock participates in version synchronization', () => {
  it('detects and repairs both lockfile version fields in an isolated fixture', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-version-sync-'));
    try {
      for (const rel of [
        'scripts/sync-version.mjs',
        'scripts/version.mjs',
        'plugin/.claude-plugin/plugin.json',
      ]) {
        const dst = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(ROOT, rel), dst);
      }
      const syncPath = path.join(tmp, 'scripts/sync-version.mjs');
      const helperName = `verify${'R'}${'vf'}Generations`;
      const sync = fs.readFileSync(syncPath, 'utf8')
        .replace(new RegExp(helperName, 'g'), 'verifyGenerations')
        .replace(/^import \{ verifyGenerations \} from[^\n]+\n/m,
          'const verifyGenerations = () => ({ failures: [] });\n');
      fs.writeFileSync(syncPath, sync);
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'fixture', version: '9.8.7', type: 'module',
      }, null, 2));
      fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: { '': { name: 'fixture', version: '2.0.0' } },
      }, null, 2));
      fs.writeFileSync(path.join(tmp, 'README.md'),
        '![RuvNet Brain version 9.8.7 — updated now](https://img.shields.io/badge/version_9.8.7-updated_now-blue)\n');
      fs.writeFileSync(path.join(tmp, 'plugin/.claude-plugin/plugin.json'),
        JSON.stringify({ version: '9.8.7' }, null, 2));

      const check = spawnSync(process.execPath, ['scripts/sync-version.mjs', '--check'], {
        cwd: tmp, encoding: 'utf8',
      });
      expect(check.status).toBe(1);
      expect(check.stderr).toContain('package-lock.json = mixed(1.0.0, 2.0.0)');

      const repair = spawnSync(process.execPath, ['scripts/sync-version.mjs'], {
        cwd: tmp, encoding: 'utf8',
      });
      expect(repair.status).toBe(0);
      const lock = JSON.parse(fs.readFileSync(path.join(tmp, 'package-lock.json'), 'utf8'));
      expect(lock.version).toBe('9.8.7');
      expect(lock.packages[''].version).toBe('9.8.7');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
