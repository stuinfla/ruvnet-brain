import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { installTerminalLaunchers, runTerminalLauncher } from '../../scripts/model-terminal-launchers.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const dirs = [];
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-entry-'))); dirs.push(home);
  const native = path.join(home, 'native'), log = path.join(home, 'native.json');
  fs.writeFileSync(native, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),api:process.env.OPENAI_API_KEY,claudeApi:process.env.ANTHROPIC_API_KEY}));process.exit(7);\n`, { mode: 0o755 });
  const options = { home, realCodex: native, realClaude: native, runtimeRoot: root, runtimeDigest: 'a'.repeat(64), manageZsh: false };
  return { home, native, log, options, env: { ...process.env, PATH: `${home}/.local/bin:/usr/bin:/bin`, OPENAI_API_KEY: 'removed', ANTHROPIC_API_KEY: 'removed' } };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('canonical native terminal executable entries', () => {
  it('plans canonical commands without touching the native binary or existing locator', () => {
    const f = fixture(), file = path.join(f.home, '.local/bin/codex'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(f.native, file);
    const planned = installTerminalLaunchers(f.options);
    expect(planned.canonicalEntries).toEqual({ codex: file, claude: path.join(f.home, '.local/bin/claude') });
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true); expect(fs.existsSync(planned.configPath)).toBe(false);
  });
  it('replaces only the matching native locator, preserves its target and backup, and is idempotent', () => {
    const f = fixture(), file = path.join(f.home, '.local/bin/codex'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(f.native, file);
    const before = fs.readFileSync(f.native), installed = installTerminalLaunchers({ ...f.options, apply: true });
    expect(fs.lstatSync(file).isFile()).toBe(true); expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    expect(installed.config.realCodex).toBe(f.native); expect(fs.readFileSync(f.native)).toEqual(before);
    expect(installed.backups.some(p => fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p) === f.native)).toBe(true);
    expect(installTerminalLaunchers({ ...f.options, apply: true }).canonicalEntries).toEqual(installed.canonicalEntries);
    expect(installTerminalLaunchers({ ...f.options, realCodex: undefined, apply: true }).config.realCodex).toBe(f.native);
    expect(fs.readFileSync(f.native)).toEqual(before);
  });
  it.each(['codex', 'claude'])('real /bin/sh command %s and direct subprocess preserve admin args/status, strip API keys, and use the managed entry', host => {
    const f = fixture(), installed = installTerminalLaunchers({ ...f.options, apply: true });
    const args = host === 'codex' ? ['login', 'status', "spaces ' $literal"] : ['--permission-mode', 'bypassPermissions', '--version'];
    const direct = spawnSync(host, args, { env: f.env, encoding: 'utf8', cwd: os.tmpdir() });
    expect(direct.status).toBe(7); expect(JSON.parse(fs.readFileSync(f.log))).toEqual({ args });
    fs.unlinkSync(f.log);
    const shell = spawnSync('/bin/sh', ['-c', 'command "$0" "$@"', host, ...args], { env: f.env, encoding: 'utf8', cwd: os.tmpdir() });
    expect(shell.status).toBe(7); expect(JSON.parse(fs.readFileSync(f.log))).toEqual({ args });
    expect(fs.readFileSync(installed.canonicalEntries[host], 'utf8')).toContain('model-terminal-launchers.mjs');
  });
  it('canonical Codex exec cannot reach a raw native subprocess; literal -- admin-looking prompt still routes/refuses', () => {
    const f = fixture(); installTerminalLaunchers({ ...f.options, apply: true });
    for (const args of [['exec', 'hello'], ['--', 'login']]) {
      const result = spawnSync('codex', args, { env: { ...f.env, CODEX_HOME: path.join(f.home, 'missing') }, encoding: 'utf8' });
      expect(result.status).toBe(1); expect(result.stderr).toContain('[native-terminal-routing]');
      // Exec is refused; a literal interactive prompt also refuses without a TTY.
      // Neither may fall back to a raw native process or the retired daemon path.
      expect(fs.existsSync(f.log)).toBe(false);
    }
  });
  it('refuses unrelated symlinks, unmanaged scripts, and same-path native files before mutation', () => {
    const f = fixture(), file = path.join(f.home, '.local/bin/codex'); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(process.execPath, file);
    expect(() => installTerminalLaunchers({ ...f.options, apply: true, replaceCanonicalEntries: ['codex'] })).toThrow(/unrelated/);
    fs.unlinkSync(file); fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const before = fs.readFileSync(file);
    expect(() => installTerminalLaunchers({ ...f.options, apply: true })).toThrow(/unmanaged canonical/);
    expect(() => installTerminalLaunchers({ ...f.options, realCodex: file, apply: true, replaceCanonicalEntries: ['codex'] })).toThrow(/Separate native/);
    expect(fs.readFileSync(file)).toEqual(before); expect(fs.existsSync(path.join(f.home, '.cache'))).toBe(false);
  });
  it('explicit migration backs up an owned legacy wrapper and preserves owner aliases', () => {
    const f = fixture(), file = path.join(f.home, '.local/bin/claude'); fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '#!/bin/sh\nexec owner-native "$@"\n'; fs.writeFileSync(file, original, { mode: 0o755 });
    const alias = 'alias claude="owner --permission-mode bypassPermissions"\n'; fs.writeFileSync(path.join(f.home, '.zshrc'), alias);
    const receipt = installTerminalLaunchers({ ...f.options, apply: true, manageZsh: true, replaceCanonicalEntries: ['claude'] });
    expect(receipt.backups.some(p => !fs.lstatSync(p).isSymbolicLink() && fs.readFileSync(p, 'utf8') === original)).toBe(true);
    expect(fs.readFileSync(path.join(f.home, '.zshrc'), 'utf8')).toContain(alias);
    expect(receipt.shellConflicts).toEqual(['claude']);
  });
  it('refuses a stored real binary pointing at either managed canonical entry rather than recursing', async () => {
    const f = fixture(), receipt = installTerminalLaunchers({ ...f.options, apply: true });
    const bad = { ...receipt.config, realCodex: receipt.canonicalEntries.codex, realClaude: receipt.canonicalEntries.claude };
    for (const host of ['codex', 'claude']) {
      await expect(runTerminalLauncher({ host, args: ['--version'], config: bad, env: {}, signalSource: new EventEmitter() })).rejects.toThrow(/recursion/);
    }
    expect(() => installTerminalLaunchers({ ...f.options, realCodex: receipt.canonicalEntries.codex })).toThrow(/recursion/);
    expect(fs.existsSync(f.log)).toBe(false);
  });
});
