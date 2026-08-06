// tests/unit/star-ask-once.test.mjs — the once-EVER star/feedback line in session-start.sh.
//
// Contract:
//   • It only appears after the brain has actually grounded something (.grounded-once stamp,
//     written by forge-mcp-all.mjs on the first successful search_ruvnet).
//   • It appears exactly ONCE per machine, ever — .star-ask-shown is written BEFORE the echo,
//     so even a killed session can't cause a repeat.
//   • A machine that has never grounded never sees it.
// Runs the real script with HOME pointed at a temp dir; the heartbeat's network check is skipped
// by pre-seeding .last-update-check with "now" (the script's own 15-min rate limit).

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'plugin', 'scripts', 'session-start.sh');
const STAR_LINE = 'Finding this useful? Star github.com/stuinfla/ruvnet-brain';

let home, stateDir;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-star-home-'));
  stateDir = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(stateDir, { recursive: true });
  // Keep the run hermetic: auto-update pref answered (so no setup question / KB check),
  // heartbeat stamped "just checked" (so no curl), meter off (plain stdout).
  fs.writeFileSync(path.join(stateDir, '.auto-update-pref'), 'no\n');
  fs.writeFileSync(path.join(stateDir, '.last-update-check'), String(Math.floor(Date.now() / 1000)));
});

function run() {
  // 'bash' via PATH, not /bin/bash: Windows runners resolve this to Git Bash — the same shell
  // Claude Code uses for hooks on real Windows machines, so the test matches production there.
  const r = spawnSync('bash', [SCRIPT], {
    // USERPROFILE as well as HOME (25cda46's class, measured here). The hook's node half resolves
    // ~/.cache/ruvnet-brain from os.homedir(), which reads USERPROFILE on Windows and ignores HOME.
    // MEASURED under Windows homedir semantics before this line: the suite stayed GREEN while
    // writing 81 files — a staged version tree plus an update transaction and lock — into the
    // runner's real profile. Green is the dangerous half: the fixture below seeds `.grounded-once`
    // and the star stamp, so on Windows the assertions were reading a profile nobody seeded.
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), RUVNET_BRAIN_METER: '0' },
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(r.status).toBe(0); // the hook must NEVER exit non-zero — that could block a session
  return r.stdout || '';
}

describe('once-ever star/feedback line', () => {
  it('never shows on a machine where the brain has not grounded anything', () => {
    const out = run();
    expect(out).not.toContain(STAR_LINE);
    expect(fs.existsSync(path.join(stateDir, '.star-ask-shown'))).toBe(false);
  });

  it('shows exactly once after the first successful grounding, then never again', () => {
    fs.writeFileSync(path.join(stateDir, '.grounded-once'), new Date().toISOString());

    const first = run();
    expect(first).toContain(STAR_LINE);
    expect(fs.existsSync(path.join(stateDir, '.star-ask-shown'))).toBe(true);

    const second = run();
    expect(second).not.toContain(STAR_LINE);

    const third = run(); // paranoia: still silent on every subsequent session
    expect(third).not.toContain(STAR_LINE);
  });

  it('respects a pre-existing shown-stamp (e.g. restored dotfiles) — silence, not a re-ask', () => {
    fs.writeFileSync(path.join(stateDir, '.grounded-once'), 'x');
    fs.writeFileSync(path.join(stateDir, '.star-ask-shown'), 'x');
    expect(run()).not.toContain(STAR_LINE);
  });
});
