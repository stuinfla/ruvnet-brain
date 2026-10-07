import { spawnSync as hostSpawnSync } from 'node:child_process';
// hook-shim.test.mjs — the Stable Spine's hook dispatcher (ADR-023 §3). Runs the REAL
// plugin/scripts/hook-shim.mjs as a subprocess against a temp RUVNET_BRAIN_HOME + a fake
// CLAUDE_PLUGIN_ROOT. Execution fixtures need bash → honest skipIf(win32), matching the
// derived-status.test.mjs convention.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'hook-shim.mjs');
const HOOKS = path.join(path.dirname(SHIM), '..', 'hooks', 'hooks.json');
const SOURCE_PLUGIN_ROOT = path.dirname(path.dirname(SHIM));
const VERSION = JSON.parse(fs.readFileSync(path.join(SOURCE_PLUGIN_ROOT, '..', 'package.json'), 'utf8')).version;

let HOME_DIR, PLUGIN_ROOT;
const run = (hookId) => spawnSync(process.execPath, [SHIM, hookId], {
  encoding: 'utf8',
  env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
});

function runRegistered(hookId, input) {
  return spawnSync(process.execPath, [SHIM, hookId], {
    input,
    encoding: 'utf8',
    env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: SOURCE_PLUGIN_ROOT },
  });
}

/** Seed a spine generation whose scripts print/exit as instructed. */
function seedSpine(version, scripts) {
  const root = path.join(HOME_DIR, 'versions', version);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  // A real immutable generation carries its declaration-derived SessionStart deadline.
  fs.cpSync(path.join(SOURCE_PLUGIN_ROOT, 'hooks'), path.join(root, 'hooks'), { recursive: true });
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(root, 'scripts', name), body);
  fs.writeFileSync(path.join(HOME_DIR, 'active.json'), JSON.stringify({ generation: 1, version, codeRoot: path.join('versions', version) }));
  fs.writeFileSync(path.join(HOME_DIR, '.spine-seeded'), 'yes');
  return root;
}

beforeEach(() => {
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-home-'));
  PLUGIN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-plugin-'));
  fs.mkdirSync(path.join(PLUGIN_ROOT, 'scripts'), { recursive: true });
});
afterEach(() => { fs.rmSync(HOME_DIR, { recursive: true, force: true }); fs.rmSync(PLUGIN_ROOT, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('hook-shim.mjs — restart-free hook dispatch', () => {
  it('THE core promise: flipping the spine changes what a hook runs, same process boundary, no restart', () => {
    seedSpine('1.0.0', { 'ground-ruvnet.sh': '#!/bin/bash\necho FROM-GEN-1\n' });
    expect(run('ground-ruvnet').stdout).toMatch(/FROM-GEN-1/);
    // "update": new generation lands, active.json flips — exactly what update-apply does
    seedSpine('2.0.0', { 'ground-ruvnet.sh': '#!/bin/bash\necho FROM-GEN-2\n' });
    expect(run('ground-ruvnet').stdout).toMatch(/FROM-GEN-2/); // next fire = new code. No restart.
  });

  it('hands the active generation version to SessionStart so the banner names the code executing', () => {
    seedSpine(VERSION, { 'session-start-core.mjs': 'process.stdout.write(process.env.RUVNET_BRAIN_ACTIVE_VERSION || "missing");\n' });
    const result = run('session-start');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(VERSION);
  });

  it('route-dispatch is advisory even when a stale body tries to return exit 2', () => {
    seedSpine('1.0.0', { 'route-dispatch.sh': '#!/bin/bash\necho BLOCKED >&2\nexit 2\n' });
    const r = run('route-dispatch');
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/BLOCKED/);
  });

  it('the explicit blocking shim sends one bounded payload to its consuming hook body', () => {
    seedSpine('1.0.0', {
      // ADR-067: the registered blocking hook on the write path is now decision-gate. The BOUND is
      // the property under test and it is unchanged — declared as `stdinBytes: 65536` on the shim
      // table entry — so the stub simply reports how many bytes actually arrived.
      'decision-gate.mjs': 'let n = 0;\nprocess.stdin.on("data", (c) => { n += c.length; });\nprocess.stdin.on("end", () => process.stdout.write(String(n)));\n',
    });
    const result = runRegistered('decision-gate', 'p'.repeat(70_000));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, 'a 70KB payload must arrive truncated to the declared bound').toBe('65536');
  });

  it('every preserved explicit payload consumer receives the exact closed-pipe payload', () => {
    // ADR-067 collapsed four PreToolUse walls into one gate, so `ground-before-write`, `design-wall`
    // and `protect-state` are no longer registered hooks — they are policies the gate spawns. This
    // list is therefore DERIVED from hooks.json rather than restated, which is also why it went stale
    // the moment the registry changed: a hand-listed set of registrations is a second copy of the
    // registry. The gate's own forwarding to its policies is covered by decision-gate.test.mjs.
    const shimSource = fs.readFileSync(SHIM, 'utf8');
    const registeredIds = [...new Set([...shimSource.matchAll(/'([a-z][a-z0-9-]+)':\s*\{/g)].map((match) => match[1]))];
    const FILES = {
      'route-dispatch': 'route-dispatch.sh',
      'unprompted-speech': 'unprompted-runtime.mjs',
      'ground-ruvnet': 'ground-ruvnet.sh',
      'verify-interface': 'verify-interface.sh',
      'learn-capture': 'learn-capture.mjs',
    };
    const consumers = registeredIds.filter((id) => FILES[id]).map((id) => [id, FILES[id]]);
    expect(consumers.length, 'derived nothing — the registry parse is wrong and this is vacuous')
      .toBeGreaterThan(2);
    for (const [hookId, file] of consumers) {
      const payload = `payload-for-${hookId}`;
      seedSpine('1.0.0', {
        [file]: file.endsWith('.mjs')
          ? 'let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => process.stdout.write(input));\n'
          : '#!/bin/bash\nIFS= read -r payload || true\nprintf "%s" "$payload"\n',
      });
      const result = runRegistered(hookId, payload);
      expect(result.status, `${hookId}: ${result.stderr}`).toBe(0);
      expect(result.stdout, hookId).toBe(payload);
    }
  });

  it('ADVISORY mode can never block a turn — a crashing hook still exits 0', () => {
    seedSpine('1.0.0', { 'ground-ruvnet.sh': '#!/bin/bash\nexit 97\n' });
    expect(run('ground-ruvnet').status).toBe(0);
  });

  it('dispatches the successful-search grounding stamp as an advisory hook', () => {
    seedSpine('1.0.0', { 'grounding-stamp.sh': '#!/bin/bash\necho STAMP-DISPATCHED\nexit 97\n' });
    const result = run('grounding-stamp');
    expect(result.stdout).toContain('STAMP-DISPATCHED');
    expect(result.status).toBe(0);
  });

  it('no spine at all (first install) → quiet fallback to the frozen plugin dir', () => {
    fs.writeFileSync(path.join(PLUGIN_ROOT, 'scripts', 'ground-ruvnet.sh'), '#!/bin/bash\necho FROZEN-FALLBACK\n');
    const r = run('ground-ruvnet');
    expect(r.stdout).toMatch(/FROZEN-FALLBACK/);
    expect(r.stderr).not.toMatch(/hook-shim/); // first install is NOT an error — stays quiet
  });

  it('a seeded-then-broken spine falls back LOUDLY (finding 25: silence would mask corruption)', () => {
    fs.writeFileSync(path.join(HOME_DIR, '.spine-seeded'), 'yes');
    fs.writeFileSync(path.join(HOME_DIR, 'active.json'), '{corrupt json');
    fs.writeFileSync(path.join(PLUGIN_ROOT, 'scripts', 'ground-ruvnet.sh'), '#!/bin/bash\necho FROZEN-FALLBACK\n');
    const r = run('ground-ruvnet');
    expect(r.stdout).toMatch(/FROZEN-FALLBACK/); // still works…
    expect(r.stderr).toMatch(/spine unreadable/); // …but says so
  });

  it('containment (finding 13): a codeRoot OUTSIDE versions/ is refused → fallback, never executed', () => {
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'evil-'));
    fs.mkdirSync(path.join(evil, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'scripts', 'ground-ruvnet.sh'), '#!/bin/bash\necho PWNED\n');
    fs.mkdirSync(path.join(HOME_DIR, 'versions'), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR, 'active.json'), JSON.stringify({ generation: 1, version: 'x', codeRoot: evil }));
    fs.writeFileSync(path.join(PLUGIN_ROOT, 'scripts', 'ground-ruvnet.sh'), '#!/bin/bash\necho FROZEN-FALLBACK\n');
    const r = run('ground-ruvnet');
    expect(r.stdout).not.toMatch(/PWNED/);
    expect(r.stdout).toMatch(/FROZEN-FALLBACK/);
    fs.rmSync(evil, { recursive: true, force: true });
  });

  it('dev mode wins over active.json and executes the checkout directly', () => {
    seedSpine('1.0.0', { 'ground-ruvnet.sh': '#!/bin/bash\necho FROM-VERSIONS\n' });
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-checkout-'));
    fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'scripts', 'ground-ruvnet.sh'), '#!/bin/bash\necho FROM-DEV-CHECKOUT\n');
    fs.writeFileSync(path.join(HOME_DIR, 'dev.json'), JSON.stringify({ codeRoot: checkout }));
    expect(run('ground-ruvnet').stdout).toMatch(/FROM-DEV-CHECKOUT/);
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  it('an unknown hook id never blocks the turn (exit 0) and names the known table', () => {
    const r = run('not-a-real-hook');
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/unknown hook id/);
    expect(r.stderr).toMatch(/route-dispatch/); // the table is named, aiding diagnosis
  });
});


describe('registered native host boundary', () => {
  it('recognizes only the matching Claude plugin root and preserves explicit Codex', () => {
    const root = seedSpine('1.0.0', { 'session-snapshot-hook.mjs': 'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"host:"+(process.env.RUVNET_HOOK_HOST||"unknown")}}));\n' });
    const invoke = (pluginRoot, explicitHost) => {
      const env = { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR };
      delete env.RUVNET_HOOK_HOST;
      delete env.CLAUDE_PLUGIN_ROOT;
      if (pluginRoot !== null) env.CLAUDE_PLUGIN_ROOT = pluginRoot;
      if (explicitHost !== null) env.RUVNET_HOOK_HOST = explicitHost;
      return hostSpawnSync(process.execPath, [SHIM, 'session-snapshot'], { input: '{}', encoding: 'utf8', env, timeout: 10000 });
    };
    const matching = invoke(SOURCE_PLUGIN_ROOT, null);
    expect(matching.status).toBe(0);
    expect(matching.stdout).toContain('host:claude');
    expect(invoke(null, null).stdout).toContain('host:unknown');
    expect(invoke(root, null).stdout).toContain('host:unknown');
    expect(invoke(SOURCE_PLUGIN_ROOT, 'codex').stdout).toContain('host:codex');
    expect(invoke(SOURCE_PLUGIN_ROOT, 'invalid').stdout).toContain('host:invalid');
  });
});


describe.skipIf(process.platform === 'win32')('native Claude grounding identity through owned shim', () => {
  it('records a prompt-bound nonce and same-turn search stamp without an external host variable', () => {
    const dir = path.join(HOME_DIR, 'markers');
    const env = { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR, RUVNET_BRAIN_HOME: HOME_DIR,
      RUVNET_GROUNDING_TURN_DIR: dir, CLAUDE_PLUGIN_ROOT: SOURCE_PLUGIN_ROOT };
    delete env.RUVNET_HOOK_HOST;
    const payload = { cwd: HOME_DIR, session_id: 'native-claude', prompt_id: 'native-prompt', hook_event_name: 'UserPromptSubmit', prompt: 'Explain how ruflo works' };
    const fire = (id, input, overrides = {}) => hostSpawnSync(process.execPath, [SHIM, id], {
      env: { ...env, ...overrides }, input: JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
    const marked = fire('grounding-turn-mark', payload);
    expect(marked.status, marked.stderr).toBe(0);
    const file = path.join(dir, 'claude-native-claude.json');
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(marker).toMatchObject({ host: 'claude', nativeKind: 'claude-prompt-id', sessionId: payload.session_id, turnId: payload.prompt_id });
    expect(marker.nonce).toMatch(/^[a-f0-9-]{36}$/);
    const stamped = fire('grounding-stamp', { ...payload, hook_event_name: 'PostToolUse',
      tool_name: 'mcp__plugin_ruvnet-brain_ruvnet-brain__search_ruvnet', tool_input: { query: 'ruflo' },
      tool_response: 'Searched 3 RuvNet repos (ruflo).\n#1 repo=ruflo\n----- full document (200 chars) -----\nreal source' });
    expect(stamped.status, stamped.stderr).toBe(0);
    const evidence = JSON.parse(fs.readFileSync(file + '.search-' + marker.nonce, 'utf8'));
    expect(evidence).toMatchObject({ host: 'claude', turnId: payload.prompt_id, sessionId: payload.session_id, nonce: marker.nonce, searchCount: 1 });
    const gate = fire('grounding-turn-gate', { ...payload, hook_event_name: 'Stop', last_assistant_message: 'Ruflo provides orchestration.' });
    expect(gate.status, gate.stderr).toBe(0); expect(gate.stdout).toBe('');
    for (const overrides of [{ RUVNET_HOOK_HOST: 'invalid' }, { RUVNET_HOOK_HOST: '' }, { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }, { CLAUDE_PLUGIN_ROOT: '' }]) {
      const session = 'untrusted-' + Math.random().toString(36).slice(2);
      expect(fire('grounding-turn-mark', { ...payload, session_id: session }, overrides).status).toBe(0);
      expect(fs.existsSync(path.join(dir, 'claude-' + session + '.json'))).toBe(false);
    }
    const codex = fire('grounding-turn-mark', { ...payload, session_id: 'explicit-codex', turn_id: 'codex-turn' }, { RUVNET_HOOK_HOST: 'codex' });
    expect(codex.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'codex-explicit-codex.json'), 'utf8'))).toMatchObject({ host: 'codex', nativeKind: 'codex-turn-id', turnId: 'codex-turn' });
    expect(fs.existsSync(path.join(dir, 'claude-explicit-codex.json'))).toBe(false);
    const directEnv = { ...env }; delete directEnv.CLAUDE_PLUGIN_ROOT;
    const direct = hostSpawnSync(process.execPath, [path.join(SOURCE_PLUGIN_ROOT, 'scripts', 'grounding-turn-mark.mjs')], {
      env: directEnv, input: JSON.stringify({ ...payload, session_id: 'direct-unknown' }), encoding: 'utf8', timeout: 10000 });
    expect(direct.status).toBe(0); expect(fs.existsSync(path.join(dir, 'claude-direct-unknown.json'))).toBe(false);
  });
});


describe.skipIf(process.platform === 'win32')('grounding registered dispatch host transport', () => {
  it.each([['grounding-turn-mark', 'grounding-turn-mark.mjs'], ['grounding-stamp', 'grounding-stamp.sh'], ['grounding-turn-gate', 'grounding-turn-gate.mjs']])('%s receives only the trusted Claude fallback', (id, file) => {
    seedSpine('1.0.0', { [file]: file.endsWith('.sh') ? 'echo "host:${RUVNET_HOOK_HOST:-unknown}"\n' : 'console.log("host:"+(process.env.RUVNET_HOOK_HOST||"unknown"));\n' });
    const env = { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: SOURCE_PLUGIN_ROOT,
      RUVNET_BRAIN_STATE_DIR: path.join(HOME_DIR, 'state') }; delete env.RUVNET_HOOK_HOST;
    const invoke = overrides => hostSpawnSync(process.execPath, [SHIM,id], { env: { ...env,...overrides }, input: '{}', encoding:'utf8', timeout:10000 });
    expect(invoke({}).stdout).toContain('host:claude');
    expect(invoke({ RUVNET_HOOK_HOST:'codex' }).stdout).toContain('host:codex');
    expect(invoke({ RUVNET_HOOK_HOST:'invalid' }).stdout).toContain('host:invalid');
    expect(invoke({ RUVNET_HOOK_HOST:'' }).stdout).toContain('host:unknown');
    expect(invoke({ CLAUDE_PLUGIN_ROOT:PLUGIN_ROOT }).stdout).toContain('host:unknown');
    expect(invoke({ CLAUDE_PLUGIN_ROOT:'' }).stdout).toContain('host:unknown');
    fs.mkdirSync(env.RUVNET_BRAIN_STATE_DIR); fs.writeFileSync(path.join(env.RUVNET_BRAIN_STATE_DIR,'brain-off'),'');
    const off = invoke({}); expect(off.status).toBe(0); expect(off.stdout).toBe('');
  });
});
