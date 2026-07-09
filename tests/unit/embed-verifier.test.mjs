// tests/unit/embed-verifier.test.mjs — bin/install.mjs carries a base64 copy of
// kb/verify-citation.mjs, because the installer must ship as ONE dependency-free file and every
// bundle published before 2026-07-09 lacks the verifier. Two copies of anything will drift; this
// test is the thing that stops it. If it fails, run: node scripts/embed-verifier.mjs
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEmbedded, encode, decode } from '../../scripts/embed-verifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installSrc = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
const kbSrc = fs.readFileSync(path.join(ROOT, 'kb', 'verify-citation.mjs'), 'utf8');

describe('embedded verify-citation.mjs', () => {
  it('the generated block exists in install.mjs', () => {
    expect(extractEmbedded(installSrc)).not.toBeNull();
  });

  it('decodes byte-for-byte to kb/verify-citation.mjs — no drift', () => {
    expect(decode(extractEmbedded(installSrc))).toBe(kbSrc);
  });

  it('round-trips: encode(decode(x)) === x', () => {
    const b64 = extractEmbedded(installSrc);
    expect(encode(decode(b64))).toBe(b64);
  });

  it('the decoded module really is the verifier (exports the gate, not some other file)', () => {
    const src = decode(extractEmbedded(installSrc));
    expect(src).toMatch(/export async function verifyGrounding/);
    expect(src).toMatch(/export function parseCitations/);
  });

  it('install.mjs writes it into the KB only when absent — a newer bundle copy must win', () => {
    expect(installSrc).toMatch(/function ensureVerifier\(cacheDir\)/);
    expect(installSrc).toMatch(/if \(fs\.existsSync\(p\)\) return 'from-bundle';/);
  });
});
