// An old-booted session must not announce "vX is downloading" when vX is already the ACTIVE generation (D5).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { heartbeat } from '../../plugin/scripts/session-start-update-plane.mjs';

const temps = [];
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

function beat({ running, active, remote }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-announce-'));
  const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-announce-hooks-'));
  temps.push(home, hookDir);
  const stateDir = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'active.json'), JSON.stringify({ version: active }));
  fs.writeFileSync(path.join(stateDir, '.last-version-check.log'), `${remote}\n`);
  const emitted = [];
  heartbeat({ env: { HOME: home }, hookDir, stateDir, home, running, seedDispatched: false,
    stamp: path.join(stateDir, '.last-update-check'), emit: (l) => emitted.push(l), now: Date.now() });
  return emitted.join('\n');
}

describe('update announcement vs the active generation', () => {
  it('is silent when the remote version is already active', () => {
    expect(beat({ running: '3.1.0', active: '3.1.1', remote: '3.1.1' })).toBe('');
  });
  it('is silent when the active generation is newer than the remote', () => {
    expect(beat({ running: '3.1.0', active: '3.1.2', remote: '3.1.1' })).toBe('');
  });
  it('still announces a remote version newer than the active generation', () => {
    expect(beat({ running: '3.1.0', active: '3.1.1', remote: '3.1.2' })).toContain('3.1.2');
  });
});
