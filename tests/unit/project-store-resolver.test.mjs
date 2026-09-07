import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';

let temporaryRoots = [];

function temporaryRoot(prefix = 'project-store-resolver-') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function linkedWorktreeFixture() {
  const container = temporaryRoot();
  const primary = path.join(container, 'primary');
  const linked = path.join(container, 'linked');
  fs.mkdirSync(primary);
  git(primary, 'init');
  git(primary, 'config', 'user.name', 'Resolver Test');
  git(primary, 'config', 'user.email', 'resolver@example.invalid');
  fs.writeFileSync(path.join(primary, 'tracked.txt'), 'source\n');
  git(primary, 'add', 'tracked.txt');
  git(primary, 'commit', '-m', 'fixture');
  git(primary, 'worktree', 'add', '-b', 'linked-fixture', linked);
  fs.mkdirSync(path.join(primary, 'nested'));
  fs.mkdirSync(path.join(linked, 'nested'));
  return { primary: fs.realpathSync.native(primary), linked: fs.realpathSync.native(linked) };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('canonical project store resolution', () => {
  it('maps a primary checkout and real linked worktree to one canonical project AgentDB', () => {
    const fixture = linkedWorktreeFixture();
    fs.mkdirSync(path.join(fixture.linked, '.swarm'));
    fs.writeFileSync(path.join(fixture.linked, '.swarm', 'memory.db'), 'linked-worktree decoy\n');
    const primary = resolveProjectStore({ projectDir: path.join(fixture.primary, 'nested') });
    const linked = resolveProjectStore({ projectDir: path.join(fixture.linked, 'nested') });

    expect(primary).toMatchObject({
      kind: 'git',
      projectRoot: fixture.primary,
      checkoutRoot: fixture.primary,
      gitCommonDir: path.join(fixture.primary, '.git'),
      canonicalAgentDbPath: path.join(fixture.primary, '.swarm', 'memory.db'),
    });
    expect(linked).toMatchObject({
      kind: 'git',
      projectRoot: fixture.primary,
      checkoutRoot: fixture.linked,
      gitCommonDir: path.join(fixture.primary, '.git'),
      canonicalAgentDbPath: primary.canonicalAgentDbPath,
      projectIdentity: primary.projectIdentity,
    });
    expect(linked.canonicalAgentDbPath).not.toBe(path.join(fixture.linked, '.swarm', 'memory.db'));
    expect(primary.projectIdentity.id).toMatch(/^git-sha256:[a-f0-9]{64}$/);
  });

  it('resolves a non-Git project deterministically through canonical path aliases', () => {
    const container = temporaryRoot();
    const project = path.join(container, 'plain-project');
    const alias = path.join(container, 'plain-project-alias');
    fs.mkdirSync(project);
    fs.symlinkSync(project, alias, 'dir');

    const direct = resolveProjectStore({ projectDir: project });
    const throughAlias = resolveProjectStore({ projectDir: alias });

    expect(direct).toMatchObject({
      kind: 'non-git',
      projectRoot: fs.realpathSync.native(project),
      checkoutRoot: fs.realpathSync.native(project),
      gitCommonDir: null,
      canonicalAgentDbPath: path.join(fs.realpathSync.native(project), '.swarm', 'memory.db'),
    });
    expect(throughAlias).toEqual(direct);
    expect(direct.projectIdentity.id).toMatch(/^non-git-sha256:[a-f0-9]{64}$/);
  });

  it('rejects parent traversal in the supplied project path even when it normalizes inside', () => {
    const project = temporaryRoot();
    fs.mkdirSync(path.join(project, 'nested'));

    expect(() => resolveProjectStore({ projectDir: `${project}${path.sep}nested${path.sep}..` }))
      .toThrow(/projectDir.*parent traversal/i);
  });

  it('rejects a requested AgentDB path rooted in a foreign project', () => {
    const project = temporaryRoot('project-store-local-');
    const foreign = temporaryRoot('project-store-foreign-');

    expect(() => resolveProjectStore({
      projectDir: project,
      requestedStorePath: path.join(foreign, '.swarm', 'memory.db'),
    })).toThrow(/foreign.*store/i);
  });

  it('rejects parent traversal in a requested store path before normalization', () => {
    const project = temporaryRoot();
    const requested = [project, '.swarm', 'nested', '..', 'memory.db'].join(path.sep);

    expect(() => resolveProjectStore({ projectDir: project, requestedStorePath: requested }))
      .toThrow(/requestedStorePath.*parent traversal/i);
  });

  it('rejects a project whose .swarm directory symlinks outside the canonical root', () => {
    const project = temporaryRoot('project-store-symlink-project-');
    const foreign = temporaryRoot('project-store-symlink-target-');
    fs.symlinkSync(foreign, path.join(project, '.swarm'), 'dir');

    expect(() => resolveProjectStore({ projectDir: project })).toThrow(/symlink.*escape/i);
  });

  it('accepts a requested store through a canonical alias of the project root', () => {
    const container = temporaryRoot();
    const project = path.join(container, 'project');
    const alias = path.join(container, 'project-alias');
    fs.mkdirSync(project);
    fs.symlinkSync(project, alias, 'dir');

    const resolved = resolveProjectStore({
      projectDir: alias,
      requestedStorePath: path.join(alias, '.swarm', 'memory.db'),
    });

    expect(resolved.canonicalAgentDbPath).toBe(path.join(project, '.swarm', 'memory.db'));
  });

  it('rejects a non-directory .swarm store root', () => {
    const project = temporaryRoot();
    fs.writeFileSync(path.join(project, '.swarm'), 'not a directory\n');

    expect(() => resolveProjectStore({ projectDir: project })).toThrow(/store.*ancestor.*directory/i);
  });

  it('rejects an existing memory.db symlink that escapes the project', () => {
    const project = temporaryRoot('project-store-db-link-project-');
    const foreign = temporaryRoot('project-store-db-link-target-');
    fs.mkdirSync(path.join(project, '.swarm'));
    const foreignDb = path.join(foreign, 'memory.db');
    fs.writeFileSync(foreignDb, 'foreign store\n');
    fs.symlinkSync(foreignDb, path.join(project, '.swarm', 'memory.db'));

    expect(() => resolveProjectStore({ projectDir: project })).toThrow(/symlink.*escape/i);
  });
});
