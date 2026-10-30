// continuation-gate-completion-claims.test.mjs — ADR-074 `completion` class (Piece A) and promise
// capture (Piece C), driven through the REAL Stop gate in a REAL git repo with a REAL JSONL
// transcript fixture. Every guard here is also broken on purpose (the "remove the detector" case
// runs a mutated copy of the gate and proves the block disappears), because a guard that cannot
// fail is not a guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSettledTranscript } from '../../plugin/scripts/turn-outcome-capture.mjs';
import {
  extractCompletionClaims, extractCommitments, auditCompletionClaims, claudeTurnEvents, promiseEvidence,
} from '../../plugin/scripts/completion-claim-evidence.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = path.join(ROOT, 'plugin/scripts/continuation-gate.mjs');
let dir;
let home;

function gitRepo(name, url = `https://github.com/example/${name}.git`) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', url]]) {
    const r = spawnSync('git', args, { cwd: d, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  return fs.realpathSync(d);
}

let seq = 0;
const rec = (type, content) => JSON.stringify({ type, message: { role: type, content } });
const toolUse = (name, input) => { seq += 1; return { id: `t${seq}`, line: rec('assistant', [{ type: 'tool_use', id: `t${seq}`, name, input }]) }; };
const toolResult = (id, text, isError = false) => rec('user', [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }]);
const edit = () => { const u = toolUse('Edit', { file_path: '/repo/src/updater.mjs' }); return [u.line, toolResult(u.id, 'ok')]; };
const bash = (command, out = 'Tests  5 passed (5)', isError = false) => { const u = toolUse('Bash', { command }); return [u.line, toolResult(u.id, out, isError)]; };

function transcript(...steps) {
  const file = path.join(dir, `t-${Math.random().toString(16).slice(2)}.jsonl`);
  fs.writeFileSync(file, [rec('user', 'please fix the updater'), ...steps.flat()].join('\n') + '\n');
  return file;
}

let promptSeq = 0;
function fire(cwd, message, { transcriptPath, stopHookActive = false, host = 'claude', session = 's1', promiseCapture = '', promptId = `p${++promptSeq}` } = {}) {
  const r = spawnSync(process.execPath, [GATE], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'Stop', cwd, session_id: session, stop_hook_active: stopHookActive,
      ...(promptId ? (host === 'codex' ? { turn_id: promptId } : { prompt_id: promptId }) : {}), last_assistant_message: message, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }),
    env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_HOOK_HOST: host,
      RUVNET_WORK_LEDGER: path.join(home, 'ledger.json'),
      RUVNET_PROMISE_CAPTURE: promiseCapture,
      RUVNET_OPEN_ISSUES_FILE: path.join(home, 'none.json'), RUVNET_CI_STATUS_FILE: path.join(home, 'none.json'),
      RUVNET_CAPABILITY_ROOTS: path.join(home, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(home, 'live.jsonl'),
      RUVNET_EVIDENCE_FILE: path.join(home, 'ev.jsonl'), RUVNET_CONTINUATION_COOLDOWN_MS: '1' },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  lastStderr = r.stderr;
  return r.stdout;
}
let lastStderr = '';
const ledger = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'ledger.json'), 'utf8')); } catch { return { items: [] }; } };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-completion-'));
  home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'caps'), { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const GOOD = 'The updater is fixed.\n\nVerified: `npx vitest run tests/unit/updater.test.mjs` — 5 passed after the edit.\nNot verified: the native host path.';

describe('completion claims (Piece A)', () => {
  it('blocks a completion claim when no check ran this turn', () => {
    const repo = gitRepo('a');
    const out = fire(repo, GOOD, { transcriptPath: transcript(edit()) });
    expect(out).toContain('claims completion beyond the available verified scope');
    expect(out).toContain('no end-to-end check ran this turn after the last change');
    expect(out).toContain('restate it as UNVERIFIED');
  });

  it('blocks when the only check ran BEFORE the last edit', () => {
    const repo = gitRepo('a');
    const out = fire(repo, GOOD, { transcriptPath: transcript(bash('npx vitest run'), edit()) });
    expect(out).toContain('no end-to-end check ran this turn after the last change');
  });

  it('#425: a scope-only UNKNOWN (post-edit check named, gaps disclosed) is reported, not blocked, and stays UNKNOWN', () => {
    const repo = gitRepo('a');
    const t = transcript(edit(), bash('npx vitest run tests/unit/updater.test.mjs'));
    expect(fire(repo, GOOD, { transcriptPath: t })).toBe('');
    const advisory = JSON.parse(lastStderr.trim().split('\n').find((l) => l.includes('completion-scope-advisory')));
    expect(advisory).toMatchObject({ kind: 'completion-scope-advisory', authority: false, verdict: 'UNKNOWN' });
    expect(advisory.text).toContain('completion stays UNKNOWN');
    const turn = claudeTurnEvents(readSettledTranscript(t, { maxMs: 0 }));
    expect(auditCompletionClaims(GOOD, { turn }).verdict).toBe('UNKNOWN');
    // The reporter's scoped task statement: same named-check/disclosure lines, same non-blocking result.
    const scoped = 'The five listed recovery tasks are complete at their documented local scope.\nVerified: `npx vitest run tests/unit/updater.test.mjs` — 5 passed.\nNot verified: the browser path.';
    expect(auditCompletionClaims(scoped, { turn }).verdict).toBe('UNKNOWN');
    expect(fire(repo, scoped, { transcriptPath: t })).toBe('');
    // Every other UNKNOWN/FAIL still blocks: no check after the change, or no disclosure.
    expect(fire(repo, scoped, { transcriptPath: transcript(edit()) })).toContain('beyond the available verified scope');
    expect(fire(repo, 'The five listed recovery tasks are complete.', { transcriptPath: t })).toContain('does not disclose what is NOT verified');
  });

  it('blocks when the check ran but the answer neither names it nor discloses gaps', () => {
    const repo = gitRepo('a');
    const out = fire(repo, 'The updater is fixed.', { transcriptPath: transcript(edit(), bash('npx vitest run')) });
    expect(out).toContain('does not name the check');
    expect(out).toContain('does not disclose what is NOT verified');
  });

  it('a failing check or a trivial read is not verification', () => {
    const repo = gitRepo('a');
    expect(fire(repo, GOOD, { transcriptPath: transcript(edit(), bash('npx vitest run', 'FAIL 1', true)) })).toContain('no end-to-end check');
    expect(fire(repo, GOOD, { transcriptPath: transcript(edit(), bash('cat src/updater.mjs')) })).toContain('no end-to-end check');
    expect(fire(repo, GOOD, { transcriptPath: transcript(edit(), bash('npx vitest run && git push origin main')) })).toContain('git push origin main');
  });

  it('allows negated, quoted, question, fenced and disclosure sentences', () => {
    const repo = gitRepo('a');
    const t = transcript(edit());
    for (const message of ['The updater is not fixed yet.', 'The log line said "fixed" but that was the old run.',
      'Is the updater fixed?', '```\nDone.\n```', 'UNVERIFIED: the updater change is live on my machine only.',
      '> Fixed.\n\nThat was your quote.', 'I cannot say it is done.']) {
      expect(fire(repo, message, { transcriptPath: t }), message).toBe('');
    }
  });

  it('never requests on a continued stop, and fails open on an unreadable transcript', () => {
    const repo = gitRepo('a');
    expect(fire(repo, GOOD, { transcriptPath: transcript(edit()), stopHookActive: true })).toBe('');
    const dirAsTranscript = path.join(dir, 'broken.jsonl');
    fs.mkdirSync(dirAsTranscript);
    expect(fire(repo, GOOD, { transcriptPath: dirAsTranscript })).toContain('UNKNOWN');
  });

  it('rejects a non-regular transcript even when its stat size is zero on Windows', () => {
    const file = transcript();
    const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ size: 0, isFile: () => false });
    try {
      expect(() => readSettledTranscript(file, { maxMs: 0 })).toThrow(/regular file/);
      const directory = path.join(dir, 'changed.jsonl'); fs.mkdirSync(directory);
      stat.mockReturnValue({ size: 0, isFile: () => true });
      expect(() => readSettledTranscript(directory, { maxMs: 0 })).toThrow(/regular file/);
    } finally { stat.mockRestore(); }
  });

  it('keeps missing transcripts unknown and accepts a real empty regular transcript', () => {
    const repo = gitRepo('a');
    expect(fire(repo, GOOD, { transcriptPath: path.join(dir, 'missing.jsonl') })).toContain('UNKNOWN');
    const file = path.join(dir, 'empty.jsonl'); fs.writeFileSync(file, '');
    expect(readSettledTranscript(file, { maxMs: 0 })).toEqual(['']);
    expect(fire(repo, GOOD, { transcriptPath: file })).toContain('no end-to-end check');
  });

  it('on Codex enforces the answer-side half and discloses that the transcript half is UNKNOWN', () => {
    const repo = gitRepo('a');
    const out = fire(repo, 'The updater is fixed.', { host: 'codex' });
    expect(out).toContain('(codex) transcript is unavailable or not parsed');
    expect(fire(repo, GOOD, { host: 'codex' })).toContain('UNKNOWN');
  });

  it('reaches Codex through the real adapter as decision:block with the correction as reason', () => {
    const repo = gitRepo('a');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin/scripts/codex-hook-adapter.mjs'), 'continuation-gate'], {
      cwd: repo,
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: repo, session_id: 'cx1', turn_id: 't1', stop_hook_active: false,
        last_assistant_message: 'The updater is fixed.' }),
      env: { ...process.env, HOME: home, USERPROFILE: home, PLUGIN_ROOT: path.join(ROOT, 'plugin'),
        RUVNET_WORK_LEDGER: path.join(home, 'ledger.json'), RUVNET_OPEN_ISSUES_FILE: path.join(home, 'none.json'),
        RUVNET_CI_STATUS_FILE: path.join(home, 'none.json'), RUVNET_CAPABILITY_ROOTS: path.join(home, 'caps'),
        RUVNET_CONTINUATION_COOLDOWN_MS: '1' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('beyond the available verified scope');
  });

  it('BREAK-IT: with the detector removed, the unverified claim is no longer blocked', () => {
    const copy = path.join(dir, 'mutant');
    fs.cpSync(path.join(ROOT, 'plugin/scripts'), copy, { recursive: true });
    const file = path.join(copy, 'completion-claim-evidence.mjs');
    const src = fs.readFileSync(file, 'utf8');
    const mutated = src.replace('export function extractCompletionClaims(message) {', 'export function extractCompletionClaims(message) {\n  return [];');
    expect(mutated).not.toBe(src);
    fs.writeFileSync(file, mutated);
    const repo = gitRepo('a');
    const input = JSON.stringify({ hook_event_name: 'Stop', cwd: repo, session_id: 's1', stop_hook_active: false,
      last_assistant_message: GOOD, transcript_path: transcript(edit()) });
    const env = { ...process.env, HOME: home, RUVNET_HOOK_HOST: 'claude', RUVNET_WORK_LEDGER: path.join(home, 'ledger.json'),
      RUVNET_OPEN_ISSUES_FILE: path.join(home, 'none.json'), RUVNET_CAPABILITY_ROOTS: path.join(home, 'caps'), RUVNET_CONTINUATION_COOLDOWN_MS: '1' };
    const mutant = spawnSync(process.execPath, [path.join(copy, 'continuation-gate.mjs')], { cwd: repo, input, env, encoding: 'utf8' });
    const real = spawnSync(process.execPath, [GATE], { cwd: repo, input, env, encoding: 'utf8' });
    expect(real.stdout).toContain('beyond the available verified scope');
    expect(mutant.stdout).toBe('');
  });

  it('allows an accurate targeted-check statement without claiming the whole task is complete', () => {
    const repo = gitRepo('a'); const message = 'Targeted unit tests are passing.\nVerified: npx vitest run tests/unit/updater.test.mjs — 5 passed.\nNot verified: the complete consumer path.';
    const t = transcript(edit(), bash('npx vitest run tests/unit/updater.test.mjs'));
    expect(fire(repo, message, { transcriptPath: t })).toBe('');
    const turn = claudeTurnEvents(readSettledTranscript(t, { maxMs: 0 }));
    expect(auditCompletionClaims(message, { turn }).verdict).toBe('OBSERVED_CHECK');
    expect(fire(repo, 'Hello. Five targeted tests passed; the task remains unverified.', { host: 'codex' })).toBe('');
  });
  it('one observed check cannot excuse a broad completion assertion in the same sentence', () => {
    const turn = claudeTurnEvents([rec('user', 'go'), ...edit(), ...bash('npx vitest run tests/unit/updater.test.mjs')]);
    for (const assertion of ['the updater is fixed', 'it now works', 'it will now work']) {
      expect(auditCompletionClaims(`Targeted unit tests are passing, so ${assertion}.\nVerified: vitest.\nNot verified: Windows.`, { turn }).verdict).toBe('UNKNOWN');
    }
  });

  // A fresh install has no ~/.config/ruvnet-brain/work-ledgers/ until the first promise is saved.
  // The cooldown lock lives in that folder, so the gate must create it rather than read ENOENT as
  // "lost the race" and drop the correction in silence. Default ledger path on purpose (no override).
  const freshEnv = (h) => ({ ...process.env, HOME: h, USERPROFILE: h, RUVNET_WORK_LEDGER: '', RUVNET_HOOK_HOST: 'claude', RUVNET_PROMISE_CAPTURE: '',
    RUVNET_OPEN_ISSUES_FILE: path.join(h, 'none.json'), RUVNET_CI_STATUS_FILE: path.join(h, 'none.json'),
    RUVNET_CAPABILITY_ROOTS: path.join(h, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(h, 'live.jsonl'),
    RUVNET_EVIDENCE_FILE: path.join(h, 'ev.jsonl'), RUVNET_CONTINUATION_COOLDOWN_MS: '1' });
  const ledgerDir = (h) => path.join(h, '.config', 'ruvnet-brain', 'work-ledgers');

  it('a fresh HOME with no work-ledgers folder still gets the correction', () => {
    const repo = gitRepo('a');
    expect(fs.existsSync(ledgerDir(home))).toBe(false);
    const input = JSON.stringify({ hook_event_name: 'Stop', cwd: repo, session_id: 's1', stop_hook_active: false,
      last_assistant_message: 'I fixed the config file.', transcript_path: transcript(edit()) });
    const r = spawnSync(process.execPath, [GATE], { cwd: repo, input, env: freshEnv(home), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('claims completion beyond the available verified scope');
    expect(fs.readdirSync(ledgerDir(home)).some((f) => f.includes('.cooldown.'))).toBe(true);
  });

  it('BREAK-IT: without the cooldown mkdir, a fresh HOME drops the correction in silence', () => {
    const copy = path.join(dir, 'mutant');
    fs.cpSync(path.join(ROOT, 'plugin/scripts'), copy, { recursive: true });
    const file = path.join(copy, 'continuation-gate.mjs');
    const src = fs.readFileSync(file, 'utf8');
    const mutated = src.replace('fs.mkdirSync(path.dirname(LOCK), { recursive: true }); ', '');
    expect(mutated).not.toBe(src);
    fs.writeFileSync(file, mutated);
    const repo = gitRepo('a');
    const input = JSON.stringify({ hook_event_name: 'Stop', cwd: repo, session_id: 's1', stop_hook_active: false,
      last_assistant_message: 'I fixed the config file.', transcript_path: transcript(edit()) });
    const mutant = spawnSync(process.execPath, [file], { cwd: repo, input, env: freshEnv(home), encoding: 'utf8' });
    expect(mutant.status).toBe(0);
    expect(mutant.stdout).toBe('');
    expect(fs.existsSync(ledgerDir(home))).toBe(false);
    // Same mutant, same input, folder pre-created: the correction comes back, so the missing folder is the cause.
    fs.mkdirSync(ledgerDir(home), { recursive: true });
    const withDir = spawnSync(process.execPath, [file], { cwd: repo, input, env: freshEnv(home), encoding: 'utf8' });
    expect(withDir.status).toBe(0);
    expect(withDir.stdout).toContain('claims completion beyond the available verified scope');
  });

  it('detector unit cases', () => {
    expect(extractCompletionClaims('Done. The gate is now live.').length).toBe(2);
    expect(extractCompletionClaims("I'll run the baseline as soon as the set is complete.")).toEqual([]);
    expect(extractCompletionClaims("ADR-272's published calibration table made that the suspect.")).toEqual([]);
    expect(extractCompletionClaims('Free space fell while I was working.')).toEqual([]);
    const turn = claudeTurnEvents([rec('user', 'go'), ...edit(), ...bash('npm run hooks:check', 'PASS')]);
    expect(auditCompletionClaims('Hooks are wired. hooks:check passed; not verified on Codex.', { turn }).verdict).toBe('UNKNOWN');
  });
});

describe('promises (Piece C)', () => {
  const PROMISE = 'Next I\'ll add the retry test to the updater.';

  it('a FAIL completion verdict preserves the promise without completion evidence', () => {
    const repo = gitRepo('failed-completion');
    fire(repo, PROMISE, { transcriptPath: transcript() });
    const message = 'The updater retry test is fixed.';
    const t = transcript(edit(), bash('npx vitest run tests/unit/updater.test.mjs', 'FAIL 1', true));
    const turn = claudeTurnEvents(readSettledTranscript(t, { maxMs: 0 }));
    expect(auditCompletionClaims(message, { turn }).verdict).toBe('FAIL');
    const original = ledger().items.find((i) => i.kind === 'assistant-commitment');
    fire(repo, message, { transcriptPath: t, stopHookActive: true });
    const item = ledger().items.find((i) => i.kind === 'assistant-commitment');
    expect(item).toEqual(original);
    expect(item).toMatchObject({ done: false, state: 'active' });
    expect(item.completionEvidence).toBeUndefined();
  });

  it('owner opt-out stops new capture, including continued stops, and toggles back on', () => {
    const repo = gitRepo('a');
    for (const stopHookActive of [false, true]) {
      expect(fire(repo, 'I will ask again before the first push.', {
        transcriptPath: transcript(), stopHookActive, promiseCapture: 'off',
      })).toBe('');
    }
    expect(ledger().items).toEqual([]);
    expect(fire(repo, PROMISE, { transcriptPath: transcript(), promiseCapture: 'on' })).toContain('you said you would');
    expect(ledger().items.filter((i) => i.kind === 'assistant-commitment')).toHaveLength(1);
  });

  it('opt-out keeps existing promises forceable and closes them only with verified evidence', () => {
    const repo = gitRepo('a');
    fire(repo, PROMISE, { transcriptPath: transcript() });
    expect(fire(repo, 'Here is the summary.', { transcriptPath: transcript(), promiseCapture: 'off' })).toContain('you said you would');
    const claim = 'The updater retry test is now passing.';
    expect(fire(repo, claim, { transcriptPath: transcript(edit()), promiseCapture: 'off' })).toContain('beyond the available verified scope');
    expect(ledger().items.find((i) => i.kind === 'assistant-commitment').done).toBe(false);
    fire(repo, `${claim}\nVerified: npx vitest run — 5 passed.\nNot verified: Windows.\nI will fix the parser.`,
      { transcriptPath: transcript(edit(), bash('npx vitest run tests/unit/updater.test.mjs')), promiseCapture: 'off' });
    expect(ledger().items.filter((i) => i.kind === 'assistant-commitment')).toHaveLength(1);
    expect(ledger().items[0].done).toBe(false);
    expect(ledger().items[0].completionEvidence).toBeUndefined();
  });

  it('only the documented off value suppresses capture', () => {
    const repo = gitRepo('a');
    expect(fire(repo, PROMISE, { transcriptPath: transcript(), promiseCapture: 'invalid' })).toContain('you said you would');
    expect(ledger().items.filter((i) => i.kind === 'assistant-commitment')).toHaveLength(1);
  });

  it('captures a first-person commitment into the project ledger and forces on it', () => {
    const repo = gitRepo('a');
    const out = fire(repo, PROMISE, { transcriptPath: transcript() });
    const items = ledger().items.filter((i) => i.kind === 'assistant-commitment');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: 'add the retry test to the updater', done: false, sessionIds: ['s1'] });
    expect(out).toContain('you said you would: add the retry test to the updater');
  });

  it('ignores hedged, conditional, offered, questioned and quoted commitments', () => {
    const repo = gitRepo('a');
    for (const message of ["If you want, I'll add the retry test.", 'I might add the retry test later.',
      "Should I add the retry test? I'll wait for your call.", 'Once CI is green I\'ll add the retry test.',
      'You said "I\'ll add the retry test".', "I'll not add the retry test without approval.", "I'll be honest about it."]) {
      fire(repo, message, { transcriptPath: transcript() });
    }
    expect(ledger().items.filter((i) => i.kind === 'assistant-commitment')).toEqual([]);
    expect(extractCommitments('My plan:\n1. add the retry test\n2. wire the alert\n')).toHaveLength(2);
  });

  it('dedupes by normalized text and caps captures per turn', () => {
    const repo = gitRepo('a');
    fire(repo, PROMISE, { transcriptPath: transcript() });
    fire(repo, 'Next I will add the retry test to the updater!', { transcriptPath: transcript(), stopHookActive: true });
    expect(ledger().items.filter((i) => i.kind === 'assistant-commitment')).toHaveLength(1);
    fire(repo, "I'll fix the parser. I'll wire the alert. I'll write the docs. I'll rotate the key. I'll ship the patch.", { transcriptPath: transcript() });
    expect(ledger().items.filter((i) => i.kind === 'assistant-commitment')).toHaveLength(4);
  });

  it('closes ONLY with verification evidence — never by --done or by an unverified claim', () => {
    const repo = gitRepo('a');
    fire(repo, PROMISE, { transcriptPath: transcript() });
    const done = spawnSync(process.execPath, [GATE, '--done', 'add the retry test to the updater'], {
      cwd: repo, env: { ...process.env, HOME: home, RUVNET_WORK_LEDGER: path.join(home, 'ledger.json') }, encoding: 'utf8' });
    expect(done.status).toBe(2);
    const claim = 'The updater retry test is now passing.';
    fire(repo, claim, { transcriptPath: transcript(edit()) });
    expect(ledger().items.find((i) => i.kind === 'assistant-commitment').done).toBe(false);
    fire(repo, `${claim}\nVerified: npx vitest run — 5 passed.\nNot verified: Windows.`,
      { transcriptPath: transcript(edit(), bash('npx vitest run tests/unit/updater.test.mjs')) });
    const item = ledger().items.find((i) => i.kind === 'assistant-commitment');
    expect(item.done).toBe(false);
    expect(item.completionEvidence).toBeUndefined();
  });

  it('a promise with no verified closure is forced a bounded number of times, then retained as deferred', () => {
    const repo = gitRepo('a');
    fire(repo, PROMISE, { transcriptPath: transcript() });
    // The first stop after capture may itself force; count forces over later stops.
    const outs = [1, 2, 3, 4, 5, 6].map((n) => fire(repo, `Here is summary ${n}.`, { transcriptPath: transcript() }));
    expect(outs.filter((o) => o.includes('you said you would')).length).toBeLessThanOrEqual(3);
    expect(outs[outs.length - 1]).toBe('');
    const item = ledger().items.find((i) => i.kind === 'assistant-commitment');
    expect(item).toMatchObject({ done: false, state: 'deferred' });
    expect(item.stateReason).toContain('retained, not completed');
    expect(item.completionEvidence).toBeUndefined();
  });

  it('a promise captured in one repository never forces in another', () => {
    const a = gitRepo('a');
    const b = gitRepo('b', 'https://github.com/someone-else/unrelated.git');
    fire(a, PROMISE, { transcriptPath: transcript() });
    expect(fire(b, 'Here is the summary you asked for.', { transcriptPath: transcript() })).toBe('');
    expect(fire(a, 'Here is the summary you asked for.', { transcriptPath: transcript() })).toContain('you said you would');
  });

  it('is not captured or forced on Codex, where it could never be closed', () => {
    const repo = gitRepo('a');
    expect(fire(repo, PROMISE, { host: 'codex' })).toBe('');
    expect(ledger().items).toEqual([]);
  });
});

describe('#425 a completion correction is delivered once per session + turn + category', () => {
  const CLAIM = 'The updater is fixed.';
  it('the same category twice in one turn blocks once; rewording does not rearm it; a new turn does', () => {
    const repo = gitRepo('a');
    expect(fire(repo, CLAIM, { promptId: 'turn-1' })).toContain('beyond the available verified scope');
    expect(fire(repo, CLAIM, { promptId: 'turn-1' })).toBe('');
    expect(fire(repo, 'The updater is now fully fixed.', { promptId: 'turn-1' })).toBe('');
    expect(fire(repo, CLAIM, { promptId: 'turn-1', session: 's2' })).toContain('beyond the available verified scope');
    expect(fire(repo, CLAIM, { promptId: 'turn-2' })).toContain('beyond the available verified scope');
  });
  it('without a native id the transcript prompt is the turn identity', () => {
    const repo = gitRepo('a');
    const t = transcript();
    expect(fire(repo, CLAIM, { promptId: null, transcriptPath: t })).toContain('beyond the available verified scope');
    expect(fire(repo, CLAIM, { promptId: null, transcriptPath: t })).toBe('');
  });
  it('without a native id a REPEATED prompt text is a new turn: the opening record, not the words, is the identity', () => {
    const repo = gitRepo('a');
    const t = transcript();
    expect(fire(repo, CLAIM, { promptId: null, transcriptPath: t })).toContain('beyond the available verified scope');
    expect(fire(repo, CLAIM, { promptId: null, transcriptPath: t })).toBe('');
    // the user sends the SAME words again ("please fix the updater"): a new turn, so its correction is delivered
    fs.appendFileSync(t, [rec('assistant', [{ type: 'text', text: CLAIM }]), rec('user', 'please fix the updater')].join('\n') + '\n');
    expect(fire(repo, CLAIM, { promptId: null, transcriptPath: t })).toContain('beyond the available verified scope');
    expect(fire(repo, CLAIM, { promptId: null, transcriptPath: t })).toBe('');
  });
  it('a different audit category in the same turn is still delivered', () => {
    const repo = gitRepo('a');
    expect(fire(repo, CLAIM, { promptId: 'turn-1' })).toContain('beyond the available verified scope');
    const named = 'The updater is fixed.\nVerified: `npx vitest run tests/unit/updater.test.mjs` — 5 passed.\nNot verified: host.';
    expect(fire(repo, named, { promptId: 'turn-1', transcriptPath: transcript(edit()) })).toContain('beyond the available verified scope');
  });
  it('with no turn identity at all it degrades to an advisory carrying the original verdict, never a block', () => {
    const repo = gitRepo('a');
    expect(fire(repo, CLAIM, { promptId: null })).toBe('');
    const adv = JSON.parse(lastStderr.trim().split('\n').find((l) => l.includes('completion-correction-advisory')));
    expect(adv).toMatchObject({ authority: false, verdict: 'FAIL' });
    expect(adv.reason).toContain('turn identity');
    expect(JSON.stringify(adv)).not.toContain('"PASS"');
  });
});

describe('#425 per-claim outcomes (evidence per outcome, never authority)', () => {
  const CMD = 'npx vitest run tests/unit/updater.test.mjs';
  const FIVE = 'The five listed recovery tasks are complete at their documented local scope.';
  const ANSWER = `The updater retry is fixed (verified: ${CMD}).\n${FIVE}\nNot verified: browser.`;
  const audit = (message, ...steps) => auditCompletionClaims(message, { turn: claudeTurnEvents([rec('user', 'go'), ...steps.flat()]) });

  it('binds only the claim whose own sentence names a post-edit passing check; verdict stays UNKNOWN', () => {
    const r = audit(ANSWER, edit(), bash(CMD));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.outcomes.map((o) => o.state)).toEqual(['observed-check', 'unbound']);
    expect(r.outcomes[0].checks).toHaveLength(1);
    expect(r.outcomes[0].checks[0].command).toBe(CMD);
    expect(r.outcomes.every((o) => o.authority === false)).toBe(true);
    expect(JSON.stringify(r)).not.toContain('"PASS"');
  });

  it('a check before the edit is stale, an unrelated command or a failing check never binds', () => {
    expect(audit(ANSWER, bash(CMD), edit()).outcomes[0].state).toBe('stale');
    expect(audit(ANSWER, edit(), bash('npm test')).outcomes[0].state).toBe('unbound');
    expect(audit(ANSWER, edit(), bash(CMD, 'FAIL 1', true)).outcomes[0].state).toBe('failed-check');
    expect(audit('The updater retry is fixed.\nNot verified: browser.', edit(), bash(CMD)).outcomes[0].state).toBe('unbound');
  });

  it('a line-start Verified: line can name the command; "Not verified:" never does', () => {
    expect(audit(`The updater retry is fixed.\nVerified: ${CMD} — 5 passed.\nNot verified: browser.`, edit(), bash(CMD)).outcomes[0].state).toBe('observed-check');
    expect(audit(`The updater retry is fixed.\nNot verified: ${CMD}.`, edit(), bash(CMD)).outcomes[0].state).toBe('unbound');
  });

  // #369/#425: the transcript reports the WHOLE command's exit status. A check is observed only when that
  // status is the check's own: one simple command or an `&&` chain. Everything else is `unbound`, with a reason.
  it.each([
    ['a pipe to tail', `${CMD} | tail -3`],
    ['an `|| true` fallback', `${CMD} || true`],
    ['a `;` sequence', `${CMD}; echo exit=$?`],
    ['a background `&`', `${CMD} &`],
    ['a command substitution', `echo $(${CMD})`],
    ['a subshell', `(${CMD})`],
    ['a file redirection', `${CMD} > out.log`],
    ['a second line', `${CMD}\ntail out.log`],
  ])('a check run with %s never binds (output claims success, status is not the check\'s)', (_, command) => {
    const answer = `The updater retry is fixed (verified: ${CMD}).\nNot verified: browser.`;
    const r = audit(answer, edit(), bash(command, 'FAIL 3 failed'));
    expect(r.outcomes[0].state).toBe('unbound');
    expect(r.outcomes[0].checks).toEqual([]);
    if (!/^echo|> out\.log/.test(command)) expect(r.outcomes[0].reason).toMatch(/exit status is not this check/);
    expect(r.verification.checks).toEqual([]);
    expect(r.verdict).not.toBe('OBSERVED_CHECK');
  });

  it('a negated check (`! <cmd>`) flips a failure to success, so naming it still never binds or evidences', () => {
    const answer = `The updater retry is fixed.\nVerified: ! ${CMD}\nNot verified: browser.`;
    const r = audit(answer, edit(), bash(`! ${CMD}`, 'FAIL 3 failed'));
    expect(r.outcomes[0].state).toBe('unbound');
    expect(r.outcomes[0].reason).toMatch(/negated exit status/);
    expect(r.verification.checks).toEqual([]);
    expect(r.verdict).not.toBe('OBSERVED_CHECK');
  });

  it('an environment prefix is part of the command: SKIP_HOOKS=1 <cmd> is not <cmd>, in either direction', () => {
    const answer = `The updater retry is fixed (verified: ${CMD}).\nNot verified: browser.`;
    expect(audit(answer, edit(), bash(`SKIP_HOOKS=1 ${CMD}`)).outcomes[0].state).toBe('unbound');
    const withEnv = `The updater retry is fixed (verified: SKIP_HOOKS=1 ${CMD}).\nNot verified: browser.`;
    expect(audit(withEnv, edit(), bash(CMD)).outcomes[0].state).toBe('unbound');
    expect(audit(withEnv, edit(), bash(`SKIP_HOOKS=1 ${CMD}`)).outcomes[0].state).toBe('observed-check');
  });

  it('a quoted operator is not an operator, and an `&&` chain binds only through its own exit status', () => {
    const q = 'npm run check -- --grep "a|b;c"';
    const answer = (c) => `The updater retry is fixed (verified: ${c}).\nNot verified: browser.`;
    expect(audit(answer(q), edit(), bash(q)).outcomes[0].state).toBe('observed-check');
    const chain = `cd tests && ${CMD}`;
    expect(audit(answer(CMD), edit(), bash(chain)).outcomes[0].state).toBe('observed-check');
    expect(audit(answer(CMD), edit(), bash(chain, 'FAIL', true)).outcomes[0].state).toBe('failed-check');
    expect(audit(answer(CMD), edit(), bash(`${CMD} 2>&1`)).outcomes[0].state).toBe('observed-check');
  });

  it('through the gate: nothing on stdout, exactly one advisory listing outcomes, ledger byte-identical', () => {
    const repo = gitRepo('a');
    const before = fs.existsSync(path.join(home, 'ledger.json')) ? fs.readFileSync(path.join(home, 'ledger.json')) : null;
    expect(fire(repo, ANSWER, { transcriptPath: transcript(edit(), bash(CMD)) })).toBe('');
    const advisories = lastStderr.trim().split('\n').filter((l) => l.includes('advisory'));
    expect(advisories).toHaveLength(1);
    const adv = JSON.parse(advisories[0]);
    expect(adv).toMatchObject({ authority: false, verdict: 'UNKNOWN' });
    expect(adv.outcomes.map((o) => o.state)).toEqual(['observed-check', 'unbound']);
    expect(adv.text).toContain('unbound');
    const after = fs.existsSync(path.join(home, 'ledger.json')) ? fs.readFileSync(path.join(home, 'ledger.json')) : null;
    expect(after).toEqual(before);
  });

  it('when checks ran but the verdict is still FAIL, the correction asks for an outcome-by-outcome report', () => {
    const repo = gitRepo('a');
    const out = fire(repo, 'The five listed recovery tasks are complete.', { transcriptPath: transcript(edit(), bash(CMD)) });
    expect(out).toContain('report outcome by outcome');
    expect(out).not.toContain('Run the real consumer path');
    expect(fire(repo, GOOD, { transcriptPath: transcript(edit()) })).toContain('Run the real consumer path');
  });
});

describe('masked/compound checks: a check ran, its exit status is not attributable (never "no check ran")', () => {
  const CMD = 'npx vitest run tests/unit/updater.test.mjs';
  const ANS = `The updater is fixed.\n\nVerified: \`${CMD}\` — 5 passed after the edit.\nNot verified: the native host path.`;
  const audit = (message, ...steps) => auditCompletionClaims(message, { turn: claudeTurnEvents([rec('user', 'go'), ...steps.flat()]) });

  it.each([
    ['a pipe to tail', `${CMD} 2>&1 | tail -20`],
    ['a redirect to a log', `${CMD} > /tmp/run.log 2>&1`],
    ['an || fallback', `${CMD} || true`],
    ['a ; sequence', `${CMD}; echo done`],
  ])('through the real Stop gate: %s is a non-blocking advisory that does not claim no check ran', (_, command) => {
    const repo = gitRepo('a');
    const t = transcript(edit(), bash(command));
    expect(fire(repo, ANS, { transcriptPath: t })).toBe('');
    const adv = JSON.parse(lastStderr.trim().split('\n').find((l) => l.includes('completion-scope-advisory')));
    expect(adv).toMatchObject({ authority: false, verdict: 'UNKNOWN' });
    expect(adv.text).toContain('not attributable');
    expect(adv.text).toContain('completion stays UNKNOWN');
    expect(lastStderr).not.toContain('no end-to-end check ran');
    const r = audit(ANS, edit(), bash(command));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.problems.join(' ')).not.toContain('no end-to-end check ran');
    expect(r.verification.checks).toEqual([]);
    expect(r.verification.maskedChecks).toHaveLength(1);
  });

  // Round-2 gate must-fix: the answer names the masked check INLINE (not on a line-start `Verified:` line).
  // `names` was built from strict checks only, so this read "does not name the check" and BLOCKED, where 4.7.21 advised.
  it.each([
    ['a pipe to tail', `${CMD} 2>&1 | tail -20`],
    ['a redirect to a tmp log', `${CMD} > /tmp/run.log 2>&1`],
    ['an || fallback', `${CMD} || true`],
    ['a ; sequence', `${CMD}; echo done`],
    ['a short tail', `${CMD} | tail -3`],
  ])('inline-naming answer, %s: real Stop gate under full nudges is a non-blocking advisory, verdict UNKNOWN', (_, command) => {
    const repo = gitRepo('a');
    const INLINE = `The updater is fixed (I ran ${CMD}, 5 passed). Not verified: the native host path.`;
    const t = transcript(edit(), bash(command));
    const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_HOOK_HOST: 'claude', RUVNET_STOP_NUDGES: 'full',
      RUVNET_WORK_LEDGER: path.join(home, 'ledger.json'), RUVNET_PROMISE_CAPTURE: '',
      RUVNET_OPEN_ISSUES_FILE: path.join(home, 'none.json'), RUVNET_CI_STATUS_FILE: path.join(home, 'none.json'),
      RUVNET_CAPABILITY_ROOTS: path.join(home, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(home, 'live.jsonl'),
      RUVNET_EVIDENCE_FILE: path.join(home, 'ev.jsonl'), RUVNET_CONTINUATION_COOLDOWN_MS: '1' };
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const run = spawnSync(process.execPath, [GATE], { cwd: repo, encoding: 'utf8', env,
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: repo, session_id: 's-inline', stop_hook_active: false, prompt_id: `inl${++promptSeq}`,
        last_assistant_message: INLINE, transcript_path: t }) });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');                                   // not blocked
    expect(run.stderr).not.toContain('no end-to-end check ran');
    expect(run.stderr).not.toContain('does not name the check');
    const adv = JSON.parse(run.stderr.trim().split('\n').find((l) => l.includes('completion-scope-advisory')));
    expect(adv).toMatchObject({ authority: false, verdict: 'UNKNOWN' });
    expect(adv.text).toContain('not attributable');
    const r = audit(INLINE, edit(), bash(command));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.verification.checks).toEqual([]);                      // masked-only can never reach OBSERVED_CHECK
    expect(r.outcomes.every((o) => o.state !== 'observed-check')).toBe(true);
    expect(promiseEvidence(r, INLINE, { text: 'fix the updater', evidenceCommands: [CMD] })).toBeNull();
  });

  it('inline naming with NO check at all, or an errored masked check, still FAILs (naming never substitutes for a run)', () => {
    const INLINE = `The updater is fixed (I ran ${CMD}, 5 passed). Not verified: the native host path.`;
    expect(audit(INLINE, edit()).problems.join(' ')).toContain('no end-to-end check ran');
    expect(audit(INLINE, edit(), bash(`${CMD} | tail -3`, 'boom', true)).problems.join(' ')).toContain('no end-to-end check ran');
    expect(audit(INLINE, edit()).verdict).not.toBe('OBSERVED_CHECK');
  });

  it('no check at all still blocks with the true statement; a masked check without naming/disclosure is still a FAIL', () => {
    const repo = gitRepo('a');
    expect(fire(repo, ANS, { transcriptPath: transcript(edit()) })).toContain('no end-to-end check ran this turn');
    expect(audit('The updater is fixed.', edit(), bash(`${CMD} | tail -3`)).verdict).toBe('FAIL');
  });

  it('a masked check that errored (or has no output) is not even "a check ran"', () => {
    expect(audit(ANS, edit(), bash(`${CMD} | tail -3`, 'boom', true)).problems.join(' ')).toContain('no end-to-end check ran');
  });

  it.each([
    ['|| true', `${CMD} || true`],
    ['; echo', `${CMD}; echo ok`],
    ['| tail -3 after FAIL output', `${CMD} | tail -3`],
    ['an env prefix', `SKIP_HOOKS=1 ${CMD}`],
    ['a negated exit status (! flips a failure to success)', `! ${CMD}`],
  ])('strictness kept: %s never evidences a promise nor binds an outcome', (_, command) => {
    const answer = `The updater retry is fixed (verified: ${CMD}).\nNot verified: browser.`;
    const r = audit(answer, edit(), bash(command, 'FAIL 3 failed'));
    expect(r.outcomes[0].state).toBe('unbound');
    const item = { text: 'fix the updater retry', evidenceCommands: [CMD] };
    expect(promiseEvidence(r, answer, item)).toBeNull();
  });
});

