// The nightly LaunchAgent runs a content-addressed SNAPSHOT of the update modules (installNightlyRunner). Until this
// change only --enable-nightly refreshed it: measured 2026-10-22, the 4.7.15 developer-update fix shipped to disk and
// the 03:30 job still ran the old module (sha 23f1f04c) and failed again. --update must re-point the registration at
// the installed modules itself, without touching what the LaunchAgent reads; a changed RUNNER is an advisory only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installNightlyRunner, installScheduler, readNightlyRegistration, nightlyModuleCurrency, refreshNightlyModules,
  NIGHTLY_ENABLE_FIX, NIGHTLY_UPDATE_FIX } from '../../plugin/scripts/nightly-scheduler.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPTS = path.join(ROOT, 'plugin', 'scripts');
const RUNNER = path.join(ROOT, 'bin', 'nightly-refresh.mjs');
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p))); roots.push(d); return d; };

/** A copy of plugin/scripts whose developer-update.mjs is one fix older, so a registration made from it is stale. */
function oldScripts() {
  const dir = tmp('old-scripts-');
  fs.cpSync(SCRIPTS, dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'developer-update.mjs'), '\n// previous generation of this module\n');
  return dir;
}
const digestOf = (record) => path.basename(path.dirname(record.updateModules['automatic-update.mjs'].path)).replace('update-modules-', '');
const scalar = (record) => JSON.stringify([record.identity, record.nodePath, record.runnerPath, record.runnerSha256, record.argv, record.environment, record.packageTarget, record.bundleTarget, record.mode]);

/** A Brain home whose nightly registration was made from OLD modules (and optionally an older runner). */
function staleWorld({ runnerSource = RUNNER } = {}) {
  const home = tmp('nmr-home-'); const brainHome = path.join(home, '.cache', 'ruvnet-brain'); const kb = path.join(brainHome, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// fixture self-updater: exit 0 = applied\nprocess.exit(0);\n');
  const env = { HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: kb, PATH: process.env.PATH };
  const registration = installNightlyRunner({ brainHome, source: runnerSource, nodePath: process.execPath, env, moduleSource: oldScripts() });
  return { home, brainHome, kb, env, registration };
}

describe('nightlyModuleCurrency reads the registration against the installed module set', () => {
  it('stale registration → stale with the --update fix; refreshed → current; runner drift → runner-changed with the --enable-nightly fix', () => {
    const w = staleWorld();
    const before = nightlyModuleCurrency({ brainHome: w.brainHome, runnerSource: RUNNER });
    expect(before.state).toBe('stale');
    expect(before.fix).toBe(NIGHTLY_UPDATE_FIX);
    expect(before.registered).toBe(digestOf(w.registration));
    const refreshed = refreshNightlyModules({ brainHome: w.brainHome, runnerSource: RUNNER });
    expect(refreshed.state).toBe('refreshed');
    expect(refreshed.registered).toBe(before.current);
    const after = readNightlyRegistration({ brainHome: w.brainHome });
    expect(after.ok, after.why).toBe(true);
    expect(digestOf(after.record)).toBe(before.current);
    expect(scalar(after.record)).toBe(scalar(w.registration)); // nothing the LaunchAgent reads changed
    expect(nightlyModuleCurrency({ brainHome: w.brainHome, runnerSource: RUNNER }).state).toBe('current');
    // A changed runner is never applied from here: the LaunchAgent command would change.
    const otherRunner = path.join(tmp('runner-'), 'nightly-refresh.mjs');
    fs.writeFileSync(otherRunner, `${fs.readFileSync(RUNNER, 'utf8')}\n// next runner\n`);
    const drift = nightlyModuleCurrency({ brainHome: w.brainHome, runnerSource: otherRunner });
    expect(drift.state).toBe('runner-changed');
    expect(drift.fix).toBe(NIGHTLY_ENABLE_FIX);
    expect(refreshNightlyModules({ brainHome: w.brainHome, runnerSource: otherRunner }).state).toBe('runner-changed');
    expect(readNightlyRegistration({ brainHome: w.brainHome }).record).toEqual(after.record);
  });

  it('never overwrites a module whose bytes differ from its content address', () => {
    const w = staleWorld();
    const current = nightlyModuleCurrency({ brainHome: w.brainHome, runnerSource: RUNNER }).current;
    const target = path.join(w.brainHome, 'scheduler', `update-modules-${current}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'automatic-update.mjs'), '// tampered\n');
    expect(() => refreshNightlyModules({ brainHome: w.brainHome, runnerSource: RUNNER })).toThrow(/immutable update module was changed/);
    expect(digestOf(readNightlyRegistration({ brainHome: w.brainHome }).record)).toBe(digestOf(w.registration)); // left as it was
    expect(fs.readFileSync(path.join(target, 'automatic-update.mjs'), 'utf8')).toBe('// tampered\n');
  });

  it('an older registration WITHOUT an environment field is refreshed byte-identical except updateModules — never rewritten with {}', () => {
    const w = staleWorld();
    const stripped = JSON.parse(fs.readFileSync(w.registration.recordPath, 'utf8'));
    delete stripped.environment;
    fs.writeFileSync(w.registration.recordPath, `${JSON.stringify(stripped, null, 2)}\n`);
    expect(readNightlyRegistration({ brainHome: w.brainHome }).ok).toBe(true);
    const result = refreshNightlyModules({ brainHome: w.brainHome, runnerSource: RUNNER });
    expect(result.state).toBe('refreshed');
    const after = JSON.parse(fs.readFileSync(w.registration.recordPath, 'utf8'));
    expect(after).not.toHaveProperty('environment');
    const { updateModules: _a, ...restAfter } = after; const { updateModules: _b, ...restBefore } = stripped;
    expect(JSON.stringify(restAfter)).toBe(JSON.stringify(restBefore)); // same fields, same order, same bytes
    expect(digestOf(after)).toBe(result.registered);
  });

  it('a candidate that would change a scheduler-visible field is refused BEFORE any write: the file is byte-identical afterwards', () => {
    const w = staleWorld();
    const before = fs.readFileSync(w.registration.recordPath);
    const schedulerDir = fs.readdirSync(path.join(w.brainHome, 'scheduler')).sort();
    const build = (plan) => ({ ...installNightlyRunner({ ...plan, dryRun: true }), nodePath: '/other/node' });
    const result = refreshNightlyModules({ brainHome: w.brainHome, runnerSource: RUNNER, build });
    expect(result.state).toBe('refused');
    expect(result.reason).toMatch(/would change nodePath/);
    expect(result.fix).toBe(NIGHTLY_ENABLE_FIX);
    expect(fs.readFileSync(w.registration.recordPath).equals(before)).toBe(true);
    expect(fs.readdirSync(path.join(w.brainHome, 'scheduler')).sort()).toEqual(schedulerDir); // no new update-modules dir either
  });

  it('no registration → unregistered, nothing written', () => {
    const brainHome = tmp('nmr-none-');
    expect(nightlyModuleCurrency({ brainHome, runnerSource: RUNNER }).state).toBe('unregistered');
    expect(refreshNightlyModules({ brainHome, runnerSource: RUNNER }).state).toBe('unregistered');
    expect(fs.existsSync(path.join(brainHome, 'scheduler'))).toBe(false);
  });
});

// The installer's own post-update step (bin/install.mjs reconcileNightlyModules, the function runUpdate calls), driven
// from a separate process. The full `--update` cannot run here: placeUpdater() re-installs the real kb/forge-update.mjs,
// which needs a reachable release manifest.
const reconcile = (w) => {
  const code = `import { reconcileNightlyModules } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'bin', 'install.mjs')).href)};
    process.stdout.write('\\n@@' + JSON.stringify(reconcileNightlyModules({ brainHome: ${JSON.stringify(w.brainHome)} })));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000, cwd: w.home,
    env: { ...w.env, TMPDIR: process.env.TMPDIR || os.tmpdir(), RUVNET_BRAIN_TEST: '1' } });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return { out: `${r.stdout}\n${r.stderr}`, result: JSON.parse(r.stdout.split('\n@@').pop()) };
};

describe.skipIf(process.platform === 'win32')('the installer\'s post-update step re-points a stale registration and leaves the scheduler artifact alone (process boundary)', () => {
  it('stale modules: registration now names the installed set, scalar fields unchanged, plist untouched, advisory PASS', () => {
    const w = staleWorld();
    const installed = installScheduler(w.registration, { platform: process.platform, env: w.env, kbDir: w.kb, testMode: true, pathValue: process.env.PATH });
    expect(installed.ok, installed.why).toBe(true);
    const plist = process.platform === 'darwin' ? path.join(w.home, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist') : null;
    const plistBefore = plist ? fs.readFileSync(plist) : null;
    const { out, result } = reconcile(w);
    expect(out).toMatch(/nightly scheduler now runs the installed update modules/);
    expect(result).toMatchObject({ status: 'PASS', state: 'refreshed' });
    const after = readNightlyRegistration({ brainHome: w.brainHome });
    expect(after.ok, after.why).toBe(true);
    expect(digestOf(after.record)).toBe(nightlyModuleCurrency({ brainHome: w.brainHome, runnerSource: RUNNER }).current);
    expect(digestOf(after.record)).not.toBe(digestOf(w.registration));
    expect(scalar(after.record)).toBe(scalar(w.registration));
    if (plist) expect(fs.readFileSync(plist).equals(plistBefore)).toBe(true);
    expect(fs.existsSync(path.join(w.brainHome, 'scheduler', `update-modules-${digestOf(w.registration)}`))).toBe(true); // old snapshot kept (immutable)
  }, 60_000);

  it('runner changed: the registration is NOT rewritten, the step names the --enable-nightly fix, advisory SKIP', () => {
    const otherRunner = path.join(tmp('runner-'), 'nightly-refresh.mjs');
    fs.writeFileSync(otherRunner, `${fs.readFileSync(RUNNER, 'utf8')}\n// older runner generation\n`);
    const w = staleWorld({ runnerSource: otherRunner });
    const recordBefore = fs.readFileSync(w.registration.recordPath, 'utf8');
    const { out, result } = reconcile(w);
    expect(out).toMatch(/nightly scheduler runs an older runner/);
    expect(out).toContain(NIGHTLY_ENABLE_FIX);
    expect(result).toMatchObject({ status: 'SKIP', state: 'runner-changed', fix: NIGHTLY_ENABLE_FIX });
    expect(fs.readFileSync(w.registration.recordPath, 'utf8')).toBe(recordBefore);
  }, 60_000);

  it('a failure inside the step is an advisory FAIL, never a thrown error', () => {
    const w = staleWorld();
    const current = nightlyModuleCurrency({ brainHome: w.brainHome, runnerSource: RUNNER }).current;
    fs.mkdirSync(path.join(w.brainHome, 'scheduler', `update-modules-${current}`), { recursive: true });
    fs.writeFileSync(path.join(w.brainHome, 'scheduler', `update-modules-${current}`, 'automatic-update.mjs'), '// tampered\n');
    const { out, result } = reconcile(w);
    expect(out).toMatch(/nightly module snapshot was not refreshed/);
    expect(result).toMatchObject({ status: 'FAIL', state: 'error' });
  }, 60_000);
});
