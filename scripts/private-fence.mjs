// private-fence.mjs — the fence that keeps private repos out of anything we ship (SEC-0010 #5).
//
// This logic used to live inline in build-concepts.mjs, executed at import time, and it called
// process.exit(1) on failure. That made it literally untestable: importing the module to test the
// fence would kill the test runner. So the highest-severity code in the repo — the thing standing
// between a private cognitum store and a public 512MB release — had zero tests.
//
// Here the decisions are pure: they RETURN {ok, reason} and never exit. The caller (a build script)
// owns the exit. Same contract as before, now assertable.
//
// FAIL-CLOSED is the whole point. Three ways to fail, all of which must refuse to build:
//   1. the fence file is missing        (unless the caller explicitly allows a no-private fork)
//   2. the fence file is corrupt        (a fence you can't read is not a fence)
//   3. a private repo's topics file is corrupt (same reasoning, one level down)
// Fail-OPEN already shipped once (QE-0011 security#1): an L2 article whose repo attribution was
// unknown defaulted to 'ruvnet' and went out the door. Hence the second, slug-based layer below.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Read kb/PRIVATE-STORES.json into a lowercased Set of private repo names.
 * `allowNoFence` is the documented ALLOW_NO_PRIVATE_FENCE=1 escape hatch for a fork with no private
 * repos — the ONLY case where a missing fence is acceptable.
 */
export function loadPrivateFence(kbDir, { allowNoFence = false } = {}) {
  const p = path.join(kbDir, 'PRIVATE-STORES.json');
  if (!fs.existsSync(p)) {
    if (allowNoFence) return { ok: true, privateSet: new Set(), reason: 'no-fence-allowed' };
    return { ok: false, privateSet: null, reason: `private fence missing (${p})` };
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(j.privateStores)) throw new Error('no privateStores array');
    return { ok: true, privateSet: new Set(j.privateStores.map((s) => String(s).toLowerCase())), reason: 'ok' };
  } catch (e) {
    return { ok: false, privateSet: null, reason: `PRIVATE-STORES.json unreadable/corrupt (${e.message})` };
  }
}

/** Case-insensitive membership — "Seed", "SEED" and "seed" must all fence. */
export const isPrivate = (privateSet, repo) => privateSet.has(String(repo).toLowerCase());

/**
 * Second layer: collect the SLUGS owned by private repos, by reading each one's l2-topics file.
 * An absent topics file is normal (that repo has no L2 articles) — absence is not corruption.
 * A present-but-corrupt one is corruption, and must abort the build.
 */
export function loadPrivateSlugs(kbDir, privateSet) {
  const slugs = new Set();
  for (const repo of privateSet) {
    const tf = path.join(kbDir, `l2-topics.${repo}.json`);
    if (!fs.existsSync(tf)) continue;
    try {
      for (const t of JSON.parse(fs.readFileSync(tf, 'utf8'))) if (t.slug) slugs.add(t.slug);
    } catch (e) {
      return { ok: false, slugs: null, reason: `private topics file ${tf} is corrupt (${e.message})` };
    }
  }
  return { ok: true, slugs, reason: 'ok' };
}

/**
 * THE decision. An L2 article is fenced when its repo is private OR its slug belongs to a private
 * repo. The second clause is what catches the shipped bug: `slugRepo.get(slug) || 'ruvnet'` hands
 * an unattributed article a PUBLIC repo name, so repo-based fencing alone would wave it through.
 */
export const shouldFenceL2 = ({ repo, slug }, privateSet, privateSlugs) =>
  isPrivate(privateSet, repo) || privateSlugs.has(slug);
