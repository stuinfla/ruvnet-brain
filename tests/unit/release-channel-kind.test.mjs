import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  describeLatestPointer, isCodeReleaseTag, isCorpusReleaseTag,
  latestCodeReleaseTag, pickLatestCodeRelease, releaseKind,
} from '../../scripts/release-channel-kind.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const corpus = (seed) => `corpus-sha256-${seed.repeat(64).slice(0, 64)}`;

describe('release channel kind', () => {
  it.each([
    [corpus('a'), 'corpus'],
    ['v4.3.25', 'code'], // sync-version-ignore: fixture code release tag
    ['v10.0.0', 'code'],
    ['v4.3.25-dev', 'other'], // sync-version-ignore: fixture prerelease-shaped tag
    ['corpus-sha256-SHORT', 'other'],
    ['corpus-sha256-' + 'A'.repeat(64), 'other'],
    ['latest', 'other'],
    ['', 'other'],
    [null, 'other'],
  ])('classifies %s as %s', (tag, kind) => {
    expect(releaseKind(tag)).toBe(kind);
    expect(isCorpusReleaseTag(tag)).toBe(kind === 'corpus');
    expect(isCodeReleaseTag(tag)).toBe(kind === 'code');
  });

  it('picks the newest CODE release even when a corpus generation is newer', () => {
    // The whole point. `releases/latest` is the corpus generation here — correctly, by design —
    // and every author-side question about the product generation must still get v4.3.25.
    const releases = [
      { tag_name: corpus('b'), draft: false, published_at: '2026-09-14T02:00:00Z' },
      { tag_name: 'v4.3.25', draft: false, published_at: '2026-09-10T00:00:00Z' }, // sync-version-ignore: fixture code release tag
      { tag_name: 'v4.3.24', draft: false, published_at: '2026-09-01T00:00:00Z' },
    ];
    expect(latestCodeReleaseTag(releases)).toBe('v4.3.25'); // sync-version-ignore: fixture code release tag
  });

  it('RED: the corpus filter is what does the work — without it the corpus digest wins', () => {
    const releases = [
      { tag_name: corpus('b'), draft: false, published_at: '2026-09-14T02:00:00Z' },
      { tag_name: 'v4.3.25', draft: false, published_at: '2026-09-10T00:00:00Z' }, // sync-version-ignore: fixture code release tag
    ];
    // The naive "newest published release" every consumer used to compute:
    const naive = [...releases].sort((l, r) => Date.parse(r.published_at) - Date.parse(l.published_at))[0].tag_name;
    expect(naive).toBe(corpus('b'));
    expect(latestCodeReleaseTag(releases)).not.toBe(naive);
  });

  it.each([
    ['drafts', [{ tag_name: 'v9.9.9', draft: true, published_at: '2026-09-14T00:00:00Z' }, { tag_name: 'v4.3.24', draft: false, published_at: '2026-09-01T00:00:00Z' }], 'v4.3.24'],
    ['gh CLI field spellings', [{ tagName: 'v4.3.24', isDraft: false, publishedAt: '2026-09-01T00:00:00Z' }], 'v4.3.24'],
    ['undated rows, falling back to API list order', [{ tag_name: corpus('c'), draft: false }, { tag_name: 'v4.3.24', draft: false }], 'v4.3.24'],
  ])('handles %s', (_name, releases, expected) => {
    expect(latestCodeReleaseTag(releases)).toBe(expected);
  });

  it.each([
    ['a corpus-only release list', [{ tag_name: corpus('d'), draft: false, published_at: '2026-09-14T00:00:00Z' }]],
    ['an empty list', []],
    ['a non-array', null],
  ])('returns null for %s rather than guessing', (_name, releases) => {
    expect(pickLatestCodeRelease(releases)).toBeNull();
    expect(latestCodeReleaseTag(releases)).toBeNull();
  });

  it('describes a corpus pointer as designed, not as a defect', () => {
    expect(describeLatestPointer(corpus('e'))).toMatch(/by design — that is the customer download/);
    expect(describeLatestPointer('v4.3.25')).toMatch(/is code release v4\.3\.25/); // sync-version-ignore: fixture code release tag
    expect(describeLatestPointer('weird')).toMatch(/neither a code release nor a corpus generation/);
  });
});

describe('every author-side consumer asks for the CODE generation, not the latest pointer', () => {
  // Verified at source before this test existed: each of these compared an npm semver (or the
  // shipping version) against whatever tag held `releases/latest`. Promoting a corpus generation to
  // latest — which ADR-086 S1 REQUIRES, because kb/forge-update.mjs polls exactly that pointer —
  // makes every one of those comparisons false forever. verify-channels is the worst of them:
  // release.mjs:547-548 runs it as `runOrDie` in step E, so a successful corpus night would have
  // failed the OWNER'S OWN release preflight.
  const CONSUMERS = [
    'scripts/verify-channels.mjs',
    'scripts/published-surface-probe.mjs',
    'scripts/github-health-watch.mjs',
    'scripts/release-transaction-provider.mjs',
    'scripts/release-convergence-watchdog.mjs',
    'scripts/release-abort-stale.mjs',
  ];

  it.each(CONSUMERS)('%s resolves the latest code release through the shared predicate', (file) => {
    const source = read(file);
    expect(source).toContain("from './release-channel-kind.mjs'");
    expect(source).toMatch(/latestCodeReleaseTag|latestCodeTag/);
    expect(source, `${file} must list releases rather than read the latest pointer`).toContain('releases?per_page=30');
  });

  it('release.mjs still runs verify-channels as a hard preflight gate — the reason this matters', () => {
    const release = read('scripts/release.mjs');
    expect(release).toContain("runOrDie('verify-channels', process.execPath, ['scripts/verify-channels.mjs'])");
  });

  it('keeps releases/latest exactly where it still means "what a customer downloads"', () => {
    // The customer download path is UNCHANGED and must stay: a corpus generation publishes the
    // identical asset names (ruvnet-brain.zip + .sig + .sha256), so these checks remain meaningful
    // whichever kind of release holds the pointer.
    const channels = read('scripts/verify-channels.mjs');
    expect(channels).toContain('releases/latest/download/ruvnet-brain.zip');
    expect(channels).toContain('${bundleUrl}.sig');
    // …but the version-currency question no longer asks that pointer.
    expect(channels).not.toContain('api.github.com/repos/${REPO}/releases/latest');
  });

  it.each([
    ['scripts/github-health-watch.mjs', /repos\/\$\{REPO\}\/releases\/latest/],
    ['scripts/release-convergence-watchdog.mjs', /releases\/latest/],
    ['scripts/release-abort-stale.mjs', /releases\/latest/],
  ])('%s no longer reads the latest pointer at all', (file, pattern) => {
    const executable = read(file).split('\n').filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')).join('\n');
    expect(executable).not.toMatch(pattern);
  });

  it('the release transaction keeps exactly one latest-pointer read, and only to describe it', () => {
    const provider = read('scripts/release-transaction-provider.mjs');
    const reads = provider.match(/repos\/\$\{REPO\}\/releases\/latest/g) || [];
    expect(reads).toHaveLength(1);
    // And that one read feeds an informational note, never the promotion decision.
    expect(provider).toContain('const current = latestCodeTag();');
    expect(provider).toContain('if (isCorpusReleaseTag(pointer))');
    expect(provider).toContain('refusing GitHub promotion: latest code release is');
  });

  it('the publisher attaches the asset names every consumer and the installer assume', () => {
    // Hard requirement from the step 16 (client) inventory: verify-channels check #4 and
    // bin/install.mjs's asset fallback both assume `ruvnet-brain.zip` and `ruvnet-brain.zip.sig`.
    // The client has been hardened against a rename; the publisher must not rely on that.
    const release = read('scripts/release.mjs');
    expect(release).toContain('const signatureFile = `${bundleFile}.sig`;');
    expect(release).toContain('const digestFile = `${bundleFile}.sha256`;');
    // ADR-086 Step 15 appended the detached retrieval-accuracy report to this list. The contract
    // this test defends is that the names the client looks up are still ATTACHED and still spelled
    // the same — bin/install.mjs:103 and verify-channels check #4 resolve assets BY NAME, never by
    // an exact set — so an added asset is compatible while a rename or a removal is not.
    expect(release).toContain('const assetFiles = [bundleFile, signatureFile, digestFile, receiptFile, accuracyReportFile, recallReportFile];');
    expect(release).toContain('const accuracyReportFile = `${bundleFile}.accuracy.json`;');
    // The BLOCKING retrieval evidence ships too (ADR-086 amendment 2026-09-15). A customer that
    // downloads the archive must be able to re-verify BOTH the number that qualified the release and
    // the C3 diagnostic it did not meet, without taking either on trust.
    expect(release).toContain('const recallReportFile = `${bundleFile}.recall.json`;');
    const workflow = read('.github/workflows/protected-release.yml');
    expect(workflow).toContain('node scripts/sign-bundle.mjs --bundle "$staged/ruvnet-brain.zip"');
  });
});
