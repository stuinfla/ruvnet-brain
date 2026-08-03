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
      wireCodexHost: () => ({ host: true, wired: true }),
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
});
