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

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deriveWrapperHistory, historyDrift, readWrapperHistory, releaseTags } from '../../scripts/codex-hook-wrapper-history.mjs';

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

// Owner's machine, 2026-10-17: the bridge was byte-identical to a wrapper an EARLIER shipped release wrote, but
// that release's versions/<v>/ generation was long pruned, so nothing on disk proved ownership and every update
// failed host convergence with hook-wrapper-ownership-conflict. The proof is now the committed history of every
// wrapper each release tag carried (data/codex-hook-wrapper-history.json, derived from git).
describe('a bridge written by an earlier shipped release whose generation is gone', () => {
  const tags = releaseTags(ROOT);
  const gitTag = tags.includes('v4.5.2') ? 'v4.5.2' : null;
  const oldBytes = gitTag ? execFileSync('git', ['show', `${gitTag}:plugin/scripts/codex-hook-wrapper.mjs`], { cwd: ROOT }) : null;
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

  it('the committed history carries EXACTLY the wrappers git says the release tags shipped (cannot drift either way)', () => {
    if (!tags.length) return; // no tags visible to git here: the derivation has nothing to compare
    const committed = readWrapperHistory(ROOT);
    const derived = deriveWrapperHistory(ROOT);
    expect(historyDrift(committed, derived)).toEqual({ missing: [], extra: [] });
    expect(derived.wrappers.length).toBeGreaterThanOrEqual(10);
    // BREAK IT both ways: a wrapper git shipped that the file lacks, and a row git never shipped, are each named.
    expect(historyDrift({ wrappers: committed.wrappers.slice(1) }, derived).missing).toHaveLength(1);
    const planted = { sha256: 'f'.repeat(64), bytes: 1, tags: ['v4.5.2'] };
    expect(historyDrift({ wrappers: [...committed.wrappers, planted] }, derived).extra).toEqual([planted]);
    // The two bridges this file was written for: the 4.5.2 bytes on the owner's machine, and the 4.7.x source.
    expect(committed.wrappers.some((row) => row.sha256.startsWith('d3ee284722aa') && row.tags.includes('v4.5.2'))).toBe(true);
    expect(committed.wrappers.some((row) => row.sha256 === sha(SHIPPED))).toBe(true);
  });

  it('UPGRADES the 4.5.2 bridge with NO retained generation on disk: known old bytes -> installed, kept beside it as .prior, its registrations retired', () => {
    if (!oldBytes) return;
    expect(oldBytes.equals(SHIPPED)).toBe(false);
    expect(sha(oldBytes).startsWith('d3ee284722aa')).toBe(true);
    const f = fixture({ generations: {}, active: null }); // nothing under versions/ at all
    fs.writeFileSync(f.wrapper, oldBytes);
    // The 4.5.2 install's own legacy registration beside a foreign hook: only the Brain's is retired.
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
    expect(fs.readFileSync(`${f.wrapper}.prior`)).toEqual(oldBytes);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
  });

  it('MUTATION KILLER: the same old bytes edited by one byte (same length or longer), or shipped by no release, stay a conflict; a hard link stays a conflict', () => {
    if (!oldBytes) return;
    // Same length, one bit flipped: only the sha256 can tell this from the 4.5.2 bridge.
    const flipped = Buffer.from(oldBytes);
    flipped[100] ^= 1;
    expect(flipped.length).toBe(oldBytes.length);
    const e = fixture({ generations: {}, active: null });
    fs.writeFileSync(e.wrapper, flipped);
    expectPreserved(e, e.install(), flipped);
    const edited = Buffer.concat([oldBytes, Buffer.from('\n')]);
    const f = fixture({ generations: {}, active: null });
    fs.writeFileSync(f.wrapper, edited);
    expectPreserved(f, f.install(), edited);
    const g = fixture({ generations: {}, active: null });
    fs.writeFileSync(g.wrapper, PRIOR); // bytes no release ever shipped
    expectPreserved(g, g.install(), PRIOR);
    const h = fixture({ generations: {}, active: null });
    fs.writeFileSync(h.wrapper, oldBytes);
    fs.linkSync(h.wrapper, path.join(h.brain, 'codex-hook.shared.mjs'));
    expectPreserved(h, h.install(), oldBytes);
  });

  it('a history file that is missing, malformed, of another schema or kind, or names a tag that is not a release proves nothing', () => {
    if (!oldBytes) return;
    const f = fixture({ generations: {}, active: null });
    fs.writeFileSync(f.wrapper, oldBytes);
    // The committed data file is never touched: the installer is pointed at a temp history through its seam.
    const history = path.join(f.home, 'history.json');
    const row = { sha256: sha(oldBytes), bytes: oldBytes.length, tags: ['v4.5.2'] };
    const valid = { schemaVersion: 1, kind: 'ruvnet-brain-codex-hook-wrapper-history', wrappers: [row] };
    const committed = fs.readFileSync(path.join(ROOT, 'data', 'codex-hook-wrapper-history.json'));
    const withHistory = (value) => {
      if (value === null) fs.rmSync(history, { force: true }); else fs.writeFileSync(history, typeof value === 'string' ? value : JSON.stringify(value));
      process.env.RUVNET_WRAPPER_HISTORY_FILE = history;
      try { return f.install(); } finally { delete process.env.RUVNET_WRAPPER_HISTORY_FILE; }
    };
    try {
      // The seam works: the same valid row through the temp file upgrades (control).
      const control = fixture({ generations: {}, active: null });
      fs.writeFileSync(control.wrapper, oldBytes);
      process.env.RUVNET_WRAPPER_HISTORY_FILE = history;
      fs.writeFileSync(history, JSON.stringify(valid));
      try { expect(control.install().action).toBe('added'); } finally { delete process.env.RUVNET_WRAPPER_HISTORY_FILE; }
      expectPreserved(f, withHistory({ ...valid, wrappers: [{ ...row, tags: ['main'] }] }), oldBytes);
      expectPreserved(f, withHistory({ ...valid, schemaVersion: 2 }), oldBytes);
      expectPreserved(f, withHistory({ ...valid, kind: 'ruvnet-brain-something-else' }), oldBytes);
      expectPreserved(f, withHistory({ ...valid, wrappers: [{ ...row, bytes: row.bytes + 1 }] }), oldBytes);
      expectPreserved(f, withHistory('{not json'), oldBytes);
      expectPreserved(f, withHistory(null), oldBytes);
    } finally {
      expect(fs.readFileSync(path.join(ROOT, 'data', 'codex-hook-wrapper-history.json'))).toEqual(committed);
    }
  });
});
