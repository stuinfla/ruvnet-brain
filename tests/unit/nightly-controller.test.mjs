import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyNightlyChoice, nightlyStatus } from '../../scripts/nightly-controller.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REAL_INSTALLER = path.join(ROOT, 'bin', 'install.mjs');

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-control-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const installer = path.join(root, 'install.mjs');
  fs.writeFileSync(installer, `import fs from 'node:fs'; import path from 'node:path';
const file = path.join(process.env.HOME, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
if (process.argv.includes('--enable-nightly')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<plist/>');
} else if (process.argv.includes('--disable-nightly')) {
  fs.rmSync(file, { force: true });
} else process.exit(2);
`);
  return { root, home, installer, env: { ...process.env, HOME: home } };
}

describe('nightly controller delegates to the installer scheduler', () => {
  it('derives off/on from the real scheduler artifact and proves both transitions', () => {
    const f = fixture();
    expect(nightlyStatus({ env: f.env, platform: 'darwin' }).state).toBe('off');
    const on = applyNightlyChoice(true, { env: f.env, platform: 'darwin', installer: f.installer });
    expect(on.ok).toBe(true);
    expect(on.after.state).toBe('on');
    const off = applyNightlyChoice(false, { env: f.env, platform: 'darwin', installer: f.installer });
    expect(off.ok).toBe(true);
    expect(off.after.state).toBe('off');
  });

  it('refuses unsupported platforms instead of claiming a printed cron recipe is a live control', () => {
    const f = fixture();
    const result = applyNightlyChoice(true, { env: f.env, platform: 'linux', installer: f.installer });
    expect(result.ok).toBe(false);
    expect(result.state.state).toBe('unsupported');
    expect(fs.existsSync(path.join(f.home, 'Library'))).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('keeps a console fixture disable inside its explicit root and never calls launchctl', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-nightly-real-door-'));
    roots.push(root);
    const liveHome = path.join(root, 'live-home');
    const consoleRoot = path.join(root, 'console-root');
    const kb = path.join(consoleRoot, '.cache', 'ruvnet-brain', 'kb');
    const bin = path.join(root, 'bin');
    const launchctlLog = path.join(root, 'launchctl.log');
    const livePlist = path.join(liveHome, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
    const fixturePlist = path.join(consoleRoot, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
    fs.mkdirSync(path.dirname(livePlist), { recursive: true });
    fs.mkdirSync(path.dirname(fixturePlist), { recursive: true });
    fs.mkdirSync(kb, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(livePlist, 'live-sentinel\n');
    fs.writeFileSync(fixturePlist, 'fixture-sentinel\n');
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// test fixture\n');
    fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${launchctlLog}"\n+exit 99\n`);
    fs.chmodSync(path.join(bin, 'launchctl'), 0o755);

    const env = {
      ...process.env,
      HOME: liveHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUVNET_BRAIN_KB: kb,
      RUVNET_BRAIN_TEST: '1',
      RUVNET_CONSOLE_ROOT: consoleRoot,
    };
    const result = applyNightlyChoice(false, {
      env,
      platform: 'darwin',
      installer: REAL_INSTALLER,
      cwd: ROOT,
    });

    expect(result.ok).toBe(true);
    expect(result.before.artifact.path).toBe(fixturePlist);
    expect(result.after.state).toBe('off');
    expect(fs.readFileSync(livePlist, 'utf8')).toBe('live-sentinel\n');
    expect(fs.existsSync(fixturePlist)).toBe(false);
    expect(fs.existsSync(launchctlLog)).toBe(false);
  });
});
