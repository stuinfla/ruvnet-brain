// injection-budget.test.mjs — ground-ruvnet.sh sends each long block once per session, holds a per-prompt
// byte budget, and never drops a safety line (4.5, HOOK LOAD).
//
// Measured before the change on the owner's token ledger (2,736 prompts): mean 1.7 KB and up to 5.5 KB per
// prompt, the same blocks re-sent prompt after prompt. A 12-prompt scripted session through every
// registered SessionStart + UserPromptSubmit hook went from 34.9 KB to 13.3 KB (mean 2.8 KB -> 1.0 KB per
// prompt). These tests pin the contract that produced that, at the process boundary.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetInjectionDedupe } from '../../plugin/scripts/session-start-core.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../plugin/scripts/ground-ruvnet.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

function world({ adr = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-'));
  const home = path.join(dir, 'home'); const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  if (adr) fs.mkdirSync(path.join(cwd, 'docs', 'adr'), { recursive: true });
  return { dir, home, cwd, brainHome: path.join(home, '.cache', 'ruvnet-brain') };
}
function prompt(w, text, { sid = 's1', env = {} } = {}) {
  const payload = { hook_event_name: 'UserPromptSubmit', prompt: text, ...(sid ? { session_id: sid } : {}) };
  const r = spawnSync('bash', [HOOK], { input: JSON.stringify(payload), cwd: w.cwd, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: w.home, RUVNET_BRAIN_HOME: w.brainHome, ...env } });
  return r.stdout || '';
}
const FULL_GROUND = 'If a needed RuvNet repo isn\'t covered yet';
const SHORT_GROUND = 'full rule given earlier this session';
const ledger = (w) => fs.readFileSync(path.join(w.home, '.cache', 'ruvnet-brain', 'token-ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe.skipIf(!hasBash || process.platform === 'win32')('ground-ruvnet — once-per-session dedupe and a per-prompt budget', () => {
  it('the ground block goes out in full once, then as ONE line that still carries the rule', () => {
    const w = world();
    const first = prompt(w, 'what is ruflo?');
    const second = prompt(w, 'and what does agentdb do?');
    expect(first).toContain(FULL_GROUND);
    expect(second).not.toContain(FULL_GROUND);
    expect(second).toContain('[RuvNet Brain — ground before you assert]');
    expect(second).toMatch(/MUST call `search_ruvnet`/);
    expect(second).toContain(SHORT_GROUND);
    expect(second.length).toBeLessThan(first.length / 2);
    expect(ledger(w).at(-1)).toMatchObject({ shortened: 1, deferred: 0 });
  });

  it('a different session gets the full block again', () => {
    const w = world();
    prompt(w, 'what is ruflo?', { sid: 'a' });
    expect(prompt(w, 'what is ruflo?', { sid: 'b' })).toContain(FULL_GROUND);
  });

  it('no session id = no dedupe and no budget (fails toward delivering, as before 4.5)', () => {
    const w = world();
    prompt(w, 'what is ruflo?', { sid: null });
    expect(prompt(w, 'what is ruflo?', { sid: null })).toContain(FULL_GROUND);
    // Without a session a deferred block would starve forever behind blocks never marked delivered.
    const r = prompt(w, 'add test coverage for the pinecone vector database adapter', { sid: null, env: { RUVNET_PROMPT_INJECTION_BUDGET: '1200' } });
    expect(r).toContain('reaching for a classical default');
    expect(r).toContain('testing/quality turn');
  });

  it('a SessionStart (compaction, resume, clear) resets it: the full text goes out once more', () => {
    const w = world();
    prompt(w, 'what is ruflo?');
    expect(prompt(w, 'what is ruflo?')).not.toContain(FULL_GROUND);
    resetInjectionDedupe(w.brainHome, Date.now() + 2000);   // a reset strictly newer than the markers
    const t = (Date.now() + 2000) / 1000; fs.utimesSync(path.join(w.brainHome, 'injected', '.reset'), t, t);
    expect(prompt(w, 'what is ruflo?')).toContain(FULL_GROUND);
  });

  it('the REAL SessionStart writes that reset (runSessionStart, not the helper)', async () => {
    const { runSessionStart } = await import('../../plugin/scripts/session-start-core.mjs');
    const w = world();
    prompt(w, 'what is ruflo?');
    const marker = path.join(w.brainHome, 'injected', 's1', 'ground');
    const past = (Date.now() - 10_000) / 1000; fs.utimesSync(marker, past, past);
    expect(prompt(w, 'what is ruflo?')).not.toContain(FULL_GROUND);
    fs.utimesSync(marker, past, past);
    await runSessionStart({ env: { HOME: w.home, RUVNET_BRAIN_HOME: w.brainHome, RUVNET_BRAIN_METER: '0' }, cwd: w.cwd,
      stdout: { write: () => true }, stderr: { write: () => true }, restoreContinuity: async () => null, runHeartbeat: false });
    expect(fs.existsSync(path.join(w.brainHome, 'injected', '.reset'))).toBe(true);
    expect(prompt(w, 'what is ruflo?')).toContain(FULL_GROUND);
  }, 60_000);

  it('SAFETY IS NEVER BUDGETED: with a zero budget the ground block and the autonomous HARD FENCE still go out, every prompt', () => {
    const w = world();
    const env = { RUVNET_PROMPT_INJECTION_BUDGET: '0' };
    const a = prompt(w, '/loop build the ruflo agentdb service', { env });
    const b = prompt(w, '/loop build the ruflo agentdb service', { env });
    expect(a).toContain(FULL_GROUND);
    expect(a).toContain('HARD FENCE');
    expect(b).toContain('[RuvNet Brain — ground before you assert]');
    expect(b).toContain('HARD FENCE — even in autonomous mode, NEVER');
    expect(b).toContain('AUTONOMOUS MODE still applies');
  });

  it('over budget, a lower-priority offer is DEFERRED (not lost): it goes out on a later prompt', () => {
    const w = world();
    const env = { RUVNET_PROMPT_INJECTION_BUDGET: '1200' };
    // drift (priority 1) and the testing/QE offer (priority 2) both fire; ~1.1 KB each.
    const first = prompt(w, 'add test coverage for the pinecone vector database adapter', { env });
    expect(first).toContain('reaching for a classical default');
    expect(first).not.toContain('testing/quality turn');
    expect(ledger(w).at(-1).deferred).toBeGreaterThan(0);
    const later = prompt(w, 'run the tests again', { env });
    expect(later).toContain('testing/quality turn');
  });

  it('an offer bigger than the whole budget still goes out when it is the prompt\'s only non-safety block', () => {
    const w = world();
    const r = prompt(w, 'run the tests again', { env: { RUVNET_PROMPT_INJECTION_BUDGET: '10' } });
    expect(r).toContain('testing/quality turn');
  });

  it('an offer the text itself calls once-per-session is not repeated (testing/QE)', () => {
    const w = world();
    expect(prompt(w, 'run the tests')).toContain('testing/quality turn');
    expect(prompt(w, 'run the tests again')).not.toContain('testing/quality turn');
  });

  it('an unwritable cache degrades to the old behaviour (full every time), never to silence', () => {
    const w = world();
    fs.mkdirSync(w.brainHome, { recursive: true });
    fs.writeFileSync(path.join(w.brainHome, 'injected'), 'not a directory');
    expect(prompt(w, 'what is ruflo?')).toContain(FULL_GROUND);
    expect(prompt(w, 'what is ruflo?')).toContain(FULL_GROUND);
  });
});
