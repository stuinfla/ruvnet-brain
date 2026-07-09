// tests/unit/build-concepts-fence.test.mjs — the fence that stands between a PRIVATE cognitum store
// and a public 512MB release. It is the highest-severity code in the repo and, until 2026-07-09, it
// had zero tests: the logic lived inline in scripts/build-concepts.mjs, ran at import time, and
// called process.exit(1), so importing it to test it would kill the runner.
//
// The logic now lives in scripts/private-fence.mjs — pure, returns {ok, reason}, never exits; the
// build script owns the exit. Same external behavior, assertable core.
//
// TWO LAYERS, because one already failed. Repo-based fencing alone let an L2 article ship when its
// repo attribution was unknown: `slugRepo.get(slug) || 'ruvnet'` handed it a PUBLIC repo name, and
// out the door it went (QE-0011 security#1). Slug-based fencing is the patch. The last test in this
// file is that exact regression — it is the reason this file exists.
//
// Every failure mode below must FAIL CLOSED. A fence you cannot read is not a fence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPrivateFence, isPrivate, loadPrivateSlugs, shouldFenceL2 } from '../../scripts/private-fence.mjs';

let kb;
const writeFence = (obj) => fs.writeFileSync(path.join(kb, 'PRIVATE-STORES.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
const writeTopics = (repo, body) => fs.writeFileSync(path.join(kb, `l2-topics.${repo}.json`), typeof body === 'string' ? body : JSON.stringify(body));

beforeEach(() => { kb = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-test-')); });
afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }); });

describe('loadPrivateFence — fail closed, always', () => {
  it('refuses to build when PRIVATE-STORES.json is missing, naming the file it wanted', () => {
    const r = loadPrivateFence(kb);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('PRIVATE-STORES.json');
    expect(r.privateSet).toBeNull();
  });
  it('allows a missing fence ONLY under the documented no-private-fork escape hatch', () => {
    const r = loadPrivateFence(kb, { allowNoFence: true });
    expect(r.ok).toBe(true);
    expect(r.privateSet).toEqual(new Set());
  });
  it('refuses when the fence file exists but is not valid JSON — an unreadable fence is no fence', () => {
    writeFence('{ this is not json');
    expect(loadPrivateFence(kb)).toMatchObject({ ok: false });
  });
  it('refuses when privateStores is present but not an array (a string)', () => {
    writeFence({ privateStores: 'cognitum-seed' });
    expect(loadPrivateFence(kb)).toMatchObject({ ok: false });
  });
  it('refuses when privateStores is present but not an array (an object)', () => {
    writeFence({ privateStores: { seed: true } });
    expect(loadPrivateFence(kb)).toMatchObject({ ok: false });
  });
  it('refuses when privateStores is absent entirely, even from otherwise-valid JSON', () => {
    writeFence({ somethingElse: [] });
    expect(loadPrivateFence(kb)).toMatchObject({ ok: false });
  });
  it('lowercases every name, so the fence cannot be defeated by casing', () => {
    writeFence({ privateStores: ['Seed', 'V0-Appliance'] });
    const r = loadPrivateFence(kb);
    expect(r.ok).toBe(true);
    expect(r.privateSet).toEqual(new Set(['seed', 'v0-appliance']));
  });
  it('an empty privateStores array is legal — a fork may genuinely have nothing to fence', () => {
    writeFence({ privateStores: [] });
    expect(loadPrivateFence(kb)).toMatchObject({ ok: true, privateSet: new Set() });
  });
});

describe('isPrivate — case-insensitive membership', () => {
  const set = new Set(['seed']);
  it('fences a private repo whatever its casing', () => {
    for (const name of ['Seed', 'SEED', 'seed', 'SeEd']) expect(isPrivate(set, name)).toBe(true);
  });
  it('lets a public repo through', () => {
    expect(isPrivate(set, 'ruvector')).toBe(false);
    expect(isPrivate(set, 'seedling')).toBe(false); // near-miss must not fence
  });
});

describe('loadPrivateSlugs — learn which slugs a private repo owns', () => {
  it('treats an absent topics file as normal, not as corruption', () => {
    const r = loadPrivateSlugs(kb, new Set(['seed']));
    expect(r).toMatchObject({ ok: true });
    expect(r.slugs).toEqual(new Set());
  });
  it('collects every slug a private repo declares', () => {
    writeTopics('seed', [{ slug: 'seed-architecture' }, { slug: 'seed-appliance' }]);
    const r = loadPrivateSlugs(kb, new Set(['seed']));
    expect(r.slugs).toEqual(new Set(['seed-architecture', 'seed-appliance']));
  });
  it('unions slugs across several private repos', () => {
    writeTopics('seed', [{ slug: 'a' }]);
    writeTopics('v0-appliance', [{ slug: 'b' }]);
    expect(loadPrivateSlugs(kb, new Set(['seed', 'v0-appliance'])).slugs).toEqual(new Set(['a', 'b']));
  });
  it('FAILS CLOSED when a private repo\'s topics file exists but is corrupt — never silently skip', () => {
    writeTopics('seed', '[{ broken json');
    const r = loadPrivateSlugs(kb, new Set(['seed']));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('corrupt');
    expect(r.slugs).toBeNull();
  });
  it('ignores topics entries that carry no slug rather than adding undefined to the set', () => {
    writeTopics('seed', [{ slug: 'a' }, { title: 'no slug here' }]);
    expect(loadPrivateSlugs(kb, new Set(['seed'])).slugs).toEqual(new Set(['a']));
  });
});

describe('shouldFenceL2 — THE regression this file exists to catch (QE-0011 security#1)', () => {
  const priv = new Set(['seed']);
  const privSlugs = new Set(['seed-architecture']);

  it('fences an article attributed to a private repo (the easy case repo-fencing already caught)', () => {
    expect(shouldFenceL2({ repo: 'seed', slug: 'anything' }, priv, privSlugs)).toBe(true);
  });

  it('STILL fences a private article whose repo attribution was lost and defaulted to the PUBLIC "ruvnet"', () => {
    // This is the bug that shipped. `slugRepo.get(slug) || 'ruvnet'` gives an unattributed article a
    // public repo name, so repo-based fencing waves it through. Only the slug betrays it.
    expect(isPrivate(priv, 'ruvnet')).toBe(false);                                  // repo layer: clean
    expect(shouldFenceL2({ repo: 'ruvnet', slug: 'seed-architecture' }, priv, privSlugs)).toBe(true); // slug layer: caught
  });

  it('ships a genuinely public article — the fence must not swallow everything', () => {
    expect(shouldFenceL2({ repo: 'ruvector', slug: 'hnsw-indexing' }, priv, privSlugs)).toBe(false);
  });

  it('end to end, from files on disk: a private slug attributed to ruvnet never reaches the store', () => {
    writeFence({ privateStores: ['Seed'] });
    writeTopics('seed', [{ slug: 'seed-architecture' }]);
    const fence = loadPrivateFence(kb);
    const slugs = loadPrivateSlugs(kb, fence.privateSet);
    expect(fence.ok && slugs.ok).toBe(true);

    const articles = [
      { repo: 'ruvnet', slug: 'seed-architecture' }, // private, mis-attributed
      { repo: 'seed', slug: 'seed-appliance' },      // private, attributed
      { repo: 'ruvector', slug: 'hnsw-indexing' },   // public
    ];
    const shipped = articles.filter((a) => !shouldFenceL2(a, fence.privateSet, slugs.slugs));
    expect(shipped).toEqual([{ repo: 'ruvector', slug: 'hnsw-indexing' }]);
  });
});
