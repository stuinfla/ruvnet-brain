import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
    fs.mkdirSync(path.join(cache, v, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(cache, v, 'scripts', 'hook-shim.mjs'), `process.stdout.write(${JSON.stringify(v)});\n`);
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
const utcProcessStart = (pid = process.pid) => {
  if (process.platform === 'win32') {
    return spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${pid}; $p.StartTime.ToUniversalTime().ToString('ddd MMM dd HH:mm:ss yyyy',[Globalization.CultureInfo]::InvariantCulture)`,
    ], { encoding: 'utf8' }).stdout.trim();
  }
  return spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
  }).stdout.trim();
};

describe('issue #153 — plugin generations are retained without trustworthy session liveness', () => {
  it('keeps frozen A and B sessions executable across A -> B -> C registry advances', () => {
    const versions = ['9.9.10-dev', '9.9.20', '9.9.30-dev'];
    const { cache, registryPath } = layout({ versions, activeVersions: ['9.9.10-dev'] });
    const advance = (version) => fs.writeFileSync(registryPath, JSON.stringify({
      version: 2,
      plugins: { 'ruvnet-brain@ruvnet-brain': [{
        scope: 'user', installPath: path.join(cache, version), version,
      }] },
    }));
    const invokeFrozen = (version) => spawnSync(
      process.execPath,
      [path.join(cache, version, 'scripts', 'hook-shim.mjs'), 'session-snapshot', 'SessionEnd'],
      { encoding: 'utf8' },
    );

    advance('9.9.20');
    prunePluginGenerations({ registryPath, apply: true });
    expect(invokeFrozen('9.9.10-dev')).toMatchObject({ status: 0, stdout: '9.9.10-dev' });
    expect(fs.readFileSync(path.join(cache, '9.9.10-dev', 'skills', 'SKILL.md'), 'utf8')).toContain('9.9.10-dev');

    advance('9.9.30-dev');
    prunePluginGenerations({ registryPath, apply: true });
    expect(invokeFrozen('9.9.10-dev')).toMatchObject({ status: 0, stdout: '9.9.10-dev' });
    expect(invokeFrozen('9.9.20')).toMatchObject({ status: 0, stdout: '9.9.20' });
  });

  it('reports every unreferenced generation but removes none without liveness proof', () => {
    const { cache, registryPath } = layout({
      versions: ['9.9.10-dev', '9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'], // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    });
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(names(r.stale)).toEqual(['9.9.10-dev', '9.9.20']); // sync-version-ignore: synthetic fixture generations
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(cache, '9.9.30-dev')), 'the live install must survive').toBe(true); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    expect(fs.existsSync(path.join(cache, '9.9.10-dev')), 'a frozen session may still need it').toBe(true); // sync-version-ignore: synthetic fixture generation
    expect(r.bytes, 'retained bytes must not be reported as freed').toBe(0);
    expect(r.staleBytes).toBeGreaterThan(0);
    expect(r.marked.sort()).toEqual(['9.9.10-dev', '9.9.20']);
  });

  it('reports without deleting unless asked', () => {
    const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] }); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    const r = prunePluginGenerations({ registryPath });
    expect(names(r.stale)).toEqual(['9.9.20']); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(cache, '9.9.20'))).toBe(true); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
  });

  it('TEETH: an unreadable registry removes NOTHING and says why', () => {
    // The registry is the only authority. Without this, a missing or corrupt file would present as
    // "no generation is registered", i.e. every generation is stale — deleting the live install.
    const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] }); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    fs.writeFileSync(registryPath, '{ not json');
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(r.removed).toEqual([]);
    expect(r.why).toMatch(/unreadable/);
    expect(fs.existsSync(path.join(cache, '9.9.20')), 'nothing may be deleted on a guess').toBe(true); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    expect(fs.existsSync(path.join(cache, '9.9.30-dev'))).toBe(true); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
  });

  it('TEETH: a registry with no ruvnet-brain entry removes NOTHING', () => {
    const { cache, registryPath } = layout({ versions: ['9.9.20'], activeVersions: [] }); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(r.removed).toEqual([]);
    expect(r.why).toMatch(/no ruvnet-brain install is registered/);
    expect(fs.existsSync(path.join(cache, '9.9.20'))).toBe(true); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
  });

  it('TEETH: a symlinked dev checkout is never removed or followed', () => {
    // scripts/dev-plugin-link.sh links a working tree in here. Removing through that link would
    // delete the checkout itself — the single worst outcome this function could produce.
    const { cache, registryPath } = layout({
      versions: ['9.9.30-dev'], activeVersions: ['9.9.30-dev'], extras: { 'dev-link': 'symlink' }, // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    });
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(cache, 'dev-link')), 'the link must still be there').toBe(true);
    expect(fs.existsSync(path.join(path.dirname(path.dirname(path.dirname(path.dirname(cache)))), 'checkout')))
      .toBe(true);
  });

  it('TEETH: a directory that is not a generation is left alone', () => {
    const { cache, registryPath } = layout({
      versions: ['9.9.30-dev'], activeVersions: ['9.9.30-dev'], extras: { 'someone-elses-data': 'dir', 'notes.txt': 'file' }, // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
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
      versions: ['9.9.20', '9.9.30-dev', '9.9.25-dev'], activeVersions: ['9.9.30-dev', '9.9.25-dev'], // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    });
    const r = prunePluginGenerations({ registryPath, apply: true });
    expect(names(r.stale)).toEqual(['9.9.20']); // sync-version-ignore: synthetic fixture generation
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(cache, '9.9.20'))).toBe(true); // sync-version-ignore: synthetic fixture generation
    expect(fs.existsSync(path.join(cache, '9.9.25-dev'))).toBe(true); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
    expect(fs.existsSync(path.join(cache, '9.9.30-dev'))).toBe(true); // sync-version-ignore: a synthetic generation name IS the fixture — this suite is about which DIRECTORIES survive a prune, and the strings are directory names, not a claim about any shipped version
  });

  it('reclaims a modern orphan immediately when its exact process incarnation is dead', () => {
    const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] });
    const old = path.join(cache, '9.9.20');
    fs.writeFileSync(path.join(old, '.orphaned_at'), '1000');
    fs.mkdirSync(path.join(old, '.in_use'));
    fs.writeFileSync(path.join(old, '.in_use', '42'), JSON.stringify({ pid: 42, procStart: 'old incarnation' }));
    const r = prunePluginGenerations({ registryPath, apply: true, now: () => 1001, processIdentity: () => 'dead' });
    expect(r.removed).toEqual(['9.9.20']);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('retains a generation while its exact process incarnation is live or unknown', () => {
    for (const state of ['live', 'unknown']) {
      const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] });
      const old = path.join(cache, '9.9.20');
      fs.writeFileSync(path.join(old, '.orphaned_at'), '1');
      fs.mkdirSync(path.join(old, '.in_use'));
      fs.writeFileSync(path.join(old, '.in_use', '42'), JSON.stringify({ pid: 42, procStart: 'incarnation' }));
      const r = prunePluginGenerations({ registryPath, apply: true, now: () => 999999, graceMs: 1, processIdentity: () => state });
      expect(r.removed, state).toEqual([]);
      expect(fs.existsSync(old), state).toBe(true);
    }
  });

  it('retains the exact live process with the real UTC process-start probe', () => {
    const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] });
    const old = path.join(cache, '9.9.20');
    fs.writeFileSync(path.join(old, '.orphaned_at'), '1');
    fs.mkdirSync(path.join(old, '.in_use'));
    fs.writeFileSync(path.join(old, '.in_use', String(process.pid)), JSON.stringify({ pid: process.pid, procStart: utcProcessStart() }));
    const r = prunePluginGenerations({ registryPath, apply: true, now: () => 999999, graceMs: 1 });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('reclaims a PID-reused lease when process start differs', () => {
    const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] });
    const old = path.join(cache, '9.9.20');
    fs.writeFileSync(path.join(old, '.orphaned_at'), '1');
    fs.mkdirSync(path.join(old, '.in_use'));
    fs.writeFileSync(path.join(old, '.in_use', String(process.pid)), JSON.stringify({ pid: process.pid, procStart: 'Thu Jan  1 00:00:01 1970' }));
    const r = prunePluginGenerations({ registryPath, apply: true, now: () => 999999, graceMs: 1 });
    expect(r.removed).toEqual(['9.9.20']);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('fails closed for symlinked or malformed lease state', () => {
    const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] });
    const old = path.join(cache, '9.9.20');
    const outside = mktemp();
    fs.writeFileSync(path.join(outside, 'lease'), '{}');
    fs.writeFileSync(path.join(old, '.orphaned_at'), '1');
    fs.symlinkSync(outside, path.join(old, '.in_use'));
    let r = prunePluginGenerations({ registryPath, apply: true, now: () => 999999, graceMs: 1 });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(path.join(outside, 'lease'))).toBe(true);
    fs.rmSync(path.join(old, '.in_use'));
    fs.mkdirSync(path.join(old, '.in_use'));
    fs.writeFileSync(path.join(old, '.in_use', 'broken'), '{');
    r = prunePluginGenerations({ registryPath, apply: true, now: () => 999999, graceMs: 1 });
    expect(r.removed).toEqual([]);
    expect(r.cleanupBlocked.length).toBeGreaterThan(0);
  });

  it('keeps legacy generations for 14 days, then collects them', () => {
    const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] });
    const old = path.join(cache, '9.9.20');
    const day = 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(old, '.orphaned_at'), '1000');
    expect(prunePluginGenerations({ registryPath, apply: true, now: () => 1000 + 14 * day - 1 }).removed).toEqual([]);
    expect(prunePluginGenerations({ registryPath, apply: true, now: () => 1000 + 14 * day }).removed).toEqual(['9.9.20']);
  });

  it('retains everything when the registry changes at the destructive boundary', () => {
    const { cache, registryPath } = layout({ versions: ['9.9.20', '9.9.30-dev'], activeVersions: ['9.9.30-dev'] });
    const old = path.join(cache, '9.9.20');
    fs.writeFileSync(path.join(old, '.orphaned_at'), '1');
    fs.mkdirSync(path.join(old, '.in_use'));
    fs.writeFileSync(path.join(old, '.in_use', '42'), JSON.stringify({ pid: 42, procStart: 'old' }));
    const r = prunePluginGenerations({
      registryPath, apply: true, now: () => 999999, graceMs: 1,
      processIdentity: () => {
        const doc = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        doc.observedRace = true;
        fs.writeFileSync(registryPath, JSON.stringify(doc));
        return 'dead';
      },
    });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(old)).toBe(true);
  });
});
