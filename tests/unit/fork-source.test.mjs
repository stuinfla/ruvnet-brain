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
  fs.chmodSync(path.join(root, 'renamed.js'), 0o755);
  fs.symlinkSync('renamed.js', path.join(root, 'linked.js'));
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 255, 1, 2, 0, 3]));
  const nested = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-submodule-')); tempDirs.push(nested);
  git(nested, 'init', '-q'); git(nested, 'config', 'user.email', 'test@example.invalid'); git(nested, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(nested, 'module.txt'), 'submodule\n'); git(nested, 'add', '.'); git(nested, 'commit', '-qm', 'module');
  const submoduleSha = git(nested, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'literal\\name.txt'), 'backslash path\n');
  git(root, 'add', 'renamed.js', 'linked.js', 'binary.bin', 'literal\\name.txt');
  git(root, 'update-index', '--add', `--cacheinfo`, `160000,${submoduleSha},submodule`);
  git(root, 'commit', '-qm', 'typed operations');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/fork.git');
  return { root, base, head, submoduleSha };
}

describe('fork-source delta materialization', () => {
  it('validates pinned identity and emits only deterministic changed-operation documents', async () => {
    const f = fixture();
    const metadata = {
      version: 'fork-delta/2', forkRepository: 'example/fork', upstream: 'example/upstream',
      upstreamHeadSha: f.base, forkHeadSha: f.head, mergeBaseSha: f.base, aheadBy: 2, behindBy: 0,
    };
    expect(validateForkDeltaIdentity(metadata)).toMatchObject(metadata);
    const out = await buildForkDeltaCorpus({ repo: f.root, name: 'fork', metadata });
    tempDirs.push(out.outputDir);
    expect(out.sourceMode).toBe('fork-delta');
    expect(out.operations.map((x) => x.kind)).toEqual(['A', 'A', 'A', 'A', 'D', 'R']);
    expect(out.chunks.length).toBeGreaterThan(0);
    const passages = fs.readFileSync(path.join(out.outputDir, 'fork-delta.passages.jsonl'), 'utf8');
    expect(passages).not.toContain('UPSTREAM ONLY');
    expect(passages).toContain('Operation: rename old.js → renamed.js');
    expect(passages).toContain('Operation: D deleted.txt');
    expect(out.operations.find((x) => x.typed === 'symlink')).toMatchObject({ newMode: '120000' });
    expect(out.operations.find((x) => x.typed === 'submodule')).toMatchObject({ newMode: '160000', newObject: f.submoduleSha });
    expect(out.operations.find((x) => x.kind === 'R')).toMatchObject({ oldMode: '100644', newMode: '100755' });
    expect(out.operations.find((x) => x.paths[0] === 'literal\\name.txt')).toBeTruthy();
    expect(out.chunks.some((chunk) => chunk.operation.typed === 'binary' && chunk.text.includes('non-text binary operation'))).toBe(true);
    expect(out.chunks.every((chunk) => chunk.text === chunk.embedText)).toBe(true);
    expect(out.chunks.every((chunk) => chunk.operation?.paths?.length)).toBe(true);
    expect(passages).not.toMatch(/@@[^\n]*\n [^\n]/);
    expect(out.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out.passagesSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records credential-shaped paths without reading or embedding their payload', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, '.env'), 'FAKE_TEST_SECRET=must-not-be-embedded\n');
    fs.writeFileSync(path.join(f.root, 'server.key'), 'FAKE_PRIVATE_KEY_TEST_BYTES\n');
    git(f.root, 'add', '-f', '.env', 'server.key'); git(f.root, 'commit', '-qm', 'sensitive fixture');
    const head = git(f.root, 'rev-parse', 'HEAD');
    const out = await buildForkDeltaCorpus({ repo:f.root, name:'fork', metadata:{
      version:'fork-delta/2', forkRepository:'example/fork', upstream:'example/upstream',
      upstreamHeadSha:f.base, forkHeadSha:head, mergeBaseSha:f.base, aheadBy:3, behindBy:0,
    }});
    tempDirs.push(out.outputDir);
    const passages=fs.readFileSync(path.join(out.outputDir, 'fork-delta.passages.jsonl'), 'utf8');
    expect(passages).not.toContain('must-not-be-embedded');
    expect(passages).not.toContain('FAKE_PRIVATE_KEY_TEST_BYTES');
    for (const file of ['.env', 'server.key']) expect(out.operations.find(op=>op.paths.includes(file)))
      .toMatchObject({typed:'sensitive-metadata-only', hunks:[], newObject:expect.stringMatching(/^[a-f0-9]{40}$/)});
  });

  it('rejects a forged remote or pinned head before materialization', async () => {
    const f = fixture();
    const metadata = {
      version: 'fork-delta/2', forkRepository: 'other/fork', upstream: 'example/upstream',
      upstreamHeadSha: f.base, forkHeadSha: f.head, mergeBaseSha: f.base, aheadBy: 2, behindBy: 0,
    };
    await expect(buildForkDeltaCorpus({ repo: f.root, name: 'fork', metadata })).rejects.toThrow(/remote/);
  });

  it('rejects graph counts that do not match the pinned ancestry', async () => {
    const f = fixture();
    const metadata = {
      version: 'fork-delta/2', forkRepository: 'example/fork', upstream: 'example/upstream',
      upstreamHeadSha: f.base, forkHeadSha: f.head, mergeBaseSha: f.base, aheadBy: 1, behindBy: 0,
    };
    await expect(buildForkDeltaCorpus({ repo: f.root, name: 'fork', metadata })).rejects.toThrow(/graph counts/);
  });

  it('keeps a typed document for a net-zero delta', async () => {
    const f = fixture();
    const metadata = {
      version: 'fork-delta/2', forkRepository: 'example/fork', upstream: 'example/upstream',
      upstreamHeadSha: f.head, forkHeadSha: f.head, mergeBaseSha: f.head, aheadBy: 0, behindBy: 0,
    };
    const out = await buildForkDeltaCorpus({ repo: f.root, name: 'fork', metadata });
    tempDirs.push(out.outputDir);
    expect(out.operations).toEqual([]);
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0].operation).toMatchObject({ kind: 'N', status: 'NETZERO', paths: ['(no changed paths)'], hunks: [] });
    expect(out.chunks[0].text).toContain('no net changed paths');
  });

});
