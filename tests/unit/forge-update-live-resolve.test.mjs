/**
 * Issue #35 (Dr. Mark Allen / @mamd69) — the three remaining defects, all in kb/forge-update.mjs:
 *
 *   1. `--apply` downloaded from `local.canonicalBundleUrl` — the URL pinned inside the copy of
 *      SOURCE.json BEING REPLACED. That pointer can only ever point BACKWARD. Mark's machine
 *      re-downloaded the same June v0.5.0-dev asset for three weeks while every run reported
 *      success. `resolveBundleUrl()` fixes this by resolving the bundle URL from the LIVE
 *      "latest release" payload fetched moments before, falling back to the pinned URL only when
 *      the live manifest has nothing resolvable — and never silently.
 *
 *   2. The final "DONE" message was built from `canon.tag_name` — a lookup made BEFORE any bytes
 *      were downloaded. Mark's run printed "KB updated to the canonical build (v9.9.99-test)" while
 *      his on-disk SOURCE.json still read v0.5.0-dev. `verifyLanded()` fixes this by re-reading the
 *      SOURCE.json that extraction actually wrote and refusing to report success if it is
 *      byte-for-byte identical to what was there immediately before the run (Mark's literal bug:
 *      the "update" downloaded the same content again) or if the downloaded bytes don't match a
 *      release-declared digest.
 *
 *   3. The known-good/pinned fallback fired with zero warning. `resolveBundleUrl()` now returns a
 *      non-null `warning` string naming the fallback's own build identity and the reason, and
 *      main() prints it with a visible ⚠ marker — callers MUST NOT swallow it.
 *
 * Both functions are pure enough to test directly. `verifyLanded()` reads a real SOURCE.json off a
 * real temp directory (no fs mocking), matching the house style in reclaim-backups.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyVerifiedStagedRelease, resolveBundleUrl, verifyLanded } from '../../kb/forge-update.mjs';

// A realistic per-store `local` record, shaped exactly like forge-build.mjs writes it (see
// kb/forge-build.mjs:476-486 and the real kb/SOURCE.json in this repo).
const staleLocal = {
  kbName: 'ruvnet',
  sourceRepo: 'https://github.com/ruvnet/ruvnet',
  sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sourceDescribe: 'aaaaaaa',
  builtUtc: '2026-06-29T09:00:00.000Z',
  builder: 'rvf-kb-forge',
  canonicalManifestUrl: 'https://api.github.com/repos/stuinfla/ruvnet-brain/releases/latest',
  // The exact shape of Mark's bug: pinned to the June build's own raw-file path.
  canonicalBundleUrl: 'https://raw.githubusercontent.com/stuinfla/ruvnet-brain/main/kb/ruvnet-kb-bundle.zip',
  selfUpdate: 'node forge-update.mjs ruvnet',
};
const staleSource = { canonicalBundleUrl: staleLocal.canonicalBundleUrl };

describe('resolveBundleUrl (issue #35 items 1 and 3)', () => {
  it('PROVES THE BUG FIRST: the old naive lookup (local.canonicalBundleUrl || source.canonicalBundleUrl) always returns the stale pinned URL, even when a live release exists', () => {
    // This is literally the expression that used to sit at kb/forge-update.mjs:218. Confirming it
    // here documents exactly what resolveBundleUrl replaces and why that replacement was needed.
    const naiveOldLogic = staleLocal.canonicalBundleUrl || staleSource.canonicalBundleUrl;
    expect(naiveOldLogic).toBe('https://raw.githubusercontent.com/stuinfla/ruvnet-brain/main/kb/ruvnet-kb-bundle.zip');
  });

  it('resolves to the live release asset instead of the stale pinned URL, when the release has an unambiguous single .zip asset (this project\'s real packaging)', () => {
    // Matches the real `gh release view --json assets` shape for this repo: one combined
    // ruvnet-brain.zip, not one zip per store — the pinned per-store name never matches it.
    const canon = {
      tag_name: 'v9.9.99-test',
      published_at: '2026-07-20T07:21:53Z',
      assets: [
        { name: 'ruvnet-brain.zip', browser_download_url: 'https://github.com/stuinfla/ruvnet-brain/releases/download/v9.9.99-test/ruvnet-brain.zip', digest: 'sha256:98d8103f' },
        { name: 'ruvnet-brain.zip.sig', browser_download_url: 'https://github.com/stuinfla/ruvnet-brain/releases/download/v9.9.99-test/ruvnet-brain.zip.sig' },
      ],
    };

    const resolved = resolveBundleUrl({ canon, local: staleLocal, source: staleSource });

    expect(resolved.url).toBe('https://github.com/stuinfla/ruvnet-brain/releases/download/v9.9.99-test/ruvnet-brain.zip');
    expect(resolved.origin).toBe('latest-release-asset');
    expect(resolved.assetName).toBe('ruvnet-brain.zip');
    expect(resolved.digest).toBe('sha256:98d8103f');
    expect(resolved.warning).toBeNull();
    // The whole point: NOT the stale pinned URL.
    expect(resolved.url).not.toBe(staleLocal.canonicalBundleUrl);
  });

  it('resolves by exact asset-name match when the release does carry a per-store-named asset', () => {
    const canon = {
      tag_name: 'v9.0.0',
      published_at: '2026-08-01T00:00:00Z',
      assets: [
        { name: 'ruvnet-kb-bundle.zip', browser_download_url: 'https://cdn.example/v9/ruvnet-kb-bundle.zip' },
        { name: 'other-kb-bundle.zip', browser_download_url: 'https://cdn.example/v9/other-kb-bundle.zip' },
      ],
    };
    const resolved = resolveBundleUrl({ canon, local: staleLocal, source: staleSource });
    expect(resolved.url).toBe('https://cdn.example/v9/ruvnet-kb-bundle.zip');
    expect(resolved.origin).toBe('latest-release-asset');
  });

  it('resolves from a live SOURCE.json-shaped manifest (shape 2), not the pinned local copy', () => {
    const canon = {
      builtUtc: '2026-07-20T00:00:00Z',
      stores: { ruvnet: { builtUtc: '2026-07-20T00:00:00Z', canonicalBundleUrl: 'https://cdn.example/fresh/ruvnet-kb-bundle.zip' } },
    };
    const resolved = resolveBundleUrl({ canon, local: staleLocal, source: staleSource });
    expect(resolved.url).toBe('https://cdn.example/fresh/ruvnet-kb-bundle.zip');
    expect(resolved.origin).toBe('live-manifest');
    expect(resolved.warning).toBeNull();
  });

  it('falls back to the pinned URL when nothing live resolves it, and WARNS VISIBLY naming the version it fell back to (issue #35 item 3)', () => {
    const canon = { tag_name: 'v9.9.99-test', published_at: '2026-07-20T07:21:53Z', assets: [] }; // e.g. rate-limited/degraded payload
    const resolved = resolveBundleUrl({ canon, local: staleLocal, source: staleSource });

    expect(resolved.url).toBe(staleLocal.canonicalBundleUrl);
    expect(resolved.origin).toBe('pinned-fallback');
    expect(resolved.warning).toBeTruthy();
    // The warning must NAME the version it fell back to, not just say "fallback used".
    expect(resolved.warning).toContain(staleLocal.builtUtc);
    expect(resolved.warning).toContain(staleLocal.sourceDescribe);
    expect(resolved.warning).toMatch(/stale/i);
  });

  it('returns no URL at all when there is nothing live and nothing pinned', () => {
    const resolved = resolveBundleUrl({ canon: { tag_name: 'v1', assets: [] }, local: { kbName: 'x' }, source: {} });
    expect(resolved.url).toBeNull();
    expect(resolved.origin).toBe('none');
    expect(resolved.warning).toBeNull();
  });
});

describe('verifyLanded (issue #35 item 2)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-landed-test-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeSource = (dir, storeRecord) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify({
      builder: 'rvf-kb-forge',
      builtUtc: storeRecord.builtUtc,
      stores: { [storeRecord.kbName]: storeRecord },
    }, null, 2));
  };

  it('PROVES THE BUG FIRST: FAILS when the "update" left SOURCE.json byte-for-byte identical to before it ran — Mark\'s exact report (bytes replaced with an identical copy)', () => {
    const kb = path.join(root, 'kb');
    writeSource(kb, staleLocal); // simulates: the download fetched the SAME June bundle again

    const result = verifyLanded({ kbDir: kb, kbName: 'ruvnet', before: staleLocal });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/IDENTICAL/);
    expect(result.reason).toMatch(/issue #35/i);
  });

  it('passes when SOURCE.json on disk genuinely differs from before the update (a real new build landed)', () => {
    const kb = path.join(root, 'kb');
    const freshLocal = { ...staleLocal, builtUtc: '2026-07-20T07:19:18.120Z', sourceCommit: '2c02fb59ffcd2c3826908b74cc6e68e7a4e363fb', sourceDescribe: '2c02fb5' };
    writeSource(kb, freshLocal);

    const result = verifyLanded({ kbDir: kb, kbName: 'ruvnet', before: staleLocal });

    expect(result.ok).toBe(true);
    expect(result.landed.builtUtc).toBe(freshLocal.builtUtc);
  });

  it('FAILS when no SOURCE.json exists on disk after extraction (cannot confirm anything landed)', () => {
    const kb = path.join(root, 'kb-empty');
    fs.mkdirSync(kb, { recursive: true }); // extraction produced an empty/broken dir, no SOURCE.json
    const result = verifyLanded({ kbDir: kb, kbName: 'ruvnet', before: staleLocal });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no SOURCE\.json/);
  });

  it('FAILS when SOURCE.json on disk is corrupt JSON', () => {
    const kb = path.join(root, 'kb-corrupt');
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, 'SOURCE.json'), '{ not valid json');
    const result = verifyLanded({ kbDir: kb, kbName: 'ruvnet', before: staleLocal });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreadable\/corrupt/);
  });

  it('FAILS when the landed SOURCE.json has no entry for the requested store name', () => {
    const kb = path.join(root, 'kb-wrong-store');
    writeSource(kb, { ...staleLocal, kbName: 'some-other-store', builtUtc: '2026-07-20T00:00:00Z' });
    const result = verifyLanded({ kbDir: kb, kbName: 'ruvnet', before: staleLocal });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no entry for store "ruvnet"/);
  });

  it('FAILS when the downloaded bytes do not match the release-declared digest, even though the fingerprint changed', () => {
    const kb = path.join(root, 'kb-bad-digest');
    const freshLocal = { ...staleLocal, builtUtc: '2026-07-20T07:19:18.120Z', sourceCommit: '2c02fb59ffcd2c3826908b74cc6e68e7a4e363fb', sourceDescribe: '2c02fb5' };
    writeSource(kb, freshLocal);
    const buf = Buffer.from('this is NOT what the release actually published');

    const result = verifyLanded({
      kbDir: kb, kbName: 'ruvnet', before: staleLocal,
      expectedDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      downloadedBuffer: buf,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/digest/);
  });

  it('passes when the downloaded bytes DO match the release-declared digest', () => {
    const kb = path.join(root, 'kb-good-digest');
    const freshLocal = { ...staleLocal, builtUtc: '2026-07-20T07:19:18.120Z', sourceCommit: '2c02fb59ffcd2c3826908b74cc6e68e7a4e363fb', sourceDescribe: '2c02fb5' };
    writeSource(kb, freshLocal);
    const buf = Buffer.from('the real bundle bytes');
    const digest = `sha256:${createHash('sha256').update(buf).digest('hex')}`;

    const result = verifyLanded({ kbDir: kb, kbName: 'ruvnet', before: staleLocal, expectedDigest: digest, downloadedBuffer: buf });

    expect(result.ok).toBe(true);
  });
});

describe('applyVerifiedStagedRelease (private recovery rail)', () => {
  it('fails closed on a missing detached signature before touching the live tree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-recovery-trust-'));
    const staged = path.join(root, 'staged');
    const live = path.join(root, 'live');
    fs.mkdirSync(staged); fs.mkdirSync(live);
    fs.writeFileSync(path.join(staged, 'SOURCE.json'), '{}');
    fs.writeFileSync(path.join(live, 'SOURCE.json'), '{}');
    const before = fs.readFileSync(path.join(live, 'SOURCE.json'));
    await expect(applyVerifiedStagedRelease({ stagedDir: staged, liveDir: live,
      bundlePath: path.join(root, 'bundle.zip'), signaturePath: path.join(root, 'bundle.zip.sig'),
      expectedRuntimeVersion: JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url))).version, validateCoverageDirectory: () => ({ valid: true, failures: [] })
    })).rejects.toThrow(/signature verification failed/i);
    expect(fs.readFileSync(path.join(live, 'SOURCE.json'))).toEqual(before);
  });
});
