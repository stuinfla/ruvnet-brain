import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { automaticInvocation, automaticPath, installedUpdater, ownerSettingsPath, updateSource } from '../../plugin/scripts/automatic-update.mjs';

const roots = [];
function scratch() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-automatic-')); roots.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('owner automatic update authority', () => {
  const policy = input => ({ ok: ['latest', 'installed'].includes(input.updateSource), values: input });
  const writePolicy = (home, settings = { updateSource: 'installed' }, version = 1) => {
    fs.mkdirSync(path.dirname(ownerSettingsPath(home)), { recursive: true });
    fs.writeFileSync(ownerSettingsPath(home), JSON.stringify({ version, settings }), { mode: 0o600 });
  };
  it('captures the canonical policy once; a hypothetical second-read EIO cannot become latest', () => {
    const home = scratch(); writePolicy(home);
    const original = fs.readFileSync;
    const read = vi.fn((...args) => {
      if (read.mock.calls.length > 1) throw Object.assign(new Error('second read failed'), { code: 'EIO' });
      return original(...args);
    });
    expect(updateSource({ home, read, validatePolicy: policy })).toBe('installed');
    expect(read).toHaveBeenCalledTimes(1);
    expect(typeof read.mock.calls[0][0]).toBe('number'); // captured descriptor, not a re-opened path
  });
  it('refuses a failed captured read and never treats EIO as absence', () => {
    const home = scratch(); writePolicy(home);
    const read = vi.fn(() => { throw Object.assign(new Error('disk read failed'), { code: 'EIO' }); });
    expect(() => updateSource({ home, read, validatePolicy: policy })).toThrow(/unreadable/);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([null, [], {}, { version: 2, settings: { updateSource: 'installed' } }, { version: 1, settings: [] },
    { version: 1, settings: { updateSource: 'other' } }])('refuses malformed/foreign/future owner envelope %j', captured => {
    const home = scratch(); writePolicy(home);
    fs.writeFileSync(ownerSettingsPath(home), JSON.stringify(captured));
    expect(() => updateSource({ home, validatePolicy: policy })).toThrow(/unproven/);
  });
  it('refuses corrupt JSON, settings symlinks and writable foreign policy boundaries', () => {
    const home = scratch(); writePolicy(home);
    fs.writeFileSync(ownerSettingsPath(home), '{');
    expect(() => updateSource({ home, validatePolicy: policy })).toThrow(/invalid/);
    const target = path.join(home, 'project-settings.json'); fs.writeFileSync(target, '{"version":1,"settings":{"updateSource":"latest"}}');
    fs.unlinkSync(ownerSettingsPath(home)); fs.symlinkSync(target, ownerSettingsPath(home), 'file');
    expect(() => updateSource({ home, validatePolicy: policy })).toThrow(/symlink/);
    fs.unlinkSync(ownerSettingsPath(home)); writePolicy(home);
    fs.chmodSync(ownerSettingsPath(home), 0o666);
    if (typeof process.getuid === 'function') expect(() => updateSource({ home, validatePolicy: policy })).toThrow(/permissions/);
    else expect(updateSource({ home, validatePolicy: policy })).toBe('installed'); // Windows does not expose POSIX write bits as an ACL authority
  });
  it('an unreadable settings path is a refusal, not absence', () => {
    const home = scratch(); fs.mkdirSync(ownerSettingsPath(home), { recursive: true });
    expect(() => updateSource({ home })).toThrow(/regular file/);
  });
  it('missing owner settings retains the latest default', () => { expect(updateSource({ home: scratch() })).toBe('latest'); });
  it('installed mode resolves the owner global package declared bin and contains its entry', () => {
    const home = scratch();
    const root = path.join(home, '.npm-global', ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'ruvnet-brain');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ruvnet-brain', version: '4.5.9', bin: { 'ruvnet-brain': 'bin/install.mjs' } }));
    fs.writeFileSync(path.join(root, 'bin', 'install.mjs'), '// real owned entry fixture');
    const invocation = automaticInvocation(['--update'], { source: 'installed', home });
    expect(invocation).toMatchObject({ executable: process.execPath, args: [fs.realpathSync(path.join(root, 'bin', 'install.mjs')), '--update'], source: 'installed' });
    expect(invocation.installed.sha256).toMatch(/^[a-f0-9]{64}$/);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ruvnet-brain', bin: { 'ruvnet-brain': '../escape.mjs' } }));
    expect(() => installedUpdater({ home })).toThrow(/safe declared/);
  });
  it('missing installed package and conflicting proof target cannot fall back to npx', () => {
    const home = scratch();
    expect(() => automaticInvocation(['--update'], { source: 'installed', home })).toThrow();
    expect(() => automaticInvocation(['--update'], { source: 'installed', home, packageTarget: '/tmp/proof.tgz' })).toThrow(/proof tarball/);
  });
  it('tool PATH excludes inherited npx caches and project directories', () => {
    const home = scratch(); const poison = path.join(home, 'project', '.npm', '_npx', 'bad', 'bin');
    const env = { HOME: home, PATH: poison };
    const selected = automaticPath({ home, env });
    expect(selected).not.toContain(poison);
    expect(selected).toContain(path.join(home, '.npm-global', 'bin'));
    expect(selected).toContain(path.dirname(process.execPath));
  });
});

