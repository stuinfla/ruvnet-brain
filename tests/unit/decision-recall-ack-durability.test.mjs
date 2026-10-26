// decision-recall-ack-durability.test.mjs — ADR-105 §8 / ADR-106's "refuse at most once per path per
// session" memory depends entirely on decision-recall-acks.json surviving disk. decision-record.mjs's
// OWN sibling receipt (writeConsultReceipt) already writes via a temp file + rename so a crash mid-write
// can never corrupt the real file; decision-recall-gate.mjs's ack ledger was never migrated to that
// pattern and instead calls fs.writeFileSync(file, ...) directly on the real path — which truncates
// before it writes the new bytes. A process killed between truncate and write (the exact failure mode
// documented in user-settings.mjs's writeAtomic) leaves the ledger empty, silently discarding every
// acknowledgment ever recorded, not just the one being added.
//
// Every guard here was first run against a deliberately broken input (decision-recall-gate.mjs on
// unmodified `main`) and seen to fail.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from '../../plugin/scripts/decision-recall-gate.mjs';
import { adoptedProject, cleanup } from '../helpers/continuity-fixture.mjs';

afterEach(() => cleanup());

function payload({ cwd, session, adrName }) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: `docs/adr/${adrName}.md`, content: `# ADR ${adrName}\n` },
    cwd,
    session_id: session,
  };
}

describe('decision-recall-gate ack ledger durability', () => {
  it('a crash mid-write on a SECOND acknowledgment must not destroy the FIRST', () => {
    const project = adoptedProject();
    const brainHome = path.join(project.home, 'brain');
    const env = { HOME: project.home, RUVNET_BRAIN_HOME: brainHome };
    const ackFile = path.join(brainHome, 'decision-recall-acks.json');

    // First acknowledgment: a real refusal that records key1 to disk, no mocking involved.
    const first = evaluate(payload({ cwd: project.dir, session: 's1', adrName: '0201-a' }),
      { env, now: Date.parse('2026-10-14T01:00:00Z') });
    expect(first.code).toBe(2);
    expect(fs.existsSync(ackFile), 'first acknowledgment must have been written').toBe(true);
    const afterFirst = JSON.parse(fs.readFileSync(ackFile, 'utf8'));
    expect(Object.keys(afterFirst).length).toBe(1);

    // Second acknowledgment (a DIFFERENT decision, so a different key): simulate the exact failure
    // user-settings.mjs's writeAtomic was written to survive — the OS's write(2) truncates the
    // destination before the new bytes land, and the process is killed before they do. We let the
    // real truncate happen (so the simulation is physically honest) and then throw, exactly as a
        // real write() returning ENOSPC or the process dying would surface to the caller.
    const orig = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data, opts) => {
      if (String(p) === ackFile) {
        orig(p, '', { mode: 0o600 }); // the real file is truncated — this is what "mid-write" means
        throw new Error('ENOSPC: simulated crash between truncate and write');
      }
      return orig(p, data, opts);
    });
    let second;
    try {
      second = evaluate(payload({ cwd: project.dir, session: 's2', adrName: '0202-b' }),
        { env, now: Date.parse('2026-10-14T01:05:00Z') });
    } finally { spy.mockRestore(); }

    // The gate must never THROW over its own ledger I/O, whether the simulated write actually failed
    // (buggy code: the crash is real, on the literal target path → ALLOW) or the publish went through
    // untouched because the risky write landed on a scratch path instead (fixed code: a normal REFUSE).
    expect([0, 2]).toContain(second.code);

    // THE TEETH: the first acknowledgment, already durably recorded, must survive a crash that only
    // ever touches the SECOND write. A non-atomic write-in-place loses it; a temp-file+rename write
    // never touches the real path until the new content is complete, so it cannot.
    const raw = fs.readFileSync(ackFile, 'utf8');
    expect(raw.length, 'the ledger must not have been truncated to empty by the simulated crash').toBeGreaterThan(0);
    const acks = JSON.parse(raw);
    const firstKey = Object.keys(afterFirst)[0];
    expect(acks[firstKey], 'the pre-existing acknowledgment must still be present after the crash').toBeTruthy();
  });

  it('a clean write (no crash) still merges both acknowledgments and never leaves a temp file behind', () => {
    const project = adoptedProject();
    const brainHome = path.join(project.home, 'brain');
    const env = { HOME: project.home, RUVNET_BRAIN_HOME: brainHome };
    const ackFile = path.join(brainHome, 'decision-recall-acks.json');

    evaluate(payload({ cwd: project.dir, session: 's1', adrName: '0203-a' }),
      { env, now: Date.parse('2026-10-14T01:00:00Z') });
    evaluate(payload({ cwd: project.dir, session: 's2', adrName: '0204-b' }),
      { env, now: Date.parse('2026-10-14T01:05:00Z') });

    const acks = JSON.parse(fs.readFileSync(ackFile, 'utf8'));
    expect(Object.keys(acks).length, 'both independent acknowledgments must be present').toBe(2);
    const leftovers = fs.readdirSync(brainHome).filter((n) => n.includes('.tmp-') || n.startsWith('decision-recall-acks.json.'));
    expect(leftovers, 'no scratch file should remain next to the published ledger').toEqual([]);
  });
});
