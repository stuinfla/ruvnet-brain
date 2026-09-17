import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildForkDeltaCorpus, validateForkDeltaIdentity } from '../../kb/fork-source.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const tempDirs = [];
afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-delta-'));
  tempDirs.push(root);
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(root, 'sentinel.md'), 'UPSTREAM ONLY — must never enter fork delta passages\n');
  fs.writeFileSync(path.join(root, 'old.js'), 'const shared = true;\nconst before = true;\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'upstream');
  fs.writeFileSync(path.join(root, 'deleted.txt'), 'remove me\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'upstream deletion fixture');
  const base = git(root, 'rev-parse', 'HEAD');
  fs.renameSync(path.join(root, 'old.js'), path.join(root, 'renamed.js'));
  fs.writeFileSync(path.join(root, 'renamed.js'), 'const shared = true;\nconst after = true;\n');
  fs.rmSync(path.join(root, 'deleted.txt')); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fork changes');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/fork.git');
  return { root, base, head };
}

describe('fork-source delta materialization', () => {
  it('validates pinned identity and emits only deterministic changed-operation documents', async () => {
    const f = fixture();
    const metadata = {
      version: 'fork-delta/1', forkRepository: 'example/fork', upstream: 'example/upstream',
      upstreamHeadSha: f.base, forkHeadSha: f.head, mergeBaseSha: f.base, aheadBy: 1, behindBy: 0,
    };
    expect(validateForkDeltaIdentity(metadata)).toMatchObject(metadata);
    const out = await buildForkDeltaCorpus({ repo: f.root, name: 'fork', metadata });
    expect(out.sourceMode).toBe('fork-delta');
    expect(out.operations.map((x) => x.kind)).toEqual(['D', 'R']);
    expect(out.chunks.length).toBeGreaterThan(0);
    const passages = fs.readFileSync(path.join(out.outputDir, 'fork-delta.passages.jsonl'), 'utf8');
    expect(passages).not.toContain('UPSTREAM ONLY');
    expect(passages).toContain('Operation: rename old.js → renamed.js');
    expect(passages).toContain('Operation: D deleted.txt');
    expect(out.chunks.every((chunk) => chunk.text === chunk.embedText)).toBe(true);
    expect(out.chunks.every((chunk) => chunk.operation?.paths?.length)).toBe(true);
    expect(passages).not.toMatch(/@@[^\n]*\n [^\n]/);
    expect(out.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out.passagesSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a forged remote or pinned head before materialization', async () => {
    const f = fixture();
    const metadata = {
      version: 'fork-delta/1', forkRepository: 'other/fork', upstream: 'example/upstream',
      upstreamHeadSha: f.base, forkHeadSha: f.head, mergeBaseSha: f.base, aheadBy: 1, behindBy: 0,
    };
    await expect(buildForkDeltaCorpus({ repo: f.root, name: 'fork', metadata })).rejects.toThrow(/remote/);
  });

  it('keeps a typed document for a net-zero delta', async () => {
    const f = fixture();
    const metadata = {
      version: 'fork-delta/1', forkRepository: 'example/fork', upstream: 'example/upstream',
      upstreamHeadSha: f.head, forkHeadSha: f.head, mergeBaseSha: f.head, aheadBy: 0, behindBy: 0,
    };
    const out = await buildForkDeltaCorpus({ repo: f.root, name: 'fork', metadata });
    expect(out.operations).toEqual([]);
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0].operation).toEqual({ kind: 'N', status: 'NETZERO', paths: ['(no changed paths)'] });
    expect(out.chunks[0].text).toContain('no net changed paths');
  });

});
