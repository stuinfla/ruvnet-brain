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
