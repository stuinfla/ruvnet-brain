/**
 * anticipate-dial.test.mjs — the ADVOCACY DIAL wired into plugin/scripts/anticipate.sh
 * (ADR-032 / DDD-0004 "the three channels"): off / important-only / all, read from the settings
 * file at RUVNET_SETTINGS_FILE (or ~/.config/ruvnet-brain/settings.json), default important-only.
 *
 * THE CORRECTED MODEL (2026-07-23). An earlier build gated important-only on `best.row.severity`,
 * on the assumption that a dormant-capability nudge is a low-severity "suggestion". But verified
 * live: neither scripts/capability-registry.mjs's auditAll() nor scripts/goal-match.mjs emits a
 * severity field at all — so that gate silenced the ENTIRE feature at the default (a regression this
 * very test suite caught, and it broke 7 assertions in tests/integration/anticipate.test.mjs). It was
 * removed. anticipate produces exactly ONE class of output — a nudge that has already cleared a high
 * evidence bar (two independent cues + the matcher's confidence floor + once-per-session) — so its
 * meaningful dial is OFF vs ON:
 *   • off             → silent, always.
 *   • important-only  → speaks a genuine match (the default; the owner's "recommend on").
 *   • all             → speaks a genuine match too.
 * The important-only/all split is for OTHER emitters (session-start promotions, health tiers) that
 * have a verbosity axis; anticipate has none, so it does not fake one. `off` is the real, honoured
 * control.
 *
 * SCOPE. This file tests ONLY the dial gate in anticipate.sh (`if (ADVOCACY === 'off') quit();` and
 * the default resolution in advocacyLevel()). The rest of the delivery contract (dormancy filtering,
 * once-per-session, no-evidence silence, the outcome ledger, footprint) is
 * tests/integration/anticipate.test.mjs's job.
 *
 * TEETH — how "off is silent" proves something. The off-test and the "on" tests share the IDENTICAL
 * event + fixture pair (same prompt, same dormant capability, same 0.95 confidence, same non-empty
 * `why`), differing ONLY in the settings file's `advocacy` value. So if `if (ADVOCACY === 'off')
 * quit();` were deleted, the off run would fall through to the emit line and print the same line the
 * `all`/`important-only` runs print — and expect(stdout).toBe('') would fail. An empty registry, a
 * non-matching prompt, or a low-confidence match would make the off-test pass for the WRONG reason;
 * the paired on-tests rule that out by showing the same setup DOES speak when not off.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'anticipate.sh');
const FIXTURE_REGISTRY = path.join(HERE, 'fixtures', 'anticipate-dial.capability-registry.fixture.mjs');
const FIXTURE_MATCHER = path.join(HERE, 'fixtures', 'anticipate-dial.goal-match.fixture.mjs');

const MATCHING_PROMPT = 'please help me rebuild the vector cache for this project, it seems stale';
const UNMATCHING_PROMPT = 'what is the capital of France, and why is it the capital city there';

let home, work, fx;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-dial-home-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-dial-work-'));
  fx = fs.mkdtempSync(path.join(os.tmpdir(), 'anticipate-dial-fx-'));
});
afterEach(() => { for (const d of [home, work, fx]) fs.rmSync(d, { recursive: true, force: true }); });

function writeSettings(content) {
  const p = path.join(fx, 'settings.json');
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

/** Runs the real hook as Claude Code's UserPromptSubmit does: event JSON on stdin, rest in env. */
function run({ prompt, sessionId = 's1', settingsFile } = {}) {
  const res = spawnSync('/bin/sh', [HOOK], {
    input: JSON.stringify({ session_id: sessionId, prompt }),
    cwd: work,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      RUVNET_CAPABILITY_REGISTRY: FIXTURE_REGISTRY,
      RUVNET_GOAL_MATCH: FIXTURE_MATCHER,
      ...(settingsFile ? { RUVNET_SETTINGS_FILE: settingsFile } : {}),
    },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('the advocacy dial — off is verifiably, provably silent', () => {
  it('advocacy=off + a genuinely matching prompt → EXACTLY zero bytes of stdout, exit 0', () => {
    const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: writeSettings({ advocacy: 'off' }) });
    expect(status).toBe(0);
    expect(stdout).toBe('');            // byte-exact: nothing enters the model's context
  });

  it('TEETH: the SAME event + fixture, only advocacy=all → it speaks (off-silence is not a false positive)', () => {
    const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: writeSettings({ advocacy: 'all' }), sessionId: 'teeth' });
    expect(status).toBe(0);
    expect(stdout).toContain('Fixture Vector Cache');
    expect(stdout).toContain('[RuvNet Brain — anticipating]');
  });
});

describe('the advocacy dial — the default is ON, not off (the owner\'s "recommend on")', () => {
  it('advocacy=important-only (the default) → speaks a genuine match', () => {
    const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: writeSettings({ advocacy: 'important-only' }), sessionId: 'imp' });
    expect(status).toBe(0);
    expect(stdout).toContain('Fixture Vector Cache');
  });

  // Missing / unreadable / malformed / unrecognised settings must resolve to the SPEAKING default
  // (important-only), never silently to off — a broken settings file must not quietly mute the brain.
  const badSettings = [
    ['a file that does not exist', () => path.join(fx, 'nope', 'settings.json')],
    ['an unrecognised advocacy value (typo)', () => writeSettings({ advocacy: 'ALL-CAPS-TYPO' })],
    ['not valid JSON', () => writeSettings('{ not actually json')],
  ];
  for (const [label, make] of badSettings) {
    it(`${label} → defaults to important-only and SPEAKS (never silently off), exit 0`, () => {
      const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: make(), sessionId: `def-${label.slice(0, 6)}` });
      expect(status).toBe(0);
      expect(stdout).toContain('Fixture Vector Cache');
    });
  }

  it('an unreadable settings file (permission denied) → default, exit 0, no crash', () => {
    const p = writeSettings({ advocacy: 'off' });   // content irrelevant; it must be unreadable
    fs.chmodSync(p, 0o000);
    try {
      const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: p, sessionId: 'perm' });
      expect(status).toBe(0);
      expect(stdout).toContain('Fixture Vector Cache');   // defaulted to important-only, not to the file's 'off'
    } finally { fs.chmodSync(p, 0o600); }
  });
});

describe('the advocacy dial — reads the REAL settings envelope (nested .settings.advocacy)', () => {
  // The shape user-settings.mjs saveSettings() actually writes: a versioned envelope, value nested
  // under .settings. An earlier read of top-level `.advocacy` made every real save invisible here —
  // off never took effect. These prove the emitter reads the shape the console/CLI actually persist.
  const envelope = (advocacy) => ({
    version: 1, updated: '2026-07-23T00:00:00Z',
    settings: { learningScope: 'project', advocacy, autoApply: false, newProjectDefaults: false },
  });

  it('advocacy=off in the versioned envelope → silent (before the fix this defaulted to on and spoke)', () => {
    const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: writeSettings(envelope('off')), sessionId: 'env-off' });
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('advocacy=all in the versioned envelope → speaks (off-silence is the setting, not a parse miss)', () => {
    const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: writeSettings(envelope('all')), sessionId: 'env-all' });
    expect(status).toBe(0);
    expect(stdout).toContain('Fixture Vector Cache');
  });
});

describe('the advocacy dial — the 1–5 integers the console actually saves (RNBC QA 2026-10-01)', () => {
  // The console's "How much it jumps in" dial persists an INTEGER 1–5 (user-settings ADR-052). This
  // hook only understood the pre-dial strings, so every integer fell through to the speaking default:
  // level 1 "Only when I ask" was ignored here.
  const envelope = (advocacy) => ({ version: 1, settings: { advocacy } });
  it('advocacy=1 ("Only when I ask") → silent', () => {
    const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: writeSettings(envelope(1)), sessionId: 'int-1' });
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });
  for (const level of [2, 3, 4, 5]) {
    it(`advocacy=${level} → speaks a genuine match`, () => {
      const { status, stdout } = run({ prompt: MATCHING_PROMPT, settingsFile: writeSettings(envelope(level)), sessionId: `int-${level}` });
      expect(status).toBe(0);
      expect(stdout).toContain('Fixture Vector Cache');
    });
  }
});

describe('the advocacy dial — on-levels do not mean "match anything"', () => {
  it('an unrelated prompt stays silent at important-only AND all — the dial is not a bypass of the matcher', () => {
    for (const advocacy of ['important-only', 'all']) {
      const { status, stdout } = run({ prompt: UNMATCHING_PROMPT, settingsFile: writeSettings({ advocacy }), sessionId: `unrel-${advocacy}` });
      expect(status).toBe(0);
      expect(stdout).toBe('');
    }
  });
});
