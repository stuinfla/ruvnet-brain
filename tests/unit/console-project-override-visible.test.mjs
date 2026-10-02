// tests/unit/console-project-override-visible.test.mjs — RNBC QA 2026-10-01.
//
// runtime-preferences merges <project>/.swarm/ruvnet-brain-settings.json OVER the user-level choices,
// and route-cheap / the managed-CLI gate / learning obey that merge. The console saved and displayed
// user-level values only, so in a project seeded by "Apply these choices to new projects" a Settings
// change was silently ignored by the runtime while the page showed it as in effect.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-override-')));
const home = path.join(tmp, 'home');
const project = path.join(tmp, 'project');
const savedCwd = process.cwd();
const savedEnv = {};
let mod;

beforeAll(async () => {
  fs.mkdirSync(path.join(home, '.claude', 'ruvnet-brain'), { recursive: true });
  fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'ruvnet-brain', 'config.json'), JSON.stringify({ routing: 'auto', qeFleet: true }));
  fs.writeFileSync(path.join(project, '.swarm', 'ruvnet-brain-settings.json'),
    JSON.stringify({ version: 1, source: 'user-defaults', values: { routing: 'off', advocacy: 5 } }));
  for (const k of ['HOME', 'RUVNET_CONSOLE_ROOT', 'RUVNET_BRAIN_TEST', 'RUVNET_SETTINGS_FILE', 'RUVNET_BRAIN_CONFIG_FILE', 'RUVNET_BRAIN_PROJECT_SETTINGS_FILE']) savedEnv[k] = process.env[k];
  Object.assign(process.env, { HOME: home, RUVNET_CONSOLE_ROOT: home, RUVNET_BRAIN_TEST: '1', RUVNET_SETTINGS_FILE: path.join(home, '.config', 'ruvnet-brain', 'settings.json') });
  delete process.env.RUVNET_BRAIN_CONFIG_FILE;
  delete process.env.RUVNET_BRAIN_PROJECT_SETTINGS_FILE;
  process.chdir(project);
  mod = await import('../../scripts/onboarding-console.mjs');
});
afterAll(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a project-level override is shown where the user would change the setting', () => {
  it('precondition: the real consumer obeys the project file (route-cheap refuses in this project)', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'route-cheap.mjs'), '--task', 'summarise x'],
      { cwd: project, env: { ...process.env, OPENROUTER_API_KEY: '' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/routing is off/i);
  });

  it('gatherConfig names the overridden key and its project value; the user value is unchanged', () => {
    const cfg = mod.gatherConfig();
    expect(cfg.values.routing).toBe('auto');
    expect(cfg.projectOverrides?.values).toEqual({ routing: 'off' });
    expect(cfg.projectOverrides.path).toMatch(/\.swarm\/ruvnet-brain-settings\.json$/);
  });

  it('keys whose consumer reads user level only (advocacy) are NOT claimed as overridden', () => {
    expect(mod.gatherAdvocacy().projectOverrides).toBeNull();
  });
});
