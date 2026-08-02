import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PLUGIN = path.join(ROOT, 'plugin');
const CODEX = process.env.RUVNET_CODEX_BIN || 'codex';
let wireCodexPlugin;

beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  ({ wireCodexPlugin } = await import('../../bin/install.mjs'));
});

function run(home, args) {
  return spawnSync(CODEX, args, {
    cwd: ROOT,
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

describe('installed Codex skill discovery', () => {
  const available = spawnSync(CODEX, ['--version'], { encoding: 'utf8' }).status === 0;
  const test = available ? it : it.skip;

  test('exposes self-contained native Console and What is New skills through the real plugin loader', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-codex-skills-'));
    try {
      const market = run(home, ['plugin', 'marketplace', 'add', PLUGIN, '--json']);
      expect(market.status, market.stderr || market.stdout).toBe(0);
      const install = run(home, ['plugin', 'add', 'ruvnet-brain@ruvnet-brain', '--json']);
      expect(install.status, install.stderr || install.stdout).toBe(0);

      const prompt = run(home, ['debug', 'prompt-input', 'List available Brain skills only.']);
      expect(prompt.status, prompt.stderr || prompt.stdout).toBe(0);
      const rendered = prompt.stdout;

      expect(rendered).toContain('ruvnet-brain:rvbc');
      expect(rendered).toContain('ruvnet-brain:brain-console');
      expect(rendered).toContain('ruvnet-brain:whats-new');
      expect(rendered).toContain('Configure RuvNet Brain');
      expect(rendered).not.toMatch(
        /source-command-(?:brain-console|rvcb)[\s\S]{0,1600}rvbc\.md[\s\S]{0,120}same directory/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test.each(['missing', 'malformed'])(
    'repairs a %s Brain-owned marketplace snapshot before Codex reads plugin state',
    (snapshotState) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-codex-stale-market-'));
    const brainHome = path.join(home, 'brain-home');
    const marketplace = path.join(brainHome, 'codex-marketplace');
    const priorBrainHome = process.env.RUVNET_BRAIN_HOME;
    try {
      fs.mkdirSync(path.join(marketplace, '.claude-plugin'), { recursive: true });
      fs.copyFileSync(
        path.join(ROOT, '.claude-plugin', 'marketplace.json'),
        path.join(marketplace, '.claude-plugin', 'marketplace.json'),
      );
      fs.cpSync(PLUGIN, path.join(marketplace, 'plugin'), { recursive: true });

      const market = run(home, ['plugin', 'marketplace', 'add', marketplace, '--json']);
      expect(market.status, market.stderr || market.stdout).toBe(0);
      const install = run(home, ['plugin', 'add', 'ruvnet-brain@ruvnet-brain', '--json']);
      expect(install.status, install.stderr || install.stdout).toBe(0);

      if (snapshotState === 'missing') {
        fs.rmSync(marketplace, { recursive: true, force: true });
      } else {
        fs.writeFileSync(path.join(marketplace, '.claude-plugin', 'marketplace.json'), '{');
      }
      process.env.RUVNET_BRAIN_HOME = brainHome;
      const repaired = wireCodexPlugin({
        codexDir: home,
        codexHome: home,
        expectedVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
        announce: false,
      });

      expect(repaired.action).not.toBe('codex-unavailable');
      expect(repaired).toMatchObject({ installed: true, enabled: true });
      expect(fs.existsSync(path.join(marketplace, '.claude-plugin', 'marketplace.json'))).toBe(true);
      const listed = run(home, ['plugin', 'list', '--json']);
      expect(listed.status, listed.stderr || listed.stdout).toBe(0);
    } finally {
      if (priorBrainHome === undefined) delete process.env.RUVNET_BRAIN_HOME;
      else process.env.RUVNET_BRAIN_HOME = priorBrainHome;
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    },
  );

  test('repairs the snapshot without re-enabling an explicitly disabled Codex plugin', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-codex-disabled-market-'));
    const brainHome = path.join(home, 'brain-home');
    const marketplace = path.join(brainHome, 'codex-marketplace');
    const priorBrainHome = process.env.RUVNET_BRAIN_HOME;
    try {
      fs.mkdirSync(path.join(marketplace, '.claude-plugin'), { recursive: true });
      fs.copyFileSync(
        path.join(ROOT, '.claude-plugin', 'marketplace.json'),
        path.join(marketplace, '.claude-plugin', 'marketplace.json'),
      );
      fs.cpSync(PLUGIN, path.join(marketplace, 'plugin'), { recursive: true });
      expect(run(home, ['plugin', 'marketplace', 'add', marketplace, '--json']).status).toBe(0);
      expect(run(home, ['plugin', 'add', 'ruvnet-brain@ruvnet-brain', '--json']).status).toBe(0);

      const configPath = path.join(home, 'config.toml');
      const config = fs.readFileSync(configPath, 'utf8').replace(
        /(\[plugins\."ruvnet-brain@ruvnet-brain"\]\nenabled = )true/,
        '$1false',
      );
      fs.writeFileSync(configPath, config);
      fs.rmSync(marketplace, { recursive: true, force: true });
      process.env.RUVNET_BRAIN_HOME = brainHome;

      const repaired = wireCodexPlugin({ codexDir: home, codexHome: home, announce: false });
      expect(repaired).toMatchObject({ action: 'disabled', installed: true, enabled: false });
      expect(fs.readFileSync(configPath, 'utf8')).toContain(
        '[plugins."ruvnet-brain@ruvnet-brain"]\nenabled = false',
      );
      expect(fs.existsSync(path.join(marketplace, '.claude-plugin', 'marketplace.json'))).toBe(true);
    } finally {
      if (priorBrainHome === undefined) delete process.env.RUVNET_BRAIN_HOME;
      else process.env.RUVNET_BRAIN_HOME = priorBrainHome;
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  test('reports a marketplace preparation failure without changing Codex configuration', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-codex-market-failure-'));
    const brainHome = path.join(home, 'not-a-directory');
    const configPath = path.join(home, 'config.toml');
    const priorBrainHome = process.env.RUVNET_BRAIN_HOME;
    try {
      fs.writeFileSync(brainHome, 'occupied');
      fs.writeFileSync(configPath, '[features]\njs_repl = false\n');
      const before = fs.readFileSync(configPath, 'utf8');
      process.env.RUVNET_BRAIN_HOME = brainHome;

      expect(wireCodexPlugin({ codexDir: home, codexHome: home, announce: false })).toMatchObject({
        action: 'marketplace-prepare-failed',
      });
      expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    } finally {
      if (priorBrainHome === undefined) delete process.env.RUVNET_BRAIN_HOME;
      else process.env.RUVNET_BRAIN_HOME = priorBrainHome;
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
