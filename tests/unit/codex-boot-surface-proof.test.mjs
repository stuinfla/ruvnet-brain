// Issue #391 / ADR-0070 / ADR-0051: a recovered Codex host must stop reading as unconverged, but only when each changed
// boot-level path is PROVEN, and never by editing a historical receipt. Every negative case below names its reason.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as installer from '../../bin/install.mjs';
import { proveCodexBootSurface, parseChangedPaths, registeredCodexRoles, isolatedEnv } from '../../scripts/codex-boot-surface-proof.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const READY = { ok: true, state: 'fresh-declarations-ready' };
// The owner's Mac, read from ~/.cache/ruvnet-brain/host-convergence.json on 2026-10-29.
const MAC_REASON = 'boot-level declarations changed: scripts/hook-shim.mjs, skills/';
const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
const tmp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

/** Two copies of the REAL plugin tree: what Codex loaded (installed) and the release being converged to (released). */
function roots() {
  const base = tmp('cbs-');
  const copy = (name) => {
    const dest = path.join(base, name);
    fs.cpSync(path.join(ROOT, 'plugin'), dest, { recursive: true, filter: (src) => !src.startsWith(path.join(ROOT, 'plugin', 'test')) });
    return dest;
  };
  return { installed: copy('installed'), released: copy('released') };
}
const prove = (r, changedPaths, extra = {}) => proveCodexBootSurface({ changedPaths, installedPluginRoot: r.installed,
  releasedPluginRoot: r.released, declarations: READY, timeoutMs: 20_000, ...extra });
const reasonFor = (result, file) => result.unproven.find((u) => u.path === file)?.reason;

describe('proveCodexBootSurface: changed boot paths proven by byte identity plus a real process', () => {
  it('this Mac\'s change list over copied real files is boot-surface-ready, with open windows and relaunch reported honestly', async () => {
    const r = roots();
    const result = await prove(r, parseChangedPaths(MAC_REASON));
    expect(result).toMatchObject({ ok: true, state: 'boot-surface-ready', existingWindows: 'unproven', hostRelaunch: 'not-observed', inferenceRequests: 0 });
    expect(result.proven.map((p) => p.path)).toEqual(['scripts/hook-shim.mjs', 'skills/']);
    expect(result.shim).toMatchObject({ ok: true, rolesRegistered: registeredCodexRoles(path.join(r.installed, 'hooks', 'codex-hooks.json')).length });
    expect(result.shim.rolesRegistered).toBeGreaterThanOrEqual(10);
  });

  it('proves mcp/server.mjs with a real initialize + tools/list, leaves no lease, and reports that initialize launches the warm worker', async () => {
    const result = await prove(roots(), ['mcp/server.mjs']);
    expect(result).toMatchObject({ ok: true, state: 'boot-surface-ready' });
    expect(result.mcp).toMatchObject({ ok: true, leaseLeftBehind: false, exit: 0 });
    expect(result.mcp.tools).toBeGreaterThanOrEqual(1);
    // Measured from the server's own behaviour (it runs `void ensureChild()` on initialize), not assumed.
    expect(result.mcp.initializeStartsWarmWorker).toBe(true);
  });

  it('keeps it unproven, naming the file, when one byte of the installed server differs from the release', async () => {
    const r = roots();
    fs.appendFileSync(path.join(r.installed, 'mcp', 'server.mjs'), '\n// drift\n');
    const result = await prove(r, ['mcp/server.mjs', 'skills/']);
    expect(result).toMatchObject({ ok: false, state: 'boot-surface-unproven', existingWindows: 'unproven', hostRelaunch: 'not-observed' });
    expect(reasonFor(result, 'mcp/server.mjs')).toMatch(/not byte-identical/);
    expect(result.reason).toContain('mcp/server.mjs');
    expect(result.proven.map((p) => p.path)).toEqual(['skills/']);
  });

  it('keeps a path with no prover (commands/) unproven and names it', async () => {
    const result = await prove(roots(), ['skills/', 'commands/']);
    expect(result.ok).toBe(false);
    expect(reasonFor(result, 'commands/')).toMatch(/no prover/);
  });

  it('kills a hanging shim at the deadline and says so', async () => {
    const r = roots();
    for (const root of [r.installed, r.released]) fs.writeFileSync(path.join(root, 'scripts', 'hook-shim.mjs'), 'setInterval(() => {}, 1000);\n');
    const started = Date.now();
    const result = await prove(r, ['scripts/hook-shim.mjs'], { timeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(result.ok).toBe(false);
    expect(reasonFor(result, 'scripts/hook-shim.mjs')).toMatch(/did not exit within 1500 ms and was killed/);
  });

  it('on timeout the probe kills its whole process group: a grandchild the shim started does not survive', async () => {
    if (process.platform === 'win32') return;   // group kill is POSIX; Windows kills the child only (stated in the source)
    const r = roots();
    const pidFile = path.join(tmp('cbs-pid-'), 'grandchild.pid');
    const script = `import {spawn} from 'node:child_process';import fs from 'node:fs';const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});`
      + `fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1000);\n`;
    for (const root of [r.installed, r.released]) fs.writeFileSync(path.join(root, 'scripts', 'hook-shim.mjs'), script);
    const result = await prove(r, ['scripts/hook-shim.mjs'], { timeoutMs: 1500 });
    expect(result.ok).toBe(false);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(1);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 50)); } catch { alive = false; } }
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    expect(alive).toBe(false);
  });

  it('the probe env keeps the Windows needs (only when present, no secrets) and never the caller profile paths', () => {
    // sync-version-ignore: fixture env literals for isolatedEnv, not a version
    const source = { PATH: '/bin', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe', PATHEXT: '.EXE;.CMD',
      TEMP: 'C:\\Users\\real\\Temp', USERPROFILE: 'C:\\Users\\real', ANTHROPIC_API_KEY: 'secret', GITHUB_TOKEN: 'secret' };
    const env = isolatedEnv('/iso', {}, source);
    expect(env).toMatchObject({ SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe', PATHEXT: '.EXE;.CMD', PATH: '/bin', USERPROFILE: '/iso', HOME: '/iso' });
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
    expect(Object.keys(env)).not.toContain('GITHUB_TOKEN');
    expect(isolatedEnv('/iso', {}, { PATH: '/bin' })).not.toHaveProperty('SystemRoot');   // absent stays absent
    if (process.platform === 'win32') expect(env).toMatchObject({ TEMP: '/iso', TMP: '/iso' });
  });

  it('keeps the shim unproven when it does not list a registered Codex role', async () => {
    const r = roots();
    const stub = "console.error('[hook-shim] unknown hook id: \"x\" — known: session-start'); process.exit(0);\n";
    for (const root of [r.installed, r.released]) fs.writeFileSync(path.join(root, 'scripts', 'hook-shim.mjs'), stub);
    const result = await prove(r, ['scripts/hook-shim.mjs']);
    expect(reasonFor(result, 'scripts/hook-shim.mjs')).toMatch(/does not list registered Codex role\(s\): .*continuation-gate/);
  });

  it('keeps the MCP server unproven when tools/list lacks search_ruvnet', async () => {
    const r = roots();
    const fake = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',(c)=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
      if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'x',version:'1'}}:{tools:[{name:'other_tool'}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});process.stdin.on('end',()=>process.exit(0));\n`;
    for (const root of [r.installed, r.released]) fs.writeFileSync(path.join(root, 'mcp', 'server.mjs'), fake);
    const result = await prove(r, ['mcp/server.mjs']);
    expect(result.ok).toBe(false);
    expect(reasonFor(result, 'mcp/server.mjs')).toMatch(/does not include search_ruvnet/);
  });

  it('keeps skills/ and hook paths unproven when the fresh declarations are not proven, and never proves an empty list', async () => {
    const r = roots();
    const refused = await prove(r, ['skills/', 'hooks/codex-hooks.json'], { declarations: { ok: false, reason: 'Native registry reports errors or warnings' } });
    expect(refused.ok).toBe(false);
    expect(reasonFor(refused, 'skills/')).toMatch(/Native registry reports errors or warnings/);
    expect(reasonFor(refused, 'hooks/codex-hooks.json')).toMatch(/Native registry reports errors or warnings/);
    expect((await prove(r, [])).ok).toBe(false);
  });
});

describe('doctor projection reads the proof and never edits the receipt', () => {
  const receipt = () => ({ desiredVersion: VERSION, verifiedAt: '2026-10-26T11:43:50.565Z', hosts: {
    claude: { state: 'ready', version: VERSION },
    codex: { state: 'ready', version: VERSION, restartRequired: true, sessionSafety: 'restart-required', sessionSafetyReason: MAC_REASON, restartScope: 'unproven' } },
    consoleRuntime: { state: 'ready' } });
  const fresh = { ok: true, state: 'fresh-declarations-ready', expectedVersion: VERSION };
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  it('this Mac\'s receipt reads as converged for new sessions once every path is proven; the receipt hash is unchanged', async () => {
    const dir = tmp('cbr-'); const file = path.join(dir, 'host-convergence.json');
    fs.writeFileSync(file, JSON.stringify(receipt(), null, 2));
    const before = digest(file);
    const recorded = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(installer.reconcileFreshCodexDeclarations(recorded, fresh, VERSION).healthy).toBe(false); // declarations alone never clear it
    const boot = await prove(roots(), parseChangedPaths(MAC_REASON));
    const verdict = installer.reconcileFreshCodexDeclarations(recorded, fresh, VERSION, boot);
    expect(verdict).toMatchObject({ healthy: true, state: 'boot-surface-ready' });
    expect(verdict.notice).toMatch(/existing open windows remain unproven/);
    expect(digest(file)).toBe(before);
  });

  it('an unproven path keeps the historical restart refusal and puts the reason in the notice', async () => {
    const r = roots(); fs.appendFileSync(path.join(r.installed, 'mcp', 'server.mjs'), '\n// drift\n');
    const recorded = receipt(); recorded.hosts.codex.sessionSafetyReason = `${MAC_REASON.replace('skills/', 'mcp/server.mjs')}`;
    const boot = await prove(r, parseChangedPaths(recorded.hosts.codex.sessionSafetyReason));
    const verdict = installer.reconcileFreshCodexDeclarations(recorded, fresh, VERSION, boot);
    expect(verdict.healthy).toBe(false);
    expect(verdict.notice).toContain('mcp/server.mjs');
  });

  it('a proof for a different change list never clears the receipt', async () => {
    const boot = await prove(roots(), ['skills/']);
    expect(installer.reconcileFreshCodexDeclarations(receipt(), fresh, VERSION, boot).healthy).toBe(false);
  });
});

describe('--host-sync-only records a NEW receipt through convergeHostsAfterUpdate', () => {
  const converge = async ({ plugin, proveBootSurface: prover, seed, during }) => {
    const home = tmp('cbc-'); const brain = path.join(home, 'brain'); const kb = path.join(home, 'kb');
    fs.mkdirSync(kb, { recursive: true }); fs.mkdirSync(brain, { recursive: true });
    if (seed) fs.writeFileSync(path.join(brain, 'host-convergence.json'), JSON.stringify(seed));
    const proveBootSurface = during ? async (a) => { const out = await prover(a); await during({ brain }); return out; } : prover;
    const result = await installer.convergeHostsAfterUpdate(kb, { sourceRoot: ROOT, brainHome: brain, unattended: false,
      wireClaude: () => ({ host: true, wired: true, version: VERSION }),
      wireCodexHost: () => ({ host: true, wired: true, action: 'unchanged' }),
      wireCodexPlugin: () => plugin, runStableSpine: () => ({ status: 0 }),
      refreshHost: async () => ({ state: 'not-needed', changed: false }), proveBootSurface });
    return { result, brain, receipt: JSON.parse(fs.readFileSync(path.join(brain, 'host-convergence.json'), 'utf8')) };
  };
  const restartPlugin = { action: 'updated', installed: true, enabled: true, version: VERSION, restartRequired: true,
    sessionSafety: 'restart-required', sessionSafetyReason: MAC_REASON, restartScope: 'unproven' };
  const ready = async ({ changedPaths }) => ({ ok: true, state: 'boot-surface-ready', changed: changedPaths, proven: changedPaths.map((p) => ({ path: p })), unproven: [] });
  const refused = async ({ changedPaths }) => ({ ok: false, state: 'boot-surface-unproven', changed: changedPaths, proven: [], unproven: [{ path: 'skills/', reason: 'x' }], reason: 'skills/: x' });

  it('writes open-sessions and reports ok when every changed path is proven', async () => {
    const { result, receipt } = await converge({ plugin: restartPlugin, proveBootSurface: ready });
    expect(result.ok).toBe(true);
    expect(receipt.hosts.codex).toMatchObject({ restartRequired: true, restartScope: 'open-sessions',
      bootSurface: { state: 'boot-surface-ready', existingWindows: 'unproven', hostRelaunch: 'not-observed' } });
    expect(result.convergence.state).toBe('boot-surface-ready');
  });

  // #391 review: the receipt write is the sync's own file, so it takes the host-convergence lock.
  it('takes the host-convergence lock for the receipt write and releases it afterwards', async () => {
    const { result, brain } = await converge({ plugin: restartPlugin, proveBootSurface: ready });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(brain, 'host-convergence.lock'))).toBe(false);
  });

  it('does not write while another sync holds the lock, and says so', async () => {
    let held;
    const { result, receipt } = await converge({ plugin: restartPlugin, proveBootSurface: ready,
      during: ({ brain }) => { held = installer.acquireHostConvergenceLock(path.join(brain, 'host-convergence.lock')); } });
    held?.release();
    expect(held?.acquired).toBe(true);
    expect(result.bootSurfaceNotRecorded).toMatch(/lock unavailable/);
    expect(receipt.hosts.codex.restartScope).toBe('unproven');
    expect(receipt.hosts.codex.bootSurface).toBeUndefined();
  });

  it('does not overwrite a receipt a newer sync wrote while the boot surface was being proven', async () => {
    const { result, receipt } = await converge({ plugin: restartPlugin, proveBootSurface: ready,
      during: ({ brain }) => {
        const file = path.join(brain, 'host-convergence.json');
        const newer = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...newer, verifiedAt: '2099-01-01T00:00:00.000Z' }));
      } });
    expect(result.bootSurfaceNotRecorded).toMatch(/changed while/);
    expect(receipt.verifiedAt).toBe('2099-01-01T00:00:00.000Z');
    expect(receipt.hosts.codex.bootSurface).toBeUndefined();
  });

  it('stays unproven (and not ok) when any path is refused: success is never manufactured', async () => {
    const { result, receipt } = await converge({ plugin: restartPlugin, proveBootSurface: refused });
    expect(result.ok).toBe(false);
    expect(receipt.hosts.codex.restartScope).toBe('unproven');
    expect(receipt.hosts.codex.bootSurface.reason).toBe('skills/: x');
  });

  it('a repeat sync on an already-current plugin does not silently drop the previous unproven request', async () => {
    const seed = { desiredVersion: VERSION, verifiedAt: '2026-10-26T11:43:50.565Z', hosts: { claude: { state: 'ready', version: VERSION },
      codex: { state: 'ready', version: VERSION, restartRequired: true, sessionSafety: 'restart-required', sessionSafetyReason: MAC_REASON, restartScope: 'unproven' } },
      consoleRuntime: { state: 'ready' } };
    const plugin = { action: 'unchanged', installed: true, enabled: true, version: VERSION, restartRequired: false };
    const refusedRun = await converge({ plugin, proveBootSurface: refused, seed });
    expect(refusedRun.result.ok).toBe(false);
    expect(refusedRun.receipt.hosts.codex.restartScope).toBe('unproven');
    const readyRun = await converge({ plugin, proveBootSurface: ready, seed });
    expect(readyRun.result.ok).toBe(true);
    expect(readyRun.receipt.hosts.codex.restartScope).toBe('open-sessions');
    expect(readyRun.receipt.verifiedAt).not.toBe(seed.verifiedAt);
  });
});
