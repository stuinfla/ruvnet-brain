import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const temps = [];
let install;

beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  install = await import('../../bin/install.mjs');
});

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('issue #77 installed host convergence boundary', () => {
  it('activates Stable Spine and Console runtime as one exact candidate receipt', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-issue77-host-'));
    temps.push(home);
    const kb = path.join(home, 'kb');
    const brainHome = path.join(home, 'brain');
    fs.mkdirSync(kb, { recursive: true });

    const result = install.syncHostsAfterUpdate(kb, {
      sourceRoot: ROOT,
      brainHome,
      wireClaude: () => ({ host: true, wired: true, version: VERSION }),
      wireCodexHost: () => ({ host: true, wired: true, action: 'unchanged' }),
      wireCodexPlugin: () => ({ action: 'updated', installed: true, enabled: true, version: VERSION }),
      runStableSpine: () => ({ status: 0, error: undefined }),
    });

    expect(result.ok).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(path.join(brainHome, 'host-convergence.json'), 'utf8'));
    expect(receipt).toMatchObject({
      desiredVersion: VERSION,
      hosts: {
        claude: { state: 'ready', version: VERSION },
        codex: { state: 'ready', version: VERSION },
      },
      consoleRuntime: { runtimeVersion: VERSION, state: 'ready' },
    });
    const runtimeManifest = JSON.parse(fs.readFileSync(
      path.join(kb, '.console-runtime', 'package.json'), 'utf8',
    ));
    expect(runtimeManifest.version).toBe(VERSION);
    expect(fs.existsSync(path.join(kb, '.console-runtime', 'scripts', 'onboarding-console.mjs'))).toBe(true);
  });

  it('rolls back the staged Console candidate when either host cannot converge', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-issue77-rollback-'));
    temps.push(home);
    const kb = path.join(home, 'kb');
    fs.mkdirSync(kb, { recursive: true });
    const active = path.join(kb, '.console-runtime');
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'sentinel.txt'), 'candidate-a');

    const result = install.syncHostsAfterUpdate(kb, {
      sourceRoot: ROOT,
      brainHome: path.join(home, 'brain'),
      wireClaude: () => ({ host: true, wired: true, version: VERSION }),
      wireCodexHost: () => ({ host: true, wired: true }),
      wireCodexPlugin: () => ({ action: 'verification-failed', version: 'candidate-a' }),
      runStableSpine: () => ({ status: 0, error: undefined }),
    });

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(active, 'sentinel.txt'), 'utf8')).toBe('candidate-a');
    expect(fs.existsSync(path.join(home, 'brain', 'host-convergence.json'))).toBe(false);
  });

  it('keeps a running stale Console explicitly non-converged until restart', () => {
    const receipt = {
      desiredVersion: VERSION,
      hosts: {
        claude: { state: 'ready', version: VERSION },
        codex: { state: 'disabled', version: VERSION },
      },
      consoleRuntime: { state: 'pending-console-restart', runtimeVersion: VERSION },
    };
    expect(install.classifyHostConvergence(receipt)).toMatchObject({
      healthy: false,
      state: 'pending-console-restart',
    });
  });

  // 4.4.1 — owner's Mac, 4.3.40 -> 4.4.0: KB applied, spine flipped, Console replaced, a fresh `claude -p`
  // loaded 4.4.0 and ran its hooks — yet the update ended "host-restart-required … runtime stays on the
  // prior verified generation" and EXIT 1, because hooks.json/hook-shim.mjs (boot-level) changed. Only
  // windows already open booted the old declarations; that is a notice, not a failure.
  it('a PROVEN boot-declaration change is converged: new sessions use it, open windows are told to reopen', () => {
    const receipt = {
      desiredVersion: VERSION,
      hosts: {
        claude: { state: 'ready', version: VERSION, restartRequired: true, restartScope: 'open-sessions',
          sessionSafety: 'restart-required', sessionSafetyReason: 'boot-level declarations changed: hooks/hooks.json, scripts/hook-shim.mjs' },
        codex: { state: 'absent', version: null },
      },
      consoleRuntime: { state: 'ready', runtimeVersion: VERSION },
    };
    expect(install.classifyHostConvergence(receipt)).toEqual({ healthy: true, state: 'channels-converged',
      openSessions: ['claude'],
      notice: `new Claude Code sessions use ${VERSION}; already-open windows keep the old hook definitions until they are reopened` });
    // Codex is never 'open-sessions' (changed hooks are PENDING until reviewed in /hooks): a Codex boot
    // change stays a restart, exit 1, beside a converged Claude.
    expect(install.classifyHostConvergence({ ...receipt, hosts: { ...receipt.hosts,
      codex: { state: 'ready', version: VERSION, restartRequired: true, restartScope: 'unproven', sessionSafetyReason: 'boot-level declarations changed: hooks/hooks.json' } } }))
      .toEqual({ healthy: false, state: 'host-restart-required', action: 'boot-level declarations changed: hooks/hooks.json' });
    // An UNPROVEN boot surface (it could not be compared) still requires a restart.
    expect(install.classifyHostConvergence({ ...receipt, hosts: { claude: { ...receipt.hosts.claude, restartScope: 'unproven' } } }))
      .toMatchObject({ healthy: false, state: 'host-restart-required' });
    // A real convergence failure beside it still fails.
    expect(install.classifyHostConvergence({ ...receipt, hosts: { ...receipt.hosts, codex: { state: 'ready', version: '0.0.1' } } }))
      .toMatchObject({ healthy: false, state: 'host-pending' });
    expect(install.classifyHostConvergence({ ...receipt, consoleRuntime: { state: 'pending-console-restart' } }))
      .toMatchObject({ healthy: false, state: 'pending-console-restart' });
  });

  it('syncHostsAfterUpdate succeeds and records the open-sessions scope when only boot declarations changed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-issue77-open-sessions-'));
    temps.push(home);
    const kb = path.join(home, 'kb');
    const brainHome = path.join(home, 'brain');
    fs.mkdirSync(kb, { recursive: true });
    const result = install.syncHostsAfterUpdate(kb, {
      sourceRoot: ROOT,
      brainHome,
      wireClaude: () => ({ host: true, wired: true, version: VERSION, restartRequired: true, restartScope: 'open-sessions',
        sessionSafety: 'restart-required', sessionSafetyReason: 'boot-level declarations changed: hooks/hooks.json' }),
      wireCodexHost: () => ({ host: false, action: 'no-host' }),
      runStableSpine: () => ({ status: 0, error: undefined }),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.error).toBeNull();
    expect(result.convergence).toMatchObject({ healthy: true, openSessions: ['claude'] });
    const receipt = JSON.parse(fs.readFileSync(path.join(brainHome, 'host-convergence.json'), 'utf8'));
    expect(receipt.hosts.claude).toMatchObject({ state: 'ready', restartRequired: true, restartScope: 'open-sessions' });
    // --doctor reads this same receipt through the same classifier.
    expect(install.classifyHostConvergence(receipt)).toMatchObject({ healthy: true, state: 'channels-converged' });
  });



  it('keeps a native Codex update explicitly non-converged until Codex restarts', () => {
    const receipt = {
      desiredVersion: VERSION,
      hosts: {
        claude: { state: 'absent', version: null },
        codex: {
          state: 'ready', version: VERSION, restartRequired: true,
          sessionSafety: 'restart-required', sessionSafetyReason: 'Codex host cache has no lease API',
        },
      },
      consoleRuntime: { state: 'ready', runtimeVersion: VERSION },
    };
    expect(install.classifyHostConvergence(receipt)).toEqual({
      healthy: false,
      state: 'host-restart-required',
      action: 'Codex host cache has no lease API',
    });
  });
});
