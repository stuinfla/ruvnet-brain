import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { automaticHookRetirementStatus, retireManagedHookRegistrations, wireCodexHost } from '../../bin/install.mjs';
import { continuityContractIds, continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';
import { resolveBash } from '../../plugin/scripts/hook-shim-bash.mjs';
import { rmAfterReap } from '../helpers/reap-detached.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BASH = resolveBash();
const gated = BASH ? it : it.skip;

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

/**
 * EVERY HOOK, BOTH HOSTS, IN A PROJECT THAT IS NOT THIS ONE.
 *
 * Dream Cycle 2026-10-05 — cross-host-conformance / codex-parity + stranger-project-behaviour.
 *
 * This describe block real-fires every command both manifests register, on both hosts, in a
 * genuine stranger project (no git, no kb, no .swarm, no docs/adr, no evals). It existed here from
 * 2026-08-19 (the owner's literal "a ton of hook errors in another project" complaint) through
 * 2026-09-07, when commit 00526b12 ("retire automatic hooks") replaced this whole file with the
 * schema/policy checks above and dropped it — not because the hooks it guarded were retired: both
 * manifests have since grown BACK to a full automatic plane (decision-gate, grounding-stamp,
 * grounding-turn-mark/gate, capacity-aware-parallel-work, unprompted-speech, session-snapshot at
 * seven events), the exact shape of hook that caused the original incident. Since 2026-09-07,
 * `npm run test:integration` has been green with zero real-firing coverage of any of them, on
 * either host, in a stranger project — "a guard that cannot fail is not a guard."
 *
 * Restored, not reinvented: the fixtures below (`strangerProject`, `installCodexSpine`,
 * `hookCommands`, `fire`) are the same mechanism this file used before 00526b12, reproduced from
 * `git show 00526b12^:tests/integration/hook-conformance-both-hosts.test.mjs`. The ADR-063
 * managed-memory-boundary describe block that used to follow this one is deliberately NOT restored
 * tonight — a second, independent concern, left for its own candidate so this diff stays reviewable.
 */
const cleanupStranger = (dir) => rmAfterReap(path.join(dir, '.conformance-home'), dir);

/** A project this plugin has never seen: no git, no kb, no .swarm, no docs/adr, no evals. */
function strangerProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stranger-'));
  fs.writeFileSync(path.join(d, 'index.js'), '// somebody else\n');
  return d;
}

/**
 * Codex has no frozen-fallback: every Codex hook command hits two undocumented silent-exit
 * branches (no installed `codex-hook.mjs`, no resolvable spine) before reaching any shared hook
 * body unless a real Stable Spine (ADR-023) exists at `RUVNET_BRAIN_HOME`. Without this, every
 * "no stderr / no artifacts / within timeout" assertion below would pass by construction for
 * Codex, never by measurement — the hook never ran. Test-only: no production file is read from
 * anywhere but the real checkout, and nothing here is imported by shipped code.
 */
function installCodexSpine(brainHome) {
  const version = 'conformance';
  const codeRoot = path.join(brainHome, 'versions', version);
  fs.mkdirSync(codeRoot, { recursive: true });
  fs.cpSync(path.join(ROOT, 'plugin'), codeRoot, { recursive: true });
  fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({
    generation: version, version, codeRoot: `versions/${version}`,
  }));
  fs.copyFileSync(
    path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'),
    path.join(brainHome, 'codex-hook.mjs'),
  );
}

/** Every command both manifests register, with the event it fires on. */
export function hookCommands() {
  const out = [];
  for (const [host, file] of [['claude-code', 'hooks.json'], ['codex', 'codex-hooks.json']]) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', file), 'utf8'));
    for (const [event, groups] of Object.entries(m.hooks ?? {})) {
      for (const g of groups ?? []) for (const h of g.hooks ?? []) {
        if (h.command) out.push({ host, event, command: h.command, timeout: h.timeout });
      }
    }
  }
  return out;
}

/** A payload shaped the way the hosts actually send them. */
const payloadFor = (event) => JSON.stringify({
  session_id: `conformance-${Math.random().toString(16).slice(2)}`,
  hook_event_name: event,
  prompt: 'add a helper to index.js',
  tool_name: 'Bash',
  tool_input: { command: 'ls -la', file_path: 'index.js' },
  tool_response: { success: true },
});

function fire({ command, event, cwd, host, env: envOverride, payload }) {
  const started = Date.now();
  const brainHome = path.join(cwd, '.conformance-home');
  if (host === 'codex') installCodexSpine(brainHome);
  const r = spawnSync(BASH, ['-c', command], {
    cwd,
    input: payload ?? payloadFor(event),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
      RUVNET_BRAIN_PROJECT_DIR: cwd,
      RUVNET_CONFIG_ROOT: path.join(cwd, '.conformance-config'), // keep real ledgers untouched
      // Point at an empty home: forces the frozen-plugin fallback on Claude Code (the real fresh-
      // install path) and a real, freshly-built spine on Codex (installCodexSpine, above) — tests
      // the payload being shipped, not whatever generation happens to be installed on this machine.
      RUVNET_BRAIN_HOME: brainHome,
      ...envOverride,
    },
  });
  return { ...r, ms: Date.now() - started };
}

describe('every registered hook behaves in a project this plugin does not own', () => {
  const commands = hookCommands();

  it('finds hooks in BOTH manifests, or this whole block is vacuous', () => {
    const byHost = commands.reduce((a, c) => ({ ...a, [c.host]: (a[c.host] ?? 0) + 1 }), {});
    expect(byHost['claude-code'] ?? 0, 'no Claude Code hooks found — the manifest path is wrong').toBeGreaterThan(5);
    expect(byHost.codex ?? 0, 'no Codex hooks found — Codex is not being checked at all').toBeGreaterThan(3);
  });

  gated('TEETH: no hook writes to stderr or fails in a stranger project', () => {
    // stderr is what a host renders as "hook error". This is the owner's literal complaint.
    const offenders = [];
    for (const c of commands) {
      const dir = strangerProject();
      try {
        const r = fire({ ...c, cwd: dir });
        const err = String(r.stderr || '').trim();
        if (err && r.status !== 2) offenders.push(`${c.host}/${c.event}: STDERR "${err.slice(0, 90)}"`);
        if (r.status !== 0 && r.status !== 2) offenders.push(`${c.host}/${c.event}: exit ${r.status}`);
        if (r.error) offenders.push(`${c.host}/${c.event}: ${r.error.message.slice(0, 80)}`);
      } finally { cleanupStranger(dir); }
    }
    expect(offenders, 'these emit noise or fail in a project that is not ruvnet-brain — a host '
      + 'renders that to the user as a hook error').toEqual([]);
  }, 600_000);

  gated('TEETH: no hook creates anything in a stranger working tree', () => {
    // Measured 2026-08-13: hooks planted .swarm/, .claude-flow/ and a 1.5MB database file in
    // unrelated repos. ADR-058 D5: never touch what we do not own.
    const offenders = [];
    for (const c of commands) {
      const dir = strangerProject();
      try {
        const before = fs.readdirSync(dir).sort().join(',');
        fire({ ...c, cwd: dir });
        const after = fs.readdirSync(dir).filter((n) => !n.startsWith('.conformance-')).sort().join(',');
        if (after !== before) offenders.push(`${c.host}/${c.event}: left behind ${after}`);
      } finally { cleanupStranger(dir); }
    }
    expect(offenders, 'these mutate a project the plugin does not own').toEqual([]);
  }, 600_000);

  gated('TEETH: every hook finishes well inside its own declared timeout', () => {
    const offenders = [];
    for (const c of commands) {
      const dir = strangerProject();
      try {
        const r = fire({ ...c, cwd: dir });
        const budget = (c.timeout ?? 30) * 1000;
        if (r.ms > budget * 0.8) offenders.push(`${c.host}/${c.event}: ${r.ms}ms of a ${budget}ms budget`);
      } finally { cleanupStranger(dir); }
    }
    expect(offenders, 'these run too close to the host timeout that kills them; the host reports '
      + 'the kill as a hook error, intermittently, on ordinary tool calls').toEqual([]);
  }, 600_000);
});
