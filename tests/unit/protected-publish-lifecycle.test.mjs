import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('npm publication lifecycle authority', () => {
  it('runs the protected publication guard before npm can publish', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.prepublishOnly)
      .toBe('node scripts/protected-release-invocation.mjs --prepublish-only');
  });
});
