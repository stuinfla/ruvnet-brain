import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reclaimBackups } from '../../kb/forge-update.mjs';

/**
 * ISSUES #130 / #131 — the backup reclaimer failed closed forever on an ordinary npm symlink.
 *
 * PR #124 hardened the private-overlay updater so that a governed store file may never be a
 * symlink. That is right, and it must stay. But the SAME walker was used to inventory backups, and
 * a KB backup contains `node_modules`, where npm's `.bin` entries are ALWAYS symlinks. So the very
 * first `.bin/semver` link made every inventory "incomplete" and every reclaim refuse:
 *
 *     KEPT kb.bak-… — inventory is incomplete; refusing destructive reclaim
 *       (unreadable inventory tree: symbolic link is not a governed regular file: node_modules/…)
 *
 * Permanent, not incidental. Measured on the maintainer's machine: 63 backups, ~72 GB, growing
 * ~1.2 GB per nightly run, every one refused for that identical reason. The refusal was SAFE and the
 * SCOPE was wrong — and a guard that can never pass is not protecting anything, it is leaking disk.
 *
 * The security property is unchanged where it matters, and this file exists to keep it that way: a
 * symlink standing in for a store file still throws, in either mode.
 */
const temps = [];
const mktemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
const cleanup = () => temps.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

/** A KB dir plus one backup beside it, shaped like the real thing. */
function layout({ withNpmSymlink = true, symlinkedRvf = false } = {}) {
  const parent = mktemp('reclaim-');
  const kb = path.join(parent, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'ruflo.big.rvf'), 'live');

  const backup = path.join(parent, 'kb.bak-2026-01-01T00-00-00-000Z');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'ruflo.big.rvf'), 'old');
  if (withNpmSymlink) {
    fs.mkdirSync(path.join(backup, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync('/usr/bin/true', path.join(backup, 'node_modules', '.bin', 'semver'));
  }
  if (symlinkedRvf) {
    fs.symlinkSync('/usr/bin/true', path.join(backup, 'evil.rvf'));
  }
  return { kb, backup };
}

describe('issues #130/#131 — reclaim tolerates tooling symlinks, never store symlinks', () => {
  it('reclaims a backup that contains npm .bin symlinks', () => {
    const { kb, backup } = layout({ withNpmSymlink: true });
    const result = reclaimBackups({ kbDir: kb });
    const refusals = (result.kept || []).map(([, why]) => String(why)).join(' | ');
    expect(refusals, 'an npm .bin symlink must not make the inventory unreadable')
      .not.toMatch(/symbolic link is not a governed regular file/);
    expect(fs.existsSync(backup), 'the backup should actually be gone, not merely un-refused').toBe(false);
    cleanup();
  });

  it('TEETH: a symlink standing in for a STORE FILE still refuses', () => {
    // This is the case PR #124 hardened. If loosening the inventory ever swallowed it, the reclaimer
    // would happily walk a tree where a .rvf points somewhere else entirely.
    const { kb, backup } = layout({ withNpmSymlink: true, symlinkedRvf: true });
    const result = reclaimBackups({ kbDir: kb });
    const refusals = (result.kept || []).map(([, why]) => String(why)).join(' | ');
    expect(refusals, 'a symlinked .rvf is exactly what the hardening exists for')
      .toMatch(/symbolic link is not a governed regular file/);
    expect(fs.existsSync(backup), 'and the backup must be kept, not destroyed').toBe(true);
    cleanup();
  });

  it('reports what it freed, so a silent no-op cannot masquerade as success', () => {
    const { kb } = layout({ withNpmSymlink: true });
    const result = reclaimBackups({ kbDir: kb });
    expect(result).toHaveProperty('removed');
    expect(result).toHaveProperty('freed');
    expect(typeof result.freed === 'number' || typeof result.freed === 'string').toBe(true);
    cleanup();
  });
});
