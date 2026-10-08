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
    { type: 'user', toolUseResult: { exitCode: 0 }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'check', content: 'PASS 4 tests' }] } },
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
    expect(f.stop('session-A').stdout).toBe('');
  });

  it('keeps legacy wildcard debt only for its proven capturing session, without erasing it', () => {
    const f = fixture(); f.stop('session-A', promise);
    const led = f.read(); led.items[0].sessionIds = ['*']; led.items[0].at = '2020-01-01T00:00:00Z'; f.write(led);
    expect(f.stop('session-B').stdout).toBe('');
    expect(f.stop('session-A').stdout).toBe('');
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
    const correction = JSON.parse(f.stop('session-B', verified).stdout);
    expect(correction.decision).toBe('block');
    expect(correction.reason).not.toContain('you said you would');
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

  it('an unrelated current answer is not blocked by same-session unlinked history', () => {
    const f = fixture(); f.stop('session-A', promise);
    const prior = f.read().items;
    expect(f.stop('session-A', 'Here is the requested CPU and memory status.').stdout).toBe('');
    expect(f.read().items).toEqual(prior);
    expect(f.stop('session-A', promise).stdout).toContain('add the retry test');
  });
  it.each(['compare the real counts tomorrow', 'check again at 10:00 before running',
    'run the check after the deployment', 'retry if the dependency becomes available'])('retains future/conditional promise without blocking current Stop: %s', text => {
    const f = fixture(); f.stop('session-A', promise);
    const ledger = f.read(); ledger.items[0].text = text; ledger.items[0].at = '2020-01-01T00:00:00Z'; f.write(ledger);
    const result = f.stop('session-A');
    expect(result.stdout).toBe('');
    expect(f.read().items).toEqual(ledger.items);
  });
  it.each(['claude', 'codex'])('emits one concise native JSON current step while retaining stale/future history on %s', host => {
    const f = fixture(); f.stop('session-A', promise);
    const ledger = f.read(); ledger.items[0].text = 'compare the real counts tomorrow';
    ledger.items[0].at = '2020-01-01T00:00:00Z'; f.write(ledger);
    expect(f.cli(['--commit-to', 'finish the currently authorized checker repair']).status).toBe(0);
    f.env.RUVNET_HOOK_HOST = host;
    const result = JSON.parse(f.stop('session-A').stdout);
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('finish the currently authorized checker repair');
    expect(result.reason).not.toMatch(/tomorrow|--set-commitment-state|☐|\n/);
    expect(result.reason.length).toBeLessThan(400);
    expect(f.read().items[0]).toEqual(ledger.items[0]);
    expect(f.read().items).toHaveLength(2);
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
