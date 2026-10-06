import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { classifyFreshCodexDeclarations, probeFreshCodexDeclarations } from '../../scripts/codex-fresh-host-proof.mjs';
import { codexHookHash, codexHookIdentities } from '../../scripts/codex-hook-trust.mjs';
import { hostSynchronizationFailureMessage, reconcileFreshCodexDeclarations } from '../../bin/install.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url))).version;
const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb391-'))); temps.push(dir);
  const codexHome = path.join(dir, 'codex'); const root = path.join(codexHome, 'plugins/cache/ruvnet-brain/ruvnet-brain', VERSION);
  const releasedPluginRoot = path.join(dir, 'released');
  const hooks = { hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node body.mjs', timeout: 8 }] }] } };
  const manifest = { name: 'ruvnet-brain', version: VERSION };
  const hashes = {};
  for (const [file, value] of [['.codex-plugin/plugin.json', manifest], ['hooks/codex-hooks.json', hooks]]) {
    const bytes = Buffer.from(JSON.stringify(value)); hashes[file] = sha(bytes);
    for (const base of [root, releasedPluginRoot]) { const target = path.join(base, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
  }
  const key = [...codexHookIdentities(hooks).keys()][0];
  const row = { key, currentHash: codexHookHash('SessionStart', hooks.hooks.SessionStart[0], hooks.hooks.SessionStart[0].hooks[0]),
    eventName: 'sessionStart', matcher: 'startup|resume', handlerType: 'command', command: 'node body.mjs', timeoutSec: 8,
    async: false, source: 'plugin', sourcePath: path.join(root, 'hooks/codex-hooks.json'), enabled: true, trustStatus: 'trusted', pluginId: 'ruvnet-brain@ruvnet-brain' };
  const binary = path.join(dir, 'codex-native'); fs.writeFileSync(binary, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o700 });
  return { root, target: { hooks, manifest, hashes }, plugin: { installed: true, enabled: true, version: VERSION, pluginId: 'ruvnet-brain@ruvnet-brain' },
    listed: { data: [{ cwd: dir, hooks: [row], errors: [], warnings: [] }] }, expectedVersion: VERSION, codexHome, cwd: dir, releasedPluginRoot, binary,
    publishedIdentity: { state: 'verified', releaseIdentity: { version: VERSION, hooksSha256: hashes['hooks/codex-hooks.json'] } } };
}
function backend(f, mode) {
  const children = []; let count = 0;
  const spawnChild = (_binary, args) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: ++count, exitCode: null, signalCode: null });
    child.unref = () => { child.unreferenced = true; };
    child.kill = (signal) => { if (mode === 'kill-no-exit') return false; child.signalCode = signal; child.emit('exit', null, signal); return true; }; children.push(child);
    if (args[0] === 'app-server') child.stdin.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line); if (!request.id || mode === 'hang') continue;
        let result = request.method === 'initialize' ? {} : structuredClone(f.listed);
        if (mode === 'registry-race' && request.id === 3) result.data[0].warnings.push('new warning');
        queueMicrotask(() => child.stdout.write(mode === 'malformed' ? 'invalid\n' : `${JSON.stringify({ id: request.id, result })}\n`));
      }
    });
    else queueMicrotask(() => {
      child.stdout.write(args[0] === '--version' ? 'codex-cli 0.160.0\n' : JSON.stringify({ installed: [f.plugin] }));
      child.exitCode = 0; child.emit('exit', 0);
    });
    return child;
  };
  return { spawnChild, children };
}
describe('native fresh declarations are source bound and narrowly scoped', () => {
  it('accepts the observed native inventory without an installPath and retires only its owned child', async () => {
    const f = fixture(); const b = backend(f); const result = await probeFreshCodexDeclarations({ ...f, spawnChild: b.spawnChild });
    expect(result).toMatchObject({ ok: true, state: 'fresh-declarations-ready', hookBodiesExecuted: false, mcpReadiness: 'unknown', existingWindows: 'unproven', inferenceRequests: 0 });
    expect(b.children.filter((c) => c.signalCode)).toHaveLength(1);
  });
  it('requires an independently released hook hash, not a self-consistent editable manifest', async () => {
    const f = fixture(); f.publishedIdentity.releaseIdentity.hooksSha256 = '0'.repeat(64); const b = backend(f);
    expect(await probeFreshCodexDeclarations({ ...f, spawnChild: b.spawnChild })).toMatchObject({ ok: false }); expect(b.children).toHaveLength(0);
  });
  for (const mutate of [
    (f) => { f.plugin.version = '0.0.1'; },
    (f) => { f.listed.data[0].hooks[0].trustStatus = 'modified'; },
    (f) => { f.listed.data[0].hooks[0].enabled = false; },
    (f) => { f.listed.data[0].hooks.push(f.listed.data[0].hooks[0]); },
    (f) => { f.listed.data[0].hooks[0].command = 'node edited.mjs'; },
    (f) => { f.listed.data[0].warnings.push('foreign registry warning'); },
    (f) => { f.listed.data[0].cwd = '/other'; },
    (f) => { f.plugin.installPath = f.releasedPluginRoot; },
    (f) => { fs.writeFileSync(path.join(f.root, 'hooks/codex-hooks.json'), '{}'); },
  ]) it('refuses stale, untrusted, unexpected, edited, or wrong-scope metadata', () => {
    const f = fixture(); mutate(f); expect(classifyFreshCodexDeclarations(f).ok).toBe(false);
  });
  it('preserves unrelated owner hooks instead of rejecting their presence', () => {
    const f = fixture(); f.listed.data[0].hooks.push({ pluginId: 'owner@local', key: 'owner-key' }); expect(classifyFreshCodexDeclarations(f).ok).toBe(true);
  });
  for (const mode of ['hang', 'malformed', 'registry-race']) it(`fails closed and cleans owned children for ${mode}`, async () => {
    const f = fixture(); const b = backend(f, mode);
    expect((await probeFreshCodexDeclarations({ ...f, spawnChild: b.spawnChild, timeoutMs: 100 })).ok).toBe(false);
    expect(b.children.filter((c) => c.signalCode)).toHaveLength(1);
  });
  it('does not hang or accept proof when an owned child refuses termination and never exits', async () => {
    const f = fixture(); const b = backend(f, 'kill-no-exit'); const started = Date.now();
    expect(await probeFreshCodexDeclarations({ ...f, spawnChild: b.spawnChild, timeoutMs: 100 })).toMatchObject({ ok: false, reason: 'Owned native proof child retirement is unverified' });
    expect(Date.now() - started).toBeLessThan(500);
    const owned = b.children.find((c) => c.unreferenced);
    expect(owned).toBeDefined();
    expect(owned.stdin.destroyed && owned.stdout.destroyed && owned.stderr.destroyed).toBe(true);
    expect(b.children.filter((c) => c.unreferenced)).toHaveLength(1);
  });
  it('cannot clear executable or MCP restart gaps from declarations', () => {
    const f = fixture(); const proof = classifyFreshCodexDeclarations(f);
    const recorded = { desiredVersion: VERSION, hosts: { codex: { state: 'ready', version: VERSION, restartRequired: true, restartScope: 'unproven', sessionSafetyReason: 'boot-level declarations changed: scripts/hook-shim.mjs, mcp/server.mjs' } }, consoleRuntime: { state: 'ready' } };
    const bytes = JSON.stringify(recorded); expect(reconcileFreshCodexDeclarations(recorded, proof)).toMatchObject({ healthy: false, state: 'host-restart-required' }); expect(JSON.stringify(recorded)).toBe(bytes);
  });
});
describe('host failure does not imply a runtime rollback', () => {
  it('reports the activated generation even when host convergence failed', () => {
    expect(hostSynchronizationFailureMessage({ error: 'restart required' }, { version: VERSION, generation: 38, codeRoot: `versions/${VERSION}` })).toBe(`host synchronization is incomplete — runtime ${VERSION} generation 38 is active (restart required)`);
  });
  for (const active of [null, { version: '0.0.1', generation: 38, codeRoot: 'versions/0.0.1' }, { version: VERSION, generation: 38, codeRoot: '/edited/path' }]) it('reports unknown activation without inventing retention or rollback', () => {
    expect(hostSynchronizationFailureMessage({}, active)).toContain('active runtime generation could not be verified');
    expect(hostSynchronizationFailureMessage({}, active)).not.toContain('prior verified generation');
  });
});


describe('native administrative lifecycle probe', () => {
  it('uses configured native hooks transport, preserves explicit overrides, and fails closed on invalid configuration', () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'native-doctor-probe-'));
    try {
      const brain = path.join(home, 'brain'), config = path.join(brain, 'model-routing', 'terminal-launcher-config.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      const preload = path.join(home, 'protocol.mjs');
      fs.writeFileSync(preload, `import path from 'node:path'; if (path.basename(process.argv[1] || '') === 'app-server') {
        await new Promise(resolve => {
          let buffer = '';
          process.stdin.on('data', chunk => {
            buffer += chunk;
            let at;
            while ((at = buffer.indexOf('\\n')) >= 0) {
              const row = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
              if (row.id === 1) process.stdout.write(JSON.stringify({id:1,result:{}}) + '\\n');
              if (row.id === 2) { process.stdout.write(JSON.stringify({id:2,result:{data:[]}}) + '\\n'); resolve(); }
            }
          });
        });
        process.exit(0);
      }`);
      const script = `process.env.RUVNET_BRAIN_IMPORT_ONLY='1';
        const {codexLifecycleStatus}=await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'bin/install.mjs')).href)});
        const options={runJson:()=>({ok:true,value:{installed:[{pluginId:'ruvnet-brain@ruvnet-brain',installed:true,enabled:true}]}}),codexHome:${JSON.stringify(home)},timeoutMs:1500};
        if(process.env.EXPLICIT_PROBE) options.codexBin=process.env.EXPLICIT_PROBE;
        console.log(JSON.stringify(await codexLifecycleStatus(options)));`;
      const missing = path.join(home, 'absent-native');
      const run = (extra = {}) => {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8', timeout: 5000,
          env: { ...process.env, RUVNET_BRAIN_HOME: brain, CODEX_BIN: '', EXPLICIT_PROBE: '',
            PATH: home, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, ...extra },
        });
        expect(result.status).toBe(0); return JSON.parse(result.stdout);
      };
      fs.writeFileSync(config, JSON.stringify({realCodex:process.execPath}));
      expect(run().state).toBe('inactive-by-design');
      expect(run({EXPLICIT_PROBE:missing}).state).toBe('probe-failed');
      expect(run({CODEX_BIN:missing}).state).toBe('probe-failed');
      for (const value of ['{malformed', JSON.stringify({realCodex:'relative-native'})]) {
        fs.writeFileSync(config, value); expect(run().state).toBe('probe-failed');
      }
      fs.unlinkSync(config); expect(run().state).toBe('probe-failed');
    } finally { fs.rmSync(home, {recursive:true,force:true}); }
  });
});
