import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, missingIngests, OK, NEVER_MATERIALIZED, WIPED } from '../../scripts/restore-local-ingests.mjs';

/**
 * TEETH: a store root that was never materialized on this host must never read as a wipe.
 *
 * Measured 2026-08-19 (Dream Cycle, memory-durability): this script had zero test coverage and
 * could not distinguish "fresh checkout / CI runner / this agent's own ephemeral container never
 * ingested anything" from "this host ingested, then an overnight bundle apply wiped it" — both
 * produced the identical alarm. Every test below pins one of the three states so that conflation
 * cannot silently return.
 */

let dir, ledgerFile;
const record = (...entries) => {
  ledgerFile = path.join(dir, 'local-ingests.json');
  fs.writeFileSync(ledgerFile, JSON.stringify({ ingests: entries }));
};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-ingests-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('classify() names three states, never collapses them into one alarm', () => {
  it('OK: every recorded ingest is present', () => {
    record({ name: 'helix', store: 'helix', at: '2026-08-19T00:00:00Z' });
    const root = path.join(dir, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'helix.rvf'), 'x');
    expect(classify({ ledgerFile, root })).toEqual({ state: OK, missing: [] });
  });

  it('NEVER-MATERIALIZED: the root does not exist on this host at all', () => {
    record({ name: 'helix', store: 'helix', at: '2026-08-19T00:00:00Z' });
    const root = path.join(dir, 'never-created');
    const result = classify({ ledgerFile, root });
    expect(result.state).toBe(NEVER_MATERIALIZED);
    expect(result.missing).toHaveLength(1);
  });

  it('WIPED: the root exists — this host DID ingest before — but a recorded entry is gone', () => {
    record(
      { name: 'helix', store: 'helix', at: '2026-08-19T00:00:00Z' },
      { name: 'rvQR', store: 'rvqr', at: '2026-08-19T00:00:00Z' },
    );
    const root = path.join(dir, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'helix.rvf'), 'x'); // rvqr is gone, root is otherwise live
    const result = classify({ ledgerFile, root });
    expect(result.state).toBe(WIPED);
    expect(result.missing.map((e) => e.name)).toEqual(['rvQR']);
  });

  it('an empty ledger is OK regardless of whether the root exists', () => {
    record();
    expect(classify({ ledgerFile, root: path.join(dir, 'nope') })).toEqual({ state: OK, missing: [] });
  });

  it('a missing ledger file is OK, not a crash', () => {
    expect(classify({ ledgerFile: path.join(dir, 'no-ledger.json'), root: dir })).toEqual({ state: OK, missing: [] });
  });
});

describe('missingIngests() stays the raw diff classify() builds on', () => {
  it('matches by explicit `store` name, not just the display `name`', () => {
    record({ name: 'RuCelium', store: 'rucelium', at: '2026-08-19T00:00:00Z' });
    const root = path.join(dir, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'rucelium.rvf'), 'x');
    expect(missingIngests({ ledgerFile, root })).toEqual([]);
  });

  it('falls back to a lower-cased `name` when `store` is absent', () => {
    record({ name: 'wifi-veil', at: '2026-08-19T00:00:00Z' });
    const root = path.join(dir, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'wifi-veil.rvf'), 'x');
    expect(missingIngests({ ledgerFile, root })).toEqual([]);
  });
});
