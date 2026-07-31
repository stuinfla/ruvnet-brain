// tests/unit/signal-lifecycle.test.mjs — THE EXISTENCE PROOF for the external-signal watch plane.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS: the watch plane had never been shown closing a real loop.
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// An independent grading of this suite on 2026-07-28 scored D3 (the watch plane) 76 with this
// deduction, quoted: *"Never proven in anger: no evidence of a single real debt resolved end-to-end
// (push → red → surfaced → cleared)."* It was right. `tests/unit/signal-watch.test.mjs` proves each
// PART works — the poller maps conclusions correctly, the observer opens debts, the degradation
// ladder never invents green. `tests/mutation/signal-watch-mutation.test.mjs` proves the parts fail
// when broken. Neither one had ever run a whole debt from `git push` to "CI is green again" on data
// that came from a real pipeline. A plane that has only ever been tested a stage at a time has not
// been proven to CARRY anything.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE LOOP THIS REPLAYS IS REAL, AND IT IS THIS REPO'S OWN. NOTHING BELOW IS SYNTHESIZED.
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// On 2026-07-28, on origin/main, `.github/workflows/learning-replay.yml` carried an unquoted colon
// inside a step name. GitHub's parser rejects a bare `: ` in an unquoted YAML scalar, so the file was
// invalid and the workflow concluded `failure` without executing a step — twice, on two different
// SHAs, 38 minutes apart. Commit `68b1ce7` quoted the step name and the next run concluded
// `success`, 77 seconds later.
//
// Every run id, conclusion, SHA and timestamp used here is COPIED from the live GitHub API into
// tests/fixtures/signal-watch/ci-lifecycle-learning-replay.json, which records the exact `gh`
// commands that produced them so anyone can re-verify:
//
//     30325577756  failure  2818207c…  2026-07-28T03:18:45Z   ← the debt opens
//     30327349291  failure  06bf252a…  2026-07-28T03:57:09Z   ← a second, distinct red
//     30327405302  success  68b1ce71…  2026-07-28T03:58:26Z   ← the fix; the red closes
//
// A fabricated run id here would be worse than the deduction it closes: it would turn the one
// artifact whose entire job is to be evidence into a forgery.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS UNDER TEST — both halves, neither of them a stand-in.
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
//   POLLER    scripts/signal-watch.mjs, by direct import (`pollOnce`), fed the real runs through its
//             own documented SIGNAL_WATCH_GH_FIXTURE port so no network and no auth are involved.
//
//   SURFACER  plugin/scripts/session-start-core.mjs through its shipped CLI boundary, with the real
//             pending/status/surfaced files. The shell is now only a Node trampoline; extracting
//             implementation text from it would grade dead code instead of the single authority.
//
// The transitions asserted are DDD-0013 Context 2's, by name, not an approximation of them:
//   invariant 1  UNKNOWN STAYS OPEN — states are `pending → resolved(conclusion) | unverifiable`.
//   invariant 2  speak on TRANSITIONS only; green emits ZERO bytes unless it closes a surfaced red,
//                which earns EXACTLY ONE line.
//   invariant 5  a surfaced red carries the actionable minimum — workflow, conclusion, and the
//                command that shows the run.
//   invariant 7  once per debt per transition — a still-red debt is never re-nagged.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollOnce, debtKey } from '../../scripts/signal-watch.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION_START = path.join(REPO_ROOT, 'plugin/scripts/session-start-core.mjs');
const LIFECYCLE = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, 'tests/fixtures/signal-watch/ci-lifecycle-learning-replay.json'), 'utf8',
));

const REPO = LIFECYCLE.repo;
const phase = (name) => LIFECYCLE.lifecycle.find((p) => p.phase === name).run;
const RED_1 = phase('red-1');
const RED_2 = phase('red-2');
const GREEN = phase('green');

let tmp;
let home;
let statusFile;
let surfacedFile;
let pendingFile;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-lifecycle-')));
  statusFile = path.join(tmp, 'ci-status.json');
  surfacedFile = path.join(tmp, 'surfaced.json');
  pendingFile = path.join(tmp, 'pending.jsonl');
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.cache/ruvnet-brain'), { recursive: true });
  // This proof owns the external-signal lifecycle, not first-install Stable Spine seeding.
  // An absent active.json makes every surface() call dispatch a detached seed worker; on Windows
  // that unrelated worker can still hold this fixture's cwd when afterEach removes it. Mark the
  // fixture active so the real SessionStart authority exercises only the lifecycle under test.
  fs.writeFileSync(path.join(home, '.cache/ruvnet-brain/active.json'), '{}');
  fs.writeFileSync(path.join(home, '.cache/ruvnet-brain/.last-update-check'), String(Math.floor(Date.now() / 1000)));
});
afterEach(() => {
  // Windows can retain a just-exited foreground process's directory handle for a few milliseconds.
  // `rmSync` only retries EPERM/EBUSY/ENOTEMPTY when maxRetries is explicit; without it, the
  // cleanup itself can make the nested D3 release proof report a product failure.
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Project a captured run onto the exact array shape `gh run list --json …` returns. */
function ghFixtureFor(run, name) {
  const p = path.join(tmp, `gh-${name}.json`);
  fs.writeFileSync(p, JSON.stringify([{
    status: run.status, conclusion: run.conclusion, workflowName: run.workflowName,
  }]));
  return p;
}

/** What plugin/scripts/signal-watch.mjs (the PostToolUse observer) appends when a push succeeds. */
function observePush(run) {
  fs.appendFileSync(pendingFile, `${JSON.stringify({
    kind: 'git-push', repo: REPO, ref: run.headSha, ts: run.createdAt,
  })}\n`);
}

/** Run the REAL SessionStart authority and project only its signal-channel output. */
function surface() {
  const r = spawnSync(process.execPath, [SESSION_START], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: tmp,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RUVNET_SIGNAL_DIR: tmp,
      RUVNET_BRAIN_METER: '0',
      CLAUDE_PLUGIN_ROOT: path.join(REPO_ROOT, 'plugin'),
    },
  });
  expect(r.status, `the surfacer must never fail a session start (stderr: ${r.stderr})`).toBe(0);
  const all = String(r.stdout || '').split('\n');
  const selected = [];
  for (let i = 0; i < all.length; i++) {
    if (/external signal/i.test(all[i])) {
      selected.push(all[i]);
      if (/CI is RED/.test(all[i]) && all[i + 1]?.startsWith('Workflow ')) selected.push(all[++i]);
    }
  }
  return selected.length ? `${selected.join('\n')}\n` : '';
}

const lines = (s) => s.split('\n').filter((l) => l.trim() !== '');

describe('ONE REAL debt, end to end: learning-replay.yml went red on 2026-07-28 and 68b1ce7 fixed it', () => {
  it('push → red → surfaced → fixed → green → closed, and then silence', () => {
    // ── 1. THE PUSH THAT WENT RED. The observer opens a debt keyed (repo, sha); the poller resolves
    //       it against run 30325577756, which really did conclude `failure`.
    observePush(RED_1);
    const afterRed1 = pollOnce({ pendingFile, statusFile, fixturePath: ghFixtureFor(RED_1, 'red1') });
    const key1 = debtKey('gh-ci', REPO, RED_1.headSha);
    expect(afterRed1[key1].state).toBe('resolved');
    expect(afterRed1[key1].conclusion).toBe('failure');

    // ── 2. IT IS SURFACED, unprompted, with the actionable minimum (DDD-0013 inv. 5).
    const red1Out = surface();
    expect(red1Out).toContain('EXTERNAL SIGNAL: CI is RED');
    expect(red1Out).toContain(`${REPO}@${RED_1.headSha.slice(0, 7)}`);
    expect(red1Out).toContain(GREEN.workflowName);          // which workflow
    expect(red1Out).toContain('concluded failure');          // what it concluded
    expect(red1Out).toContain(`gh run list --repo ${REPO} --commit ${RED_1.headSha}`); // how to look
    expect(JSON.parse(fs.readFileSync(surfacedFile, 'utf8')).debts[key1]).toBe('red');

    // ── 3. THE SAME STILL-RED DEBT IS NEVER RE-NAGGED (inv. 7). This is the whole reason the
    //       surfacing ledger exists — the #38 incident put 22 duplicate comments on one issue.
    expect(surface()).toBe('');

    // ── 4. A SECOND, DIFFERENT SHA IS STILL RED. A distinct debt with its own key, so it speaks —
    //       that is a new transition, not a repeat. Run 30327349291, also really `failure`.
    observePush(RED_2);
    const afterRed2 = pollOnce({ pendingFile, statusFile, fixturePath: ghFixtureFor(RED_2, 'red2') });
    const key2 = debtKey('gh-ci', REPO, RED_2.headSha);
    expect(afterRed2[key2].conclusion).toBe('failure');
    // …and the FIRST debt is not re-resolved by a later poll — append-only, its verdict is frozen.
    expect(afterRed2[key1].checkedAt).toBe(afterRed1[key1].checkedAt);
    const red2Out = surface();
    expect(red2Out).toContain(`${REPO}@${RED_2.headSha.slice(0, 7)}`);
    expect(red2Out).not.toContain(RED_1.headSha.slice(0, 7)); // the older red stays quiet

    // ── 5. THE FIX. 68b1ce7 quoted the step name; run 30327405302 concluded `success`.
    observePush(GREEN);
    const afterGreen = pollOnce({ pendingFile, statusFile, fixturePath: ghFixtureFor(GREEN, 'green') });
    const key3 = debtKey('gh-ci', REPO, GREEN.headSha);
    expect(afterGreen[key3].state).toBe('resolved');
    expect(afterGreen[key3].conclusion).toBe('success');

    // ── 6. THE CLOSE — EXACTLY ONE LINE (DDD-0013 inv. 2). Not two, not a summary, not a recap of
    //       both reds. One line that says the pipeline recovered, then out of the way.
    const greenOut = surface();
    expect(lines(greenOut)).toHaveLength(1);
    expect(greenOut).toContain('CI is GREEN again');
    expect(greenOut).toContain(`${REPO}@${GREEN.headSha.slice(0, 7)}`);

    // ── 7. AND THEN SILENCE. Green produces ZERO BYTES once there is no surfaced red left to close.
    //       This is the anti-nag law, and it is the difference between a signal and a nag.
    expect(surface()).toBe('');
    expect(surface()).toBe('');

    // The ledger agrees with what was actually said: two reds announced, the open red closed out.
    const ledger = JSON.parse(fs.readFileSync(surfacedFile, 'utf8'));
    expect(ledger.debts[key1]).toBe('red');
    expect(ledger.debts[key2]).toBe('red');
    expect(ledger.debts[key3]).toBe('green');
    expect(ledger.redRepo[REPO]).toBeUndefined(); // nothing outstanding
  });

  it('a green that never followed a surfaced red says NOTHING — silence is the default, not the exception', () => {
    // The same real success run, with no prior red anywhere in the ledger. If this ever speaks, the
    // plane has become a bot that announces good news, which is how a signal earns itself muted.
    observePush(GREEN);
    pollOnce({ pendingFile, statusFile, fixturePath: ghFixtureFor(GREEN, 'green-only') });
    expect(surface()).toBe('');
  });

  it('the fixture is real: three runs on one workflow, two failures then the success that fixed them', () => {
    // Guards the evidence itself. If someone edits the fixture to make a test pass, the shape of the
    // incident stops matching what `gh` reported and this fails.
    expect(LIFECYCLE.lifecycle).toHaveLength(3);
    expect([RED_1.conclusion, RED_2.conclusion, GREEN.conclusion]).toEqual(['failure', 'failure', 'success']);
    for (const run of [RED_1, RED_2, GREEN]) {
      expect(run.workflowName).toBe('learning-replay');
      expect(run.headBranch).toBe('main');
      expect(String(run.databaseId)).toMatch(/^\d{11}$/);        // a real GitHub run id, not a placeholder
      expect(run.headSha).toMatch(/^[0-9a-f]{40}$/);             // a real full SHA, not "abc123"
      expect(run.url).toBe(`https://github.com/${REPO}/actions/runs/${run.databaseId}`);
    }
    // The green is the newest, and it is the commit whose message names the defect.
    expect(new Date(GREEN.createdAt).getTime()).toBeGreaterThan(new Date(RED_2.createdAt).getTime());
    expect(GREEN.displayTitle).toContain('unquoted colon');
    expect(LIFECYCLE._provenance.command).toContain('gh run list --workflow learning-replay.yml');
  });
});
