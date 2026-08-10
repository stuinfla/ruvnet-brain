import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ISSUE #128 — stale plugin generations in the cache are still discovered.
 *
 * The registry names ONE generation; the cache held 28 on the maintainer's machine, each a complete
 * generation with its own skills/ and hooks/. Claude Code resolves skills by walking the directory
 * rather than honouring `installPath`, so old generations keep answering: one session announced
 * three different versions, none of them the one executing, and obeyed the stale block's mandatory
 * phrasing to state the wrong version authoritatively in its first sentence.
 *
 * This function DELETES DIRECTORIES FROM A USER'S MACHINE, so most of what follows is about what it
 * must refuse to do. Every refusal has a case that fails if the refusal is removed.
 */
let prunePluginGenerations;
beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';   // never run the installer main on import
  ({ prunePluginGenerations } = await import('../../bin/install.mjs'));
});

const temps = [];
const mktemp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-prune-')); temps.push(d); return d; };
afterEach(() => temps.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A plugin cache shaped like the real one, plus a registry pointing at `activeVersions`. */
function layout({ versions, activeVersions, extras = {} }) {
  const root = mktemp();
  const cache = path.join(root, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain');
  for (const v of versions) {
    fs.mkdirSync(path.join(cache, v, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(cache, v, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: v }));
    fs.mkdirSync(path.join(cache, v, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(cache, v, 'skills', 'SKILL.md'), `# ${v}`);
  }
  // Anything the caller wants beside the generations: a bare dir, a file, a symlink.
  for (const [name, kind] of Object.entries(extras)) {
    const p = path.join(cache, name);
    if (kind === 'dir') fs.mkdirSync(p, { recursive: true });
    else if (kind === 'file') fs.writeFileSync(p, 'x');
    else if (kind === 'symlink') { fs.mkdirSync(path.join(root, 'checkout'), { recursive: true }); fs.symlinkSync(path.join(root, 'checkout'), p); }
  }
  const registryPath = path.join(root, 'installed_plugins.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    version: 2,
    plugins: {
      'other-plugin@someone': [{ scope: 'user', installPath: '/somewhere/else', version: '1' }],
      'ruvnet-brain@ruvnet-brain': activeVersions.map((v) => ({
        scope: 'user', installPath: path.join(cache, v), version: v,
      })),
    },
  }));
  return { cache, registryPath };
}

const names = (list) => list.map((s) => s.version).sort();

describe('issue #128 — only the registered generation survives', () => {
  it('removes every unreferenced generation and keeps the registered one', () => {
    const { cache, registryPath } = layout({
      versions: ['4.0.17-dev', '4.0.35', '4.0.38-dev'], activeVersions: ['4.0.38-dev'],
    });
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(names(r.removed)).toEqual(['4.0.17-dev', '4.0.35']);
    expect(fs.existsSync(path.join(cache, '4.0.38-dev')), 'the live install must survive').toBe(true);
    expect(fs.existsSync(path.join(cache, '4.0.17-dev')), 'the stale skills must be gone').toBe(false);
    expect(r.bytes, 'it reports what it freed, so a no-op cannot pass as success').toBeGreaterThan(0);
  });

  it('reports without deleting unless asked', () => {
    const { cache, registryPath } = layout({ versions: ['4.0.35', '4.0.38-dev'], activeVersions: ['4.0.38-dev'] });
    const r = prunePluginGenerations({ registryPath });
    expect(names(r.stale)).toEqual(['4.0.35']);
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(cache, '4.0.35'))).toBe(true);
  });

  it('TEETH: an unreadable registry removes NOTHING and says why', () => {
    // The registry is the only authority. Without this, a missing or corrupt file would present as
    // "no generation is registered", i.e. every generation is stale — deleting the live install.
    const { cache, registryPath } = layout({ versions: ['4.0.35', '4.0.38-dev'], activeVersions: ['4.0.38-dev'] });
    fs.writeFileSync(registryPath, '{ not json');
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(r.removed).toEqual([]);
    expect(r.why).toMatch(/unreadable/);
    expect(fs.existsSync(path.join(cache, '4.0.35')), 'nothing may be deleted on a guess').toBe(true);
    expect(fs.existsSync(path.join(cache, '4.0.38-dev'))).toBe(true);
  });

  it('TEETH: a registry with no ruvnet-brain entry removes NOTHING', () => {
    const { cache, registryPath } = layout({ versions: ['4.0.35'], activeVersions: [] });
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(r.removed).toEqual([]);
    expect(r.why).toMatch(/no ruvnet-brain install is registered/);
    expect(fs.existsSync(path.join(cache, '4.0.35'))).toBe(true);
  });

  it('TEETH: a symlinked dev checkout is never removed or followed', () => {
    // scripts/dev-plugin-link.sh links a working tree in here. Removing through that link would
    // delete the checkout itself — the single worst outcome this function could produce.
    const { cache, registryPath } = layout({
      versions: ['4.0.38-dev'], activeVersions: ['4.0.38-dev'], extras: { 'dev-link': 'symlink' },
    });
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(cache, 'dev-link')), 'the link must still be there').toBe(true);
    expect(fs.existsSync(path.join(path.dirname(path.dirname(path.dirname(path.dirname(cache)))), 'checkout')))
      .toBe(true);
  });

  it('TEETH: a directory that is not a generation is left alone', () => {
    const { cache, registryPath } = layout({
      versions: ['4.0.38-dev'], activeVersions: ['4.0.38-dev'], extras: { 'someone-elses-data': 'dir', 'notes.txt': 'file' },
    });
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(cache, 'someone-elses-data'))).toBe(true);
    expect(fs.existsSync(path.join(cache, 'notes.txt'))).toBe(true);
  });

  it('TEETH: every registered scope is protected, not just the first', () => {
    // The plugin can legitimately be installed at user AND project scope. Protecting only the first
    // entry would delete a live install while reporting success.
    const { cache, registryPath } = layout({
      versions: ['4.0.35', '4.0.38-dev', '4.0.31-dev'], activeVersions: ['4.0.38-dev', '4.0.31-dev'],
    });
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(names(r.removed)).toEqual(['4.0.35']);
    expect(fs.existsSync(path.join(cache, '4.0.31-dev'))).toBe(true);
    expect(fs.existsSync(path.join(cache, '4.0.38-dev'))).toBe(true);
  });
});
