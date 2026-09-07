import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Snapshot the working source, including pending fixes, rather than testing HEAD
// or making the developer's checkout appear clean to production verification.
export function createReplaySource() {
  const source = path.resolve(import.meta.dirname, '../..');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-replay-source-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    for (const entry of ['scripts', 'plugin', 'package.json']) {
      fs.cpSync(path.join(source, entry), path.join(repo, entry), { recursive: true });
    }
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Current replay source fixture');
    return { repo, sha: git('rev-parse', 'HEAD'), cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}
