#!/usr/bin/env node
// Development pushes inspect unpublished commit patches for credentials. Release qualification
// belongs to the single hosted producer, never a second checkout's Git hook.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function inspectPush(root, input) {
  const checked = [];
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!/^[a-f0-9]{40}$/.test(localSha || '') || !/^[a-f0-9]{40}$/.test(remoteSha || '')) {
      throw new Error('malformed Git push identity');
    }
    if (/^0+$/.test(localSha)) continue;
    const range = /^0+$/.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`];
    const patch = execFileSync('git', ['log', '--format=', '--no-ext-diff', '-p', ...range],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    const additions = patch.split('\n').filter((row) => row.startsWith('+') && !row.startsWith('+++')).join('\n');
    const matches = additions.match(/(?:sk-(?:proj|ant|or-v1)-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,})/g) || [];
    if (matches.some((value) => !/your-key|abc123|xxxx+|deadbeef|example|placeholder|REDACTED/i.test(value))) {
      throw new Error('credential-shaped value found in unpublished commit history');
    }
    checked.push(localSha);
  }
  return { ok: true, checked, scope: 'unpublished-commit-secret-scan' };
}

// Compares REALPATHS on both sides: path.resolve() normalizes a path but does NOT follow
// symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (this repo's
// own $ROOT, from `git rev-parse --show-toplevel`, is symlinked whenever the checkout is reached
// through a symlinked ancestor directory -- a symlinked home/mount/worktree layout) the two sides
// disagree, so this body never runs -- and because nothing throws, the process exits 0, silently
// skipping the pre-push credential scan. A silent exit 0 is indistinguishable from "scanned, found
// nothing". Pinned by tests/unit/entrypoint-symlink.test.mjs (see this repo's established
// isDirectInvocation() sibling copies, e.g. scripts/doc-currency.mjs).
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    console.log(JSON.stringify(inspectPush(root, fs.readFileSync(0, 'utf8'))));
  } catch (error) { console.error(`development push refused: ${error.message}`); process.exitCode = 1; }
}
