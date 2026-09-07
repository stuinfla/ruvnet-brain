// stack-plugins.test.mjs — ISSUE #22: a rUv tool installed via the Claude Code plugin MARKETPLACE
// must be counted on the "Your stack" card, never reported "not installed".
//
// THE BUG THIS EXISTS FOR: stack-sync.listInstalled() only ever scanned the global npm lib, so a user
// who installed ruflo / ruvnet-brain / ruview / cognitum through the plugin marketplace (not
// `npm install -g`) saw a permanently undercounted stack — the card literally could not see their
// plugins. The fix scans the plugin cache (authoritatively, via installed_plugins.json) and tags each
// entry source:'plugin'. These are unit-tested against a fixture dir, injected exactly like the
// installedVersion(pkg, lib=GLOBAL_LIB) pattern (here: listInstalledPlugins(pluginsDir)).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { listInstalledPlugins, pluginVersion, classify, PLUGIN_MARKETPLACES, pickTargetTag } from '../../scripts/stack-sync.mjs';

describe('pickTargetTag — track the NEWEST of {policy tag, latest}, never behind the newest published', () => {
  it('latest leads (the real 2026-07-18 ruflo case): @alpha 3.32.0 < @latest 3.32.7 → target latest', () => {
    // "track @alpha" alone pinned the core at 3.32.2 (AHEAD of the 3.32.0 alpha target) while 3.32.7
    // shipped to latest — the nightly reported success doing nothing. Newest-of-both fixes it.
    expect(pickTargetTag({ alpha: '3.32.0', latest: '3.32.7' }, 'alpha')).toEqual({ tag: 'latest', target: '3.32.7' });
  });
  it('alpha leads (the normal case — alpha is ahead): → target alpha', () => {
    expect(pickTargetTag({ alpha: '3.33.0', latest: '3.32.7' }, 'alpha')).toEqual({ tag: 'alpha', target: '3.33.0' });
  });
  it('no alpha tag published → falls through to latest, never invents one', () => {
    expect(pickTargetTag({ latest: '1.0.0' }, 'alpha')).toEqual({ tag: 'latest', target: '1.0.0' });
  });
  it('a latest-policy package does NOT jump to a higher alpha — only core tracks alpha', () => {
    expect(pickTargetTag({ latest: '2.0.0', alpha: '2.1.0' }, 'latest')).toEqual({ tag: 'latest', target: '2.0.0' });
  });
  it('registry unreachable (null tags) → unresolved, never a guessed target', () => {
    expect(pickTargetTag(null, 'alpha')).toEqual({ tag: null, target: null });
  });
});

// Build a throwaway ~/.claude/plugins fixture: an installed_plugins.json whose records point at cached
// version dirs that each carry a real .claude-plugin/plugin.json — mirroring the machine's true layout.
function makeFixture(plugins) {
  const dir = mkdtempSync(join(tmpdir(), 'sp-'));
  const manifest = { version: 2, plugins: {} };
  for (const [key, records] of Object.entries(plugins)) {
    manifest.plugins[key] = records.map((rec) => {
      const installPath = join(dir, 'cache', rec.installDir);
      if (rec.pluginJsonVersion !== undefined) {
        mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
        writeFileSync(join(installPath, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: key.split('@')[0], version: rec.pluginJsonVersion }));
      }
      return { scope: rec.scope ?? 'user', installPath, version: rec.manifestVersion ?? rec.pluginJsonVersion };
    });
  }
  writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify(manifest));
  return dir;
}

describe('stack plugins — ISSUE #22: marketplace-installed rUv tools are counted', () => {
  it('the four rUv marketplaces are the allow-list', () => {
    expect([...PLUGIN_MARKETPLACES].sort()).toEqual(['cognitum', 'ruflo', 'ruview', 'ruvnet-brain']);
  });

  it('finds rUv plugins, tags them source:plugin, and reads the version from plugin.json', () => {
    const dir = makeFixture({
      'ruvnet-brain@ruvnet-brain': [{ installDir: 'ruvnet-brain/ruvnet-brain/3.9.9', pluginJsonVersion: '3.9.9' }],
      'ruview@ruview': [{ installDir: 'ruview/ruview/0.3.0', pluginJsonVersion: '0.3.0' }],
      'cog-beehive-monitor@cognitum': [{ installDir: 'cognitum/cog-beehive-monitor/1.0.0', pluginJsonVersion: '1.0.0' }],
      'ruflo-core@ruflo': [{ installDir: 'ruflo/ruflo-core/0.2.2', pluginJsonVersion: '0.2.2' }],
    });
    try {
      const rows = listInstalledPlugins(dir);
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

      // Every one of the issue's named tools is present with a real version and source:'plugin'.
      expect(byName['ruvnet-brain']).toMatchObject({ installed: '3.9.9', source: 'plugin', marketplace: 'ruvnet-brain' });
      expect(byName['ruview']).toMatchObject({ installed: '0.3.0', source: 'plugin', marketplace: 'ruview' });
      expect(byName['cog-beehive-monitor']).toMatchObject({ installed: '1.0.0', source: 'plugin', marketplace: 'cognitum' });
      expect(byName['ruflo-core']).toMatchObject({ installed: '0.2.2', source: 'plugin', marketplace: 'ruflo' });

      // None of them is ever null/"not installed" — the exact failure the issue reports.
      for (const r of rows) expect(r.installed, `${r.name} must have a version`).toBeTruthy();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('EXCLUDES plugins from non-rUv marketplaces (allow-list, not a loose scope match)', () => {
    const dir = makeFixture({
      'frontend-design@claude-code-plugins': [{ installDir: 'claude-code-plugins/frontend-design/1.1.0', pluginJsonVersion: '1.1.0' }],
      'ruvnet-brain@ruvnet-brain': [{ installDir: 'ruvnet-brain/ruvnet-brain/3.9.9', pluginJsonVersion: '3.9.9' }],
    });
    try {
      const names = listInstalledPlugins(dir).map((r) => r.name);
      expect(names).toContain('ruvnet-brain');
      expect(names).not.toContain('frontend-design');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('FAMILY name is a secondary matcher — a rUv-named plugin in some other marketplace still counts', () => {
    const dir = makeFixture({
      'ruflo-loop-workers@third-party-market': [{ installDir: 'third-party-market/ruflo-loop-workers/0.2.0', pluginJsonVersion: '0.2.0' }],
    });
    try {
      expect(listInstalledPlugins(dir).map((r) => r.name)).toContain('ruflo-loop-workers');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('picks the HIGHEST readable version across scope records (no stale copy masks a newer one)', () => {
    const dir = makeFixture({
      'ruvnet-brain@ruvnet-brain': [
        { scope: 'project', installDir: 'rb/2.9.0', pluginJsonVersion: '2.9.0' },
        { scope: 'user', installDir: 'rb/3.9.9', pluginJsonVersion: '3.9.9' },
      ],
    });
    try {
      expect(listInstalledPlugins(dir)[0].installed).toBe('3.9.9');
      expect(listInstalledPlugins(dir)[0].instances.map(({ version }) => version)).toEqual(['2.9.0', '3.9.9']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('falls back to the manifest version when plugin.json is unreadable (never "not installed")', () => {
    const dir = makeFixture({
      // no pluginJsonVersion ⇒ no plugin.json written on disk ⇒ pluginVersion() returns null
      'ruview@ruview': [{ installDir: 'ruview/missing', manifestVersion: '0.3.0' }],
    });
    try {
      const row = listInstalledPlugins(dir)[0];
      expect(row).toMatchObject({ name: 'ruview', installed: '0.3.0', source: 'plugin' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('missing installed_plugins.json ⇒ [] (no throw, npm scan unaffected)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-empty-'));
    try { expect(listInstalledPlugins(dir)).toEqual([]); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('installed plugins remain unverified until their marketplace currency is measured', () => {
    const rows = classify([{ name: 'ruvnet-brain', installed: '3.9.9', source: 'plugin', marketplace: 'ruvnet-brain' }]);
    expect(rows[0]).toMatchObject({ state: 'INSTALLED_UNVERIFIED', tag: 'plugin', target: null });
    // A plugin with a version is never BROKEN / UNRESOLVED — i.e. never reported "not installed".
    expect(['BROKEN', 'UNRESOLVED']).not.toContain(rows[0].state);
  });

  it('pluginVersion(installPath) reads .claude-plugin/plugin.json, injectable like installedVersion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-pv-'));
    try {
      mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
      writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
      expect(pluginVersion(dir)).toBe('9.9.9');
      expect(pluginVersion(path.join(dir, 'nope'))).toBe(null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
