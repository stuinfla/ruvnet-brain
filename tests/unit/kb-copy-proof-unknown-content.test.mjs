import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kbCopyProof } from '../../plugin/scripts/kb-copy-proof.mjs';
import { sweepFootprint } from '../../plugin/scripts/brain-footprint.mjs';

const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const put = (root, name, value) => {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-unknown-proof-')); roots.push(root);
  const home = path.join(root, 'home'), brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const liveDir = path.join(brainHome, 'kb'), copyDir = path.join(brainHome, 'kb.install-preserved-test');
  for (const dir of [liveDir, copyDir]) put(dir, 'SOURCE.json', { stores: [{ kbName: 'agentdb', updateManaged: true }] });
  put(liveDir, 'agentdb.big.rvf', 'new public bytes'); put(copyDir, 'agentdb.big.rvf', 'old public bytes');
  return { root, home, brainHome, liveDir, copyDir };
}
const witness = (dir, file) => {
  const bytes = fs.readFileSync(path.join(dir, file));
  put(dir, 'ARCHIVE-MANIFEST.json', { files: [{ path: file, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] });
};

describe('unknown-content preservation during KB copy reclamation (#335)', () => {
  it('retains same-length differing unknown bytes at an existing live pathname', () => {
    const f = fixture(); put(f.copyDir, 'user-notes.txt', 'older'); put(f.liveDir, 'user-notes.txt', 'newer');
    expect(kbCopyProof(f)).toMatchObject({ disposable: false, unique: [{ file: 'user-notes.txt' }] });
  });
  it('accepts identical unknown regular bytes and existing governed public artifacts', () => {
    const f = fixture(); for (const dir of [f.liveDir, f.copyDir]) put(dir, 'user-notes.txt', 'same');
    put(f.copyDir, 'agentdb.big.meta.json', 'old public metadata');
    expect(kbCopyProof(f)).toMatchObject({ disposable: true, unique: [] });
  });
  it.each(['missing', 'directory', 'symlink'])('retains unknown bytes when live has a %s destination', (kind) => {
    const f = fixture(); put(f.copyDir, 'user-notes.txt', 'original');
    if (kind === 'directory') fs.mkdirSync(path.join(f.liveDir, 'user-notes.txt'));
    if (kind === 'symlink') {
      // Deterministic leaf-link type avoids requiring Windows symlink privilege; content is identical.
      put(f.liveDir, 'user-notes.txt', 'original'); const original = fs.lstatSync;
      vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => file === path.join(f.liveDir, 'user-notes.txt')
        ? { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false } : original(file, ...args));
    }
    expect(kbCopyProof(f).disposable).toBe(false);
  });
  it('does not follow a live ancestor symlink even to byte-identical unknown content', () => {
    const f = fixture(); put(f.copyDir, 'notes/user.txt', 'original'); put(f.root, 'outside/user.txt', 'original');
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.liveDir, 'notes'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(kbCopyProof(f)).toMatchObject({ disposable: false, unique: [{ file: path.join('notes', 'user.txt'), why: expect.stringContaining('ancestor') }] });
  });
  it('does not traverse a copy ancestor symlink', () => {
    const f = fixture(); put(f.liveDir, 'notes/user.txt', 'original'); put(f.root, 'outside/user.txt', 'original');
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.copyDir, 'notes'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(kbCopyProof(f).disposable).toBe(false);
  });
  it('retains differing nested unknown content', () => {
    const f = fixture(); put(f.copyDir, 'notes/user.txt', 'original'); put(f.liveDir, 'notes/user.txt', 'changed');
    expect(kbCopyProof(f).unique.map(u => u.file)).toContain(path.join('notes', 'user.txt'));
  });
  it.each(['liveDir', 'copyDir'])('private fence in %s precedes public manifest authority', (side) => {
    const f = fixture(); put(f[side], 'PRIVATE-STORES.json', { privateStores: ['agentdb'] });
    witness(f.copyDir, 'agentdb.big.rvf');
    expect(kbCopyProof(f).unique.map(u => u.file)).toContain('agentdb.big.rvf');
  });
  it.each(['copyDir', 'liveDir'])('updateManaged:false alias in %s precedes reinstallable node_modules exemption', (side) => {
    const f = fixture(); put(f[side], 'SOURCE.json', { stores: [{ kbName: 'private', updateManaged: false }] });
    put(f[side], 'RVF-GENERATIONS.json', { stores: { private: { file: 'node_modules/alias.rvf' } } });
    put(f.copyDir, 'node_modules/alias.rvf', 'sole private bytes'); witness(f.copyDir, 'node_modules/alias.rvf');
    expect(kbCopyProof(f).unique.map(u => u.file)).toContain(path.join('node_modules', 'alias.rvf'));
  });
  it.each(['SOURCE.json', 'RVF-GENERATIONS.json', 'repo-aliases.json', 'unknown.metadata.json'])('retains unowned differing/copy-only %s', (file) => {
    const f = fixture(); const value = file === 'SOURCE.json' ? { stores: [{ kbName: 'private', updateManaged: false }], privateNote: 'original' }
      : file === 'RVF-GENERATIONS.json' ? { stores: { private: { file: 'private.rvf' } } } : { privateAlias: ['private'] };
    put(f.copyDir, file, value);
    expect(kbCopyProof(f).unique.map(u => u.file)).toContain(file);
  });
  it.each(['PRIVATE-STORES.json', 'SOURCE.json', 'RVF-GENERATIONS.json', 'repo-aliases.json'])('malformed %s fails closed', (file) => {
    const f = fixture(); put(f.copyDir, file, '{malformed');
    expect(kbCopyProof(f)).toMatchObject({ disposable: false, reason: expect.stringContaining('metadata') });
  });
  it.each(['agentdb', null])('malformed private fence shape %s fails closed despite a public manifest', (privateStores) => {
    const f = fixture(); put(f.copyDir, 'PRIVATE-STORES.json', { privateStores }); witness(f.copyDir, 'agentdb.big.rvf');
    expect(kbCopyProof(f).disposable).toBe(false);
  });
  it.each([null, 'not-a-store', 42, []])('malformed SOURCE map value %s cannot erase private membership', (value) => {
    const f = fixture(); put(f.copyDir, 'SOURCE.json', { stores: { private: value } });
    expect(kbCopyProof(f)).toMatchObject({ disposable: false, reason: expect.stringContaining('metadata') });
  });
  it('unreadable copy enumeration cannot become an empty disposable inventory', () => {
    const f = fixture(), original = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation((dir, ...args) => {
      if (dir === f.copyDir) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return original(dir, ...args);
    });
    expect(kbCopyProof(f)).toMatchObject({ disposable: false, reason: expect.stringContaining('unreadable copy') });
  });
  it('a special file type keeps the copy', () => {
    const f = fixture(); put(f.copyDir, 'special', 'placeholder'); const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => file === path.join(f.copyDir, 'special')
      ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false } : original(file, ...args));
    expect(kbCopyProof(f)).toMatchObject({ disposable: false, reason: expect.stringContaining('unsupported file type') });
  });
  it('real sweep keeps differing unknown bytes while removing only a separate proven duplicate', () => {
    const f = fixture(); put(f.copyDir, 'user-notes.txt', 'older'); put(f.liveDir, 'user-notes.txt', 'newer');
    const duplicate = path.join(f.brainHome, 'kb.install-preserved-duplicate'); fs.mkdirSync(duplicate);
    for (const file of ['SOURCE.json', 'agentdb.big.rvf']) fs.copyFileSync(path.join(f.liveDir, file), path.join(duplicate, file));
    const result = sweepFootprint({ apply: true, home: f.home, env: { HOME: f.home } });
    expect(result.errors).toEqual([]); expect(fs.existsSync(duplicate)).toBe(false);
    expect(fs.readFileSync(path.join(f.copyDir, 'user-notes.txt'), 'utf8')).toBe('older');
    expect(fs.readFileSync(path.join(f.liveDir, 'user-notes.txt'), 'utf8')).toBe('newer');
  });
});
