// update-resilience-4-7-18.test.mjs — four faults measured on the owner's Mac 2026-10-23/24, each pinned here.
//
// 1. Codex refuses every plugin command while ANY configured marketplace snapshot fails to load (a third-party Git
//    marketplace mid-refresh). The update's host convergence then failed with no recorded reason.
// 2. A refused host convergence recorded `state: null, error: null` — undiagnosable afterwards.
// 3. `npx ruvnet-brain --update` inside a stale source checkout downloaded ~736 MB before refusing on a version
//    mismatch. It now stops before the download and says which command works.
// 4. ruflo's startup self-update runs `npm install @claude-flow/cli --save-exact` in its cwd; it left a 1.3-1.4 GB
//    node_modules in the Brain's scratch dir and in a project. Every Brain ruflo spawn must carry the off switch.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let mod;
beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  mod = await import('../../bin/install.mjs');
});
const temps = [];
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-4718-')); temps.push(d); return d; };

const BROKEN = (name) => ({ status: 1, stdout: '', stderr: `Error: failed to load configured marketplace snapshot(s):\n- \`${name}\` at /h/.codex/.tmp/marketplaces/${name}: marketplace root does not contain a supported manifest\n` });
const OK = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });

describe('Codex marketplace snapshot race (fault 1)', () => {
  it('names the broken marketplaces from Codex\'s own error text', () => {
    expect(mod.codexBrokenMarketplaces(BROKEN('claude-code-plugins').stderr)).toEqual(['claude-code-plugins']);
    expect(mod.codexBrokenMarketplaces('unrelated')).toEqual([]);
  });

  it('a refresh that finishes while waiting: one retry, no repair', () => {
    const calls = [];
    const replies = [BROKEN('claude-code-plugins'), OK({ installed: [] })];
    const run = (_bin, args) => { calls.push(args.join(' ')); return replies.shift(); };
    expect(mod.runCodexJson(['plugin', 'list', '--json'], { run, waitMs: 0 })).toEqual({ ok: true, value: { installed: [] } });
    expect(calls).toEqual(['plugin list --json', 'plugin list --json']);
  });

  it('a snapshot that stays broken: refreshes ONLY that third-party marketplace, then succeeds', () => {
    const calls = [];
    const replies = [BROKEN('claude-code-plugins'), BROKEN('claude-code-plugins'), OK({ upgradedRoots: ['x'] }), OK({ installed: [] })];
    const run = (_bin, args) => { calls.push(args.join(' ')); return replies.shift(); };
    const r = mod.runCodexJson(['plugin', 'list', '--json'], { run, waitMs: 0, repair: true });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['plugin list --json', 'plugin list --json', 'plugin marketplace upgrade claude-code-plugins --json', 'plugin list --json']);
  });

  it('never "repairs" the Brain\'s own marketplace this way, and a lasting failure names the exact repair', () => {
    const calls = [];
    const run = (_bin, args) => { calls.push(args.join(' ')); return args[1] === 'marketplace' ? { status: 1, stdout: '', stderr: 'net down' } : BROKEN('claude-code-plugins'); };
    const r = mod.runCodexJson(['plugin', 'list', '--json'], { run, waitMs: 0, repair: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Codex cannot load its `claude-code-plugins` marketplace snapshot \(tried: claude-code-plugins: refresh failed \(exit 1\)\); repair with: codex plugin marketplace upgrade claude-code-plugins$/);
    expect(calls.filter((c) => c.includes('upgrade'))).toHaveLength(1); // bounded: one repair attempt
    const own = [];
    mod.runCodexJson(['plugin', 'list', '--json'], { run: (_b, args) => { own.push(args.join(' ')); return BROKEN('ruvnet-brain'); }, waitMs: 0, repair: true });
    expect(own.some((c) => c.includes('upgrade'))).toBe(false);
  });

  it('read-only callers (--doctor, listings) never refresh another marketplace; they report it', () => {
    const calls = [];
    const r = mod.runCodexJson(['plugin', 'list', '--json'], { run: (_b, args) => { calls.push(args.join(' ')); return BROKEN('claude-code-plugins'); }, waitMs: 0 });
    expect(calls).toEqual(['plugin list --json', 'plugin list --json']);
    expect(r.error).toMatch(/repair with: codex plugin marketplace upgrade claude-code-plugins$/);
  });

  it('the Brain install/update path (wireCodexPlugin) is the one caller that opts into repair', () => {
    const codexDir = tmp(); const seen = [];
    const runJson = (args, options) => { seen.push(options?.repair); return { ok: false, error: 'stop here' }; };
    mod.wireCodexPlugin({ codexDir, codexHome: codexDir, expectedVersion: '1.2.3', runJson, announce: false });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r === true)).toBe(true);
  });

  it('an ordinary failure is returned once, untouched, with no wait or repair', () => {
    let n = 0;
    const r = mod.runCodexJson(['plugin', 'list', '--json'], { run: () => { n += 1; return { status: 2, stdout: '', stderr: 'boom' }; }, waitMs: 0 });
    expect(r).toEqual({ ok: false, error: 'boom' });
    expect(n).toBe(1);
  });
});

describe('a failed host sync always says why (fault 2)', () => {
  it('derives the reason from the per-host results', () => {
    expect(mod.hostFailureReason({ claude: { host: true, wired: false, action: 'verification-failed', version: '4.7.16', expectedVersion: '4.7.99' } }))
      .toBe('Claude Code plugin verification-failed (installed 4.7.16, required 4.7.99)');
    expect(mod.hostFailureReason({ claude: { host: true, wired: true }, codex: { action: 'codex-unavailable', error: 'Error: failed to load\n- `x` at y\nmore\nmore' } }))
      .toBe('Codex plugin codex-unavailable: Error: failed to load - `x` at y more');
    expect(mod.hostFailureReason({ claude: { host: true, wired: true }, codex: { action: 'updated' } })).toBeNull();
  });
});

describe('an older installer stops before downloading (fault 3)', () => {
  it('refuses when the installed runtime is newer, and names a source checkout', () => {
    const home = tmp(); const repo = tmp();
    fs.writeFileSync(path.join(home, 'active.json'), JSON.stringify({ version: '4.7.17' }));
    fs.mkdirSync(path.join(repo, '.git'));
    const msg = mod.olderInstallerRefusal({ brainHome: home, packageVersion: '4.5.2', repoRoot: repo });
    expect(msg).toMatch(/ruvnet-brain 4\.5\.2, a source checkout at .*, older than the 4\.7\.17 already installed/);
    expect(msg).toMatch(/npx ruvnet-brain@latest --update {2}from any other folder, or bring this checkout up to date first \(git pull\)\.$/);
  });
  it('never blocks a published installer that is older than active.json (release window, candidate install)', () => {
    const home = tmp(); const npxCopy = tmp();
    fs.writeFileSync(path.join(home, 'active.json'), JSON.stringify({ version: '4.7.17' }));
    expect(mod.olderInstallerRefusal({ brainHome: home, packageVersion: '4.7.16', repoRoot: npxCopy })).toBeNull();
  });
  it('allows a current or newer installer, and a machine with no recorded runtime', () => {
    const home = tmp();
    expect(mod.olderInstallerRefusal({ brainHome: home, packageVersion: '4.7.17', repoRoot: home })).toBeNull();
    fs.writeFileSync(path.join(home, 'active.json'), JSON.stringify({ version: '4.7.17' }));
    expect(mod.olderInstallerRefusal({ brainHome: home, packageVersion: '4.7.17', repoRoot: home })).toBeNull();
    expect(mod.olderInstallerRefusal({ brainHome: home, packageVersion: '4.7.99', repoRoot: home })).toBeNull();
  });
});

describe('every Brain ruflo spawn turns ruflo\'s in-cwd self-update off (fault 4)', () => {
  it('each source that sets RUFLO_DAEMON_AUTOSTART=0 for ruflo also sets CLAUDE_FLOW_AUTO_UPDATE=false', () => {
    const files = execFileSync('git', ['ls-files', 'bin', 'plugin', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
      .filter((f) => /\.(mjs|sh)$/.test(f) && !/\.test\./.test(f));
    const offenders = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      // Object form `RUFLO_DAEMON_AUTOSTART: '0'` and shell form `RUFLO_DAEMON_AUTOSTART=0` (not inside a comment).
      const sets = text.split('\n').filter((l) => /RUFLO_DAEMON_AUTOSTART(: '0'|=0)/.test(l) && !/^\s*(\/\/|\*|#|-)/.test(l));
      const off = (text.match(/CLAUDE_FLOW_AUTO_UPDATE(: 'false'|=false)/g) || []).length;
      if (sets.length > off) offenders.push(`${f}: ${sets.length} spawn env(s), ${off} off switch(es)`);
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(50); // the census actually looked
  });

  it('a file that builds a ruflo call with rufloInvocation carries the off switch (the spawn scanner cannot see `spawn(inv.executable)`)', () => {
    const files = execFileSync('git', ['ls-files', 'bin', 'plugin', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
      .filter((f) => /\.mjs$/.test(f) && !/\.test\./.test(f) && f !== 'plugin/scripts/ruflo-bin.mjs');
    const users = files.filter((f) => /\brufloInvocation(?:OrPlain)?\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(users.length).toBeGreaterThan(5);
    expect(users.filter((f) => !/CLAUDE_FLOW_AUTO_UPDATE(: 'false'|=false)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))).toEqual([]);
  });

  it('the git-push durability probe runs ruflo in a private scratch dir with both switches, never in the caller\'s project', async () => {
    const bin = tmp(); const out = path.join(tmp(), 'seen.txt'); const project = tmp(); const brainHome = tmp();
    fs.writeFileSync(path.join(bin, 'ruflo'), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$PWD" "$CLAUDE_FLOW_AUTO_UPDATE" "$RUFLO_DAEMON_AUTOSTART" >> "${out}"\nfor a in "$@"; do last="$a"; done\necho "probe-$last"\n`);
    fs.chmodSync(path.join(bin, 'ruflo'), 0o755);
    const saved = { PATH: process.env.PATH, HOME: process.env.RUVNET_BRAIN_HOME, cwd: process.cwd() };
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.RUVNET_BRAIN_HOME = brainHome;
    process.chdir(project);
    try {
      const { proveMemoryDurable } = await import('../../plugin/scripts/degradation-watch.mjs');
      expect(proveMemoryDurable(path.join(tmp(), 'probe.db')).ok).toBe(true);
    } finally {
      process.chdir(saved.cwd); process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.RUVNET_BRAIN_HOME; else process.env.RUVNET_BRAIN_HOME = saved.HOME;
    }
    const seen = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split('|'));
    expect(seen).toHaveLength(2);
    for (const [cwd, update, daemon] of seen) {
      expect(cwd).toContain('ruflo-cwd');
      expect(cwd.startsWith(fs.realpathSync(project))).toBe(false);
      expect([update, daemon]).toEqual(['false', '0']);
    }
    expect(fs.readdirSync(project)).toEqual([]); // nothing left in the caller's project
  });
});
