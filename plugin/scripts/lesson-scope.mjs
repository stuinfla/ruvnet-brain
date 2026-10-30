/**
 * Where a lesson applies: the ONE project-identity and applicability rule, shared by plugin/scripts/lesson-gate.mjs and
 * the Console (scripts/onboarding-console.mjs). Re-exported from lesson-store.mjs. Pure apart from the git/fs reads
 * projectNameFor makes, which are bounded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectStore } from './project-store-resolver.mjs';

/**
 * THE project identity lessons are scoped by: the folder name of the CANONICAL project root (the primary checkout,
 * the same root resolveProjectStore uses for the store), so a linked worktree `feature-x` is the project it belongs to,
 * not its own name. Falls back to the nearest folder holding a `.git`, then to the folder itself, when the resolver
 * refuses (the name is only a lesson-scope label; a refusal must not silence the gate).
 */
export function projectNameFor(cwd = process.cwd()) {
  try { return path.basename(resolveProjectStore({ projectDir: cwd, gitTimeoutMs: 500 }).projectRoot); } catch { /* fall through */ }
  let d = cwd;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return path.basename(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.basename(cwd);
}

/**
 * `a` matches `b` when `b` is a whole path/name SEGMENT suffix of `a`: the character before it must be a separator,
 * never a mid-word letter ("Sentry" must not match inside "WhitSentry").
 */
export function segmentSuffixMatch(a, b) {
  if (a === b) return true;
  if (a.length <= b.length || !a.endsWith(b)) return false;
  return /[-_/]/.test(a[a.length - b.length - 1]);
}

/**
 * THE applicability rule (lesson-gate and the Console share it): a lesson applies to a project when it is unscoped,
 * scoped to that project (stored names may carry a `Code-` prefix the folder lacks), or proven in two or more
 * projects (cross-project rediscovery is what makes it universal, ADR-029).
 */
export function lessonApplies(lesson, projectName) {
  const ps = Array.isArray(lesson?.projects) ? lesson.projects : [];
  if (!ps.length || ps.length >= 2) return true;
  const here = String(projectName);
  return ps.some((p) => {
    const n = String(p).replace(/^Code-/, '');
    return n === here || String(p) === here || segmentSuffixMatch(here, n) || segmentSuffixMatch(n, here);
  });
}
