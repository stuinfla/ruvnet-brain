import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixture, outcome, ROOT } from '../helpers/turn-capture-process.mjs';
import { captureTurnOutcome } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { pendingTurnFiles } from '../../plugin/scripts/turn-transport-journal.mjs';

function firstStart(f, extraEnv = {}) {
  const source = `import {restoreProgressionForSession} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'plugin/scripts/project-progression-session-start.mjs')).href)};
process.stdout.write(JSON.stringify(restoreProgressionForSession()));`;
  const started = Date.now();
  const result = JSON.parse(f.command(process.execPath, ['--input-type=module', '-e', source],
    { env: { ...f.env, CLAUDE_PROJECT_DIR: f.project, ...extraEnv } }).stdout);
  return { result, elapsedMs: Date.now() - started };
}
function queue(f) {
  f.env.RUVNET_TURN_CAPTURE = 'force';
  return captureTurnOutcome({ projectDir: f.project, event: 'Stop', host: 'codex', env: f.env, home: f.home,
    payload: { session_id: 'startup-lost-worker', last_assistant_message: outcome,
      transcript_path: path.join(f.root, 'missing-private-transcript.jsonl') }, launch: () => ({ launched: true }) });
}

describe('fresh process SessionStart replays turns automatically', () => {
  it('exactly records the orphaned turn on first startup without a private transcript', () => {
    const f = fixture(); try {
      f.initialize(); const report = queue(f); expect(report.queued, JSON.stringify(report)).toBe(true);
      const db = path.join(f.project, '.swarm', 'memory.db'); expect(pendingTurnFiles(db)).toHaveLength(1);
      const { result, elapsedMs } = firstStart(f);
      expect(result.status).toBe('empty');
      expect(pendingTurnFiles(db)).toEqual([]);
      expect(f.retrieve(report.key)).toBe(report.value);
      expect(f.receipts().find((row) => row.key === report.key)).toMatchObject({ status: 0, verified: true });
      expect(elapsedMs).toBeLessThan(3500);
      console.info(JSON.stringify({ proof: 'fresh-process-first-start-turn-replay', elapsedMs, privateTranscript: false }));
    } finally { f.cleanup(); }
  }, 30000);

  it('refused turn replay stays durable and returns UNKNOWN instead of older state', () => {
    const f = fixture(); try {
      f.initialize(); queue(f); const db = path.join(f.project, '.swarm', 'memory.db');
      const { result } = firstStart(f, { PROBE_FAIL: '1' });
      expect(result).toMatchObject({ status: 'unknown', reason: 'outbox-replay', pendingTurns: 1 });
      expect(result.context).not.toContain('PROJECT CONTINUITY RESTORED');
      expect(pendingTurnFiles(db)).toHaveLength(1);
    } finally { f.cleanup(); }
  }, 30000);

  it('fresh persisted opt-out suspends the journal before any replay write', () => {
    const f = fixture(); try {
      f.initialize(); queue(f); const db = path.join(f.project, '.swarm', 'memory.db');
      const [file] = pendingTurnFiles(db); const before = fs.readFileSync(file);
      f.policy({ [f.project]: 'off' }); const callsBefore = fs.readFileSync(f.argvLog, 'utf8');
      const { result } = firstStart(f);
      expect(result.status).toBe('empty');
      expect(fs.readFileSync(file)).toEqual(before);
      expect(fs.readFileSync(f.argvLog, 'utf8')).toBe(callsBefore);
    } finally { f.cleanup(); }
  }, 30000);
});
