import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';

let temporaryRoots = [];

function temporaryRoot() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-outbox-')));
  temporaryRoots.push(root);
  return root;
}

function snapshot(overrides = {}) {
  return {
    eventKey: 'project-progress-v1-test-event',
    payloadDigest: 'a'.repeat(64),
    completeProjectState: { nextAction: 'replay me' },
    ...overrides,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ProjectProgression crash outbox', () => {
  it('fsyncs a permission-restricted snapshot before returning and fsyncs its commit marker', () => {
    const projectRoot = temporaryRoot();
    const synced = [];
    const outbox = new ProgressionOutbox({
      projectRoot,
      fsync(fd) {
        synced.push(fd);
        fs.fsyncSync(fd);
      },
    });

    const appended = outbox.appendSnapshot(snapshot());

    expect(appended).toMatchObject({ type: 'snapshot', eventKey: snapshot().eventKey });
    expect(synced).toHaveLength(1);
    if (process.platform !== 'win32') expect(fs.statSync(outbox.path).mode & 0o777).toBe(0o600);
    expect(outbox.pendingSnapshots()).toEqual([snapshot()]);

    outbox.markCommitted({
      eventKey: snapshot().eventKey,
      payloadDigest: snapshot().payloadDigest,
      readbackDigest: snapshot().payloadDigest,
      committedAt: '2026-08-22T17:30:00.000Z',
    });

    expect(synced).toHaveLength(2);
    expect(outbox.pendingSnapshots()).toEqual([]);
  });

  it('refuses a commit marker whose exact readback digest does not match the snapshot', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    outbox.appendSnapshot(snapshot());

    expect(() => outbox.markCommitted({
      eventKey: snapshot().eventKey,
      payloadDigest: snapshot().payloadDigest,
      readbackDigest: 'f'.repeat(64),
      committedAt: '2026-08-22T17:30:00.000Z',
    })).toThrow(/readback digest mismatch/i);
    expect(outbox.pendingSnapshots()).toEqual([snapshot()]);
  });

  it('fails closed on a key carrying divergent digests: that key is quarantined and never replayed', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    outbox.appendSnapshot(snapshot());
    outbox.appendSnapshot(snapshot({ payloadDigest: 'b'.repeat(64) }));

    expect(outbox.pendingSnapshots()).toEqual([]);
    expect(outbox.quarantinedKeys()).toEqual([{ eventKey: snapshot().eventKey, reason: 'outbox event key collision' }]);
  });

  // RED on the pre-4.5 outbox (it threw for the whole file): the real repo's outbox carried one
  // 2026-09-18 collision and four unrelated snapshots that were never replayed because of it.
  it('one quarantined collision does not block an unrelated pending snapshot', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    outbox.appendSnapshot(snapshot());
    outbox.appendSnapshot(snapshot({ payloadDigest: 'b'.repeat(64) }));
    const unrelated = snapshot({ eventKey: 'project-progress-v1-unrelated', payloadDigest: 'c'.repeat(64) });
    outbox.appendSnapshot(unrelated);

    expect(outbox.pendingSnapshots()).toEqual([unrelated]);
    expect(outbox.quarantinedKeys().map((row) => row.eventKey)).toEqual([snapshot().eventKey]);
  });

  it('replays a complete final snapshot without a newline and separates its appended commit', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    outbox.appendSnapshot(snapshot());
    fs.truncateSync(outbox.path, fs.statSync(outbox.path).size - 1);
    const recovered = new ProgressionOutbox({ projectRoot: path.dirname(path.dirname(outbox.path)) });
    expect(recovered.pendingSnapshots()).toEqual([snapshot()]);
    recovered.markCommitted({ eventKey: snapshot().eventKey, payloadDigest: snapshot().payloadDigest,
      readbackDigest: snapshot().payloadDigest, committedAt: '2026-08-22T17:30:00.000Z' });
    expect(recovered.records().map((r) => r.type)).toEqual(['snapshot', 'commit']);
    expect(recovered.pendingSnapshots()).toEqual([]);
    // The complete commit is also authoritative when its delimiter was the interrupted write.
    fs.truncateSync(recovered.path, fs.statSync(recovered.path).size - 1);
    expect(new ProgressionOutbox({ projectRoot: path.dirname(path.dirname(outbox.path)) }).pendingSnapshots()).toEqual([]);
  });

  it('ignores a torn final suffix but refuses append without changing accepted records or torn bytes', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    outbox.appendSnapshot(snapshot());
    fs.appendFileSync(outbox.path, '{"type":"snapshot"');
    const before = fs.readFileSync(outbox.path);
    expect(outbox.pendingSnapshots()).toEqual([snapshot()]);
    expect(() => outbox.markCommitted({ eventKey: snapshot().eventKey, payloadDigest: snapshot().payloadDigest,
      readbackDigest: snapshot().payloadDigest, committedAt: '2026-08-22T17:30:00.000Z' })).toThrow(/recover the torn tail/);
    expect(fs.readFileSync(outbox.path)).toEqual(before);
    expect(outbox.pendingSnapshots()).toEqual([snapshot()]);
  });

  it('a recovery disposition settles only its exact original payload after a linked verified commit', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    const original = snapshot();
    const recovery = snapshot({ eventKey: 'project-progress-v1-recovered', payloadDigest: 'c'.repeat(64),
      recoveryDiagnostics: { originalEventKey: original.eventKey, frozenPayloadDigest: original.payloadDigest } });
    const receipt = { eventKey: recovery.eventKey, payloadDigest: recovery.payloadDigest,
      readbackDigest: recovery.payloadDigest, committedAt: '2026-10-04T00:00:00.000Z' };
    outbox.appendSnapshot(original);
    expect(() => outbox.markRecovered(original, { ...receipt, readbackDigest: 'wrong' })).toThrow(/unverified/);
    expect(() => outbox.markRecovered(original, { ...receipt, eventKey: original.eventKey })).toThrow(/unverified/);
    // A marker alone cannot consume debt; both the linked snapshot and verified commit are needed.
    outbox.markRecovered(original, receipt);
    expect(outbox.pendingSnapshots()).toEqual([original]);
    outbox.appendSnapshot(recovery);
    expect(outbox.pendingSnapshots()).toHaveLength(2);
    outbox.markCommitted(receipt);
    expect(outbox.pendingSnapshots()).toEqual([]);
    expect(outbox.records().filter((row) => row.type === 'commit' && row.eventKey === original.eventKey)).toEqual([]);
    expect(new ProgressionOutbox({ projectRoot: path.dirname(path.dirname(outbox.path)) }).pendingSnapshots()).toEqual([]);
  });

  it('still fails closed on a malformed terminated record instead of treating it as a torn suffix', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    outbox.appendSnapshot(snapshot());
    fs.appendFileSync(outbox.path, '{"type":"snapshot"\n');
    expect(() => outbox.pendingSnapshots()).toThrow(/malformed outbox record at line 2/);
  });
});
