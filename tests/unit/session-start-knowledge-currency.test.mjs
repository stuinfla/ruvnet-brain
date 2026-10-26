// session-start-knowledge-currency.test.mjs — "never silent for 40 days" (Piece B).
// The owner's installed knowledge base was 35 days old with the nightly refresh failing 22/22 times
// and nothing said so. SessionStart must speak ONE line when currency cannot be proven, stay silent
// when a refresh proved it, and never call UNKNOWN "current". Each case also runs through the real
// runSessionStart so the line is proven to survive its output filter, not just to be computed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knowledgeCurrency, KNOWLEDGE_LINE_PREFIX } from '../../plugin/scripts/session-start-health.mjs';
import { runSessionStart } from '../../plugin/scripts/session-start-core.mjs';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const H = 3_600_000;
let home;
let brain;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-currency-'));
  brain = path.join(home, '.cache', 'ruvnet-brain');
  const kb = path.join(brain, 'kb');
  fs.mkdirSync(path.join(kb, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
  fs.writeFileSync(path.join(kb, 'store.rvf'), 'x');
  for (const f of ['.console-offered', '.auto-update-pref', '.router-profile-nudged']) fs.writeFileSync(path.join(brain, f), 'no\n');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const built = (msAgo) => fs.writeFileSync(path.join(brain, 'kb', 'SOURCE.json'), JSON.stringify({ builtUtc: new Date(NOW - msAgo).toISOString() }));
let n = 0;
function receipt({ status, hoursAgo, action = 'nightly' }) {
  const dir = path.join(brain, 'refresh-runs');
  fs.mkdirSync(dir, { recursive: true });
  n += 1;
  const at = new Date(NOW - hoursAgo * H).toISOString();
  const ok = status === 'SUCCEEDED';
  fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', action, runId: `r${n}`,
    status, terminalVerdict: ok ? 'noop' : 'failed', startedAt: at, finishedAt: at, requiredPhaseOrder: ['source-enumeration', 'apply'],
    phases: ok ? [{ phase: 'source-enumeration', status: 'PASS' }, { phase: 'apply', status: 'PASS' }]
      : [{ phase: 'source-enumeration', status: 'FAIL', evidence: { reason: 'github rate limit' } }] }));
}
const line = () => knowledgeCurrency({ env: {}, home, now: NOW });
// The receipt shape bin/install.mjs runUpdate writes when every corpus phase (through `update`) PASSED,
// so the new knowledge is installed, and only host-convergence after it failed (issue #391).
const CORPUS = ['source-enumeration', 'ingestion', 'local-overlay-restoration', 'generation-ledger-reconciliation',
  'coverage-generation', 'bundle-assembly', 'update'];
function hostOnlyReceipt({ hoursAgo, hostEvidence, hostStatus = 'FAIL', after = [], terminalVerdict = 'failed' }) {
  const dir = path.join(brain, 'refresh-runs');
  fs.mkdirSync(dir, { recursive: true });
  n += 1;
  const at = new Date(NOW - hoursAgo * H).toISOString();
  fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', action: 'update', runId: `r${n}`,
    status: 'FAILED', terminalVerdict, startedAt: at, finishedAt: at, requiredPhaseOrder: [...CORPUS, 'host-convergence', 'cleanup'],
    phases: [...CORPUS.map((phase) => ({ phase, status: 'PASS', evidence: {} })),
      { phase: 'host-convergence', status: hostStatus, evidence: hostEvidence }, ...after] }));
}
const RETENTION = 'lifecycle evidence exceeds its fixed retention safety budget';
async function sessionStartOutput() {
  let out = '';
  await runSessionStart({ env: { HOME: home, RUVNET_BRAIN_METER: '0' }, cwd: home, stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} }, restoreContinuity: async () => null, runHeartbeat: false });
  return out;
}

describe('SessionStart knowledge currency', () => {
  it('is silent when the knowledge base is fresh, or old but proven current by a recent successful refresh', async () => {
    built(2 * H);
    expect(line()).toBe('');
    built(35 * 24 * H);
    receipt({ status: 'SUCCEEDED', hoursAgo: 5 });
    expect(line()).toBe('');
    // runSessionStart uses the real clock (NOW is fixed): from 2026-10-02 the 5h receipt above reads >48h
    // there, so the session half gets the same "5h before now" receipt on the real clock.
    receipt({ status: 'SUCCEEDED', hoursAgo: (NOW - (Date.now() - 5 * H)) / H });
    expect(await sessionStartOutput()).not.toContain(KNOWLEDGE_LINE_PREFIX);
  });

  it('speaks when the knowledge base is 35 days old and nothing proves it current', async () => {
    built(35 * 24 * H);
    const text = line();
    expect(text).toContain('KNOWLEDGE STALE');
    expect(text).toContain('(35d ago)');
    expect(text).toContain('no nightly refresh is scheduled');
    expect(text).toContain('npx ruvnet-brain@latest --update && npx ruvnet-brain --enable-nightly');
    const out = await sessionStartOutput();
    // runSessionStart uses the real clock (NOW is fixed), so the "(Nd ago)" age differs by date.
    const ageless = (l) => l.replace(/\(\d+[dh] ago\)/, '(AGE)');
    expect(out.split('\n').filter((l) => l.startsWith(KNOWLEDGE_LINE_PREFIX)).map(ageless)).toEqual([ageless(text)]);
  });

  it('speaks when refresh receipts are FAILING, even if the bundle itself is recent', async () => {
    built(10 * H);
    receipt({ status: 'SUCCEEDED', hoursAgo: 800 });
    for (let i = 22; i >= 1; i -= 1) receipt({ status: 'FAILED', hoursAgo: i * 24 });
    const text = line();
    expect(text).toContain('KNOWLEDGE UPDATE FAILING');
    expect(text).toContain('failed at source-enumeration: github rate limit');
    expect(text).toContain('22 failed run(s) since the last success (2026-08-28');
    // runSessionStart uses the real clock, so match the stable parts of its one line.
    const lines = (await sessionStartOutput()).split('\n').filter((l) => l.startsWith(KNOWLEDGE_LINE_PREFIX));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('UPDATE FAILING');
    expect(lines[0]).toContain('22 failed run(s)');
  });

  // Issue #391: the knowledge DID update; only the host plugin sync after it did not finish. That must
  // never read "KNOWLEDGE UPDATE FAILING", and the host half must still be said, with its reason.
  it('reports a host restart as pending, not as a knowledge failure, when the corpus update landed', () => {
    built(3 * H);
    for (let i = 4; i >= 1; i -= 1) {
      hostOnlyReceipt({ hoursAgo: i * 0.2, hostEvidence: { state: 'host-restart-required',
        error: 'host convergence is host-restart-required: boot-level declarations changed: hooks/hooks.json' } });
    }
    const text = line();
    expect(text).not.toContain('UPDATE FAILING');
    expect(text).toContain(`${KNOWLEDGE_LINE_PREFIX}CURRENT, HOST RESTART PENDING]`);
    expect(text).toContain('knowledge base built');
    expect(text).toContain('boot-level declarations changed: hooks/hooks.json');
    expect(text).toContain('passed its knowledge update phase');
    expect(text).not.toContain('installed the knowledge');
    // A restart writes no receipt, so the fix must name the step that records the sync.
    expect(text).toContain('then record it: npx ruvnet-brain@latest --update');
    expect(text).not.toContain('since the last success (none recorded)');
  });

  // BREAK-IT: host-convergence PASSED and only cleanup failed (runUpdate's recovery-required path).
  // That is not a host sync failure and must keep its own cleanup reason, never "did not finish: converged".
  it('keeps a cleanup failure after converged hosts as UPDATE FAILING with the cleanup reason', () => {
    built(3 * H);
    hostOnlyReceipt({ hoursAgo: 1, hostStatus: 'PASS', hostEvidence: { state: 'converged', error: null },
      terminalVerdict: 'recovery-required', after: [{ phase: 'cleanup', status: 'FAIL', evidence: { reason: RETENTION } }] });
    const text = line();
    expect(text).not.toContain('HOST');
    expect(text).not.toContain('converged');
    expect(text).toContain(`${KNOWLEDGE_LINE_PREFIX}UPDATE FAILING]`);
    expect(text).toContain(`failed at cleanup: ${RETENTION}`);
  });

  it('does not call it host-only when host sync AND cleanup both failed', () => {
    built(3 * H);
    hostOnlyReceipt({ hoursAgo: 1, hostEvidence: { state: 'host-restart-required', error: 'host restart' },
      after: [{ phase: 'cleanup', status: 'FAIL', evidence: { reason: RETENTION } }] });
    const text = line();
    expect(text).not.toContain('HOST RESTART PENDING');
    expect(text).toContain(`${KNOWLEDGE_LINE_PREFIX}UPDATE FAILING]`);
  });

  it('does not call it host-only when the process exited after converged hosts (no failed phase recorded)', () => {
    built(3 * H);
    hostOnlyReceipt({ hoursAgo: 1, hostStatus: 'PASS', hostEvidence: { state: 'converged', error: null } });
    const text = line();
    expect(text).not.toContain('HOST');
    expect(text).toContain(`${KNOWLEDGE_LINE_PREFIX}UPDATE FAILING]`);
  });

  it('on an old KB, a host-only failure reads STALE with the host reason, not UPDATE FAILING', () => {
    built(5 * 24 * H);
    hostOnlyReceipt({ hoursAgo: 4 * 24, hostEvidence: { state: 'host-restart-required', error: 'host restart pending' } });
    const text = line();
    expect(text).toContain(`${KNOWLEDGE_LINE_PREFIX}STALE]`);
    expect(text).toContain('passed its knowledge update phase 4d ago but its host sync did not finish: host restart pending');
  });

  it('names a reasonless host-sync failure as host sync, not knowledge, and says no reason was recorded', () => {
    built(9 * H);
    hostOnlyReceipt({ hoursAgo: 9, hostEvidence: { state: null, error: null } });
    const text = line();
    expect(text).not.toContain('UPDATE FAILING');
    expect(text).toContain(`${KNOWLEDGE_LINE_PREFIX}CURRENT, HOST SYNC PENDING]`);
    expect(text).toContain('no reason recorded');
    expect(text).toContain('Fix: npx ruvnet-brain@latest --update');
  });

  it('still says UPDATE FAILING when a corpus phase failed, and never pairs "since the last success" with "none recorded"', () => {
    built(10 * H);
    for (let i = 3; i >= 1; i -= 1) receipt({ status: 'FAILED', hoursAgo: i });
    const text = line();
    expect(text).toContain('KNOWLEDGE UPDATE FAILING');
    expect(text).toContain('3 failed run(s) and no successful run on record');
    expect(text).not.toContain('(none recorded)');
  });

  it('says UNKNOWN, never current, when SOURCE.json is unreadable', () => {
    fs.writeFileSync(path.join(brain, 'kb', 'SOURCE.json'), '{not json');
    const text = line();
    expect(text).toContain('KNOWLEDGE CURRENCY UNKNOWN');
    expect(text).toContain('age UNKNOWN');
    expect(text).not.toMatch(/\bcurrent\b(?! verdict)/i);
  });

  it('names ak sync only when agentic-kit is proven delivering, and stays quiet when the brain is off', async () => {
    built(40 * 24 * H);
    fs.mkdirSync(path.join(home, '.config', 'agentic-kit'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'agentic-kit', 'kit.json'), JSON.stringify({ ruvnetBrain: true }));
    // A claim with no proven update (the owner's Mac): the Brain's own update is the fix, never ak sync.
    expect(line()).toContain('Fix: npx ruvnet-brain@latest --update (');
    expect(line()).toContain('no update is proven in 36h');
    expect(line()).not.toContain('no nightly refresh is scheduled');
    // agentic-kit delivered 30h ago but the latest run failed: it is the owner, so ak sync is the fix.
    receipt({ status: 'SUCCEEDED', hoursAgo: 30 });
    receipt({ status: 'FAILED', hoursAgo: 1 });
    expect(line()).toContain('KNOWLEDGE UPDATE FAILING');
    expect(line()).toContain('Fix: ak sync');
    expect(line()).not.toContain('no update is proven');
    let out = '';
    await runSessionStart({ env: { HOME: home, RUVNET_BRAIN_OFF: '1', RUVNET_BRAIN_METER: '0' }, cwd: home,
      stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} }, restoreContinuity: async () => null, runHeartbeat: false });
    expect(out).not.toContain(KNOWLEDGE_LINE_PREFIX);
  });
});
