import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = fs.readFileSync(new URL('../../console/app.js', import.meta.url), 'utf8');
function fixture() {
  const nodes = new Map();
  const list = { firstChild: null, before() {}, append(...values) { for (const n of values) nodes.set(n.id, n); }, prepend(...values) { this.append(...values); } };
  const context = { Map, Set, Array, renderedRecIds: new Set(), renderedRecommendations: new Map(), recommendationSources: new Map(),
    $: () => list, document: { getElementById: id => id === 'recs-order-note' ? {} : nodes.get(id) },
    el: () => ({}), updateRecsChip() {},
    buildRecCard: rec => ({ id: `rec-${rec.id}`, remove() { nodes.delete(this.id); }, replaceWith(node) { nodes.set(node.id, node); } }) };
  vm.createContext(context);
  const body = source.match(/function addRecommendations\([\s\S]*?\n\}/)?.[0];
  expect(body).toBeTruthy(); vm.runInContext(body, context);
  return { ...context, nodes };
}
const recommendation = (id, title = 'Update tool') => ({ id, title, evidence: ['measured'], cost: {}, undo: {} });
describe('recommendation refresh replaces the measured source', () => {
  it('removes behind-version recommendations when a new stack audit reports none', () => {
    const f = fixture(); f.addRecommendations([recommendation('stack:ruflo')], 'stack');
    expect(f.renderedRecIds.size).toBe(1);
    f.addRecommendations([], 'stack');
    expect(f.renderedRecIds.size).toBe(0); expect(f.nodes.has('rec-stack:ruflo')).toBe(false);
  });
  it('updates evidence for the same ID and preserves recommendations from other sources', () => {
    const f = fixture(); f.addRecommendations([recommendation('stack:ruflo')], 'stack');
    f.addRecommendations([recommendation('health:memory')], 'health');
    f.addRecommendations([recommendation('stack:ruflo', 'New measured version')], 'stack');
    expect(f.renderedRecommendations.get('stack:ruflo').title).toBe('New measured version');
    f.addRecommendations([], 'stack');
    expect([...f.renderedRecIds]).toEqual(['health:memory']);
  });
});

describe('the independently measured stack settles after the state cache', () => {
  it('keeps polling a withdrawn stack cache instead of treating state freshness as stack completion', async () => {
    const scheduled = [], settled = [], chips = [];
    let response = { stale: true, recommendations: [recommendation('stack:old')] };
    const context = { WARM_RETRY_MAX: 60, WARM_RETRY_MS: 3000, getJSON: async () => response,
      setTimeout: fn => scheduled.push(fn), setChips: (...args) => chips.push(args), chip: text => text,
      renderStack() {}, addRecommendations: (...args) => settled.push(args), recsSettled() {}, inlineError() {}, stackTicker: null };
    vm.createContext(context);
    vm.runInContext(source.match(/async function loadStack\([\s\S]*?\n\}/)[0], context);
    await context.loadStack();
    expect(scheduled.length).toBe(1); expect(settled).toEqual([]);
    response = { stale: false, recommendations: [] };
    await context.loadStack(1);
    expect(settled).toEqual([[[], 'stack']]);
  });
});

it('paints the exact settled polling snapshot without a second older state fetch', async () => {
  let fetches = 0; const hosts = [];
  const context = { getJSON: async () => { fetches++; return { host: { version: 'old' }, sections: {} }; },
    $: () => ({}), renderHost: host => hosts.push(host), preStateHash: null, lastMemory: null,
    renderSuiteUpdate() {}, pollSuiteUpdate() {}, renderBrainPower() {}, renderInventory() {}, renderWiring() {}, renderMemory() {}, renderSavings() {}, renderSettings() {}, renderGates() {},
    addRecommendations() {}, recsSettled() {}, dismissStandby() {}, renderFreshness() {}, loadMemoryFleet() {}, startFreshnessPolling() {} };
  vm.createContext(context); vm.runInContext(source.match(/async function loadState\([\s\S]*?\n\}/)[0], context);
  await context.loadState({ landed: true, snapshot: { host: { version: 'new' }, sections: {}, stale: false } });
  expect(fetches).toBe(0); expect(hosts).toEqual([{ version: 'new' }]);
});
