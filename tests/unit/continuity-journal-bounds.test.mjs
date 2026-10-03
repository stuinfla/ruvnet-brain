// continuity-journal-bounds.test.mjs — "Recording ✗" must mean something, and the outbox must stay bounded
// (independent review S3/S4, 2026-10-01). Every scenario here was RED on the 4.5.0 journal:
//   S3a  the same event observed by two sessions was quarantined forever (session id in the bytes);
//   S3b  a quarantined or corrupt line kept the line red forever, with no way to clear it;
//   S3c  a project with .swarm but no store, or no ruflo, read "stuck" after 10 minutes;
//   S3d  the Stop line repeated at every turn;
//   S4   with ruflo missing every Stop appended one failure line per pending event (305 → 910 → 1815
//        lines in 3 days, measured), and nothing ever aged out.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ContinuityJournal, MAX_EVENT_RECORDS, QUARANTINE_REPORT_MS, RETAIN_COMMITTED_MS, STUCK_AFTER_MS,
  captureContinuityEvents, drain, recordingLine, runDrain, stopNotice,
} from '../../plugin/scripts/continuity-journal.mjs';
import { CONTINUITY_NAMESPACE, eventKey, makeEvent } from '../../plugin/scripts/continuity-events.mjs';
import { digestCanonical } from '../../plugin/scripts/project-progression-contract.mjs';
import { WAL_REFUSAL_TEXT, adoptedProject, cleanup, commit, fakeRuflo, rows, tmp } from '../helpers/continuity-fixture.mjs';

const DAY = 86_400_000;
const noSleep = () => {};
const fastBackoff = [1, 1, 1, 1];
let saved;
beforeAll(() => { saved = process.env.RUVNET_RUFLO_CWD_ROOT; process.env.RUVNET_RUFLO_CWD_ROOT = tmp('cont-cwd-'); });
afterAll(() => { if (saved === undefined) delete process.env.RUVNET_RUFLO_CWD_ROOT; else process.env.RUVNET_RUFLO_CWD_ROOT = saved; });
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const lesson = (text, at = Date.now()) => makeEvent({ kind: 'lesson', at, source: 'explicit', authoritative: true, summary: text });
const raw = (event, journaledAt = new Date(Date.parse(event.at)).toISOString()) => ({ type: 'event', key: eventKey(event), digest: digestCanonical(event), journaledAt, event });
const sameCommit = (session, at) => makeEvent({ kind: 'commit', at, session, source: 'git', authoritative: true, summary: 'abcdef12 fix: one commit', basis: 'a'.repeat(40), detail: { sha: 'a'.repeat(40) } });

// These two stress cases already replace store/readback to measure outbox accounting.
// Validate fixture consent once, then isolate its discovery cost at the existing seam.
// Production consent/refusal tests retain real resolution and live policy reads.
function isolatedDrainConsent(journal) {
  const authorized = journal.captureConsent();
  expect(authorized.skipped).toBeUndefined();
  expect(authorized).toMatchObject({ db: journal.db, projectRoot: journal.projectRoot, capturePath: journal.projectDir });
  return vi.spyOn(ContinuityJournal.prototype, 'captureConsent').mockImplementation(function (origin, unknownOriginalPath) {
    expect(this.db).toBe(journal.db);
    expect(origin).toBe(journal.projectDir);
    expect(unknownOriginalPath).toBe(false);
    return authorized;
  });
}

describe('S3a: one event seen by two sessions is one event, never a quarantine', () => {
  it('two concurrent journal lines for the same commit (different session ids) dedupe to ONE pending event', () => {
    const p = adoptedProject();
    const at = Date.now() - 60_000;
    const [a, b] = [sameCommit('session-a', at), sameCommit('session-b', at)];
    expect(eventKey(a)).toBe(eventKey(b));
    expect(digestCanonical(a)).not.toBe(digestCanonical(b)); // the bytes differ only by who observed it
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: fakeRuflo().bin });
    journal.appendRecords([raw(a), raw(b)]); // the race: both boundaries passed knownIds() before either appended
    const status = journal.status();
    expect(status).toMatchObject({ pending: 1, quarantined: [], stuck: false });
    expect(drain(journal, { ruflo: fakeRuflo().bin, backoff: fastBackoff, sleep: noSleep })).toMatchObject({ committed: 1, remaining: 0 });
    expect(journal.status()).toMatchObject({ pending: 0, quarantined: [], stuck: false });
  });

  it('a row the OTHER session already stored under the same key commits this one; it is not a conflict', () => {
    const p = adoptedProject();
    const ruflo = fakeRuflo();
    const at = Date.now() - 60_000;
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: ruflo.bin });
    journal.appendRecords([raw(sameCommit('session-a', at))]);
    const theirs = sameCommit('session-b', at);
    spawnSync(ruflo.bin, ['memory', 'store', '--key', eventKey(theirs), '--value', JSON.stringify(theirs), '--namespace', CONTINUITY_NAMESPACE, '--path', journal.db]);
    expect(drain(journal, { ruflo: ruflo.bin, backoff: fastBackoff, sleep: noSleep })).toMatchObject({ committed: 1, remaining: 0 });
    expect(journal.status()).toMatchObject({ quarantined: [], stuck: false });
  });
});

describe('S3b: a real problem is surfaced, then clears itself (or with one command)', () => {
  it('a genuine conflict is red with the clear command, and ages out after QUARANTINE_REPORT_MS', () => {
    const p = adoptedProject();
    const ruflo = fakeRuflo();
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: ruflo.bin });
    const [rec] = journal.record([lesson('One key, one value.')]);
    spawnSync(ruflo.bin, ['memory', 'store', '--key', rec.key, '--value', '{"other":true}', '--namespace', CONTINUITY_NAMESPACE, '--path', journal.db]);
    drain(journal, { ruflo: ruflo.bin, backoff: fastBackoff, sleep: noSleep });
    const red = journal.status();
    expect(red).toMatchObject({ quarantined: [rec.key], stuck: true, problem: 'quarantined', pending: 0 });
    expect(recordingLine(red)).toMatch(/recording stuck .*quarantined.*clears itself .*--clear/);
    const later = new ContinuityJournal({ projectRoot: p.dir, ruflo: ruflo.bin, now: () => Date.now() + QUARANTINE_REPORT_MS + DAY });
    expect(later.status()).toMatchObject({ stuck: false, problem: null, pending: 0 });
    // …and the one command clears it now.
    journal.clearProblems();
    expect(journal.status()).toMatchObject({ stuck: false, problem: null, quarantined: [] });
    expect(journal.pending()).toHaveLength(0); // a conflicted key is still never retried
  });

  it('a corrupt outbox line is reported, compacted out of the file, and clears the same way', () => {
    const p = adoptedProject();
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: fakeRuflo().bin });
    journal.record([lesson('Survives a torn line.')]);
    fs.appendFileSync(journal.path, '{"type":"event","key":\n');
    expect(journal.status()).toMatchObject({ problem: 'corrupt', stuck: true });
    journal.compact();
    expect(lines(journal.path).some((l) => l.startsWith('{"type":"event","key":') && !l.endsWith('}'))).toBe(false);
    expect(journal.pending()).toHaveLength(1); // the good event survived compaction
    expect(journal.status()).toMatchObject({ problem: 'corrupt' }); // still reported once compacted …
    const later = new ContinuityJournal({ projectRoot: p.dir, ruflo: fakeRuflo().bin, now: () => Date.now() + QUARANTINE_REPORT_MS + DAY });
    expect(later.status().problem).not.toBe('corrupt'); // … until it ages out
  });
});

describe('S3c: no store or no ruflo is NOT APPLICABLE, never "stuck"', () => {
  it('.swarm without memory.db: nothing is journalled and the line says n/a', () => {
    const p = adoptedProject();
    fs.rmSync(path.join(p.dir, '.swarm', 'memory.db'));
    commit(p.dir, p.env, 'a.txt', 'feat: a change');
    const r = captureContinuityEvents({ projectDir: p.dir, event: 'Stop', payload: { session_id: 's' }, env: {}, ruflo: fakeRuflo().bin, launch: () => true });
    expect(r.skipped).toMatch(/not applicable/);
    expect(fs.existsSync(path.join(p.dir, '.swarm', 'continuity-events-outbox.jsonl'))).toBe(false);
    // An outbox left from before the store disappeared is still not "stuck".
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: fakeRuflo().bin });
    journal.appendRecords([raw(lesson('Old.', Date.now() - STUCK_AFTER_MS * 10))]);
    const status = journal.status();
    expect(status).toMatchObject({ stuck: false, applicable: false });
    expect(recordingLine(status)).toMatch(/^AgentDB: recording n\/a — no AgentDB store/);
    expect(recordingLine(status)).not.toMatch(/✗/);
  });

  it('a store but no ruflo: n/a after any time, no drainer is launched', () => {
    const p = adoptedProject();
    commit(p.dir, p.env, 'a.txt', 'feat: a change');
    const launches = [];
    const r = captureContinuityEvents({ projectDir: p.dir, event: 'Stop', payload: { session_id: 's' }, env: {}, ruflo: null, launch: (x) => { launches.push(x); return true; } });
    expect(r.recorded).toBe(1);
    expect(launches).toEqual([]);
    const status = new ContinuityJournal({ projectRoot: p.dir, ruflo: null, now: () => Date.now() + STUCK_AFTER_MS * 10 }).status();
    expect(status).toMatchObject({ stuck: false, applicable: false, pending: 1 });
    expect(recordingLine(status)).toMatch(/^AgentDB: recording n\/a — ruflo is not installed; 1 event\(s\) wait in the outbox/);
  });
});

describe('S3d: the Stop line is shown at most once per session per condition', () => {
  it('throttles by session and condition', () => {
    const p = adoptedProject();
    const ruflo = fakeRuflo();
    const old = Date.now() - STUCK_AFTER_MS - 60_000;
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: ruflo.bin, now: () => old });
    journal.record([lesson('Stuck.', old)]);
    const live = new ContinuityJournal({ projectRoot: p.dir, ruflo: ruflo.bin });
    const status = live.status();
    expect(status.problem).toBe('stuck-pending');
    expect(stopNotice({ journal: live, status, session: 's1' })).toMatch(/recording stuck/);
    expect(stopNotice({ journal: live, status, session: 's1' })).toBe('');
    expect(stopNotice({ journal: live, status, session: 's2' })).toMatch(/recording stuck/);
    expect(stopNotice({ journal: live, status: { ...status, problem: 'corrupt', corrupt: 1 }, session: 's1' })).toMatch(/recording stuck/);
    expect(stopNotice({ journal: live, status: { ...status, stuck: false, problem: null }, session: 's3' })).toBe('');
  });
});

describe('S4: the outbox stays bounded', () => {
  it('three simulated days with ruflo missing: no drainer, no per-Stop lines, a constant file', () => {
    const p = adoptedProject();
    const start = Date.now() - 3 * DAY;
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: null, now: () => start });
    journal.record(Array.from({ length: 300 }, (_, i) => lesson(`Pending lesson number ${i}.`, start)));
    const launches = [];
    const sizes = [];
    for (let day = 0; day < 3; day += 1) {
      for (let stop = 0; stop < 8; stop += 1) {
        const at = start + day * DAY + stop * 3 * 3_600_000;
        captureContinuityEvents({ projectDir: p.dir, event: 'Stop', payload: { session_id: `s${day}` }, env: {}, ruflo: null, now: () => at,
          launch: (x) => { launches.push(x); return true; } });
        runDrain(p.dir, { ruflo: null });
      }
      sizes.push(lines(journal.path).length);
    }
    expect(launches).toEqual([]);
    expect(sizes[2]).toBeLessThanOrEqual(300 + 5); // 4.5.0 measured 305 → 910 → 1815
    expect(sizes[2]).toBe(sizes[0]);
  }, 120_000);

  it('persistent WAL contention: ONE failure record per event (attempts counted), not a line per attempt', () => {
    const p = adoptedProject();
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: 'ruflo' });
    journal.record(Array.from({ length: 20 }, (_, i) => lesson(`Contended ${i}.`)));
    const consent = isolatedDrainConsent(journal);
    const refuse = vi.fn(() => ({ status: 1, output: WAL_REFUSAL_TEXT }));
    for (let i = 0; i < 72; i += 1) {
      runDrain(p.dir, { ruflo: 'ruflo', store: refuse, readBack: () => ({ content: null }), backoff: fastBackoff, sleep: noSleep });
    }
    expect(refuse).toHaveBeenCalledTimes(72 * 20 * (fastBackoff.length + 1));
    expect(consent).toHaveBeenCalledTimes(refuse.mock.calls.length);
    const all = lines(journal.path).map((l) => JSON.parse(l));
    expect(all.filter((r) => r.type === 'event')).toHaveLength(20);
    const failures = all.filter((r) => r.type === 'failure');
    expect(failures.length).toBeLessThanOrEqual(20);
    expect(all.length).toBeLessThanOrEqual(20 + 20 + 3);
    expect(failures[0]).toMatchObject({ reason: 'wal-contention' });
    expect(failures[0].attempts).toBeGreaterThanOrEqual(72);
    expect(failures[0].error).toContain('refusing an unsafe sql.js');
  });

  it('committed events age out of the outbox after RETAIN_COMMITTED_MS and stay deduped by the store', () => {
    const p = adoptedProject();
    const ruflo = fakeRuflo();
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: ruflo.bin });
    const e = lesson('Aged out but remembered.');
    journal.record([e]);
    drain(journal, { ruflo: ruflo.bin, backoff: fastBackoff, sleep: noSleep });
    const later = new ContinuityJournal({ projectRoot: p.dir, ruflo: ruflo.bin, now: () => Date.now() + RETAIN_COMMITTED_MS + DAY });
    later.compact();
    expect(lines(journal.path).filter((l) => JSON.parse(l).type === 'event')).toEqual([]);
    expect(rows(journal.db, CONTINUITY_NAMESPACE)).toHaveLength(1);
    expect(later.record([e])).toHaveLength(0);
  });

  it('keeps every accepted pending event over the soft cap and reports capacity pressure without repeated rewrites', () => {
    const p = adoptedProject();
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: null });
    const events = Array.from({ length: MAX_EVENT_RECORDS + 500 }, (_, i) => lesson(`Uncommittable ${i}.`, Date.now() + i));
    const accepted = journal.record(events);
    const result = journal.compact();
    expect(result).toMatchObject({ kept: events.length, dropped: 0 });
    const reopened = new ContinuityJournal({ projectRoot: p.dir, ruflo: null });
    expect(reopened.pending()).toEqual([...accepted].sort((a, b) => a.key.localeCompare(b.key)));
    expect(reopened.status()).toMatchObject({ pending: events.length, dropped: 0, capacityPressure: true });
    expect(recordingLine(reopened.status())).toMatch(/Capacity pressure:.*no pending events discarded/);
    expect(reopened.needsCompaction()).toBe(false); // No redundant history remains to shrink.
    const bytes = fs.readFileSync(reopened.path);
    expect(drain(reopened, { ruflo: null })).toMatchObject({ remaining: events.length, skipped: 'ruflo not found' });
    expect(fs.readFileSync(reopened.path)).toEqual(bytes);
  });

  it('prunes committed history before pending, preserves failures, then drains every recovered event and returns within the cap', () => {
    const p = adoptedProject();
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: 'ruflo' });
    const at = Date.now();
    const accepted = journal.record(Array.from({ length: MAX_EVENT_RECORDS + 5 }, (_, i) => lesson(`Recover ${i}.`, at + i)));
    const committed = journal.record(Array.from({ length: 20 }, (_, i) => lesson(`Already committed ${i}.`, at - 100 + i)));
    journal.appendRecords(committed.map((r) => ({ type: 'commit', key: r.key, digest: r.digest, committedAt: new Date(at).toISOString() })));
    const failure = { type: 'failure', key: accepted[0].key, at: new Date(at).toISOString(), attempts: 3, reason: 'wal-contention' };
    journal.appendRecords([failure, failure]);
    expect(journal.needsCompaction()).toBe(true);
    expect(journal.compact()).toMatchObject({ kept: accepted.length, dropped: 0 });
    const reopened = new ContinuityJournal({ projectRoot: p.dir, ruflo: 'ruflo' });
    expect(reopened.pending()).toEqual([...accepted].sort((a, b) => a.key.localeCompare(b.key)));
    expect(reopened.scan().committed.size).toBe(0);
    expect(reopened.scan().failures.get(failure.key)).toMatchObject({ attempts: 6, reason: 'wal-contention' });
    expect(reopened.needsCompaction()).toBe(false);
    expect(reopened.status()).toMatchObject({ problem: 'capacity-pressure', capacityPressure: true, dropped: 0 });
    expect(recordingLine(reopened.status())).toMatch(/soft limit 2000; no pending events discarded/);
    const stored = new Map(); // Exact-content store/readback seam; no owner store or raw SQL mutation.
    const consent = isolatedDrainConsent(reopened);
    const store = vi.fn(({ key, value }) => { stored.set(key, value); return { status: 0 }; });
    const result = drain(reopened, {
      store,
      readBack: ({ key }) => ({ content: stored.get(key), readPath: 'isolated-exact-content' }),
    });
    expect(result).toMatchObject({ committed: accepted.length, failed: 0, remaining: 0 });
    expect(store).toHaveBeenCalledTimes(accepted.length);
    expect(consent).toHaveBeenCalledTimes(store.mock.calls.length);
    for (const r of accepted) expect(stored.get(r.key)).toBe(JSON.stringify(r.event));
    expect(reopened.scan().events.size).toBe(MAX_EVENT_RECORDS);
    expect(reopened.scan().failures.size).toBe(0);
    expect(reopened.status()).toMatchObject({ pending: 0, capacityPressure: false, dropped: 0, problem: null });
    const later = new ContinuityJournal({ projectRoot: p.dir, ruflo: 'ruflo', now: () => at + RETAIN_COMMITTED_MS + DAY });
    later.compact();
    expect(later.scan().events.size).toBe(0);
    expect(stored.size).toBe(accepted.length); // History pruning never touches durable stored content.
  });

  it('an append that lands during a compaction is never lost', () => {
    const p = adoptedProject();
    const journal = new ContinuityJournal({ projectRoot: p.dir, ruflo: null });
    journal.record([lesson('Before compaction.')]);
    fs.appendFileSync(journal.path, 'torn\n'); // forces a rewrite
    const other = new ContinuityJournal({ projectRoot: p.dir, ruflo: null });
    journal.compact({ beforeRename: () => fs.appendFileSync(other.path, `${JSON.stringify(raw(lesson('Landed mid-compaction.')))}\n`) });
    expect(journal.pending().map((r) => r.event.summary)).toEqual(expect.arrayContaining(['Before compaction.', 'Landed mid-compaction.']));
  });
});

// Re-review BLOCKER 2: on a read-only .swarm the `wx` lock create failed with EACCES, the follow-up stat
// threw ENOENT, and the catch `continue`d BEFORE the deadline check — a 100% CPU spin that hung Stop,
// PreCompact and SessionEnd. Run in a CHILD with a hard timeout, so a regression fails instead of hanging.
const JOURNAL = path.resolve(import.meta.dirname, '../../plugin/scripts/continuity-journal.mjs');
const HOOK = path.resolve(import.meta.dirname, '../../plugin/scripts/session-snapshot-hook.mjs');
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0; // root ignores the mode bits
describe.skipIf(!canChmod)('a read-only .swarm never hangs a capture boundary (re-review B2)', () => {
  const readOnlyProject = () => {
    const p = adoptedProject();
    commit(p.dir, p.env, 'a.txt', 'feat: a change');
    fs.chmodSync(path.join(p.dir, '.swarm'), 0o555);
    return p;
  };
  const restore = (p) => fs.chmodSync(path.join(p.dir, '.swarm'), 0o755);

  it('appendRecords throws the real error promptly (EACCES), it does not spin', () => {
    const p = readOnlyProject();
    try {
      const started = Date.now();
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { ContinuityJournal } = await import(${JSON.stringify(`file://${JOURNAL}`)});
        const j = new ContinuityJournal({ projectRoot: ${JSON.stringify(p.dir)}, ruflo: null });
        try { j.appendRecords([{ type: 'event', key: 'k', digest: 'd', event: {} }]); console.log('APPENDED'); }
        catch (e) { console.log('THREW ' + e.code); }`], { encoding: 'utf8', timeout: 8_000 });
      expect(r.signal, 'killed by the timeout: the lock loop spun').toBeNull();
      expect(r.stdout.trim()).toBe('THREW EACCES');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally { restore(p); }
  });

  // Re-review a6 NIT: a STALE append lock that cannot be removed (read-only .swarm) was retried with no pause —
  // a CPU-bound second until the deadline. The wait must sleep, not spin.
  it('an unremovable stale lock is waited out with backoff (little CPU), then the append proceeds', () => {
    const p = adoptedProject();
    const swarm = path.join(p.dir, '.swarm');
    fs.writeFileSync(path.join(swarm, 'continuity-events-outbox.jsonl'), '', { mode: 0o600 });
    const lock = path.join(swarm, '.continuity-events-outbox.lock');
    fs.writeFileSync(lock, '1 1\n');
    const old = new Date(Date.now() - 10 * 60_000); fs.utimesSync(lock, old, old);
    fs.chmodSync(swarm, 0o555);
    try {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { ContinuityJournal } = await import(${JSON.stringify(`file://${JOURNAL}`)});
        const j = new ContinuityJournal({ projectRoot: ${JSON.stringify(p.dir)}, ruflo: null });
        const cpu = process.cpuUsage(); const t = Date.now();
        j.appendRecords([{ type: 'event', key: 'k', digest: 'd', event: {} }]);
        const used = process.cpuUsage(cpu);
        console.log(JSON.stringify({ wallMs: Date.now() - t, cpuMs: (used.user + used.system) / 1000 }));`], { encoding: 'utf8', timeout: 8_000 });
      expect(r.signal).toBeNull();
      const { wallMs, cpuMs } = JSON.parse(r.stdout.trim());
      expect(wallMs).toBeGreaterThanOrEqual(900);   // it did wait for the lock's deadline …
      expect(cpuMs).toBeLessThan(400);               // … asleep, not spinning (a busy loop burns ~the whole second)
      expect(fs.readFileSync(path.join(swarm, 'continuity-events-outbox.jsonl'), 'utf8')).toContain('"key":"k"');
    } finally { restore(p); }
  });

  it('the Claude Stop hook returns promptly (exit 0) with a read-only .swarm', () => {
    const p = readOnlyProject();
    try {
      const started = Date.now();
      const r = spawnSync(process.execPath, [HOOK, 'Stop'], { cwd: p.dir, encoding: 'utf8', timeout: 15_000,
        input: JSON.stringify({ session_id: 'ro-1', hook_event_name: 'Stop', cwd: p.dir }),
        env: { ...p.env, CLAUDE_PROJECT_DIR: p.dir, RUVNET_HOOK_HOST: 'claude', RUFLO_BIN: fakeRuflo().bin, RUVNET_BRAIN_HOME: tmp('cont-brain-'),
          RUVNET_RUFLO_CWD_ROOT: process.env.RUVNET_RUFLO_CWD_ROOT, RUVNET_TURN_CAPTURE: 'off',
          RUVNET_CONTINUITY_CAPTURE: '' } }); // vitest.config turns capture off; this test needs it ON
      expect(r.signal, 'the hook hung until killed').toBeNull();
      expect(r.status).toBe(0);
      expect(Date.now() - started).toBeLessThan(5_000); // < 3 s of capture work plus process start-up
    } finally { restore(p); }
  });
});
