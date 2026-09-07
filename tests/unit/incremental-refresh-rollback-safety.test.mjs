import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { promoteArtifactSet } from '../../kb/incremental-refresh.mjs';

let root;
afterEach(() => {
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-recovery-'));
  const liveDir = path.join(root, 'live');
  const candidateDir = path.join(root, 'candidate');
  fs.mkdirSync(liveDir);
  fs.mkdirSync(candidateDir);
  for (const file of ['a.rvf', 'b.rvf']) {
    fs.writeFileSync(path.join(liveDir, file), `original:${file}`);
    fs.writeFileSync(path.join(candidateDir, file), `candidate:${file}`);
  }
  return { liveDir, candidateDir, files: ['a.rvf', 'b.rvf'] };
}

it('retains the only originals and reader lock when activation and rollback both fail', () => {
  const f = fixture();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from === path.join(f.candidateDir, 'b.rvf')) throw new Error('activation denied');
    if (String(from).includes('.promotion-backup-') && path.basename(from) === 'b.rvf') throw new Error('rollback denied');
    return rename(from, to);
  });
  let failure;
  try { promoteArtifactSet(f); } catch (error) { failure = error; }
  expect(failure?.code).toBe('ERECOVERYREQUIRED');
  expect(failure.message).toMatch(/activation denied.*rollback denied.*retained/);
  expect(fs.existsSync(path.join(f.liveDir, '.promotion.lock'))).toBe(true);
  for (const file of f.files) expect(fs.readFileSync(path.join(failure.backupDir, file), 'utf8')).toBe(`original:${file}`);
  expect(() => promoteArtifactSet(f)).toThrow();
  for (const file of f.files) expect(fs.readFileSync(path.join(failure.backupDir, file), 'utf8')).toBe(`original:${file}`);
});

it('preserves originals if removal of a partially promoted candidate fails', () => {
  const f = fixture();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from === path.join(f.candidateDir, 'b.rvf')) throw new Error('activation denied');
    return rename(from, to);
  });
  const remove = fs.rmSync;
  vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
    if (file === path.join(f.liveDir, 'a.rvf')) throw new Error('candidate removal denied');
    return remove(file, options);
  });
  let failure;
  try { promoteArtifactSet(f); } catch (error) { failure = error; }
  expect(failure?.code).toBe('ERECOVERYREQUIRED');
  for (const file of f.files) expect(fs.readFileSync(path.join(failure.backupDir, file), 'utf8')).toBe(`original:${file}`);
});

it('retains the remaining backup when rollback restored one original before failing', () => {
  const f = fixture();
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from === path.join(f.candidateDir, 'b.rvf')) throw new Error('activation denied');
    if (String(from).includes('.promotion-backup-') && path.basename(from) === 'a.rvf') throw new Error('later rollback denied');
    return rename(from, to);
  });
  let failure;
  try { promoteArtifactSet(f); } catch (error) { failure = error; }
  expect(failure?.code).toBe('ERECOVERYREQUIRED');
  expect(fs.readFileSync(path.join(f.liveDir, 'b.rvf'), 'utf8')).toBe('original:b.rvf');
  expect(fs.readFileSync(path.join(failure.backupDir, 'a.rvf'), 'utf8')).toBe('original:a.rvf');
  expect(fs.existsSync(failure.lockDir)).toBe(true);
});
