// node-sqlite-quiet.test.mjs — SessionStart output stays byte-clean on Node 22.
//
// Linux CI (Node 22, run 36894944735) failed session-start-core-parity because every SessionStart began
// with "(node:PID) ExperimentalWarning: SQLite is an experimental feature…": the continuity brief and the
// progression restore read the store through node:sqlite, and Node 22 warns on its first load. Node 24
// does not, so a Node 24 machine can never see this. Two proofs:
//   1. SIMULATED, on any Node: the loader drops exactly the SQLite ExperimentalWarning and lets every
//      other warning through, and restores process.emitWarning afterwards.
//   2. REAL, on a real Node 22 when one is found (process.execPath on a Node 22 runner, $RUVNET_TEST_NODE22,
//      /usr/local/bin/node, Homebrew node@22, nvm, volta): the real SessionStart core runs in an adopted
//      git project whose store is read through node:sqlite; stderr must be empty and stdout must not
//      mention the warning — and, so this cannot pass vacuously, a bare `require('node:sqlite')` under the
//      same binary and environment MUST warn.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSqliteExperimentalWarning } from '../../plugin/scripts/node-sqlite.mjs';
import { createStore } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOADER = path.join(ROOT, 'plugin', 'scripts', 'node-sqlite.mjs');
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); roots.push(d); return d; };

/** An environment in which Node prints warnings (the developer's shell may set NODE_NO_WARNINGS). */
function warningEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_NO_WARNINGS;
  delete env.NODE_OPTIONS;
  return env;
}

describe('node-sqlite loader (simulated warning, any Node)', () => {
  it('recognizes exactly the SQLite ExperimentalWarning shapes', () => {
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')).toBe(true);
    expect(isSqliteExperimentalWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' })).toBe(true);
    expect(isSqliteExperimentalWarning(Object.assign(new Error('SQLite is experimental'), { name: 'ExperimentalWarning' }))).toBe(true);
    expect(isSqliteExperimentalWarning('VM Modules is an experimental feature', 'ExperimentalWarning')).toBe(false);
    expect(isSqliteExperimentalWarning('SQLite thing', 'DeprecationWarning')).toBe(false);
  });

  it('drops the SQLite warning during the load, passes every other warning, and restores emitWarning', () => {
    const script = `
      import { loadNodeSqlite } from ${JSON.stringify(new URL(`file://${LOADER}`).href)};
      const before = process.emitWarning;
      const mod = loadNodeSqlite({ load: () => {
        process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
        process.emitWarning('fixture deprecation must survive', 'DeprecationWarning');
        return { DatabaseSync: function DatabaseSync() {} };
      } });
      if (process.emitWarning !== before) { console.log('NOT-RESTORED'); process.exit(3); }
      process.emitWarning('SQLite is an experimental feature (after the load)', 'ExperimentalWarning');
      console.log(typeof mod.DatabaseSync);
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: warningEnv(), timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('function');
    expect(r.stderr).toContain('fixture deprecation must survive');
    // Outside the load the filter is gone: a later SQLite-named warning is NOT swallowed.
    expect(r.stderr).toContain('SQLite is an experimental feature (after the load)');
    expect(r.stderr).not.toContain('might change at any time');
  });
});

function findNode22() {
  const candidates = [process.execPath, process.env.RUVNET_TEST_NODE22, '/usr/local/bin/node',
    '/opt/homebrew/opt/node@22/bin/node', '/usr/local/opt/node@22/bin/node'];
  for (const base of [path.join(os.homedir(), '.nvm', 'versions', 'node'), path.join(os.homedir(), '.volta', 'tools', 'image', 'node')]) {
    try { for (const v of fs.readdirSync(base)) candidates.push(path.join(base, v, 'bin', 'node')); } catch { /* none */ }
  }
  for (const bin of candidates.filter(Boolean)) {
    try {
      const v = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
      const [major, minor] = v.split('.').map(Number);
      if (major === 22 && minor >= 5) return { bin, version: v };
    } catch { /* not runnable */ }
  }
  return null;
}

const node22 = findNode22();
describe('real SessionStart on a real Node 22', () => {
  (node22 ? it : it.skip)(`stderr is empty and stdout carries no SQLite warning (${node22 ? `${node22.bin} v${node22.version}` : 'no Node 22 found'})`, () => {
    const root = tmp('sqlite-quiet-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const plugin = path.join(root, 'plugin');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.cpSync(path.join(ROOT, 'plugin', 'scripts'), path.join(plugin, 'scripts'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'plugin', 'hooks'), path.join(plugin, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '4.0.2-test' }));
    const emptyGit = path.join(root, 'empty-gitconfig');
    fs.writeFileSync(emptyGit, '');
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyGit, GIT_CONFIG_NOSYSTEM: '1' };
    expect(spawnSync('git', ['init', '-q'], { cwd: project, env: gitEnv }).status).toBe(0);
    // An adopted store with ruflo's shape, so the restore AND the brief both read it through node:sqlite.
    fs.mkdirSync(path.join(project, '.swarm'));
    createStore(path.join(project, '.swarm', 'memory.db'));
    const env = warningEnv({ HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
      CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: project, RUVNET_HOOK_HOST: 'claude', GIT_CONFIG_GLOBAL: emptyGit,
      GIT_CONFIG_NOSYSTEM: '1', RUFLO_BIN: path.join(root, 'no-ruflo-here'), RUVNET_RUFLO_CWD_ROOT: path.join(root, 'ruflo-cwd') });

    // The test can fail: the same binary and environment DO warn on a bare load.
    const bare = spawnSync(node22.bin, ['-e', "require('node:sqlite')"], { encoding: 'utf8', env, timeout: 30_000 });
    expect(bare.stderr).toMatch(/ExperimentalWarning: SQLite is an experimental feature/);

    const r = spawnSync(node22.bin, [path.join(plugin, 'scripts', 'session-start-core.mjs')], {
      cwd: project, env, encoding: 'utf8', input: '{}', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[RuvNet Brain — COME UP TO SPEED'); // the brief ran, so the store WAS read
    expect(r.stderr).toBe('');
    expect(r.stdout).not.toMatch(/ExperimentalWarning|experimental feature/);
  }, 120_000);
});
