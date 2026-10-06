#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// scripts/entrypoint-guard-scan.mjs — the static half of the entrypoint-guard defect class.
//
// tests/unit/entrypoint-symlink.test.mjs already documents the defect: an entry-point guard that
// resolves process.argv[1] with path.resolve and compares it against the module URL (or the
// pathToFileURL(...).href variant of the same comparison) disagrees through a symlinked
// invocation — npm bin shims, wrapper scripts, every os.tmpdir() path on macOS — so
// main() never runs and the process exits 0 having done nothing. This repo has found and fixed
// that exact shape seven separate times (commit 43bf391 "close the last 13 silent exit-0 guards —
// zero old-form guards remain", then four more found AFTER that sweep: PRs #295/#317/#333 and
// 2026-10-02's eval-brain.mjs fix), each time by a human or a Dream Cycle session noticing one
// more file by hand. "Zero old-form guards remain" was never true for long, because nothing
// stopped a 130th file from being written with the same copy-pasted broken comparison.
//
// This is the guard FOR that gap: a pure, exported scan a test can run on every push, so the next
// occurrence is a failing test instead of a future night's rediscovery.
//
// DETECTION RULE, and why it is NOT "contains path.resolve(process.argv[1])" (that first draft was
// adversarially reviewed and rejected — too narrow AND too broad at once):
//   - too narrow: it only matched the literal `path.resolve(process.argv[1])` substring, so it
//     missed every other equally-broken comparison this repo actually has — a bare
//     `pathToFileURL(process.argv[1]).href`, a template-literal `` `file://${process.argv[1]}` ``,
//     and the reversed `process.argv[1] === new URL(import.meta.url).pathname`. None of those
//     contain the exact substring, so a scan built around it was blind to all three.
//   - too broad: the literal substring also matches inside COMMENTS describing the historical bug
//     (bin/install.mjs, plugin/scripts/hook-input.mjs) and inside unrelated code that merely
//     resolves argv[1] for logging/display and never compares it to anything (kb/forge-big.mjs's
//     `const scriptPath = path.resolve(process.argv[1]);`, used only to spawn children, not as a
//     guard) — both read as "broken" when they are not.
// The actual defect is always a COMPARISON between (something derived from) process.argv[1] and
// (something derived from) import.meta.url, on CODE, not prose. So the rule is: a non-comment line
// that mentions both process.argv[1] and import.meta.url, and does not mention realpath (the one
// fix this repo has used consistently — fs.realpathSync on both sides) anywhere on that same line.
// A file abstracting the comparison behind a named helper (isDirectInvocation(), node's own
// import.meta.main) never puts both tokens on one line at the call site, so it is unaffected by
// construction — not because of a keyword exemption, but because there is nothing there to match.
const HAS_ARGV1_RE = /process\.argv\[1\]/;
const HAS_IMPORT_META_URL_RE = /import\.meta\.url/;
const SAFE_HINT_RE = /realpath/i;
const COMMENT_LINE_RE = /^\s*(\/\/|\/?\*)/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);

/** Every real CLI surface this repo ships. tests/ and fixtures carry documentation and probes, not
 * production entry points, so they are deliberately out of scope here. */
export const SCAN_DIRS = ['scripts', 'kb', 'plugin', 'bin'];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
  }
}

/**
 * Scan `root` for the broken entry-point guard shape. Returns the sorted, deduplicated list of
 * files (relative to `root`) that still carry it — never line numbers, so an unrelated edit
 * elsewhere in a flagged file cannot flip this scan's verdict.
 */
export function scanUnsafeEntrypointGuards(root, dirs = SCAN_DIRS) {
  const files = [];
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  const hits = new Set();
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes('process.argv[1]')) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (COMMENT_LINE_RE.test(line)) continue;
      if (!HAS_ARGV1_RE.test(line) || !HAS_IMPORT_META_URL_RE.test(line)) continue;
      // The comparison can legitimately span lines (e.g. a `&&`-continued boolean), and the
      // realpath-based helper it calls can be a locally named variable (`canonical(...)`, not the
      // literal word "realpath") defined a few lines above the comparison that uses it. A single
      // line is too narrow a window for either case — widen the safety check to the current line
      // plus the preceding 5, which is enough to see a split comparison or a nearby local helper
      // without losing the precision of still requiring both tokens on the FLAGGED line itself.
      const windowStart = Math.max(0, i - 5);
      const window = lines.slice(windowStart, i + 1).join('\n');
      if (SAFE_HINT_RE.test(window)) continue;
      hits.add(path.relative(root, f).split(path.sep).join('/'));
      break;
    }
  }
  return [...hits].sort();
}
