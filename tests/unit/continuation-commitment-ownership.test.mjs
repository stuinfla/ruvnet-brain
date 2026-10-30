import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { extractCommitments, extractCompletionClaims } from '../../plugin/scripts/completion-claim-evidence.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = path.join(ROOT, 'plugin/scripts/continuation-gate.mjs');
const SHIM = path.join(ROOT, 'plugin/scripts/hook-shim.mjs');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/hooks.json')));
const registration = registry.hooks.Stop.flatMap((group) => group.hooks)
  .find((hook) => hook.command.includes(' continuation-gate'));
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const promise = "I'll add the retry test to the updater.";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-owner-')));
  roots.push(root);
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(git.stderr);
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'fixture task' } })}\n`);
  const ledger = path.join(root, 'ledger.json');
  const env = { ...process.env, HOME: root, USERPROFILE: root,
    RUVNET_BRAIN_HOME: path.join(root, 'brain'), RUVNET_HOOK_HOST: 'claude',
    RUVNET_WORK_LEDGER: ledger, RUVNET_BRAIN_SESSION_ID: '', RUVNET_HOOK_SESSION_ID: '',
    RUVNET_PROMISE_CAPTURE: 'on', RUVNET_CONTINUATION_COOLDOWN_MS: '1',
    RUVNET_OPEN_ISSUES_FILE: path.join(root, 'none'), RUVNET_CI_STATUS_FILE: path.join(root, 'none'),
    RUVNET_CAPABILITY_ROOTS: path.join(root, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(root, 'none') };
  const read = () => JSON.parse(fs.readFileSync(ledger, 'utf8'));
  const write = (value) => fs.writeFileSync(ledger, JSON.stringify(value));
  function stop(sessionId, message = 'This session has no additional assistant commitment.') {
    // Execute the actual registered argv without a POSIX-only shell on Windows.
    expect(registration.command).toContain('/scripts/hook-shim.mjs" continuation-gate');
    fs.rmSync(`${ledger}.cooldown`, { force: true });
    return spawnSync(process.execPath, [SHIM, 'continuation-gate'], { cwd: repo, env, encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: repo, session_id: sessionId,
        stop_hook_active: false, transcript_path: transcript, last_assistant_message: message }) });
  }
  const cli = (args, override = {}) => spawnSync(process.execPath, [GATE, ...args], {
    cwd: repo, env: { ...env, ...override }, encoding: 'utf8' });
  const state = (name, sid = 'session-A', reason = 'recorded fixture reason', extra = []) => cli([
    '--set-commitment-state', name, '--item', read().items[0].text, '--session-id', sid, '--reason', reason, ...extra]);
  return { root, repo, transcript, ledger, env, read, write, stop, cli, state };
}

function checkedTranscript(file) {
  fs.writeFileSync(file, [
    { type: 'user', message: { role: 'user', content: 'fixture task' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'check', content: 'PASS 4 tests' }] } },
  ].map(JSON.stringify).join('\n'));
}
const verified = 'The updater retry test is now passing.\nVerified: npm test — PASS.\nNot verified: native host delivery.';

describe('registered Stop assistant commitment ownership', () => {
  it('new capture names its actual session; a different session cannot inherit the nudge', () => {
    const f = fixture();
    expect(f.stop('session-A', promise).stdout).toContain('you said you would');
    expect(f.read().items[0]).toMatchObject({ sessionIds: ['session-A'], capturedFrom: { sessionId: 'session-A' }, state: 'active' });
    const original = f.read().items;
    expect(f.stop('session-B').stdout).toBe('');
    expect(f.read().items).toEqual(original);
    expect(f.stop('session-A').stdout).toContain('you said you would');
  });

  it('keeps legacy wildcard debt only for its proven capturing session, without erasing it', () => {
    const f = fixture(); f.stop('session-A', promise);
    const led = f.read(); led.items[0].sessionIds = ['*']; led.items[0].at = '2020-01-01T00:00:00Z'; f.write(led);
    expect(f.stop('session-B').stdout).toBe('');
    expect(f.stop('session-A').stdout).toContain('you said you would');
    expect(f.read().items).toEqual(led.items);
    delete led.items[0].capturedFrom; f.write(led);
    expect(f.stop('session-A').stdout).toBe('');
    expect(f.read().items).toEqual(led.items);
    expect(f.state('disputed').status).toBe(2);
  });

  it('allows the same work text to be independently captured by another session', () => {
    const f = fixture(); f.stop('session-A', promise); f.stop('session-B', promise);
    expect(f.read().items.map((item) => item.capturedFrom.sessionId)).toEqual(['session-A', 'session-B']);
  });

  it('retains paused debt without letting it consume the active capture cap', () => {
    const f = fixture(); f.stop('session-A', promise);
    const led = f.read();
    led.items = Array.from({ length: 8 }, (_, i) => ({ ...led.items[0], state: 'blocked', text: `blocked fixture task ${i}`, key: `blocked-${i}` }));
    f.write(led);
    expect(f.stop('session-A', promise).stdout).toContain('add the retry test');
    expect(f.read().items).toHaveLength(9);
    expect(f.read().items.slice(0, 8)).toEqual(led.items);
  });

  it('refuses a wildcard payload session as an automatic capture owner', () => {
    const f = fixture(); expect(f.stop('*', promise).stdout).toBe('');
    expect(fs.existsSync(f.ledger)).toBe(false);
  });

  it('a different session cannot close another session promise even with PASS evidence', () => {
    const f = fixture(); f.stop('session-A', promise); checkedTranscript(f.transcript);
    const original = f.read().items[0];
    // #425: a scope-only UNKNOWN is not a correction, and session-B owns no promise to nudge.
    expect(f.stop('session-B', verified).stdout).toBe('');
    expect(f.read().items[0]).toEqual(original);
    f.stop('session-A', verified);
    expect(f.read().items[0]).toEqual(original);
  });

  it('a quoted exact promise and one local check cannot establish whole-task completion', () => {
    const f = fixture(); f.stop('session-A', promise);
    const answer = "'add the retry test to the updater' is done.\nVerified: npm test — PASS.\nNot verified: native host delivery.";
    f.stop('session-A', answer); expect(f.read().items[0].done).toBe(false);
    checkedTranscript(f.transcript);
    expect(JSON.parse(f.stop('session-A', answer).stdout).decision).toBe('block');
    expect(f.read().items[0]).toMatchObject({ done: false, state: 'active' });
    expect(f.read().items[0].completionEvidence).toBeUndefined();
  });

  it('exact --done still cannot invent completion', () => {
    const f = fixture(); f.stop('session-A', promise);
    expect(f.cli(['--done', f.read().items[0].text]).status).toBe(2);
    expect(f.read().items[0].done).toBe(false);
  });

  it('distinguishes unsupported first-person completion from an accurately scoped check result', () => {
    const f = fixture();
    f.stop('session-A', "I'll run the four checks and report each as pass or fail.");
    const claim = 'I completed the run of the four checks and reported each as pass or fail.';
    expect(extractCompletionClaims(claim)).toHaveLength(1);
    expect(extractCompletionClaims('I reported the result.')).toHaveLength(1);
    expect(extractCompletionClaims('Someone reported the four checks are passing.')).toEqual([]);
    expect(extractCompletionClaims('The log said the updater is fixed.')).toEqual([]);
    const answer = `${claim}\nVerified: npm test — PASS.\nNot verified: native host delivery.`;
    const correction = JSON.parse(f.stop('session-A', answer).stdout);
    expect(correction.decision).toBe('block');
    expect(correction.reason).toContain('beyond the available verified scope');
    expect(f.read().items[0].done).toBe(false);
    checkedTranscript(f.transcript);
    expect(JSON.parse(f.stop('session-A', answer).stdout).decision).toBe('block');
    expect(f.read().items[0]).toMatchObject({ done: false, state: 'active' });
    expect(f.stop('session-B', 'Targeted unit tests are passing.\nVerified: npm test — PASS.\nNot verified: native host delivery.').stdout).toBe('');
    expect(f.read().items[0].done).toBe(false);
  });

  it.each(['blocked', 'deferred', 'superseded', 'disputed'])('records honest %s state without completing or erasing the item', (state) => {
    const f = fixture(); f.stop('session-A', promise); const original = f.read().items[0];
    const extra = state === 'superseded' ? ['--replacement', 'named replacement task reference'] : [];
    expect(f.state(state, 'session-A', 'reason the assistant commitment is not executable', extra).status).toBe(0);
    const item = f.read().items[0];
    expect(item).toMatchObject({ ...original, state, done: false });
    expect(item.doneAt).toBeUndefined();
    expect(item.stateHistory[0]).toMatchObject({ from: 'active', to: state,
      reason: 'reason the assistant commitment is not executable', provenance: { kind: 'explicit-session-cli', sessionId: 'session-A' } });
    expect(Number.isFinite(Date.parse(item.stateChangedAt))).toBe(true);
    expect(f.stop('session-A').stdout).toBe('');
    f.stop('session-A', promise); expect(f.read().items).toHaveLength(1); expect(f.read().items[0].state).toBe(state);
  });

  it('reasoned assistant state never silences explicit user-authorized project work across sessions', () => {
    const f = fixture(); f.stop('session-A', promise);
    expect(f.cli(['--commit-to', 'finish the explicitly authorized project task']).status).toBe(0);
    const objective = f.read().objective;
    expect(f.state('blocked').status).toBe(0);
    expect(f.read().objective).toEqual(objective);
    expect(f.stop('session-B').stdout).toContain('finish the explicitly authorized project task');
    expect(f.stop('session-B').stdout).not.toContain('you said you would');
  });

  it.each(['session-B', '*', ''])('refuses state transition from unrelated or unavailable session %j', (sid) => {
    const f = fixture(); f.stop('session-A', promise); const original = fs.readFileSync(f.ledger, 'utf8');
    expect(f.state('deferred', sid).status).toBe(2); expect(fs.readFileSync(f.ledger, 'utf8')).toBe(original);
  });

  it('refuses explicit owner argument when a different native session is known', () => {
    const f = fixture(); f.stop('session-A', promise);
    expect(f.cli(['--set-commitment-state', 'deferred', '--item', f.read().items[0].text,
      '--session-id', 'session-A', '--reason', 'reason'], { RUVNET_BRAIN_SESSION_ID: 'session-B' }).status).toBe(2);
    expect(f.read().items[0].state).toBe('active');
  });

  it.each(['completed', 'cancelled', 'active'])('does not accept %s as a reasoned noncompletion state', (state) => {
    const f = fixture(); f.stop('session-A', promise); expect(f.state(state).status).toBe(2);
    expect(f.read().items[0].state).toBe('active');
  });

  it('requires a reason and a distinct replacement for superseding; keeps successive provenance', () => {
    const f = fixture(); f.stop('session-A', promise);
    expect(f.state('deferred', 'session-A', ' ').status).toBe(2);
    expect(f.state('superseded').status).toBe(2);
    expect(f.state('superseded', 'session-A', 'reason', ['--replacement', f.read().items[0].text]).status).toBe(2);
    expect(f.state('blocked').status).toBe(0); expect(f.state('disputed').status).toBe(0);
    expect(f.read().items[0].stateHistory.map(({ from, to }) => [from, to])).toEqual([['active', 'blocked'], ['blocked', 'disputed']]);
  });

  it('retains malformed historical state evidence and refuses to overwrite it', () => {
    const f = fixture(); f.stop('session-A', promise);
    const led = f.read(); led.items[0].stateHistory = { unknownHistoricalEvidence: 'retain' }; f.write(led);
    expect(f.state('disputed').status).toBe(2);
    expect(f.read()).toEqual(led);
  });
});

describe('owner-dependent offers are not executable assistant commitments', () => {
  it.each(["Say the word and I'll hide it the same way.", 'Say the word and I will push it.',
    "Or just ask me and I'll open it for you.", "Let me know and I'll add the retry test.",
    'I will ask again before the first push.', "I'll confirm with you before the first push.",
    "I'll check with you before publishing the release."] )('rejects %s', (message) => {
    expect(extractCommitments(message)).toEqual([]);
    const f = fixture(); f.stop('session-A', message); expect(fs.existsSync(f.ledger)).toBe(false);
  });
  it('retains unconditional concrete task promises and plan items', () => {
    expect(extractCommitments(promise)).toHaveLength(1);
    expect(extractCommitments("I'll check the retry test before committing the patch.")).toHaveLength(1);
    expect(extractCommitments('My plan:\n1. add the retry test\n2. wire the alert')).toHaveLength(2);
  });
});

// #369 (remaining items, reported by HF-teamdev on 4.5.11).
describe('pronoun-only promises and double-quoted promise names (#369)', () => {
  it.each(["I'll hide it the same way.", 'I will check for it then.', "I'll set it up again."])('rejects the referent-less %s', (message) => {
    expect(extractCommitments(message)).toEqual([]);
  });
  it('keeps promises that name their object', () => {
    expect(extractCommitments("I'll push it to origin.")).toHaveLength(1);
    expect(extractCommitments("I'll push the branch itself, as a record.")).toHaveLength(1);
  });
  it('a double-quoted claim closes its promise under PASS only, and carries the raw sentence', async () => {
    const evidence = await import('../../plugin/scripts/completion-claim-evidence.mjs');
    const answer = '"push the branch itself" is done (verified: git ls-remote origin).\nNot verified: CI.';
    const claims = extractCompletionClaims(answer);
    expect(claims.map((c) => c.text)).toEqual(['is done (verified: git ls-remote origin).']);
    const item = 'push the branch itself, as a record';
    expect(evidence.promiseClosingClaim?.({ verdict: 'PASS', claims }, answer, item)?.text)
      .toBe('"push the branch itself" is done (verified: git ls-remote origin).');
    for (const verdict of ['OBSERVED_CHECK', 'UNKNOWN', 'FAIL']) expect(evidence.promiseClosingClaim({ verdict, claims }, answer, item)).toBeNull();
    // Quoting alone is not a claim: someone else's words never close a promise.
    const quoteOnly = 'You said "push the branch itself is done".';
    expect(evidence.promiseClosingClaim({ verdict: 'PASS', claims: extractCompletionClaims(quoteOnly) }, quoteOnly, item)).toBeNull();
  });
});

describe('#369 per-promise forcing limit (RUVNET_PROMISE_MAX_FORCES, default 3)', () => {
  it('forces a promise exactly three times, then retains it as deferred and stops forcing (separate process per stop)', () => {
    const f = fixture();
    const outs = [f.stop('session-A', promise).stdout];            // capture stop = force 1
    for (let i = 0; i < 4; i += 1) outs.push(f.stop('session-A').stdout);
    expect(outs.map((o) => o.includes('you said you would'))).toEqual([true, true, true, false, false]);
    expect(f.read().items[0]).toMatchObject({ done: false, state: 'deferred' });
    expect(f.read().items[0].stateReason).toContain('retained, not completed');
  });

  it('the quiet default never forces a promise at all (so there is nothing to cap), and a lower limit is honoured', () => {
    const quiet = fixture(); quiet.env.RUVNET_STOP_NUDGES = '';
    expect(quiet.stop('session-A', promise).stdout).toBe('');
    expect(quiet.stop('session-A').stdout).toBe('');
    const tight = fixture(); tight.env.RUVNET_PROMISE_MAX_FORCES = '1';
    const outs = [tight.stop('session-A', promise).stdout, tight.stop('session-A').stdout, tight.stop('session-A').stdout];
    expect(outs.map((o) => o.includes('you said you would'))).toEqual([true, false, false]);
  });
});

describe('#369 evidenced promises (observed check, never completion)', () => {
  const cmdPromise = "I'll run `npm run hooks:check` for the hook wiring.";
  const claim = '"run for the hook wiring" is done.';
  const answer = `${claim}\nVerified: npm run hooks:check — PASS.\nNot verified: Codex.`;
  const step = (name, input, out) => [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: name, name: input.file_path ? 'Edit' : 'Bash', input }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: name, content: out.text, is_error: out.error === true }] } }];
  function steps(f, ...list) {
    fs.writeFileSync(f.transcript, [{ type: 'user', message: { role: 'user', content: 'fixture task' } },
      ...list.flatMap((s, i) => step(`s${i}`, s.input, s.out))].map(JSON.stringify).join('\n'));
  }
  const EDIT = { input: { file_path: '/repo/a.mjs' }, out: { text: 'ok' } };
  const check = (command = 'npm run hooks:check', out = { text: 'PASS' }) => ({ input: { command }, out });
  const captured = () => { const f = fixture(); f.stop('session-A', cmdPromise); return f; };

  it('captures the inline-code commands of the original sentence (max 2)', () => {
    expect(extractCommitments(cmdPromise)[0].evidenceCommands).toEqual(['npm run hooks:check']);
    expect(extractCommitments("I will run `npm run a` and `npm run b` and `npm run c` for the wiring.")[0].evidenceCommands).toHaveLength(2);
    expect(extractCommitments(promise)[0].evidenceCommands).toBeUndefined();
    const f = captured();
    expect(f.read().items[0].evidenceCommands).toEqual(['npm run hooks:check']);
  });

  it('a quoted claim plus the promised check after the edit => evidenced, not done, no longer forced', () => {
    const f = captured(); steps(f, EDIT, check());
    expect(f.stop('session-A', answer).stdout).toBe('');
    const item = f.read().items[0];
    expect(item).toMatchObject({ done: false, state: 'evidenced',
      closureEvidence: { command: 'npm run hooks:check', auditVerdict: 'UNKNOWN', authority: false } });
    expect(item.closureEvidence.claim).toContain('is done');
    expect(f.stop('session-A', 'Anything else.').stdout).toBe('');
    expect(f.read().items[0].state).toBe('evidenced');
    expect(f.cli(['--done', item.text]).status).toBe(2);
  });

  it.each([
    ['check ran before the edit', (f) => steps(f, check(), EDIT), 'session-A'],
    ['a different command ran', (f) => steps(f, EDIT, check('npm test')), 'session-A'],
    ['the promised check failed', (f) => steps(f, EDIT, check('npm run hooks:check', { text: 'FAIL', error: true })), 'session-A'],
    ['the claim comes from another session', (f) => steps(f, EDIT, check()), 'session-B'],
  ])('stays active when %s', (_, arrange, session) => {
    const f = captured(); arrange(f); f.stop(session, answer);
    expect(f.read().items[0]).toMatchObject({ done: false, state: 'active' });
    expect(f.read().items[0].closureEvidence).toBeUndefined();
  });

  it.each([
    ['a pipe', 'npm run hooks:check | tail -3'],
    ['an `|| true`', 'npm run hooks:check || true'],
    ['a `;` tail', 'npm run hooks:check; echo done'],
    ['an env prefix', 'SKIP_HOOKS=1 npm run hooks:check'],
  ])('stays active when the promised check ran with %s (its status is not the check\'s)', (_, command) => {
    const f = captured(); steps(f, EDIT, check(command, { text: 'FAIL 3 failed' }));
    f.stop('session-A', answer);
    expect(f.read().items[0]).toMatchObject({ done: false, state: 'active' });
    expect(f.read().items[0].closureEvidence).toBeUndefined();
  });

  it('stays active without a disclosure of what is not verified', () => {
    const f = captured(); steps(f, EDIT, check());
    f.stop('session-A', `${claim}\nVerified: npm run hooks:check — PASS.`);
    expect(f.read().items[0].state).toBe('active');
  });
});
