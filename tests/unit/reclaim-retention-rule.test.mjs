/**
 * Retention rule for full-KB copies beside the installed brain (measured 2026-09-11: a 1.2 GB brain
 * held three times — kb, kb.install-preserved-*, kb.bak-* — and --apply refused to run at all).
 *
 *   (a) an `.install-preserved-` sibling is a reclaim candidate under the SAME redundancy proof as
 *       `.bak-` — never deleted unless every byte survives in the live brain.
 *   (b) stores the live COVERAGE.json marks ineligible (policy exclusions) are intentionally absent
 *       from live; their presence in a backup no longer pins it as "lost".
 *   (c) a PRIVATE-fenced store (PRIVATE-STORES.json) the live brain lacks pins its backup: reported,
 *       never removed, and not authorizable away — but it is not a recovery blocker.
 *   (d) being over the one-snapshot budget is reported; only an unmeasured / unsafe / lost-store copy
 *       blocks an update. `dryRun` reports the plan and deletes nothing.
 *
 * The existing data-safety spec is untouched: an UNDECLARED unique store still blocks, and no
 * unique bytes are ever deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reclaimBackups } from '../../kb/forge-update.mjs';

let root;
const mk = (dir, files) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1));
  return dir;
};
const ledger = (dir, stores) => fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores }));
const coverage = (dir, rows) => fs.writeFileSync(path.join(dir, 'COVERAGE.json'), JSON.stringify({ rows }));
const fence = (dir, privateStores) => fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores }));
const A = { a: { file: 'a.rvf' } };

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-rule-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('(a) install-preserved siblings', () => {
  it('are reclaimed when every byte survives in the live brain', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 2048 }); ledger(kb, A);
    const preserved = mk(path.join(root, 'kb.install-preserved-pPgP8t'), { 'a.rvf': 2048 }); ledger(preserved, A);
    const result = reclaimBackups({ kbDir: kb, env: {} });
    expect(result.removed).toEqual([preserved]);
    expect(fs.existsSync(preserved)).toBe(false);
  });
  it('are kept, unclassified, when their bytes differ — eligible is not the same as redundant', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 2048 }); ledger(kb, A);
    const preserved = mk(path.join(root, 'kb.install-preserved-pPgP8t'), { 'a.rvf': 2048 }); ledger(preserved, A);
    fs.writeFileSync(path.join(preserved, 'a.rvf'), Buffer.alloc(2048, 7));
    const result = reclaimBackups({ kbDir: kb, env: {} });
    expect(result.removed).toEqual([]);
    expect(result.kept[0][1]).toMatch(/PRESERVED_UNCLASSIFIED/);
    expect(fs.existsSync(preserved)).toBe(true);
  });
});

describe('(b) policy exclusions recorded in the live COVERAGE.json', () => {
  it('no longer pin a backup as holding a lost store', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 }); ledger(kb, A);
    coverage(kb, [{ kind: 'repository', name: 'agentic-music', disposition: 'excluded-no-corpus', status: 'INELIGIBLE',
      artifact: { store: 'agentic-music' } }]);
    const bak = mk(path.join(root, 'kb.bak-2026-09-04'), { 'a.rvf': 64, 'agentic-music.big.rvf': 128 });
    ledger(bak, { ...A, 'agentic-music': { file: 'agentic-music.big.rvf' } });
    // Ample byte budget: this test is about the lost→not-lost transition, not retention budget.
    const result = reclaimBackups({ kbDir: kb, env: { RUVNET_MAX_ROLLBACK_BYTES: '100000' } });
    expect(result.removed).toEqual([]);
    expect(result.kept[0][1]).not.toMatch(/does NOT have/);
    expect(result.kept[0][1]).toMatch(/PRESERVED_UNCLASSIFIED/);
    expect(result.retained[0].safeToRetainDuringUpdate).toBe(true);
    expect(result.blockingRetained).toEqual([]);
    expect(fs.existsSync(path.join(bak, 'agentic-music.big.rvf'))).toBe(true);
  });
  it('an eligible row with no artifact is NOT an exclusion — the backup still blocks', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 }); ledger(kb, A);
    coverage(kb, [{ kind: 'repository', name: 'Event-Horizon', disposition: 'eligible', status: 'MISSING',
      artifact: { store: 'event-horizon' } }]);
    const bak = mk(path.join(root, 'kb.bak-2026-09-04'), { 'a.rvf': 64, 'event-horizon.big.rvf': 128 });
    ledger(bak, { ...A, 'event-horizon': { file: 'event-horizon.big.rvf' } });
    const result = reclaimBackups({ kbDir: kb, env: {} });
    expect(result.kept[0][1]).toMatch(/does NOT have.*event-horizon/);
    expect(result.blockingRetained.map((entry) => entry.path)).toEqual([bak]);
  });
});

describe('(c) PRIVATE-fenced stores', () => {
  const fenced = () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 }); ledger(kb, A); fence(kb, ['cognitum-api']);
    const bak = mk(path.join(root, 'kb.bak-2026-09-04'), { 'a.rvf': 64, 'cognitum-api.big.rvf': 4096 });
    ledger(bak, { ...A, 'cognitum-api': { file: 'cognitum-api.big.rvf' } });
    return { kb, bak };
  };
  it('pin the backup: reported by name, never removed, and not a recovery blocker', () => {
    const { kb, bak } = fenced();
    const result = reclaimBackups({ kbDir: kb, env: {} });
    expect(result.removed).toEqual([]);
    expect(result.kept[0][1]).toMatch(/PRIVATE/);
    expect(result.kept[0][1]).toMatch(/cognitum-api/);
    expect(result.retained[0].safeToRetainDuringUpdate).toBe(true);
    expect(result.blockingRetained).toEqual([]);
    expect(fs.existsSync(path.join(bak, 'cognitum-api.big.rvf'))).toBe(true);
  });
  it('cannot be authorized away through intentionallyRemovedStores', () => {
    const { kb, bak } = fenced();
    const result = reclaimBackups({ kbDir: kb, env: {}, intentionallyRemovedStores: ['cognitum-api'] });
    expect(result.removed).toEqual([]);
    expect(result.kept[0][1]).toMatch(/PRIVATE/);
    expect(fs.existsSync(bak)).toBe(true);
  });
  it('an UNDECLARED unique store still blocks — the data-safety spec is unchanged', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 }); ledger(kb, A);
    const bak = mk(path.join(root, 'kb.bak-2026-09-04'), { 'a.rvf': 64, 'private.rvf': 4096 });
    const result = reclaimBackups({ kbDir: kb, env: {} });
    expect(result.removed).toEqual([]);
    expect(result.retained[0].safeToRetainDuringUpdate).toBe(false);
    expect(result.blockingRetained).toHaveLength(1);
  });
});

describe('(d) budget and dry run', () => {
  it('over the one-snapshot budget with only PRIVATE-pinned copies is reported, not blocking', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 }); ledger(kb, A); fence(kb, ['cognitum-api']);
    for (const name of ['kb.bak-2026-09-04', 'kb.install-preserved-pPgP8t']) {
      const copy = mk(path.join(root, name), { 'a.rvf': 64, 'cognitum-api.big.rvf': 4096 });
      ledger(copy, { ...A, 'cognitum-api': { file: 'cognitum-api.big.rvf' } });
    }
    const result = reclaimBackups({ kbDir: kb, env: {} });
    expect(result.removed).toEqual([]);
    expect(result.withinBudget).toBe(false);
    expect(result.updateMayProceed).toBe(false); // the existing field keeps its meaning
    expect(result.retained.map((entry) => entry.retention)).toEqual(['private-pinned', 'private-pinned']);
    expect(result.blockingRetained).toEqual([]);
    expect(result.overBudget).toMatchObject({ snapshots: 2, maxSnapshots: 1 });
  });
  it('over budget with an UNCLASSIFIED copy still blocks — the existing data-safety contract stands', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 }); ledger(kb, A);
    const copy = mk(path.join(root, 'kb.bak-2026-09-01'), { 'a.rvf': 64, 'note.txt': 8 }); ledger(copy, A);
    const result = reclaimBackups({ kbDir: kb, env: { RUVNET_MAX_ROLLBACK_SNAPSHOTS: '0' } });
    expect(result.retained[0]).toMatchObject({ retention: 'unclassified', safeToRetainDuringUpdate: true });
    expect(result.blockingRetained.map((entry) => entry.path)).toEqual([copy]);
  });
  it('an inside-tree tooling symlink does not make a copy blocking; an escaping link or a symlinked .rvf does', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 64 }); ledger(kb, A);
    const tooling = mk(path.join(root, 'kb.bak-2026-09-01'), { 'a.rvf': 64, 'note.txt': 8 }); ledger(tooling, A);
    fs.mkdirSync(path.join(tooling, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync('../semver/bin/semver.js', path.join(tooling, 'node_modules', '.bin', 'semver'));
    const escaping = mk(path.join(root, 'kb.bak-2026-09-02'), { 'a.rvf': 64, 'note.txt': 8 }); ledger(escaping, A);
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
    fs.symlinkSync('../outside.txt', path.join(escaping, 'private-link'));
    const evil = mk(path.join(root, 'kb.bak-2026-09-03'), { 'a.rvf': 64 }); ledger(evil, A);
    fs.symlinkSync('/usr/bin/true', path.join(evil, 'evil.rvf'));
    const result = reclaimBackups({ kbDir: kb, env: { RUVNET_MAX_ROLLBACK_SNAPSHOTS: '3', RUVNET_MAX_ROLLBACK_BYTES: '100000' } });
    expect(result.removed).toEqual([]);
    expect(result.retained.find((entry) => entry.path === tooling).safeToRetainDuringUpdate).toBe(true);
    expect(result.blockingRetained.map((entry) => entry.path).sort()).toEqual([escaping, evil].sort());
    expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('outside');
  });
  it('dryRun reports what it WOULD remove and deletes nothing', () => {
    const kb = mk(path.join(root, 'kb'), { 'a.rvf': 2048 }); ledger(kb, A);
    const bak = mk(path.join(root, 'kb.bak-2026-09-04'), { 'a.rvf': 2048 }); ledger(bak, A);
    const result = reclaimBackups({ kbDir: kb, env: {}, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.wouldRemove).toEqual([bak]);
    expect(result.removed).toEqual([]);
    expect(result.freed).toBeGreaterThan(2048);
    expect(fs.existsSync(bak)).toBe(true);
  });
});
