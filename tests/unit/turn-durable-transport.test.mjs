import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { fixture as baseFixture, outcome, ROOT } from '../helpers/turn-capture-process.mjs';
import { captureTurnOutcome, replayTurnQueue, runSteps } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { pendingTurnFiles, readJournal } from '../../plugin/scripts/turn-transport-journal.mjs';

function fixture() { const f = baseFixture(); f.env.RUVNET_TURN_CAPTURE = 'force'; return f; }

function capture(f, launch = () => ({ launched: true })) {
  return captureTurnOutcome({ projectDir: f.project, event: 'Stop', host: 'codex', env: f.env, home: f.home,
    payload: { session_id: 'durable-synthetic', last_assistant_message: outcome }, launch });
}
function freshReplay(f) {
  const source = `import {replayTurnQueue} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'plugin/scripts/turn-outcome-capture.mjs')).href)};
process.stdout.write(JSON.stringify(replayTurnQueue({projectDir:process.cwd(),synchronous:true,deadlineMs:Date.now()+20000})));`;
  return JSON.parse(f.command(process.execPath, ['--input-type=module', '-e', source]).stdout);
}

describe('durable turn transport with native global Ruflo over synthetic content', () => {
  it('survives a killed detached worker and removed transcript, then a fresh process records exactly once', async () => {
    const f = fixture(); let worker; let workerReady;
    try {
      f.initialize();
      const transcript = path.join(f.root, 'removed-transcript.jsonl'); fs.writeFileSync(transcript, '{}');
      const report = capture(f, (steps) => {
        const requests = steps.map((step) => ({ kind: 'journal', journalFile: step.journalFile, db: step.args[step.args.indexOf('--path') + 1] }));
        const source = `import {runSteps} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'plugin/scripts/turn-outcome-capture.mjs')).href)};
runSteps(${JSON.stringify({ steps: requests })}, {projectDir:${JSON.stringify(f.project)}, brainHome:${JSON.stringify(f.brainHome)}, run:()=>{process.stdout.write('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);return {status:1};}});`;
        worker = spawn(process.execPath, ['--input-type=module', '-e', source], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
        workerReady = new Promise((resolve, reject) => { worker.stdout.once('data', resolve); worker.once('error', reject); worker.once('exit', () => reject(new Error('worker exited before pause'))); });
        return { launched: true, pid: worker.pid };
      });
      await workerReady;
      worker.kill('SIGKILL'); await new Promise((resolve) => worker.once('exit', resolve));
      fs.unlinkSync(transcript);
      const db = path.join(f.project, '.swarm', 'memory.db');
      const [file] = pendingTurnFiles(db); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(readJournal(file, db).schemaVersion).toBe(2);
      expect(readJournal(file, db)).not.toHaveProperty('step');
      expect(freshReplay(f)).toMatchObject({ failed: 0, verified: 1, pending: 0 });
      expect(f.retrieve(report.key)).toBe(report.value);
      const count = f.command('sqlite3', [db, `SELECT COUNT(*) FROM memory_entries WHERE namespace='turns' AND key='${report.key.replaceAll("'", "''")}';`]).stdout.trim();
      expect(count).toBe('1');
      expect(freshReplay(f)).toMatchObject({ count: 0 });
      const stores = fs.readFileSync(f.argvLog, 'utf8').trim().split('\n').map(JSON.parse)
        .filter((args) => args[1] === 'store' && args.includes(report.key));
      expect(stores).toHaveLength(1);
    } finally { worker?.kill('SIGKILL'); f.cleanup(); }
  }, 60000);

  it('replays a store committed before its receipt without another store or upsert', () => {
    const f = fixture(); try {
      f.initialize(); const report = capture(f); const db = path.join(f.project, '.swarm', 'memory.db');
      const [file] = pendingTurnFiles(db); const record = readJournal(file, db);
      const rows = runSteps({ steps: [{ kind: 'journal', journalFile: file, db }] }, { env: f.env, projectDir: f.project });
      expect(rows[0].verified).toBe(true); expect(pendingTurnFiles(db)).toHaveLength(1);
      expect(freshReplay(f)).toMatchObject({ failed: 0, verified: 1, pending: 0 });
      const stores = fs.readFileSync(f.argvLog, 'utf8').trim().split('\n').map(JSON.parse)
        .filter((args) => args[1] === 'store' && args.includes(report.key));
      expect(stores).toHaveLength(1);
    } finally { f.cleanup(); }
  }, 60000);

  it('suspends consent-off and malformed consent queues without touching content or launching', () => {
    const f = fixture(); try {
      f.initialize(); capture(f); const db = path.join(f.project, '.swarm', 'memory.db');
      const [file] = pendingTurnFiles(db); const before = fs.readFileSync(file);
      f.policy({ [f.project]: 'off' });
      expect(freshReplay(f).skipped).toContain('opt-out');
      f.policy({ [f.project]: true });
      expect(freshReplay(f).skipped).toContain('invalid');
      expect(fs.readFileSync(file)).toEqual(before);
      f.policy({ [f.project]: 'on' }); expect(freshReplay(f).verified).toBe(1);
    } finally { f.cleanup(); }
  }, 60000);

  it('rejects journal symlinks and hard links while preserving unrelated queued files', () => {
    const f = fixture(); try {
      f.initialize(); capture(f); const db = path.join(f.project, '.swarm', 'memory.db');
      const [file] = pendingTurnFiles(db); const saved = `${file}.saved`; fs.renameSync(file, saved);
      fs.symlinkSync(saved, file);
      expect(freshReplay(f).failed).toBe(1); expect(fs.existsSync(saved)).toBe(true);
      fs.unlinkSync(file); fs.linkSync(saved, file);
      expect(freshReplay(f).failed).toBe(1); expect(fs.statSync(saved).nlink).toBe(2);
      fs.unlinkSync(file); fs.renameSync(saved, file); expect(freshReplay(f).verified).toBe(1);
    } finally { f.cleanup(); }
  }, 60000);

  it('rejects a replaced canonical root even at the same path', () => {
    const f = fixture(); try {
      f.initialize(); capture(f); const saved = `${f.project}.saved`; fs.renameSync(f.project, saved);
      fs.mkdirSync(f.project); fs.renameSync(path.join(saved, '.swarm'), path.join(f.project, '.swarm'));
      expect(freshReplay(f)).toMatchObject({ failed: 1, pending: 1 });
      const rows = f.receipts(); expect(rows.at(-1).error).toContain('identity changed');
    } finally { f.cleanup(); }
  }, 60000);
  it('the recovery oracle rejects a source-bound hash-only mutation rather than vacuously passing', async () => {
    const f = fixture(); try {
      f.initialize();
      const original = fs.readFileSync(path.join(ROOT, 'plugin/scripts/turn-outcome-capture.mjs'), 'utf8');
      const durableWrite = 'step.journalFile = journalTurn(step, db, report.key, { onDurability: (evidence) => { report.durability = evidence; } });';
      expect(original).toContain(durableWrite);
      // Preserve the legacy hash-only breadcrumb and spawn path, remove only durable content.
      const mutant = original.replace(durableWrite, '// mutation: hash-only breadcrumb, no durable turn content');
      const oldFile = path.join(f.root, 'old-capture.mjs');
      fs.writeFileSync(oldFile, mutant.replace(/from '(\.\/[^']+)'/g,
        (_, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(ROOT, 'plugin/scripts', relative)).href)}`));
      const old = await import(pathToFileURL(oldFile).href);
      const report = old.captureTurnOutcome({ projectDir: f.project, event: 'Stop', host: 'codex', env: f.env, home: f.home,
        payload: { session_id: 'durable-synthetic', last_assistant_message: outcome }, launch: () => ({ launched: true }) });
      expect(report.queued).toBe(true);
      const recovered = freshReplay(f);
      expect(() => expect(recovered).toMatchObject({ verified: 1, pending: 0 })).toThrow();
      expect(recovered).toMatchObject({ count: 0 });
    } finally { f.cleanup(); }
  }, 60000);

});
