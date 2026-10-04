import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { refreshNativeCatalog } from '../../scripts/model-native-catalog.mjs';
const directories = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-catalog-')); directories.push(routerDir);
  const profile = { automaticModelRoutingUpdates: true, harnesses: { codex: { available: true, subscription: true }, 'claude-code': { available: true, subscription: true } } };
  const catalog = { privateNote: 'OWNER', candidates: [{ id: 'sol', provider: 'openai', harness: ['codex'], subscription: ['codex'], custom: 'KEEP' }] };
  fs.writeFileSync(path.join(routerDir, 'profile.json'), JSON.stringify(profile));
  fs.writeFileSync(path.join(routerDir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(routerDir, 'routing-policy.json'), 'OWNER POLICY BYTES');
  const models = { codex: [{ id: 'sol', efforts: ['medium', 'high'] }], 'claude-code': [{ id: 'sonnet', efforts: ['high'] }] };
  const inspect = vi.fn(async ({ host }) => ({ available: true, nativeSubscription: true, catalogStatus: 'verified', sourceReceipt: { host, allowance: { verified: true } }, host, auth: { secret: 'DO NOT PERSIST' }, models: models[host], extra: 'DO NOT PERSIST' }));
  const run = () => refreshNativeCatalog({ routerDir, deadline: Date.now() + 10000, inspect });
  const bytes = name => fs.readFileSync(path.join(routerDir, name));
  return { routerDir, profile, catalog, models, inspect, run, bytes };
}
test('first native snapshot is baseline only; unchanged refresh stays quiet and preserves active policy', async () => {
  const f = fixture(); const policy = f.bytes('routing-policy.json');
  expect(await f.run()).toMatchObject({ status: 'current', baseline: true, newNativeModelIds: [], catalogAdded: 1, inferenceRequests: 0 });
  const once = f.bytes('catalog.json');
  expect(await f.run()).toMatchObject({ status: 'current', baseline: false, newNativeModelIds: [], catalogAdded: 0 });
  expect(f.bytes('catalog.json')).toEqual(once); expect(f.bytes('routing-policy.json')).toEqual(policy);
  expect(f.bytes('native-availability.json').toString()).not.toMatch(/DO NOT PERSIST|secret|extra/);
  expect(f.inspect.mock.calls.every(([args]) => Number.isFinite(args.deadline))).toBe(true);
});
test('verified new exact native identity enters catalog without pricing or automatic policy promotion', async () => {
  const f = fixture(); await f.run(); const prior = f.bytes('catalog.json'); const policy = f.bytes('routing-policy.json');
  f.models.codex.push({ id: 'new-sol', efforts: ['high'] });
  expect(await f.run()).toMatchObject({ status: 'current', newNativeModelIds: ['openai/new-sol'], catalogAdded: 1, policyApplied: false });
  const catalog = JSON.parse(f.bytes('catalog.json'));
  expect(catalog.candidates[0]).toEqual(f.catalog.candidates[0]); expect(catalog.privateNote).toBe('OWNER');
  expect(catalog.candidates.find(c => c.id === 'new-sol')).toMatchObject({ provider: 'openai', harness: ['codex'], subscription: ['codex'], supportedEfforts: ['high'], costPerMTok: null });
  expect(f.bytes('routing-policy.json')).toEqual(policy);
  const history = fs.readdirSync(path.join(f.routerDir, 'native-catalog-history'));
  expect(history.some(dir => fs.readFileSync(path.join(f.routerDir, 'native-catalog-history', dir, 'catalog.json')).equals(prior))).toBe(true);
  expect((await f.run()).newNativeModelIds).toEqual([]);
});
test('existing disabled or landscape-only declarations are withheld and never re-enabled', async () => {
  const f = fixture(); f.catalog.candidates.push({ id: 'sonnet', provider: 'anthropic', harness: [], subscription: [], disabled: true, custom: 'OWNER' });
  fs.writeFileSync(path.join(f.routerDir, 'catalog.json'), JSON.stringify(f.catalog)); const before = f.bytes('catalog.json');
  expect(await f.run()).toMatchObject({ status: 'current', withheldExistingModelIds: ['anthropic/sonnet'], catalogAdded: 0 });
  expect(f.bytes('catalog.json')).toEqual(before);
});
test('unapproved automatic registration or unavailable profile host never invokes native inspection', async () => {
  const f = fixture(); delete f.profile.automaticModelRoutingUpdates;
  fs.writeFileSync(path.join(f.routerDir, 'profile.json'), JSON.stringify(f.profile));
  expect((await f.run()).status).toBe('failed'); expect(f.inspect).not.toHaveBeenCalled();
  f.profile.automaticModelRoutingUpdates = true; f.profile.harnesses.codex.available = false; f.profile.harnesses['claude-code'].subscription = false;
  fs.writeFileSync(path.join(f.routerDir, 'profile.json'), JSON.stringify(f.profile));
  expect((await f.run()).status).toBe('failed'); expect(f.inspect).not.toHaveBeenCalled();
});
test.each(['auth', 'empty', 'partial', 'allowance', 'shutdown', 'exception'])('incomplete native %s leaves both prior files intact', async kind => {
  const f = fixture(); await f.run(); const catalog = f.bytes('catalog.json'), availability = f.bytes('native-availability.json');
  f.models.codex.push({ id: 'new-sol', efforts: ['high'] });
  f.inspect.mockImplementation(async ({ host }) => {
    if (host === 'codex') return { available: true, nativeSubscription: true, catalogStatus: 'verified', sourceReceipt: { host, allowance: { verified: true } }, host, models: f.models[host] };
    if (kind === 'exception') throw Error('PRIVATE AUTH SECRET');
    return { failure: kind === 'shutdown' ? 'cleanup failed' : undefined, available: true, nativeSubscription: kind !== 'auth', catalogStatus: kind === 'partial' ? 'unknown' : 'verified', sourceReceipt: { host, allowance: { verified: kind !== 'allowance' } }, host, models: kind === 'empty' ? [] : [{ id: 'sonnet', efforts: kind === 'unknown-effort' ? [] : ['high'] }] };
  });
  const result = await f.run(); expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(f.bytes('catalog.json')).toEqual(catalog); expect(f.bytes('native-availability.json')).toEqual(availability);
});
test('concurrent owner edit is retained and a held mutation guard is never removed', async () => {
  const f = fixture(); await f.run(); const availability = f.bytes('native-availability.json');
  const inspect = f.inspect.getMockImplementation();
  f.inspect.mockImplementation(async args => { const result = await inspect(args); if (args.host === 'claude-code') fs.writeFileSync(path.join(f.routerDir, 'catalog.json'), 'CONCURRENT OWNER'); return result; });
  expect((await f.run()).status).toBe('failed'); expect(f.bytes('catalog.json').toString()).toBe('CONCURRENT OWNER');
  expect(f.bytes('native-availability.json')).toEqual(availability);
  fs.writeFileSync(path.join(f.routerDir, 'catalog.json'), JSON.stringify(f.catalog)); f.inspect.mockImplementation(inspect);
  const guard = path.join(f.routerDir, 'native-catalog-mutation.lock'); fs.mkdirSync(guard);
  expect((await f.run()).status).toBe('failed'); expect(fs.existsSync(guard)).toBe(true);
});
test('failed snapshot commit restores exact prior catalog bytes without pretending success', async () => {
  const f = fixture(); await f.run(); const catalog = f.bytes('catalog.json'), availability = f.bytes('native-availability.json');
  f.models.codex.push({ id: 'new-sol', efforts: ['high'] }); const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (to === path.join(f.routerDir, 'native-availability.json')) throw Error('disk unavailable'); return rename(from, to); });
  expect((await f.run()).status).toBe('failed'); expect(f.bytes('catalog.json')).toEqual(catalog); expect(f.bytes('native-availability.json')).toEqual(availability);
});

test('unknown native efforts remain visible without enabling or inventing support, and later effort metadata is not a new release', async () => {
  const f = fixture(); await f.run(); f.models.codex.push({ id: 'unknown-sol', efforts: [] });
  expect(await f.run()).toMatchObject({ status: 'current', newNativeModelIds: ['openai/unknown-sol'], unknownEffortModelIds: ['openai/unknown-sol'], catalogAdded: 0 });
  const snapshot = JSON.parse(f.bytes('native-availability.json'));
  expect(snapshot.hosts.find(h => h.host === 'codex').models.find(m => m.id === 'unknown-sol')).toEqual({ id: 'unknown-sol', efforts: [], effortSupport: 'unknown' });
  expect(JSON.parse(f.bytes('catalog.json')).candidates.some(c => c.id === 'unknown-sol')).toBe(false);
  f.models.codex.at(-1).efforts = ['high'];
  expect(await f.run()).toMatchObject({ status: 'current', newNativeModelIds: [], catalogAdded: 1 });
});

test('real native ultra control does not erase verified supported efforts or enable an unsupported control', async () => {
  const f = fixture(); await f.run(); const policy = f.bytes('routing-policy.json');
  f.models.codex.push({ id: 'new-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, { id: 'ultra-only', efforts: ['ultra'] });
  expect(await f.run()).toMatchObject({ status: 'current', catalogAdded: 1, unknownEffortModelIds: ['openai/ultra-only'] });
  const recognized = ['high', 'low', 'max', 'medium', 'xhigh'];
  const snapshot = JSON.parse(f.bytes('native-availability.json'));
  expect(snapshot.hosts.find(h => h.host === 'codex').models.find(m => m.id === 'new-sol')).toEqual({ id: 'new-sol', efforts: recognized, effortSupport: 'verified', unrecognizedEfforts: ['ultra'] });
  const catalog = JSON.parse(f.bytes('catalog.json'));
  expect(catalog.candidates.find(c => c.id === 'new-sol').supportedEfforts).toEqual(recognized);
  expect(catalog.candidates.find(c => c.id === 'ultra-only')).toBeUndefined();
  expect(catalog.candidates[0]).toEqual(f.catalog.candidates[0]); expect(f.bytes('routing-policy.json')).toEqual(policy);
});
