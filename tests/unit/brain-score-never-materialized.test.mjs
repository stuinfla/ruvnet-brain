import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCoverage } from '../../scripts/brain-score.mjs';

/**
 * Dream Cycle 2026-08-21, DEEP=brain-currency. `restore-local-ingests.mjs`'s `classify()` was fixed
 * in PR #143 (Night 1) to distinguish "store root never materialized on this host" from "wiped" —
 * `storesAt()` silently returns `[]` on ENOENT, and treating that as evidence produced a false alarm
 * on every ephemeral checkout. `brain-score.mjs`'s `catalogue` coverage dimension shares the exact
 * same `storesAt(root)` call and never got the fix: measured live in this Dream Cycle's own
 * container (a fresh checkout with no materialized `~/.cache/ruvnet-brain/kb`), `catalogue` reports
 * a real-looking `0` / `"0/206 live repos"` tagged `status: 'current'` — indistinguishable from a
 * host that genuinely has near-zero coverage.
 */
describe('brain-score catalogue distinguishes never-materialized from a real empty root', () => {
  it('TEETH: a root that does not exist on disk is reported unmeasured, not a false current 0', async () => {
    const missingRoot = path.join(os.tmpdir(), `brain-score-never-materialized-${process.pid}-${Date.now()}`);
    expect(fs.existsSync(missingRoot), 'fixture precondition: this path must not exist').toBe(false);

    const cov = await readCoverage(missingRoot);

    expect(cov.catalogue.value, 'a never-materialized root must not produce a numeric catalogue value').toBeNull();
    expect(cov.catalogue.detail).toMatch(/never materialized|does not exist/i);
    expect(cov.routable.value).toBeNull();
    expect(cov.routable.detail).toMatch(/never materialized|does not exist/i);
  });

  it('TEETH: a stray FILE where the root directory belongs is reported unmeasured, not a false current 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-score-stray-file-'));
    const strayRoot = path.join(dir, 'root-as-file');
    fs.writeFileSync(strayRoot, 'x');
    try {
      expect(fs.existsSync(strayRoot), 'fixture precondition: existsSync must see it as present').toBe(true);

      const cov = await readCoverage(strayRoot);

      expect(cov.catalogue.value, 'a stray-file root must not produce a numeric catalogue value').toBeNull();
      expect(cov.catalogue.detail).toMatch(/never materialized|does not exist/i);
      expect(cov.routable.value).toBeNull();
      expect(cov.routable.detail).toMatch(/never materialized|does not exist/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a root that DOES exist but is genuinely empty still reports a real 0, not unmeasured', async () => {
    const realEmptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-score-real-empty-'));
    try {
      const cov = await readCoverage(realEmptyRoot);
      // org-repo-count.json's total is known and present in this repo, so an existing-but-empty
      // root is a REAL, reportable 0 — this must stay distinguishable from the never-materialized case.
      expect(cov.catalogue.value).toBe(0);
      expect(cov.catalogue.detail).not.toMatch(/never materialized/i);
      // routable stays unmeasured here too, but for the ORIGINAL reason (zero stores built),
      // not because the root itself is absent.
      expect(cov.routable.value).toBeNull();
    } finally {
      fs.rmSync(realEmptyRoot, { recursive: true, force: true });
    }
  });
});
