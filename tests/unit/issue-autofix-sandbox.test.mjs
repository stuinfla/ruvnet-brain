// ADR-107: the macOS sandbox that every model-written test runs in. Pure parts everywhere; on darwin a REAL run proves
// a test inside cannot read a planted gh credential under a fake HOME, cannot reach a local HTTP server, and sees no token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { READ_DENY_HOME, SANDBOX_BIN, makeSandboxRunner, sandboxEnv, sandboxProfile } from '../../scripts/issue-autofix-sandbox.mjs';

const tmps = [];
const tmp = (p = 'autofix-sbx-test-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop(), { recursive: true, force: true }); });
const abortCode = (fn) => { try { fn(); } catch (e) { expect(e.name).toBe('AutofixAbort'); return e.code; } throw new Error('did not throw'); };

describe('sandboxProfile (pure)', () => {
  const home = '/Users/someone'; const wt = '/private/tmp/wt'; const run = '/private/tmp/run';
  const p = () => sandboxProfile({ home, writable: [wt, run] });
  it('denies every outbound network path and binding', () => {
    const lines = p().split('\n');
    expect(lines).toContain('(deny network-outbound (remote ip))');
    expect(lines).toContain('(deny network-outbound (remote unix-socket))');
    expect(lines).toContain('(deny network-bind)');
    expect(p()).not.toMatch(/\(allow network/);
  });
  it('denies the keychain / security mach services', () => {
    const line = p().split('\n').find((l) => l.startsWith('(deny mach-lookup'));
    for (const n of ['com.apple.SecurityServer', 'com.apple.securityd.xpc', 'com.apple.secd', 'com.apple.security.agent']) expect(line).toContain(`(global-name "${n}")`);
  });
  it('denies reading every credential store and private folder under HOME, the system keychains and any .env', () => {
    const line = p().split('\n').find((l) => l.startsWith('(deny file-read-data'));
    for (const d of ['.ssh', '.npmrc', '.config', '.claude', '.aws', '.gnupg', '.git-credentials', 'Library', 'Documents', 'Code']) {
      expect(READ_DENY_HOME).toContain(d);
      expect(line).toContain(`(subpath "${path.join(home, d)}")`);
    }
    expect(line).toContain('(subpath "/Library/Keychains")');
    expect(line).toContain('\\.env');
  });
  it('writes are denied everywhere except the worktree, the run temp dir and /dev', () => {
    const line = p().split('\n').find((l) => l.startsWith('(deny file-write*'));
    expect(line).toBe(`(deny file-write* (require-not (require-any (subpath "${wt}") (subpath "${run}") (subpath "/dev"))))`);
    expect(p()).not.toMatch(/\(allow file-write/);
  });
  it('the allows come after the denies (later rules win in SBPL) and readable re-opens only what is named', () => {
    const prof = sandboxProfile({ home, writable: [wt], readable: [`${home}/Code/x/node_modules`] });
    const lines = prof.split('\n');
    const allowRead = lines.findIndex((l) => l.startsWith('(allow file-read-data'));
    expect(allowRead).toBeGreaterThan(lines.findIndex((l) => l.startsWith('(deny file-read-data')));
    expect(lines[allowRead]).toContain(`(subpath "${home}/Code/x/node_modules")`);
    expect(p()).not.toMatch(/\(allow file-read-data/);
    expect(lines[0]).toBe('(version 1)');
  });
  it('refuses a relative home or relative / missing writable paths', () => {
    expect(() => sandboxProfile({ home: 'rel', writable: [wt] })).toThrow(/home/);
    expect(() => sandboxProfile({ home, writable: [] })).toThrow(/writable/);
    expect(() => sandboxProfile({ home, writable: ['rel/wt'] })).toThrow(/writable/);
  });
});

describe('sandboxEnv (pure)', () => {
  it('carries nothing from the parent: no token, HOME is the temp home, npm offline', () => {
    const prev = process.env.GH_TOKEN; process.env.GH_TOKEN = 'ghp_LEAK';
    try {
      const e = sandboxEnv({ tmpHome: '/t/home', pathDirs: ['/n', '/usr/bin'] });
      expect(Object.keys(e).sort()).toEqual(['CI', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR', 'npm_config_audit', 'npm_config_fund', 'npm_config_offline', 'npm_config_update_notifier']);
      expect(e).toMatchObject({ HOME: '/t/home', TMPDIR: '/t/home', PATH: '/n:/usr/bin', npm_config_offline: 'true' });
      expect(JSON.stringify(e)).not.toMatch(/LEAK/);
    } finally { if (prev === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prev; }
  });
});

describe('makeSandboxRunner: fail closed', () => {
  const exec = () => { throw new Error('exec must not be reached'); };
  it('off darwin nothing runs: sandbox-unavailable', () => {
    for (const platform of ['linux', 'win32']) expect(abortCode(() => makeSandboxRunner({ exec, platform, exists: () => true })('node', [], { cwd: '/x' }))).toBe('sandbox-unavailable');
  });
  it('on darwin without sandbox-exec nothing runs: sandbox-unavailable', () => {
    expect(abortCode(() => makeSandboxRunner({ exec, platform: 'darwin', exists: (p) => p !== SANDBOX_BIN })('node', [], { cwd: '/x' }))).toBe('sandbox-unavailable');
  });
  it('a relative cwd is refused', () => {
    expect(abortCode(() => makeSandboxRunner({ exec, platform: 'darwin', exists: () => true })('node', [], { cwd: 'rel' }))).toBe('sandbox-unavailable');
  });
  it('wraps the command in sandbox-exec -f <profile>, writable only in cwd and a fresh temp dir, and removes the temp dir', () => {
    const cwd = tmp(); const tmpRoot = tmp(); let seen;
    const runner = makeSandboxRunner({ platform: 'darwin', exists: (p) => p === SANDBOX_BIN, tmpRoot, home: '/Users/someone', nodeDir: '/n',
      exec: (cmd, args, opts) => { seen = { cmd, args, opts, profile: fs.readFileSync(args[1], 'utf8') }; return { status: 0 }; } });
    expect(runner('npx', ['vitest', 'run', 'tests/unit/x.test.mjs'], { cwd, timeoutMs: 5 })).toEqual({ status: 0 });
    expect(seen.cmd).toBe(SANDBOX_BIN);
    expect(seen.args.slice(0, 1)).toEqual(['-f']);
    expect(seen.args.slice(2)).toEqual(['npx', 'vitest', 'run', 'tests/unit/x.test.mjs']);
    const runTmp = path.dirname(seen.args[1]);
    expect(path.dirname(runTmp)).toBe(tmpRoot);
    expect(seen.profile).toContain(`(deny file-write* (require-not (require-any (subpath "${cwd}") (subpath "${runTmp}") (subpath "/dev"))))`);
    expect(seen.opts).toMatchObject({ cwd, timeoutMs: 5, env: { HOME: path.join(runTmp, 'home'), PATH: '/n:/usr/bin:/bin' } });
    expect(seen.opts.env.GH_TOKEN).toBeUndefined();
    expect(fs.existsSync(runTmp)).toBe(false);
  });
});

// A real child process through the real runner, with a synchronous exec exactly like production (makeExec uses
// spawnSync). Network is probed against a LOCAL server in its own process (no internet needed): the same request from
// outside the sandbox must succeed, so a refusal inside proves the sandbox, not a dead server.
describe.runIf(process.platform === 'darwin' && fs.existsSync(SANDBOX_BIN))('a real sandboxed run (darwin only)', () => {
  const syncExec = (cmd, args, opts) => {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: 'utf8', timeout: opts.timeoutMs });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const startServer = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', "require('node:http').createServer((q, s) => s.end('HELLO-FROM-SERVER')).listen(0, '127.0.0.1', function () { console.log(this.address().port); })"]);
    c.stdout.once('data', (d) => resolve({ child: c, url: `http://127.0.0.1:${String(d).trim()}/` }));
    c.once('error', reject);
  });
  it('cannot read a planted gh credential under HOME, cannot fetch, has no GH_TOKEN; outside the sandbox all three are possible', async () => {
    const fakeHome = tmp('autofix-fakehome-');
    const secret = path.join(fakeHome, '.config', 'gh', 'hosts.yml');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, 'github.com:\n  oauth_token: gho_PLANTED_SECRET\n');
    const cwd = tmp('autofix-wt-');
    const probe = path.join(cwd, 'probe.mjs');
    fs.writeFileSync(probe, `import fs from 'node:fs';
const out = { read: null, fetch: null, token: Object.prototype.hasOwnProperty.call(process.env, 'GH_TOKEN'), write: null };
try { out.read = fs.readFileSync(process.argv[2], 'utf8'); } catch (e) { out.read = 'DENIED:' + e.code; }
try { const r = await fetch(process.argv[3]); out.fetch = 'OK:' + (await r.text()); } catch (e) { out.fetch = 'DENIED:' + (e.cause?.code || e.message); }
try { fs.writeFileSync(process.argv[4], 'x'); out.write = 'WROTE'; } catch (e) { out.write = 'DENIED:' + e.code; }
console.log(JSON.stringify(out));
`);
    const { child: server, url } = await startServer();
    const outside = path.join(fakeHome, 'escaped.txt');
    const prev = process.env.GH_TOKEN; process.env.GH_TOKEN = 'ghp_PARENT_TOKEN';
    try {
      // control: the same probe unsandboxed reads, fetches and writes
      const ctl = JSON.parse(syncExec(process.execPath, [probe, secret, url, outside], { cwd, env: process.env, timeoutMs: 30_000 }).stdout);
      expect(ctl).toMatchObject({ read: expect.stringContaining('gho_PLANTED_SECRET'), fetch: 'OK:HELLO-FROM-SERVER', token: true, write: 'WROTE' });
      fs.rmSync(outside);
      const runner = makeSandboxRunner({ exec: syncExec, home: fakeHome, tmpRoot: tmp('autofix-runroot-') });
      const r = runner(process.execPath, [probe, secret, url, outside], { cwd, timeoutMs: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      const got = JSON.parse(r.stdout);
      expect(got.read).toMatch(/^DENIED:/);
      expect(r.stdout).not.toContain('gho_PLANTED_SECRET');
      expect(got.fetch).toMatch(/^DENIED:/);
      expect(got.token).toBe(false);
      expect(got.write).toMatch(/^DENIED:/);
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prev;
      server.kill();
    }
  }, 60_000);
});

describe('the shared install stays readable from inside a denied tree (measured 2026-10-30)', () => {
  it.runIf(process.platform === 'darwin' && fs.existsSync(SANDBOX_BIN))('a worktree whose node_modules entries link into ~/.cache/ruvnet-brain can load its packages', async () => {
    const { makeExec } = await import('../../scripts/issue-autofix-exec.mjs');
    const home = tmp('autofix-sbx-home-');
    const shared = path.join(home, '.cache', 'ruvnet-brain', 'autofix-repo', 'node_modules'); // denied by READ_DENY_HOME
    fs.mkdirSync(path.join(shared, 'leftpad'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'leftpad', 'package.json'), '{"name":"leftpad","type":"module","main":"index.js"}');
    fs.writeFileSync(path.join(shared, 'leftpad', 'index.js'), 'export default (s) => `  ${s}`;');
    const wt = path.join(home, '.cache', 'ruvnet-brain', 'issue-fix-worktrees', 'issue-1'); // also inside the denied tree
    fs.mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
    fs.symlinkSync(path.join(shared, 'leftpad'), path.join(wt, 'node_modules', 'leftpad'));
    fs.writeFileSync(path.join(wt, 'probe.mjs'), "import pad from 'leftpad'; console.log(JSON.stringify(pad('x')));");
    const run = makeSandboxRunner({ exec: makeExec({}), tmpRoot: tmp(), home });
    const r = run(process.execPath, ['probe.mjs'], { cwd: wt, timeoutMs: 60_000 });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('"  x"');
  });
});
