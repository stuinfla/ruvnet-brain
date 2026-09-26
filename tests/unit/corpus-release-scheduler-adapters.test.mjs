/**
 * ADR-086 step 16, last clause: "Exercise the existing launchd, cron and Task Scheduler adapters,
 * including explicit noninteractive enablement."
 *
 * EXERCISE, not rebuild. The adapters in plugin/scripts/nightly-scheduler.mjs are unchanged by step
 * 16; what step 16 changes is the updater those adapters run every night. So this file asks the two
 * questions that the corpus work could actually have broken, and answers them by driving the real
 * code rather than by reading it:
 *
 *   1. Do all three platform adapters still complete a full install -> status:on -> remove ->
 *      status:off cycle? (Adapters are selected by platform, so all three are driven here with the
 *      module's own test-mode fixture runner — no machine scheduler is ever invoked.)
 *   2. Does `--enable-nightly` still work with NO TERMINAL? That is the flag's entire reason for
 *      existing: bin/install.mjs:4295 refuses to PROMPT without a TTY, and the flag is the
 *      documented way an unattended install still ends up scheduled. A spawned child has no TTY, so
 *      this is the real door, not a simulation of it — and it is the door ADR-086 step 18's
 *      unattended corpus promotion depends on.
 *
 * The child is pointed at a temp HOME and a temp KB throughout, and RUVNET_BRAIN_TEST=1 keeps OS
 * activation simulated, so nothing here can touch the developer's real launchd domain.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  NIGHTLY_LABEL, installNightlyRunner, installScheduler, removeScheduler, schedulerStatus,
} from '../../plugin/scripts/nightly-scheduler.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'step16-sched-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const brainHome = path.join(root, 'brain');
  const kbDir = path.join(brainHome, 'kb');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(kbDir, { recursive: true });
  // The updater the nightly job runs. enableNightly() refuses outright if it is not there.
  fs.copyFileSync(path.join(ROOT, 'kb', 'forge-update.mjs'), path.join(kbDir, 'forge-update.mjs'));
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: kbDir, RUVNET_BRAIN_TEST: '1' };
  return { root, home, brainHome, kbDir, env };
}

describe('the three scheduler adapters still complete a full lifecycle', () => {
  it.each(['darwin', 'linux', 'win32'])('%s: install -> on -> remove -> off', (platform) => {
    const f = fixture();
    const record = installNightlyRunner({ brainHome: f.brainHome, env: f.env,
      source: path.join(ROOT, 'bin', 'nightly-refresh.mjs') });
    expect(record.runnerSha256).toBe(
      crypto.createHash('sha256').update(fs.readFileSync(record.runnerPath)).digest('hex'));

    const options = { platform, env: f.env, brainHome: f.brainHome, kbDir: f.kbDir,
      testMode: true, pathValue: '/usr/bin:/bin' };

    expect(schedulerStatus(options).state, 'nothing is scheduled before we schedule it').toBe('off');
    const installed = installScheduler(record, options);
    expect(installed.ok, installed.why).toBe(true);
    expect(installed.artifact.kind).toBe(
      { darwin: 'launchd', linux: 'cron', win32: 'task-scheduler' }[platform]);

    const on = schedulerStatus(options);
    expect(on.state, on.evidence).toBe('on');
    expect(on.evidence).toBeTruthy();

    expect(removeScheduler({ platform, env: f.env, testMode: true }).ok).toBe(true);
    expect(schedulerStatus(options).state).toBe('off');
  });

  // A guard that cannot fail on broken code is not a guard: corrupt the registered runner and the
  // status must refuse to call itself healthy, on every adapter.
  it.each(['darwin', 'linux', 'win32'])('%s: a tampered runner is never reported as on', (platform) => {
    const f = fixture();
    const record = installNightlyRunner({ brainHome: f.brainHome, env: f.env,
      source: path.join(ROOT, 'bin', 'nightly-refresh.mjs') });
    const options = { platform, env: f.env, brainHome: f.brainHome, kbDir: f.kbDir,
      testMode: true, pathValue: '/usr/bin:/bin' };
    expect(installScheduler(record, options).ok).toBe(true);
    expect(schedulerStatus(options).state).toBe('on');

    fs.appendFileSync(record.runnerPath, '\n// tampered\n');

    const after = schedulerStatus(options);
    expect(after.state, 'a changed runner is not the runner that was registered').not.toBe('on');
    expect(after.evidence).toMatch(/digest/i);
  });
});

describe('explicit noninteractive --enable-nightly (no TTY)', () => {
  it('schedules and then unschedules through the real installer with no terminal attached', () => {
    const f = fixture();
    // A spawned child has no TTY. bin/install.mjs:4295 will not PROMPT here, so if the job gets
    // scheduled at all it is because the explicit flag authorized it — which is the whole contract.
    const enable = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--enable-nightly'],
      { cwd: f.root, encoding: 'utf8', env: f.env, timeout: 120_000 });
    const enableOut = `${enable.stdout}${enable.stderr}`;

    expect(enableOut).toContain('nightly updates enabled');
    expect(enableOut, 'the identity and immutable runner digest are part of the receipt').toContain(NIGHTLY_LABEL);
    expect(enable.status, enableOut).toBe(0);

    // Read back from the machine state, not from the message that claimed it.
    const status = schedulerStatus({ platform: process.platform, env: f.env,
      brainHome: f.brainHome, kbDir: f.kbDir, testMode: true });
    expect(status.state, status.evidence).toBe('on');

    const disable = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--disable-nightly'],
      { cwd: f.root, encoding: 'utf8', env: f.env, timeout: 120_000 });
    expect(`${disable.stdout}${disable.stderr}`).toMatch(/nightly updates (disabled|were already off)/);
    expect(disable.status).toBe(0);
    expect(schedulerStatus({ platform: process.platform, env: f.env,
      brainHome: f.brainHome, kbDir: f.kbDir, testMode: true }).state).toBe('off');
  }, 180_000);

  it('refuses to schedule a job pointed at a brain with no updater, rather than scheduling a no-op', () => {
    const f = fixture();
    fs.rmSync(path.join(f.kbDir, 'forge-update.mjs'));

    const enable = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--enable-nightly'],
      { cwd: f.root, encoding: 'utf8', env: f.env, timeout: 120_000 });

    expect(enable.status, `${enable.stdout}${enable.stderr}`).toBe(1);
    expect(schedulerStatus({ platform: process.platform, env: f.env,
      brainHome: f.brainHome, kbDir: f.kbDir, testMode: true }).state).toBe('off');
  }, 180_000);
});
