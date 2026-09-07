import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  HOST_ADAPTER_FILES,
  buildHostRegistry,
  validateHostRegistry,
} from '../../scripts/host-registry.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('sealed host registry', () => {
  it('derives the complete OS, host, and mode authority from tracked descriptors', () => {
    const registry = buildHostRegistry({ root: ROOT });
    expect(HOST_ADAPTER_FILES).toEqual([
      'plugin/host-adapters/claude.json',
      'plugin/host-adapters/codex.json',
    ]);
    expect(registry.os).toEqual(['linux', 'macos', 'windows']);
    expect(registry.modes).toEqual(['claude', 'codex', 'dual']);
    expect(registry.adapters.map(({ id }) => id)).toEqual(['claude', 'codex']);
    expect(registry.adapters.find(({ id }) => id === 'claude').modes).toEqual(['claude', 'dual']);
    expect(registry.adapters.find(({ id }) => id === 'codex').modes).toEqual(['codex', 'dual']);
    expect(validateHostRegistry(registry, { root: ROOT })).toBe(registry);
  });

  it.each([
    ['digest mutation', (value) => { value.registrySha256 = '0'.repeat(64); }, /digest/],
    ['missing OS', (value) => { value.os.pop(); }, /operating systems/],
    ['missing adapter', (value) => { value.adapters.pop(); }, /adapter set/],
    ['wrong mode ownership', (value) => { value.adapters[0].modes = ['dual']; }, /mode ownership/],
    ['untracked loader', (value) => { value.adapters[0].loader = 'scripts/not-real.mjs'; }, /tracked file/],
  ])('rejects %s', (_label, mutate, expected) => {
    const registry = structuredClone(buildHostRegistry({ root: ROOT }));
    mutate(registry);
    expect(() => validateHostRegistry(registry, { root: ROOT })).toThrow(expected);
  });

  it('writes one immutable registry receipt and refuses overwrite', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-registry-'));
    const out = path.join(temp, 'host-registry.json');
    const args = ['scripts/host-registry.mjs', '--out', out];
    const first = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    expect(validateHostRegistry(JSON.parse(fs.readFileSync(out, 'utf8')), { root: ROOT })).toBeTruthy();
    const second = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/refusing to overwrite/);
  });
});
