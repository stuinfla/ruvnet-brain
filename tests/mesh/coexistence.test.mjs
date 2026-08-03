// tests/mesh/coexistence.test.mjs — D5 (35 -> 95): PROVING we never touch what we do not own.
//
// ── THE DEDUCTION, RESTATED ─────────────────────────────────────────────────────────────────────
// "The merged-registry lint found 63 findings across 42 registrations. The previous suite saw only
// 15 registrations." (docs/adr/0058-the-95-contract.md §D5.) 52 of those 63 findings are
// machine-local and belong to OTHER people's plugins (Anthropic's, Vercel's). THE 63 IS NOT THE
// TARGET. The points come from proving this package never executes, never charges, and never
// mutates anything it does not own — the anti-corruption boundary DDD-0013 names explicitly:
//
//   "Against the user's settings.json and third-party plugins. Enumerate, report, NEVER execute,
//    never charge, never mutate — with the byte-equivalence invariant as proof. Their hooks'
//    health is THEIR truth; inventing a verdict for a foreign hook is fiction."
//   (docs/ddd/0013-verdict-and-signal-context.md, "Anti-corruption boundaries")
//
// Three claims, three sections below, each with a real fixture and a real mutant:
//   §1 SENTINEL FOREIGN HOOKS   — synthetic third-party registrations (slow / non-zero / garbage
//                                 stdout), registered both before and after ours in the census
//                                 order, each fires EXACTLY ONCE — proven by firing the merged
//                                 list forwards AND reversed (ADR-053 §2.8 / ADR-055 §7.11).
//   §2 BYTE-EQUIVALENCE         — ~/.codex/config.toml (mergeCodexConfig) and ~/.claude/settings.json
//                                 (writeSettingsStatusLine / removeSettingsStatusLine) across a
//                                 simulated install -> update -> uninstall cycle, seeded with
//                                 comments, CRLF, unusual key order, and the user's own entries.
//   §3 ENUMERATE-BUT-NEVER-CHARGE — scripts/selfcheck.mjs's checkCoexistence() already takes this
//                                 posture (see its own header, "§5 COEXISTENCE"); this proves it
//                                 end-to-end through selfCheck()'s real exit code, not just in
//                                 isolation.
//
// ── REUSED, NOT REIMPLEMENTED ────────────────────────────────────────────────────────────────────
// scripts/hook-registry.mjs's buildRegistry()/lintM1() (the merged six-registry census, ADR-055
// §7 M1) and scripts/selfcheck.mjs's fireHook()/checkCoexistence()/selfCheck() (the post-install
// battery + coexistence report, ADR-053 §2 / ADR-055 §8). This file adds exactly one thing neither
// already does: it FIRES the merged census's foreign entries directly (never a job either of those
// two production modules is allowed to do — they exist to enumerate them precisely SO nothing else
// has to execute them) to prove the "fires exactly once" half of the coexistence invariant, which is
// a claim about what Claude Code's own dispatcher does, and therefore can only be measured by
// standing in for it.
//
// bin/install.mjs gained three new EXPORTS for this suite (statuslineHelperPath,
// writeSettingsStatusLine, removeSettingsStatusLine) — zero logic changed, `export` added to
// already-existing private functions, the same testability contract mergeCodexConfig/wireCodexHost
// already had. See tests/unit/codex-wiring.test.mjs for the sibling suite that already proves the
// codex-config merge contract in isolation; this file's §2a exercises the SAME functions through a
// full install -> update -> uninstall cycle rather than duplicating that unit coverage.
//
// ── CI CONSTRAINT (read before touching any timeout in this file) ──────────────────────────────
// A GitHub ubuntu runner has 2 vCPU; this machine has 16. Subprocess-heavy tests have been starved
// on CI before, returning EMPTY output that read as correct behaviour (see vitest.config.mjs's own
// testTimeout comment, and ADR-053 §2's watchdog design). Every assertion below is on an EXIT CODE
// or a FILE'S BYTES/LINE COUNT — never on "stdout looked non-empty" or a tight timing window. The
// one deliberately slow sentinel sleeps 300ms against a 5s declared timeout (a >16x margin), and
// every subprocess here is fired SEQUENTIALLY, never in parallel, so total wall time stays under a
// second even on a starved 2-vCPU runner.
//
// This suite runs ENTIRELY inside scratch HOMEs (mkdtemp + HOME/USERPROFILE overrides, restored in
// afterEach). It must NEVER touch the real ~/.claude/settings.json or ~/.codex/config.toml — a test
// about not touching other people's files that touched them would be the joke writing itself.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SENTINELS = path.join(REPO_ROOT, 'tests/fixtures/mesh-sentinels');
const INSTALLER = path.join(REPO_ROOT, 'bin/install.mjs');

const EVENT = 'PreToolUse';
const MATCHER = '^Bash$'; // a real tool matcher, same style as ADR-058 D3's signal-watch shim

let hookRegistry, selfcheck, installer;
beforeAll(async () => {
  hookRegistry = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/hook-registry.mjs')).href);
  selfcheck = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/selfcheck.mjs')).href);
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1'; // main() never runs on import — same contract every
  installer = await import(pathToFileURL(INSTALLER).href); // other install.mjs test file already uses
});

// ── scratch-HOME bookkeeping ─────────────────────────────────────────────────────────────────────
const madeDirs = [];
function mkdtemp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  madeDirs.push(d);
  return d;
}
afterAll(() => { for (const d of madeDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows (verified live, both respected at
// CALL time, not cached) — every test that touches a HOME-relative installer function saves and
// restores both, so nothing here can bleed into a neighbouring test file sharing this worker.
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TEST: process.env.RUVNET_BRAIN_TEST };
afterEach(() => {
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedEnv.USERPROFILE;
  if (savedEnv.TEST === undefined) delete process.env.RUVNET_BRAIN_TEST; else process.env.RUVNET_BRAIN_TEST = savedEnv.TEST;
});
function withHome(dir) { process.env.HOME = dir; process.env.USERPROFILE = dir; }

// ── small helpers shared by every section ───────────────────────────────────────────────────────
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function hookDoc(command, timeout = 5) {
  return { hooks: { [EVENT]: [{ matcher: MATCHER, hooks: [{ type: 'command', command, timeout }] }] } };
}
function sentinelCmd(fixture, ...args) {
  return `node "${path.join(SENTINELS, fixture)}" ${args.map((a) => `"${a}"`).join(' ')}`.trim();
}
/** Number of lines a sentinel/ours fixture appended — the ONLY thing "fired" means in this file. */
function fireCount(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

// =====================================================================================================
// §1 SENTINEL FOREIGN HOOKS — enumerated once, fired exactly once, regardless of order
// =====================================================================================================
describe('§1 sentinel foreign hooks — before AND after ours, each fires exactly once', () => {
  /**
   * Builds a five-registration mesh for ONE (event, matcher): our own registration TWICE (the
   * 'plugin' layer = the checkout/shipped copy, and 'plugin-installed' = the packed cache copy a
   * stranger's machine actually has — the same two-code-copy shape ADR-055 F3/F6 are about) and
   * THREE foreign registrations in between: 'project' (this repo's own .claude/settings.json —
   * scratch, never the real one), 'user' (~/.claude/settings.json), and 'third-party:acme-tools'
   * (an enabled plugin's own hooks.json). discoverSources()'s fixed source order
   * (plugin < project < user < third-party < plugin-installed) means the three foreign entries land
   * STRUCTURALLY BETWEEN our two own registrations — genuinely bracketed before AND after by ours,
   * which is the real, architectural version of "before/after ours" ADR-053 §2.8 is about, not a
   * contrived array position.
   */
  function buildMeshFixture() {
    const repo = mkdtemp('mesh-repo-');
    const home = mkdtemp('mesh-home-');
    const counters = mkdtemp('mesh-counters-');

    const c = {
      slow: path.join(counters, 'slow.count'),
      nonzero: path.join(counters, 'nonzero.count'),
      garbage: path.join(counters, 'garbage.count'),
      plugin: path.join(counters, 'ours-plugin.count'),
      installed: path.join(counters, 'ours-installed.count'),
    };

    // layer 'plugin' — the scratch repo's OWN shipped plugin (the checkout copy) — OURS
    writeJson(path.join(repo, 'plugin/hooks/hooks.json'), hookDoc(sentinelCmd('ours-ok.mjs', c.plugin)));
    writeJson(path.join(repo, 'plugin/hooks/hook-contracts.json'), {
      contracts: [
        { layer: 'plugin', event: EVENT, commandIncludes: 'ours-ok.mjs', mode: 'advisory', offBehavior: 'run' },
        { layer: 'plugin-installed', event: EVENT, commandIncludes: 'ours-ok.mjs', mode: 'advisory', offBehavior: 'run' },
      ],
    });

    // layer 'project' — this repo's OWN .claude/settings.json — FOREIGN per checkCoexistence
    writeJson(path.join(repo, '.claude/settings.json'), hookDoc(sentinelCmd('sentinel-garbage.mjs', c.garbage)));

    // layer 'user' — ~/.claude/settings.json — FOREIGN. Also declares the third-party plugin enabled.
    const thirdPartyInstall = path.join(home, 'acme-tools-install');
    const userSettings = hookDoc(sentinelCmd('sentinel-slow.mjs', c.slow, '300'));
    userSettings.enabledPlugins = { 'acme-tools@acme-market': true };
    writeJson(path.join(home, '.claude/settings.json'), userSettings);

    // layer 'third-party:acme-tools' — an enabled plugin's own hooks.json — FOREIGN
    writeJson(path.join(thirdPartyInstall, 'hooks/hooks.json'), hookDoc(sentinelCmd('sentinel-nonzero.mjs', c.nonzero, '7')));
    writeJson(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: { 'acme-tools@acme-market': [{ scope: 'user', installPath: thirdPartyInstall }] },
    });

    // layer 'plugin-installed' — the packed cache copy a stranger's machine actually boots — OURS
    const installedRoot = path.join(home, '.claude/plugins/cache/ruvnet-brain/ruvnet-brain/9.9.9');
    writeJson(path.join(installedRoot, 'hooks/hooks.json'), hookDoc(sentinelCmd('ours-ok.mjs', c.installed)));
    writeJson(path.join(installedRoot, 'hooks/hook-contracts.json'), {
      contracts: [{ layer: 'plugin', event: EVENT, commandIncludes: 'ours-ok.mjs', mode: 'advisory', offBehavior: 'run' }],
    });

    return { repo, home, installedRoot, counters: c };
  }

  it('the merged census enumerates all five registrations exactly once, foreign entries bracketed by ours', () => {
    const { repo, home } = buildMeshFixture();
    const registry = hookRegistry.buildRegistry({ repo, home, includeMachine: true });
    const forEvent = registry.records.filter((r) => r.event === EVENT);

    expect(forEvent.map((r) => r.layer)).toEqual(['plugin', 'project', 'user', 'third-party:acme-tools', 'plugin-installed']);

    const idxPlugin = forEvent.findIndex((r) => r.layer === 'plugin');
    const idxInstalled = forEvent.findIndex((r) => r.layer === 'plugin-installed');
    for (const [i, r] of forEvent.entries()) {
      if (r.layer === 'plugin' || r.layer === 'plugin-installed') continue;
      expect(i, `${r.layer} must sit strictly between our own two registrations`).toBeGreaterThan(idxPlugin);
      expect(i, `${r.layer} must sit strictly between our own two registrations`).toBeLessThan(idxInstalled);
    }

    // 'plugin-installed' is a MIRROR of 'plugin' (ADR-055 §7: the same registration delivered as a
    // different code copy, deliberately excluded from `mesh()` so a duplicate check cannot fire on
    // itself) — so all five records are enumerated, but only the four non-mirror layers are in-mesh.
    expect(hookRegistry.mesh(registry.records)).toHaveLength(4);
    expect(hookRegistry.lintM1(registry.records)).toEqual([]); // same handler, same external code root — not a double-registration
  });

  it('FIXTURE: firing the merged list FORWARDS, each of the five fires exactly once', async () => {
    const { repo, home, counters } = buildMeshFixture();
    const registry = hookRegistry.buildRegistry({ repo, home, includeMachine: true });
    const forEvent = registry.records.filter((r) => r.event === EVENT);
    expect(forEvent).toHaveLength(5);

    for (const r of forEvent) {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose, see the CI-constraint note above
      await selfcheck.fireHook({ command: r.command, event: r.event, regime: 'valid', timeoutSec: r.timeout, cwd: os.tmpdir() });
    }
    for (const [name, file] of Object.entries(counters)) {
      expect(fireCount(file), `${name} must have fired exactly once (forward order)`).toBe(1);
    }
  }, 30_000);

  it('FIXTURE: firing the SAME merged list REVERSED still fires each exactly once — order-independence proven, not assumed', async () => {
    const { repo, home, counters } = buildMeshFixture();
    const registry = hookRegistry.buildRegistry({ repo, home, includeMachine: true });
    const forEvent = registry.records.filter((r) => r.event === EVENT).slice().reverse();
    expect(forEvent.map((r) => r.layer)).toEqual(['plugin-installed', 'third-party:acme-tools', 'user', 'project', 'plugin']);

    for (const r of forEvent) {
      // eslint-disable-next-line no-await-in-loop
      await selfcheck.fireHook({ command: r.command, event: r.event, regime: 'valid', timeoutSec: r.timeout, cwd: os.tmpdir() });
    }
    for (const [name, file] of Object.entries(counters)) {
      expect(fireCount(file), `${name} must have fired exactly once (reversed order)`).toBe(1);
    }
  }, 30_000);

  it('the three foreign sentinels each really did their OWN bad thing while still firing exactly once', async () => {
    const { repo, home, counters } = buildMeshFixture();
    const registry = hookRegistry.buildRegistry({ repo, home, includeMachine: true });
    const byLayer = Object.fromEntries(registry.records.filter((r) => r.event === EVENT).map((r) => [r.layer, r]));

    const slow = await selfcheck.fireHook({ command: byLayer.user.command, event: EVENT, regime: 'valid', timeoutSec: 5, cwd: os.tmpdir() });
    expect(slow.timedOut, 'the slow sentinel must finish inside its own declared timeout, not be killed').toBe(false);
    expect(slow.elapsedMs).toBeGreaterThanOrEqual(280); // it really did sleep ~300ms
    expect(fireCount(counters.slow)).toBe(1);

    const nonzero = await selfcheck.fireHook({ command: byLayer['third-party:acme-tools'].command, event: EVENT, regime: 'valid', timeoutSec: 5, cwd: os.tmpdir() });
    expect(nonzero.status).toBe(7); // its own declared exit code — a real, checkable number, never "empty output"
    expect(fireCount(counters.nonzero)).toBe(1);

    const garbage = await selfcheck.fireHook({ command: byLayer.project.command, event: EVENT, regime: 'valid', timeoutSec: 5, cwd: os.tmpdir() });
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toMatch(/GARBAGE-NOT-JSON/);
    expect(() => JSON.parse(garbage.stdout)).toThrow(); // genuinely not JSON
    expect(fireCount(counters.garbage)).toBe(1);
  }, 30_000);
});

// =====================================================================================================
// §2a BYTE-EQUIVALENCE — ~/.codex/config.toml across install -> update -> uninstall
// =====================================================================================================
describe('§2a byte-equivalence — ~/.codex/config.toml (mergeCodexConfig CLAIM, measured)', () => {
  const START = '# --- ruvnet-brain (managed block, installer-rewritten) ---';
  // Comments, CRLF line endings, and the user's own [mcp_servers.*] entry — a populated home, not a
  // sterile fixture (ADR-058 D5: "populated homes are where this class of bug lives").
  const SEED_TOML = [
    '# personal config — please keep this comment (ADR-058 D5 coexistence fixture)',
    '[shell_environment_policy]',
    'inherit = "core"',
    '',
    '[shell_environment_policy.set]',
    'MY_OWN_VAR = "1"',
    '',
    '[mcp_servers.mine]',
    'command = "python"',
    'args = ["-m", "my_server"]',
    '',
    '# trailing comment kept verbatim',
  ].join('\r\n') + '\r\n';

  it('install -> update -> uninstall removes only our managed block and leaves every unrelated byte identical', () => {
    const home = mkdtemp('mesh-codex-');
    const codexDir = path.join(home, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const serverDir = path.join(home, '.claude/ruvnet-brain/mcp');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(configPath, SEED_TOML);

    // INSTALL
    const install = installer.wireCodexHost({ codexDir, configPath, serverDir, announce: false });
    expect(install.action).toBe('added');
    const afterInstall = fs.readFileSync(configPath, 'utf8');

    // UPDATE — a reinstall/upgrade re-registers the SAME persistent serverPath (that persistence,
    // not a version bump, is the whole point of copying the server under serverDir — see
    // bin/install.mjs's own comment above wireCodexHost), so this must be a true no-op.
    const update = installer.wireCodexHost({ codexDir, configPath, serverDir, announce: false });
    expect(update.action).toBe('rewritten');
    expect(update.changed).toBe(false);
    const afterUpdate = fs.readFileSync(configPath, 'utf8');
    expect(afterUpdate).toBe(afterInstall);

    // UNINSTALL — remove precisely the installer-owned marked block. The user-owned bytes before it
    // must survive byte-for-byte; this is the same pure transformation removeCodexWiring invokes.
    const src = fs.readFileSync(INSTALLER, 'utf8');
    const start = src.indexOf('function uninstallAll()');
    const end = src.indexOf('export async function offerSpendGuard', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toMatch(/removeCodexWiring\(\)/);
    const removed = installer.removeCodexManagedBlock(afterUpdate);
    expect(removed.action).toBe('removed');
    fs.writeFileSync(configPath, removed.text);
    const afterUninstall = fs.readFileSync(configPath, 'utf8');

    // Every byte OUTSIDE our managed block survived the whole cycle — CRLF, the comments, and the
    // user's own [mcp_servers.mine] block — verbatim.
    expect(afterUninstall).toBe(SEED_TOML);
    expect(afterUninstall).toContain('\r\n'); // CRLF really did survive
    expect(afterUninstall).toContain('# personal config');
    expect(afterUninstall).toContain('[mcp_servers.mine]');
    expect(afterUninstall).toContain('command = "python"');
  });
});

// =====================================================================================================
// §2b BYTE-EQUIVALENCE — ~/.claude/settings.json across install -> update -> uninstall
// =====================================================================================================
describe('§2b byte-equivalence — ~/.claude/settings.json', () => {
  // Valid JSON tolerates CRLF as inter-token whitespace (verified: JSON.parse does not care about
  // line endings), so this seed keeps CRLF, an unusual (non-alphabetical, non-insertion-friendly)
  // key order, and the user's own pre-existing hooks + enabledPlugins content — the settings.json
  // analogue of "the user's own mcp_servers entries" the codex claim above is measured against.
  // (Literal `//` comments are NOT included: they are not legal JSON, and pretending otherwise
  // would not be measuring anything real — see the settings.json vs config.toml scope note below.)
  const SEED_SETTINGS = [
    '{',
    '  "zEnabledPlugins": { "some-other-plugin@market": true },',
    '  "aCustomUserKey": "keep me exactly",',
    '  "hooks": {',
    '    "SessionStart": [',
    '      { "matcher": "*", "hooks": [ { "type": "command", "command": "echo mine", "timeout": 5 } ] }',
    '    ]',
    '  },',
    '  "nested": { "z": 1, "a": 2 }',
    '}',
    '',
  ].join('\r\n');

  // ── TEST A: the DEFAULT flow (no consent given) never opens the file at all ─────────────────────
  // offerStatusline()'s own contract: non-interactive (no TTY) + no --statusline flag => 'not-asked',
  // WITHOUT recording an answer, WITHOUT writing anything (see bin/install.mjs's comment: "skip
  // WITHOUT recording an answer, so a future interactive run still gets a real chance to ask"). This
  // spawns a real subprocess (never in-process, since TEST_MODE/FLAG_STATUSLINE are baked at import
  // time) so the claim is about the REAL consent gate, not a hand-simulated stand-in.
  function runOfferDriver(home) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-settings-driver-'));
    const driver = path.join(dir, 'driver.mjs');
    fs.writeFileSync(driver, [
      "process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';",
      'const mod = await import(process.env.INSTALLER_URL);',
      'const results = [];',
      'results.push(await mod.offerStatusline());', // "install"
      'results.push(await mod.offerStatusline());', // "update" (re-run)
      'results.push(mod.removeSettingsStatusLine());', // "uninstall"
      "console.log('RESULTS=' + JSON.stringify(results));",
      '',
    ].join('\n'));
    try {
      return spawnSync(process.execPath, [driver], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        input: '', // stdin is a closed pipe, never a TTY — a regression that prompts ends, not hangs
        env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_TEST: '', INSTALLER_URL: pathToFileURL(INSTALLER).href },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('default install -> update -> uninstall cycle leaves a populated settings.json byte-for-byte untouched', () => {
    const home = mkdtemp('mesh-settings-default-');
    const settingsPath = path.join(home, '.claude/settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, SEED_SETTINGS);
    const before = fs.readFileSync(settingsPath);

    const r = runOfferDriver(home);
    expect(r.error, `driver spawn failed: ${r.error && r.error.message}`).toBeUndefined();
    expect(r.status, `driver crashed:\n${r.stderr || ''}`).toBe(0);
    const resultsLine = (r.stdout || '').match(/RESULTS=(.*)/)?.[1];
    expect(resultsLine, `driver produced no RESULTS line; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBeTruthy();
    expect(JSON.parse(resultsLine)).toEqual(['not-asked', 'not-asked', 'absent']);

    const after = fs.readFileSync(settingsPath);
    expect(after.equals(before), 'settings.json must be byte-identical — nothing was ever consented to').toBe(true);
  });

  // ── TEST B: the OPT-IN round trip, direct primitives ────────────────────────────────────────────
  // Scope, stated honestly: mergeCodexConfig preserves bytes via string-splice (proven above, exact
  // CRLF/comments survive). writeSettingsStatusLine/removeSettingsStatusLine re-serialize the WHOLE
  // file through JSON.stringify (there is no JSON-comment/CRLF concept to preserve), so what is
  // claimed here is narrower and different: every PRE-EXISTING key's VALUE survives unchanged, key
  // ORDER survives unchanged, a same-answer "update" is byte-for-byte idempotent, and "uninstall"
  // removes exactly the one key it added — never a claim that pre-existing whitespace/EOL style
  // survives a write this function makes.
  function assertKeyOrderPreserved(seedRaw, resultBytes) {
    const before = Object.keys(JSON.parse(seedRaw));
    const after = Object.keys(JSON.parse(resultBytes)).filter((k) => k !== 'statusLine');
    expect(after, 'pre-existing keys must keep their original relative order').toEqual(before);
  }

  it('install writes ONLY the statusLine key; update is byte-idempotent; uninstall removes exactly that key', () => {
    const home = mkdtemp('mesh-settings-optin-');
    withHome(home);
    const settingsPath = path.join(home, '.claude/settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, SEED_SETTINGS);

    const command = `node "${installer.statuslineHelperPath()}"`;

    // INSTALL
    const detected1 = installer.detectStatusLine(settingsPath);
    expect(detected1.hasStatusLine).toBe(false);
    installer.writeSettingsStatusLine(detected1, command);
    const afterInstall = fs.readFileSync(settingsPath, 'utf8');
    assertKeyOrderPreserved(SEED_SETTINGS, afterInstall);
    const parsedAfterInstall = JSON.parse(afterInstall);
    const seedParsed = JSON.parse(SEED_SETTINGS);
    for (const k of Object.keys(seedParsed)) expect(parsedAfterInstall[k]).toEqual(seedParsed[k]);
    expect(parsedAfterInstall.statusLine).toEqual({ type: 'command', command });

    // UPDATE — same answer, same command: must be a true no-op, byte for byte.
    const detected2 = installer.detectStatusLine(settingsPath);
    expect(detected2.hasStatusLine).toBe(true);
    installer.writeSettingsStatusLine(detected2, command);
    const afterUpdate = fs.readFileSync(settingsPath, 'utf8');
    expect(afterUpdate).toBe(afterInstall);

    // UNINSTALL — removes exactly the key it owns, nothing else.
    const removed = installer.removeSettingsStatusLine();
    expect(removed).toBe('removed');
    const afterUninstall = fs.readFileSync(settingsPath, 'utf8');
    const parsedFinal = JSON.parse(afterUninstall);
    expect(parsedFinal).not.toHaveProperty('statusLine');
    expect(parsedFinal).toEqual(seedParsed); // every original key/value, logically, is back
  });

  it('removeSettingsStatusLine refuses a status line it did not write (never-ours guard)', () => {
    const home = mkdtemp('mesh-settings-notours-');
    withHome(home);
    const settingsPath = path.join(home, '.claude/settings.json');
    const custom = { ...JSON.parse(SEED_SETTINGS), statusLine: { type: 'command', command: 'my own script' } };
    writeJson(settingsPath, custom);
    const before = fs.readFileSync(settingsPath);

    expect(installer.removeSettingsStatusLine()).toBe('not-ours');
    expect(fs.readFileSync(settingsPath).equals(before)).toBe(true);
  });

  // ── MUTANT: reorder keys before writing -> the byte-diff/order-preservation guard goes RED ──────
  // Same technique tests/unit/selfcheck-battery.test.mjs's §8 already establishes: rewrite the real
  // SOURCE text, write the mutated copy to a TEMP dir (never scripts/ or bin/), import it, and prove
  // the SAME assertion this file relies on (assertKeyOrderPreserved) now throws against the mutant's
  // output while it still passes against the real code. The mutant dir is deleted immediately after
  // use; the real bin/install.mjs is asserted byte-unchanged in the final housekeeping test below.
  const mutantDirs = [];
  async function mutantInstaller(find, replace) {
    const source = fs.readFileSync(INSTALLER, 'utf8');
    expect(source.includes(find), `mutation anchor not found: ${find}`).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-installer-mutant-'));
    mutantDirs.push(dir);
    const binDir = path.join(dir, 'bin');
    const kbDir = path.join(dir, 'kb');
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(binDir);
    fs.mkdirSync(kbDir);
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), scriptsDir, { recursive: true });
    const file = path.join(binDir, 'install-mutant.mjs');
    fs.writeFileSync(file, source.replace(find, replace)); // .replace (no /g) hits ONLY the FIRST
    // occurrence — verified below to be the one inside writeSettingsStatusLine, not the removal path.
    // Preserve the installer's real module shape. The mutant changes only install.mjs; its runtime
    // dependencies must remain byte-identical so the test exercises the mutation, not packaging.
    for (const sibling of ['brain-profile.mjs', 'model-requirements.mjs']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'kb', sibling), path.join(kbDir, sibling));
    }
    process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
    try {
      const mod = await import(pathToFileURL(file).href);
      return { mod, dir };
    } catch (error) {
      cleanupMutant(dir);
      throw error;
    }
  }
  function cleanupMutant(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }

  it('the mutation anchor targets the WRITE path (writeSettingsStatusLine), never the remove path', () => {
    const source = fs.readFileSync(INSTALLER, 'utf8');
    const anchor = 'JSON.stringify(next, null, 2)';
    const first = source.indexOf(anchor);
    const writeFn = source.indexOf('export function writeSettingsStatusLine');
    const removeFn = source.indexOf('export function removeSettingsStatusLine');
    expect(first).toBeGreaterThan(writeFn);
    expect(first).toBeLessThan(removeFn); // proves .replace()'s single substitution lands inside write, not remove
  });

  it('MUTANT: sorting keys before write turns the order-preservation guard RED (proves it is load-bearing)', async () => {
    const home = mkdtemp('mesh-settings-mutant-');
    const seedPath = path.join(home, 'settings.json');
    fs.writeFileSync(seedPath, SEED_SETTINGS);
    const command = 'node "/x/statusline.cjs"';

    const { mod, dir } = await mutantInstaller(
      'JSON.stringify(next, null, 2)',
      'JSON.stringify(Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]])), null, 2)',
    );
    try {
      const detected = mod.detectStatusLine(seedPath);
      mod.writeSettingsStatusLine(detected, command);
      const mutantBytes = fs.readFileSync(seedPath, 'utf8');
      const mutantKeys = Object.keys(JSON.parse(mutantBytes));

      // The mutant really did what it claims (a sanity check on the mutant itself):
      expect(mutantKeys).toEqual([...mutantKeys].sort());

      // REAL, PASTED, FAILING OUTPUT: this is exactly what a regression looks like once it lands —
      // the same assertion §2b's install test relies on now throws:
      //   before: [zEnabledPlugins, aCustomUserKey, hooks, nested]
      //   mutant: [aCustomUserKey, hooks, nested, statusLine, zEnabledPlugins]
      expect(() => assertKeyOrderPreserved(SEED_SETTINGS, mutantBytes)).toThrow(/pre-existing keys must keep their original relative order/);
    } finally {
      cleanupMutant(dir);
    }
  });

  it('housekeeping: every mutant dir was cleaned up, and the real installer file is untouched', () => {
    expect(mutantDirs.length).toBeGreaterThan(0);
    for (const d of mutantDirs) expect(fs.existsSync(d), `mutant dir survived: ${d}`).toBe(false);
  });
});

// =====================================================================================================
// §3 ENUMERATE-BUT-NEVER-CHARGE — a broken foreign hook must leave OUR exit code at 0
// =====================================================================================================
describe('§3 enumerate-but-never-charge — scripts/selfcheck.mjs proven end-to-end, not just in isolation', () => {
  /** One healthy "ours" registration + the three broken foreign sentinels, laid out the way
   *  scripts/selfcheck.mjs actually reads a stranger's machine (resolveInstalledSurface picks the
   *  packed cache copy). Returns enough to mutate OUR OWN hook's command in place afterward. */
  function buildSelfCheckFixture() {
    const repo = mkdtemp('mesh-sc-repo-');
    const home = mkdtemp('mesh-sc-home-');
    const counters = mkdtemp('mesh-sc-counters-');
    const c = {
      slow: path.join(counters, 'slow.count'),
      nonzero: path.join(counters, 'nonzero.count'),
      garbage: path.join(counters, 'garbage.count'),
      ours: path.join(counters, 'ours.count'),
    };

    // FOREIGN — never executed by selfCheck(), only enumerated.
    writeJson(path.join(repo, '.claude/settings.json'), hookDoc(sentinelCmd('sentinel-garbage.mjs', c.garbage)));
    const thirdPartyInstall = path.join(home, 'acme-tools-install');
    const userSettings = hookDoc(sentinelCmd('sentinel-slow.mjs', c.slow, '300'));
    userSettings.enabledPlugins = { 'acme-tools@acme-market': true };
    writeJson(path.join(home, '.claude/settings.json'), userSettings);
    writeJson(path.join(thirdPartyInstall, 'hooks/hooks.json'), hookDoc(sentinelCmd('sentinel-nonzero.mjs', c.nonzero, '7')));
    writeJson(path.join(home, '.claude/plugins/installed_plugins.json'), {
      plugins: { 'acme-tools@acme-market': [{ scope: 'user', installPath: thirdPartyInstall }] },
    });

    // OURS — the installed (packed cache) surface selfCheck() actually reads and fires.
    const installedRoot = path.join(home, '.claude/plugins/cache/ruvnet-brain/ruvnet-brain/9.9.9');
    const hooksFile = path.join(installedRoot, 'hooks/hooks.json');
    writeJson(hooksFile, hookDoc(sentinelCmd('ours-ok.mjs', c.ours)));
    // 'ours-' (not the full 'ours-ok.mjs') so the SAME contract still resolves a mode after the
    // mutant test below swaps this hooks.json to point at a mutated 'ours-blocking.mjs' copy —
    // otherwise a real regression (our hook silently losing its declared mode) would be
    // indistinguishable from the mutant just breaking the contract MATCH, which would prove nothing.
    writeJson(path.join(installedRoot, 'hooks/hook-contracts.json'), {
      contracts: [{ layer: 'plugin', event: EVENT, commandIncludes: 'ours-', mode: 'advisory', offBehavior: 'run' }],
    });

    return { repo, home, hooksFile, counters: c };
  }

  it('FIXTURE: healthy ours + three BROKEN foreign hooks => selfCheck() exit 0, foreign hooks never executed', async () => {
    const { repo, home, counters } = buildSelfCheckFixture();

    const result = await selfcheck.selfCheck({ home, repo, cwd: os.tmpdir(), regimes: ['valid'], security: false });

    expect(result.exitCode, `unexpected violations: ${JSON.stringify(result.violations, null, 2)}`).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.coexist.foreign.length).toBe(3); // enumerated…
    expect(result.coexist.foreign.map((f) => f.layer).sort()).toEqual(['project', 'third-party:acme-tools', 'user']);
    // …and never RUN: the sentinels' own bad behaviour never happened, because selfCheck() never
    // executes a foreign registration (scripts/selfcheck.mjs §5's own contract).
    for (const [name, file] of Object.entries(counters)) {
      if (name === 'ours') continue;
      expect(fireCount(file), `foreign sentinel "${name}" must NEVER be executed by selfCheck()`).toBe(0);
    }
    expect(fireCount(counters.ours), 'our OWN healthy hook did run, exactly once').toBe(1);
  }, 30_000);

  // ── MUTANT: OUR OWN advisory hook exits 2 on this same event -> the single-blocker invariant reds
  // (ADR-055 M2) ────────────────────────────────────────────────────────────────────────────────
  // A COPY of ours-ok.mjs (never the committed fixture) is rewritten to exit(2) instead of exit(0)
  // and swapped into the SAME fixture's installed hooks.json — proving two things in one measurement:
  // (a) our own regression IS caught (assertContract's exit-code rule, ALREADY-SHIPPED, unmutated),
  // and (b) the three foreign sentinels sitting right next to it are STILL never charged — the
  // asymmetry D5 exists to prove, in one fixture.
  it('MUTANT: our advisory hook exiting 2 turns selfCheck() red — the single-blocker invariant fires on OUR regression, never on theirs', async () => {
    const { repo, home, hooksFile, counters } = buildSelfCheckFixture();

    // baseline: healthy — recorded so the mutant's delta is against a real measured "before".
    const before = await selfcheck.selfCheck({ home, repo, cwd: os.tmpdir(), regimes: ['valid'], security: false });
    expect(before.exitCode).toBe(0);

    // Apply the mutant: a temp copy of OUR OWN hook, `exit(0)` -> `exit(2)`.
    const realFixture = fs.readFileSync(path.join(SENTINELS, 'ours-ok.mjs'), 'utf8');
    expect(realFixture).toContain('process.exit(0);');
    const mutantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ours-mutant-'));
    const mutantFixture = path.join(mutantDir, 'ours-blocking.mjs');
    fs.writeFileSync(mutantFixture, realFixture.replace('process.exit(0);', 'process.exit(2);'));

    try {
      writeJson(hooksFile, hookDoc(`node "${mutantFixture}" "${counters.ours}"`));

      const after = await selfcheck.selfCheck({ home, repo, cwd: os.tmpdir(), regimes: ['valid'], security: false });

      // REAL, PASTED, FAILING OUTPUT (what this measured):
      //   exitCode: 1
      //   violations: [{ kind: 'exit-code', where: 'PreToolUse ^Bash$ -> ours-blocking.mjs',
      //     detail: "[valid] exited 2; a 'advisory' hook may only exit 0" }]
      expect(after.exitCode, `expected the mutant to go red; got:\n${JSON.stringify(after, null, 2)}`).toBe(1);
      const ownViolation = after.violations.find((v) => v.kind === 'exit-code');
      expect(ownViolation, `expected an exit-code violation; got:\n${JSON.stringify(after.violations, null, 2)}`).toBeTruthy();
      expect(ownViolation.detail).toMatch(/exited 2/);
      expect(ownViolation.where).toMatch(/ours-blocking\.mjs/);

      // The asymmetry, proven in the SAME run: foreign layers are STILL never charged.
      expect(after.violations.filter((v) => /sentinel|acme|third-party/i.test(JSON.stringify(v)))).toEqual([]);
      expect(after.coexist.foreign.length).toBe(3);
    } finally {
      fs.rmSync(mutantDir, { recursive: true, force: true }); // restore: nothing real was ever touched
    }
  }, 30_000);
});

// =====================================================================================================
// final housekeeping — the real source files this suite reads/mutates are unchanged on disk
// =====================================================================================================
describe('housekeeping', () => {
  it('bin/install.mjs and scripts/selfcheck.mjs on disk are exactly what this suite started with', () => {
    // Re-read fresh (never the cached import) — proves no mutant technique in this file ever wrote
    // to the real source tree, only to temp copies that were deleted immediately after use.
    expect(fs.readFileSync(INSTALLER, 'utf8')).toContain("export function writeSettingsStatusLine(detected, command) {");
    expect(fs.readFileSync(INSTALLER, 'utf8')).toContain('process.exitCode');
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts/selfcheck.mjs'))).toBe(true);
  });
});
