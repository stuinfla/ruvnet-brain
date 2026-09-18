import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { nodeVersionFailure } from '../../kb/node-version.mjs';

describe('one Node runtime requirement', () => {
  it.each(['18.20.0', '20.8.9', 'invalid'])('refuses unsupported %s', version => {
    expect(nodeVersionFailure(version)).toBeTruthy();
  });
  it.each(['20.9.0', '20.19.0', '22.0.0', '24.18.0'])('accepts supported %s', version => {
    expect(nodeVersionFailure(version)).toBeNull();
  });
  it('keeps package and lock roots consistent with the actual sharp requirement', () => {
    const read = file => JSON.parse(fs.readFileSync(new URL('../../' + file, import.meta.url)));
    const kb = read('kb/package.json');
    const lock = read('kb/package-lock.json');
    expect(read('package.json').engines.node).toBe(kb.engines.node);
    expect(read('package-lock.json').packages[''].engines.node).toBe(kb.engines.node);
    expect(lock.packages[''].engines.node).toBe(kb.engines.node);
    expect(nodeVersionFailure(kb.engines.node.slice(2), lock.packages['node_modules/sharp'].engines.node)).toBeNull();
  });
});
