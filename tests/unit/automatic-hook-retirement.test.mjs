import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { npmInvocation } from '../../scripts/npm-invocation.mjs';
import { automaticHookRetirementStatus, retireManagedHookRegistrations, wireCodexHost } from '../../bin/install.mjs';
import { selfCheck } from '../../scripts/selfcheck.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-proof-')); roots.push(root); return root; };
function fixture() {
  const home = temporary();
  const codexDir = path.join(home, '.codex');
  const wrapper = path.join(home, '.cache/ruvnet-brain/codex-hook.mjs');
  const settings = path.join(home, '.claude/settings.json');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const foreign = { type: 'command', command: 'node /foreign/task.mjs' };
  fs.writeFileSync(wrapper, '// installer-owned old bridge');
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [foreign,
    { command: `node "${wrapper}"`, type: 'command' },
    { pluginId: 'ruvnet-brain@ruvnet-brain', command: 'old callback', type: 'command' }] }] } }));
  const install = () => wireCodexHost({ codexDir, serverDir: path.join(home, 'mcp'), announce: false });
  return { home, codexDir, wrapper, settings, foreign, install };
}

it('requires schema-valid empty shipped registries/contracts and canonical host pointers', () => {
  const result = automaticHookRetirementStatus(ROOT);
  expect(result.errors).toEqual([]);
  expect(result.registrations).toEqual([]);
  expect(result.ok).toBe(true);
});

it('rejects added registrations, malformed declarations and redirected pointers', () => {
  const root = temporary();
  const files = automaticHookRetirementStatus(ROOT).files;
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  const mutations = [
    ...['plugin/hooks/hooks.json', 'plugin/hooks/codex-hooks.json', '.claude/settings.json', '.codex/hooks.json']
      .map(file => [file, { hooks: { Stop: [{ hooks: [{ command: 'node retired.mjs' }] }] } }]),
    ['plugin/hooks/hooks.json', { hooks: [] }],
    ['plugin/hooks/hooks.json', { hooks: { Stop: [{}] } }],
    ['plugin/host-adapters/codex.json', { hooks: 'plugin/hooks/foreign.json' }],
  ];
  for (const [file, value] of mutations) {
    const target = path.join(root, file), original = fs.readFileSync(target);
    fs.writeFileSync(target, JSON.stringify(value));
    expect(automaticHookRetirementStatus(root).ok, file).toBe(false);
    fs.writeFileSync(target, original);
  }
});

it('actual offline host install removes owned callbacks and preserves foreign settings and MCP', () => {
  const f = fixture(), result = f.install();
  expect(result.action).toBe('added');
  expect(result.retiredHookWrapper).toBe(true);
  expect(fs.existsSync(f.wrapper)).toBe(false);
  expect(fs.existsSync(result.serverPath)).toBe(true);
  expect(fs.readFileSync(path.join(f.codexDir, 'config.toml'), 'utf8')).toContain('[mcp_servers.ruvnet-brain]');
  expect(JSON.parse(fs.readFileSync(f.settings))).toEqual({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [f.foreign] }] } });
});

it('repeated host install does not recreate callbacks or rewrite foreign settings', () => {
  const f = fixture(); f.install();
  const before = fs.readFileSync(f.settings);
  const result = f.install();
  expect(result.retiredHookWrapper).toBe(false);
  expect(result.changed).toBe(false);
  expect(fs.existsSync(f.wrapper)).toBe(false);
  expect(fs.readFileSync(f.settings)).toEqual(before);
});

it('selfcheck rejects stale registration without executing its sentinel command', async () => {
  const home = temporary();
  const installed = path.join(home, '.claude/plugins/cache/ruvnet-brain/ruvnet-brain/9.9.9');
  fs.cpSync(path.join(ROOT, 'plugin'), installed, { recursive: true });
  const sentinel = path.join(home, 'must-not-exist');
  const script = path.join(installed, 'sentinel.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'executed');`);
  fs.writeFileSync(path.join(installed, 'hooks/hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${script}"`, timeout: 5 }] }] } }));
  const result = await selfCheck({ home, security: false, installState: { repos: 1, reader: true, mcp: true } });
  expect(result.exitCode).toBe(1);
  expect(result.violations.some(v => v.kind === 'automatic-registration')).toBe(true);
  expect(result.battery.results).toEqual([]);
  expect(fs.existsSync(sentinel)).toBe(false);
});

it('malformed user settings fail closed without replacing their bytes', () => {
  const f = fixture();
  fs.writeFileSync(f.settings, '{broken user JSON');
  expect(() => retireManagedHookRegistrations({ home: f.home, codexDir: f.codexDir })).toThrow();
  expect(fs.readFileSync(f.settings, 'utf8')).toBe('{broken user JSON');
});

it('checks the real packed artifact with explicit installed scope and rejects missing shipped manifests', async () => {
  const root = temporary();
  const npm = npmInvocation(['pack', '--json', '--pack-destination', root]);
  const output = execFileSync(npm.executable, npm.args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const packed = JSON.parse(output.slice(output.indexOf('[')))[0];
  execFileSync('tar', ['-xzf', path.join(root, packed.filename), '-C', root]);
  const artifact = path.join(root, 'package');
  const { pathToFileURL } = await import('node:url');
  const installed = await import(pathToFileURL(path.join(artifact, 'bin/install.mjs')).href);
  expect(fs.existsSync(path.join(artifact, '.claude/settings.json'))).toBe(false);
  expect(fs.existsSync(path.join(artifact, '.codex/hooks.json'))).toBe(false);
  expect(installed.automaticHookRetirementStatus(artifact).ok).toBe(false);
  const result = installed.automaticHookRetirementStatus(artifact, { scope: 'installed' });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  expect(result.files).not.toContain('.claude/settings.json');
  expect(result.files).not.toContain('.codex/hooks.json');
  expect(() => installed.automaticHookRetirementStatus(artifact, { scope: 'unknown' })).toThrow(/scope/);
  for (const relative of result.files) {
    const file = path.join(artifact, relative), original = fs.readFileSync(file);
    fs.unlinkSync(file);
    expect(installed.automaticHookRetirementStatus(artifact, { scope: 'installed' }).ok, relative).toBe(false);
    fs.writeFileSync(file, original);
  }
}, 120000);
