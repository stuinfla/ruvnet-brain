import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shouldMark, markerPathFor } from '../../plugin/scripts/grounding-turn-mark.mjs';
import { wasGroundedSince, newestGroundingStampMs } from '../../plugin/scripts/grounding-turn-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARK = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-mark.mjs');
const GATE = path.join(ROOT, 'plugin', 'scripts', 'grounding-turn-gate.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-turn-'));
}

describe('grounding-turn-mark.mjs — pure decision logic', () => {
  it('marks only a real UserPromptSubmit payload with a session id and a Gate-1-matching prompt', () => {
    expect(shouldMark({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'build a ruflo agent' })).toBe(true);
    expect(shouldMark({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'what is the weather' })).toBe(false);
    expect(shouldMark({ hook_event_name: 'UserPromptSubmit', prompt: 'use ruflo for this' })).toBe(false); // no session_id
    expect(shouldMark({ hook_event_name: 'Stop', session_id: 's1', prompt: 'use ruflo for this' })).toBe(false); // wrong event
    expect(shouldMark(null)).toBe(false);
  });

  it('reads prompt from prompt, user_prompt, or input, in that order of fallback (matches ground-ruvnet.sh)', () => {
    expect(shouldMark({ hook_event_name: 'UserPromptSubmit', session_id: 's1', user_prompt: 'ruvector setup' })).toBe(true);
    expect(shouldMark({ hook_event_name: 'UserPromptSubmit', session_id: 's1', input: 'ruvector setup' })).toBe(true);
  });
});

describe('grounding-turn-mark.mjs and grounding-turn-gate.mjs share one marker path function', () => {
  it('sanitizes a hostile session id into a safe filename inside the marker dir', () => {
    const dir = tmpDir();
    const p = markerPathFor('../../etc/passwd', dir);
    expect(p).not.toBeNull();
    expect(path.dirname(p)).toBe(dir);
    expect(p).not.toContain('..');
  });

  it('returns null for an empty/missing session id — nothing to key the marker on', () => {
    expect(markerPathFor('', '/tmp/x')).toBeNull();
    expect(markerPathFor(undefined, '/tmp/x')).toBeNull();
  });
});

describe('grounding-turn-gate.mjs — pure decision logic', () => {
  it('is NOT grounded when no stamp exists at all', () => {
    expect(wasGroundedSince(Date.now(), null)).toBe(false);
  });

  it('is NOT grounded when the newest stamp predates the marker (searched before this turn, not during it)', () => {
    const markerMs = 1_000_000;
    const staleStampMs = 900_000; // older
    expect(wasGroundedSince(markerMs, staleStampMs)).toBe(false);
  });

  it('IS grounded when a stamp postdates the marker (searched during/after this turn began)', () => {
    const markerMs = 1_000_000;
    const freshStampMs = 1_000_050;
    expect(wasGroundedSince(markerMs, freshStampMs)).toBe(true);
  });

  it('tolerates same-instant / filesystem-rounding skew without a false negative', () => {
    const markerMs = 1_000_000;
    expect(wasGroundedSince(markerMs, markerMs)).toBe(true);
    expect(wasGroundedSince(markerMs, markerMs - 500)).toBe(true); // inside SKEW_MS
  });

  it('newestGroundingStampMs reads real file mtimes from a directory and ignores non-files', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'agentdb'), '');
    fs.mkdirSync(path.join(dir, 'not-a-file-subdir'));
    const ms = newestGroundingStampMs(dir);
    expect(ms).not.toBeNull();
    expect(Math.abs(Date.now() - ms)).toBeLessThan(5000);
  });

  it('newestGroundingStampMs returns null for a missing directory (fail-open evidence read)', () => {
    expect(newestGroundingStampMs('/definitely/does/not/exist/xyz')).toBeNull();
  });
});

/**
 * END-TO-END, REAL PROCESSES, NO STUBS — proves the fail-first gap directly: before this file
 * existed, NOTHING checked whether a Gate-1-matching turn actually called search_ruvnet. These
 * three cases are exactly Phase 3's Claude-side live-verification matrix, run here as fast,
 * deterministic subprocess tests instead of a real `claude`/`codex` CLI invocation.
 */
function runNode(file, payload, env = {}) {
  return spawnSync(process.execPath, [file], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 5000,
  });
}

describe('end-to-end: mark then gate, real subprocesses, real filesystem', () => {
  it('CASE 1 — RuvNet-matching prompt, no search: the gate FIRES (blocks the stop)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-e2e-'));
    const env = { HOME: home, RUVNET_GROUNDING_TURN_DIR: path.join(home, 'grounding-turn') };

    const markResult = runNode(MARK, {
      hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', prompt: 'build a ruflo agent for me',
    }, env);
    expect(markResult.status).toBe(0);
    expect(fs.existsSync(markerPathFor('sess-1', env.RUVNET_GROUNDING_TURN_DIR))).toBe(true);

    const gateResult = runNode(GATE, {
      hook_event_name: 'Stop', session_id: 'sess-1', stop_hook_active: false,
    }, env);
    expect(gateResult.status).toBe(0); // advisory — never a hard failure exit
    const out = JSON.parse(gateResult.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/search_ruvnet/);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/Do NOT end the turn/);
    // The marker is consumed either way.
    expect(fs.existsSync(markerPathFor('sess-1', env.RUVNET_GROUNDING_TURN_DIR))).toBe(false);
  });

  it('CASE 2 — same prompt, but a real search_ruvnet call happened after it: the gate stays SILENT', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-e2e-'));
    const env = { HOME: home, RUVNET_GROUNDING_TURN_DIR: path.join(home, 'grounding-turn') };

    runNode(MARK, { hook_event_name: 'UserPromptSubmit', session_id: 'sess-2', prompt: 'use ruflo memory' }, env);

    // Simulate grounding-stamp.sh's own write: a stamp file under ~/.cache/ruvnet-brain/grounded/.
    const groundedDir = path.join(home, '.cache', 'ruvnet-brain', 'grounded');
    fs.mkdirSync(groundedDir, { recursive: true });
    fs.writeFileSync(path.join(groundedDir, 'ruflo'), '');

    const gateResult = runNode(GATE, { hook_event_name: 'Stop', session_id: 'sess-2', stop_hook_active: false }, env);
    expect(gateResult.status).toBe(0);
    expect(gateResult.stdout).toBe('');
  });

  it('CASE 3 — prompt never touched the rUv stack: no marker is ever written, gate is silent', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-e2e-'));
    const env = { HOME: home, RUVNET_GROUNDING_TURN_DIR: path.join(home, 'grounding-turn') };

    const markResult = runNode(MARK, {
      hook_event_name: 'UserPromptSubmit', session_id: 'sess-3', prompt: 'write a haiku about the ocean',
    }, env);
    expect(markResult.status).toBe(0);
    expect(fs.existsSync(markerPathFor('sess-3', env.RUVNET_GROUNDING_TURN_DIR))).toBe(false);

    const gateResult = runNode(GATE, { hook_event_name: 'Stop', session_id: 'sess-3', stop_hook_active: false }, env);
    expect(gateResult.status).toBe(0);
    expect(gateResult.stdout).toBe('');
  });

  it('loop safety: stop_hook_active suppresses the gate exactly like continuation-gate.mjs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-e2e-'));
    const env = { HOME: home, RUVNET_GROUNDING_TURN_DIR: path.join(home, 'grounding-turn') };
    runNode(MARK, { hook_event_name: 'UserPromptSubmit', session_id: 'sess-4', prompt: 'build a ruflo agent' }, env);
    const gateResult = runNode(GATE, { hook_event_name: 'Stop', session_id: 'sess-4', stop_hook_active: true }, env);
    expect(gateResult.status).toBe(0);
    expect(gateResult.stdout).toBe('');
    // Marker untouched — this stop episode never evaluated it.
    expect(fs.existsSync(markerPathFor('sess-4', env.RUVNET_GROUNDING_TURN_DIR))).toBe(true);
  });
});
