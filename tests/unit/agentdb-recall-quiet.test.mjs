// A recall that timed out finds nothing; it must say nothing unless RUVNET_STOP_NUDGES=full (owner, 2026-10-15).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { recallIsWorthSurfacing } from '../../plugin/scripts/agentdb-recall.mjs';

const SCRIPT = path.resolve('plugin/scripts/agentdb-recall.mjs');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function recallOut(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-quiet-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.swarm'));
  fs.writeFileSync(path.join(dir, '.swarm', 'memory.db'), '');
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ prompt: 'what did we decide about the retry policy for the updater', cwd: dir }),
    env: { ...process.env, HOME: dir, RUVNET_BRAIN_HOME: path.join(dir, 'brain'), RUVNET_AGENTDB_RECALL_MS: '1', ...extraEnv } });
  return r.stdout;
}

describe('recall noise (pure decision)', () => {
  const timedOut = { block: '[AgentDB recall]\nRecall timed out; no records verified.', picks: [], outcome: 'timed-out' };
  it('silences a timed-out recall with no picks, unless full', () => {
    expect(recallIsWorthSurfacing(timedOut, {})).toBe(false);
    expect(recallIsWorthSurfacing(timedOut, { RUVNET_STOP_NUDGES: 'full' })).toBe(true);
  });
  it('still surfaces a recall that found something', () => {
    expect(recallIsWorthSurfacing({ block: 'x', picks: [{}], outcome: 'timed-out' }, {})).toBe(true);
    expect(recallIsWorthSurfacing({ block: 'Found it', picks: [], outcome: 'ok' }, {})).toBe(true);
  });
});

describe('recall noise', () => {
  it('a timed-out or unavailable recall is silent by default', () => {
    expect(recallOut({ RUVNET_STOP_NUDGES: '' })).toBe('');
  });
  it('the status line is still available in full mode', () => {
    const out = recallOut({ RUVNET_STOP_NUDGES: 'full' });
    expect(out === '' || /timed out|unavailable|no records/i.test(out)).toBe(true);
  });
});
