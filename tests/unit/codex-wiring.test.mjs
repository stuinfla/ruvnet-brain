// codex-wiring.test.mjs — the second host, and the developer path that must never ship again.
//
// WHAT THIS PROTECTS (issue #42, Henrik Pettersen; ADR-051). Three failures, three shapes.
//
// The first is REACHABILITY. We shipped a working MCP server, a .codex/ directory, and no line of
// code connecting them, so on a Codex host the brain was entirely absent. The fix writes
// [mcp_servers.ruvnet-brain] into ~/.codex/config.toml at install time — into a file that is the
// USER's, already carrying their settings, with no TOML library to parse it. So the merge is the
// load-bearing part: it must add when absent, rewrite its own block when present, preserve every
// other byte, refuse to touch a declaration the user wrote themselves, and be idempotent across
// reinstalls. That is asserted at byte level below, against a pure function, so no test ever goes
// near a real ~/.codex.
//
// The second is TRUTHFULNESS of skill discovery. Codex discovers native plugin SKILL.md files and
// migrates short Claude commands. A skill that depends on a sibling command file absent from the
// migrated directory is the product lying at the user's keyboard, so native skills must be
// self-contained and the retired skill.toml surface must not return.
//
// The third is the LEAK CLASS. .codex/hooks.json shipped a path inside the maintainer's home
// directory. Its removal is worth nothing if the next edit reintroduces it, so the guard is
// repo-wide over both shipped trees rather than a check on the one file we happened to fix.
//
// The five test classes ADR-028 requires:
//   low         — the merge contract, table-driven, pure, no I/O
//   medium      — real filesystem round trip: wireCodexHost() against a temp HOME
//   high        — the invariants that cost something when broken: byte preservation, idempotency,
//                 refusing to clobber a user's own entry, and a doctor that probes instead of asserts
//   numeric     — the leak guard, asserted as a count over every shipped file under .codex/ + plugin/
//   qualitative — native plugin skills are self-contained and discovered by the real Codex loader

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CODEX_DIR = path.join(ROOT, '.codex');

let mergeCodexConfig, wireCodexHost, codexStatus, codexMarketplaceRows, classifyCodexLifecycle;
let wireCodexPlugin, codexPluginStatus, codexLifecycleGuidance;
beforeAll(async () => {
  // Same import-only contract the other installer tests use, so main() never runs on import.
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  ({
    mergeCodexConfig,
    wireCodexHost,
    codexStatus,
    codexMarketplaceRows,
    classifyCodexLifecycle,
    wireCodexPlugin,
    codexPluginStatus,
    codexLifecycleGuidance,
  } = await import('../../bin/install.mjs'));
});

const SERVER = '/some/persistent/home/.claude/ruvnet-brain/mcp/server.mjs';
const START = '# --- ruvnet-brain (managed block, installer-rewritten) ---';
const END = '# --- end ruvnet-brain ---';

// The real shipped config, byte for byte — the thing a reinstall must not damage.
const REAL_CONFIG = '[shell_environment_policy]\ninherit = "core"\n\n[shell_environment_policy.set]\nRUFLO_HARNESS_LOOP = "1"\n';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wiring-'));

// ── low: the merge contract ──────────────────────────────────────────────────────────────────────
describe('mergeCodexConfig — the three outcomes, and only three', () => {
  it('writes a fresh block into an empty/absent config', () => {
    const { text, action } = mergeCodexConfig('', SERVER);
    expect(action).toBe('added');
    expect(text).toContain('[mcp_servers.ruvnet-brain]');
    expect(text).toContain('command = "node"');
    expect(text).toContain(`args = [${JSON.stringify(SERVER)}]`);
    expect(text.startsWith(START)).toBe(true);
    expect(text.trimEnd().endsWith(END)).toBe(true);
  });

  it('treats a non-string (never-read file) as empty rather than throwing', () => {
    expect(mergeCodexConfig(undefined, SERVER).action).toBe('added');
    expect(mergeCodexConfig(null, SERVER).action).toBe('added');
  });

  it('appends after existing content, separated by a blank line', () => {
    const { text, action } = mergeCodexConfig(REAL_CONFIG, SERVER);
    expect(action).toBe('added');
    expect(text.startsWith(REAL_CONFIG)).toBe(true);
    expect(text).toMatch(/RUFLO_HARNESS_LOOP = "1"\n\n# --- ruvnet-brain/);
  });

  it('rewrites its own block in place when the server path changes', () => {
    const first = mergeCodexConfig(REAL_CONFIG, '/old/server.mjs').text;
    const { text, action } = mergeCodexConfig(first, SERVER);
    expect(action).toBe('rewritten');
    expect(text).toContain(`args = [${JSON.stringify(SERVER)}]`);
    expect(text).not.toContain('/old/server.mjs');
    // Exactly one block — a rewrite must not stack a second copy.
    expect(text.split(START).length - 1).toBe(1);
    expect(text.split(END).length - 1).toBe(1);
  });

  for (const [label, header] of [
    ['bare', '[mcp_servers.ruvnet-brain]'],
    ['double-quoted', '[mcp_servers."ruvnet-brain"]'],
    ['single-quoted', "[mcp_servers.'ruvnet-brain']"],
    ['indented', '  [mcp_servers.ruvnet-brain]'],
  ]) {
    it(`leaves a user's own ${label} declaration completely alone`, () => {
      const mine = `${REAL_CONFIG}\n${header}\ncommand = "node"\nargs = ["/my/own/choice.mjs"]\n`;
      const { text, action } = mergeCodexConfig(mine, SERVER);
      expect(action).toBe('user-owned');
      expect(text).toBe(mine); // not one byte changed
    });
  }

  it('does not mistake another server for ours', () => {
    const other = `${REAL_CONFIG}\n[mcp_servers.something-else]\ncommand = "node"\n`;
    expect(mergeCodexConfig(other, SERVER).action).toBe('added');
  });
});

describe('Codex home selection', () => {
  it('honors CODEX_HOME instead of silently wiring the login-home Codex', () => {
    const home = tmpdir();
    const codexDir = path.join(home, 'isolated-codex');
    const server = path.join(home, 'server.mjs');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(server, '// fixture\n');
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      `${START}\n[mcp_servers.ruvnet-brain]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\n${END}\n`,
    );
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexDir;
    try {
      expect(codexStatus()).toMatchObject({
        host: true,
        wired: true,
        serverPath: server,
      });
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    }
  });
});

// ── high: byte preservation + idempotency, the two things a reinstall can destroy ────────────────
describe('a reinstall is safe — every other section survives, and the result is stable', () => {
  it('preserves the pre-existing sections byte for byte', () => {
    const { text } = mergeCodexConfig(REAL_CONFIG, SERVER);
    // Strip our block back out; what remains must be exactly what we were given.
    const without = text.slice(0, text.indexOf(START)).replace(/\n+$/, '\n');
    expect(without).toBe(REAL_CONFIG);
    expect(text).toContain('[shell_environment_policy]');
    expect(text).toContain('inherit = "core"');
    expect(text).toContain('[shell_environment_policy.set]');
    expect(text).toContain('RUFLO_HARNESS_LOOP = "1"');
  });

  it('is idempotent: a second and third run reproduce the first byte for byte', () => {
    const once = mergeCodexConfig(REAL_CONFIG, SERVER).text;
    const twice = mergeCodexConfig(once, SERVER).text;
    const thrice = mergeCodexConfig(twice, SERVER).text;
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it('preserves content the user added AFTER our block', () => {
    const once = mergeCodexConfig(REAL_CONFIG, SERVER).text;
    const withTail = `${once}\n[mcp_servers.theirs]\ncommand = "python"\n`;
    const { text, action } = mergeCodexConfig(withTail, SERVER);
    expect(action).toBe('rewritten');
    expect(text).toContain('[mcp_servers.theirs]');
    expect(text).toContain('command = "python"');
    expect(text).toBe(withTail); // same server path in, same bytes out
  });
});

// ── medium: the real write path, against a temp HOME (never the developer's own ~/.codex) ────────
describe('wireCodexHost — the filesystem round trip', () => {
  it('says nothing and changes nothing when there is no Codex host', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex'); // deliberately not created
    const r = wireCodexHost({ codexDir, serverDir: path.join(home, 'srv'), announce: false });
    expect(r).toEqual({ host: false, action: 'no-host' });
    expect(fs.existsSync(codexDir)).toBe(false);
  });

  it('registers a RESOLVED ABSOLUTE path to a server that really exists', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    const serverDir = path.join(home, '.claude', 'ruvnet-brain', 'mcp');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), REAL_CONFIG);

    const r = wireCodexHost({ codexDir, serverDir, announce: false });
    expect(r.action).toBe('added');
    expect(path.isAbsolute(r.serverPath)).toBe(true);
    // The registration is worthless if the file it names is not there.
    expect(fs.existsSync(r.serverPath)).toBe(true);
    // It is the real supervisor, not a stub.
    expect(fs.readFileSync(r.serverPath, 'utf8')).toContain('search_ruvnet');

    const written = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    expect(written).toContain('[mcp_servers.ruvnet-brain]');
    expect(written).toContain(`args = [${JSON.stringify(r.serverPath)}]`);
    expect(written).toContain('RUFLO_HARNESS_LOOP = "1"'); // theirs, untouched
  });

  it('keeps every default write under the supplied Codex home instead of the real user home', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    const serverDir = path.join(home, '.claude', 'ruvnet-brain', 'mcp');
    fs.mkdirSync(codexDir, { recursive: true });

    const r = wireCodexHost({ codexDir, serverDir, announce: false });

    expect(r.hookWrapperPath).toBe(path.join(home, '.cache', 'ruvnet-brain', 'codex-hook.mjs'));
    expect(fs.existsSync(r.hookWrapperPath)).toBe(true);
  });

  it('creates config.toml when the host exists but has none yet', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const r = wireCodexHost({ codexDir, serverDir: path.join(home, 'srv'), announce: false });
    expect(r.action).toBe('added');
    expect(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')).toContain('[mcp_servers.ruvnet-brain]');
  });

  it('a symlinked config (dotfiles-managed) keeps its identity — the write goes THROUGH the link', (ctx) => {
    // chezmoi/stow/yadm users keep ~/.codex/config.toml as a symlink into a dotfiles repo. The
    // atomic rename swaps inodes, so without realpath resolution it would replace the LINK with a
    // plain file and the user's dotfiles repo would silently stop receiving the config (found by
    // the issue #43 review, 2026-07-26).
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const realConfig = path.join(home, 'dotfiles', 'codex-config.toml');
    fs.mkdirSync(path.dirname(realConfig), { recursive: true });
    fs.writeFileSync(realConfig, REAL_CONFIG);
    const configPath = path.join(codexDir, 'config.toml');
    try { fs.symlinkSync(realConfig, configPath); }
    catch { return ctx.skip(); } // Windows without symlink privilege — POSIX runs keep this honest

    wireCodexHost({ codexDir, configPath, serverDir: path.join(home, 'srv'), announce: false });

    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(realConfig, 'utf8')).toContain('[mcp_servers.ruvnet-brain]');
    expect(fs.readFileSync(realConfig, 'utf8')).toContain('RUFLO_HARNESS_LOOP = "1"');
  });

  it('preserves the config file mode — a chmod-600 config never comes back world-readable', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, 'config.toml');
    fs.writeFileSync(configPath, REAL_CONFIG);
    fs.chmodSync(configPath, 0o600);
    // Assert against what THIS platform made of 0o600 (win32 folds it into the read-only bit),
    // so the test is byte-honest everywhere without a platform fork.
    const modeBefore = fs.statSync(configPath).mode & 0o777;

    wireCodexHost({ codexDir, configPath, serverDir: path.join(home, 'srv'), announce: false });

    expect(fs.readFileSync(configPath, 'utf8')).toContain('[mcp_servers.ruvnet-brain]');
    expect(fs.statSync(configPath).mode & 0o777).toBe(modeBefore);
  });

  it('a second install leaves the file byte-identical', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    const serverDir = path.join(home, '.claude', 'ruvnet-brain', 'mcp');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), REAL_CONFIG);
    const opts = { codexDir, serverDir, announce: false };

    wireCodexHost(opts);
    const after1 = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    const r2 = wireCodexHost(opts);
    const after2 = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');

    expect(after2).toBe(after1);
    expect(r2.changed).toBe(false);
    expect(r2.action).toBe('rewritten');
  });
});

// ── high: the doctor probes disk; it never asserts from "we ran once" ────────────────────────────
describe('codexStatus — the three doctor states, each derived from disk', () => {
  it('no host', () => {
    const home = tmpdir();
    const s = codexStatus({ codexDir: path.join(home, '.codex'), configPath: path.join(home, '.codex', 'config.toml') });
    expect(s).toMatchObject({ host: false, wired: false });
  });

  it('host detected but NOT wired — no entry at all', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, 'config.toml');
    fs.writeFileSync(configPath, REAL_CONFIG);
    expect(codexStatus({ codexDir, configPath })).toMatchObject({ host: true, wired: false, serverPath: null });
  });

  it('host detected but NOT wired — entry present, server MISSING (the worse case)', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, 'config.toml');
    fs.writeFileSync(configPath, mergeCodexConfig(REAL_CONFIG, path.join(home, 'deleted', 'server.mjs')).text);
    const s = codexStatus({ codexDir, configPath });
    // An entry pointing at nothing must NOT read as wired — Codex would fail at spawn time.
    expect(s).toMatchObject({ host: true, wired: false, serverExists: false });
    expect(s.serverPath).toContain('server.mjs');
  });

  it('wired — entry present AND the server it names exists', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    const serverDir = path.join(home, '.claude', 'ruvnet-brain', 'mcp');
    fs.mkdirSync(codexDir, { recursive: true });
    wireCodexHost({ codexDir, serverDir, announce: false });
    const s = codexStatus({ codexDir, configPath: path.join(codexDir, 'config.toml') });
    expect(s).toMatchObject({ host: true, wired: true, serverExists: true });
  });

  it('the probe can FAIL on a broken config — deleting the server flips wired to false', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    const serverDir = path.join(home, '.claude', 'ruvnet-brain', 'mcp');
    fs.mkdirSync(codexDir, { recursive: true });
    const r = wireCodexHost({ codexDir, serverDir, announce: false });
    const configPath = path.join(codexDir, 'config.toml');
    expect(codexStatus({ codexDir, configPath }).wired).toBe(true);
    fs.rmSync(r.serverPath);
    expect(codexStatus({ codexDir, configPath }).wired).toBe(false);
  });
});

describe('Codex plugin/lifecycle state — live CLI shapes become one actionable verdict', () => {
  it('reads the current Codex marketplace list envelope instead of treating it as an array', () => {
    const rows = [{ name: 'ruvnet-brain' }, { name: 'ruflo' }];
    expect(codexMarketplaceRows({ marketplaces: rows })).toEqual(rows);
  });

  it('keeps compatibility with the earlier bare-array marketplace response', () => {
    const rows = [{ name: 'ruvnet-brain' }];
    expect(codexMarketplaceRows(rows)).toEqual(rows);
    expect(codexMarketplaceRows(null)).toEqual([]);
  });

  it('reports active only when every discovered Brain hook is enabled and trusted', () => {
    const plugin = { available: true, installed: true, enabled: true };
    const listed = {
      ok: true,
      value: {
        data: [{
          hooks: [
            { pluginId: 'ruvnet-brain@ruvnet-brain', enabled: true, trustStatus: 'trusted' },
            { pluginId: 'ruvnet-brain@ruvnet-brain', enabled: true, trustStatus: 'trusted' },
            { pluginId: 'other@market', enabled: true, trustStatus: 'untrusted' },
          ],
          errors: [],
        }],
      },
    };
    expect(classifyCodexLifecycle(plugin, listed)).toMatchObject({ state: 'active' });
  });

  it('makes pending trust explicit instead of printing generic install-success instructions', () => {
    const plugin = { available: true, installed: true, enabled: true };
    const listed = {
      ok: true,
      value: {
        data: [{
          hooks: [{ pluginId: 'ruvnet-brain@ruvnet-brain', enabled: true, trustStatus: 'untrusted' }],
          errors: [],
        }],
      },
    };
    expect(classifyCodexLifecycle(plugin, listed)).toMatchObject({
      state: 'pending-trust',
      hooks: [{ trustStatus: 'untrusted' }],
    });
  });

  it('distinguishes a user-disabled plugin from missing runtime hooks and probe failure', () => {
    expect(classifyCodexLifecycle(
      { available: true, installed: true, enabled: false },
      { ok: true, value: { data: [] } },
    ).state).toBe('disabled');
    expect(classifyCodexLifecycle(
      { available: true, installed: true, enabled: true },
      { ok: true, value: { data: [{ hooks: [], errors: [] }] } },
    ).state).toBe('missing-runtime-hooks');
    expect(classifyCodexLifecycle(
      { available: true, installed: true, enabled: true },
      { ok: false, error: 'app-server unavailable' },
    )).toMatchObject({ state: 'probe-failed', error: 'app-server unavailable' });
  });

  it('turns each lifecycle state into one concise user action and no false action when active', () => {
    expect(codexLifecycleGuidance({ state: 'active', hooks: [{}, {}] })).toMatchObject({
      healthy: true,
      action: null,
    });
    expect(codexLifecycleGuidance({ state: 'pending-trust', hooks: [{}] })).toMatchObject({
      healthy: false,
      action: expect.stringContaining('/hooks'),
    });
    expect(codexLifecycleGuidance({ state: 'not-installed', hooks: [] })).toMatchObject({
      healthy: false,
      action: expect.stringContaining('npx ruvnet-brain'),
    });
    expect(codexLifecycleGuidance({ state: 'disabled', hooks: [] })).toMatchObject({
      healthy: false,
      intentional: true,
    });
    expect(codexLifecycleGuidance({ state: 'missing-runtime-hooks', hooks: [] })).toMatchObject({
      healthy: false,
      action: expect.stringContaining('marketplace upgrade'),
    });
    expect(codexLifecycleGuidance({ state: 'probe-failed', error: 'timeout', hooks: [] })).toMatchObject({
      healthy: false,
      detail: expect.stringContaining('timeout'),
    });
  });
});

describe('wireCodexPlugin — install is idempotent, state-driven, and disable-preserving', () => {
  it('refreshes a known marketplace and installs the plugin exactly once', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const calls = [];
    let installed = false;
    const runJson = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin list --json') {
        return {
          ok: true,
          value: {
            installed: installed ? [{
              pluginId: 'ruvnet-brain@ruvnet-brain',
              version: '1.2.3',
              installed: true,
              enabled: true,
            }] : [],
          },
        };
      }
      if (args.join(' ') === 'plugin marketplace list --json') {
        return { ok: true, value: { marketplaces: [{ name: 'ruvnet-brain' }] } };
      }
      if (args.join(' ') === 'plugin marketplace upgrade ruvnet-brain --json') {
        return { ok: true, value: {} };
      }
      if (args.join(' ') === 'plugin add ruvnet-brain@ruvnet-brain --json') {
        installed = true;
        return { ok: true, value: {} };
      }
      return { ok: false, error: `unexpected ${args.join(' ')}` };
    };

    expect(wireCodexPlugin({
      codexDir,
      codexHome: codexDir,
      expectedVersion: '1.2.3',
      runJson,
      announce: false,
    })).toMatchObject({ action: 'installed', installed: true, enabled: true });
    expect(calls.map((args) => args.join(' '))).toEqual([
      'plugin list --json',
      'plugin marketplace list --json',
      'plugin marketplace upgrade ruvnet-brain --json',
      'plugin add ruvnet-brain@ruvnet-brain --json',
      'plugin list --json',
    ]);
  });

  it('leaves a user-disabled installation untouched', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const calls = [];
    const runJson = (args) => {
      calls.push(args);
      return {
        ok: true,
        value: {
          installed: [{
            pluginId: 'ruvnet-brain@ruvnet-brain',
            version: '1.2.3',
            installed: true,
            enabled: false,
          }],
        },
      };
    };

    expect(wireCodexPlugin({ codexDir, runJson, announce: false })).toMatchObject({
      action: 'disabled',
      enabled: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('does not refresh or rewrite an already-current enabled installation', () => {
    const home = tmpdir();
    const codexDir = path.join(home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const calls = [];
    const runJson = (args) => {
      calls.push(args);
      return {
        ok: true,
        value: {
          installed: [{
            pluginId: 'ruvnet-brain@ruvnet-brain',
            version: '1.2.3',
            installed: true,
            enabled: true,
          }],
        },
      };
    };

    expect(wireCodexPlugin({
      codexDir,
      expectedVersion: '1.2.3',
      runJson,
      announce: false,
    })).toMatchObject({ action: 'unchanged', enabled: true });
    expect(calls).toHaveLength(1);
  });

  it('codexPluginStatus degrades cleanly when the CLI is unavailable', () => {
    expect(codexPluginStatus({
      runJson: () => ({ ok: false, error: 'codex not found' }),
    })).toMatchObject({
      available: false,
      installed: false,
      enabled: false,
      error: 'codex not found',
    });
  });
});

// ── native plugin skills: the actual current Codex surface ───────────────────────────────────────
describe('plugin/skills/*/SKILL.md — native, self-contained Codex skills', () => {
  const native = ['brain-console', 'whats-new'];

  for (const name of native) {
    it(`${name} has matching frontmatter and no absent sibling dependency`, () => {
      const file = path.join(ROOT, 'plugin', 'skills', name, 'SKILL.md');
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
      expect(src).toMatch(/description: .{40,}/);
      expect(src).not.toMatch(/follow .*\.md.*same directory/i);
    });
  }

  it('retired skill.toml manifests cannot silently become a second unsupported surface', () => {
    const skills = path.join(CODEX_DIR, 'skills');
    const manifests = fs.existsSync(skills)
      ? fs.readdirSync(skills, { recursive: true }).filter((name) => name.endsWith('skill.toml'))
      : [];
    expect(manifests).toEqual([]);
  });
});

// ── numeric: the leak class, dead forever ────────────────────────────────────────────────────────
describe('no shipped file leaks a developer path', () => {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'clones', 'models-cache']);
  function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.isFile()) out.push(p);
    }
    return out;
  }

  const shipped = [...walk(CODEX_DIR), ...walk(path.join(ROOT, 'plugin'))];

  // A REAL leak names a real account. Prose that TEACHES this bug class has to be able to show the
  // shape it is warning about — plugin/scripts/session-start.sh's comment does exactly that, and
  // learn-capture.sh illustrates the learner with "cd /Users/me/ClientProject". So the guard flags a
  // concrete home directory and allows a short, explicit list of placeholders. Anything not on that
  // list fails, which is what makes it a guard and not a formality.
  const PLACEHOLDERS = new Set(['me', 'you', 'user', 'username', 'someone', 'your-name', '<maintainer>', '<user>', '<you>']);
  const leakedHomes = (src) => [...src.matchAll(/\/Users\/([^/\s"'`)\]]+)\//g)]
    .map((m) => m[1])
    .filter((seg) => !PLACEHOLDERS.has(seg));

  it('there are shipped files to scan (an empty pass proves nothing)', () => {
    expect(shipped.length).toBeGreaterThan(20);
  });

  it('ZERO files under .codex/ or plugin/ ship a real "/Users/<account>/" path', () => {
    const offenders = [];
    for (const f of shipped) {
      let src;
      try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const homes = leakedHomes(src);
      if (homes.length) offenders.push(`${path.relative(ROOT, f)} (${[...new Set(homes)].join(', ')})`);
    }
    // Counted, not just asserted: the number is the claim.
    expect(offenders, `leaked developer paths in: ${offenders.join('; ')}`).toHaveLength(0);
  });

  it('the guard CATCHES a reintroduction — proven by running it on the exact line that shipped', () => {
    // The verbatim defect from .codex/hooks.json:9 as it shipped in 3.9.70-dev.
    const asShipped = '"command": "/bin/bash \\"/Users/stuartkerr/Code/ruvnet-brain/plugin/scripts/version-bump-gate.sh\\""';
    expect(leakedHomes(asShipped)).toEqual(['stuartkerr']);
    // …and it does NOT fire on the placeholders that legitimately appear in explanatory comments.
    expect(leakedHomes('# e.g. "cd /Users/me/ClientProject" records "cd"')).toEqual([]);
    expect(leakedHomes('# (/Users/<maintainer>/Code/ruvnet-brain/...) shipped verbatim')).toEqual([]);
    // The file we fixed is clean under the same rule.
    expect(leakedHomes(fs.readFileSync(path.join(CODEX_DIR, 'hooks.json'), 'utf8'))).toEqual([]);
  });

  it('.codex/hooks.json is valid JSON, carries no unrunnable hook, and explains itself', () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(CODEX_DIR, 'hooks.json'), 'utf8'));
    expect(Object.keys(parsed.hooks)).toHaveLength(0);
    // Assert on the STRUCTURE, not the prose. What must be absent is a duplicate runnable command.
    expect(JSON.stringify(parsed.hooks)).not.toMatch(/command|\/bin\//);
    expect(parsed.description).toMatch(/plugin owns lifecycle integration/i);
  });
});
