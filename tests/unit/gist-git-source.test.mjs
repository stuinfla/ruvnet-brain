import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as transport from '../../scripts/gist-git-source.mjs';
import { captureGistSources, defaultFetchDetail, isIncludedGistFile } from '../../scripts/gist-receipts.mjs';
import { observeSourceUniverse } from '../../scripts/source-coverage.mjs';

const execute = promisify(execFile);
const id = 'a'.repeat(32);
const directories = [];
afterEach(() => { vi.restoreAllMocks(); while (directories.length) fs.rmSync(directories.pop(), { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-git-test-'));
  directories.push(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', ...args], { env: transport.gistGitEnvironment(), encoding: 'utf8' });
  git('init', '--quiet', '--object-format=sha1', '--template=');
  fs.writeFileSync(path.join(dir, 'one.md'), '\ufefffirst\r\n');
  fs.writeFileSync(path.join(dir, 'two.txt'), 'second\n');
  fs.writeFileSync(path.join(dir, 'excluded.png'), Buffer.from([255, 254]));
  git('add', '.'); git('commit', '--quiet', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD').trim();
  const rows = git('ls-tree', '-r', '-l', 'HEAD').trim().split('\n').map((row) => {
    const [, oid, size, name] = /^\d+ blob (\w+) +(\d+)\t(.+)$/.exec(row);
    return { name, oid, size: Number(size) };
  });
  const stub = { id, public: true, owner: { login: 'ruvnet' }, updated_at: '2026-09-18T00:00:00Z',
    files: Object.fromEntries(rows.map((f) => [f.name, { filename: f.name, size: f.size,
      raw_url: `https://gist.githubusercontent.com/ruvnet/${id}/raw/${f.oid}/${f.name}` }])) };
  const calls = [];
  const gitExec = async (binary, args, options) => {
    calls.push({ args, options });
    return execute(binary, ['-c', 'protocol.file.allow=always', ...args.map((arg) =>
      arg === `https://gist.github.com/${id}.git` ? dir : arg)], options);
  };
  const capture = (options = {}) => transport.fetchPublicGistGit(id, {
    stub, owner: 'ruvnet', includeFile: isIncludedGistFile, gitExec, ...options });
  return { dir, git, commit, stub, rows, calls, gitExec, capture };
}

describe('public gist Git capture', () => {
  it('captures different blob OIDs and excluded binary inventory through the canonical pipeline', async () => {
    const f = fixture();
    expect(new Set(f.rows.map((row) => row.oid)).size).toBe(3);
    const observation = observeSourceUniverse({ owner: 'ruvnet', externalSources: [], gh: (args) => {
      if (args[1] === 'graphql') return JSON.stringify({ data: { user: { repositories: {
        nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
      if (args[1] === 'users/ruvnet') return JSON.stringify({ public_gists: 1 });
      if (args[1].startsWith('users/ruvnet/gists')) return JSON.stringify([[f.stub]]);
      throw new Error('unexpected observation request');
    } });
    expect(observation.owner).toBe('ruvnet');
    expect(observation.gists.rows[0].public).toBeUndefined();
    const full = await f.capture({ stub: observation.gists.rows[0] });
    expect(full.history[0].version).toBe(f.commit);
    expect(full.updated_at).toBe(f.stub.updated_at);
    expect(full.files['one.md'].content).toBe('\ufefffirst\r\n');
    expect(full.files['excluded.png'].content).toBeUndefined();
    expect(full.captureEvidence.kind).toBe('git-tree-matched-observation');
    const result = await captureGistSources({ observation,
      fetchDetail: async () => full });
    expect(result.gists[id].files.find((file) => file.filename === 'excluded.png').included).toBe(false);
    expect(result.gists[id].versionSha).toBe(f.commit);
    expect(result.gists[id].files.find((file) => file.filename === 'one.md').body).toBe('\ufefffirst\r\n');
    for (const call of f.calls) expect(fs.existsSync(call.args[call.args.indexOf('-C') + 1])).toBe(false);
  });

  it.each(['missing', 'extra', 'renamed', 'same-size-change', 'excluded-change', 'wrong-size'])('rejects %s inventory', async (kind) => {
    const f = fixture();
    if (kind === 'missing') fs.unlinkSync(path.join(f.dir, 'two.txt'));
    if (kind === 'extra') fs.writeFileSync(path.join(f.dir, 'extra.md'), 'extra');
    if (kind === 'renamed') fs.renameSync(path.join(f.dir, 'two.txt'), path.join(f.dir, 'renamed.txt'));
    if (kind === 'same-size-change') fs.writeFileSync(path.join(f.dir, 'two.txt'), 'change\n');
    if (kind === 'excluded-change') fs.writeFileSync(path.join(f.dir, 'excluded.png'), Buffer.from([255, 253]));
    if (kind === 'wrong-size') f.stub.files['two.txt'].size++;
    else { f.git('add', '-A'); f.git('commit', '--quiet', '-m', 'changed'); }
    await expect(f.capture()).rejects.toMatchObject({ code: 'GIST_OBSERVATION_MOVED', gistId: id, detail: expect.any(Object) });
  });

  it.each(['http://gist.githubusercontent.com', 'https://evil.example', 'https://user@gist.githubusercontent.com',
    'https://gist.githubusercontent.com:444'])('rejects a malformed raw origin %s before Git', async (origin) => {
    const f = fixture();
    f.stub.files['one.md'].raw_url = f.stub.files['one.md'].raw_url.replace('https://gist.githubusercontent.com', origin);
    await expect(f.capture()).rejects.toThrow('raw identity');
    expect(f.calls).toHaveLength(0);
  });

  it.each(['owner', 'id', 'name', 'oid', 'query', 'fragment'])('rejects mismatched raw %s', async (kind) => {
    const f = fixture(), file = f.stub.files['one.md'];
    if (kind === 'owner') file.raw_url = file.raw_url.replace('/ruvnet/', '/elsewhere/');
    if (kind === 'id') file.raw_url = file.raw_url.replace(id, 'b'.repeat(32));
    if (kind === 'name') file.raw_url = file.raw_url.replace('/one.md', '/two.md');
    if (kind === 'oid') file.raw_url = file.raw_url.replace(/\/raw\/\w+\//, '/raw/not-an-oid/');
    if (kind === 'query') file.raw_url += '?x=1';
    if (kind === 'fragment') file.raw_url += '#x';
    await expect(f.capture()).rejects.toThrow('raw identity');
  });

  it.each(['120000 blob', '160000 commit', '040000 tree', '100644 blob'])('rejects unsupported tree entries %s', (mode) => {
    const f = fixture();
    const name = mode === '100644 blob' ? 'nested/one.md' : 'one.md';
    expect(() => transport.verifyGistGitTree(id, f.rows, Buffer.from(`${mode} ${'b'.repeat(40)} 1\t${name}\0`)))
      .toThrow('unsupported-tree-entry');
  });

  it('rejects duplicate tree entries and accepts executable regular blobs', () => {
    const f = fixture(), rows = f.rows.map((r) => `100755 blob ${r.oid} ${r.size}\t${r.name}\0`);
    expect(transport.verifyGistGitTree(id, f.rows, Buffer.from(rows.join('')))).toHaveLength(3);
    expect(() => transport.verifyGistGitTree(id, f.rows, Buffer.from(rows.join('') + rows[0]))).toThrow('file-set');
  });

  it('continues reading the resolved commit when remote HEAD advances', async () => {
    const f = fixture(); let advanced = false;
    const full = await f.capture({ gitExec: async (...args) => {
      const result = await f.gitExec(...args);
      if (args[1].includes('rev-parse') && !advanced) {
        advanced = true; fs.writeFileSync(path.join(f.dir, 'two.txt'), 'new remote contents');
        f.git('add', '.'); f.git('commit', '--quiet', '-m', 'advance');
      }
      return result;
    } });
    expect(full.history[0].version).toBe(f.commit);
    expect(full.files['two.txt'].content).toBe('second\n');
  });

  it('records an actual new commit with identical content and frozen observed metadata', async () => {
    const f = fixture(); f.git('commit', '--quiet', '--allow-empty', '-m', 'metadata');
    const full = await f.capture();
    expect(full.history[0].version).toBe(f.git('rev-parse', 'HEAD').trim());
    expect(full.history[0].version).not.toBe(f.commit);
    expect(full.updated_at).toBe(f.stub.updated_at);
  });

  it('rejects invalid UTF-8 text while leaving excluded binary undecoded', async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.dir, 'one.md'), Buffer.from([255]));
    f.git('add', '.'); f.git('commit', '--quiet', '-m', 'invalid text');
    const oid = f.git('rev-parse', 'HEAD:one.md').trim();
    f.stub.files['one.md'].size = 1;
    f.stub.files['one.md'].raw_url = `https://gist.githubusercontent.com/ruvnet/${id}/raw/${oid}/one.md`;
    await expect(f.capture()).rejects.toThrow(`gist ${id}/one.md is not valid UTF-8 text`);
  });

  it('retries transient fetch failures only and independently checks returned blob bytes', async () => {
    const f = fixture(); let attempts = 0;
    const gitExec = async (...args) => {
      if (args[1].includes('fetch') && ++attempts < 3) throw new Error('connection reset');
      if (args[1].includes('cat-file')) return { stdout: Buffer.from('forged') };
      return f.gitExec(...args);
    };
    await expect(f.capture({ gitExec })).rejects.toMatchObject({ code: 'GIST_OBSERVATION_MOVED', detail: { check: 'blob-bytes' } });
    expect(attempts).toBe(3);
  });

  it.each(['abort', 'timeout', 'missing-git'])('cleans temporary state after %s', async (kind) => {
    const f = fixture(), controller = new AbortController(); let folder;
    const gitExec = async (binary, args, options) => {
      folder = args[args.indexOf('-C') + 1];
      if (kind === 'missing-git') throw Object.assign(new Error('git absent'), { code: 'ENOENT' });
      if (args.includes('fetch')) {
        if (kind === 'abort') setTimeout(() => controller.abort(), 20);
        return execute(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], options);
      }
      return f.gitExec(binary, args, options);
    };
    await expect(f.capture({ gitExec, signal: controller.signal, timeoutMs: 300 })).rejects.toThrow();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('does not inherit token or injected Git configuration', () => {
    vi.stubEnv('GH_TOKEN', 'never-forward'); vi.stubEnv('GIT_CONFIG_PARAMETERS', 'malicious');
    try {
      const env = transport.gistGitEnvironment();
      expect(env.GH_TOKEN).toBeUndefined(); expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(Object.keys(env).filter((k) => k.startsWith('GIT_')).sort()).toEqual([
        'GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_TERMINAL_PROMPT']);
    } finally { vi.unstubAllEnvs(); }
  });

  it('routes only integration-scope rejection to Git and never forwards its fixture seam', async () => {
    const f = fixture(), full = await f.capture();
    const git = vi.spyOn(transport, 'fetchPublicGistGit').mockResolvedValue(full);
    const publicRest = vi.fn();
    const forbidden = () => ({ status: 1, stderr: 'Resource not accessible by integration (HTTP 403)' });
    await defaultFetchDetail(id, { stub: f.stub, owner: 'ruvnet', spawn: forbidden, fetchImpl: publicRest, gitExec: vi.fn() });
    expect(git).toHaveBeenCalledOnce(); expect(publicRest).not.toHaveBeenCalled();
    expect(git.mock.calls[0][1].gitExec).toBeUndefined();
    git.mockClear();
    await expect(defaultFetchDetail(id, { stub: f.stub, owner: 'ruvnet', retries: 1,
      spawn: () => ({ status: 1, stderr: 'Not Found (HTTP 404)' }) })).rejects.toMatchObject({ code: 'GIST_NOT_FOUND' });
    expect(git).not.toHaveBeenCalled();
    await expect(defaultFetchDetail(id, { stub: f.stub, spawn: forbidden, fetchImpl: publicRest }))
      .rejects.toMatchObject({ code: 'GIST_OBSERVATION_INVALID' });
    expect(publicRest).not.toHaveBeenCalled();
  });
});
