import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectPush } from '../../scripts/development-push-check.mjs';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'development-push-')); roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  const commit = (value) => { fs.writeFileSync(path.join(root, 'sample.txt'), value); git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  return { root, git, commit };
}
const input = (sha, prior = '0'.repeat(40)) => `refs/heads/release/test ${sha} refs/heads/release/test ${prior}\n`;
it('permits a clean development push without consulting release/docs/runtime gates', () => {
  const f = fixture(); const sha = f.commit('ordinary source');
  expect(inspectPush(f.root, input(sha))).toMatchObject({ ok: true, checked: [sha] });
});
it('rejects secrets in an earlier unpublished commit even after later removal', () => {
  const f = fixture(); const prior = f.commit('baseline');
  f.commit('sk-proj-' + 'A'.repeat(40)); const sha = f.commit('removed');
  expect(() => inspectPush(f.root, input(sha, prior))).toThrow('credential-shaped');
});
it('rejects malformed source identity and tolerates ref deletion', () => {
  const f = fixture(); const sha = f.commit('baseline');
  expect(() => inspectPush(f.root, 'unknown')).toThrow('identity');
  expect(inspectPush(f.root, input('0'.repeat(40), sha)).checked).toEqual([]);
});
