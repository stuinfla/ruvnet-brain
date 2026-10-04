/**
 * `--uninstall` and `--what-changed` (issue: corporate-machine report, 2026-07-20).
 *
 * The user who found the consent bug had to reverse-engineer our footprint from a bug report to
 * work out what to delete. Nobody should ever be in that position: if we put it there, one command
 * takes it away, and another shows what "it" even is.
 *
 * This path DELETES FILES, including a surgical edit to a file we do not own, so the guarantees are
 * tested against real files rather than trusted: their CLAUDE.md content survives, only our marked
 * block is removed, and nothing outside our footprint is ever touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
const START = '<!-- ruvnet-brain:start -->';
const END = '<!-- ruvnet-brain:end -->';

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-test-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md');
const kbDir = () => path.join(home, '.cache', 'ruvnet-brain', 'kb');

function isolatedEnv(ambient) {
  const env = Object.fromEntries(Object.entries(ambient).filter(([key]) =>
    !/^(?:RUVNET_|CLAUDE_|CODEX_|XDG_)/i.test(key)));
  return { ...env, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    RUVNET_BRAIN_HOME: path.dirname(kbDir()), RUVNET_BRAIN_KB: kbDir(),
    RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain'),
    RUVNET_UPGRADE_NOTICE_FILE: path.join(home, '.config', 'ruvnet-brain', 'upgrade-notice.json'),
    RUVNET_BRAIN_TEST: '1' };
}

function run(args, ambient = process.env) {
  const res = spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: isolatedEnv(ambient),
  });
  expect(res.error, res.stderr || res.stdout).toBeUndefined();
  expect(res.signal, res.stderr || res.stdout).toBeNull();
  expect(res.status, res.stderr || res.stdout).toBe(0);
  return `${res.stdout || ''}${res.stderr || ''}`;
}

/** A machine that has everything we can install. */
function seedFullInstall() {
  fs.mkdirSync(kbDir(), { recursive: true });
  fs.writeFileSync(path.join(kbDir(), 'forge-ask.mjs'), '// stub');
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist'), '<plist/>');
  fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.spend-watchdog.plist'), '<plist/>');
  fs.mkdirSync(path.join(home, '.claude', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'scripts', 'api-spend-watchdog.mjs'), '// stub');
}

const USER_RULES = '# My rules\n\nAlways use tabs.\nNever deploy on Friday.\n';
const withBlock = () => `${USER_RULES}\n${START}\n## RuvNet Brain\nsome guidance\n${END}\n`;

// LaunchAgents are macOS-only BY DESIGN — machineFootprint() gates them on process.platform, and
// disableNightly()/disableSpendGuard() return early elsewhere. The first version of these tests
// asserted them unconditionally and went red on the Linux integration runner: the code was correct
// and the test was wrong. Gate the platform-specific assertions rather than weakening them, so they
// keep their teeth on macOS instead of being softened into something that passes everywhere.
const onMac = process.platform === 'darwin';

describe('--what-changed', () => {
  it('lists what is actually on disk, with an undo for each', () => {
    seedFullInstall();

    const out = run(['--what-changed']);

    expect(out).toMatch(/Brain bundle/);
    expect(out).toMatch(/--uninstall/);
    if (onMac) {
      expect(out).toMatch(/Nightly updater/);
      expect(out).toMatch(/Spend watchdog/);
    }
  });

  it('says so plainly when nothing is installed, rather than inventing a footprint', () => {
    const out = run(['--what-changed']);
    expect(out).toMatch(/Nothing from RuvNet Brain is currently installed/);
  });
});

describe('--uninstall', () => {
  it('ignores ambient owner paths while removing only the disposable install', () => {
    seedFullInstall();
    const foreign = path.join(home, 'foreign-owner');
    fs.mkdirSync(foreign);
    const reader = path.join(foreign, 'forge-ask.mjs');
    fs.writeFileSync(reader, 'owner knowledge must survive');
    const out = run(['--uninstall'], { ...process.env, RUVNET_BRAIN_KB: foreign,
      RUVNET_BRAIN_HOME: foreign, CODEX_HOME: foreign, CLAUDE_CONFIG_DIR: foreign,
      RUVNET_BRAIN_STATE_DIR: foreign, RUVNET_UPGRADE_NOTICE_FILE: reader,
      XDG_CACHE_HOME: foreign, XDG_CONFIG_HOME: foreign });
    expect(fs.existsSync(kbDir())).toBe(false);
    expect(fs.readFileSync(reader, 'utf8')).toBe('owner knowledge must survive');
    expect(out).not.toContain(foreign);
  });

  it('removes the whole footprint', () => {
    seedFullInstall();

    run(['--uninstall']);

    expect(fs.existsSync(kbDir()), 'KB bundle').toBe(false);
    if (onMac) {
      // The LaunchAgents and their script are only ever created — and therefore only ever
      // removed — on macOS.
      expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist'))).toBe(false);
      expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.spend-watchdog.plist'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.claude', 'scripts', 'api-spend-watchdog.mjs'))).toBe(false);
    }
  });

  it('takes ONLY our block out of CLAUDE.md and leaves their content intact', () => {
    seedFullInstall();
    fs.writeFileSync(claudeMd(), withBlock());

    run(['--uninstall']);

    const after = fs.readFileSync(claudeMd(), 'utf8');
    expect(after, 'our markers must be gone').not.toContain(START);
    expect(after).not.toContain(END);
    expect(after, 'their rules must survive').toContain('Always use tabs.');
    expect(after).toContain('Never deploy on Friday.');
    expect(after).toContain('# My rules');
  });

  it('backs CLAUDE.md up before editing it on the way out too', () => {
    seedFullInstall();
    fs.writeFileSync(claudeMd(), withBlock());

    run(['--uninstall']);

    const backups = fs.readdirSync(path.join(home, '.claude')).filter((n) => n.startsWith('CLAUDE.md.bak-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(home, '.claude', backups[0]), 'utf8')).toContain(START);
  });

  it('never touches a CLAUDE.md that has no block of ours', () => {
    seedFullInstall();
    fs.writeFileSync(claudeMd(), USER_RULES);

    run(['--uninstall']);

    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(USER_RULES);
    const backups = fs.readdirSync(path.join(home, '.claude')).filter((n) => n.startsWith('CLAUDE.md.bak-'));
    expect(backups.length, 'no edit means no backup churn').toBe(0);
  });

  it('leaves unrelated files and LaunchAgents completely alone', () => {
    seedFullInstall();
    const theirs = path.join(home, 'Library', 'LaunchAgents', 'com.someoneelse.job.plist');
    fs.writeFileSync(theirs, '<plist/>');
    const theirData = path.join(home, '.cache', 'something-else');
    fs.mkdirSync(theirData, { recursive: true });

    run(['--uninstall']);

    expect(fs.existsSync(theirs), "another tool's LaunchAgent").toBe(true);
    expect(fs.existsSync(theirData), "another tool's cache").toBe(true);
  });

  it('is safe to run when nothing is installed', () => {
    const out = run(['--uninstall']);
    expect(out).toMatch(/Nothing to remove/);
  });

  it('is idempotent', () => {
    seedFullInstall();
    run(['--uninstall']);
    const out = run(['--uninstall']);
    expect(out).toMatch(/Nothing to remove/);
  });
});
