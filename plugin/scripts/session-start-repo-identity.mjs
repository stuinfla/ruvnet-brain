#!/usr/bin/env node
// session-start-repo-identity.mjs — resolves whether the CURRENT project's git remote IS the one
// maintainer-scoped repo, read-only and bounded. See session-start-issue-alert.mjs for the bug this
// closes.
//
// THE BUG (found 2026-09-11): the maintainer entitlement file
// (~/.config/ruvnet-brain/maintainer-issues.json) is PER-USER, not per-project. A maintainer entitled
// for stuinfla/ruvnet-brain therefore saw the SAME "16 issues past SLA" banner in every UNRELATED
// project on the machine — Codex repeated it in 4 of 8 answers on sandbox repos with zero relation to
// ruvnet-brain. The entitlement check never looked at what project the session was actually IN. This
// module is that missing half.
//
// FIXED CONSTANT, ON PURPOSE (reviewer correction 2026-09-11): entitlement must be an exact
// remote-URL match against ONE fixed repo, never a value read back out of a cache file or the
// entitlement file's own `repos` array — so a corrupted or malicious open-issues.json / entitlement
// file can widen who is ASKED, but never which repo is ELIGIBLE to be asked about.
import { spawnSync } from 'node:child_process';

export const MAINTAINER_REPO_SLUG = 'stuinfla/ruvnet-brain';

// Matches both `git@github.com:owner/repo.git` (ssh) and `https://github.com/owner/repo(.git)`.
const SLUG_RE = /github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/;

/** "owner/repo" from a git remote URL in either form; null for anything else (including no URL). */
export function parseRepoSlugFromRemote(remoteUrl) {
  const m = SLUG_RE.exec(String(remoteUrl || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Read-only, LOCAL-only (`git config --get`, never a network call), bounded so a hung or missing
 * git binary can never eat the SessionStart budget. Returns null for: not a git checkout, no
 * `origin` remote, a non-GitHub remote, or git missing/erroring.
 *
 * 1000ms, not a few hundred (2026-09-11, found live under real machine load with several parallel
 * agents contending for CPU): `git config --get` is normally single-digit ms, but a tighter budget
 * measurably flaked under contention — the git subprocess got killed before it could answer, which
 * fails CLOSED (hides the pointer) rather than open, but is still avoidable jitter for a purely
 * local read. Matches this codebase's own convention for "should be near-instant, allow headroom
 * for a loaded runner" (ascii-drift.mjs's spawnSync timeout is the same order of magnitude). */
export function resolveProjectRepoSlug(cwd, { timeoutMs = 1000, gitBin = process.env.GIT_BIN || 'git' } = {}) {
  try {
    const r = spawnSync(gitBin, ['config', '--get', 'remote.origin.url'], {
      cwd, encoding: 'utf8', timeout: timeoutMs,
    });
    if (r.status !== 0) return null;
    return parseRepoSlugFromRemote(r.stdout);
  } catch { return null; }
}

/** The ONE predicate maintainer-only content may gate on: is THIS project checkout the entitled
 * repo, by exact remote-URL match against the fixed constant above. */
export function isMaintainerRepo(cwd, options) {
  return resolveProjectRepoSlug(cwd, options) === MAINTAINER_REPO_SLUG;
}
