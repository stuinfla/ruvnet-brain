import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { diagnose } = vi.hoisted(() => ({ diagnose: vi.fn() }));
vi.mock('../../plugin/scripts/memory-doctor.mjs', () => ({ diagnose }));
const { CAPABILITIES, auditAll } = await import('../../plugin/scripts/capability-registry.mjs');
const detector = CAPABILITIES.find((row) => row.key === 'memory-distillation');
const roots = [];
function temporary() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'capability-canonical-')));
  roots.push(root);
  return root;
}
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'source.txt'), 'fixture');
  git(root, 'add', 'source.txt');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}
function fixture() {
  const container = temporary();
  const primary = repository(path.join(container, 'primary'));
  const linked = path.join(container, 'linked');
  git(primary, 'worktree', 'add', '-qb', 'linked', linked);
  for (const root of [primary, linked]) fs.mkdirSync(path.join(root, 'nested'));
  return { container, primary, linked };
}
function store(root, content) {
  fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
  const file = path.join(root, '.swarm', 'memory.db');
  fs.writeFileSync(file, content);
  return file;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  diagnose.mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('capability diagnostics use the canonical project store', () => {
  it('all four Git entry paths diagnose the primary store despite decoys and retain caller metadata', () => {
    const { primary, linked } = fixture();
    const db = store(primary, 'canonical');
    store(linked, 'decoy');
    store(path.join(linked, 'nested'), 'nested decoy');
    diagnose.mockImplementation((file) => ({ total: 7, real: 7, patterns: 2, cover: 1,
      learns: fs.readFileSync(file, 'utf8') === 'canonical' }));
    for (const project of [primary, path.join(primary, 'nested'), linked, path.join(linked, 'nested')]) {
      expect(detector.detect({ project })).toMatchObject({ state: 'on' });
      expect(diagnose).toHaveBeenLastCalledWith(db);
    }
    const project = path.join(linked, 'nested');
    expect(auditAll({ project }).find((row) => row.key === detector.key)).toMatchObject({ project, state: 'on' });
    expect(diagnose.mock.calls.every(([file]) => file === db)).toBe(true);
  });

  it('a local decoy cannot substitute for a missing primary store', () => {
    const { primary, linked } = fixture();
    store(linked, 'decoy');
    const result = detector.detect({ project: linked });
    expect(result.state).toBe('absent');
    expect(result.evidence).toContain(path.join(primary, '.swarm', 'memory.db'));
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('ignores an inherited foreign Git identity rather than diagnosing a foreign store', () => {
    const { container, primary } = fixture();
    const foreign = repository(path.join(container, 'foreign'));
    const db = store(primary, 'canonical');
    store(foreign, 'foreign');
    vi.stubEnv('GIT_DIR', path.join(foreign, '.git'));
    vi.stubEnv('GIT_WORK_TREE', foreign);
    vi.stubEnv('GIT_COMMON_DIR', path.join(foreign, '.git'));
    diagnose.mockReturnValue({ total: 0 });
    expect(detector.detect({ project: primary }).state).toBe('absent');
    expect(diagnose).toHaveBeenCalledExactlyOnceWith(db);
  });

  it('reports unsupported submodule identity as unknown without selecting an ancestor or local store', () => {
    const { container, primary } = fixture();
    const dependency = repository(path.join(container, 'dependency'));
    git(primary, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', dependency, 'child');
    store(path.join(primary, 'child'), 'child');
    expect(detector.detect({ project: path.join(primary, 'child') }).state).toBe('unknown');
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('fails closed on unresolved paths and escaping store links', () => {
    const root = temporary();
    const project = path.join(root, 'plain');
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(project, 'nested'));
    for (const candidate of [path.join(root, 'missing'), `${project}/nested/..`]) {
      expect(detector.detect({ project: candidate }).state).toBe('unknown');
    }
    fs.symlinkSync(root, path.join(project, '.swarm'), 'dir');
    expect(detector.detect({ project }).state).toBe('unknown');
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('preserves standalone non-Git diagnostic states', () => {
    const project = temporary();
    const db = store(project, 'synthetic diagnostic input');
    for (const [answer, state] of [
      [{ unreadable: 'file is not a database' }, 'unknown'],
      [{ schemaless: true }, 'unknown'],
      [{ total: 0 }, 'absent'],
      [{ total: 3, patterns: 0, cover: 1 }, 'off'],
      [{ total: 3, real: 3, patterns: 2, cover: 1, learns: true }, 'on'],
    ]) {
      diagnose.mockReturnValue(answer);
      expect(detector.detect({ project }).state).toBe(state);
      expect(diagnose).toHaveBeenLastCalledWith(db);
    }
  });

  it.skipIf(process.platform === 'win32')('bounds a stalled Git probe and reports unknown without fallback', () => {
    const root = temporary();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    vi.stubEnv('PATH', bin);
    const start = Date.now();
    expect(detector.detect({ project: root }).state).toBe('unknown');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(diagnose).not.toHaveBeenCalled();
  });
});
