// tests/unit/dispatch-gate-wiring.test.mjs — issue #112.
//
// THE FAILURE THIS PINS. The `cheap-model-routing` row decided whether anything can invoke the
// router by scanning ONE file, `~/.claude/settings.json`, for the literal string `route-dispatch.sh`.
// That is how the LEGACY standalone install wires the gate. A plugin-marketplace install — the path
// most people are now on — wires it in the plugin's own hooks.json as `hook-shim.mjs route-dispatch`
// and never touches settings.json at all, so the detector answered "nothing can invoke it" about a
// correctly wired gate, and pointed the user at a wiring job already done.
//
// Same shape as every other defect in this file's history: a consumer re-deriving a fact instead of
// reading it from the module that owns it. hook-registry.mjs already enumerates every registry a
// session loads and resolves each command to its handler through hook-shim.mjs's own dispatch table.
//
// The first test drives the SHIPPED detector in a child process against a fixture HOME, because the
// claim under test is one the console prints to a person — asserting on the helper alone would let
// the wiring between them rot unobserved.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dispatchGateWiring } from '../../scripts/capability-registry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(REPO, 'scripts', 'capability-registry.mjs');
const PLUGIN_HOOKS = path.join(REPO, 'plugin', 'hooks', 'hooks.json');

const temps = [];
const temporary = (prefix) => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(value);
  return value;
};
afterEach(() => { for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
};

/**
 * A machine that installed RuvNet Brain from the plugin marketplace: the plugin is enabled, its
 * hooks.json sits in the plugin cache Claude Code boots from, and settings.json holds no PreToolUse
 * hook of its own — exactly the environment in the bug report.
 */
function marketplaceHome({ enabled = true, version = '4.0.8' } = {}) {
  const home = temporary('brain-dispatch-home-');
  write(path.join(home, '.claude', 'settings.json'), {
    hooks: { PreToolUse: [] },
    enabledPlugins: { 'ruvnet-brain@ruvnet-brain': enabled },
  });
  fs.copyFileSync(PLUGIN_HOOKS, (() => {
    const dest = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', version, 'hooks', 'hooks.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return dest;
  })());
  write(path.join(home, '.claude', 'model-router', 'profile.json'), { optIn: true });
  write(path.join(home, '.claude', 'metaharness', 'routing-receipts.jsonl'), `${JSON.stringify({ task: 'probe', model: 'cheap' })}\n`);
  return home;
}

/**
 * A checkout-free tree shaped like the installed console runtime: `plugin/scripts` is present (the
 * shim table is parsed from it) and `plugin/hooks` is NOT, because the runtime copy does not ship
 * it. A stranger's console reads exactly this, which is why the repo's own hooks.json must never be
 * the only place the wiring can be seen from.
 */
function runtimeShapedRepo() {
  const repo = temporary('brain-dispatch-repo-');
  const dest = path.join(repo, 'plugin', 'scripts', 'hook-shim.mjs');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'plugin', 'scripts', 'hook-shim.mjs'), dest);
  return repo;
}

/** Run the SHIPPED detector for one capability with HOME pointed at a fixture. */
function detectInHome(key, home) {
  const out = execFileSync(process.execPath, [
    '-e',
    // pathToFileURL, ALWAYS. A raw absolute path in a dynamic import() throws
    // ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows, where the path begins `D:\\a\\...` and the drive
    // letter reads as an unknown URL scheme. ci.yml documents this as cluster 7, already fixed once
    // on 2026-07-26 — this test reintroduced it the day it was written.
    `import(${JSON.stringify(pathToFileURL(REGISTRY).href)}).then((m) => {
       const c = m.CAPABILITIES.find((x) => x.key === ${JSON.stringify(key)});
       process.stdout.write(JSON.stringify(c.detect({ project: process.cwd() })));
     });`,
    // USERPROFILE as well as HOME. os.homedir() — which installedPluginHooks() defaults to — reads
    // USERPROFILE on Windows and ignores HOME entirely, so a fixture that sets only HOME points the
    // detector at the REAL user profile, where none of these fixtures exist. It then correctly
    // answers `absent`, and the test reads that as the product being broken on Windows when it is
    // the fixture that never described a Windows machine.
  ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: home });
  return JSON.parse(out);
}

describe('issue #112 — the routing gate is found wherever it is actually wired', () => {
  it('does not tell a plugin-marketplace user their wired gate is missing', () => {
    const r = detectInHome('cheap-model-routing', marketplaceHome());
    expect(r.evidence).not.toMatch(/no PreToolUse gate on Task\|Agent is wired/);
    expect(r.evidence).not.toMatch(/nothing can invoke it/);
    expect(r.state).toBe('on');
  });

  it('still reports the gate missing when nothing anywhere declares it', () => {
    const home = marketplaceHome();
    // Same machine, minus the plugin's hooks.json — nothing is wired, and saying so is correct.
    fs.rmSync(path.join(home, '.claude', 'plugins'), { recursive: true, force: true });
    const r = detectInHome('cheap-model-routing', home);
    expect(r.state).toBe('idle');
    expect(r.evidence).toMatch(/no PreToolUse gate on Task\|Agent is wired to route-dispatch\.sh/);
  });
});

describe('dispatchGateWiring reads every registry a session loads', () => {
  it('sees the gate in the plugin copy Claude Code booted, with no checkout present', () => {
    const gate = dispatchGateWiring({ repo: runtimeShapedRepo(), home: marketplaceHome() });
    expect(gate).toEqual({ wired: true, layer: 'plugin-installed', unreadable: false });
  });

  it('sees the gate in settings.json, the way a legacy standalone install wires it', () => {
    const home = temporary('brain-dispatch-legacy-');
    write(path.join(home, '.claude', 'settings.json'), {
      hooks: {
        PreToolUse: [{
          matcher: '^(Task|Agent)$',
          hooks: [{ type: 'command', command: 'bash "/opt/ruvnet/route-dispatch.sh"', timeout: 5 }],
        }],
      },
    });
    const gate = dispatchGateWiring({ repo: runtimeShapedRepo(), home });
    expect(gate.wired).toBe(true);
    expect(gate.layer).toBe('user');
  });

  // A plugin cache directory outlives the plugin being switched off, so the directory alone must not
  // be read as "Claude Code is loading these hooks". Reporting a wired gate on a machine that loads
  // none of it is the same fabricated status this registry exists to refuse.
  it('does not count our own plugin copies while the plugin is disabled', () => {
    const gate = dispatchGateWiring({ repo: runtimeShapedRepo(), home: marketplaceHome({ enabled: false }) });
    expect(gate.wired).toBe(false);
  });

  // Dream Cycle 2026-08-20 (cross-host-conformance): hook-registry.mjs's mesh census learned to
  // read plugin/hooks/codex-hooks.json, and Codex's own `route-dispatch` registration correctly
  // resolves to handler `route-dispatch.sh` through the SAME shim table Claude Code uses. Without
  // an explicit exclusion here, that alone flipped this function to `wired: true, layer: 'codex'`
  // on a machine that never installed Codex — reproduced by reverting the exclusion below and
  // re-running this test, which goes red.
  it('does not report Claude Code\'s gate as wired by Codex\'s own manifest', () => {
    const home = temporary('brain-dispatch-codex-only-');
    // A bare machine: no marketplace install, no plugin cache, no legacy settings.json entry —
    // the ONLY route-dispatch registration anywhere is codex-hooks.json, which this repo ships but
    // Claude Code never loads.
    const gate = dispatchGateWiring({ repo: REPO, home });
    expect(gate.layer).not.toBe('codex');
    expect(gate.wired).toBe(false);
  });

  it('reports a hook on a tool OTHER than subagent dispatch as not wiring this gate', () => {
    const home = temporary('brain-dispatch-othertool-');
    write(path.join(home, '.claude', 'settings.json'), {
      hooks: {
        PreToolUse: [{
          matcher: '^Bash$',
          hooks: [{ type: 'command', command: 'bash "/opt/ruvnet/route-dispatch.sh"', timeout: 5 }],
        }],
      },
    });
    expect(dispatchGateWiring({ repo: runtimeShapedRepo(), home }).wired).toBe(false);
  });
});
