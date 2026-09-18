import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activeClaudeView } from '../../plugin/scripts/hook-registry.mjs';
import { gatesSurvey } from '../../plugin/scripts/gates.mjs';

const roots = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-hook-view-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`); };

function brainHome({ enabled = true, rows = null } = {}) {
  const home = temp();
  const install = path.join(home, '.claude/plugins/cache/ruvnet-brain/ruvnet-brain/selected');
  write(path.join(install, 'hooks/hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Task', hooks: [{ type: 'command', command: 'node route-dispatch.sh' }] }] } });
  write(path.join(home, '.claude/settings.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': enabled }, hooks: {} });
  write(path.join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: { 'ruvnet-brain@ruvnet-brain': rows || [{ scope: 'user', installPath: install }] } });
  return { home, install };
}

describe('active Claude configured-on-disk hook view', () => {
  it('uses the registry-selected generation instead of cache mtime', () => {
    const { home, install } = brainHome();
    const newer = path.join(home, '.claude/plugins/cache/ruvnet-brain/ruvnet-brain/newer');
    write(path.join(newer, 'hooks/hooks.json'), { hooks: { SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: 'node wrong.mjs' }] }] } });
    const view = activeClaudeView({ home, project: home });
    expect(view.pluginState).toBe('configured-on-disk');
    expect(view.pluginSource).toBe(fs.realpathSync(path.join(install, 'hooks/hooks.json')));
    expect(view.records.some((r) => r.command === 'node route-dispatch.sh')).toBe(true);
    expect(view.records.some((r) => r.command === 'node wrong.mjs')).toBe(false);
  });

  it('reports disabled instead of falling back to a stale cache generation', () => {
    const { home } = brainHome({ enabled: false });
    const view = activeClaudeView({ home, project: home });
    expect(view.pluginState).toBe('disabled');
    expect(view.pluginSource).toBe(null);
    expect(view.records.some((r) => r.command === 'node route-dispatch.sh')).toBe(false);
  });

  it('returns unknown for malformed authoritative registry and selected hooks', () => {
    const { home, install } = brainHome();
    write(path.join(home, '.claude/plugins/installed_plugins.json'), '{bad');
    expect(activeClaudeView({ home, project: home })).toMatchObject({ pluginState: 'unknown', state: 'unknown', complete: false });
    write(path.join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'user', installPath: install }] } });
    write(path.join(install, 'hooks/hooks.json'), '{bad');
    const view = activeClaudeView({ home, project: home });
    expect(view).toMatchObject({ pluginState: 'configured-on-disk', state: 'unknown', complete: false });
    expect(view.errors.some((e) => e.layer === 'plugin-installed')).toBe(true);
  });

  it('accepts a valid empty active hooks document', () => {
    const { home, install } = brainHome();
    write(path.join(install, 'hooks/hooks.json'), { hooks: {} });
    const view = activeClaudeView({ home, project: home });
    expect(view).toMatchObject({ state: 'configured-on-disk', pluginState: 'configured-on-disk', complete: true, records: [] });
  });

  it('rejects install path prefix collisions', () => {
    const { home } = brainHome();
    write(path.join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'user', installPath: `${home}/.claude/plugins/cache/ruvnet-brain/ruvnet-brain-evil` }] } });
    const view = activeClaudeView({ home, project: home });
    expect(view.pluginState).toBe('unknown');
    expect(view.errors[0].error).toMatch(/escapes|unreadable/);
  });

  it('applies project-local then project then user plugin enablement precedence', () => {
    const { home, install } = brainHome();
    const project = temp();
    write(path.join(project, '.claude/settings.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': false } });
    expect(activeClaudeView({ home, project }).pluginState).toBe('disabled');
    write(path.join(project, '.claude/settings.local.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true } });
    const view = activeClaudeView({ home, project });
    expect(view.pluginState).toBe('configured-on-disk');
    expect(view.pluginSource).toBe(fs.realpathSync(path.join(install, 'hooks/hooks.json')));
    expect(view.provenance.project).toBe(path.resolve(project));
  });

  it('labels checkout hooks as diagnostic preimage and excludes them from active gate counts', () => {
    const home = temp();
    write(path.join(home, '.claude/settings.json'), { hooks: { PreToolUse: [{ matcher: 'Task', hooks: [{ type: 'command', command: 'node direct.mjs' }] }] } });
    const repo = temp();
    write(path.join(repo, 'plugin/hooks/hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Task', hooks: [{ type: 'command', command: 'node preimage.mjs' }] }] } });
    const view = activeClaudeView({ home, repo, project: repo });
    expect(view.state).toBe('diagnostic-preimage');
    expect(view.records.find((r) => r.command.includes('preimage')).role).toBe('diagnostic-preimage');
    const survey = gatesSurvey({ home, repo });
    expect(survey.gates.some((g) => g.name === 'preimage')).toBe(false);
    expect(survey.gates.some((g) => g.name === 'direct')).toBe(true);
    expect(survey.state).toBe('diagnostic-preimage');
  });

  it('marks malformed project settings unknown while preserving no partial claim', () => {
    const { home } = brainHome();
    const project = temp();
    write(path.join(project, '.claude/settings.json'), '{bad');
    const view = activeClaudeView({ home, project });
    expect(view.state).toBe('unknown');
    expect(view.complete).toBe(false);
    expect(view.errors.some((e) => e.layer === 'project')).toBe(true);
  });

  it('honors effective disableAllHooks and keeps handler types strict', () => {
    const { home, install } = brainHome();
    write(path.join(home, '.claude/settings.json'), { disableAllHooks: true, hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node user.mjs' }] }] } });
    write(path.join(install, 'hooks/hooks.json'), { hooks: { SessionStart: [{ matcher: '*', hooks: [
      { type: 'agent', prompt: 'check this' }, { type: 'http', url: 'https://example.test/hook' },
    ] }] } });
    const view = activeClaudeView({ home, project: home });
    expect(view.provenance.hooksDisabled).toBe(true);
    expect(view.records).toEqual([]);
    write(path.join(home, '.claude/settings.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true } });
    const enabled = activeClaudeView({ home, project: home });
    expect(enabled.records.map((r) => r.type)).toEqual(['agent', 'http']);
  });

  it('rejects relative configured install paths', () => {
    const { home } = brainHome();
    write(path.join(home, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'user', installPath: 'relative-generation' }] } });
    expect(activeClaudeView({ home, project: home }).pluginState).toBe('unknown');
  });
});


describe('managed file policy and canonical project resolution', () => {
  const hook = (command) => ({ SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command }] }] });
  const commands = (view) => view.records.filter(row => row.role !== 'diagnostic-preimage').map(row => row.command);
  const policy = () => path.join(temp(), 'managed-settings.json');

  it('uses base then lexical drop-in precedence and ignores hidden fragments', () => {
    const { home } = brainHome(); const managedFile = policy();
    write(managedFile, { disableAllHooks: true, enabledPlugins: { 'ruvnet-brain@ruvnet-brain': false } });
    const fragments = path.join(path.dirname(managedFile), 'managed-settings.d');
    write(path.join(fragments, '10-enable.json'), { disableAllHooks: false, enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true } });
    write(path.join(fragments, '20-other.json'), { enabledPlugins: { 'other@market': true } });
    write(path.join(fragments, '.99-hidden.json'), { disableAllHooks: true, enabledPlugins: { 'ruvnet-brain@ruvnet-brain': false } });
    const view = activeClaudeView({ home, project: home, managedFile });
    expect(view.pluginState).toBe('configured-on-disk');
    expect(view.provenance.hooksDisabled).toBe(false);
    expect(commands(view)).toContain('node route-dispatch.sh');
    write(path.join(fragments, '30-disable.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': false } });
    expect(activeClaudeView({ home, project: home, managedFile }).pluginState).toBe('disabled');
  });

  it('retains base, fragment and force-enabled plugin hooks under managed-only policy', () => {
    const { home } = brainHome(); const managedFile = policy();
    write(path.join(home, '.claude/settings.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true }, hooks: hook('node user.mjs') });
    write(managedFile, { allowManagedHooksOnly: true, enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true }, hooks: hook('node base.mjs') });
    write(path.join(path.dirname(managedFile), 'managed-settings.d/10-hooks.json'), { hooks: hook('node fragment.mjs') });
    const view = activeClaudeView({ home, project: home, managedFile });
    expect(commands(view).sort()).toEqual(['node base.mjs', 'node fragment.mjs', 'node route-dispatch.sh'].sort());
  });

  it('lets a lower-tier disable preserve managed sources while a managed disable removes all', () => {
    const { home } = brainHome(); const managedFile = policy();
    write(path.join(home, '.claude/settings.json'), { disableAllHooks: true, hooks: hook('node user.mjs') });
    write(managedFile, { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true }, hooks: hook('node base.mjs') });
    write(path.join(path.dirname(managedFile), 'managed-settings.d/10-hooks.json'), { hooks: hook('node fragment.mjs') });
    expect(commands(activeClaudeView({ home, project: home, managedFile })).sort())
      .toEqual(['node base.mjs', 'node fragment.mjs', 'node route-dispatch.sh'].sort());
    write(path.join(path.dirname(managedFile), 'managed-settings.d/20-disable.json'), { disableAllHooks: true });
    expect(activeClaudeView({ home, project: home, managedFile }).records).toEqual([]);
  });

  it('lets an explicit project false override a user disable', () => {
    const { home } = brainHome(); const project = temp(); const managedFile = policy();
    write(path.join(home, '.claude/settings.json'), { disableAllHooks: true, enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true }, hooks: hook('node user.mjs') });
    write(path.join(project, '.claude/settings.json'), { disableAllHooks: false });
    const view = activeClaudeView({ home, project, managedFile });
    expect(view.provenance.hooksDisabled).toBe(false);
    expect(commands(view)).toContain('node user.mjs');
  });

  it('finds canonical project-local policy from a nested Git working directory', () => {
    const { home } = brainHome(); const project = temp(); const managedFile = policy();
    execFileSync('git', ['init', '-q', project], { stdio: 'pipe' });
    const nested = path.join(project, 'src/nested'); fs.mkdirSync(nested, { recursive: true });
    write(path.join(project, '.claude/settings.local.json'), { enabledPlugins: { 'ruvnet-brain@ruvnet-brain': false } });
    expect(activeClaudeView({ home, project: nested, managedFile }).pluginState).toBe('disabled');
  });
});
