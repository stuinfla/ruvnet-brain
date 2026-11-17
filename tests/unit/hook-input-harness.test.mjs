// tests/unit/hook-input-harness.test.mjs — H2: UserPromptSubmit hooks must not treat a
// harness-generated message as something a user typed.
//
// ROOT CAUSE. Background task notifications, slash-command scaffolding, and other harness-authored
// bookkeeping arrive on UserPromptSubmit exactly like real user text, wrapped in tags such as
// <task-notification>, <local-command-caveat>, <command-name>, <local-command-stdout>, and
// <system-reminder>. scripts/correction-detect.mjs already carried a regex list for exactly this
// (HARNESS_TEMPLATES, built from measured live-corpus evidence), but as a private copy nothing else
// could reuse it — so grounding-turn-mark.mjs could arm the Stop-time grounding gate off a harness
// message that happens to mention a rUv term, unprompted-runtime.mjs's producers could fire an
// advisory at a background notification, capacity-aware-parallel-work.mjs could recommend a
// parallel-work fan-out for text nobody wrote, and ground-ruvnet.sh could inject its full grounding
// banner into a turn with no human in it.
//
// THE FIX: plugin/scripts/hook-input.mjs now exports isHarnessGenerated(promptText) as the ONE
// shared helper. correction-detect.mjs re-exports its old HARNESS_TEMPLATES name from there instead
// of keeping its own copy. Every regression test below is run against the pre-fix tree first — see
// each `it` block's comment for what SHOULD (and, on old code, does not) happen.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HARNESS_GENERATED_PATTERNS, HARNESS_GENERATED_SHELL_PATTERN, isHarnessGenerated } from '../../plugin/scripts/hook-input.mjs';
import { HARNESS_TEMPLATES } from '../../scripts/correction-detect.mjs';
import { shouldMark, markerPathFor } from '../../plugin/scripts/grounding-turn-mark.mjs';
import { runCapacityHook } from '../../plugin/scripts/capacity-aware-parallel-work.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(ROOT, 'plugin', 'scripts');
const GROUND_RUVNET = path.join(SCRIPTS, 'ground-ruvnet.sh');
const UNPROMPTED = path.join(SCRIPTS, 'unprompted-runtime.mjs');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasJq = spawnSync('jq', ['--version']).status === 0;
const bashOnly = !hasBash || process.platform === 'win32';

// Real, live examples of the harness artifacts the corpus actually produced (see
// scripts/correction-detect.mjs's own header for the measured 29%-of-holdout-pool finding).
const HARNESS_SAMPLES = [
  '<task-notification>Background task "build" completed.</task-notification>',
  '<local-command-caveat>Caveat: this output is truncated.</local-command-caveat>',
  '<system-reminder>As you answer, remember...</system-reminder>',
  '<local-command-stdout>build succeeded</local-command-stdout>',
  '   Caveat: the following was auto-generated',
  'This session is being continued from a previous conversation that ran out of context.',
  '[Request interrupted by user]',
];
const REAL_USER_SAMPLES = [
  'build a ruflo agent for me',
  'what is the weather today',
  'please fix the bug in the parser',
];

describe('isHarnessGenerated — pure decision logic', () => {
  it('recognises every known harness-artifact shape', () => {
    for (const s of HARNESS_SAMPLES) expect(isHarnessGenerated(s), s).toBe(true);
  });

  it('leaves genuine user text alone', () => {
    for (const s of REAL_USER_SAMPLES) expect(isHarnessGenerated(s), s).toBe(false);
  });

  it('is false for empty/non-string input (fail-open: never mistake nothing for a harness artifact)', () => {
    expect(isHarnessGenerated('')).toBe(false);
    expect(isHarnessGenerated(undefined)).toBe(false);
    expect(isHarnessGenerated(null)).toBe(false);
  });
});

describe('correction-detect.mjs no longer keeps its own copy', () => {
  it('HARNESS_TEMPLATES IS HARNESS_GENERATED_PATTERNS — the same array, not a re-declared duplicate', () => {
    expect(HARNESS_TEMPLATES).toBe(HARNESS_GENERATED_PATTERNS);
  });
});

describe('ground-ruvnet.sh embeds a byte-identical copy of HARNESS_GENERATED_SHELL_PATTERN', () => {
  function extractGroundRuvnetHarnessPattern() {
    const src = fs.readFileSync(GROUND_RUVNET, 'utf8');
    const m = /H2: HARNESS-GENERATED[\s\S]*?grep -qiE '([^']+)'/.exec(src);
    if (!m) throw new Error('could not locate the H2 harness-detection grep -qiE pattern in ground-ruvnet.sh — did it move or get rewritten?');
    return m[1];
  }

  it('extracts a real, non-trivial pattern (or this test checks nothing)', () => {
    const shellPattern = extractGroundRuvnetHarnessPattern();
    expect(shellPattern.length).toBeGreaterThan(50);
    expect(shellPattern).toContain('task-notification');
  });

  it('is byte-identical to HARNESS_GENERATED_SHELL_PATTERN', () => {
    expect(HARNESS_GENERATED_SHELL_PATTERN).toBe(extractGroundRuvnetHarnessPattern());
  });

  it.skipIf(bashOnly)('agrees with real `grep -qiE` on every sample, both harness and real-user', () => {
    const pattern = extractGroundRuvnetHarnessPattern();
    for (const s of [...HARNESS_SAMPLES, ...REAL_USER_SAMPLES]) {
      const shellResult = spawnSync('grep', ['-qiE', pattern], { input: s, encoding: 'utf8' }).status === 0;
      expect(shellResult, `shell grep -qiE disagrees with isHarnessGenerated for ${JSON.stringify(s)}`).toBe(isHarnessGenerated(s));
    }
  });
});

describe('grounding-turn-mark.mjs: a harness-generated message never arms the turn gate (H2)', () => {
  it('does NOT mark even when the harness text names a Gate-1 product (RED on pre-fix code)', () => {
    const text = '<task-notification>Background task "ruflo swarm build" completed.</task-notification>';
    expect(shouldMark({ hook_event_name: 'UserPromptSubmit', session_id: 's-h2', prompt: text })).toBe(false);
  });

  it('CONTROL: the same words WITHOUT the harness wrapper DO arm it (proves the test is not vacuous)', () => {
    const text = 'Background task "ruflo swarm build" completed.';
    expect(shouldMark({ hook_event_name: 'UserPromptSubmit', session_id: 's-h2', prompt: text })).toBe(true);
  });

  it.skipIf(bashOnly)('end-to-end: no marker file is written for a harness-shaped payload', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-mark-'));
    const env = { ...process.env, HOME: home, RUVNET_GROUNDING_TURN_DIR: path.join(home, 'grounding-turn') };
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'grounding-turn-mark.mjs')], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit', session_id: 's-h2-e2e',
        prompt: '<task-notification>Background task "build a ruflo agent" completed.</task-notification>',
      }),
      encoding: 'utf8', env,
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(markerPathFor('s-h2-e2e', env.RUVNET_GROUNDING_TURN_DIR))).toBe(false);
  });
});

describe('capacity-aware-parallel-work.mjs: a harness-generated message never advises a fan-out (H2)', () => {
  // Independent workstream language (multiple components + broad scope) that would otherwise trip
  // isSubstantialParallelWork — chosen to be a genuine positive control, not a weak one.
  const substantialWork = 'refactor the api, cli, and tests across the whole repository end-to-end';

  it('returns "" for harness-wrapped text that would otherwise trigger an advisory (RED on pre-fix code)', () => {
    const out = runCapacityHook(JSON.stringify({
      prompt: `<task-notification>${substantialWork}</task-notification>`,
    }), null);
    expect(out).toBe('');
  });

  it('CONTROL: the same words WITHOUT the harness wrapper DO trigger the advisory', () => {
    const out = runCapacityHook(JSON.stringify({ prompt: substantialWork }), null);
    expect(out).not.toBe('');
  });
});

describe.skipIf(bashOnly)('unprompted-runtime.mjs: the enforcement chokepoint stays silent for a harness message (H2)', () => {
  function runtime(rawInput, extraEnv = {}) {
    return spawnSync(process.execPath, [UNPROMPTED, 'UserPromptSubmit'], {
      input: rawInput, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, RUVNET_BRAIN_METER: '0', ...extraEnv },
    });
  }

  // A trusted always-speaks fake producer via the documented RUVNET_UNPROMPTED_PRODUCERS test seam
  // (same seam tests/unit/hook-hardening.test.mjs's own "TEETH" case uses) — proves the chokepoint
  // itself suppresses dispatch, not that the fake producer happened to stay quiet.
  function alwaysSpeaksProducerEnv(tmp) {
    const emit = path.join(tmp, 'emit.mjs');
    fs.writeFileSync(emit, 'process.stdout.write(`${process.env.CANDIDATE_LINE}\\n`);\n');
    return {
      RUVNET_UNPROMPTED_PRODUCERS: JSON.stringify([{ argv: [process.execPath, emit], feedStdin: true, channels: ['alarm'] }]),
      CANDIDATE_LINE: JSON.stringify({ channel: 'alarm', effect: 'advisory', copy: 'REAL ALARM', hookEventName: 'UserPromptSubmit' }),
    };
  }

  it('a harness-shaped payload never reaches the producers (RED on pre-fix code: this would print REAL ALARM)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-runtime-'));
    const r = runtime(JSON.stringify({
      session_id: 's1',
      prompt: '<task-notification>Background task "build a ruflo agent" completed.</task-notification>',
    }), alwaysSpeaksProducerEnv(tmp));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('CONTROL: the same producer setup DOES speak for a genuine user prompt (proves the test is not vacuous)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-runtime-ctrl-'));
    const r = runtime(JSON.stringify({ session_id: 's2', prompt: 'build a ruflo agent for me' }), alwaysSpeaksProducerEnv(tmp));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REAL ALARM');
  });
});

describe.skipIf(bashOnly || !hasJq)('ground-ruvnet.sh: no grounding banner for a harness-shaped payload (H2)', () => {
  function ground(promptField) {
    return spawnSync('bash', [GROUND_RUVNET], {
      input: JSON.stringify({ prompt: promptField }),
      encoding: 'utf8', timeout: 30_000,
      // A private brain home: this machine's live search-down state must not decide what this test sees.
      env: { ...process.env, RUVNET_BRAIN_METER: '0', RUVNET_AUTONOMOUS: '', RUVNET_BRAIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'h2-brain-')),
        SEARCH_CANARY_STATE: '', RUVNET_BRAIN_CANARY_INJECT: '' },
    });
  }

  it('a harness-wrapped rUv mention injects nothing (RED on pre-fix code: this would print the grounding banner)', () => {
    const r = ground('<task-notification>Background task "build a ruflo agent" completed.</task-notification>');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('CONTROL: the same words WITHOUT the harness wrapper DO inject the grounding banner', () => {
    const r = ground('build a ruflo agent for me');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ground before you assert');
  });
});
