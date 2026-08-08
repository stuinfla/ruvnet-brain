import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmpVersion } from '../../scripts/stack-sync.mjs';

/**
 * ISSUE #123 — an install that is AHEAD of the published release is not a broken install.
 *
 * Reported against a dev install one patch AHEAD of the published release:
 *
 *   · `--update --auto` exited 1 with "host synchronization is incomplete"
 *   · `--doctor` printed "✗ FAILING — the warnings above are real"
 *
 * …while every displayed check was green: 121 repos indexed, grounding proven in 41.0s with a real
 * citation, Codex MCP live, 17 hooks enabled. Worse, the prescribed repair (re-add the marketplace,
 * reinstall the plugin) was a NO-OP, because the extras it named were present and demonstrably
 * firing in the same session.
 *
 * Telling someone their working install is broken and then handing them a fix that changes nothing
 * is the worst kind of false alarm — it costs trust and time, and it trains people to ignore the
 * next warning, which may be real.
 *
 * Cause: host convergence compared `installed === PACKAGE_VERSION`, so being AHEAD was
 * indistinguishable from being BEHIND. Convergence means NOT BEHIND.
 *
 * This test pins the predicate in BOTH directions. The cases that must still FAIL matter more than
 * the one that must now pass: a fix that simply stopped checking would satisfy the headline and
 * silently retire a real guard.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SOURCE = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');

/** The predicate exactly as bin/install.mjs defines it (ordering delegated to the one comparator). */
const versionSatisfies = (installed, expected) => {
  if (!expected) return true;
  if (!installed) return false;
  if (installed === expected) return true;
  try { return cmpVersion(installed, expected) >= 0; } catch { return installed === expected; }
};

describe('issue #123 — convergence means NOT BEHIND, not exactly-equal', () => {
  it('the reported scenario now converges: a -dev install one patch ahead of the release', () => {
    // SYNTHETIC versions on purpose, per the convention repo-count.test.mjs records: a test that
    // spells the REAL current version becomes a stray literal the instant the product reaches it,
    // and sync-version's scanner then fails this file for a reason unrelated to what it tests.
    // (It did exactly that on first write.) The defect is about ORDERING, not about two numbers.
    expect(versionSatisfies('9.9.9-dev', '9.9.8'), 'a dev build ahead of the release is ahead, not broken').toBe(true); // sync-version-ignore: the -dev literal IS the fixture — this defect only exists for prerelease strings
  });

  it('TEETH: everything that should still fail, still fails', () => {
    expect(versionSatisfies('9.9.7', '9.9.8'), 'genuinely BEHIND must remain a failure').toBe(false);
    expect(versionSatisfies('9.9.8-dev', '9.9.8'), 'a prerelease of the SAME version is behind it (semver)').toBe(false); // sync-version-ignore: same reason — the suffix is the subject under test
    expect(versionSatisfies(null, '9.9.8'), 'not installed at all must remain a failure').toBe(false);
    expect(versionSatisfies('8.0.0', '9.9.8'), 'a whole major generation behind must remain a failure').toBe(false);
  });

  it('exact match and clean-ahead both converge', () => {
    expect(versionSatisfies('9.9.8', '9.9.8')).toBe(true);
    expect(versionSatisfies('9.9.9', '9.9.8')).toBe(true);
    expect(versionSatisfies('10.0.0', '9.9.8')).toBe(true);
  });

  it('no strict version equality survives in the convergence path', () => {
    // The whole defect was `!==` where an ordering test belonged. If one comes back, this fails —
    // a comment cannot hold that line, but a test can.
    expect(SOURCE, 'host version equality must go through versionSatisfies')
      .not.toMatch(/\.version !== expectedVersion/);
    expect(SOURCE, 'receipt version equality must go through versionSatisfies')
      .not.toMatch(/desiredVersion !== expectedVersion/);
    expect(SOURCE, 'the predicate must be defined, not inlined ad hoc').toContain('const versionSatisfies');
  });

  it('ordering is delegated, never re-implemented', () => {
    // stack-sync.mjs documents itself as "the only place ordering is decided anywhere in this
    // system". A second comparator here is exactly the hand-rolled-substitute failure this repo
    // gates against elsewhere.
    expect(SOURCE).toMatch(/import \{ cmpVersion \} from '\.\.\/scripts\/stack-sync\.mjs'/);
  });
});
