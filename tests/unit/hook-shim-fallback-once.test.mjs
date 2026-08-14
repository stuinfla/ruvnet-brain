// hook-shim-fallback-once.test.mjs — the loud fallback must be loud ONCE, not loud per tool call.
//
// THE COMPLAINT, from the owner on 2026-08-13: "When I opened up RuvNet Brain in another project, I
// got a ton of hook errors." One of the two causes is here. hook-shim.mjs writes a stderr line when
// it falls back from a broken spine — correctly, because a broken spine masquerading as health is
// worse. But it wrote that line on EVERY invocation, and the shim is registered ~19 times across the
// two manifests, on UserPromptSubmit / PreToolUse / PostToolUse / Stop. stderr is exactly what a
// host renders as "hook error", so a single broken spine did not report itself once; it reported
// itself continuously, on every prompt and every tool call, for as long as it stayed broken.
//
// MEASURED before the fix: five consecutive fires of ONE hook id produced five identical lines.
//
// The design choice being defended is NOT "be quieter". A warning nobody can read because it repeats
// forty times a minute is the same failure as no warning at all — the surface gets muted and the
// next real one is lost with it. So every case below asserts the message SURVIVES: on the first
// fire, on a new breakage, and after the window. Only the repetition is gone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'hook-shim.mjs');

let HOME_DIR; let PLUGIN_ROOT;
beforeEach(() => {
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-once-home-'));
  PLUGIN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-once-plugin-'));
  fs.mkdirSync(path.join(PLUGIN_ROOT, 'scripts'), { recursive: true });
  // A frozen fallback body that works, so the only stderr in play is the shim's own notice.
  fs.writeFileSync(path.join(PLUGIN_ROOT, 'scripts', 'md-stamp.mjs'), 'process.exit(0);\n');
});
afterEach(() => {
  for (const d of [HOME_DIR, PLUGIN_ROOT]) {
    try { fs.chmodSync(d, 0o755); } catch { /* already writable */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const run = (hookId = 'md-stamp', env = {}) => spawnSync(process.execPath, [SHIM, hookId], {
  encoding: 'utf8',
  env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
});

/** stderr lines produced by firing the shim `n` times. */
const fireN = (n, hookId, env) => Array.from({ length: n }, () => run(hookId, env))
  .flatMap((r) => String(r.stderr || '').split('\n').filter(Boolean));

/** A spine that was seeded and is now unreadable — the state that produced the flood. */
function brokenSpine() {
  fs.writeFileSync(path.join(HOME_DIR, '.spine-seeded'), 'yes');
  fs.writeFileSync(path.join(HOME_DIR, 'active.json'), '{corrupt json');
}

describe.skipIf(process.platform === 'win32')('hook-shim fallback notice — said once, not on every fire', () => {
  it('THE REGRESSION: six fires of a broken spine produce ONE stderr line, not six', () => {
    brokenSpine();
    const lines = fireN(6);
    expect(lines.length, `a broken spine must announce itself once, not once per tool call: ${lines.join(' | ')}`).toBe(1);
    expect(lines[0]).toMatch(/spine unreadable/);
    expect(lines[0]).toMatch(/update-apply\.mjs --doctor/);   // the remedy survives intact
  });

  it('the SAME breakage seen by a different registered hook is still one piece of news', () => {
    // ~19 registrations share one spine. Keying the notice per hook id would put nineteen identical
    // diagnoses of one fault on the screen, which is the same disease in a smaller dose.
    brokenSpine();
    fs.writeFileSync(path.join(PLUGIN_ROOT, 'scripts', 'learn-flush.mjs'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(PLUGIN_ROOT, 'scripts', 'continuation-gate.mjs'), 'process.exit(0);\n');
    const lines = ['md-stamp', 'learn-flush', 'continuation-gate', 'md-stamp'].flatMap((id) => fireN(1, id));
    expect(lines.length, lines.join(' | ')).toBe(1);
  });

  it('THE MESSAGE IS KEPT: a NEW breakage speaks even though an older one was already reported', () => {
    // Silence-after-first-notice would be the over-correction: a spine that breaks a second, different
    // way must still say so. The key carries the generation, so a changed spine is changed news.
    brokenSpine();
    expect(fireN(3).length).toBe(1);

    // A different fault: the spine now resolves, but the body file is missing from it.
    fs.mkdirSync(path.join(HOME_DIR, 'versions', '2.0.0', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR, 'active.json'),
      JSON.stringify({ generation: 10, version: '2.0.0', codeRoot: path.join('versions', '2.0.0') }));
    const second = fireN(3);
    expect(second.length, 'a new fault must not inherit the old fault\'s silence').toBe(1);
    expect(second[0]).toMatch(/spine \(gen 10\) missing md-stamp\.mjs/);
  });

  it('the window is a window, not permanent silence — an expired notice is said again', () => {
    brokenSpine();
    // TTL 0: every fire is past the window. This is the same code path a fresh session takes hours
    // later, and it proves the dedup is a cadence limit rather than a one-time mute.
    const lines = fireN(4, 'md-stamp', { RUVNET_SPINE_NOTICE_TTL_MS: '0' });
    expect(lines.length).toBe(4);
  });

  it('a notice that cannot be RECORDED is still SAID — the warning outranks the bookkeeping', () => {
    brokenSpine();
    fs.chmodSync(HOME_DIR, 0o555);            // marker unwritable
    const lines = fireN(2);
    fs.chmodSync(HOME_DIR, 0o755);
    expect(lines.length, 'failing to persist the claim must never swallow the warning').toBe(2);
  });

  it('first install (never seeded) stays completely quiet, and leaves no marker behind', () => {
    // Unchanged contract: no spine yet is the normal first-run state, not a fault.
    expect(fireN(3)).toEqual([]);
    expect(fs.existsSync(path.join(HOME_DIR, '.spine-fallback-notice'))).toBe(false);
  });

  it('a healthy spine writes nothing at all', () => {
    fs.mkdirSync(path.join(HOME_DIR, 'versions', '1.0.0', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(HOME_DIR, 'versions', '1.0.0', 'scripts', 'md-stamp.mjs'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(HOME_DIR, 'active.json'),
      JSON.stringify({ generation: 1, version: '1.0.0', codeRoot: path.join('versions', '1.0.0') }));
    fs.writeFileSync(path.join(HOME_DIR, '.spine-seeded'), 'yes');
    expect(fireN(3)).toEqual([]);
  });
});
