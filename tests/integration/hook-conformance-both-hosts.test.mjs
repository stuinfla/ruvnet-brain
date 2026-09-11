import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { automaticHookRetirementStatus, retireManagedHookRegistrations, wireCodexHost } from '../../bin/install.mjs';
import { continuityContractIds, continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('automatic Brain continuity hooks are constrained on both hosts', () => {
  it('ships schema-valid continuity-only Claude and Codex registries', () => {
    const result = automaticHookRetirementStatus(ROOT);
    expect(result.errors).toEqual([]);
    expect(result.registrations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /**
   * The MANIFEST must match the POLICY. This assertion used to hardcode the two-handler plane, so it
   * measured a number rather than an agreement and went red the moment the plane legitimately grew.
   * Deriving the expectation from continuity-hook-policy.mjs keeps the real property — the shipped
   * JSON and the enforcing code agree — while letting the plane change in exactly one place.
   */
  it('keeps the out-of-shim contract inventory equal to the declared continuity plane', () => {
    const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/hook-contracts.json'), 'utf8'));
    expect(contracts.contracts.map((entry) => `${entry.event}:${entry.id}`).sort())
      .toEqual(continuityContractIds().sort());
    expect([...new Set(contracts.matcherAllowlist.map((entry) => `${entry.event}:${entry.matcher}`))].sort())
      .toEqual([...new Set(continuityRegistrations().map((spec) => `${spec.event}:${spec.matcher}`))].sort());
    // Every contract names hosts the policy actually permits for that (event, id).
    for (const entry of contracts.contracts) {
      const spec = continuityRegistrations().find((row) => row.event === entry.event && row.id === entry.id);
      expect(spec, `${entry.event}:${entry.id} is not in the policy`).toBeTruthy();
      expect(entry.hosts.slice().sort()).toEqual(spec.hosts.slice().sort());
    }
  });

  it.each([
    ['Claude hook', 'plugin/hooks/hooks.json', { hooks: { UserPromptSubmit: [{ hooks: [{ command: 'node stale.mjs' }] }] } }],
    ['Codex Stop hook', 'plugin/hooks/codex-hooks.json', { hooks: { Stop: [{ hooks: [{ command: 'node stale.mjs' }] }] } }],
    ['malformed group', 'plugin/hooks/hooks.json', { hooks: { SessionStart: [{}] } }],
    ['project hook', '.codex/hooks.json', { hooks: { Stop: [{ hooks: [{ command: 'node stale.mjs' }] }] } }],
    // THE LEGACY-GATE MUTANT, kept explicit because growing the plane is exactly when a reviewer
    // will ask "did you just re-open the door?". A retired PreToolUse grounding gate must still fail
    // the check even though the plane now has five events instead of two.
    ['retired PreToolUse grounding gate', 'plugin/hooks/hooks.json', {
      hooks: {
        SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" session-start || true', timeout: 5 }] }],
        PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ground-ruvnet || true', timeout: 10 }] }],
      },
    }],
  ])('fails closed on an injected %s', (_label, relative, document) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-hook-mutant-'));
    try {
      fs.cpSync(path.join(ROOT, 'plugin'), path.join(temp, 'plugin'), { recursive: true });
      fs.cpSync(path.join(ROOT, '.claude'), path.join(temp, '.claude'), { recursive: true });
      fs.cpSync(path.join(ROOT, '.codex'), path.join(temp, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(temp, relative), JSON.stringify(document));
      expect(automaticHookRetirementStatus(temp).ok).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('fails closed when a host adapter is redirected away from the canonical empty registry', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-hook-pointer-mutant-'));
    try {
      fs.cpSync(path.join(ROOT, 'plugin'), path.join(temp, 'plugin'), { recursive: true });
      const adapterFile = path.join(temp, 'plugin/host-adapters/codex.json');
      const adapter = JSON.parse(fs.readFileSync(adapterFile, 'utf8'));
      adapter.hooks = 'plugin/hooks/alternate.json';
      fs.writeFileSync(adapterFile, JSON.stringify(adapter));
      expect(automaticHookRetirementStatus(temp)).toMatchObject({ ok: false });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('retires only owned settings registrations during an offline host install, idempotently', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-owned-hook-cleanup-'));
    try {
      const codexDir = path.join(home, '.codex');
      const wrapper = path.join(home, '.cache', 'ruvnet-brain', 'codex-hook.mjs');
      const file = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });
      fs.mkdirSync(path.dirname(wrapper), { recursive: true });
      fs.writeFileSync(wrapper, '// old bridge');
      const foreign = { type: 'command', command: 'node /foreign/codex-hook.mjs' };
      const mixed = { type: 'command', command: `node "${wrapper}"; node /foreign/task.mjs` };
      fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: {
        Stop: [{ matcher: '*', hooks: [foreign, mixed,
          { type: 'command', command: `node "${wrapper}"` },
          { pluginId: 'ruvnet-brain@ruvnet-brain', type: 'command', command: 'old callback' }] }] } }));
      const installed = wireCodexHost({ codexDir, serverDir: path.join(home, 'mcp'), announce: false });
      expect(installed.action).toBe('added');
      expect(installed.hookWrapperInstalled).toBe(true);
      const after = fs.readFileSync(file, 'utf8');
      expect(JSON.parse(after)).toEqual({ permissions: { allow: ['Read'] }, hooks: {
        Stop: [{ matcher: '*', hooks: [foreign, mixed] }] } });
      expect(retireManagedHookRegistrations({ home, codexDir }).removed).toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toBe(after);
      expect(fs.existsSync(installed.serverPath)).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('an update refreshes the exact Codex bridge while preserving foreign config bytes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-hook-retirement-'));
    try {
      const codexDir = path.join(home, '.codex');
      const configPath = path.join(codexDir, 'config.toml');
      const wrapper = path.join(home, '.cache', 'ruvnet-brain', 'codex-hook.mjs');
      fs.mkdirSync(path.dirname(wrapper), { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(configPath, 'model = "user-choice"\n');
      fs.writeFileSync(wrapper, 'legacy bridge');

      const first = wireCodexHost({
        codexDir,
        configPath,
        serverDir: path.join(home, '.claude', 'ruvnet-brain', 'mcp'),
        hookWrapperPath: wrapper,
        announce: false,
      });
      const afterFirst = fs.readFileSync(configPath, 'utf8');
      const second = wireCodexHost({
        codexDir,
        configPath,
        serverDir: path.join(home, '.claude', 'ruvnet-brain', 'mcp'),
        hookWrapperPath: wrapper,
        announce: false,
      });

      expect(first.hookWrapperInstalled).toBe(true);
      expect(second.hookWrapperInstalled).toBe(true);
      expect(fs.existsSync(wrapper)).toBe(true);
      expect(afterFirst).toContain('model = "user-choice"');
      expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
