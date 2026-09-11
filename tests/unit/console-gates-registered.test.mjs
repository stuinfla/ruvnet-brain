// console-gates-registered.test.mjs — the "what caught Claude" card must count the hooks the HOST
// actually loads, name each plugin gate by what it runs, and list blocking gates that exist on disk
// but are wired nowhere.
//
// THE LIE (console audit 2026-09-11): the card said "8 gates armed — 0 can block". Every plugin row
// was named "hook-shim" (the launcher, not the gate), the survey read plugin/hooks/hooks.json from
// the console's own REPO (absent on an installed host, so the live server showed 3 machine rows and
// nothing from the plugin), and it had no way to say that ground-before-write.sh, decision-gate.mjs,
// design-wall.sh and protect-brain-state.sh — the hooks hook-shim's own table marks `blocking` —
// are not registered at all. "Nothing is enforcing" and "these enforcers are unplugged" are
// different sentences, and only the second one is actionable.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scratch } from './helpers/console-child.mjs';
import { gatesSurvey } from '../../plugin/scripts/gates.mjs';

let tmp;
beforeEach(() => { tmp = scratch('console-gates-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const HOOKS_JSON = {
  hooks: {
    SessionStart: [{ matcher: 'startup|resume', hooks: [
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" session-start || true' },
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" memory-ensure || true' },
    ] }],
    PostEdit: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" memory-store-decisions || true' }] }],
    Stop: [{ matcher: '*', hooks: [
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" continuation-gate || true' },
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" memory-snapshot-threads || true' },
    ] }],
  },
};
// A hook-shim.mjs stand-in carrying the ONLY thing gates.mjs reads from it: the TABLE of ids → mode.
const SHIM_SRC = `
const TABLE = {
  'session-start':       { file: 'session-start-core.mjs', interpreter: 'node', mode: 'advisory', offBehavior: 'partial' },
  'ground-before-write': { file: 'ground-before-write.sh', interpreter: 'bash', mode: 'blocking', offBehavior: 'run', stdinBytes: 65536 },
  'decision-gate':       { file: 'decision-gate.mjs',   interpreter: 'node', mode: 'blocking', offBehavior: 'run', stdinBytes: 65536 },
  'memory-ensure':       { file: 'memory-ensure.mjs', interpreter: 'node', mode: 'advisory', offBehavior: 'silence' },
  'memory-store-decisions': { file: 'memory-store-decisions.mjs', interpreter: 'node', mode: 'advisory', offBehavior: 'silence', stdinBytes: 4096 },
  'memory-snapshot-threads': { file: 'memory-snapshot-threads.mjs', interpreter: 'node', mode: 'advisory', offBehavior: 'silence' },
  'unprompted-speech':   { file: 'unprompted-runtime.mjs', interpreter: 'node', mode: 'blocking', channel: 'unprompted', offBehavior: 'silence', stdinBytes: 65536 },
};
`;

function writePlugin(root) {
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(HOOKS_JSON));
  fs.writeFileSync(path.join(root, 'scripts', 'hook-shim.mjs'), SHIM_SRC);
  fs.writeFileSync(path.join(root, 'scripts', 'ground-before-write.sh'), '#!/bin/bash\nexit 2\n'); // on disk
  // decision-gate.mjs deliberately ABSENT: registered nowhere AND not on disk.
}
function writeHome(home) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash "${HOME}/.claude/hooks/pre-action-gate.sh"' }] }],   // can refuse
    SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash "${HOME}/.claude/hooks/agentdb-ensure.sh" || true' }] }], // cannot
  } }));
}
function writeRepoWithGitHooks(repo) {
  const common = path.join(tmp, 'main.git');
  fs.mkdirSync(path.join(common, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(common, 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(common, 'hooks', 'pre-commit'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(common, 'hooks', 'pre-push.sample'), '# sample');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${path.join(common, 'worktrees', 'wt')}\n`); // a worktree checkout
}

describe('Fix 4 — gates survey counts what the host loads and names what is unplugged', () => {
  it('plugin rows are named by the gate they run, not by the launcher', () => {
    const home = path.join(tmp, 'home'); const plugin = path.join(tmp, 'plugin'); const repo = path.join(tmp, 'repo');
    writeHome(home); writePlugin(plugin); fs.mkdirSync(repo);
    const s = gatesSurvey({ repo, home, pluginRoot: plugin });
    const pluginNames = s.gates.filter((g) => g.source.startsWith('plugin')).map((g) => g.name).sort();
    expect(pluginNames).toEqual(['continuation-gate', 'memory-ensure', 'memory-snapshot-threads', 'memory-store-decisions', 'session-start']);
    expect(pluginNames).not.toContain('hook-shim');
  });

  it('blocking counts only what can refuse: 1 machine PreToolUse without "|| true"; the plugin’s 5 "|| true" entries are advisory', () => {
    const home = path.join(tmp, 'home'); const plugin = path.join(tmp, 'plugin'); const repo = path.join(tmp, 'repo');
    writeHome(home); writePlugin(plugin); fs.mkdirSync(repo);
    const s = gatesSurvey({ repo, home, pluginRoot: plugin });
    expect(s.summary.armed).toBe(7);
    expect(s.summary.blocking).toBe(1);
    expect(s.summary.advisory).toBe(6);
  });

  it('lists blocking gates that hook-shim knows but hooks.json never registers — with whether they exist on disk', () => {
    const home = path.join(tmp, 'home'); const plugin = path.join(tmp, 'plugin'); const repo = path.join(tmp, 'repo');
    writeHome(home); writePlugin(plugin); fs.mkdirSync(repo);
    const s = gatesSurvey({ repo, home, pluginRoot: plugin });
    const byName = Object.fromEntries(s.unregistered.map((u) => [u.name, u]));
    expect(byName['ground-before-write']).toMatchObject({ mode: 'blocking', onDisk: true, file: 'ground-before-write.sh' });
    expect(byName['decision-gate']).toMatchObject({ mode: 'blocking', onDisk: false });
    expect(byName['unprompted-speech']).toMatchObject({ mode: 'blocking' });
    expect(byName['memory-ensure']).toBeUndefined();          // registered → not in this list
    expect(s.summary.unregisteredBlocking).toBe(3);
  });

  it('resolves the plugin the host actually loads from installed_plugins.json when no pluginRoot is given', () => {
    const home = path.join(tmp, 'home'); const plugin = path.join(tmp, 'cache', 'ruvnet-brain', '9.9.9'); const repo = path.join(tmp, 'repo');
    writeHome(home); writePlugin(plugin); fs.mkdirSync(repo);
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'ruvnet-brain@ruvnet-brain': [{ installPath: plugin }] } }));
    const s = gatesSurvey({ repo, home });
    expect(s.pluginSource).toBe('installed');
    expect(s.pluginPath).toBe(path.join(plugin, 'hooks', 'hooks.json'));
    expect(s.gates.filter((g) => g.source.startsWith('plugin'))).toHaveLength(5);
  });

  it('falls back to the repo’s plugin/hooks/hooks.json in a dev checkout, and says that is what it read', () => {
    const home = path.join(tmp, 'home'); const repo = path.join(tmp, 'repo');
    writeHome(home); writePlugin(path.join(repo, 'plugin'));
    const s = gatesSurvey({ repo, home });
    expect(s.pluginSource).toBe('repo');
  });

  it('reports git hooks separately (they stop commits, not tool calls) and follows a worktree’s .git pointer', () => {
    const home = path.join(tmp, 'home'); const repo = path.join(tmp, 'repo');
    writeHome(home); writeRepoWithGitHooks(repo);
    const s = gatesSurvey({ repo, home });
    expect(s.git.map((g) => g.name)).toEqual(['pre-commit']);                 // .sample files are not hooks
    expect(s.summary.blocking).toBe(1);                                          // git hooks do NOT inflate the tool-call count
  });
});
