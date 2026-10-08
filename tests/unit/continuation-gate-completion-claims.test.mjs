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
  extractCompletionClaims, extractCommitments, auditCompletionClaims, claudeTurnEvents,
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

function fire(cwd, message, { transcriptPath, stopHookActive = false, host = 'claude', session = 's1', promiseCapture = '' } = {}) {
  const r = spawnSync(process.execPath, [GATE], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'Stop', cwd, session_id: session, stop_hook_active: stopHookActive,
      last_assistant_message: message, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }),
    env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_HOOK_HOST: host,
      RUVNET_WORK_LEDGER: path.join(home, 'ledger.json'),
      RUVNET_PROMISE_CAPTURE: promiseCapture,
      RUVNET_OPEN_ISSUES_FILE: path.join(home, 'none.json'), RUVNET_CI_STATUS_FILE: path.join(home, 'none.json'),
      RUVNET_CAPABILITY_ROOTS: path.join(home, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(home, 'live.jsonl'),
      RUVNET_EVIDENCE_FILE: path.join(home, 'ev.jsonl'), RUVNET_CONTINUATION_COOLDOWN_MS: '1' },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return r.stdout;
}
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

  it('allows a claim with a post-edit check that the answer names and a NOT-verified disclosure', () => {
    const repo = gitRepo('a');
    expect(fire(repo, GOOD, { transcriptPath: transcript(edit(), bash('npx vitest run tests/unit/updater.test.mjs')) })).toContain('whole-task completion is UNKNOWN');
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
