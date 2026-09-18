import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';

const roots = [];
const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugin/scripts/project-progression-outbox.mjs')).href;
function root() {
  const value = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-outbox-concurrent-')));
  roots.push(value);
  return value;
}
afterEach(() => { for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }); });

describe('ProjectProgression outbox concurrent publishers', () => {
  it('publishes every record from independent Node processes without interleaving', async () => {
    const projectRoot = root();
    const source = `import { ProgressionOutbox } from ${JSON.stringify(moduleUrl)};
      const outbox = new ProgressionOutbox({projectRoot: process.argv[1]});
      for (let i = 0; i < 12; i++) outbox.appendSnapshot({eventKey: 'worker-' + process.argv[2] + '-' + i, payloadDigest: (process.argv[2] + i).padEnd(64, 'x'), completeProjectState: {blob: 'x'.repeat(12000)}});`;
    const workers = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, projectRoot, String(index)], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`worker ${index}: ${code}/${signal}`)));
    }));
    await Promise.all(workers);
    const pending = new ProgressionOutbox({ projectRoot }).pendingSnapshots();
    expect(pending).toHaveLength(48);
    expect(new Set(pending.map((row) => row.eventKey)).size).toBe(48);
  }, 120_000);

  it.runIf(process.platform !== 'win32')('recovers when a writer is killed before or immediately after publication', async () => {
    const projectRoot = root();
    const run = (stage, eventKey) => new Promise((resolve, reject) => {
      const source = `import fs from 'node:fs'; import { ProgressionOutbox } from ${JSON.stringify(moduleUrl)};
        const mode = process.argv[2]; const outbox = new ProgressionOutbox({projectRoot: process.argv[1], io: {
          writeSync(fd,b,o,l) { const n = fs.writeSync(fd,b,o,Math.min(l, mode === 'before' ? 1 : l)); if (mode === 'before' && !globalThis.paused) { globalThis.paused=true; fs.writeSync(3,'before'); process.kill(process.pid,'SIGSTOP'); } return n; },
          renameSync(a,b) { fs.renameSync(a,b); fs.writeSync(3,'after'); process.kill(process.pid,'SIGSTOP'); }
        }}); outbox.appendSnapshot({eventKey: process.argv[3], payloadDigest: process.argv[3].padEnd(64,'x'), completeProjectState:{}});`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, projectRoot, stage, eventKey], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
      let killed = false;
      child.stdio[3].once('data', (message) => { if (String(message) === stage) { killed = true; child.kill('SIGKILL'); } });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (killed && signal === 'SIGKILL') resolve();
        else reject(new Error(`${stage} child exited ${code}/${signal}`));
      });
    });
    await run('before', 'killed-before');
    await run('after', 'killed-after');
    const pending = new ProgressionOutbox({ projectRoot }).pendingSnapshots();
    expect(pending.map((row) => row.eventKey)).toEqual(['killed-after']);
  }, 30_000);

  it.runIf(process.platform !== 'win32')('does not steal a paused live writer beyond the old stale threshold', async () => {
    const projectRoot = root();
    const source = `import fs from 'node:fs'; import { ProgressionOutbox } from ${JSON.stringify(moduleUrl)};
      let paused=false; const outbox=new ProgressionOutbox({projectRoot:process.argv[1],io:{writeSync(fd,b,o,l){const n=fs.writeSync(fd,b,o,Math.min(l,1)); if(!paused){paused=true; fs.writeSync(3,'paused'); process.kill(process.pid,'SIGSTOP');} return n;}}});
      outbox.appendSnapshot({eventKey:'paused-live',payloadDigest:'paused-live'.padEnd(64,'x'),completeProjectState:{}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, projectRoot], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => { child.stdio[3].once('data', (message) => String(message) === 'paused' ? resolve() : reject(new Error('unexpected barrier'))); child.once('error', reject); });
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      new ProgressionOutbox({ projectRoot }).appendSnapshot({ eventKey: 'other-writer', payloadDigest: 'other-writer'.padEnd(64, 'x'), completeProjectState: {} });
      child.kill('SIGCONT');
      await new Promise((resolve, reject) => { child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`paused writer exited ${code}`))); child.once('error', reject); });
      const pending = new ProgressionOutbox({ projectRoot }).pendingSnapshots();
      expect(new Set(pending.map((row) => row.eventKey))).toEqual(new Set(['paused-live', 'other-writer']));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGCONT');
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
  }, 45_000);
});
