// ADR-106 `no-deferral`: the pure detector on fixed fixtures (magnitude-bounded), then the REAL Stop
// gate across a process boundary. Phrasings are modelled on real flagged turns from deferral-replay.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { auditDeferral, blockersIn, deferralIn, standingAuthorization } from '../../plugin/scripts/deferral-evidence.mjs';
import { adoptedProject, cleanup } from '../helpers/continuity-fixture.mjs';

const AUTH = ['Fix the hooks and get it done. Do not stop until it is shipped.'];

const DEFERRALS = [
  'I built the parser and the tests pass. Say go and I\'ll start on the release.',
  'The audit is ready. Do you want me to apply the fixes now?',
  'Three findings remain. Should I fix them on a new branch?',
  'Would you like me to run the full suite next?',
  'Let me know if you want the migration applied.',
  '## Decisions I need from you\n1. Merge order.\n2. Whether to ship tonight.',
  'Everything else is staged. I need your go-ahead to push the branch.',
  'Waiting on your answer on the flag before I continue.',
  'The fix is written but not tested.\n\n**Next:** run the tests, then push and check the live site.',
  'Status is recorded. I\'ll pick this up later once you are back.',
  'The plan is in the ADR. Ready when you are.',
  'Phase 2 is done. Your call on whether to launch Phase 3.',
  'Remaining: the version bump and the protected-release dispatch.',
  'All reviewers agree. OK to proceed?',
  'I\'m waiting for your go-ahead on the ADR and the card.',
  'The branch is clean. Want me to proceed with the version bump + release dispatch now?',
];

const LEGITIMATE = [
  // plain status reports and completed work
  'Verified: npm test passed (40/40). NOT verified: the Windows install. Commit abc1234 is on the branch.',
  'Done. The parser handles both shapes and the suite is green; the Linux lane was not run.',
  'I fixed the race and committed it as 5f3e2a1. Nothing else is open.',
  // explicitly progressing
  'Starting on step 1 (the crash fix) now, since it unblocks everything else.',
  'Nothing is waiting on you.',
  'The ADR is done and I\'m continuing with the tests now; should I find a gap, I will add it to the list.',
  'The remaining order needs no further input needed from you: 1. fix 2. test 3. ship.',
  // genuine blockers (each class)
  'The deploy needs the npm token, which is missing from this machine. Should I wait for you to add it?',
  'Publishing needs a tap on your hardware security key. Say go when you are at the Mini.',
  'That would write to ~/.claude, which is outside my stated authority. Do you want me to do it?',
  'This deletes the production database and cannot be undone. Should I proceed?',
  'GitHub is returning 503 for every API call (status page shows an outage). Want me to retry in ten minutes?',
  'Should the release go out as two versions or as one combined release?',
  'The CI run is still running; I will merge once it passes. Want me to also tag it?',
  'Restart the Mac (Apple menu → Restart), then tell me when you are back.',
  'These are the three drives at the current price on amazon.com. Should I pick the Samsung?',
  'Show me where that file is and I will read it.',
];

describe('pure detector, on fixed fixtures', () => {
  it(`flags all ${DEFERRALS.length} true deferrals when authorization exists`, () => {
    const missed = DEFERRALS.filter((m) => auditDeferral(m, { prompts: AUTH }).verdict !== 'DEFERRAL');
    expect(missed).toEqual([]);
    expect(DEFERRALS.length).toBeGreaterThanOrEqual(15);
  });
  it(`passes all ${LEGITIMATE.length} legitimate endings (status, progress, every blocker class)`, () => {
    const flagged = LEGITIMATE.filter((m) => auditDeferral(m, { prompts: AUTH }).verdict === 'DEFERRAL');
    expect(flagged).toEqual([]);
    expect(LEGITIMATE.length).toBeGreaterThanOrEqual(15);
  });
  it('without authorization (no standing instruction, no open promise) nothing is forced', () => {
    expect(DEFERRALS.filter((m) => auditDeferral(m, { prompts: ['What does this repo do?'] }).verdict === 'DEFERRAL')).toEqual([]);
    expect(auditDeferral(DEFERRALS[0], { prompts: [], openPromises: 1 }).verdict).toBe('DEFERRAL');
  });
  it('looks only at the END of the answer and ignores quoted or fenced text', () => {
    const early = 'Should I fix it? I did: ' + 'the fix landed and the suite is green. '.repeat(30);
    expect(deferralIn(early)).toBeNull();
    expect(deferralIn('Done.\n```\nShould I proceed?\n```')).toBeNull();
    expect(blockersIn('the `npm token missing` string')).toEqual([]);
    expect(standingAuthorization(['please keep going'])).toBe('keep going');
  });
});

describe('the REAL Stop gate, across a process boundary', () => {
  afterEach(() => cleanup());
  const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/continuation-gate.mjs');
  const rec = (o) => JSON.stringify(o);
  const transcript = (dir, prompt, answer) => {
    const file = path.join(dir, `t-${Math.random().toString(16).slice(2)}.jsonl`);
    fs.writeFileSync(file, [rec({ type: 'user', message: { role: 'user', content: prompt } }),
      rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })].join('\n') + '\n');
    return file;
  };
  const fire = (p, prompt, answer, { active = false, host = 'claude', env = {} } = {}) => {
    const r = spawnSync(process.execPath, [GATE], { cwd: p.dir, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: p.dir, session_id: 's1', stop_hook_active: active,
        last_assistant_message: answer, transcript_path: transcript(p.dir, prompt, answer) }),
      env: { ...p.env, USERPROFILE: p.home, RUVNET_HOOK_HOST: host, RUVNET_WORK_LEDGER: path.join(p.home, 'ledger.json'),
        RUVNET_BRAIN_HOME: path.join(p.home, 'bh'), RUVNET_PROMISE_CAPTURE: 'off',
        RUVNET_OPEN_ISSUES_FILE: path.join(p.home, 'none.json'), RUVNET_CI_STATUS_FILE: path.join(p.home, 'none.json'),
        RUVNET_CAPABILITY_ROOTS: path.join(p.home, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(p.home, 'live.jsonl'),
        RUVNET_EVIDENCE_FILE: path.join(p.home, 'ev.jsonl'), RUVNET_CONTINUATION_COOLDOWN_MS: '1', ...env } });
    expect(r.status).toBe(0);
    return r.stdout;
  };
  it('forces once on an authorized deferral, then records "not resolved" and lets the continued stop through', () => {
    const p = adoptedProject();
    const out = fire(p, AUTH[0], DEFERRALS[0]);
    const env = JSON.parse(out);
    expect(env.decision).toBe('block');
    expect(env.reason).toMatch(/Continue now; stop only on a genuine blocker/);
    expect(env.reason).toContain('Say go');
    expect(fire(p, AUTH[0], DEFERRALS[0], { active: true })).toBe('');
    const ledger = fs.readFileSync(path.join(p.home, 'bh', 'hook-failures.jsonl'), 'utf8');
    expect(ledger).toMatch(/deferral not resolved after 1 force/);
    expect(fire(p, AUTH[0], DEFERRALS[0], { active: true })).toBe('');
    expect(fs.readFileSync(path.join(p.home, 'bh', 'hook-failures.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1); // reported once
  });
  it('caps forces per prompt at 3, then lets it through with one advisory', () => {
    const p = adoptedProject();
    for (let i = 0; i < 3; i++) expect(JSON.parse(fire(p, AUTH[0], DEFERRALS[1])).decision).toBe('block');
    expect(fire(p, AUTH[0], DEFERRALS[1])).toBe('');
    expect(fs.readFileSync(path.join(p.home, 'bh', 'hook-failures.jsonl'), 'utf8')).toMatch(/after 3 force/);
  });
  it('never forces a blocker, an unauthorized session, Codex, or when switched off', () => {
    const p = adoptedProject();
    expect(fire(p, AUTH[0], LEGITIMATE[6])).toBe('');
    expect(fire(p, 'What does this repo do?', DEFERRALS[0])).toBe('');
    expect(fire(p, AUTH[0], DEFERRALS[0], { host: 'codex' })).toBe('');
    expect(fire(p, AUTH[0], DEFERRALS[0], { env: { RUVNET_NO_DEFERRAL: 'off' } })).toBe('');
  });
});
