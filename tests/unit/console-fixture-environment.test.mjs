import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONSOLE_FIXTURE_PATH_KEYS,
  consoleFixtureEnvironment,
} from '../helpers/console-fixture-environment.mjs';

describe('consoleFixtureEnvironment', () => {
  it('keeps every Console-owned writable path beneath one absolute disposable root', () => {
    const root = path.join(os.tmpdir(), 'console-fixture-environment');
    const env = consoleFixtureEnvironment(root, { baseEnv: {} });

    for (const key of CONSOLE_FIXTURE_PATH_KEYS) {
      expect(path.isAbsolute(env[key]), key).toBe(true);
      const relative = path.relative(path.resolve(root), env[key]);
      expect(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), key).toBe(true);
    }
  });

  it('does not repurpose HOME, USERPROFILE, or CODEX_HOME', () => {
    const baseEnv = {
      HOME: '/system/home',
      USERPROFILE: 'C:\\Users\\system',
      CODEX_HOME: '/system/codex',
      KEEP_ME: 'yes',
    };
    const env = consoleFixtureEnvironment(path.resolve(os.tmpdir(), 'console-fixture-environment'), { baseEnv });

    for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME']) expect(env[key], key).toBe(baseEnv[key]);
    expect(env.KEEP_ME).toBe('yes');
    expect(() => consoleFixtureEnvironment(path.resolve(os.tmpdir(), 'console-fixture-environment'), {
      baseEnv,
      extras: { HOME: '/fixture/home' },
    })).toThrow('console fixture extras may not override HOME');
  });

  it('rejects relative fixture roots', () => {
    expect(() => consoleFixtureEnvironment('../fixture', { baseEnv: {} }))
      .toThrow('console fixture root must be an absolute path');
  });
});
