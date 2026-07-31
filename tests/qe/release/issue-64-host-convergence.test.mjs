import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const ENGINE = path.join(ROOT, 'plugin/scripts/update-apply.mjs');
const SESSION = path.join(ROOT, 'plugin/scripts/session-start-core.mjs');
const EXPECTED = '9.9.1-issue64';
const OTHER = '9.9.2-issue64';
const previousImportOnly = process.env.RUVNET_BRAIN_IMPORT_ONLY;
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { claudePluginStatus } = await import('../../../bin/install.mjs');
afterAll(() => {
  if (previousImportOnly === undefined) delete process.env.RUVNET_BRAIN_IMPORT_ONLY;
  else process.env.RUVNET_BRAIN_IMPORT_ONLY = previousImportOnly;
});

const cleanup = [];
const temporary = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};
afterAll(() => cleanup.forEach((item) => fs.rmSync(item, { recursive: true, force: true })));

function stagedPayload(home, host, version) {
  const base = host === 'codex' ? '.codex' : '.claude';
  const dir = path.join(home, base, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', version);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'body.mjs'), `export default ${JSON.stringify(version)};\n`);
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(dir, 'commands', 'rvbc.md'), '# console\n');
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return dir;
}

describe('issue #64 — exact dual-host convergence', () => {
  it('reads Claude Code active version from its authoritative installed registry and payload', () => {
    const home = temporary('rvb-issue64-claude-');
    const installPath = stagedPayload(home, 'claude', EXPECTED);
    const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({
      plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'user', version: 'stale-metadata', installPath }] },
    }));
    expect(claudePluginStatus({ home })).toMatchObject({
      managed: true,
      installed: true,
      version: EXPECTED,
      installPath: fs.realpathSync(installPath),
    });
  });

  it('does not mistake a local/project plugin record for a managed user host', () => {
    const home = temporary('rvb-issue64-local-');
    const installPath = stagedPayload(home, 'claude', EXPECTED);
    const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({
      plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'local', projectPath: '/project', installPath }] },
    }));
    expect(claudePluginStatus({ home })).toMatchObject({ managed: false, installed: false });
  });

  it('rejects a user registry record whose payload escapes the managed plugin cache', () => {
    const home = temporary('rvb-issue64-path-');
    const installPath = temporary('rvb-issue64-foreign-');
    fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(installPath, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: EXPECTED }));
    fs.writeFileSync(path.join(installPath, 'commands', 'rvbc.md'), '# console\n');
    const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({
      plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'user', installPath }] },
    }));
    expect(claudePluginStatus({ home })).toMatchObject({ managed: true, installed: false });
  });

  it('keeps a corrupt user record classified as managed so repair is retried, not silently skipped', () => {
    const home = temporary('rvb-issue64-corrupt-');
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', EXPECTED);
    fs.mkdirSync(installPath, { recursive: true });
    const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({
      plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'user', installPath }] },
    }));
    expect(claudePluginStatus({ home })).toMatchObject({ managed: true, installed: false });
  });

  it('selects the requested candidate, not a different newer payload in another host cache', () => {
    const home = temporary('rvb-issue64-home-');
    const brain = temporary('rvb-issue64-brain-');
    stagedPayload(home, 'claude', EXPECTED);
    stagedPayload(home, 'codex', OTHER);
    const result = spawnSync(process.execPath, [ENGINE, '--auto', '--expected-version', EXPECTED], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), RUVNET_BRAIN_HOME: brain },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(brain, 'active.json'), 'utf8')).version).toBe(EXPECTED);
  });

  it('fails closed when the exact requested candidate is absent', () => {
    const home = temporary('rvb-issue64-home-');
    const brain = temporary('rvb-issue64-brain-');
    stagedPayload(home, 'codex', OTHER);
    const result = spawnSync(process.execPath, [ENGINE, '--auto', '--expected-version', EXPECTED], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), RUVNET_BRAIN_HOME: brain },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(`exactly matches expected version ${EXPECTED}`);
    expect(fs.existsSync(path.join(brain, 'active.json'))).toBe(false);
  });

  it('emits host-aware restart guidance and preserves Codex hook trust review', () => {
    const source = fs.readFileSync(SESSION, 'utf8');
    expect(source).toContain("env.RUVNET_HOOK_HOST || 'claude'");
    expect(source).toContain('already installed and verified for Codex');
    expect(source).toContain('restart Codex');
    expect(source).toContain('run /hooks and trust only ruvnet-brain@ruvnet-brain');
    expect(source).toContain('already installed and verified for Claude Code');
    expect(source).toContain('claude --continue');
    expect(source).toContain('host-convergence.json');
    expect(source).toContain('do not restart for this update yet');
  });

  it('does not launch the update heartbeat in the same SessionStart that seeds the Stable Spine', () => {
    const source = fs.readFileSync(SESSION, 'utf8');
    expect(source).toContain('let seedDispatched = false');
    expect(source).toContain('seedDispatched = dispatchDetached');
    expect(source).toContain('first-session-worker.mjs');
    expect(source).toMatch(/if\s*\(seedDispatched\s*\|\|/);
  });

  it('the installer binds host sync and Spine activation to one exact package version', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin/install.mjs'), 'utf8');
    expect(source).toContain('wirePlugin({ expectedVersion: PACKAGE_VERSION, requireManaged: true })');
    expect(source).toContain("'--auto', '--expected-version', PACKAGE_VERSION");
    expect(source).toContain('if (results.claude.host && !results.claude.wired)');
    expect(source).toContain("['plugin', 'update', 'ruvnet-brain@ruvnet-brain', '--scope', 'user']");
    expect(source).toContain("['plugin', 'marketplace', 'update', 'ruvnet-brain']");
    expect(source).toContain('host-convergence.json');
    expect(fs.readFileSync(path.join(ROOT, 'plugin/scripts/host-update.mjs'), 'utf8')).toContain("'--host-sync-only'");
  });
});
