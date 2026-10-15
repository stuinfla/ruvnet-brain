import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const ENGINE = path.join(ROOT, 'plugin/scripts/update-apply.mjs');
const EXPECTED = '9.9.1-issue64';
const OTHER = '9.9.2-issue64';
const CURRENT = '9.9.2-issue420';
const OLD = '9.9.0-issue420';
const previousImportOnly = process.env.RUVNET_BRAIN_IMPORT_ONLY;
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { claudePluginStatus, claudeProjectInstalls, projectInstallsCheck } = await import('../../../bin/install.mjs');
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
const isolatedEnv = (home, brain, ambient = process.env) => ({
  ...Object.fromEntries(Object.entries(ambient).filter(([key]) =>
    !/^(?:RUVNET_|CLAUDE_|CODEX_|XDG_)/i.test(key))),
  HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CODEX_HOME: path.join(home, '.codex'), RUVNET_BRAIN_HOME: brain,
  RUVNET_BRAIN_KB: path.join(brain, 'kb'), XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
});
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
      env: isolatedEnv(home, brain),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(brain, 'active.json'), 'utf8')).version).toBe(EXPECTED);
  });

  it('ignores an ambient Claude cache containing the otherwise missing requested version', () => {
    const home = temporary('rvb-issue64-isolated-');
    const owner = temporary('rvb-issue64-owner-');
    const brain = temporary('rvb-issue64-brain-');
    const foreignPayload = stagedPayload(owner, 'claude', EXPECTED);
    stagedPayload(home, 'codex', OTHER);
    const result = spawnSync(process.execPath, [ENGINE, '--auto', '--expected-version', EXPECTED], {
      encoding: 'utf8', timeout: 30_000,
      env: isolatedEnv(home, brain, { ...process.env, CLAUDE_CONFIG_DIR: path.join(owner, '.claude') }),
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain(`exactly matches expected version ${EXPECTED}`);
    expect(fs.existsSync(path.join(brain, 'active.json'))).toBe(false);
    expect(fs.readFileSync(path.join(foreignPayload, 'scripts', 'body.mjs'), 'utf8'))
      .toBe(`export default ${JSON.stringify(EXPECTED)};\n`);
  });

  it('fails closed when the exact requested candidate is absent', () => {
    const home = temporary('rvb-issue64-home-');
    const brain = temporary('rvb-issue64-brain-');
    stagedPayload(home, 'codex', OTHER);
    const result = spawnSync(process.execPath, [ENGINE, '--auto', '--expected-version', EXPECTED], {
      encoding: 'utf8',
      env: isolatedEnv(home, brain),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(`exactly matches expected version ${EXPECTED}`);
    expect(fs.existsSync(path.join(brain, 'active.json'))).toBe(false);
  });


  // #420 item 4: --update moves only the user row; per-project rows must be reported with their own command, never edited.
  it('reports a lagging per-project install with its exact command and leaves the registry and project untouched', () => {
    const home = temporary('rvb-issue420-projects-');
    const project = temporary('rvb-issue420-repo-');
    const userPath = stagedPayload(home, 'claude', CURRENT);
    const oldPath = stagedPayload(home, 'claude', OLD);
    const gone = path.join(project, 'deleted-repo');
    const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({ plugins: { 'ruvnet-brain@ruvnet-brain': [
      { scope: 'user', version: CURRENT, installPath: userPath },
      { scope: 'local', projectPath: project, version: 'stale-metadata', installPath: oldPath },
      { scope: 'project', projectPath: gone, version: OLD, installPath: oldPath },
    ] } }));
    const before = fs.readFileSync(registry, 'utf8');
    expect(claudePluginStatus({ home })).toMatchObject({ installed: true, version: CURRENT });
    const rows = claudeProjectInstalls({ home, referenceVersion: CURRENT });
    expect(rows).toEqual([
      { scope: 'local', projectPath: project, version: OLD, exists: true, behind: true,
        command: `cd '${project}' && claude plugin update ruvnet-brain@ruvnet-brain --scope local` },
      { scope: 'project', projectPath: gone, version: OLD, exists: false, behind: false, command: null },
    ]);
    const line = projectInstallsCheck(rows, CURRENT);
    expect(line).toMatchObject({ id: 'project-installs', state: 'warn', fix: rows[0].command });
    expect(line.detail).toContain(`1 per-project Claude Code install(s) behind ${CURRENT}: ${project} (local, ${OLD})`);
    expect(line.detail).toContain(`1 registered for a folder that no longer exists: ${gone} (project, ${OLD})`);
    expect(fs.readFileSync(registry, 'utf8')).toBe(before);
    expect(fs.readdirSync(project)).toEqual([]);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('is silent with no per-project rows and green when every project is current', () => {
    const home = temporary('rvb-issue420-current-');
    const project = temporary('rvb-issue420-repo-');
    const installPath = stagedPayload(home, 'claude', CURRENT);
    const registry = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({ plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'user', installPath }] } }));
    expect(projectInstallsCheck(claudeProjectInstalls({ home, referenceVersion: CURRENT }), CURRENT)).toBeNull();
    fs.writeFileSync(registry, JSON.stringify({ plugins: { 'ruvnet-brain@ruvnet-brain': [
      { scope: 'user', installPath }, { scope: 'local', projectPath: project, installPath },
    ] } }));
    expect(projectInstallsCheck(claudeProjectInstalls({ home, referenceVersion: CURRENT }), CURRENT))
      .toMatchObject({ state: 'ok', fix: null, detail: `1 per-project Claude Code install(s) at ${CURRENT} or newer` });
    expect(claudeProjectInstalls({ home: temporary('rvb-issue420-empty-'), referenceVersion: CURRENT })).toEqual([]);
  });

  it('wires the per-project report into --update and the --doctor verdict', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
    expect(source).toContain('claudeProjectInstalls({ referenceVersion: installed.version }).filter((p) => p.behind)');
    expect(source).toContain('projectInstallsCheck(claudeProjectInstalls({ referenceVersion: projectReference }), projectReference)');
    expect(source).toContain('...(projectLine ? [projectLine] : []),');
  });
});
