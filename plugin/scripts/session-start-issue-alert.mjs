#!/usr/bin/env node
// session-start-issue-alert.mjs — the maintainer-only open-issue pointer.
//
// REWRITTEN 2026-09-11 after two findings:
//   1. SCOPING BUG: the per-user entitlement file was never checked against the CURRENT project's
//      identity, so an entitled maintainer saw the alert in every unrelated project on the machine.
//      Fixed by session-start-repo-identity.mjs's isMaintainerRepo() — BOTH the local entitlement
//      file AND the current checkout's git remote must agree before anything is shown.
//   2. SCOPE CREEP: SessionStart printed a per-issue breakdown (numbers, titles, ages) sourced from a
//      GitHub lookup. Per reviewer correction, that detail belongs to issue-watch.mjs's own output
//      surface (its console report and open-issues.json), not to a hook that fires on every prompt
//      boundary. SessionStart now prints AT MOST one line — a pointer, not a report — read from the
//      cache within a 100ms budget and never touching the network itself.
import fs from 'node:fs';
import path from 'node:path';
import { isMaintainerRepo } from './session-start-repo-identity.mjs';

const json = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

export const ISSUE_POINTER_BUDGET_MS = 100;
// A corrupt/huge open-issues.json is not evidence of anything actionable; refuse to even attempt
// parsing past this size rather than let a pathological file consume the stage's budget.
const MAX_STATUS_BYTES = 256 * 1024;

export const maintainerIssueEntitlement = (env, home, repo, platform = process.platform) => {
  const file = env.RUVNET_BRAIN_MAINTAINER_ISSUES_FILE
    || path.join(home, '.config', 'ruvnet-brain', 'maintainer-issues.json');
  // Windows ACL ownership is not available through this dependency-free hot path. Fail closed
  // instead of weakening an owner-only promise into "any local user who can write the file".
  if (platform === 'win32') return false;
  let stat;
  try { stat = fs.lstatSync(file); } catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  // This is maintainer-only operational data. Refuse group/world-readable opt-ins on POSIX so a
  // shared machine cannot turn a private maintainer signal into a terminal banner for other users.
  if ((stat.mode & 0o077) !== 0) return false;
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
  const entitlement = json(file);
  return entitlement?.enabled === true
    && Array.isArray(entitlement.repos)
    && entitlement.repos.includes(repo);
};

/**
 * At most ONE line, naming a count and where to look — never a per-issue breakdown. Requires BOTH
 * the local per-user entitlement file AND the current project's git remote to name the entitled
 * repo; either alone is not enough (see module header).
 */
export function surfaceIssuePointer({ stateDir, emit, now, env, home, platform, cwd, budgetMs = ISSUE_POINTER_BUDGET_MS }) {
  const start = Date.now();
  try {
    const statusPath = path.join(stateDir, 'open-issues.json');
    let size = 0;
    try { size = fs.statSync(statusPath).size; } catch { return; }
    if (size > MAX_STATUS_BYTES) return;

    const status = json(statusPath);
    const observedAt = Date.parse(status?.at || '');
    if (!Number.isFinite(observedAt) || observedAt > now + 5 * 60_000 || now - observedAt > 6 * 3600_000) return;
    // The 100ms budget covers exactly what correction #2 named — "a one-line pointer read from the
    // cache" — checked HERE, before the (separately, generously bounded — see
    // session-start-repo-identity.mjs's own spawnSync timeout) git-based repo-scoping check below.
    // A local JSON read is always microseconds; a real overrun here means something pathological.
    if (Date.now() - start > budgetMs) return;
    if (!maintainerIssueEntitlement(env, home, status.repo, platform)) return;
    if (!isMaintainerRepo(cwd)) return; // the CURRENT project must itself be the entitled repo

    const open = Array.isArray(status.issues) ? status.issues : [];
    if (!open.length) return;
    const breaches = open.filter((issue) => issue.breach).length;
    const ageHours = (now - observedAt) / 3_600_000;
    const breachNote = breaches ? `, ${breaches} past SLA` : '';
    emit(`[RuvNet Brain — OPEN ISSUES: ${open.length} on ${status.repo}${breachNote}, checked ${ageHours.toFixed(1)}h ago — full detail: node scripts/issue-watch.mjs]`);
  } catch { /* advisory only — a broken cache read must never affect the session */ }
}
