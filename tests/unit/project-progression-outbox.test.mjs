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

  it('fails closed when one event key carries divergent snapshot digests', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    outbox.appendSnapshot(snapshot());
    outbox.appendSnapshot(snapshot({ payloadDigest: 'b'.repeat(64) }));

    expect(() => outbox.pendingSnapshots()).toThrow(/event key collision/i);
  });

  it('ignores only a crash-truncated final line while retaining complete snapshots', () => {
    const outbox = new ProgressionOutbox({ projectRoot: temporaryRoot() });
    outbox.appendSnapshot(snapshot());
    fs.appendFileSync(outbox.path, '{"type":"snapshot"');

    expect(outbox.pendingSnapshots()).toEqual([snapshot()]);
  });
});
