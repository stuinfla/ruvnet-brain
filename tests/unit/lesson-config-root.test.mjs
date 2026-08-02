import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lessonStore from '../../plugin/scripts/lesson-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('lesson fixture configuration never rewrites child HOME', () => {
  it('resolves an explicit config root independently of the account home', () => {
    expect(lessonStore.resolveConfigRoot).toBeTypeOf('function');
    expect(lessonStore.resolveConfigRoot({ RUVNET_CONFIG_ROOT: '/fixture/config' }, '/real/account'))
      .toBe('/fixture/config');
  });

  it('guards the standalone plugin process test against adding a HOME override', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'tests', 'integration', 'unprompted-speech-registry.test.mjs'),
      'utf8',
    );
    expect(source).not.toMatch(/\bHOME\s*:\s*isolatedHome\b/);
  });
});
