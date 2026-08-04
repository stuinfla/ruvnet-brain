// project-identity.mjs — ONE answer to "which directory is this, and have I seen it already?"
//
// WHY THIS EXISTS. Two user-filed bugs, #85 and #107, are the same defect: the product derives a
// project's location independently at each site and the sites then disagree.
//
//   #85  The PreCompact producer wrote its receipt under `CLAUDE_PROJECT_DIR`; the Console probe
//        that reports whether a receipt exists looked under `process.cwd()`. Launch the Console
//        from a subdirectory of the project and it warns "no supported PreCompact snapshot found"
//        about a snapshot it had itself just written. Nothing was broken except the agreement.
//
//   #107 `candidateRoots()` returned BOTH `~/Code` and `~/code`, which on APFS are one directory
//        with one inode. Every project under them was scanned, counted and summed twice, so the
//        machine-wide memory total read exactly 2x — silently, confidently, in the one figure the
//        Console exists to make trustworthy. `path.resolve()` was the guard, and it normalises
//        `.`/`..` only: it case-folds nothing and resolves no symlinks, which the guard's own
//        comment ("e.g. a symlink") shows it was believed to do.
//
// WHY DEVICE+INODE RATHER THAN LOWER-CASING. Lower-casing is a guess about the filesystem, and it
// is wrong on the machines that would suffer most: Linux, and case-sensitive APFS volumes, where
// `Code` and `code` really are two projects and folding them would DELETE one from the report.
// `st_dev` + `st_ino` is not a guess — it is the filesystem's own answer, correct in both
// directions on every volume, and it settles symlinks and bind mounts in the same stroke. The
// case-insensitivity probe the reporter suggested (write a temp file, stat the other spelling)
// would also work, but it writes to the user's disk to learn something `stat` already knows.
//
// `fs.realpathSync.native` is the OS canonicaliser: it resolves symlinks AND returns the case as
// stored on disk. Plain `fs.realpathSync` is a JavaScript reimplementation that does symlinks only
// — measured on this repo's own machine, `realpathSync('~/code')` stays `~/code` while
// `realpathSync.native('~/code')` returns `~/Code`. That one missing word is the whole of #107.
import fs from 'node:fs';
import path from 'node:path';

const defaultRealpath = (value) => fs.realpathSync.native(value);
const defaultStat = (value) => fs.statSync(value, { bigint: true });

/** The operating system's own spelling of an existing path, or null when it cannot be resolved. */
export function canonicalPath(value, { realpath = defaultRealpath } = {}) {
  if (typeof value !== 'string' || !value) return null;
  try { return realpath(value); } catch { return null; }
}

/**
 * A key that is equal for two names of one directory and different for two directories.
 * Falls back to the canonical path when the volume reports no usable inode (some Windows and
 * network mounts report 0) — never worse than the raw string compare it replaces.
 */
export function pathIdentity(value, { realpath = defaultRealpath, stat = defaultStat } = {}) {
  const canonical = canonicalPath(value, { realpath });
  if (!canonical) return null;
  try {
    const info = stat(canonical);
    if (info?.ino) return `${info.dev}:${info.ino}`;
  } catch { /* unreadable — the canonical spelling is still a better key than the raw one */ }
  return canonical;
}

/** True when both names denote the same existing directory or file. */
export function sameLocation(a, b, options = {}) {
  const left = pathIdentity(a, options);
  return left !== null && left === pathIdentity(b, options);
}

/** True when `child` is `root` or lies beneath it, compared canonically rather than by raw string. */
export function contains(root, child, options = {}) {
  const canonicalRoot = canonicalPath(root, options);
  const canonicalChild = canonicalPath(child, options);
  if (!canonicalRoot || !canonicalChild) return false;
  if (sameLocation(canonicalRoot, canonicalChild, options)) return true;
  const relative = path.relative(canonicalRoot, canonicalChild);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * THE project directory. The PreCompact snapshot producer and the Console probe that detects the
 * snapshot both call this, so they cannot disagree about where the project is (#85).
 *
 * `CLAUDE_PROJECT_DIR` wins only when the current directory actually lies inside it. Containment,
 * not mere presence, is what makes the two sides agree by construction: a hook and a Console
 * launched anywhere within one project resolve to that project's root, while a caller that hands
 * over an unrelated directory (a test fixture, an explicit `--project`) is never overruled by an
 * environment variable it knows nothing about.
 */
export function projectDirectory({ env = process.env, cwd = process.cwd(), ...options } = {}) {
  const here = canonicalPath(cwd, options) || path.resolve(cwd);
  const declared = typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.trim()
    ? canonicalPath(env.CLAUDE_PROJECT_DIR, options)
    : null;
  return declared && contains(declared, here, options) ? declared : here;
}
