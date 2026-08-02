import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { consoleRootFromEnvironment } from '../../scripts/onboarding-console.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONSOLE = path.join(REPO, 'scripts', 'onboarding-console.mjs');

describe('consoleRootFromEnvironment', () => {
  it('retains the operating-system home when no console root is supplied', () => {
    expect(consoleRootFromEnvironment({}, os.homedir())).toBe(os.homedir());
  });

  it('accepts and normalizes an explicit absolute console root', () => {
    const root = path.join(os.tmpdir(), 'console-root', '..', 'console-fixture');
    expect(consoleRootFromEnvironment({ RUVNET_CONSOLE_ROOT: root }, '/not-used')).toBe(path.resolve(root));
  });

  it('rejects a relative traversal root instead of resolving it against an ambient directory', () => {
    expect(() => consoleRootFromEnvironment({ RUVNET_CONSOLE_ROOT: '../console-fixture' }, '/not-used'))
      .toThrow('RUVNET_CONSOLE_ROOT must be an absolute path');
  });

  it('fails before serving when its externally supplied root is a relative traversal path', () => {
    const result = spawnSync(process.execPath, [CONSOLE, '--print-state'], {
      cwd: REPO,
      env: { ...process.env, RUVNET_CONSOLE_ROOT: '../console-fixture' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RUVNET_CONSOLE_ROOT must be an absolute path');
  });
});
