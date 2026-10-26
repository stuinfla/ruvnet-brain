import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { automaticInvocation, automaticPath, installedUpdater, ownerSettingsPath, saveUpdateSource, updateSource } from '../../plugin/scripts/automatic-update.mjs';
import { installNightlyRunner } from '../../plugin/scripts/nightly-scheduler.mjs';

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


// Opus review #1 (4.7.21): the SessionStart self-heal passed --knowledge-only to the REGISTERED coordinator snapshot,
// which moves only when an --update reconciles it (never on runner-changed). A 4.7.20 snapshot refuses the flag
// ("unsupported developer update argument", exit 1), so every knowledge self-heal on those machines recorded FAILED.
describe('coordinated self-heal against an older registered coordinator', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const current = fs.readFileSync(path.join(ROOT, 'plugin/scripts/developer-update.mjs'), 'utf8');
  // The real 4.7.20 coordinator when the tag is in this clone (CI checks out full history); the derived copy always runs.
  const tagged = spawnSync('git', ['show', 'v4.7.20:plugin/scripts/developer-update.mjs'], { cwd: ROOT, encoding: 'utf8' });
  const derived = current.replace(/\n\s*if \(args\[i\] === '--knowledge-only'\) knowledgeOnly = true;\n\s*else /, '\n    ');
  const register = (source) => {
    // Real path: 4.7.20's main guard compares argv[1] with import.meta.url literally (macOS /var -> /private/var).
    const home = fs.realpathSync(scratch()); const brainHome = path.join(home, '.cache/ruvnet-brain');
    const record = installNightlyRunner({ brainHome, source: path.join(ROOT, 'bin/nightly-refresh.mjs'), nodePath: process.execPath });
    const entry = record.updateModules['developer-update.mjs'].path;
    if (source !== undefined) {
      fs.writeFileSync(entry, source);
      const registration = JSON.parse(fs.readFileSync(record.recordPath, 'utf8'));
      registration.updateModules['developer-update.mjs'].sha256 = crypto.createHash('sha256').update(source).digest('hex');
      fs.writeFileSync(record.recordPath, JSON.stringify(registration));
    }
    return { home, entry };
  };

  it('the derived old coordinator really lacks the flag, and the current one really has it', () => {
    expect(derived).not.toBe(current);
    expect(derived.includes("'--knowledge-only'")).toBe(false);
    expect(current.includes("'--knowledge-only'")).toBe(true);
  });

  it.each([['4.7.20 (git tag)', 'tagged'], ['derived pre-flag copy', 'derived']])('%s: the self-heal asks it for --apply only', (_label, kind) => {
    if (kind === 'tagged' && tagged.status !== 0) { expect(tagged.stderr).toMatch(/v4\.7\.20|unknown revision|not a git repository/); return; }
    const old = kind === 'tagged' ? tagged.stdout : derived;
    const { home, entry } = register(old);
    const invocation = automaticInvocation(['--update', '--no-nightly-prompt'], { home });
    expect(invocation.source).toBe('developer-suite');
    expect(invocation.args).toEqual([entry, '--apply']); // before: [entry, '--apply', '--knowledge-only']
    // The premise, executed: the registered old coordinator refuses the flag before doing anything.
    const refused = spawnSync(process.execPath, [entry, '--knowledge-only'], { encoding: 'utf8', timeout: 30_000,
      env: { HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: path.join(home, '.cache/ruvnet-brain'), PATH: path.dirname(process.execPath) } });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/unsupported developer update argument: --knowledge-only/);
  });

  it('a current coordinator still gets --knowledge-only', () => {
    const { home, entry } = register(undefined);
    expect(automaticInvocation(['--update'], { home }).args).toEqual([entry, '--apply', '--knowledge-only']);
  });
});

