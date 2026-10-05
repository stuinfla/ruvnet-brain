import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../helpers/continuity-fixture.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })));

function project() {
  const p = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-trust-')));
  fs.mkdirSync(path.join(p, '.swarm'));
  createStore(path.join(p, '.swarm', 'memory.db'));
  dirs.push(p);
  return p;
}

function queueFiles(projectDir) {
  const swarm = path.join(projectDir, '.swarm');
  if (!fs.existsSync(swarm)) return [];
  return fs.readdirSync(swarm).filter((name) => name.startsWith('.progression-capture-queue-'));
}

const script = fileURLToPath(new URL('../../plugin/scripts/session-snapshot-hook.mjs', import.meta.url));

describe('session-snapshot-hook per-tool-call entrypoint trusts payload.cwd only when it names the real project', () => {
  it('a relative payload.cwd naming a nested stranger project must not redirect the capture there', () => {
    const real = project();
    // A nested "stranger" project living inside the real one (e.g. a vendored dependency) with its
    // own independently-adopted .swarm store — the shape PR #348 already hardened for a symlinked
    // .swarm, but reachable here through the hook's OWN unvalidated payload.cwd, no symlink needed.
    const strangerRel = path.join('vendor', 'dep-repo');
    const strangerAbs = path.join(real, strangerRel);
    fs.mkdirSync(path.join(strangerAbs, '.swarm'), { recursive: true });
    createStore(path.join(strangerAbs, '.swarm', 'memory.db'));

    const result = spawnSync(process.execPath, [script, 'PreToolUse'], {
      cwd: real,
      input: JSON.stringify({ cwd: strangerRel, session_id: 'cwd-trust-1', tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, RUVNET_BRAIN_HOME: real },
    });
    expect(result.status).toBe(0);

    // The capture must be queued against the real project this hook is actually running in, never
    // against whatever relative path a host payload happens to name.
    expect(queueFiles(real).length).toBeGreaterThan(0);
    expect(queueFiles(strangerAbs)).toHaveLength(0);
  });

  it('an absolute payload.cwd (the host-trusted shape) still resolves normally', () => {
    const real = project();
    const result = spawnSync(process.execPath, [script, 'PreToolUse'], {
      cwd: real,
      input: JSON.stringify({ cwd: real, session_id: 'cwd-trust-2', tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, RUVNET_BRAIN_HOME: real },
    });
    expect(result.status).toBe(0);
    expect(queueFiles(real).length).toBeGreaterThan(0);
  });
});
