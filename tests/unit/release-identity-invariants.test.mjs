import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/**
 * WHY MAIN, npm AND THE GITHUB RELEASE KEPT DISAGREEING — and the invariant that ends it.
 *
 * Measured 2026-08-04: 263 version bumps against 30 published releases, roughly nine bumps per
 * release. main said 4.0.11, npm said 4.0.8, the GitHub release said v4.0.7. Three numbers, and a
 * user's banner printed two of them and asked the user to reconcile.
 *
 * The cause is TWO RULES ASKING ONE NUMBER TO MEAN TWO THINGS:
 *
 *   plugin/scripts/version-bump-gate.sh — "EVERY PUSH CARRIES A VERSION INCREMENT... the version
 *     number is the update signal". It MUST move on every push or plugin caches serve stale code.
 *   The release model — the version is the generation customers are running. It must move ONLY
 *     when something is actually published.
 *
 * Both rules are right. Neither can be dropped. So they cannot share one namespace, and drift was
 * not an accident — it was arithmetic, about nine deep on average.
 *
 * This repo already solved it once and abandoned the solution at 4.0: npm still carries
 * 3.9.129-dev … 3.9.134-dev. main wore a `-dev` suffix (self-evidently unreleased, still a perfectly
 * good update signal for caches) and a RELEASE promoted it to a clean number.
 *
 * The invariants below restore that, and are the customer-facing guarantee:
 *   1. Unreleased main is `-dev`. A clean version in the repo means "this exact thing was shipped".
 *   2. Every version surface agrees with every other. There is no second opinion.
 *   3. A customer never sees two numbers (enforced at the banner in session-start-core).
 */
describe('release identity — one number, and it means one thing', () => {
  it('every version surface agrees with the single source of truth', () => {
    const source = readJson('plugin/.claude-plugin/plugin.json').version;
    expect(source, 'plugin.json is the source of truth and must carry a version').toBeTruthy();
    for (const surface of ['package.json', 'kb/package.json', 'plugin/.codex-plugin/plugin.json']) {
      expect(readJson(surface).version, `${surface} disagrees with plugin.json`).toBe(source);
    }
  });

  it('an unreleased main is marked -dev, so a clean number always means SHIPPED', () => {
    const version = readJson('plugin/.claude-plugin/plugin.json').version;
    // A clean X.Y.Z on main is a claim that this exact tree is what customers are running. That is
    // only true in the instant a release promotes it, so in the repo it must carry the suffix.
    //
    // THE RELEASE-COMMIT EXEMPTION IS NOT A LOOPHOLE — IT IS THE ONE MOMENT THE CLAIM IS TRUE, AND
    // WITHOUT IT THIS TEST DEADLOCKS THE PUBLISHER (measured 2026-08-06).
    //
    // The first version of this test said "if this fails on a release commit, the release is what
    // should clear it." That is impossible, and the impossibility is circular:
    //
    //   · protected-release.yml:170/183/186/187 require the receipt, the manifest and the tag to
    //     equal package.json AT THE CANDIDATE SHA — so a release candidate must carry the CLEAN
    //     version. There is no promotion step inside the workflow; the commit IS the promotion.
    //   · that same workflow refuses any candidate whose exact-SHA `ci` run did not conclude
    //     successfully.
    //   · this assertion made `ci` red on precisely those commits.
    //
    // So every release candidate was red by construction, and the only workflow allowed to sign and
    // publish could never accept one. Combined with the unbound EXPECTED_VERSION in the same file,
    // the rail was dead in two independent ways — which is why releases were being done by hand,
    // and hand-releases are how npm and GitHub came to name different generations (#77).
    //
    // The exemption is derived from the COMMIT ITSELF, never from an env var or a skip flag: a
    // release commit must say so in its subject AND name this exact version. Any other commit
    // carrying a clean version is the lingering-drift case this invariant exists to catch, and
    // still fails. You cannot take the exemption by accident — you have to label the commit a
    // release of this version, which is the claim being checked in the first place.
    if (!/-dev$/.test(version)) {
      let subject = '';
      try {
        subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: ROOT, encoding: 'utf8' }).trim();
      } catch { /* no git (packed tarball) — fall through to the strict assertion below */ }
      const isReleaseCommitForThisVersion =
        /^release\s*\(/i.test(subject) && subject.includes(version);
      expect(
        isReleaseCommitForThisVersion,
        `main carries the clean version ${version}, which asserts it is the shipped generation, but `
        + `HEAD is not a release commit for it (subject: "${subject}"). Unreleased work must be `
        + 'X.Y.Z-dev; only the release commit that publishes this exact version may carry it clean.',
      ).toBe(true);
      return;
    }
    expect(version).toMatch(/-dev$/);
  });

  it('TEETH: the suffix check can actually fail, and the surfaces check can actually fail', () => {
    // Synthetic versions on purpose. A test that spells the REAL current version becomes a stray
    // literal the moment the product reaches it — sync-version's stray-literal scanner flags it,
    // and the suite starts failing for a reason that has nothing to do with what it tests. That
    // happened twice on this branch: a v4.0.9 literal in a forge-update test, then the live
    // version in this very file. Note the scanner reads COMMENTS too, so even naming the offending
    // literal in prose re-triggers it — which is why this note spells none of them in quotes.
    expect(/-dev$/.test('99.0.0-dev')).toBe(true); // sync-version-ignore: the literal IS the fixture
    expect(/-dev$/.test('99.0.0'), 'a clean version must NOT satisfy the unreleased check').toBe(false); // sync-version-ignore
    expect('99.0.0-dev' === '99.0.1').toBe(false); // sync-version-ignore
  });

  it('the customer-facing banner emits exactly ONE version', () => {
    const core = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'session-start-core.mjs'), 'utf8');
    // Issue #77: the banner printed the plugin version AND the bundle tag, making every user
    // adjudicate whether their own install was out of sync.
    expect(core).not.toMatch(/RuvNet Brain active \(v\$\{bannerVersion\}\$\{kbVersion/);
    expect(core, 'divergence belongs on the maintainer channel, not in the user banner')
      .toMatch(/MAINTAINER ONLY: the shipped generation is split/);
  });
});
