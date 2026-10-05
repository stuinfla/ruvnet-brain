import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-containment-'))); roots.push(root);
  fs.mkdirSync(path.join(root, '.swarm')); return root;
}

describe('outbox historical payload retention containment (#390 A, partial)', () => {
  it('reads 128 MiB of unique committed history under a 64 MiB JS heap without altering evidence', () => {
    const root = project(); const outbox = new ProgressionOutbox({ projectRoot: root });
    const fd = fs.openSync(outbox.path, 'w');
    const hash = createHash('sha256');
    for (let i = 0; i < 1024; i += 1) {
      const eventKey = `event-${String(i).padStart(6, '0')}`; const payloadDigest = `digest-${i}`;
      const text = `${JSON.stringify({ type: 'snapshot', eventKey, payloadDigest, snapshot: { eventKey, payloadDigest, evidence: `${i}:` + 'x'.repeat(128 * 1024) } })}\n`
        + `${JSON.stringify({ type: 'commit', eventKey, payloadDigest })}\n`;
      fs.writeSync(fd, text); hash.update(text);
    }
    for (const eventKey of ['pending-z', 'pending-a']) {
      const text = `${JSON.stringify({ type: 'snapshot', eventKey, payloadDigest: eventKey, snapshot: { eventKey, payloadDigest: eventKey } })}\n`;
      fs.writeSync(fd, text); hash.update(text);
    }
    fs.closeSync(fd);
    const before = hash.digest('hex');
    const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e',
      `import { ProgressionOutbox } from ${JSON.stringify(new URL('../../plugin/scripts/project-progression-outbox.mjs', import.meta.url).href)};
       const outbox = new ProgressionOutbox({projectRoot:process.argv[1]});
       console.log(JSON.stringify({pending:outbox.pendingSnapshots().map(s=>s.eventKey),quarantine:outbox.quarantine}));`, root],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ pending: ['pending-a', 'pending-z'], quarantine: [] });
    expect(createHash('sha256').update(fs.readFileSync(outbox.path)).digest('hex')).toBe(before);
  });

  it('retains the latest duplicate payload and collision quarantine across the second scan', () => {
    const outbox = new ProgressionOutbox({ projectRoot: project() });
    outbox.appendSnapshot({ eventKey: 'z', payloadDigest: 'same', content: 'first' });
    outbox.appendSnapshot({ eventKey: 'z', payloadDigest: 'same', content: 'last' });
    outbox.appendSnapshot({ eventKey: 'a', payloadDigest: 'old' });
    outbox.appendSnapshot({ eventKey: 'a', payloadDigest: 'conflict' });
    const bytes = fs.readFileSync(outbox.path);
    expect(outbox.pendingSnapshots()).toEqual([{ eventKey: 'z', payloadDigest: 'same', content: 'last' }]);
    expect(outbox.quarantinedKeys()).toEqual([{ eventKey: 'a', reason: 'outbox event key collision' }]);
    expect(fs.readFileSync(outbox.path)).toEqual(bytes);
  });
});
