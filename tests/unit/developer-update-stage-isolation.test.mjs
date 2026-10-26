// WP-B2 (4.7.21, AuditC #1, #5, #10, #16, #17, #26): the coordinated nightly was all-or-nothing with knowledge
// near the end, so one npm view, one plugin or a missing `claude` cost the corpus its update every night, and the
// SessionStart self-heal ran the whole suite under a session TTL. Every case here uses injected runners in a temp HOME;
// nothing reaches npm, the registry or a real installer.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDeveloperUpdate, knowledge, pruneCorpusResults, withTransientRetry, INSTALL_UPDATE_TIMEOUT_MS, atomic } from '../../plugin/scripts/developer-update.mjs';
import { sharedLockStatus } from '../../plugin/scripts/developer-update-lock.mjs';
import { automaticInvocation, saveUpdateSource } from '../../plugin/scripts/automatic-update.mjs';
import { installNightlyRunner } from '../../plugin/scripts/nightly-scheduler.mjs';
import { developerCoordinatorOwner } from '../../plugin/scripts/developer-update-owner.mjs';
import { EXECUTION_MODULES } from '../../plugin/scripts/developer-update-policy.mjs';
import { AUTO_UPDATE_POLICY, heartbeat } from '../../plugin/scripts/session-start-update-plane.mjs';
import { AUTO_UPDATE_LOCK_STALE_MS, knowledgeCurrency } from '../../plugin/scripts/session-start-health.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = path.join(ROOT, 'plugin', 'scripts');
const RUNNER = path.join(ROOT, 'bin', 'nightly-refresh.mjs');
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dusi-'))); roots.push(d); return d; };

/** A temp HOME with an npm owner, two family packages at 1.0.0 and an installed Brain KB whose --check says CURRENT. */
function machine() {
  const home = tmp(), prefix = path.join(home, '.npm-global'), root = path.join(prefix, 'lib/node_modules'), bin = path.join(prefix, 'bin');
  const brainHome = path.join(home, '.cache/ruvnet-brain');
  for (const name of ['agentdb', 'ruflo']) { fs.mkdirSync(path.join(root, name), { recursive: true }); atomic(path.join(root, name, 'package.json'), { name, version: '1.0.0' }); }
  fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'npm'), 'fixture', { mode: 0o755 });
  fs.mkdirSync(path.join(brainHome, 'kb'), { recursive: true }); fs.writeFileSync(path.join(brainHome, 'kb/forge-update.mjs'), '');
  const calls = [];
  const runner = (command, args, options) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'prefix') return prefix;
    if (args[0] === 'root') return root;
    if (args[0] === 'view') {
      if (args[1] === 'ruflo') throw Error('npm view ruflo: exit 1: npm error code E404 Not Found');
      return JSON.stringify({ latest: '1.0.0' });
    }
    if (args[1] === '--check') {
      fs.writeFileSync(args[args.indexOf('--result-file') + 1], JSON.stringify({ kind: 'ruvnet-brain-check-result', recordedAt: new Date().toISOString(), currencyVerdict: 'CURRENT' }));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw Error(`unexpected call: ${command} ${args.join(' ')}`);
  };
  return { home, prefix, root, bin, brainHome, calls, runner, receiptFile: path.join(brainHome, 'nightly-suite-update.json') };
}

const OLD_PLUGIN_VERSION = ['9', '0', '0'].join('.'); // synthetic: the fixture's installed plugin version, never the product's

describe('coordinator stage isolation', () => {
  it('npm view failing for one package still runs knowledge, records the package failure, and throws after persisting', async () => {
    const m = machine();
    await expect(runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin }, runner: m.runner }))
      .rejects.toThrow(/completed with failures: package ruflo: npm view ruflo/);
    const receipt = JSON.parse(fs.readFileSync(m.receiptFile, 'utf8'));
    expect(m.calls.filter(c => c.endsWith('--check'))).toHaveLength(1);
    expect(receipt).toMatchObject({ state: 'completed-with-failures', ok: false, knowledge: { state: 'current' } });
    expect(receipt.failures).toEqual([{ stage: 'package ruflo', error: expect.stringMatching(/E404/) }]);
    expect(receipt.steps.map(s => [s.name, s.state])).toEqual([['agentdb', 'current'], ['ruflo', 'failed']]);
    expect(typeof receipt.finishedAt).toBe('string');
    // A non-transient npm error is not retried, the corpus result file is gone, and the lock is released.
    expect(m.calls.filter(c => c === 'view ruflo')).toHaveLength(1);
    expect(fs.readdirSync(m.brainHome).filter(n => n.startsWith('nightly-suite-corpus-'))).toEqual([]);
    expect(sharedLockStatus({ brainHome: m.brainHome }).state).toBe('idle');
  });

  it('packages run before knowledge, and a transient npm view failure is retried 15 s then 30 s apart', async () => {
    const m = machine(), slept = [];
    let failures = 2;
    const runner = (command, args, options) => {
      if (args[0] === 'view' && args[1] === 'ruflo') {
        m.calls.push('view ruflo');
        if (failures-- > 0) throw Error('npm view ruflo: exit 1: npm error code ETIMEDOUT');
        return JSON.stringify({ latest: '1.0.0' });
      }
      return m.runner(command, args, options);
    };
    const receipt = await runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin }, runner, sleep: ms => slept.push(ms) });
    expect(receipt).toMatchObject({ state: 'completed', ok: true, failures: [] });
    expect(slept).toEqual([15_000, 30_000]);
    expect(m.calls.indexOf('view ruflo')).toBeLessThan(m.calls.findIndex(c => c.endsWith('--check')));
  });

  it('no claude on PATH: installed plugins are UNSUPPORTED and preserved, knowledge ran, the run completes', async () => {
    const m = machine(), artifact = path.join(m.home, 'artifact'); fs.mkdirSync(artifact);
    const installed = path.join(m.home, '.claude/plugins/installed_plugins.json');
    atomic(installed, { plugins: { 'ruvnet-brain@ruvnet-brain': [{ scope: 'user', installPath: artifact, version: OLD_PLUGIN_VERSION }] } });
    const runner = (command, args, options) => args[0] === 'view' ? JSON.stringify({ latest: '1.0.0' }) : m.runner(command, args, options);
    const receipt = await runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin }, runner });
    expect(receipt).toMatchObject({ state: 'completed', ok: true, knowledge: { state: 'current' } });
    expect(receipt.plugins.steps).toEqual([expect.objectContaining({ id: 'ruvnet-brain@ruvnet-brain', state: 'UNSUPPORTED', reason: expect.stringMatching(/no existing Claude command/) })]);
    expect(receipt.coverage.unverified.some(n => n.includes('ruvnet-brain@ruvnet-brain'))).toBe(true);
    expect(m.calls.some(c => c.startsWith('plugin'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(installed, 'utf8')).plugins['ruvnet-brain@ruvnet-brain'][0].version).toBe(OLD_PLUGIN_VERSION);
  });

  it('a knowledge failure is recorded on the knowledge stage and the later stages still run', async () => {
    const m = machine();
    const runner = (command, args, options) => args[0] === 'view' ? JSON.stringify({ latest: '1.0.0' })
      : args[1] === '--check' ? { exitCode: 1, stdout: '', stderr: 'boom' } : m.runner(command, args, options);
    await expect(runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin }, runner })).rejects.toThrow(/knowledge: corpus check exited 1/);
    const receipt = JSON.parse(fs.readFileSync(m.receiptFile, 'utf8'));
    expect(receipt.knowledge).toEqual({ state: 'failed', error: 'corpus check exited 1' });
    expect(receipt.failures).toEqual([{ stage: 'knowledge', error: 'corpus check exited 1' }]);
    expect(receipt.plugins).toMatchObject({ steps: [] });
    expect(receipt.after.map(p => p.name)).toEqual(['agentdb', 'ruflo']);
  });

  it('--knowledge-only runs npm identity and knowledge only, under the same lock', async () => {
    const m = machine();
    const receipt = await runDeveloperUpdate({ mode: 'apply', home: m.home, env: { PATH: m.bin }, runner: m.runner, knowledgeOnly: true });
    expect(receipt).toMatchObject({ state: 'completed', ok: true, knowledgeOnly: true, knowledge: { state: 'current' }, coverage: { scope: 'knowledge-only' } });
    expect(m.calls).toEqual(['prefix -g', 'root -g', expect.stringMatching(/--check$/)]);
    expect(receipt.plugins).toBeUndefined(); expect(receipt.maintenance).toBeUndefined();
  });

  it('the CLI accepts --knowledge-only (it used to refuse it as an unsupported argument)', () => {
    const home = tmp(), empty = path.join(home, 'empty'); fs.mkdirSync(empty);
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'developer-update.mjs'), '--knowledge-only', '--check'],
      { encoding: 'utf8', timeout: 30_000, env: { HOME: home, USERPROFILE: home, PATH: empty, RUVNET_BRAIN_HOME: path.join(home, '.cache/ruvnet-brain') } });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/unsupported developer update argument/);
    expect(r.stderr).toMatch(/existing npm owner absent/);
  });
});

/** knowledge() with a runner that answers the receipt door (exit codes) and the plain door (throws off-contract), so the
 * pre-fix code — which only used the plain door with allowed [0, 10] and [0] — fails these cases. */
function knowledgeFixture({ checks, installExit = 0, installed = '9.0.1', stamped = '9.0.0' }) {
  const brainHome = tmp(), root = path.join(brainHome, 'root'), calls = [];
  fs.mkdirSync(path.join(brainHome, 'kb'), { recursive: true }); fs.writeFileSync(path.join(brainHome, 'kb/forge-update.mjs'), '');
  if (stamped) atomic(path.join(brainHome, 'kb/RUNTIME-IDENTITY.json'), { brainVersion: stamped });
  fs.mkdirSync(path.join(root, 'ruvnet-brain/bin'), { recursive: true }); fs.writeFileSync(path.join(root, 'ruvnet-brain/bin/install.mjs'), '');
  atomic(path.join(root, 'ruvnet-brain/package.json'), { name: 'ruvnet-brain', version: installed });
  const answer = (args) => {
    const at = args.indexOf('--result-file');
    if (at >= 0) {
      calls.push('check');
      const [code, verdict] = checks.shift();
      if (verdict) fs.writeFileSync(args[at + 1], JSON.stringify({ kind: 'ruvnet-brain-check-result', recordedAt: new Date().toISOString(), currencyVerdict: verdict }));
      return code;
    }
    calls.push(`install ${args.slice(1).join(' ')}`);
    return installExit;
  };
  const run = (_node, args, options = {}) => { const code = answer(args); if (!(options.allowed || [0]).includes(code)) throw Error(`exit ${code}`); return ''; };
  run.receipt = (_node, args) => ({ exitCode: answer(args), stdout: '', stderr: '' });
  return { calls, run, opts: { brainHome, root, node: process.execPath } };
}

describe('knowledge step', () => {
  it('--check exit 5 with the installed package ahead of the KB runtime stamp runs install --update, which re-stamps', () => {
    const f = knowledgeFixture({ checks: [[5], [0, 'CURRENT']] });
    const result = knowledge(f.run, false, 'k1', f.opts);
    expect(f.calls).toEqual(['check', 'install --update --no-nightly-prompt --no-stack', 'check']);
    expect(result).toMatchObject({ state: 'updated', restamped: { from: '9.0.0', to: '9.0.1' } });
  });

  it('--check exit 5 with the same version is reported incompatible and installs nothing', () => {
    const f = knowledgeFixture({ checks: [[5]], installed: '9.0.0' });
    expect(knowledge(f.run, false, 'k2', f.opts)).toMatchObject({ state: 'incompatible', installed: '9.0.0', stamped: '9.0.0' });
    expect(f.calls).toEqual(['check']);
  });

  it('install --update exit 12 (cleanup pending, knowledge applied) is accepted; any other non-zero is a failure', () => {
    const ok = knowledgeFixture({ checks: [[10, 'UPDATE_AVAILABLE'], [0, 'CURRENT']], installExit: 12 });
    expect(knowledge(ok.run, false, 'k3', ok.opts)).toMatchObject({ state: 'updated', installerExit: 12 });
    const bad = knowledgeFixture({ checks: [[10, 'UPDATE_AVAILABLE']], installExit: 1 });
    expect(() => knowledge(bad.run, false, 'k4', bad.opts)).toThrow(/exited 1/);
  });

  it('--check exit 2 (network) is retried 15 s then 30 s apart, and a third exit 2 fails', () => {
    const slept = [];
    const f = knowledgeFixture({ checks: [[2], [2], [0, 'CURRENT']] });
    expect(knowledge(f.run, false, 'k5', { ...f.opts, sleep: ms => slept.push(ms) })).toMatchObject({ state: 'current' });
    expect(slept).toEqual([15_000, 30_000]);
    const g = knowledgeFixture({ checks: [[2], [2], [2]] });
    expect(() => knowledge(g.run, false, 'k6', { ...g.opts, sleep: () => {} })).toThrow(/exit 2/);
    expect(g.calls).toEqual(['check', 'check', 'check']);
  });

  it('withTransientRetry stops at once on a non-transient error', () => {
    let tries = 0;
    expect(() => withTransientRetry(() => { tries++; throw Error('E404'); }, { transient: e => /ETIMEDOUT/.test(e.message), sleep: () => {} })).toThrow(/E404/);
    expect(tries).toBe(1);
  });

  it('the check result is deleted after reading, and leftovers older than 48 h are pruned', () => {
    const f = knowledgeFixture({ checks: [[0, 'CURRENT']] });
    knowledge(f.run, false, 'k7', f.opts);
    expect(fs.existsSync(path.join(f.opts.brainHome, 'nightly-suite-corpus-k7.json'))).toBe(false);
    const old = path.join(f.opts.brainHome, 'nightly-suite-corpus-old.json'), young = path.join(f.opts.brainHome, 'nightly-suite-corpus-young.json');
    fs.writeFileSync(old, '{}'); fs.writeFileSync(young, '{}');
    const t = (Date.now() - 49 * 3_600_000) / 1000; fs.utimesSync(old, t, t);
    expect(pruneCorpusResults(f.opts.brainHome)).toBe(1);
    expect([fs.existsSync(old), fs.existsSync(young)]).toEqual([false, true]);
  });
});

describe('SessionStart scope and time limits', () => {
  it('a SessionStart request for a coordinated machine produces --knowledge-only, never the whole suite', () => {
    const home = tmp(), brainHome = path.join(home, '.cache/ruvnet-brain');
    const record = installNightlyRunner({ brainHome, source: RUNNER, nodePath: process.execPath });
    const invocation = automaticInvocation(['--update', '--no-nightly-prompt'], { home });
    expect(invocation.source).toBe('developer-suite');
    expect(invocation.args).toEqual([record.updateModules['developer-update.mjs'].path, '--apply', '--knowledge-only']);
  });

  it('the host-sync heartbeat does not start the coordinator under its 9-minute limit on a coordinated machine', () => {
    const home = tmp(), brainHome = path.join(home, '.cache/ruvnet-brain');
    installNightlyRunner({ brainHome, source: RUNNER, nodePath: process.execPath });
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'host-update.mjs')], { encoding: 'utf8', timeout: 30_000,
      env: { HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome, PATH: path.dirname(process.execPath) } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/coordinated updates own this machine/);
    expect(fs.existsSync(path.join(brainHome, 'nightly-suite-update.json'))).toBe(false);
  });

  it('time limits nest: installer < host-update knowledge < SessionStart TTL < lock staleness, above a 90-minute download', () => {
    const hostLimit = Number(/RUVNET_KNOWLEDGE_UPDATE_TIMEOUT_MS \|\| (\d+) \* 60_000/.exec(fs.readFileSync(path.join(SCRIPTS, 'host-update.mjs'), 'utf8'))[1]) * 60_000;
    expect(INSTALL_UPDATE_TIMEOUT_MS).toBeGreaterThanOrEqual(120 * 60_000);
    expect(hostLimit).toBeGreaterThanOrEqual(INSTALL_UPDATE_TIMEOUT_MS + 10 * 60_000);
    expect(AUTO_UPDATE_POLICY.ttlSec * 1000).toBeGreaterThan(hostLimit);
    expect(AUTO_UPDATE_POLICY.ttlSec).toBeGreaterThanOrEqual(2700);
    expect(AUTO_UPDATE_LOCK_STALE_MS).toBeGreaterThan(AUTO_UPDATE_POLICY.ttlSec * 1000);
    expect(AUTO_UPDATE_LOCK_STALE_MS).toBeLessThanOrEqual(AUTO_UPDATE_POLICY.ttlSec * 1000 + 10 * 60_000);
  });

  it('on a coordinated machine the heartbeat says the nightly installs new code, not that it is downloading now', () => {
    for (const coordinated of [true, false]) {
      const home = tmp(), stateDir = path.join(home, 'state'), hookDir = path.join(home, 'hooks');
      fs.mkdirSync(stateDir, { recursive: true }); fs.mkdirSync(hookDir); fs.writeFileSync(path.join(hookDir, 'host-update.mjs'), ''); // no detach.mjs: nothing is launched
      if (coordinated) installNightlyRunner({ brainHome: path.join(home, '.cache/ruvnet-brain'), source: RUNNER, nodePath: process.execPath });
      fs.writeFileSync(path.join(stateDir, '.last-version-check.log'), '9.9.9\n');
      fs.writeFileSync(path.join(stateDir, '.auto-update-pref'), 'yes\n');
      const stamp = path.join(stateDir, '.last-update-check'); fs.writeFileSync(stamp, '1\n');
      const lines = [];
      heartbeat({ env: { HOME: home }, hookDir, stateDir, home, running: '9.0.1', seedDispatched: false, stamp, emit: l => lines.push(l), now: Date.now() });
      const text = lines.join('\n');
      if (coordinated) { expect(text).toMatch(/v9\.9\.9 is published; this machine's coordinated nightly update installs it/); expect(text).not.toMatch(/downloading/); }
      else expect(text).toMatch(/v9\.9\.9 is downloading/);
    }
  });
});

describe('host-update --knowledge mirrors the exit-5 re-stamp', () => {
  function installedMachine(version) {
    const home = tmp(), brainHome = path.join(home, '.cache/ruvnet-brain'), kb = path.join(brainHome, 'kb');
    const pkg = path.join(home, '.npm-global/lib/node_modules/ruvnet-brain'), marker = path.join(home, 'installer-ran.txt');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true }); fs.mkdirSync(kb, { recursive: true });
    atomic(path.join(pkg, 'package.json'), { name: 'ruvnet-brain', version, bin: { 'ruvnet-brain': 'bin/install.mjs' } });
    fs.writeFileSync(path.join(pkg, 'bin/install.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));`);
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), 'process.exit(5);');
    atomic(path.join(kb, 'RUNTIME-IDENTITY.json'), { brainVersion: '9.0.0' });
    saveUpdateSource('installed', { home });
    const attempt = path.join(brainHome, 'auto-update.json'), lock = path.join(brainHome, 'auto-update.lock'), check = path.join(brainHome, 'corpus-check.json');
    fs.writeFileSync(lock, '{}');
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'host-update.mjs'), '--knowledge', attempt, lock, '--if-newer', kb, check, path.join(brainHome, 'result.json')],
      { encoding: 'utf8', timeout: 60_000, env: { HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome, PATH: path.dirname(process.execPath) } });
    return { r, marker, check: JSON.parse(fs.readFileSync(check, 'utf8')), lock };
  }
  it('installed package 9.0.1 over a 4.7.20 stamp: the installer runs --update', () => {
    const m = installedMachine('9.0.1');
    expect(m.r.status).toBe(0);
    expect(m.check.outcome).toBe('updating');
    expect(fs.readFileSync(m.marker, 'utf8')).toMatch(/^--update --no-nightly-prompt/);
    expect(fs.existsSync(m.lock)).toBe(false);
  });
  it('same version as the stamp: still reported incompatible, no installer', () => {
    const m = installedMachine('9.0.0');
    expect(m.check.outcome).toBe('incompatible');
    expect(fs.existsSync(m.marker)).toBe(false);
  });
});

describe('closure and owner compatibility', () => {
  it('the staged coordinator closure is the 4.7.20 file set plus entrypoint.mjs (no new module), and a fresh registration is ready', () => {
    // 4.7.20's EXECUTION_MODULES (git show v4.7.20:plugin/scripts/developer-update-policy.mjs), plus the 4.7.21 entry-point sweep.
    const v4720 = ['developer-update.mjs', 'developer-update-policy.mjs', 'developer-update-lock.mjs', 'developer-update-maintenance.mjs', 'developer-update-cleanup.mjs', 'plugin-artifact-proof.mjs'];
    expect([...EXECUTION_MODULES].sort()).toEqual([...v4720, 'entrypoint.mjs'].sort());
    const home = tmp(), brainHome = path.join(home, '.cache/ruvnet-brain');
    const record = installNightlyRunner({ brainHome, source: RUNNER, nodePath: process.execPath });
    expect(Object.keys(record.updateModules).sort()).toEqual([...new Set(['automatic-update.mjs', 'ruvnet-gate1-pattern.mjs', 'user-settings.mjs', 'developer-update-owner.mjs', ...v4720, 'entrypoint.mjs'])].sort());
    expect(developerCoordinatorOwner({ home, brainHome })).toMatchObject({ active: true, ready: true });
  });

  it('a config left by --disable-nightly with no registration owns nothing; an unreadable registration still refuses', () => {
    const home = tmp(), brainHome = path.join(home, '.cache/ruvnet-brain');
    atomic(path.join(brainHome, 'developer-update-config.json'), { schemaVersion: 1 });
    expect(developerCoordinatorOwner({ home, brainHome })).toEqual({ active: false, ready: false });
    fs.mkdirSync(path.join(brainHome, 'scheduler'), { recursive: true }); fs.writeFileSync(path.join(brainHome, 'scheduler/registration.json'), 'corrupt');
    expect(developerCoordinatorOwner({ home, brainHome })).toMatchObject({ active: true, ready: false });
  });
});

describe('SessionStart reads the coordinated suite receipt (AuditC #26)', () => {
  function coordinated(receiptPatch) {
    const home = tmp(), brainHome = path.join(home, '.cache/ruvnet-brain');
    const record = installNightlyRunner({ brainHome, source: RUNNER, nodePath: process.execPath });
    atomic(path.join(brainHome, 'kb/SOURCE.json'), { builtUtc: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    const sourceSnapshot = Object.fromEntries(Object.entries(record.updateModules).map(([n, v]) => [n, v.sha256]));
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    atomic(path.join(brainHome, 'scheduler/last-suite-attempt.json'), { schemaVersion: 1, kind: 'nightly-suite-update', mode: 'apply', scheduled: true,
      schedulerIdentity: record.identity, sourceSha256: sourceSnapshot['developer-update.mjs'], sourceSnapshot, startedAt: at, finishedAt: at, state: 'completed', ok: true, ...receiptPatch });
    return knowledgeCurrency({ env: { RUVNET_BRAIN_HOME: brainHome }, home });
  }
  it('knowledge current but the suite completed with failures: one line names it', () => {
    const line = coordinated({ state: 'completed-with-failures', ok: false, error: 'package ruflo: npm view ruflo: exit 1' });
    expect(line).toMatch(/KNOWLEDGE CURRENT, NIGHTLY SUITE FAILING\]/);
    expect(line).toContain('package ruflo: npm view ruflo');
    expect(line).toContain('last-suite-attempt.json');
  });
  it('a healthy suite stays silent', () => expect(coordinated({})).toBe(''));
});
