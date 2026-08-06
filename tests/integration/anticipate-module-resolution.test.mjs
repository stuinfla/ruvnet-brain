// tests/integration/anticipate-module-resolution.test.mjs
//
// THE GAP THIS CLOSES. tests/integration/anticipate.test.mjs is 678 lines and thorough, but every
// one of its runs injects the module path — see its `run()` helper:
//
//     ...(matcher ? { RUVNET_GOAL_MATCH: matcher } : {}),
//
// so the suite never exercises the DEFAULT path anticipate.sh derives from its own location. Even
// "exits 0 and stays quiet when the matcher module does not exist" passes an explicit path to a
// missing file. The default resolution therefore had no coverage at all, and shipped wrong:
//
//     CODE_ROOT=$SELF_DIR/../..   →   $CODE_ROOT/scripts/goal-match.mjs
//
// That is correct only for the source layout <root>/plugin/scripts/. Both layouts a user actually
// receives FLATTEN the `plugin/` level — the Claude Code plugin directory and the Stable Spine's
// versions/<gen>/ tree both place this script at <root>/scripts/ — so `../..` overshoots by one
// directory, the file is never found, and the `[ -f "$GOAL_MATCH" ] || exit 0` guard silently
// disables the entire L4 surface.
//
// This is the fifth instance of the defect class already documented in
// tests/unit/installer-sibling-imports-packaged.test.mjs: "A capability that silently does not
// exist on real installs is worse than one that was never built, because the team believes it is
// running and stops looking." Same shape, different file — and the same reason nobody noticed: the
// only symptom is silence, which is also the correct behaviour on the vast majority of prompts.
//
// So these tests deliberately set NO module env vars. They assert the invariant the overrides hide:
// dropped into a directory layout, anticipate.sh finds its own modules.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_SRC = path.join(ROOT, 'plugin', 'scripts', 'anticipate.sh');
const MODULES = ['goal-match.mjs', 'capability-registry.mjs', 'advocacy-outcomes.mjs'];

// A registry with exactly one dormant capability, so there is something legitimate to advocate for.
// Written into each layout rather than injected, because injecting is the very thing under test.
const STUB_REGISTRY = `export function auditAll() {
  return [{
    key: 'cheap-model-routing',
    state: 'off',
    label: 'Cheap-model routing',
    whatItBuysYou: 'Mechanical work runs on a cheap model instead of a frontier one.',
    evidence: 'test fixture',
    scope: 'machine',
  }];
}
export const STATE = { ON: 'on', OFF: 'off', IDLE: 'idle', UNKNOWN: 'unknown', ABSENT: 'absent' };
export const CAPABILITIES = [];
`;

// Corroborated on purpose: BASE (0.55) sits below CONFIDENCE_FLOOR (0.6), so a single cue is silent
// by design. Two cues is what a user in this situation actually writes.
const PROMPT = 'my Claude bill is expensive, can my agent use a cheaper model for simple work';

let work, home;

/**
 * Materialise one directory layout and return the path to its anticipate.sh.
 *
 * @param name    subdirectory to build under the temp workspace
 * @param nested  true  → source layout   <root>/plugin/scripts/anticipate.sh + <root>/scripts/<modules>
 *                false → shipped layout  <root>/scripts/anticipate.sh with the modules as siblings
 */
function makeLayout(name, nested) {
  const root = path.join(work, name);
  const hookDir = nested ? path.join(root, 'plugin', 'scripts') : path.join(root, 'scripts');
  const modDir = nested ? path.join(root, 'scripts') : hookDir;
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(modDir, { recursive: true });
  fs.copyFileSync(HOOK_SRC, path.join(hookDir, 'anticipate.sh'));
  // FROM THE PAYLOAD, not from `scripts/`. Since ADR-065 the three modules live in
  // `plugin/scripts/` — which is the only thing that ships — and `scripts/<name>.mjs` is a four-line
  // re-export shim over it. Copying the SHIM into a fixture that has no `plugin/` sibling produces a
  // module that cannot resolve, so the hook falls into its own silent-degradation path and both
  // layouts read as broken. The fixture must materialise the bytes a user actually receives; copying
  // a compatibility stub instead would make this test grade something nobody runs.
  for (const m of MODULES) fs.copyFileSync(path.join(ROOT, 'plugin', 'scripts', m), path.join(modDir, m));
  // The registry is the one module we stub, so the assertion is about resolution, not about the
  // state of the machine running the suite.
  fs.writeFileSync(path.join(modDir, 'capability-registry.mjs'), STUB_REGISTRY);
  return path.join(hookDir, 'anticipate.sh');
}

/** Run the hook the way Claude Code does — and with NO module env vars. That is the whole point. */
function run(hook, prompt, sessionId) {
  const res = spawnSync('/bin/sh', [hook], {
    input: JSON.stringify({ session_id: sessionId, prompt }),
    cwd: work,
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: home },
  });
  return { status: res.status, stdout: res.stdout ?? '' };
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-resolution-'));
  home = path.join(work, 'home');
  fs.mkdirSync(home, { recursive: true });
});
afterAll(() => { try { fs.rmSync(work, { recursive: true, force: true }); } catch {} });

describe('anticipate.sh — finds its own modules, with nothing injected', () => {
  it('resolves them in the SOURCE layout (<root>/plugin/scripts)', () => {
    const { status, stdout } = run(makeLayout('src-layout', true), PROMPT, 'res-src');
    expect(status).toBe(0);
    expect(stdout).toContain('Cheap-model routing');
  });

  // THE REGRESSION. This is the layout every real user receives, and the one that was broken.
  it('resolves them in the SHIPPED layout (modules as siblings)', () => {
    const { status, stdout } = run(makeLayout('flat-layout', false), PROMPT, 'res-flat');
    expect(status).toBe(0);
    expect(stdout).toContain('Cheap-model routing');
  });
});

describe('anticipate.sh — resolution does not weaken the silence contract', () => {
  it('is still SILENT on an unrelated prompt once the modules ARE reachable', () => {
    // The failure mode of any "make it speak" fix is a hook that now speaks when it should not.
    // Same layout, same reachable modules, ordinary software prompt: still nothing.
    const hook = makeLayout('flat-silent', false);
    for (const p of [
      'fix the memory leak in my C++ parser',
      'our nightly build failed again',
      'this query is expensive, can we add an index',
      'we are burning through our AWS credits',
    ]) {
      const { status, stdout } = run(hook, p, `neg-${Buffer.from(p).toString('hex').slice(0, 8)}`);
      expect(status).toBe(0);
      expect(stdout).toBe('');
    }
  });

  it('still exits 0 and stays quiet when the modules are genuinely absent', () => {
    // The documented degradation must survive the fix: no modules anywhere, no work, no noise —
    // and above all no invented failure on a turn the user is waiting for.
    const root = path.join(work, 'no-modules');
    const hookDir = path.join(root, 'scripts');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.copyFileSync(HOOK_SRC, path.join(hookDir, 'anticipate.sh'));
    const { status, stdout } = run(path.join(hookDir, 'anticipate.sh'), PROMPT, 'res-none');
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('an explicit RUVNET_GOAL_MATCH still wins over resolution', () => {
    // The override is how the rest of the suite works; resolution must not shadow it.
    const hook = makeLayout('override-layout', false);
    const res = spawnSync('/bin/sh', [hook], {
      input: JSON.stringify({ session_id: 'res-override', prompt: PROMPT }),
      cwd: work,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        RUVNET_GOAL_MATCH: path.join(work, 'override-layout', 'scripts', 'does-not-exist.mjs'),
      },
    });
    expect(res.status).toBe(0);
    expect(res.stdout ?? '').toBe('');
  });
});
