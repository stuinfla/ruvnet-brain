// tests/unit/console-user-settings-undo.test.mjs — RNBC QA 2026-10-01.
//
// The Settings card says "every save is reversible". The config.json form returned an undo token;
// the user-settings form (what it learns from, how much it jumps in, may it act, new projects) did
// not, so its saves had no Undo button. Each save is now journalled and reversible exactly once,
// and an undo that would wipe a newer save is refused.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-us-undo-')));
const file = path.join(tmp, '.config', 'ruvnet-brain', 'settings.json');
const saved = {};
let mod;
const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).settings;

beforeAll(async () => {
  for (const k of ['HOME', 'RUVNET_CONSOLE_ROOT', 'RUVNET_BRAIN_TEST', 'RUVNET_SETTINGS_FILE']) saved[k] = process.env[k];
  Object.assign(process.env, { HOME: tmp, RUVNET_CONSOLE_ROOT: tmp, RUVNET_BRAIN_TEST: '1', RUVNET_SETTINGS_FILE: file });
  mod = await import('../../scripts/onboarding-console.mjs');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('user-settings saves are reversible from the console', () => {
  it('first-ever save returns an undo that removes the file, once', () => {
    const r = mod.saveAdvocacy({ advocacy: 1, learningScope: 'user' });
    expect(r.ok, r.log).toBe(true);
    expect(typeof r.undoToken).toBe('string');
    expect(read()).toMatchObject({ advocacy: 1, learningScope: 'user' });
    const u = mod.undo(r.undoToken);
    expect(u.ok, u.log).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(mod.undo(r.undoToken).ok).toBe(false);
  });

  it('a later save makes an earlier undo refuse; the latest undo restores the prior values', () => {
    const a = mod.saveAdvocacy({ advocacy: 2 });
    const b = mod.saveAdvocacy({ advocacy: 5, autoApply: true });
    expect(read()).toMatchObject({ advocacy: 5, autoApply: true });
    const stale = mod.undo(a.undoToken);
    expect(stale.ok).toBe(false);
    expect(read()).toMatchObject({ advocacy: 5 });
    const ok = mod.undo(b.undoToken);
    expect(ok.ok, ok.log).toBe(true);
    expect(read()).toMatchObject({ advocacy: 2, autoApply: false });
  });

  // The journal's `at` stamp has millisecond resolution and two saves DO land in the same millisecond
  // (a fast Linux runner did, 2026-10-01): ordering by timestamp then saw no "later" save and let the
  // stale undo wipe the newer one. Freeze the clock so both saves share one stamp: order must come
  // from the append-only journal itself.
  it('same-millisecond saves: the earlier undo still refuses, the latest still restores', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    try {
      const a = mod.saveAdvocacy({ advocacy: 3, autoApply: false });
      const b = mod.saveAdvocacy({ advocacy: 4, autoApply: true });
      expect(mod.undo(a.undoToken).ok).toBe(false);
      expect(read()).toMatchObject({ advocacy: 4, autoApply: true });
      const ok = mod.undo(b.undoToken);
      expect(ok.ok, ok.log).toBe(true);
      expect(read()).toMatchObject({ advocacy: 3, autoApply: false });
    } finally { vi.useRealTimers(); }
  });

  it('same-millisecond config.json saves: the earlier undo refuses too', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:01.000Z'));
    try {
      const a = mod.saveConfig({ provider: 'codex' });
      const b = mod.saveConfig({ provider: 'openai' });
      expect(a.ok, a.log).toBe(true); expect(b.ok, b.log).toBe(true);
      expect(mod.undo(a.undoToken).ok).toBe(false);
      const ok = mod.undo(b.undoToken);
      expect(ok.ok, ok.log).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
