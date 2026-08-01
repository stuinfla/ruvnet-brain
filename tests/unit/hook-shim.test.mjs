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

let HOME_DIR, PLUGIN_ROOT;
const run = (hookId) => spawnSync(process.execPath, [SHIM, hookId], {
  encoding: 'utf8',
  env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
});

function runRegistered(hookId, input) {
  const registry = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
  const hook = Object.values(registry.hooks).flat()
    .flatMap((group) => group.hooks || [])
    .find((candidate) => candidate.command.includes(`hook-shim.mjs\" ${hookId}`));
  if (!hook) throw new Error(`registered hook ${hookId} not found`);
  return spawnSync('/bin/sh', ['-c', hook.command], {
    input,
    encoding: 'utf8',
    env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: SOURCE_PLUGIN_ROOT },
  });
}

/** Seed a spine generation whose scripts print/exit as instructed. */
function seedSpine(version, scripts) {
  const root = path.join(HOME_DIR, 'versions', version);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
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

  it('BLOCKING mode propagates the exact exit code — route-dispatch\'s exit-2 wall survives', () => {
    seedSpine('1.0.0', { 'route-dispatch.sh': '#!/bin/bash\necho BLOCKED >&2\nexit 2\n' });
    const r = run('route-dispatch');
    expect(r.status).toBe(2); // not 0, not 1 — the CONTRACT code
    expect(r.stderr).toMatch(/BLOCKED/);
  });

  it('the registered blocking shim sends one bounded payload to its consuming hook body', () => {
    seedSpine('1.0.0', {
      'protect-brain-state.sh': [
        '#!/bin/bash',
        'INPUT=""',
        'while IFS= read -r -t 1 _line; do INPUT+="$_line"; done',
        '[ -n "$_line" ] && INPUT+="$_line"',
        'printf "%s" "${#INPUT}"',
      ].join('\n'),
    });
    const result = runRegistered('protect-state', 'p'.repeat(70_000));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('65536');
  });

  it('every registered blocking payload consumer receives the exact closed-pipe payload', () => {
    const consumers = [
      ['route-dispatch', 'route-dispatch.sh'],
      ['ground-before-write', 'ground-before-write.sh'],
      ['design-wall', 'design-wall.sh'],
      ['protect-state', 'protect-brain-state.sh'],
      ['unprompted-speech', 'unprompted-runtime.mjs'],
    ];
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
