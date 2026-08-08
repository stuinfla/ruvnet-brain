import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/fix-workstream.mjs');
const temporaryRoots = [];

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function gitRaw(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args]);
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-workstream-test-'));
  temporaryRoots.push(root);
  const repo = path.join(root, 'repo');
  const integration = path.join(root, 'integration');
  const writer = path.join(root, 'writer');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'qe@example.test');
  git(repo, 'config', 'user.name', 'QE');
  write(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'integration/clean', base);
  git(repo, 'worktree', 'add', integration, 'integration/clean');
  return { root, repo, integration, writer, base };
}

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function startArgs(f, overrides = {}) {
  const values = {
    integration: f.integration,
    base: f.base,
    branch: 'fix/issue-123-bounded',
    worktree: f.writer,
    scope: 'issue-123',
    ...overrides,
  };
  return [
    'start',
    '--integration', values.integration,
    '--base', values.base,
    '--branch', values.branch,
    '--worktree', values.worktree,
    '--scope', values.scope,
  ];
}

function commitFix(f) {
  write(path.join(f.writer, 'fix.txt'), 'verified fix\n');
  git(f.writer, 'add', 'fix.txt');
  git(f.writer, 'commit', '-m', 'fix: bounded change');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('fix workstream start', () => {
  it('creates one scoped non-main worktree from the explicit clean integration head', () => {
    const f = fixture();
    const result = run(startArgs(f));

    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(git(f.writer, 'branch', '--show-current')).toBe('fix/issue-123-bounded');
    expect(git(f.writer, 'rev-parse', 'HEAD')).toBe(f.base);
    expect(git(f.writer, 'rev-parse', '--git-common-dir')).toBe(git(f.integration, 'rev-parse', '--git-common-dir'));
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      phase: 'workstream-start',
      scope: 'issue-123',
      branch: 'fix/issue-123-bounded',
      baseSha: f.base,
      publishAuthorized: false,
      promotionAuthorized: false,
    });
    expect(receipt.releaseGate.command).toBe('node scripts/release-proof.mjs --candidate <candidate-receipt.json>');
    expect(receipt.receiptId).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('fails closed before creating anything when the integration owner is dirty', () => {
    const f = fixture();
    write(path.join(f.integration, 'dirty.txt'), 'uncommitted\n');
    const result = run(startArgs(f));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/integration worktree is dirty/i);
    expect(fs.existsSync(f.writer)).toBe(false);
    expect(git(f.repo, 'branch', '--list', 'fix/issue-123-bounded')).toBe('');
  });

  it('rejects a stale or invented base instead of silently branching from another commit', () => {
    const f = fixture();
    write(path.join(f.integration, 'next.txt'), 'next\n');
    git(f.integration, 'add', 'next.txt');
    git(f.integration, 'commit', '-m', 'integration moved');
    const result = run(startArgs(f));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/base.*current integration HEAD|lineage/i);
    expect(fs.existsSync(f.writer)).toBe(false);
  });

  it('rejects shared-writer branches and never force-removes the existing worktree', () => {
    const f = fixture();
    const existing = path.join(f.root, 'existing-writer');
    git(f.repo, 'worktree', 'add', '-b', 'fix/shared-writer', existing, f.base);
    write(path.join(existing, 'precious.txt'), 'do not remove\n');
    const result = run(startArgs(f, { branch: 'fix/shared-writer' }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/already checked out|shared writer/i);
    expect(fs.readFileSync(path.join(existing, 'precious.txt'), 'utf8')).toBe('do not remove\n');
    expect(fs.existsSync(f.writer)).toBe(false);
  });

  it.each(['main', 'master', 'integration/clean'])('rejects protected or integration branch %s', (branch) => {
    const f = fixture();
    const result = run(startArgs(f, { branch }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/scoped non-main branch/i);
  });

  it.each(['publish', 'promote', 'merge', 'cleanup'])('has no %s bypass command', (command) => {
    const f = fixture();
    const before = git(f.integration, 'rev-parse', 'HEAD');
    const result = run([command, '--integration', f.integration]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/supported commands are start and handoff/i);
    expect(git(f.integration, 'rev-parse', 'HEAD')).toBe(before);
  });
});

describe('fix workstream handoff', () => {
  it('emits content-bound evidence for a clean committed descendant without promoting it', () => {
    const f = fixture();
    expect(run(startArgs(f)).status).toBe(0);
    commitFix(f);
    const evidence = path.join(f.root, 'focused-tests.txt');
    const out = path.join(f.root, 'handoff.json');
    write(evidence, '12 passed, 0 failed\n');

    const result = run([
      'handoff', '--integration', f.integration, '--base', f.base,
      '--worktree', f.writer, '--scope', 'issue-123',
      '--evidence', evidence, '--out', out,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(fs.readFileSync(out, 'utf8'));
    const patch = gitRaw(f.writer, 'diff', '--binary', `${f.base}..HEAD`);
    expect(JSON.parse(result.stdout)).toEqual(receipt);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      phase: 'fix-handoff',
      scope: 'issue-123',
      baseSha: f.base,
      writerSha: git(f.writer, 'rev-parse', 'HEAD'),
      writerTree: git(f.writer, 'rev-parse', 'HEAD^{tree}'),
      patchSha256: createHash('sha256').update(patch).digest('hex'),
      publishAuthorized: false,
      promotionAuthorized: false,
      nextAuthority: 'integration-owner',
    });
    expect(receipt.changedPaths).toEqual([{ status: 'A', path: 'fix.txt' }]);
    expect(receipt.evidence).toEqual([{
      path: evidence,
      sha256: createHash('sha256').update('12 passed, 0 failed\n').digest('hex'),
      bytes: 20,
    }]);
    expect(receipt.releaseGate.command).toContain('scripts/release-proof.mjs');
    expect(receipt.receiptId).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects a dirty writing lane instead of laundering uncommitted bytes into evidence', () => {
    const f = fixture();
    expect(run(startArgs(f)).status).toBe(0);
    commitFix(f);
    write(path.join(f.writer, 'uncommitted.txt'), 'dirty\n');
    const evidence = path.join(f.root, 'tests.txt');
    write(evidence, 'pass\n');
    const result = run([
      'handoff', '--integration', f.integration, '--base', f.base,
      '--worktree', f.writer, '--scope', 'issue-123', '--evidence', evidence,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/writer worktree is dirty/i);
  });

  it('rejects an unrelated writer lineage even when both worktrees are clean', () => {
    const f = fixture();
    expect(run(startArgs(f)).status).toBe(0);
    git(f.writer, 'checkout', '--orphan', 'fix/unrelated');
    git(f.writer, 'rm', '-rf', '.');
    write(path.join(f.writer, 'unrelated.txt'), 'unrelated\n');
    git(f.writer, 'add', 'unrelated.txt');
    git(f.writer, 'commit', '-m', 'unrelated root');
    const evidence = path.join(f.root, 'tests.txt');
    write(evidence, 'pass\n');
    const result = run([
      'handoff', '--integration', f.integration, '--base', f.base,
      '--worktree', f.writer, '--scope', 'issue-123', '--evidence', evidence,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/writer lineage does not descend/i);
  });

  it('fails closed if the integration owner becomes dirty before handoff', () => {
    const f = fixture();
    expect(run(startArgs(f)).status).toBe(0);
    commitFix(f);
    write(path.join(f.integration, 'dirty.txt'), 'dirty\n');
    const evidence = path.join(f.root, 'tests.txt');
    write(evidence, 'pass\n');
    const result = run([
      'handoff', '--integration', f.integration, '--base', f.base,
      '--worktree', f.writer, '--scope', 'issue-123', '--evidence', evidence,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/integration worktree is dirty/i);
  });

  it('requires real evidence files', () => {
    const f = fixture();
    expect(run(startArgs(f)).status).toBe(0);
    commitFix(f);
    const result = run([
      'handoff', '--integration', f.integration, '--base', f.base,
      '--worktree', f.writer, '--scope', 'issue-123',
      '--evidence', path.join(f.root, 'missing.txt'),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/evidence file does not exist/i);
  });

  it('refuses to overwrite an existing receipt', () => {
    const f = fixture();
    expect(run(startArgs(f)).status).toBe(0);
    commitFix(f);
    const evidence = path.join(f.root, 'tests.txt');
    const out = path.join(f.root, 'handoff.json');
    write(evidence, 'pass\n');
    write(out, 'precious\n');
    const result = run([
      'handoff', '--integration', f.integration, '--base', f.base,
      '--worktree', f.writer, '--scope', 'issue-123',
      '--evidence', evidence, '--out', out,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refusing to overwrite/i);
    expect(fs.readFileSync(out, 'utf8')).toBe('precious\n');
  });

  it('refuses to write the receipt inside either governed worktree', () => {
    const f = fixture();
    expect(run(startArgs(f)).status).toBe(0);
    commitFix(f);
    const evidence = path.join(f.root, 'tests.txt');
    const out = path.join(f.writer, 'handoff.json');
    write(evidence, 'pass\n');
    const result = run([
      'handoff', '--integration', f.integration, '--base', f.base,
      '--worktree', f.writer, '--scope', 'issue-123',
      '--evidence', evidence, '--out', out,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/receipt must be outside/i);
    expect(git(f.writer, 'status', '--porcelain')).toBe('');
  });
});
