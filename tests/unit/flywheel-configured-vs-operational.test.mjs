import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ISSUE #138 — CONFIGURED IS NOT OPERATIONAL.
 *
 * The advisory treated any occurrence of `RUFLO_HARNESS_LOOP` in `.claude/settings.json` as proof
 * the flywheel was on, and then went silent. Verified against rUv's source at f35c545 rather than
 * recalled:
 *
 *   harness-worker.ts:41          /^(1|true|yes|on)$/i.test(process.env.RUFLO_HARNESS_LOOP ?? '')
 *   harness-worker.ts:54          if (!optedIn) → reason: 'opt-in required (RUFLO_HARNESS_LOOP=1)'
 *   harness-project-anchor.ts:186 'project-local flywheel anchor required; create …'
 *   harness-project-anchor.ts:32  DEFAULT_PROJECT_ANCHOR_MANIFEST = .claude/eval/flywheel-anchor.manifest.json
 *
 * The daemon reads its OWN process environment. A settings file does not put anything into the
 * environment of a daemon launched by Codex, launchd, systemd or another shell — so the grep proved
 * a file mentions a name, never that the running daemon inherited it. The Brain stayed quiet while
 * ruflo recorded "opt-in required" every cycle.
 *
 * A false ENABLED is strictly worse than a false disabled: nobody goes looking. Same shape as the
 * console learner card (#136) — a surface reporting a proxy as if it were the answer.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'ground-ruvnet.sh');

let dir; let cache;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flywheel-'));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'flywheel-cache-'));
  // A project that "runs Ruflo" — the precondition for the advisory firing at all.
  fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.swarm', 'memory.db'), '');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
});
afterEach(() => {
  for (const d of [dir, cache]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** Fire the hook the way UserPromptSubmit does: payload on stdin, no tty, from the project. */
function fire({ env = {}, settings = null } = {}) {
  if (settings) fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  const r = spawnSync('/bin/bash', [HOOK], {
    cwd: dir,
    input: JSON.stringify({ session_id: `fw-${Math.random().toString(16).slice(2)}`, prompt: 'build a feature' }),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: cache,                       // per-test claim state, so the daily cadence never suppresses
      XDG_CACHE_HOME: cache,
      RUVNET_BRAIN_HOME: cache,
      RUFLO_HARNESS_LOOP: '',            // cleared unless a case sets it
      ...env,
    },
  });
  return `${r.stdout || ''}`;
}

const mentionsFlywheel = (out) => /self-learning flywheel/i.test(out);

describe('issue #138 — a settings entry is not the daemon environment', () => {
  it('TEETH: a settings file that NAMES the var no longer counts as enabled', () => {
    // The exact defect. Before this, the string in the file silenced the advisory entirely.
    const out = fire({ settings: { env: { RUFLO_HARNESS_LOOP: '1' } } });
    expect(mentionsFlywheel(out), 'a declared-but-not-inherited var must NOT silence the advisory').toBe(true);
    expect(out, 'and it must say plainly that configured is not running').toMatch(/Configured is not operational/i);
  }, 40_000);

  it('stays silent when THIS process genuinely carries the var', () => {
    // The one state that proves opt-in: ruflo reads process.env, so this is the real signal. Without
    // this case the fix could have been "always nag", which is a different defect.
    const out = fire({ env: { RUFLO_HARNESS_LOOP: '1' } });
    expect(mentionsFlywheel(out), 'a genuinely opted-in project must never be nagged').toBe(false);
  }, 40_000);

  it('offers it when nothing is set anywhere', () => {
    expect(mentionsFlywheel(fire()), 'the offer is the whole point of the advisory').toBe(true);
  }, 40_000);
});

describe('issue #138 — the guidance can actually produce a working setup', () => {
  it('names the project-local anchor, without which ruflo fails closed', () => {
    // ruflo #2840 / PR #2848. Guidance that omits this cannot produce a working downstream setup —
    // the user follows it exactly and still gets "project-local flywheel anchor required".
    const out = fire();
    expect(out).toMatch(/\.claude\/eval\/flywheel-anchor\.manifest\.json/);
    expect(out).toMatch(/project-local flywheel anchor required/i);
  }, 40_000);

  it('says the env must reach the DAEMON, not merely a settings file', () => {
    expect(fire()).toMatch(/DAEMON'S OWN ENVIRONMENT|daemon is launched from a shell that inherited/i);
  }, 40_000);

  it('states BOTH data gates, not just the first', () => {
    // 12 patterns is only the harvest gate; generation additionally needs 20 held-out tasks. Quoting
    // one number as "the" caveat understates when the wheel will actually turn.
    const out = fire();
    expect(out).toMatch(/12 stored neural patterns/);
    expect(out).toMatch(/20 harvested held-out tasks/);
  }, 40_000);

  it('tells the user how to VERIFY rather than assume', () => {
    // The whole issue is a proxy mistaken for an answer, so the fix must hand over the real check.
    expect(fire()).toMatch(/ruflo hooks intelligence --status/);
  }, 40_000);
});
