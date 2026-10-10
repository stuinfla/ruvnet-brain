// tests/unit/grounding-unproven-surfacer.test.mjs — session-start.sh's reader for the persisted
// "grounding: unproven" verdict (ADR-058 §D8, the -15 "nothing exercises even one hook fire /
// nothing keeps the verdict from evaporating" deduction).
//
// Contract under test (plugin/scripts/session-start.sh, the block right after the open-issue
// surfacer it deliberately mirrors):
//   • ~/.cache/ruvnet-brain/install-state.json with grounding !== "proven" → the banner fires,
//     naming the recorded reason.
//   • grounding === "proven" → silence (the common, healthy case must never nag).
//   • no file at all → silence (a machine that predates this feature, or has never installed).
//   • malformed JSON → silence, never a crash (fail-silent, matching every other reader in this file).
//   • UNLIKE the advertising blocks (console offer / router nudge / star-ask), this banner is NOT
//     suppressed when the brain is switched OFF — it is a health fact about the install, in the
//     same category as the GONG alarm and the open-issue banner (session-start.sh's own header
//     note: "KEEPS RUNNING while off").
//
// Runs the REAL script with HOME pointed at a scratch dir, same convention as
// tests/unit/star-ask-once.test.mjs and tests/unit/brain-off.test.mjs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmHome } from '../helpers/reap-detached.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'plugin', 'scripts', 'session-start.sh');
const BANNER_MARKER = 'grounding not yet PROVEN';

let home, cacheDir, statePath, project;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-grounding-home-'));
  cacheDir = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(cacheDir, { recursive: true });
  statePath = path.join(cacheDir, 'install-state.json');
  project = path.join(home, 'project');
  fs.mkdirSync(project);
  // Keep the run hermetic and fast, same suppressions star-ask-once.test.mjs uses: auto-update
  // pref answered (no setup question), heartbeat stamped "just checked" (no curl), meter off.
  fs.writeFileSync(path.join(cacheDir, '.auto-update-pref'), 'no\n');
  fs.writeFileSync(path.join(cacheDir, '.last-update-check'), String(Math.floor(Date.now() / 1000)));
  fs.writeFileSync(path.join(cacheDir, '.seed-attempted'), String(Math.floor(Date.now() / 1000)));
});
// Teardown retries: session-start.sh's spine seed is deliberately detached and still writing
// into HOME when this runs (plugin/scripts/detach.mjs's header explains why it must be). Node's
// own maxRetries/retryDelay is the documented answer; no assertion changes.
afterEach(() => { rmHome(home); });

function run(extraEnv = {}) {
  // 'bash' via PATH (not /bin/bash): Windows runners resolve this to Git Bash, the same shell
  // Claude Code uses for hooks on a real Windows machine.
  const r = spawnSync('bash', [SCRIPT], {
    cwd: project, input: '{}',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project,
      XDG_CACHE_HOME: path.join(home, '.cache'), RUVNET_BRAIN_HOME: cacheDir,
      RUVNET_BRAIN_STATE_DIR: path.join(home, '.config/ruvnet-brain'),
      RUVNET_SETTINGS_FILE: path.join(home, '.config/ruvnet-brain/settings.json'),
      RUVNET_HOOK_HOST: 'claude', CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), RUVNET_BRAIN_METER: '0', ...extraEnv },
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(r.status, `session-start.sh must never exit non-zero (stderr: ${r.stderr})`).toBe(0);
  return r.stdout || '';
}

describe('session-start.sh — grounding-unproven surfacer (ADR-058 §D8)', () => {
  it('no install-state.json at all → silence', () => {
    expect(run()).not.toContain(BANNER_MARKER);
  });

  it('grounding: "unproven" → the banner fires, naming the recorded reason', () => {
    fs.writeFileSync(statePath, JSON.stringify({ grounding: 'unproven', reason: 'no-answer', at: '2026-07-27T12:00:00.000Z' }));
    const out = run();
    expect(out).toContain(BANNER_MARKER);
    expect(out).toContain('no-answer');
    expect(out).toContain('--doctor');
  });

  it('grounding: "proven" → silence — the common healthy case must never nag', () => {
    fs.writeFileSync(statePath, JSON.stringify({ grounding: 'proven', at: '2026-07-27T12:00:00.000Z' }));
    expect(run()).not.toContain(BANNER_MARKER);
  });

  it('malformed JSON → silence, never a crash (fail-silent like every other reader here)', () => {
    fs.writeFileSync(statePath, 'not json at all {{{');
    expect(run()).not.toContain(BANNER_MARKER);
  });

  it('an empty object (no `grounding` key at all) → silence', () => {
    fs.writeFileSync(statePath, '{}');
    expect(run()).not.toContain(BANNER_MARKER);
  });

  it('fires even when the brain is switched OFF — a health fact, not advertising', () => {
    fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'brain-off'), JSON.stringify({ since: '2026-07-01' }));
    fs.writeFileSync(statePath, JSON.stringify({ grounding: 'unproven', reason: 'no-answer' }));
    const out = run();
    expect(out).toContain(BANNER_MARKER);
    expect(out).toContain('brain OFF by your setting'); // the one line ADR-054 keeps even while off
  });
});
