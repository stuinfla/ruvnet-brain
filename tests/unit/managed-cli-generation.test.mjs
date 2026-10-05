import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManagedCliDispatcher } from '../../plugin/mcp/managed-cli-generation.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-generation-'))); roots.push(root);
  const home = path.join(root, 'home'); const brain = path.join(root, 'brain');
  const shell = path.join(home, '.claude', 'ruvnet-brain');
  fs.mkdirSync(shell, { recursive: true }); fs.mkdirSync(brain, { recursive: true });
  return { home, brain, shell, env: { ...process.env, HOME: home, RUVNET_BRAIN_HOME: brain, RUVNET_BRAIN_PROJECT_DIR: home } };
}
function stage(fx, version) {
  const root = path.join(fx.brain, 'versions', version);
  fs.cpSync(path.resolve(import.meta.dirname, '../../plugin'), root, { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'ruvnet-brain', version }));
  const handler = path.join(root, 'mcp/managed-cli-interface.mjs');
  fs.writeFileSync(handler, fs.readFileSync(handler, 'utf8').replace('export async function callManagedCli(', 'async function originalCall(')
    + `\nexport async function callManagedCli(...args) { return { ...await originalCall(...args), fixtureGeneration: '${version}' }; }\n`);
  return root;
}
function activate(fx, version, generation = 1, codeRoot = `versions/${version}`) {
  fs.writeFileSync(path.join(fx.brain, 'active.json'), JSON.stringify({ version, generation, codeRoot }));
}
const args = { executable: 'ruflo', argv: ['status'] };
function binary(fx) {
  const bin = path.join(fx.home, '.npm-global/bin'); fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'ruflo.cmd' : 'ruflo');
  fs.writeFileSync(executable, process.platform === 'win32' ? '@echo ok\r\n' : '#!/bin/sh\nprintf "ok\\n"\n', { mode: 0o755 });
}

describe('active managed generation boundary (#384)', () => {
  it('uses active code for help, registry and run and refuses stamps from the previous generation', async () => {
    const fx = fixture(); binary(fx); stage(fx, '4.5.6'); stage(fx, '4.5.7'); activate(fx, '4.5.6');
    const call = createManagedCliDispatcher({ fallbackRoot: fx.shell });
    const lifecycle = { capture: () => ({ adopted: false }) };
    const helped = await call('ruvnet_cli_help', args, fx.env); expect(helped).toMatchObject({ isError: false, fixtureGeneration: '4.5.6' });
    const stamp = path.join(fx.brain, 'help-read/ruflo.status'); const previous = fs.readFileSync(stamp, 'utf8');
    const ran = await call('ruvnet_cli_run', args, fx.env, undefined, lifecycle); expect(ran).toMatchObject({ isError: false, fixtureGeneration: '4.5.6' });
    activate(fx, '4.5.7', 2);
    const refused = await call('ruvnet_cli_run', args, fx.env, undefined, lifecycle);
    expect(refused).toMatchObject({ isError: true, fixtureGeneration: '4.5.7' }); expect(refused.content[0].text).toMatch(/read the interface first/i);
    expect((await call('ruvnet_cli_help', args, fx.env)).fixtureGeneration).toBe('4.5.7');
    expect(fs.readFileSync(stamp, 'utf8')).not.toBe(previous);
    expect(await call('ruvnet_cli_run', args, fx.env, undefined, lifecycle)).toMatchObject({ isError: false, fixtureGeneration: '4.5.7' });
    const fetch = async () => ({ ok: true, text: async () => '{"version":"3.0.0"}' });
    expect(await call('ruvnet_registry_latest', args, fx.env, fetch)).toMatchObject({ isError: false, fixtureGeneration: '4.5.7' });
    // A descriptor promotion changes authorization even if its code root/version remains the same.
    activate(fx, '4.5.7', 3);
    expect((await call('ruvnet_cli_run', args, fx.env, undefined, lifecycle)).isError).toBe(true);
  });

  it('fails closed for missing or malformed active state, escaping roots and manifest mismatch', async () => {
    const fx = fixture(); const root = stage(fx, '4.5.6');
    const call = createManagedCliDispatcher({ fallbackRoot: fx.shell });
    expect((await call('ruvnet_cli_help', args, fx.env)).isError).toBe(true);
    for (const value of ['{', '{}', JSON.stringify({ version: '4.5.6', generation: 1, codeRoot: '../../outside' })]) {
      fs.writeFileSync(path.join(fx.brain, 'active.json'), value);
      expect((await call('ruvnet_cli_help', args, fx.env)).isError).toBe(true);
    }
    activate(fx, '4.5.6');
    for (const manifest of [{ name: 'foreign', version: '4.5.6' }, { name: 'ruvnet-brain', version: '4.5.7' }]) {
      fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify(manifest));
      expect((await call('ruvnet_cli_help', args, fx.env)).content[0].text).toMatch(/manifest name\/version mismatch/);
    }
    fs.writeFileSync(path.join(root, '.claude-plugin/plugin.json'), '{"name":"ruvnet-brain","version":"4.5.6"}');
    const handler = path.join(root, 'mcp/managed-cli-interface.mjs'); fs.unlinkSync(handler);
    fs.symlinkSync(path.resolve(import.meta.dirname, '../../plugin/mcp/managed-cli-interface.mjs'), handler);
    expect((await call('ruvnet_cli_help', args, fx.env)).content[0].text).toMatch(/contained regular file/);
  });

  it('protects one selected generation during a concurrent promotion and rejects same-path mutations', async () => {
    const fx = fixture(); const root = stage(fx, '4.5.6'); stage(fx, '4.5.7'); activate(fx, '4.5.6');
    let release; let imported; const entered = new Promise((resolve) => { imported = resolve; });
    const call = createManagedCliDispatcher({ fallbackRoot: fx.shell, importModule: async (url) => {
      imported(url); await new Promise((resolve) => { release = resolve; });
      return { callManagedCli: async () => ({ isError: false }) };
    } });
    const inFlight = call('ruvnet_cli_help', args, fx.env);
    expect(await entered).toContain('/versions/4.5.6/');
    const leases = path.join(fx.brain, 'leases'); const files = fs.readdirSync(leases);
    expect(files).toHaveLength(1); expect(JSON.parse(fs.readFileSync(path.join(leases, files[0]), 'utf8')).version).toBe('4.5.6');
    activate(fx, '4.5.7', 2); release(); expect((await inFlight).isError).toBe(false); expect(fs.readdirSync(leases)).toEqual([]);
    activate(fx, '4.5.6', 3); fs.appendFileSync(path.join(root, 'mcp/managed-cli-interface.mjs'), '\n// altered immutable code\n');
    expect((await call('ruvnet_cli_help', args, fx.env)).content[0].text).toMatch(/immutable generation changed/);
  });

  it('never takes a generation path or authorization stamp from client arguments', async () => {
    const fx = fixture(); binary(fx); stage(fx, '4.5.6'); activate(fx, '4.5.6');
    const call = createManagedCliDispatcher({ fallbackRoot: fx.shell });
    fs.mkdirSync(path.join(fx.brain, 'help-read'), { recursive: true });
    fs.writeFileSync(path.join(fx.brain, 'help-read/ruflo.status'), '');
    expect((await call('ruvnet_cli_run', { ...args, generationBinding: 'forged', codeRoot: '/arbitrary' }, fx.env)).isError).toBe(true);
    expect((await call('ruvnet_cli_help', { executable: 'ruflo', argv: ['--unsupported'] }, fx.env)).isError).toBe(true);
  });
});
