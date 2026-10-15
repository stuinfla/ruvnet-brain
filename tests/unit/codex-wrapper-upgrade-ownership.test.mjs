// codex-wrapper-upgrade-ownership.test.mjs — an upgrade must not refuse the Brain's own previous bridge.
//
// Measured 2026-10-13: installing 4.7.0 over 4.6.4 failed host convergence with
// hook-wrapper-ownership-conflict. ~/.cache/ruvnet-brain/codex-hook.mjs was byte-identical to the
// wrapper 4.6.4 itself shipped (versions/4.6.4/scripts/codex-hook-wrapper.mjs), but ownership was
// proven only against the NEW release's bytes, so every release that changes the wrapper broke
// every upgrade. Ownership is now proven against any retained Spine generation; everything that is
// not provably the Brain's (edited bytes, links, shared inodes, another owner) stays preserved.
// Every case runs against a temp HOME; nothing touches the real home.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { wireCodexHost } = await import('../../bin/install.mjs');

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHIPPED = fs.readFileSync(path.join(ROOT, 'plugin/scripts/codex-hook-wrapper.mjs'));
// A previous release's wrapper: different bytes from the one this release ships.
const PRIOR = Buffer.concat([SHIPPED, Buffer.from('\n// 4.6.4 wrapper bytes\n')]);

const roots = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })); });

function fixture({ generations = { '4.6.4': PRIOR }, active = '4.6.4' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wrapper-upgrade-'));
  roots.push(home);
  const codexDir = path.join(home, '.codex');
  const brain = path.join(home, '.cache', 'ruvnet-brain');
  const wrapper = path.join(brain, 'codex-hook.mjs');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(brain, { recursive: true });
  for (const [version, bytes] of Object.entries(generations)) {
    fs.mkdirSync(path.join(brain, 'versions', version, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(brain, 'versions', version, 'scripts', 'codex-hook-wrapper.mjs'), bytes);
  }
  if (active) {
    fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({
      generation: 1, version: active, codeRoot: path.join(brain, 'versions', active) }));
  }
  const install = () => wireCodexHost({ codexDir, serverDir: path.join(home, 'srv'), announce: false });
  const generationWrapper = (v) => path.join(brain, 'versions', v, 'scripts', 'codex-hook-wrapper.mjs');
  return { home, codexDir, brain, wrapper, install, generationWrapper };
}

function expectPreserved(f, result, bytes) {
  expect(result.action).toBe('hook-wrapper-ownership-conflict');
  expect(result.hookWrapperInstalled).toBe(false);
  expect(fs.readFileSync(f.wrapper)).toEqual(bytes);
  expect(fs.existsSync(`${f.wrapper}.prior`)).toBe(false);
  expect(fs.existsSync(path.join(f.home, 'srv'))).toBe(false);
  expect(fs.existsSync(path.join(f.codexDir, 'config.toml'))).toBe(false);
}

describe('Codex hook bridge ownership across a release upgrade', () => {
  it('upgrades the bridge the ACTIVE previous generation shipped, keeps its bytes beside it, and retires its registrations', () => {
    const f = fixture();
    fs.writeFileSync(f.wrapper, PRIOR);
    const settings = path.join(f.home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const foreign = { type: 'command', command: 'node /foreign/task.mjs' };
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [foreign,
      { command: `node "${f.wrapper}" continuation-gate`, type: 'command', timeout: 10 }] }] } }));

    const result = f.install();

    expect(result.action).toBe('added');
    expect(result.hookWrapperInstalled).toBe(true);
    expect(fs.readFileSync(f.wrapper)).toEqual(SHIPPED);
    expect(result.hookWrapperBackup).toBe(`${f.wrapper}.prior`);
    expect(fs.readFileSync(`${f.wrapper}.prior`)).toEqual(PRIOR); // reversible
    expect(fs.lstatSync(f.wrapper).nlink).toBe(1);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
    expect(fs.readFileSync(path.join(f.codexDir, 'config.toml'), 'utf8')).toContain('[mcp_servers.ruvnet-brain]');
  });

  it('upgrades a bridge a retained NON-active generation shipped', () => {
    const OLDER = Buffer.concat([SHIPPED, Buffer.from('\n// 4.6.3\n')]);
    const f = fixture({ generations: { '4.6.3': OLDER, '4.6.4': PRIOR }, active: '4.6.4' });
    fs.writeFileSync(f.wrapper, OLDER);
    const result = f.install();
    expect(result.hookWrapperInstalled).toBe(true);
    expect(fs.readFileSync(f.wrapper)).toEqual(SHIPPED);
    expect(fs.readFileSync(`${f.wrapper}.prior`)).toEqual(OLDER);
  });

  it('preserves a user-modified bridge with the conflict action even when generations exist', () => {
    const f = fixture();
    const mine = Buffer.concat([PRIOR, Buffer.from('// my local edit\n')]);
    fs.writeFileSync(f.wrapper, mine);
    expectPreserved(f, f.install(), mine);
  });

  it('a staging remnant is not proof of a shipped generation', () => {
    const f = fixture({ generations: { '4.7.0.staging-123': PRIOR }, active: null });
    fs.writeFileSync(f.wrapper, PRIOR);
    expectPreserved(f, f.install(), PRIOR);
  });

  it('a hard-linked bridge stays a conflict, even when its bytes match a generation', () => {
    const f = fixture();
    fs.linkSync(f.generationWrapper('4.6.4'), f.wrapper);
    expectPreserved(f, f.install(), PRIOR);
    expect(fs.statSync(f.wrapper).ino).toBe(fs.statSync(f.generationWrapper('4.6.4')).ino);
  });

  it('a bridge owned by another uid stays a conflict', () => {
    const f = fixture();
    fs.writeFileSync(f.wrapper, PRIOR);
    const original = process.getuid; // undefined on Windows: install.mjs only checks ownership when it exists
    const owner = fs.statSync(f.wrapper).uid;
    process.getuid = () => owner + 1;
    let result;
    try { result = f.install(); } finally { if (original === undefined) delete process.getuid; else process.getuid = original; }
    expectPreserved(f, result, PRIOR);
  });

  it('absent -> installed, then identical -> verified with no backup written', () => {
    const f = fixture();
    const first = f.install();
    expect(first.hookWrapperInstalled).toBe(true);
    expect(first.hookWrapperBackup).toBe(null);
    expect(fs.readFileSync(f.wrapper)).toEqual(SHIPPED);
    const second = f.install();
    expect(second.hookWrapperInstalled).toBe(true);
    expect(second.hookWrapperBackup).toBe(null);
    expect(fs.existsSync(`${f.wrapper}.prior`)).toBe(false);
    expect(fs.readFileSync(f.wrapper)).toEqual(SHIPPED);
  });
});
