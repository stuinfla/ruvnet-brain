// tests/unit/fix-metaharness-memretrieve.test.mjs — this script patches a file inside a GLOBAL npm
// package, so `npm update -g` reverts it (already happened twice). The revert is SILENT: audit_list
// reports `totalInNamespace: 4, returned: 0` and exit 0. These tests pin the three behaviours that
// make the guard trustworthy — it detects a revert, it repairs idempotently, and it stays quiet
// (passes) on a machine where the plugin was never installed. Run against a real temp filesystem.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statusOf, apply, check, FILES } from '../../scripts/fix-metaharness-memretrieve.mjs';

// The upstream (buggy) shape: no `--format json`, and it parses the envelope AS the record.
const REVERTED = `import { spawnSync } from 'node:child_process';
function memRetrieve(key) {
  const r = spawnSync('npx', [
    CLI_PKG, 'memory', 'retrieve',
    '--namespace', NS, '--key', key,
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', shell: process.platform === 'win32' });
  if (r.status !== 0) return null;
  const m = /\\{[\\s\\S]*\\}/.exec(r.stdout || '');
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function main() {}
`;

const silent = () => {};
let tmp;
const seed = (contents) => { for (const f of FILES) fs.writeFileSync(path.join(tmp, f), contents, 'utf-8'); };

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-fix-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('statusOf — classify each target file', () => {
  it('reports `missing` when the plugin is not installed', () => {
    expect(statusOf('audit-list.mjs', tmp).state).toBe('missing');
  });
  it('reports `reverted` when memRetrieve() is present but unpatched', () => {
    seed(REVERTED);
    expect(statusOf('audit-list.mjs', tmp).state).toBe('reverted');
  });
  it('reports `unrecognized` when upstream changed memRetrieve() beyond our matcher', () => {
    fs.writeFileSync(path.join(tmp, 'audit-list.mjs'), 'export const nothingToSeeHere = 1;\n', 'utf-8');
    expect(statusOf('audit-list.mjs', tmp).state).toBe('unrecognized');
  });
});

describe('apply — repair the revert, idempotently', () => {
  it('patches a reverted file so it requests JSON and unwraps the envelope', () => {
    seed(REVERTED);
    apply(tmp, silent);
    const src = fs.readFileSync(path.join(tmp, 'audit-list.mjs'), 'utf-8');
    expect(src).toContain("'--format', 'json'");   // the retrieve must ask for JSON…
    expect(src).toContain('outer.content');        // …and the record must be unwrapped from it
    expect(statusOf('audit-list.mjs', tmp).state).toBe('fixed');
  });
  it('leaves the rest of the file intact (surgical replacement of one function)', () => {
    seed(REVERTED);
    apply(tmp, silent);
    const src = fs.readFileSync(path.join(tmp, 'audit-trend.mjs'), 'utf-8');
    expect(src).toContain("import { spawnSync } from 'node:child_process';");
    expect(src).toContain('function main() {}');
  });
  it('is idempotent — a second apply is a no-op, byte for byte', () => {
    seed(REVERTED);
    apply(tmp, silent);
    const once = FILES.map((f) => fs.readFileSync(path.join(tmp, f), 'utf-8'));
    apply(tmp, silent);
    const twice = FILES.map((f) => fs.readFileSync(path.join(tmp, f), 'utf-8'));
    expect(twice).toEqual(once);
  });
  it('refuses to touch a file whose memRetrieve() it no longer recognizes', () => {
    const foreign = 'export const nothingToSeeHere = 1;\n';
    fs.writeFileSync(path.join(tmp, 'audit-list.mjs'), foreign, 'utf-8');
    apply(tmp, silent);
    expect(fs.readFileSync(path.join(tmp, 'audit-list.mjs'), 'utf-8')).toBe(foreign);
  });
});

describe('check — the guard that must not cry wolf', () => {
  it('fails (exit 1) when an installed file has lost the fix', () => {
    seed(REVERTED);
    expect(check(tmp, silent)).toBe(1);
  });
  it('passes (exit 0) once the fix is applied', () => {
    seed(REVERTED);
    apply(tmp, silent);
    expect(check(tmp, silent)).toBe(0);
  });
  it('passes (exit 0) when the plugin is not installed — n/a is not a failure', () => {
    expect(check(tmp, silent)).toBe(0);
  });
  it('fails when only ONE of the two files is reverted (the bug that fooled us once)', () => {
    seed(REVERTED);
    apply(tmp, silent);
    fs.writeFileSync(path.join(tmp, 'audit-trend.mjs'), REVERTED, 'utf-8'); // trend regressed alone
    expect(check(tmp, silent)).toBe(1);
  });
});
