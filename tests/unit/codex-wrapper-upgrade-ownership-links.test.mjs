// codex-wrapper-upgrade-ownership-links.test.mjs (POSIX only; the release contract lists it for linux and macos).
// Symlink cases split out of codex-wrapper-upgrade-ownership.test.mjs so a Windows runner without symlink
// privilege never turns them into skipped cases. An upgrade must not refuse the Brain's own previous bridge.
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

describe('Codex hook bridge ownership: symlinks', () => {
  it('a symlinked bridge stays a conflict, even when it points at a generation wrapper', () => {
    const f = fixture();
    try { fs.symlinkSync(f.generationWrapper('4.6.4'), f.wrapper); } catch (error) { throw new Error('POSIX symlink creation must work here: ' + error.message); }
    const result = f.install();
    expect(result.action).toBe('hook-wrapper-ownership-conflict');
    expect(fs.lstatSync(f.wrapper).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(f.generationWrapper('4.6.4'))).toEqual(PRIOR);
    expect(fs.existsSync(path.join(f.codexDir, 'config.toml'))).toBe(false);
  });

  it('a generation directory that is a symlink is not followed as proof', () => {
    const f = fixture({ generations: {}, active: null });
    const elsewhere = path.join(f.home, 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'scripts', 'codex-hook-wrapper.mjs'), PRIOR);
    fs.mkdirSync(path.join(f.brain, 'versions'), { recursive: true });
    try { fs.symlinkSync(elsewhere, path.join(f.brain, 'versions', '4.6.4'), 'junction'); } catch (error) { throw new Error('POSIX symlink creation must work here: ' + error.message); }
    fs.writeFileSync(f.wrapper, PRIOR);
    expectPreserved(f, f.install(), PRIOR);
  });
});
