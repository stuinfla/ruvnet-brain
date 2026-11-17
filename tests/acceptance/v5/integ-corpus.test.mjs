// The release pack's corpus fetch (packages/builder/fetch-corpus.mjs, used by v5-pack-build.yml): each
// source is fetched at its pinned commit, never at the branch tip, gets its .source.json with the
// commit's own date, and the list file it writes builds a pack. A missing gists file stops the run.
// Local repositories stand in for GitHub (file:// URLs); no network is used.
// Breaks: breaks-integration.mjs (integ-corpus-tip, integ-corpus-gists).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';
import { built, readJson } from './wp5-helpers.mjs';

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-03T12:00:00Z', GIT_AUTHOR_DATE: '2026-11-03T12:00:00Z' } });

function origin(dir, word) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${word}\n\nThe pinned ${word}harbor notes keep ${word}lattice, ${word}quill and ${word}moss tables.\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', 'pinned');
  const pin = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${word}\n\nThe unpinned ${word}tipline notes.\n`);
  git(dir, 'commit', '--quiet', '-am', 'tip');
  return pin;
}

test('the corpus is fetched at its pins and builds', { timeout: 300_000 }, (t) => {
  const ctx = setup(t, 'integ-corpus');
  const tree = ctx.tree();
  const real = readJson(path.join(tree.root, 'recipe', 'CORPUS.json'));
  assert.equal(real.sources.length, 22, 'the release corpus pins 22 repositories');
  const root = ctx.tmp('rb5-origin-');
  const sources = ['kestrel', 'plover'].map((w) => ({ repo: `${w}-kit`, url: pathToFileURL(path.join(root, w)).href, commit: origin(path.join(root, w), w) }));
  const corpus = path.join(root, 'CORPUS.json');
  fs.writeFileSync(corpus, JSON.stringify({ sources }));
  const run = (...extra) => spawnSync(process.execPath, [path.join(tree.root, 'packages', 'builder', 'fetch-corpus.mjs'), '--corpus', corpus, ...extra], { encoding: 'utf8', timeout: 120_000 });
  const into = path.join(ctx.tmp('rb5-into-'), 'src');
  const list = path.join(ctx.tmp('rb5-list-'), 'sources.json');
  const gistsMissing = run('--into', into, '--list', list, '--gists', path.join(root, 'none.jsonl'));
  assert.notEqual(gistsMissing.status, 0, 'a missing gists file stops the fetch');
  assert.match(gistsMissing.stderr, /gists passage file .* does not exist/);
  const into2 = path.join(ctx.tmp('rb5-into-'), 'src');
  const r = run('--into', into2, '--list', list, '--no-gists');
  assert.equal(r.status, 0, r.stderr);
  for (const s of sources) {
    const meta = readJson(path.join(into2, s.repo, '.source.json'));
    assert.deepEqual(meta, { repo: s.repo, commit: s.commit, date: '2026-11-03' }, `${s.repo} has its pinned .source.json`);
    assert.match(fs.readFileSync(path.join(into2, s.repo, 'README.md'), 'utf8'), /^The pinned /m, `${s.repo} is at its pin, not the tip`);
  }
  const pack = built(ctx, tree, { list });
  assert.deepEqual(readJson(path.join(pack, 'PACK.json')).sources.map((s) => s.commit).sort(), sources.map((s) => s.commit).sort(), 'the pack records the pinned commits');
});
