import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reclaimBackups } from '../../kb/forge-update.mjs';

let root, live, backup;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-data-safety-'));
  live = path.join(root, 'kb');
  backup = path.join(root, 'kb.bak-prior');
  for (const dir of [live, backup]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.rvf'), 'same vectors');
    fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { a: { file: 'a.rvf' } } }));
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const reclaim = (extra = {}) => reclaimBackups({ kbDir: live, env: {}, ...extra });

it('preserves unlisted private bytes even with a valid generation ledger', () => {
  fs.writeFileSync(path.join(backup, 'private.txt'), 'only original');
  const result = reclaim();
  expect(result.removed).toEqual([]);
  expect(result.freed).toBe(0);
  expect(result.retained).toHaveLength(1);
  expect(result.kept[0][1]).toMatch(/PRESERVED_UNCLASSIFIED/);
  expect(fs.readFileSync(path.join(backup, 'private.txt'), 'utf8')).toBe('only original');
});
it('same RVF path and size do not prove equal bytes', () => {
  fs.writeFileSync(path.join(backup, 'a.rvf'), 'DIFF vectors');
  expect(reclaim().removed).toEqual([]);
  expect(fs.readFileSync(path.join(backup, 'a.rvf'), 'utf8')).toBe('DIFF vectors');
});
it('does not accept an explicitly supplied unrelated directory as cleanup authority', () => {
  const unrelated = path.join(root, 'private-project');
  fs.renameSync(backup, unrelated);
  expect(reclaim({ backupsMade: [unrelated] }).removed).toEqual([]);
  expect(fs.existsSync(unrelated)).toBe(true);
});
it('preserves unknown symlinks without following their target', () => {
  fs.writeFileSync(path.join(root, 'private-target'), 'outside bytes');
  fs.symlinkSync('../private-target', path.join(backup, 'private-link'));
  expect(reclaim().removed).toEqual([]);
  expect(fs.readFileSync(path.join(root, 'private-target'), 'utf8')).toBe('outside bytes');
});
it('reclaims a genuinely byte-identical regular tree', () => {
  expect(reclaim().removed).toEqual([backup]);
  expect(fs.existsSync(backup)).toBe(false);
  expect(fs.readFileSync(path.join(live, 'a.rvf'), 'utf8')).toBe('same vectors');
});
it('preserves a symlinked backup root and does not inventory its target', () => {
  const privateDir = path.join(root, 'private-dir');
  fs.renameSync(backup, privateDir);
  fs.symlinkSync('private-dir', backup);
  const result = reclaim();
  expect(result.removed).toEqual([]);
  expect(fs.lstatSync(backup).isSymbolicLink()).toBe(true);
  expect(result.retained[0].inventorySha256).toBeNull();
  expect(result.retained[0].bytes).toBe(fs.lstatSync(backup).size);
  expect(fs.readFileSync(path.join(privateDir, 'a.rvf'), 'utf8')).toBe('same vectors');
});
it('a symlinked live root cannot justify reclaim', () => {
  const privateDir = path.join(root, 'private-live');
  fs.renameSync(live, privateDir);
  fs.symlinkSync('private-live', live);
  expect(reclaim().removed).toEqual([]);
  expect(fs.existsSync(backup)).toBe(true);
});
it('preserves same-path private content when live differs', () => {
  fs.writeFileSync(path.join(backup, 'private.txt'), 'private old');
  fs.writeFileSync(path.join(live, 'private.txt'), 'private new');
  expect(reclaim().removed).toEqual([]);
  expect(fs.readFileSync(path.join(backup, 'private.txt'), 'utf8')).toBe('private old');
});
it('only permits a fully measured preserved tree inside the configured retention budget', () => {
  fs.writeFileSync(path.join(backup, 'private.txt'), 'unique bytes');
  expect(reclaim({ env: { RUVNET_MAX_ROLLBACK_BYTES: '100000' } }).updateMayProceed).toBe(true);
  expect(reclaim({ env: { RUVNET_MAX_ROLLBACK_BYTES: '1' } }).updateMayProceed).toBe(false);
});
it('a missing store remains recovery-blocking even with ample budget', () => {
  fs.writeFileSync(path.join(backup, 'private.rvf'), 'only vectors');
  expect(reclaim({ env: { RUVNET_MAX_ROLLBACK_BYTES: '100000' } }).updateMayProceed).toBe(false);
});
