// rnbc-runtime-nightly.acceptance.test.mjs — the Console's Settings → Nightly switch, driven against the
// console a CUSTOMER runs: `.console-runtime`, installed by bin/install.mjs's installConsoleRuntime() from
// the bytes `npm pack` ships (RNBC independent review, 2026-10-01).
//
// Why this exists: the RNBC ledger recorded the Nightly switch PASS, but its fixture served the console
// from the repository checkout, where `bin/nightly-refresh.mjs` sits beside `bin/install.mjs`. The
// installed runtime is a COPY of CONSOLE_RUNTIME_SURFACE only, and that list omitted the runner, so every
// installed customer who switched nightly on got "nightly runner source is missing". Proven here from the
// packed tarball, through the real HTTP endpoint, with the scheduler forced into test mode (plist written
// under the fixture HOME; launchctl is a logging fake on PATH that must never be reached).
//
// Also here, on the same installed console:
//   - a save that does not CHANGE the nightly choice must not re-run the installer or rewrite the plist;
//   - the static file server must not serve a sibling directory whose name merely starts with "console".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { schedulerEntry } from './helpers/rnbc-fixture.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const LABEL = 'com.ruvnet.brain-update';
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const darwin = process.platform === 'darwin';

let fx; let server; let token;

function checked(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, ...options });
  if (r.error || r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.error?.message}`);
  return r;
}

async function freePort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** A raw GET whose path is sent exactly as written (fetch/URL would normalise `%2e%2e` away). */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
}

async function post(url, values) {
  const res = await fetch(new URL(url, server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, values }) });
  return res.json();
}

const nightlyCalls = () => (fs.existsSync(fx.callLog) ? fs.readFileSync(fx.callLog, 'utf8').split('\n').filter(Boolean) : []);
const launchctlCalls = () => (fs.existsSync(fx.launchctlLog) ? fs.readFileSync(fx.launchctlLog, 'utf8').split('\n').filter(Boolean) : []);
const plistPath = () => path.join(fx.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
function schedulerState() {
  const src = `const m = await import(${JSON.stringify(pathToFileURL(path.join(fx.runtime, 'plugin', 'scripts', 'nightly-controller.mjs')).href)});`
    + 'const s = m.nightlyStatus(); process.stdout.write(JSON.stringify({ state: s.state, evidence: s.evidence }));';
  return JSON.parse(checked(process.execPath, ['--input-type=module', '-e', src], { cwd: fx.project, env: fx.env }).stdout);
}

beforeAll(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-runtime-nightly-')));
  const home = path.join(root, 'home');
  const project = path.join(home, 'Code', 'project');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const kb = path.join(brainHome, 'kb');
  const packDir = path.join(root, 'pack');
  const fakeBin = path.join(root, 'fake-bin');
  for (const d of [project, kb, packDir, fakeBin, path.join(home, '.claude'), path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"project","private":true}\n');
  // enableNightly() refuses without the KB's self-updater; this stub is never executed (test mode).
  fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// self-updater stub (fixture) — never run\nprocess.exit(0);\n');
  const gitConfig = path.join(root, 'empty.gitconfig');
  fs.writeFileSync(gitConfig, '');

  // The bytes a customer receives: npm pack → extract → the installer's own runtime install.
  const packed = checked('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: REPO });
  checked('tar', ['-xzf', path.join(packDir, JSON.parse(packed.stdout)[0].filename), '-C', packDir]);
  const payload = path.join(packDir, 'package');
  const baseEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: process.env.TMPDIR || os.tmpdir(),
    GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
  checked(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(path.join(payload, 'bin', 'install.mjs')).href)}); m.installConsoleRuntime(${JSON.stringify(brainHome)}, ${JSON.stringify(payload)});`],
  { cwd: project, env: { ...baseEnv, RUVNET_BRAIN_IMPORT_ONLY: '1' } });
  const runtime = path.join(brainHome, '.console-runtime');

  // launchctl: a logging fake first on PATH. Test mode never calls it; any line in its log is a failure.
  const launchctlLog = path.join(root, 'launchctl.log');
  fs.writeFileSync(path.join(fakeBin, 'launchctl'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(launchctlLog)}\nexit 0\n`, { mode: 0o755 });
  // Every installer invocation that changes the scheduler, from any process, appended to one call log.
  const callLog = path.join(root, 'nightly-calls.log');
  const logger = path.join(root, 'nightly-call-logger.mjs');
  fs.writeFileSync(logger, `import fs from 'node:fs';\nconst a = process.argv.slice(1);\nif (a.some((x) => x === '--enable-nightly' || x === '--disable-nightly')) fs.appendFileSync(${JSON.stringify(callLog)}, a.join(' ') + '\\n');\n`);

  const PATH = [fakeBin, ...String(process.env.PATH || '').split(path.delimiter).filter((p) => p && !/\.npm-global/.test(p))].join(path.delimiter);
  const env = { ...baseEnv, PATH, LANG: 'en_US.UTF-8',
    NODE_OPTIONS: `--import=${pathToFileURL(logger).href}`,
    RUVNET_CONSOLE_ROOT: home, RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_SCHEDULER_TEST: '1',
    RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: kb,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1', RUVNET_TURN_CAPTURE: 'off', RUVNET_CONTINUITY_CAPTURE: 'off', RUFLO_DAEMON_AUTOSTART: '0' };
  fx = { root, home, project, brainHome, kb, payload, runtime, env, callLog, launchctlLog };

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(runtime, 'scripts', 'onboarding-console.mjs'), '--serve'],
    { cwd: project, env: { ...env, CONSOLE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
  server = { child, port, url: `http://127.0.0.1:${port}/`, output: () => output };
  const deadline = Date.now() + 60_000;
  for (;;) {
    try { const r = await fetch(new URL('/api/runtime', server.url)); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`installed console did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const html = await (await fetch(new URL('/index.html', server.url))).text();
  token = JSON.parse(/window\.__CONSOLE_TOKEN__=("[0-9a-f]+")/.exec(html)?.[1] || 'null');
  if (!token) throw new Error('no console token in the served page');
}, 300_000);

afterAll(async () => {
  if (server?.child && server.child.exitCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((r) => { server.child.once('exit', r); setTimeout(r, 5000); });
  }
  if (fx?.root) fs.rmSync(fx.root, { recursive: true, force: true });
}, 120_000);

describe('the installed Console (.console-runtime from npm pack) drives the nightly scheduler', () => {
  it('ships the nightly runner the installer copies into the scheduler, byte for byte', () => {
    const runner = path.join(fx.runtime, 'bin', 'nightly-refresh.mjs');
    expect(fs.existsSync(runner), `${runner} must exist in the installed runtime`).toBe(true);
    expect(sha(runner)).toBe(sha(path.join(fx.payload, 'bin', 'nightly-refresh.mjs')));
  });

  it('save-config {nightly:true} turns nightly ON: ok, scheduler on, plist bound to the registered runner', async () => {
    const before = nightlyCalls().length;
    const res = await post('/api/save-config', { nightly: true });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect(nightlyCalls().slice(before).filter((l) => l.includes('--enable-nightly'))).toHaveLength(1);
    expect(schedulerState().state).toBe('on');
    const registration = JSON.parse(fs.readFileSync(path.join(fx.brainHome, 'scheduler', 'registration.json'), 'utf8'));
    expect(registration).toMatchObject({ identity: LABEL, runnerSha256: sha(path.join(fx.payload, 'bin', 'nightly-refresh.mjs')) });
    expect(path.dirname(registration.runnerPath)).toBe(path.join(fx.brainHome, 'scheduler'));
    expect(sha(registration.runnerPath)).toBe(registration.runnerSha256);
    expect(registration.mode).toBe('developer-suite');
    expect(registration.updateModules['developer-update.mjs']).toBeTruthy();
    for (const [name, module] of Object.entries(registration.updateModules)) {
      expect(sha(module.path), name).toBe(module.sha256);
      expect(module.sha256, name).toBe(sha(path.join(fx.payload, 'plugin', 'scripts', name)));
    }
    // this OS's scheduler entry (plist / crontab row / task, test-mode) runs exactly the registered runner
    expect(schedulerEntry(fx).text, schedulerEntry(fx).kind).toContain(registration.runnerPath);
    if (darwin) {
      const plist = fs.readFileSync(plistPath(), 'utf8');
      expect(plist).toContain(`<string>${LABEL}</string>`);
      const argv = [.../<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
      expect(argv).toEqual([registration.nodePath, registration.runnerPath]);
      expect(fs.realpathSync(registration.nodePath)).toBe(fs.realpathSync(process.execPath));
      expect(plist).toMatch(new RegExp(`<key>RUVNET_NIGHTLY_REGISTRATION</key>\\s*<string>${path.join(fx.brainHome, 'scheduler', 'registration.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
    }
    expect(launchctlCalls(), 'test mode must never reach launchctl').toEqual([]);
  }, 120_000);

  it('a save that does not change the nightly choice does not re-run the installer or touch the scheduler', async () => {
    expect(schedulerState().state).toBe('on');
    const calls = nightlyCalls().length;
    const reg = path.join(fx.brainHome, 'scheduler', 'registration.json');
    const regStat = fs.statSync(reg, { bigint: true });
    const artifact = schedulerEntry(fx).file;
    const artStat = fs.statSync(artifact, { bigint: true });
    const artBytes = fs.readFileSync(artifact, 'utf8');
    // Exactly what the page posts when the person changes only the model house: the already-chosen
    // nightly value travels with it.
    const res = await post('/api/save-config', { provider: 'codex', nightly: true });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect(nightlyCalls().slice(calls), 'no installer --enable-nightly for an unchanged choice').toEqual([]);
    expect(fs.statSync(reg, { bigint: true }).mtimeNs).toBe(regStat.mtimeNs);
    expect(fs.statSync(artifact, { bigint: true }).mtimeNs, schedulerEntry(fx).kind).toBe(artStat.mtimeNs);
    expect(fs.readFileSync(artifact, 'utf8')).toBe(artBytes);
    const cfg = JSON.parse(fs.readFileSync(path.join(fx.home, '.claude', 'ruvnet-brain', 'config.json'), 'utf8'));
    expect(cfg).toMatchObject({ provider: 'codex', nightly: true });
    expect(schedulerState().state).toBe('on');
  }, 120_000);

  it('save-config {nightly:false} turns it OFF through the installer; an unchanged OFF is not re-applied', async () => {
    let calls = nightlyCalls().length;
    const off = await post('/api/save-config', { nightly: false });
    expect(off, JSON.stringify(off)).toMatchObject({ ok: true });
    expect(nightlyCalls().slice(calls).filter((l) => l.includes('--disable-nightly'))).toHaveLength(1);
    expect(schedulerState().state).toBe('off');
    expect(schedulerEntry(fx).text, schedulerEntry(fx).kind).toBeNull();
    calls = nightlyCalls().length;
    const again = await post('/api/save-config', { provider: 'openai', nightly: false });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    expect(nightlyCalls().slice(calls)).toEqual([]);
    expect(launchctlCalls()).toEqual([]);
  }, 120_000);

  it('serves console/ files and never a sibling directory whose name starts with "console"', async () => {
    const leakDir = path.join(fx.runtime, 'console-leak');
    fs.mkdirSync(leakDir, { recursive: true });
    fs.writeFileSync(path.join(leakDir, 'secret.txt'), 'outside-the-console-dir');
    expect((await rawGet(server.port, '/style.css')).status).toBe(200);
    for (const p of ['/%2e%2e/console-leak/secret.txt', '/..%2fconsole-leak%2fsecret.txt', '/%2e%2e%2fconsole-leak%2fsecret.txt']) {
      const r = await rawGet(server.port, p);
      expect(r.body, p).not.toContain('outside-the-console-dir');
      expect(r.status, p).toBe(404);
    }
  });
});
