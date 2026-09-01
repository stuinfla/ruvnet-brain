import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('canonical QA runner execution contract', () => {
  it('runs independent lanes concurrently and does not fail fast after the first lane', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/qa-runner.mjs'), 'utf8');

    expect(source).toMatch(/Promise\.all\(lanes\.map\(async \(lane\) =>/);
    expect(source).toMatch(/results\.length === lanes\.length/);
    expect(source).not.toMatch(/for \(const lane of lanes\) \{[\s\S]*?if \(result\.status !== 'PASS'\) break;/);
  });
});
