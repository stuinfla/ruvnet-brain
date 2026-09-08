import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// GNU tar on Git-for-Windows treats an absolute `C:\\...` archive argument as a
// remote archive (`C:` is parsed as the host). Keep tar's archive and extraction
// directory relative to a controlled cwd on every host. This also keeps tests
// independent of the shell's path conversion rules.
export function extractTarball(archive, destination, run = execFileSync) {
  const root = path.resolve(destination);
  const source = path.resolve(archive);
  fs.mkdirSync(root, { recursive: true });
  const stagedName = `.ruvnet-tar-${process.pid}-${Date.now()}-${path.basename(source)}`;
  const staged = path.join(root, stagedName);
  fs.copyFileSync(source, staged);
  try {
    run('tar', ['-xzf', stagedName, '-C', '.'], { cwd: root });
  } finally {
    fs.rmSync(staged, { force: true });
  }
}
