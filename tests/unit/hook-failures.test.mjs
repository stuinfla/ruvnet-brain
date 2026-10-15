// ADR-106: an advisory hook that fails open is recorded by the REAL shim and reported ONCE at
// SessionStart. Before this, a throwing body exited 0 with nothing on disk (measured 2026-10-11).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { FAILURE_FILE, FAILURE_LINE_PREFIX, failureLine } from '../../plugin/scripts/hook-failures.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHIM = path.join(ROOT, 'plugin/scripts/hook-shim.mjs');
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; };

/** A dev-mode spine whose bodies we control, so the REAL shim dispatches to them. */
function spine(bodies) {
  const brainHome = tmp('hf-bh-'); const code = tmp('hf-code-');
  fs.mkdirSync(path.join(code, 'scripts'));
  for (const [file, src] of Object.entries(bodies)) fs.writeFileSync(path.join(code, 'scripts', file), src);
  fs.writeFileSync(path.join(brainHome, 'dev.json'), JSON.stringify({ codeRoot: code }));
  return brainHome;
}
const fire = (brainHome, id, ...args) => spawnSync(process.execPath, [SHIM, id, ...args], {
  input: '{"hook_event_name":"Stop","session_id":"s"}', encoding: 'utf8', timeout: 20_000,
  env: { ...process.env, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: tmp('hf-state-') },
});

describe('hook failures are recorded, then reported once', () => {
  it('a crashing advisory body still exits 0 to the host, but leaves one record per failure', () => {
    const bh = spine({ 'continuation-gate.mjs': "throw new Error('boom')", 'session-snapshot-hook.mjs': 'process.exit(7)' });
    expect(fire(bh, 'continuation-gate').status).toBe(0);
    expect(fire(bh, 'continuation-gate').status).toBe(0);
    expect(fire(bh, 'session-snapshot', 'Stop').status).toBe(0);
    const rows = fs.readFileSync(path.join(bh, FAILURE_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.hook, r.status])).toEqual([['continuation-gate', 1], ['continuation-gate', 1], ['session-snapshot', 7]]);
    expect(rows[2].event).toBe('Stop');
    const line = failureLine(bh);
    expect(line.startsWith(FAILURE_LINE_PREFIX)).toBe(true);
    expect(line).toMatch(/3 advisory hook run\(s\)/);
    expect(line).toMatch(/continuation-gate ×2 \(exit 1\); session-snapshot ×1 \(exit 7\)/);
    expect(failureLine(bh)).toBe('');              // reported once
    expect(fire(bh, 'continuation-gate').status).toBe(0);
    expect(failureLine(bh)).toMatch(/1 advisory hook run\(s\).*continuation-gate ×1/); // a NEW failure is news again
  });

  it('records nothing for a body that succeeds, or for a blocking refusal (exit 2 is its contract)', () => {
    const bh = spine({ 'continuation-gate.mjs': 'process.exit(0)', 'decision-gate.mjs': 'process.exit(2)' });
    expect(fire(bh, 'continuation-gate').status).toBe(0);
    expect(fire(bh, 'decision-gate', 'write').status).toBe(2);
    expect(fs.existsSync(path.join(bh, FAILURE_FILE))).toBe(false);
    expect(failureLine(bh)).toBe('');
  });

  it('the shim writes the exact file name the reader reads (boot-frozen copy held by this test)', () => {
    expect(fs.readFileSync(SHIM, 'utf8')).toContain(`'${FAILURE_FILE}'`);
  });

  it('SessionStart prints the summary line', async () => {
    const bh = spine({ 'md-stamp.mjs': 'process.exit(3)' });
    expect(fire(bh, 'md-stamp').status).toBe(0);
    const { runSessionStart } = await import('../../plugin/scripts/session-start-core.mjs');
    let out = '';
    const home = tmp('hf-home-');
    await runSessionStart({ env: { ...process.env, HOME: home, RUVNET_BRAIN_HOME: bh, RUVNET_BRAIN_STATE_DIR: tmp('hf-state-'), RUVNET_TURN_CAPTURE: 'off' },
      cwd: tmp('hf-cwd-'), stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} }, runHeartbeat: false,
      restoreContinuity: async () => ({ context: '' }) });
    expect(out).toContain(`${FAILURE_LINE_PREFIX} 1 advisory hook run(s)`);
    expect(out).toMatch(/md-stamp ×1 \(exit 3\)/);
  }, 30_000);
});

describe('the shim watchdog stops a body before the host does (ADR-106)', () => {
  it('kills a body that sleeps past (registered timeout - 1.5 s), emits nothing partial, exits 0 and records it', () => {
    const bh = spine({ 'continuation-gate.mjs': "process.stdout.write('{\"decision\":\"block\",\"reason\":\"partial');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);" });
    const pluginRoot = tmp('hf-plugin-'); fs.mkdirSync(path.join(pluginRoot, 'hooks'));
    fs.writeFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '*', hooks: [
      { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" continuation-gate || true', timeout: 3 }] }] } }));
    const t = performance.now();
    const r = spawnSync(process.execPath, [SHIM, 'continuation-gate'], { input: '{"hook_event_name":"Stop","session_id":"s"}', encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, RUVNET_BRAIN_HOME: bh, RUVNET_BRAIN_STATE_DIR: tmp('hf-state-'), CLAUDE_PLUGIN_ROOT: pluginRoot, RUVNET_HOOK_HOST: '' } });
    const ms = performance.now() - t;
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');                       // nothing partial reaches the host
    expect(ms).toBeGreaterThan(1400); expect(ms).toBeLessThan(2900); // 3 s registered - 1.5 s margin, before the host's 3 s
    const rows = fs.readFileSync(path.join(bh, FAILURE_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([expect.objectContaining({ hook: 'continuation-gate', error: 'timed-out-internally', limitMs: 1500 })]);
    expect(failureLine(bh)).toMatch(/continuation-gate ×1 \(timed-out-internally\)/);
  }, 30_000);
});
