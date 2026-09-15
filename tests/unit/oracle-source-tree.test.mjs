// tests/unit/oracle-source-tree.test.mjs
//
// ADR-086 C3, EXTEND_FIRST Dual verdict (2026-09-14): "Enumerate the pinned Git tree and read its bound
// objects. A commit label on a filesystem walk is insufficient." These cases prove the manifest describes
// the COMMIT — never the checkout — and that no tracked entry can disappear silently: symlinks, submodule
// gitlinks, LFS pointers and binaries each get an explicit primary kind rather than being skipped.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyEntry, listTree, readBlobs, snapshotManifest, LFS_POINTER_PREFIX } from '../../scripts/oracle/source-tree.mjs';

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/oracle/source-tree.mjs');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('the snapshot manifest is read from the pinned git tree, not the filesystem', () => {
  let repo;
  let firstCommit;
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'source-tree-'));
    g('init', '-q');
    g('config', 'user.email', 'fixture@example.invalid');
    g('config', 'user.name', 'fixture');
    g('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.mkdirSync(path.join(repo, 'bin'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# Title\n\nThe client retries three times.\n');
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export function a() { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
    fs.chmodSync(path.join(repo, 'bin', 'run.sh'), 0o755);
    fs.symlinkSync('README.md', path.join(repo, 'link.md'));
    fs.writeFileSync(path.join(repo, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x00, 0x01]));
    fs.writeFileSync(path.join(repo, 'model.bin'), `${LFS_POINTER_PREFIX}\noid sha256:${'a'.repeat(64)}\nsize 42\n`);
    g('add', '-A');
    // A submodule pointer, recorded as a gitlink (mode 160000) without cloning anything.
    g('update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},vendor/sub`);
    g('commit', '-q', '-m', 'fixture');
    firstCommit = g('rev-parse', 'HEAD');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('gives every tracked entry exactly one explicit primary kind — nothing is skipped', () => {
    const { manifest } = snapshotManifest({ repoDir: repo, commit: firstCommit, repo: 'fixture' });
    const kinds = Object.fromEntries(manifest.entries.map((e) => [e.path, e.entryKind]));
    expect(kinds).toEqual({
      'README.md': 'file',
      'bin/run.sh': 'executable',
      'img.png': 'binary',
      'link.md': 'symlink',
      'model.bin': 'lfs-pointer',
      'src/a.js': 'file',
      'vendor/sub': 'gitlink',
    });
    expect(manifest.commitSha).toBe(firstCommit);
    expect(manifest.treeSha).toBe(g('rev-parse', `${firstCommit}^{tree}`));
  });

  it('binds regular blobs to the COMMITTED bytes, and never imports symlink targets or submodule content', () => {
    const { manifest } = snapshotManifest({ repoDir: repo, commit: firstCommit, repo: 'fixture' });
    const byPath = Object.fromEntries(manifest.entries.map((e) => [e.path, e]));
    expect(byPath['README.md'].contentSha256).toBe(sha256(Buffer.from('# Title\n\nThe client retries three times.\n')));
    expect(byPath['link.md'].contentSha256).toBeNull();
    expect(byPath['vendor/sub'].contentSha256).toBeNull();
    expect(byPath['vendor/sub'].objectSha).toBe('b'.repeat(40));
  });

  it('MUST IGNORE the checkout: a dirty tracked file and an untracked file change nothing', () => {
    const before = snapshotManifest({ repoDir: repo, commit: firstCommit, repo: 'fixture' }).manifest;
    fs.writeFileSync(path.join(repo, 'README.md'), 'DIRTY WORKTREE CONTENT\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'not in any commit\n');
    try {
      const after = snapshotManifest({ repoDir: repo, commit: firstCommit, repo: 'fixture' }).manifest;
      expect(after).toEqual(before);
      expect(after.entries.some((e) => e.path === 'untracked.txt')).toBe(false);
    } finally {
      g('checkout', '--', 'README.md');
      fs.rmSync(path.join(repo, 'untracked.txt'));
    }
  });

  it('a later commit does not rewrite an earlier commit\'s manifest', () => {
    const pinned = snapshotManifest({ repoDir: repo, commit: firstCommit, repo: 'fixture' }).manifest;
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export function a() { return 2; }\n');
    g('commit', '-q', '-am', 'change a.js');
    const later = snapshotManifest({ repoDir: repo, commit: 'HEAD', repo: 'fixture' }).manifest;
    const again = snapshotManifest({ repoDir: repo, commit: firstCommit, repo: 'fixture' }).manifest;
    expect(later.manifestSha256).not.toBe(pinned.manifestSha256);
    expect(again).toEqual(pinned);
  });

  it('is byte-identical across a process boundary', () => {
    const run = () => spawnSync(process.execPath, [MODULE, '--repo-dir', repo, '--commit', firstCommit, '--repo', 'fixture'], { encoding: 'utf8' });
    const a = run();
    const b = run();
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(JSON.parse(a.stdout).manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reads blob bytes exactly, including embedded NUL and newline bytes', () => {
    const png = listTree({ repoDir: repo, commit: firstCommit }).find((e) => e.path === 'img.png');
    const bytes = readBlobs({ repoDir: repo, shas: [png.objectSha] }).get(png.objectSha);
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x00, 0x01]);
  });

  it('refuses to classify a regular blob it was not given the bytes for', () => {
    expect(() => classifyEntry({ path: 'x', mode: '100644', type: 'blob' }, null)).toThrow(/needs the blob bytes/);
  });
});
