// npm-tarball-codex.test.mjs — the npm artifact IS the product (issue #43, Henrik Pettersen).
//
// WHAT THIS PROTECTS. The 3.9.75-dev tarball shipped 20 files and not plugin/mcp/server.mjs, while
// bin/install.mjs resolves the Codex server from exactly that package-relative path. Every test in
// codex-wiring.test.mjs passed, because every one ran against the SOURCE CHECKOUT — the one place
// the file always exists. The wiring worked from a repo/marketplace clone and returned `no-source`
// on every npm install, which is where the fix was aimed in the first place.
//
// So this suite refuses the checkout: it runs `npm pack`, unpacks the real tarball, and exercises
// the installer FROM THE UNPACKED ARTIFACT with its default package-relative source resolution.
// A test that can borrow files from the source tree cannot catch a packaging hole; this one cannot
// borrow anything.
//
// It also proves the atomicity half of #43: an interrupted server copy or config write must leave
// the PREVIOUS bytes intact — a torn server.mjs at a path an existing config already names means
// Codex spawns half a file. The injection is a DIRECTORY squatting on the deterministic
// `.tmp-<pid>` write-beside path, which makes the temp write throw on every OS (no chmod — a
// no-op on win32 directories, one of this repo's six documented Windows failure clusters). Both
// failure-injection tests fail against the pre-fix code (plain copyFileSync/writeFileSync went
// straight to the final path, never touching `.tmp-`, and succeeded), so this guard demonstrably
// CAN fail on broken code.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const madeTmp = [];
const tmpdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-tarball-codex-')); madeTmp.push(d); return d; };
afterAll(() => { for (const d of madeTmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp reaper's problem */ } } });

let packed;          // npm pack --json entry: { filename, files: [{path, ...}], ... }
let unpackedRoot;    // <tmp>/package — the tarball's content, and nothing else
let wireCodexHost, codexStatus; // imported from the UNPACKED bin/install.mjs, never the checkout

beforeAll(() => {
  const dest = tmpdir();
  // Windows cannot execFile npm's .cmd shim without a shell (CVE-2024-27980 hardening); the
  // paths involved are runner-controlled tmp dirs, not user input.
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
  });
  packed = JSON.parse(out.slice(out.indexOf('[')))[0];
  // tar ships in System32 on the Windows runners, so this one spawns directly everywhere.
  execFileSync('tar', ['-xzf', path.join(dest, packed.filename), '-C', dest]);
  unpackedRoot = path.join(dest, 'package');
}, 180_000);

beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  ({ wireCodexHost, codexStatus } = await import(pathToFileURL(path.join(unpackedRoot, 'bin', 'install.mjs')).href));
}, 30_000);

// A wired temp home: codex host present, config carrying a user section that must survive.
const USER_CONFIG = '[shell_environment_policy]\ninherit = "core"\n';
function isolatedHome() {
  const home = tmpdir();
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), USER_CONFIG);
  return { home, codexDir, configPath: path.join(codexDir, 'config.toml'), serverDir: path.join(home, '.claude', 'ruvnet-brain', 'mcp') };
}

// ── the tarball manifest: only the two persistent Codex host files ship from plugin/ ─────────────
describe('the published artifact carries a complete persistent Codex marketplace', () => {
  it('plugin/mcp/server.mjs is in the tarball', () => {
    expect(packed.files.map((f) => f.path)).toContain('plugin/mcp/server.mjs');
    expect(packed.files.map((f) => f.path)).toContain('plugin/mcp/managed-cli-interface.mjs');
  });

  it('ships runtime assets without generated state or test fixtures', () => {
    const pluginFiles = packed.files.map((f) => f.path).filter((p) => p.startsWith('plugin/'));
    for (const required of [
      'plugin/.claude-plugin/plugin.json',
      'plugin/.codex-plugin/plugin.json',
      'plugin/hooks/codex-hooks.json',
      'plugin/mcp/managed-cli-interface.mjs',
      'plugin/mcp/server.mjs',
      'plugin/scripts/codex-hook-wrapper.mjs',
      'plugin/scripts/host-update.mjs',
      'plugin/scripts/update-apply.mjs',
      'plugin/skills/rvbc/SKILL.md',
    ]) expect(pluginFiles).toContain(required);
    expect(pluginFiles.some((file) => file.includes('/.ruvnet-brain/'))).toBe(false);
    expect(pluginFiles.some((file) => file.startsWith('plugin/test/'))).toBe(false);
  });

  it('the packed server is byte-identical to the source of truth', () => {
    const shippedBytes = fs.readFileSync(path.join(unpackedRoot, 'plugin', 'mcp', 'server.mjs'), 'utf8');
    expect(shippedBytes).toBe(fs.readFileSync(path.join(ROOT, 'plugin', 'mcp', 'server.mjs'), 'utf8'));
    const interfaceBytes = fs.readFileSync(path.join(unpackedRoot, 'plugin', 'mcp', 'managed-cli-interface.mjs'), 'utf8');
    expect(interfaceBytes).toBe(fs.readFileSync(path.join(ROOT, 'plugin', 'mcp', 'managed-cli-interface.mjs'), 'utf8'));
  });
});

// ── the installer, run from the unpacked artifact with DEFAULT source resolution ─────────────────
describe('wireCodexHost from the unpacked tarball — the exact path issue #43 proved dead', () => {
  it('ships the host-neutral update coordinator in the published artifact', () => {
    expect(fs.existsSync(path.join(unpackedRoot, 'plugin', 'scripts', 'host-update.mjs'))).toBe(true);
  });
  it('wires (never `no-source`), and a rerun is an idempotent no-op', () => {
    const { codexDir, configPath, serverDir } = isolatedHome();
    // No `source:` override — this exercises path.join(__dirname, '..', 'plugin', 'mcp', 'server.mjs')
    // relative to the UNPACKED package, which is what every npm install resolves.
    const r1 = wireCodexHost({ codexDir, serverDir, announce: false });
    expect(r1.action).toBe('added');
    expect(fs.existsSync(r1.serverPath)).toBe(true);
    expect(fs.existsSync(path.join(serverDir, 'managed-cli-interface.mjs'))).toBe(true);
    expect(fs.existsSync(r1.runtimePreferencesPath)).toBe(true);
    expect(codexStatus({ codexDir, configPath })).toMatchObject({ host: true, wired: true });

    const bytes1 = fs.readFileSync(configPath, 'utf8');
    expect(bytes1).toContain(USER_CONFIG.trim()); // the user's section survived
    const r2 = wireCodexHost({ codexDir, serverDir, announce: false });
    expect(r2.action).toBe('rewritten');
    expect(r2.changed).toBe(false);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(bytes1);
  });

  it('leaves no .tmp- litter behind on the success path', () => {
    const { codexDir, serverDir } = isolatedHome();
    wireCodexHost({ codexDir, serverDir, announce: false });
    const litter = [...fs.readdirSync(codexDir), ...fs.readdirSync(serverDir)].filter((f) => f.includes('.tmp-'));
    expect(litter).toEqual([]);
  });
});

// ── the installed server speaks real MCP (issue #43 acceptance, verbatim) ────────────────────────
describe('the installed server completes initialize and tools/list', () => {
  it('serves search_ruvnet: required string `query`, optional integer `k`', async () => {
    const { codexDir, serverDir } = isolatedHome();
    const { serverPath } = wireCodexHost({ codexDir, serverDir, announce: false });

    // An empty RUVNET_BRAIN_HOME = no brain bundle: the shell must still complete the protocol
    // itself (its whole design point) and declare the tool from its static fallback. KB overrides
    // are scrubbed too — on a dev box with a real brain installed, an inherited RUVNET_BRAIN_KB
    // would spawn the actual embedder child and turn this into a cold-load flake.
    const env = { ...process.env, RUVNET_BRAIN_HOME: tmpdir() };
    delete env.RUVNET_BRAIN_KB;
    delete env.KB_DIR;
    const proc = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'ignore'], env });
    const replies = new Map();
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try { const m = JSON.parse(line); replies.get(m.id)?.(m); } catch { /* not a frame */ }
      }
    });
    const request = (id, method, params = {}) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${method} in 15s`)), 15_000);
      replies.set(id, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    try {
      const init = await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'issue-43-acceptance', version: '0' } });
      expect(init.result?.serverInfo?.name).toBe('ruvnet-brain');
      expect(init.result?.capabilities?.tools).toBeTruthy();

      const list = await request(2, 'tools/list');
      const tool = list.result?.tools?.find((t) => t.name === 'search_ruvnet');
      expect(tool, 'search_ruvnet must be advertised').toBeTruthy();
      expect(tool.inputSchema.required).toEqual(['query']);
      expect(tool.inputSchema.properties.query.type).toBe('string');
      expect(tool.inputSchema.properties.k.type).toBe('integer');
      // The protocol shell owns discovery; worker availability is decided only on call.
      expect(tool.description).toMatch(/first call may wait/i);
    } finally {
      proc.kill('SIGTERM');
    }
  }, 30_000);
});

// ── failure injection: an interrupted write preserves the previous install ───────────────────────
// The write-beside temp path is deterministic (`<target>.tmp-<pid>`, same process as this test), so
// squatting a DIRECTORY on it makes the temp write throw on every platform — the cross-platform
// stand-in for "the copy died partway".
describe('a failed write leaves the prior server and config byte-intact', () => {
  it('config write failure: the old registration survives untouched', () => {
    const { home, codexDir, configPath, serverDir } = isolatedHome();
    const r1 = wireCodexHost({ codexDir, serverDir, announce: false });
    const goodConfig = fs.readFileSync(configPath, 'utf8');
    const goodServer = fs.readFileSync(r1.serverPath, 'utf8');

    // A NEW serverDir changes the registered path, forcing a config rewrite; the blocked temp path
    // makes that rewrite fail BEFORE rename. The PRE-FIX code passes this spot silently — its
    // writeFileSync went straight to config.toml and never touched `.tmp-`.
    const squat = `${fs.realpathSync(configPath)}.tmp-${process.pid}`;
    fs.mkdirSync(squat, { recursive: true });
    expect(() => wireCodexHost({ codexDir, serverDir: path.join(home, 'moved-mcp'), announce: false })).toThrow();

    expect(fs.readFileSync(configPath, 'utf8')).toBe(goodConfig);
    expect(fs.readFileSync(r1.serverPath, 'utf8')).toBe(goodServer);
    expect(codexStatus({ codexDir, configPath }).wired).toBe(true); // still points at a real file
    // The failure path must also clean its own temp — a leftover .tmp- would wedge every future
    // install of this pid. (This assertion fails if rmSync ever loses `recursive`.)
    expect(fs.existsSync(squat)).toBe(false);
  });

  it('server copy failure: the old server bytes survive untouched', () => {
    const { codexDir, configPath, serverDir } = isolatedHome();
    const r1 = wireCodexHost({ codexDir, serverDir, announce: false });
    const goodConfig = fs.readFileSync(configPath, 'utf8');
    const goodServer = fs.readFileSync(r1.serverPath, 'utf8');

    // Blocked temp path: the copy throws BEFORE any byte of the live server.mjs changes. The
    // PRE-FIX copyFileSync wrote straight over the existing file and succeeded — this test fails
    // on that code, which is the point.
    const squat = `${fs.realpathSync(r1.serverPath)}.tmp-${process.pid}`;
    fs.mkdirSync(squat, { recursive: true });
    expect(() => wireCodexHost({ codexDir, serverDir, announce: false })).toThrow();

    expect(fs.readFileSync(r1.serverPath, 'utf8')).toBe(goodServer);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(goodConfig);
    expect(codexStatus({ codexDir, configPath }).wired).toBe(true);
    expect(fs.existsSync(squat)).toBe(false); // failure cleanup ran (guards `recursive: true`)
  });
});
