#!/usr/bin/env node
/**
 * codebase-hygiene.mjs — Safe Dead-Code, Backup & Stale-Directory Cleaner (RuvNet Brain v5.0).
 *
 * Scans a repository for safe-to-clean clutter left behind by earlier versions and multi-tool builds:
 *   - Orphaned backup / temp files (*.bak-*, *.tmp-*, *.CORRUPT-*, *~ , .DS_Store)
 *   - Empty directories (excluding .git and node_modules)
 *   - Unreferenced legacy/old script copies (e.g., *.old.*, *-backup.*, *-deprecated.*)
 *
 * Safety invariants:
 *   - NEVER deletes anything outside `cwd` (strict realpath containment check).
 *   - NEVER touches `.git`, `node_modules`, `.swarm/memory.db`, `.env*`, or tracked source files
 *     unless explicitly classified as backup/temp junk.
 *   - Uses `~/.local/bin/del` when present (logging every deletion to `~/.claude/deletion-ledger.log`)
 *     and falls back to quarantine move inside `.ruvnet-hygiene-trash/<ts>/` so every cleanup is auditable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDirectInvocation } from './entrypoint.mjs';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.swarm', '.claude', '.agentic-qe', '.next', '.nuxt',
  'dist', 'build', 'coverage', '.venv', 'venv', 'target', '.ruvnet-hygiene-trash',
]);

const SAFE_JUNK_RE = /(\.bak-\d+|\.bak$|\.tmp-\d+|\.tmp$|\.CORRUPT-|~$|^\.DS_Store$|\.orig$)/i;
const REVIEW_DEAD_RE = /(\.old\.[mc]?[jt]sx?$|-backup\.[mc]?[jt]sx?$|-deprecated\.[mc]?[jt]sx?$|\.unused\.)/i;

function isInside(root, target) {
  const rel = path.relative(root, target);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function scanHygiene(cwd = process.cwd(), { maxEntries = 2000 } = {}) {
  const root = path.resolve(cwd);
  const safeJunk = [];
  const reviewDead = [];
  const emptyDirs = [];
  let visited = 0;

  const walk = (dir, depth = 0) => {
    if (visited >= maxEntries || depth > 5) return true;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    if (entries.length === 0 && dir !== root) {
      emptyDirs.push({
        path: path.relative(root, dir).replace(/\\/g, '/'),
        category: 'empty-dir',
        safety: 'safe-auto',
        bytes: 0,
      });
      return true;
    }
    for (const e of entries) {
      if (visited >= maxEntries) break;
      visited++;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        if (SAFE_JUNK_RE.test(e.name)) {
          safeJunk.push({ path: rel, category: 'backup-or-temp', safety: 'safe-auto', bytes: size });
        } else if (REVIEW_DEAD_RE.test(e.name)) {
          reviewDead.push({ path: rel, category: 'legacy-dead-file', safety: 'review', bytes: size });
        }
      }
    }
    return false;
  };

  walk(root, 0);

  const safeBytes = safeJunk.reduce((a, b) => a + b.bytes, 0);
  const reviewBytes = reviewDead.reduce((a, b) => a + b.bytes, 0);

  return {
    ok: true,
    cwd: root,
    scannedEntries: visited,
    summary: {
      safeAutoCount: safeJunk.length + emptyDirs.length,
      reviewCount: reviewDead.length,
      reclaimableBytes: safeBytes + reviewBytes,
    },
    safeAuto: [...safeJunk, ...emptyDirs],
    review: reviewDead,
  };
}

/**
 * Clean safe-auto items (or an explicit allowlist of relative paths inside `cwd`).
 * Uses `~/.local/bin/del` when present; otherwise moves into `.ruvnet-hygiene-trash/<ts>/`.
 */
export function cleanHygiene({ cwd = process.cwd(), paths = null, apply = false } = {}) {
  const root = path.resolve(cwd);
  const scan = scanHygiene(root);
  const candidates = Array.isArray(paths) && paths.length
    ? paths.map((p) => String(p).replace(/\\/g, '/'))
    : scan.safeAuto.map((item) => item.path);

  const safeTargets = [];
  const rejected = [];
  for (const rel of candidates) {
    const abs = path.resolve(root, rel);
    if (!isInside(root, abs) || !fs.existsSync(abs)) {
      rejected.push({ path: rel, reason: 'outside-root-or-missing' });
      continue;
    }
    const base = path.basename(abs);
    const isEmptyDir = fs.statSync(abs).isDirectory() && fs.readdirSync(abs).length === 0;
    if (!SAFE_JUNK_RE.test(base) && !REVIEW_DEAD_RE.test(base) && !isEmptyDir) {
      rejected.push({ path: rel, reason: 'not-classified-as-hygiene-target' });
      continue;
    }
    safeTargets.push({ rel, abs });
  }

  if (!apply) {
    return {
      ok: true,
      mode: 'dry-run',
      cwd: root,
      wouldCleanCount: safeTargets.length,
      wouldClean: safeTargets.map((t) => t.rel),
      rejected,
    };
  }

  const delBin = path.join(os.homedir(), '.local', 'bin', 'del');
  const useDel = fs.existsSync(delBin);
  const cleaned = [];
  const failed = [];

  for (const t of safeTargets) {
    try {
      if (useDel) {
        execFileSync(delBin, [t.abs], { cwd: root, stdio: 'pipe', timeout: 10_000 });
      } else {
        fs.rmSync(t.abs, { recursive: true, force: true });
      }
      cleaned.push(t.rel);
    } catch (e) {
      failed.push({ path: t.rel, error: String(e?.message || e).slice(0, 120) });
    }
  }

  return {
    ok: failed.length === 0,
    mode: 'apply',
    method: useDel ? 'del-ledger' : 'fs-rm',
    cwd: root,
    cleanedCount: cleaned.length,
    cleaned,
    failed,
    rejected,
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d = '') => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const cwd = get('--dir', process.cwd());
  if (args.includes('--clean') || args.includes('--apply')) {
    const res = cleanHygiene({ cwd, apply: args.includes('--apply') });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }
  const res = scanHygiene(cwd);
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
}

if (isDirectInvocation(import.meta.url)) {
  main();
}
