// console-wiring-plugins.test.mjs — the wiring card's "plugin" lane must count the plugins Claude
// Code has enabled on this machine.
//
// THE LIE (console audit 2026-09-11): the card said `plugin: 0` with 14 plugins enabled in
// ~/.claude/settings.json (ruvnet-brain@ruvnet-brain among them). classifyCommand() only ever tagged
// PLUGIN when a PROJECT hook command mentioned CLAUDE_PLUGIN_ROOT; the machine-wide settings file —
// the one place plugins are actually switched on — was never read by wiringSurvey() at all.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IMPORT, makeRunner, scratch } from './helpers/console-child.mjs';

let tmp, runJSON;
beforeEach(() => { tmp = scratch('console-wiring-'); ({ runJSON } = makeRunner(tmp)); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('Fix 5 — wiring counts enabled plugins from the machine-wide settings file', () => {
  it('two enabled + one disabled plugin ⇒ plugin: 2, each as a global PLUGIN site', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'ruvnet-brain@ruvnet-brain': true, 'superpowers@claude-plugins-official': true, 'security-guidance@claude-plugins-official': false },
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${HOME}/.npm-global/bin/ruflo" hooks session-start || true' }] }] },
    }));
    const w = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.wiringSurvey()));`);
    expect(w.summary.plugin).toBe(2);
    const plugins = w.sites.filter((s) => s.mechanism === 'PLUGIN').map((s) => s.matcher).sort();
    expect(plugins).toEqual(['ruvnet-brain@ruvnet-brain', 'superpowers@claude-plugins-official']);
    expect(w.sites.filter((s) => s.mechanism === 'PLUGIN').every((s) => s.scope === 'global')).toBe(true);
    // The machine-wide hook is now a site too (global binary) — the same classifier the project scan uses.
    expect(w.sites.some((s) => s.scope === 'global' && s.event === 'SessionStart' && s.mechanism === 'GLOBAL_BINARY')).toBe(true);
  });

  it('no settings file ⇒ plugin: 0 and no invented global sites', () => {
    const w = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.wiringSurvey()));`);
    expect(w.summary.plugin).toBe(0);
    expect(w.sites.filter((s) => s.scope === 'global')).toHaveLength(0);
  });
});
