/**
 * The installer's spend-guard offer must never clobber an existing watchdog or add a second hourly job.
 *
 * Before 4.7.21 (audit D-opus P0, verified): enableSpendGuard() copied the bundled watchdog OVER
 * ~/.claude/scripts/api-spend-watchdog.mjs unconditionally, and offerSpendGuard() recognised only its own label
 * (com.ruvnet.spend-watchdog). On the owner's Mac, whose fixed copy runs as com.stuartkerr.api-spend-watchdog, one
 * interactive `npx ruvnet-brain` would have reverted the 2026-10-25 flood fix AND scheduled a second hourly job.
 *
 * Every case runs the real installer in a child process with a throwaway HOME. RUVNET_BRAIN_TEST=1 wherever the
 * code could reach launchctl (it then writes the plist only); the offer case without it reads files and, with no
 * terminal, installs nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
const SHIPPED = path.join(ROOT, 'bin', 'api-spend-watchdog.mjs');
const onMac = process.platform === 'darwin';
let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-guard-install-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const script = () => path.join(home, '.claude', 'scripts', 'api-spend-watchdog.mjs');
const ourPlist = () => path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.spend-watchdog.plist');
const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || os.tmpdir(),
  RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'), ...extra });
const cli = (...args) => {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8', timeout: 60_000, cwd: home,
    env: env({ RUVNET_BRAIN_TEST: '1' }) });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const offer = (extraEnv = {}) => {
  const runner = path.join(home, 'runner.mjs');
  fs.writeFileSync(runner, `const m = await import(${JSON.stringify(INSTALLER)});\nprocess.stdout.write('RESULT:' + String(await m.offerSpendGuard()));\n`);
  const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 60_000, cwd: home,
    input: '', env: env({ RUVNET_BRAIN_IMPORT_ONLY: '1', ...extraEnv }) });
  return (`${r.stdout}`.match(/RESULT:(\S+)/) || [])[1];
};
/** The owner's own job: a different label whose ProgramArguments run the watchdog. */
function ownersAgent({ binary = false } = {}) {
  const dir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'com.stuartkerr.api-spend-watchdog.plist');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.stuartkerr.api-spend-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>${script()}</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
</dict>
</plist>
`);
  if (binary) expect(spawnSync('plutil', ['-convert', 'binary1', file]).status).toBe(0);
  return file;
}
const ownersScript = '// the owner\'s own fixed watchdog\n';
const plantScript = (text) => { fs.mkdirSync(path.dirname(script()), { recursive: true }); fs.writeFileSync(script(), text); };

describe('--enable-spend-guard never clobbers or duplicates', () => {
  it('an existing destination with different content is kept byte-for-byte', () => {
    plantScript(ownersScript);
    const r = cli('--enable-spend-guard');
    expect(fs.readFileSync(script(), 'utf8')).toBe(ownersScript); // before: replaced by the shipped flooding copy
    expect(r.out).toMatch(/kept your existing/);
  });

  it('a fresh machine still gets the shipped script and the job (regression)', () => {
    const r = cli('--enable-spend-guard');
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(script())).toEqual(fs.readFileSync(SHIPPED));
    expect(fs.readFileSync(ourPlist(), 'utf8')).toContain(`<string>${script()}</string>`);
  });

  it('an identical existing copy is left as is and the job is written', () => {
    plantScript(fs.readFileSync(SHIPPED, 'utf8'));
    const r = cli('--enable-spend-guard');
    expect(r.out).toMatch(/already current/);
    expect(fs.existsSync(ourPlist())).toBe(true);
  });

  it('an existing LaunchAgent under another label that runs the watchdog: no second hourly job', () => {
    ownersAgent();
    plantScript(ownersScript);
    const r = cli('--enable-spend-guard');
    expect(fs.existsSync(ourPlist())).toBe(false); // before: com.ruvnet.spend-watchdog.plist added beside it
    expect(fs.readFileSync(script(), 'utf8')).toBe(ownersScript);
    expect(r.out).toMatch(/already installed as .*com\.stuartkerr\.api-spend-watchdog/);
  });

  it.skipIf(!onMac)('a binary plist is read too', () => {
    ownersAgent({ binary: true });
    cli('--enable-spend-guard');
    expect(fs.existsSync(ourPlist())).toBe(false);
  });
});

describe.skipIf(!onMac)('the end-of-install offer recognises any label', () => {
  it('reports already-on for com.stuartkerr.api-spend-watchdog (no terminal, real offer path)', () => {
    ownersAgent();
    expect(offer()).toBe('already-on'); // before: 'recommended' — it would offer a duplicate job
  });

  it('reports already-on under RUVNET_BRAIN_TEST too', () => {
    ownersAgent();
    expect(offer({ RUVNET_BRAIN_TEST: '1' })).toBe('already-on');
  });

  it('a clean machine is still offered (no false already-on)', () => {
    expect(offer()).toBe('recommended');
    expect(fs.existsSync(ourPlist())).toBe(false);
  });
});

describe.skipIf(!onMac)('--disable-spend-guard', () => {
  it('removes our job but keeps a script another LaunchAgent runs', () => {
    ownersAgent();
    plantScript(ownersScript);
    fs.mkdirSync(path.dirname(ourPlist()), { recursive: true });
    fs.writeFileSync(ourPlist(), '<plist/>');
    const r = cli('--disable-spend-guard');
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(ourPlist())).toBe(false);
    expect(fs.readFileSync(script(), 'utf8')).toBe(ownersScript); // before: deleted out from under the owner's job
  });
});
