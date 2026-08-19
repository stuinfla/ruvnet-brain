import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLiveCount, orgRepoCount } from '../../scripts/org-repo-count.mjs';

/**
 * THE ORG TOTAL IS DERIVED, NOT DECLARED.
 *
 * `orgTotalApprox: 248` was a literal written in TWO producers — build-bundle.mjs and
 * brain-stamp.mjs. Measured 2026-08-12 two independent ways (`users/ruvnet.public_repos` and a
 * paginated repo fetch): the account has 200. So the denominator every coverage percentage is
 * computed against was wrong by 48, in both copies at once, which is what a restated fact always
 * does.
 *
 * Replacing 248 with 200 would have repeated the mistake with a fresher number: the count changes
 * whenever rUv pushes a repo, so it is not a constant. These tests are therefore mostly about the
 * ways a derived number can still lie — inventing one offline, or reporting a stale one as live.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

let dir; let record;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgcount-'));
  record = path.join(dir, 'org-repo-count.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ok = (n) => () => ({ status: 0, stdout: `${n}\n` });

describe('the count is derived, and its provenance travels with it', () => {
  it('a live read reports source "live", and records itself ONLY when asked', () => {
    const r = orgRepoCount({ file: record, fetch: () => 200, persist: true });
    expect(r).toMatchObject({ count: 200, source: 'live' });
    expect(JSON.parse(fs.readFileSync(record, 'utf8')).count, 'the reading must be recorded').toBe(200);
  });

  it('TEETH: READING THE COUNT WRITES NOTHING — this is the bug that blocked every release', () => {
    // `data/org-repo-count.json` is TRACKED. Persisting used to be unconditional, and both
    // production callers (brain-stamp.mjs, build-bundle.mjs) are BUILD scripts — so building the
    // release candidate dirtied the working tree with a fresh `at` timestamp, and release-qe's
    // stabilization seal requires dirty === false. Measured 2026-08-19, after the seal was taught
    // to name its cause instead of printing only the code INVALID_LINEAGE:
    //
    //     stabilization seal failed: INVALID_LINEAGE
    //       working tree is dirty (1 path(s)):
    //         M data/org-repo-count.json
    //
    // Eleven days, 46 commits, nothing published (issue #141) — for one file rewriting itself
    // whenever a build read a number off it. A read is not a write.
    expect(orgRepoCount({ file: record, fetch: () => 200 })).toMatchObject({ count: 200, source: 'live' });
    expect(fs.existsSync(record), 'a plain read must leave the tracked record untouched').toBe(false);
  });

  it('TEETH: offline reuses the LAST REAL READING and says it is not live', () => {
    // The honest fallback. A build with no network must not present a remembered number as current.
    orgRepoCount({ file: record, fetch: () => 200, persist: true });
    const r = orgRepoCount({ file: record, fetch: () => null });
    expect(r).toMatchObject({ count: 200, source: 'recorded' });
    expect(r.at, 'a recorded reading carries when it was taken').toBeTruthy();
  });

  it('TEETH: with no live read and no record it returns NULL, never a guess', () => {
    // The failure this whole change exists to prevent: a plausible number with nothing behind it.
    // A consumer receiving `unknown` must omit the claim rather than print something.
    expect(orgRepoCount({ file: path.join(dir, 'absent.json'), fetch: () => null }))
      .toMatchObject({ count: null, source: 'unknown', at: null });
  });

  it('a corrupt or non-positive record is not trusted', () => {
    fs.writeFileSync(record, '{ not json');
    expect(orgRepoCount({ file: record, fetch: () => null }).source).toBe('unknown');
    fs.writeFileSync(record, JSON.stringify({ count: 0 }));
    expect(orgRepoCount({ file: record, fetch: () => null }).source).toBe('unknown');
  });
});

describe('fetchLiveCount refuses anything it cannot trust', () => {
  it('accepts a positive integer from the API', () => {
    expect(fetchLiveCount('ruvnet', { run: ok(200) })).toBe(200);
  });

  it('TEETH: a failed command, a non-zero exit, or junk output all yield null', () => {
    // Each of these previously would have been "some number" if parsed loosely, and a wrong
    // denominator is worse than an absent one because it still renders.
    expect(fetchLiveCount('ruvnet', { run: () => ({ error: new Error('ENOENT') }) })).toBeNull();
    expect(fetchLiveCount('ruvnet', { run: () => ({ status: 1, stdout: '' }) })).toBeNull();
    expect(fetchLiveCount('ruvnet', { run: () => ({ status: 0, stdout: 'not a number\n' }) })).toBeNull();
    expect(fetchLiveCount('ruvnet', { run: () => ({ status: 0, stdout: '0\n' }) })).toBeNull();
  });
});

describe('no producer holds the total as a literal', () => {
  it('build-bundle and brain-stamp derive it', () => {
    // The actual regression guard: if either producer goes back to a constant, this fails and names
    // the file. Both drifted to 248 together precisely because neither owned the fact.
    for (const rel of ['scripts/build-bundle.mjs', 'scripts/brain-stamp.mjs']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src, `${rel} must import the producer`).toMatch(/from '\.\/org-repo-count\.mjs'/);
      expect(src, `${rel} must not hard-code the org total`)
        .not.toMatch(/orgTotalApprox:\s*\d+/);
      expect(src, `${rel} must carry the provenance so a stale number is visible as stale`)
        .toMatch(/orgTotalSource/);
    }
  });
});
