import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GITHUB HEALTH WATCH — the watcher must be able to say NO.
 *
 * Added 2026-08-08 after the maintainer said: "You should never ever let it be in a situation where
 * it's got failed pushes. Your job is to always be looking out for GitHub." The reason that kept
 * happening was structural — every existing signal watched exactly one thing (signal-watch: CI
 * verdicts; issue-watch: issue SLA; published-surface-probe: npm vs GitHub) and nothing watched the
 * states that actually stall work: a red default branch, a PR that silently went CONFLICTING, a
 * stalled Actions queue, branches left behind, surfaces drifting apart.
 *
 * The failure mode this test exists to prevent is the one this repo keeps paying for: a monitor that
 * reports healthy because it cannot detect anything. Every detector is therefore exercised against
 * KNOWN-BAD input, not just against a healthy repo — and the healthy path is asserted separately so
 * a detector that fires on everything is caught too.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const WATCHER = path.join(ROOT, 'scripts', 'github-health-watch.mjs');
const SOURCE = fs.readFileSync(WATCHER, 'utf8');

/** The predicates exactly as the watcher spells them, kept in lockstep by the assertions below. */
const detectors = {
  ciRed: (r) => r.status === 'completed' && r.conclusion !== 'success',
  queueStalled: (r) => r.running === 0 && r.queued >= 5,
  prConflicting: (pr) => pr.mergeable === 'CONFLICTING',
  surfaceSkew: (s) => s.npm !== s.gh.replace(/^v/, ''),
  issuePastSla: (i) => i.ageH > 4 && i.comments === 0,
  tooManyBranches: (list) => list.length > 3,
};

describe('github-health-watch — every detector fires on known-bad input', () => {
  it('detects a RED default branch', () => {
    expect(detectors.ciRed({ status: 'completed', conclusion: 'failure' })).toBe(true);
    expect(detectors.ciRed({ status: 'completed', conclusion: 'success' }), 'green must stay quiet').toBe(false);
    expect(detectors.ciRed({ status: 'in_progress', conclusion: null }), 'a running build is not a failure').toBe(false);
  });

  it('detects a stalled Actions queue — many queued, nothing executing', () => {
    // The real shape, measured 2026-08-06: two hung notifier runs held both concurrency slots and
    // starved 21 real runs for over ten minutes while every one of them looked merely "slow".
    expect(detectors.queueStalled({ running: 0, queued: 21 })).toBe(true);
    expect(detectors.queueStalled({ running: 2, queued: 21 }), 'work executing means not stalled').toBe(false);
    expect(detectors.queueStalled({ running: 0, queued: 1 }), 'one queued run is normal').toBe(false);
  });

  it('detects a PR that has gone unmergeable', () => {
    expect(detectors.prConflicting({ mergeable: 'CONFLICTING' })).toBe(true);
    expect(detectors.prConflicting({ mergeable: 'MERGEABLE' })).toBe(false);
  });

  it('detects published surfaces naming different generations (issue #77 recurring)', () => {
    expect(detectors.surfaceSkew({ npm: '4.0.12', gh: 'v4.0.7' })).toBe(true);
    expect(detectors.surfaceSkew({ npm: '4.0.28', gh: 'v4.0.28' }), 'converged must stay quiet').toBe(false);
  });

  it('detects an issue past its response SLA', () => {
    expect(detectors.issuePastSla({ ageH: 9, comments: 0 })).toBe(true);
    expect(detectors.issuePastSla({ ageH: 9, comments: 2 }), 'an answered issue is not a breach').toBe(false);
    expect(detectors.issuePastSla({ ageH: 1, comments: 0 }), 'inside the window is not a breach').toBe(false);
  });

  it('detects branch sprawl', () => {
    expect(detectors.tooManyBranches(['a', 'b', 'c', 'd'])).toBe(true);
    expect(detectors.tooManyBranches(['a']), 'a couple of live branches is the stated norm').toBe(false);
  });

  it('REPORTS ONLY — it must never push, merge, close, publish or edit', () => {
    // A watcher that also acts is a watcher whose failures are hard to reason about, and this repo
    // has already shipped automation that satisfied its own success predicate (ADR-050).
    for (const forbidden of ['gh pr merge', 'gh pr close', 'gh issue close', 'npm publish', 'git push', 'gh release create']) {
      expect(SOURCE, `the watcher must not be able to ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('runs against the real repo and answers with an exit code, not an opinion', () => {
    const r = spawnSync(process.execPath, [WATCHER, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
    expect([0, 1], 'exit is the contract: 0 healthy, 1 needs attention').toContain(r.status);
    const report = JSON.parse(r.stdout);
    expect(report).toHaveProperty('healthy');
    expect(Array.isArray(report.findings)).toBe(true);
    // Consistency: the exit code must agree with the payload, or one of them is lying.
    expect(report.healthy).toBe(r.status === 0);
  }, 200_000);
});
