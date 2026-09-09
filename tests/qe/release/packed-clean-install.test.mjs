import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { extractTarball } from '../../helpers/extract-tarball.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-release-qe-'));
let packed;
let artifact;
let install;
const previousImportOnly = process.env.RUVNET_BRAIN_IMPORT_ONLY;

beforeAll(async () => {
  const sealed = process.env.RUVNET_SEALED_PACKAGE;
  if (sealed) {
    const packageManifest = JSON.parse(execFileSync('tar', ['-xOf', sealed, 'package/package.json'], { encoding: 'utf8' }));
    packed = {
      filename: path.basename(sealed),
      version: packageManifest.version,
      files: execFileSync('tar', ['-tzf', sealed], { encoding: 'utf8' })
        .trim().split('\n').map((entry) => ({ path: entry.replace(/^package\//, '').replace(/\/$/, '') })),
    };
    extractTarball(sealed, temp);
  } else {
    // Local focused runs remain self-contained. CI always supplies RUVNET_SEALED_PACKAGE,
    // making the release-QE fleet consume the single artifact later published byte-for-byte.
    const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', temp], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    packed = JSON.parse(raw.slice(raw.indexOf('[')))[0];
    extractTarball(path.join(temp, packed.filename), temp);
  }
  artifact = path.join(temp, 'package');
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  install = await import(pathToFileURL(path.join(artifact, 'bin/install.mjs')).href);
}, 180_000);

afterAll(() => {
  fs.rmSync(temp, { recursive: true, force: true });
  if (previousImportOnly === undefined) delete process.env.RUVNET_BRAIN_IMPORT_ONLY;
  else process.env.RUVNET_BRAIN_IMPORT_ONLY = previousImportOnly;
});

describe('npm artifact boundary', () => {
  it('packs one exact product version for npm, Claude Code, and Codex', () => {
    const packageManifest = JSON.parse(fs.readFileSync(path.join(artifact, 'package.json'), 'utf8'));
    const claudeManifest = JSON.parse(fs.readFileSync(path.join(artifact, 'plugin/.claude-plugin/plugin.json'), 'utf8'));
    const codexManifest = JSON.parse(fs.readFileSync(path.join(artifact, 'plugin/.codex-plugin/plugin.json'), 'utf8'));
    expect({
      packed: packed.version,
      package: packageManifest.version,
      claude: claudeManifest.version,
      codex: codexManifest.version,
    }).toEqual({
      packed: packageManifest.version,
      package: packageManifest.version,
      claude: packageManifest.version,
      codex: packageManifest.version,
    });
  });

  it('contains both host manifests, hooks, skills, updater, and MCP runtime', () => {
    const files = packed.files.map((entry) => entry.path);
    for (const required of [
      '.claude-plugin/marketplace.json',
      'plugin/.claude-plugin/plugin.json',
      'plugin/.codex-plugin/plugin.json',
      'plugin/hooks/hooks.json',
      'plugin/hooks/codex-hooks.json',
      'plugin/mcp/server.mjs',
      'plugin/mcp/managed-cli-interface.mjs',
      'plugin/scripts/runtime-preferences.mjs',
      'plugin/scripts/host-update.mjs',
      'plugin/scripts/update-apply.mjs',
      'plugin/skills/rvbc/SKILL.md',
      'console/index.html',
      'console/app.js',
      'scripts/onboarding-console.mjs',
      'scripts/nightly-controller.mjs',
    ]) expect(files).toContain(required);
  });

  it('excludes repository-local agents, commands, tests, state, and secrets', () => {
    const files = packed.files.map((entry) => entry.path);
    for (const forbidden of [
      '.agents/',
      '.claude/agents/',
      '.claude/commands/',
      '.claude/helpers/',
      '.claude/skills/',
      'plugin/test/',
      'plugin/scripts/.ruvnet-brain/',
      '.env',
      '.secrets/',
    ]) expect(files.some((file) => file.startsWith(forbidden))).toBe(false);
  });
});
describe('clean host installation from only the packed artifact', () => {
  it('exposes a coherent Claude marketplace with parseable hook declarations', () => {
    const marketplace = JSON.parse(fs.readFileSync(path.join(artifact, '.claude-plugin/marketplace.json'), 'utf8'));
    const plugin = JSON.parse(fs.readFileSync(path.join(artifact, 'plugin/.claude-plugin/plugin.json'), 'utf8'));
    const hooks = JSON.parse(fs.readFileSync(path.join(artifact, 'plugin/hooks/hooks.json'), 'utf8'));
    expect(marketplace.description).toMatch(/RuvNet Brain/i);
    expect(marketplace.plugins.some((entry) => entry.name === plugin.name)).toBe(true);
    expect(plugin).not.toHaveProperty('updated');
    expect(hooks.hooks).toBeTypeOf('object');
    expect(Object.keys(hooks.hooks).sort()).toEqual(['SessionStart', 'Stop']);
    expect(JSON.stringify(hooks.hooks)).toContain('session-start');
    expect(JSON.stringify(hooks.hooks)).toContain('continuation-gate');
    expect(fs.existsSync(path.join(artifact, 'plugin/.mcp.json'))).toBe(true);
  });

  it('wires Codex into an empty isolated host and is byte-idempotent on retry', () => {
    const home = fs.mkdtempSync(path.join(temp, 'codex-home-'));
    const codexDir = path.join(home, '.codex');
    const serverDir = path.join(home, '.claude', 'ruvnet-brain', 'mcp');
    fs.mkdirSync(codexDir, { recursive: true });

    const first = install.wireCodexHost({ codexDir, serverDir, announce: false });
    expect(first.host).toBe(true);
    expect(first.action).toBe('added');
    expect(fs.existsSync(first.serverPath)).toBe(true);
    const config = path.join(codexDir, 'config.toml');
    const before = fs.readFileSync(config);

    const retry = install.wireCodexHost({ codexDir, serverDir, announce: false });
    expect(retry.changed).toBe(false);
    expect(fs.readFileSync(config)).toEqual(before);
    expect(install.codexStatus({ codexDir, configPath: config }).wired).toBe(true);
  });

  it('ships continuity-only automatic registrations in both packed host manifests', () => {
    for (const name of ['hooks.json', 'codex-hooks.json']) {
      const document = JSON.parse(fs.readFileSync(path.join(artifact, 'plugin/hooks', name), 'utf8'));
      expect(Object.keys(document.hooks).sort()).toEqual(['SessionStart', 'Stop']);
      const commands = Object.values(document.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
      expect(commands.filter((command) => command.includes('session-start'))).toHaveLength(1);
      expect(commands.filter((command) => command.includes('continuation-gate'))).toHaveLength(1);
    }
  });

  it('persists a runnable /rvbc runtime with no source checkout', async () => {
    const kb = fs.mkdtempSync(path.join(temp, 'clean-kb-'));
    const entry = install.installConsoleRuntime(kb, artifact);
    expect(entry).toBe(path.join(kb, '.console-runtime', 'scripts', 'onboarding-console.mjs'));
    expect(fs.existsSync(path.join(kb, '.console-runtime', 'console', 'index.html'))).toBe(true);
    const consoleModule = await import(`${pathToFileURL(entry).href}?clean=${Date.now()}`);
    expect(consoleModule.gatherState).toBeTypeOf('function');
    expect(consoleModule.saveConfig).toBeTypeOf('function');
  });
});
