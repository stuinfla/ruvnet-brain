import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SessionStart restart notice safety filter', () => {
  it('surfaces a truthful boot-level restart notice with default filtering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-restart-notice-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const plugin = path.join(root, 'plugin');
    const state = path.join(home, '.cache', 'ruvnet-brain');
    fs.mkdirSync(project, { recursive: true });
    fs.cpSync(path.join(ROOT, 'plugin', 'scripts'), path.join(plugin, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '4.0.2-test' }));
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'active.json'), JSON.stringify({
      generation: 3, version: '4.2.0', codeRoot: 'versions/4.2.0',
      shellChanged: false, shellChangedAtVersion: '4.1.0', shellChangedSinceVersion: '4.0.0',
    }));
    fs.writeFileSync(path.join(state, 'host-convergence.json'), JSON.stringify({
      desiredVersion: '4.2.0', hosts: { claude: { state: 'ready', version: '4.2.0' } },
      consoleRuntime: { state: 'ready', runtimeVersion: '4.2.0' },
    }));
    for (const name of ['.last-update-check', '.seed-attempted', '.auto-update-pref']) {
      fs.writeFileSync(path.join(state, name), name === '.auto-update-pref' ? 'no' : String(Math.floor(Date.now() / 1000)));
    }
    const source = `
      import { runSessionStart } from ${JSON.stringify(path.join(plugin, 'scripts', 'session-start-core.mjs'))};
      let output = '';
      await runSessionStart({ env: process.env, stdout: { write(v) { output += String(v); } }, stderr: process.stderr, runHeartbeat: false });
      process.stdout.write(output);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        RUVNET_BRAIN_HOME: state,
        CLAUDE_PLUGIN_ROOT: plugin,
        CLAUDE_PROJECT_DIR: project,
        RUVNET_HOOK_HOST: 'claude',
        RUVNET_BRAIN_METER: '0',
        RUVNET_VERBOSE_HOOKS: '0',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('one restart picks up its boot-level declarations');
  });
});
