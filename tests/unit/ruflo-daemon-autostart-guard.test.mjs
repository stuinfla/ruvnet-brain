// tests/unit/ruflo-daemon-autostart-guard.test.mjs — repo-wide static guard: a file that spawns the
// `ruflo` binary directly (spawnSync/execFileSync/spawn/execFile with the literal 'ruflo') must also
// set RUFLO_DAEMON_AUTOSTART somewhere in that same file. Every `ruflo` CLI invocation auto-starts a
// project background daemon otherwise (verified live against the installed CLI, 2026-09-11:
// ~/.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/services/
// daemon-autostart.js:85 — `RUFLO_DAEMON_AUTOSTART=0|false|no|off` disables it).
//
// SCOPE: this is a coarse, per-FILE heuristic (does the file mention the guard ANYWHERE, not "is
// every call site individually guarded") — deliberately simple and reliable rather than a full AST
// analysis. It covers .mjs/.js only; the handful of shell scripts that invoke `ruflo` directly
// (scripts/proxy/{claude-proxied,proxy-up,proxy-revert}.sh) were checked and fixed by hand in the
// same pass that added this test (each now `export`s the var near the top).
//
// OWNERSHIP: files matching another lane's explicit ownership patterns (continuity, session-start,
// grounding, advocacy — see this lane's task brief) are EXEMPTED here; that lane is responsible for
// its own files and was messaged separately. Nothing in the exempt list should be read as "known
// broken" — capability-registry.mjs, for one, only LOCATES ruflo (documented in its own header as
// "LOCATES, NEVER EXECUTES") and would not match the spawn pattern below regardless.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

// Directories worth scanning for a direct `ruflo` binary spawn (repo-authored automation, not
// vendored deps or generated output).
const SCAN_DIRS = ['scripts', 'bin', 'plugin/scripts'];

// Other lanes' explicit file ownership (from this lane's task brief) — theirs to guard, not scanned
// here. Patterns match a path SEGMENT anywhere under the scanned dirs.
const OTHER_LANE_PATTERNS = [
  /plugin\/scripts\/project-progression-/, /plugin\/scripts\/session-snapshot-/,
  /plugin\/scripts\/hook-shim/, /plugin\/scripts\/codex-hook-/,
  /plugin\/scripts\/session-start-/,
  /kb\/forge-ask-all/, /kb\/forge-rerank/, /plugin\/mcp\//,
  /plugin\/scripts\/anticipate\.sh/, /plugin\/scripts\/unprompted-runtime\.mjs/,
  /plugin\/scripts\/capability-registry\.mjs/, /plugin\/scripts\/advocacy-outcomes\.mjs/,
];

// Extracts the FIRST ARGUMENT token of every spawnSync/execFileSync/spawn/execFile call in `src`,
// then asks whether that token — a quoted string's contents, or a bare identifier — looks like a
// ruflo binary. Two shapes cover every real call site found in this repo: the literal string
// ('ruflo'), and a resolved-binary variable whose name says what it holds (RUFLO, rufloBin,
// RUFLO_BIN, ...) — hence case-insensitive on the identifier form. A single mandatory-prefix regex
// (`[A-Za-z_$]<ruflo>...`) would silently reject an identifier that IS exactly "RUFLO" with nothing
// before it — that false negative is why this is two steps instead of one combined pattern.
const SPAWN_CALL = /\b(?:spawnSync|execFileSync|spawn|execFile)\s*\(\s*(?:(['"])([^'"]*)\1|([A-Za-z_$][A-Za-z0-9_$]*))/g;

function fileSpawnsRuflo(src) {
  let m;
  SPAWN_CALL.lastIndex = 0;
  while ((m = SPAWN_CALL.exec(src))) {
    const token = m[2] !== undefined ? m[2] : m[3]; // quoted-string contents, or the bare identifier
    if (/ruflo/i.test(token)) return true;
  }
  return false;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('RUFLO_DAEMON_AUTOSTART guard — every file that spawns the ruflo binary must set it', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  const relevant = files.filter((f) => {
    const rel = path.relative(ROOT, f);
    if (OTHER_LANE_PATTERNS.some((p) => p.test(rel))) return false;
    if (rel.includes(`${path.sep}test${path.sep}`) || rel.includes(`${path.sep}tests${path.sep}`)) return false;
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { return false; }
    return fileSpawnsRuflo(src);
  });

  it('found at least one file that legitimately spawns ruflo directly — otherwise this guard is vacuous', () => {
    // Sanity check on the scanner itself: if this ever hits 0, the pattern or SCAN_DIRS broke, not
    // that the repo stopped spawning ruflo.
    expect(relevant.length).toBeGreaterThan(0);
  });

  it.each(relevant.map((f) => [path.relative(ROOT, f)]))('%s sets RUFLO_DAEMON_AUTOSTART', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(src).toContain('RUFLO_DAEMON_AUTOSTART');
  });
});
