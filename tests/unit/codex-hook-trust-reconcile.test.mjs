import fs from 'node:fs';
import { getVersion } from '../../scripts/version.mjs';
const RELEASE_VERSION = getVersion();
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { reconcileVerifiedCodexHookTrust, obtainVerifiedPublishedHookIdentity, resolveNativeBinary } from '../../scripts/codex-hook-trust-reconcile.mjs';
import { codexHookIdentities } from '../../scripts/codex-hook-trust.mjs';

const dirs = []; afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-')); dirs.push(dir);
  const hooksPath = path.join(dir, 'codex-hooks.json'); const configPath = path.join(dir, 'config.toml');
  const hooks = { hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node released-snapshot.mjs', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node owner-disabled.mjs', timeout: 10 }] }] } };
  const bytes = JSON.stringify(hooks); fs.writeFileSync(hooksPath, bytes); fs.writeFileSync(configPath, 'private_config = "never print"\n');
  const ids = codexHookIdentities(hooks); const rows = [...ids].map(([key, currentHash], i) => ({ key, currentHash,
    pluginId: 'ruvnet-brain@ruvnet-brain', enabled: i === 0, trustStatus: i === 0 ? 'modified' : 'trusted' }));
  const other = { key: 'other-plugin:post_tool_use:0:0', currentHash: 'sha256:other', pluginId: 'other-plugin', enabled: false, trustStatus: 'untrusted' };
  const calls = []; let mode = ''; let written = false; let version = 'current-native-version';
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'hooks/list') {
      if (mode === 'bad-registry') return { data: [{ hooks: [{ ...rows[0], currentHash: 'sha256:unknown' }, rows[1], other] }] };
      if (mode === 'missing-registry') return { data: [{ hooks: [rows[0]] }] };
      return { data: [{ hooks: structuredClone([...rows, other]) }] };
    }
    if (method === 'config/read') return { layers: [{ name: { type: 'user', file: configPath }, version, config: mode === 'unrelated-drift' && written ? { unrelated: 'concurrent-owner-value' } : {} }] };
    if (method === 'config/batchWrite') {
      if (mode === 'race') throw new Error('Native config/batchWrite rejected');
      for (const edit of params.edits) {
        expect(edit.keyPath).toBe(`hooks.state.${JSON.stringify(rows[0].key)}.trusted_hash`);
        expect(edit.value).toBe(rows[0].currentHash);
      }
      expect(params.expectedVersion).toBe(version); expect(params.reloadUserConfig).toBe(true);
      written = true; rows[0].trustStatus = mode === 'failed-verification' ? 'modified' : 'trusted';
      if (mode === 'disabled-drift') rows[1].enabled = true;
      fs.appendFileSync(configPath, '# native hash edit\n'); return { status: 'ok' };
    }
    throw new Error('Unexpected metadata method');
  };
  const options = { releaseIdentity: { version: RELEASE_VERSION, integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
    hooksSha256: crypto.createHash('sha256').update(bytes).digest('hex') }, installedVersion: RELEASE_VERSION, hooksPath, configPath,
    cwd: dir, rpc, backupDir: path.join(dir, 'backups') };
  return { options, calls, rows, configPath, hooksPath, other, setMode: (m) => { mode = m; }, setVersion: (v) => { version = v; } };
}

describe('verified released native hook trust reconciliation', () => {
  it('repairs only owned enabled hashes with current native version, private backup and same-client proof', async () => {
    const f = fixture(); const prior = fs.readFileSync(f.configPath); const result = await reconcileVerifiedCodexHookTrust(f.options);
    expect(result.state).toBe('registry-verified'); expect(result.editedTrustHashes).toBe(1);
    expect(result.inferenceRequests).toBe(0); expect(result.executionAcceptance).toBe('not-run');
    expect(fs.readFileSync(result.backupPath)).toEqual(prior); expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600);
    expect(result.disabledPreserved).toEqual([f.rows[1].key]); expect(f.other.enabled).toBe(false);
    expect(f.calls.map((r) => r.method)).toEqual(['hooks/list', 'config/read', 'config/batchWrite', 'config/read', 'hooks/list']);
    const write = f.calls.find((r) => r.method === 'config/batchWrite'); expect(write.params.edits).toHaveLength(1);
    expect(JSON.stringify(write)).not.toMatch(/enabled|private_config|other-plugin/);
  });
  it('is idempotent with no backup/write when all enabled owned hooks are trusted', async () => {
    const f = fixture(); f.rows[0].trustStatus = 'trusted';
    expect((await reconcileVerifiedCodexHookTrust(f.options)).state).toBe('unchanged');
    expect(f.calls.map((r) => r.method)).toEqual(['hooks/list']);
  });
  it.each(['version', 'integrity', 'hooksSha256'])('rejects missing/unknown release %s before native calls', async (key) => {
    const f = fixture(); delete f.options.releaseIdentity[key];
    expect((await reconcileVerifiedCodexHookTrust(f.options)).state).toBe('blocked'); expect(f.calls).toHaveLength(0);
  });
  it('rejects version mismatch and installed source modifications before native calls', async () => {
    const f = fixture(); f.options.installedVersion = '4.5.3'; expect((await reconcileVerifiedCodexHookTrust(f.options)).state).toBe('blocked');
    f.options.installedVersion = RELEASE_VERSION; fs.appendFileSync(f.hooksPath, ' ');
    expect((await reconcileVerifiedCodexHookTrust(f.options)).state).toBe('blocked'); expect(f.calls).toHaveLength(0);
  });
  it.each(['bad-registry', 'missing-registry'])('refuses unmatched native identity %s', async (mode) => {
    const f = fixture(); f.setMode(mode); expect((await reconcileVerifiedCodexHookTrust(f.options)).state).toBe('blocked');
    expect(f.calls.some((r) => r.method === 'config/batchWrite')).toBe(false);
  });
  it('rejects unknown trust states and config symlinks before writing', async () => {
    const f = fixture(); f.rows[0].trustStatus = 'unknown';
    expect((await reconcileVerifiedCodexHookTrust(f.options)).state).toBe('blocked');
    expect(f.calls.some((r) => r.method === 'config/batchWrite')).toBe(false);
    const target = f.configPath + '.target'; fs.renameSync(f.configPath, target); fs.symlinkSync(target, f.configPath);
    expect((await reconcileVerifiedCodexHookTrust(f.options)).state).toBe('blocked');
  });
  it('preserves disabled modified hooks instead of re-enabling/trusting them', async () => {
    const f = fixture(); f.rows[0].enabled = false;
    expect((await reconcileVerifiedCodexHookTrust(f.options)).state).toBe('unchanged');
    expect(f.calls.some((r) => r.method === 'config/batchWrite')).toBe(false);
  });
  it('version fence failure preserves config and backup, never restores over other writers', async () => {
    const f = fixture(); const prior = fs.readFileSync(f.configPath); f.setMode('race');
    const result = await reconcileVerifiedCodexHookTrust(f.options); expect(result.state).toBe('degraded'); expect(result.changed).toBe('unknown');
    expect(fs.readFileSync(f.configPath)).toEqual(prior); expect(fs.readFileSync(result.backupPath)).toEqual(prior);
  });
  it.each(['failed-verification', 'disabled-drift', 'unrelated-drift'])('reports applied but degraded %s honestly', async (mode) => {
    const f = fixture(); f.setMode(mode); const result = await reconcileVerifiedCodexHookTrust(f.options);
    expect(result.state).toBe('degraded'); expect(result.changed).toBe(true); expect(result.backupPath).toBeTruthy();
  });
});

function publishedFixture(entry = 'package/plugin/hooks/codex-hooks.json') {
  const f = fixture(); const dir = path.dirname(f.hooksPath); const file = path.join(dir, entry);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(f.hooksPath, file);
  const archive = execFileSync('/usr/bin/tar', ['-czf', '-', entry], { cwd: dir });
  const metadata = { name: 'ruvnet-brain', version: RELEASE_VERSION, dist: {
    tarball: `https://registry.npmjs.org/ruvnet-brain/-/ruvnet-brain-${RELEASE_VERSION}.tgz`,
    integrity: 'sha512-' + crypto.createHash('sha512').update(archive).digest('base64') } };
  const urls = []; const fetch = async (url, options) => {
    urls.push(url); expect(options.redirect).toBe('error'); expect(options.signal).toBeTruthy();
    return new Response(url.endsWith('.tgz') ? archive : JSON.stringify(metadata), { status: 200 });
  };
  return { f, archive, metadata, fetch, urls };
}
describe('independent published hook identity', () => {
  it('verifies full archive integrity before reading exact stdout-only hooks member', async () => {
    const p = publishedFixture(); const result = await obtainVerifiedPublishedHookIdentity({ version: RELEASE_VERSION, fetch: p.fetch });
    expect(result.state).toBe('verified'); expect(result.releaseIdentity).toEqual({ ...p.f.options.releaseIdentity, integrity: p.metadata.dist.integrity });
    expect(p.urls).toHaveLength(2);
  });
  it('rejects corrupted archive bytes', async () => {
    const p = publishedFixture(); const fetch = async (url) => new Response(url.endsWith('.tgz') ? Buffer.concat([p.archive, Buffer.from('corrupt')]) : JSON.stringify(p.metadata));
    expect((await obtainVerifiedPublishedHookIdentity({ version: RELEASE_VERSION, fetch })).reason).toMatch(/integrity mismatch/);
  });
  it('rejects HTTP failure and version/path mismatch without tarball request', async () => {
    expect((await obtainVerifiedPublishedHookIdentity({ version: RELEASE_VERSION, fetch: async () => new Response('', { status: 404 }) })).state).toBe('blocked');
    for (const change of [(m) => { m.version = '4.5.3'; }, (m) => { m.dist.tarball = 'https://untrusted.example/package.tgz'; }]) {
      const p = publishedFixture(); change(p.metadata);
      expect((await obtainVerifiedPublishedHookIdentity({ version: RELEASE_VERSION, fetch: p.fetch })).state).toBe('blocked'); expect(p.urls).toHaveLength(1);
    }
  });
  it('rejects wrong archive path, absent platform tar and oversized source', async () => {
    const wrong = publishedFixture('package/unknown/hooks.json');
    expect((await obtainVerifiedPublishedHookIdentity({ version: RELEASE_VERSION, fetch: wrong.fetch })).state).toBe('blocked');
    const p = publishedFixture();
    expect((await obtainVerifiedPublishedHookIdentity({ version: RELEASE_VERSION, fetch: p.fetch, tarBinary: '/nonexistent/tar' })).state).toBe('blocked');
    expect((await obtainVerifiedPublishedHookIdentity({ version: RELEASE_VERSION, fetch: p.fetch, maxTarballBytes: 1 })).state).toBe('blocked');
  });
  it('released digest cannot trust a modified unpublished source checkout', async () => {
    const p = publishedFixture(); const proof = await obtainVerifiedPublishedHookIdentity({ version: RELEASE_VERSION, fetch: p.fetch });
    fs.appendFileSync(p.f.hooksPath, ' '); const result = await reconcileVerifiedCodexHookTrust({ ...p.f.options, releaseIdentity: proof.releaseIdentity });
    expect(result.state).toBe('blocked'); expect(p.f.calls).toHaveLength(0);
  });
});

describe('explicit bounded installer CLI', () => {
  it('resolves a command deterministically without shell or interpolation', () => {
    const f = fixture(); const dir = path.dirname(f.configPath); const exe = path.join(dir, 'codex');
    fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    expect(resolveNativeBinary('codex', { env: { PATH: dir } })).toBe(fs.realpathSync(exe));
    expect(() => resolveNativeBinary('codex; other', { env: { PATH: dir } })).toThrow();
    expect(() => resolveNativeBinary('codex', { env: { PATH: '/missing' } })).toThrow();
    const win = path.join(dir, 'codex.EXE'); fs.copyFileSync(exe, win);
    expect(resolveNativeBinary('codex', { env: { PATH: dir, PATHEXT: '.EXE;.CMD' }, platform: 'win32' })).toBe(fs.realpathSync(win));
  });
  it('awaits SIGKILL cleanup for a stubborn metadata child after a lost write reply', async () => {
    const f = fixture(); const dir = path.dirname(f.configPath); const exe = path.join(dir, 'stubborn-native'); const pidFile = path.join(dir, 'child.json');
    const code = `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,home:process.env.CODEX_HOME}));
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
rl.createInterface({input:process.stdin}).on('line',(line)=>{const q=JSON.parse(line);if(!q.id)return;
let result={};if(q.method==='hooks/list')result={data:[{hooks:${JSON.stringify(f.rows)}}]};
if(q.method==='config/read')result={layers:[{name:{type:'user',file:${JSON.stringify(f.configPath)}},version:'v',config:{}}]};
if(q.method==='config/batchWrite'){fs.appendFileSync(${JSON.stringify(f.configPath)},'# possible committed write');return;}
process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');});
`;
    fs.writeFileSync(exe, code, { mode: 0o700 });
    const { rpc, ...options } = f.options;
    const result = await reconcileVerifiedCodexHookTrust({ ...options, nativeBinary: exe, timeoutMs: 500 });
    expect(result.state).toBe('degraded'); expect(result.changed).toBe('unknown');
    const child = JSON.parse(fs.readFileSync(pidFile)); expect(child.home).toBe(dir);
    expect(() => process.kill(child.pid, 0)).toThrow();
  });
  it('import has no metadata/process/stdin side effects and explicit CLI emits one valid JSON line', () => {
    const module = path.resolve('scripts/codex-hook-trust-reconcile.mjs');
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(module)})`], { timeout: 1000, encoding: 'utf8' })).toBe('');
    const out = execFileSync(process.execPath, [module, '--reconcile-installed'], { input: '{"unknown":"private-config-do-not-print"}', timeout: 1000, encoding: 'utf8' });
    expect(out.endsWith('\n')).toBe(true); expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out).state).toBe('blocked'); expect(out).not.toContain('private-config');
  });
});
