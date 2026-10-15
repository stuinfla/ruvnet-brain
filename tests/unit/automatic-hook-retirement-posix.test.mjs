import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retireManagedHookRegistrations } from '../../bin/install.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('preserves a personal file-symlink without replacing the alias or target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-alias-proof-'));
  roots.push(home);
  const codexDir = path.join(home, '.codex');
  const wrapper = path.join(home, '.cache/ruvnet-brain/codex-hook.mjs');
  const settings = path.join(home, '.claude/settings.json');
  const personal = path.join(home, 'personal-settings.json');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'plugin/scripts/codex-hook-wrapper.mjs'), wrapper);
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', timeout: 10,
    command: `node "${wrapper}" continuation-gate` }] }] } });
  fs.writeFileSync(personal, original);
  fs.symlinkSync(personal, settings);
  const result = retireManagedHookRegistrations({ home, codexDir });
  expect(result.removed).toBe(0);
  expect(result.conflicts.length).toBe(1);
  expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(personal, 'utf8')).toBe(original);
});
