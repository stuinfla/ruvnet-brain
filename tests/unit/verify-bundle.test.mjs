// tests/unit/verify-bundle.test.mjs — the bundle-signature verifier is security-critical (it gates
// what gets extracted into the user's config), so it earns real tests. Drafted by agentic-qe
// (`aqe test generate scripts/verify-bundle.mjs`, 35 assertions); made runnable + fail-closed-focused.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../../scripts/verify-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir, zip;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-'));
  zip = path.join(dir, 'b.zip');
  fs.writeFileSync(zip, 'REAL-BUNDLE-BYTES');
  execFileSync('node', ['scripts/sign-bundle.mjs', '--bundle', zip], { cwd: ROOT });
});

describe('verifyBundle — fail-closed signature gate', () => {
  it('accepts a correctly-signed bundle', () => {
    const r = verifyBundle(zip, `${zip}.sig`);
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/valid/i);
  });
  it('REJECTS a tampered bundle (signature no longer matches)', () => {
    const t = path.join(dir, 't.zip');
    fs.writeFileSync(t, 'TAMPERED-BYTES');
    fs.copyFileSync(`${zip}.sig`, `${t}.sig`);
    const r = verifyBundle(t, `${t}.sig`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does NOT match|tamper/i);
  });
  it('FAILS CLOSED when the signature is missing (never trusts an unsigned bundle)', () => {
    const r = verifyBundle(zip, path.join(dir, 'nope.sig'));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing|fail-closed/i);
  });
  it('FAILS CLOSED when the bundle itself is absent', () => {
    const r = verifyBundle(path.join(dir, 'ghost.zip'));
    expect(r.ok).toBe(false);
  });
});
