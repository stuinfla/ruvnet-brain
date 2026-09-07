#!/usr/bin/env node
// Development pushes inspect unpublished commit patches for credentials. Release qualification
// belongs to the single hosted producer, never a second checkout's Git hook.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    console.log(JSON.stringify(inspectPush(root, fs.readFileSync(0, 'utf8'))));
  } catch (error) { console.error(`development push refused: ${error.message}`); process.exitCode = 1; }
}
