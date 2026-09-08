import { describe, expect, it } from 'vitest';
import { symbolRoute } from '../../kb/forge-ask.mjs';

describe('symbol routing ignores inherited and malformed table entries (#224)', () => {
  it('does not interpret Object.prototype properties as source paths', () => {
    expect([...symbolRoute('constructor', { bySymbol: {}, byStem: {}, byPackage: {} })]).toEqual([]);
  });
  it('does not follow an inherited constructor table', () => {
    const bySymbol = Object.create({ constructor: ['src/foreign.mjs'] });
    expect([...symbolRoute('constructor', { bySymbol, byStem: {}, byPackage: {} })]).toEqual([]);
  });
  it('retains own constructor entries without reading inherited sibling entries', () => {
    expect([...symbolRoute('constructor', { bySymbol: { constructor: ['src/ctor.ts'] }, byStem: {}, byPackage: {} })])
      .toEqual(['src/ctor.ts']);
  });
  it('ignores missing tables and non-array values', () => {
    expect([...symbolRoute('constructor', {})]).toEqual([]);
    expect([...symbolRoute('swarm_init routing @ruvnet/ruflo', {
      bySymbol: { swarm_init: 42, routing: 'not-an-array' }, byPackage: { ruflo: {} },
    })]).toEqual([]);
  });
  it('deduplicates valid routes across symbol, stem, and package tables', () => {
    expect([...symbolRoute('swarm_init routing @ruvnet/ruflo', {
      bySymbol: { swarm_init: ['src/swarm.ts'], routing: ['src/route.ts'] },
      byStem: { routing: ['src/route.ts'] }, byPackage: { ruflo: ['src/main.ts'] },
    })]).toEqual(['src/swarm.ts', 'src/main.ts', 'src/route.ts']);
  });
});
