// #377 residual (2026-10-30): on the detached hook path the PARENT marked an observation "captured" before the
// child had stored anything. A child whose store or exact readback failed therefore left the key acknowledged for
// the whole COALESCE_MS window, and every identical observation in that window was silently dropped as a
// "duplicate" of a write that never happened. Now only the child acknowledges, and only after the exact readback.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, tmp } from '../helpers/continuity-fixture.mjs';
import { slowRuflo, ledgerRows, storedRows, until } from '../helpers/slow-ruflo.mjs';
import { captureInFlight, recentlyCaptured } from '../../plugin/scripts/learn-capture.mjs';
import { observationKey } from '../../plugin/scripts/learning-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const LEARN = path.join(ROOT, 'plugin/scripts/learn-capture.mjs');
const posix = process.platform !== 'win32';
afterEach(() => cleanup());

function learner(opts) {
  const home = fs.realpathSync.native(tmp('ack-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'global-memory', '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db'), '');
  fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}');
  const stubDir = tmp('ack-ruflo-'); const stub = slowRuflo(stubDir, opts); const brainHome = tmp('ack-bh-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, RUVNET_LEARNING_SCOPE: 'user',
    RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain') };
  return { home, stub, stubDir, brainHome, env };
}
const payload = (command, session = 'ack') => ({ hook_event_name: 'PostToolUse', session_id: session, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok' } });
function drive(l, payloads) {
  const code = `import { captureLearning } from ${JSON.stringify(pathToFileURL(LEARN).href)};
    process.stdout.write(JSON.stringify(${JSON.stringify(payloads)}.map((p) => captureLearning(p, { env: process.env, binary: ${JSON.stringify(l.stub.bin)}, brainHome: ${JSON.stringify(l.brainHome)}, detach: true }))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: l.env, cwd: l.home, encoding: 'utf8', timeout: 20_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
const slotsEmpty = (brainHome) => { try { return fs.readdirSync(path.join(brainHome, 'learn-capture', 'slots')).length === 0; } catch { return true; } };
const KEY = observationKey({ session: 'ack', tool: 'Bash', action: 'npm test' });

describe('#377 an observation is acknowledged only after its exact readback', () => {
  it.skipIf(!posix)('a refused store leaves NO captured marker, so the next identical observation is tried again', async () => {
    const l = learner({ refuse: true });
    expect(drive(l, [payload('npm test')])).toEqual([true]);
    expect(await until(() => slotsEmpty(l.brainHome) && ledgerRows(l.brainHome).length > 0, 15_000), 'the child finished and was loud').toBe(true);
    expect(recentlyCaptured(l.brainHome, KEY)).toBe(false); // before the fix: true for 10 minutes
    expect(captureInFlight(l.brainHome, KEY)).toBe(false);  // the failed child cleared its in-flight mark
    expect(Object.keys(storedRows(l.stubDir))).toHaveLength(0);
    // The identical observation is attempted again, not swallowed as a "duplicate".
    const storesBefore = l.stub.calls().filter((c) => c.argv[1] === 'store').length;
    expect(drive(l, [payload('npm test')])).toEqual([true]);
    expect(await until(() => l.stub.calls().filter((c) => c.argv[1] === 'store').length > storesBefore, 15_000)).toBe(true);
  }, 45_000);

  it.skipIf(!posix)('a successful store is acknowledged by the child after readback; the parent only marks it in flight', async () => {
    const l = learner({ delayMs: 1500 });
    expect(drive(l, [payload('npm test')])).toEqual([true]);
    // While the child is still storing, the key is in flight but NOT acknowledged.
    expect(captureInFlight(l.brainHome, KEY)).toBe(true);
    expect(recentlyCaptured(l.brainHome, KEY)).toBe(false);
    // A second identical observation while the first is in flight spawns nothing.
    expect(drive(l, [payload('npm test')])).toEqual([true]);
    expect(await until(() => recentlyCaptured(l.brainHome, KEY), 15_000), 'acknowledged after readback').toBe(true);
    expect(l.stub.calls().some((c) => c.argv[1] === 'retrieve')).toBe(true);
    expect(await until(() => !captureInFlight(l.brainHome, KEY) && slotsEmpty(l.brainHome), 10_000)).toBe(true);
    expect(l.stub.calls().filter((c) => c.argv[1] === 'store')).toHaveLength(1);
    expect(Object.keys(storedRows(l.stubDir))).toHaveLength(1);
    expect(ledgerRows(l.brainHome)).toEqual([]);
  }, 45_000);
});
