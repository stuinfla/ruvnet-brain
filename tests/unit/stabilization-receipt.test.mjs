import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStabilizationReceipt, main } from '../../scripts/stabilization-receipt.mjs';
import { getVersion } from '../../scripts/version.mjs';

const VERSION = getVersion();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stabilization-receipt-'));
  for (const rel of ['plugin/.claude-plugin', 'plugin/.codex-plugin', 'package']) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }
  for (const rel of ['package.json', 'plugin/.claude-plugin/plugin.json', 'plugin/.codex-plugin/plugin.json']) {
    fs.writeFileSync(path.join(root, rel), `${JSON.stringify({ name: 'ruvnet-brain', version: VERSION })}\n`);
  }
  fs.writeFileSync(path.join(root, 'package/package.json'), `${JSON.stringify({ name: 'ruvnet-brain', version: VERSION })}\n`);
  const artifactPath = path.join(root, `ruvnet-brain-${VERSION}.tgz`);
  execFileSync('tar', ['-czf', artifactPath, '-C', root, 'package']);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'qe@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'QE'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'test(receipt): seed fixture'], { cwd: root });
  return {
    root,
    artifactPath,
    qe: { numTotalTests: 34, numPassedTests: 34, numFailedTests: 0, numPendingTests: 0 },
    audit: { metadata: { vulnerabilities: { critical: 0, high: 0 } } },
  };
}

describe('stabilization candidate receipt producer', () => {
  it('records only observed source, artifact, QE, and security facts', () => {
    const f = fixture();
    const receipt = createStabilizationReceipt(f);
    expect(receipt).toMatchObject({
      phase: 'stabilization-candidate', mode: 'stabilization', targetScore: 95,
      scoreClaimed: false, dirty: false, version: VERSION,
      qe: { status: 'PASS', total: 34, passed: 34, failed: 0, skipped: 0 },
      security: { status: 'PASS', critical: 0, high: 0 },
    });
    expect(receipt).not.toHaveProperty('github');
    expect(receipt).not.toHaveProperty('packedHosts');
    expect(receipt.artifact.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(f.artifactPath)).digest('hex'));
  });

  it('refuses red or vacuous evidence', () => {
    const f = fixture();
    expect(() => createStabilizationReceipt({ ...f, qe: { numTotalTests: 0 } })).toThrow(/QE_NOT_PASS/);
    expect(() => createStabilizationReceipt({
      ...f, audit: { metadata: { vulnerabilities: { critical: 0, high: 1 } } },
    })).toThrow(/SECURITY_NOT_PASS/);
    expect(() => createStabilizationReceipt({ ...f, audit: {} })).toThrow(/audit evidence is missing/);
  });

  it('requires explicit artifact and output flags', () => {
    expect(main([])).toBe(1);
  });
});

// OWNER-APPROVED AUDIT EXCEPTION (2026-11-17): GHSA-fc5q-39xc-vjpf only, 14 days, dev-only toolchain.
describe('the owner-approved audit exception', () => {
  const OWNER_ADVISORY = 'GHSA-fc5q-39xc-vjpf';
  const url = (id) => `https://github.com/advisories/${id}`;
  // npm audit's shape: picomatch carries the advisory; fdir/tinyglobby/vite/vitest are vulnerable via it.
  const auditWith = (extra = {}) => ({
    metadata: { vulnerabilities: { critical: 0, high: 5 + Object.keys(extra).length } },
    vulnerabilities: {
      picomatch: { severity: 'high', via: [{ source: 1, title: 'ReDoS', url: url(OWNER_ADVISORY), severity: 'high' }] },
      '@vitest/mocker': { severity: 'moderate', via: [{ source: 4, url: url('GHSA-qxg6-89mg-rqv8'), severity: 'moderate' }] },
      fdir: { severity: 'high', via: ['picomatch'] },
      tinyglobby: { severity: 'high', via: ['fdir', 'picomatch'] },
      vite: { severity: 'high', via: ['picomatch', 'tinyglobby'] },
      vitest: { severity: 'high', via: ['@vitest/mocker', 'picomatch', 'tinyglobby'] }, // as npm audit reports it today
      ...extra,
    },
  });
  const config = JSON.parse(fs.readFileSync(new URL('../../config/audit-exceptions.json', import.meta.url), 'utf8'));
  const during = Date.parse('2026-11-20T00:00:00Z');
  const cleanProd = { metadata: { vulnerabilities: { critical: 0, high: 0 } } };

  it('the committed exception names exactly that one advisory, the owner, the reason, and at most 14 days', () => {
    expect(config.exceptions).toHaveLength(1);
    const [e] = config.exceptions;
    expect(e.advisory).toBe(OWNER_ADVISORY);
    expect(e.reason).toMatch(/dev-only toolchain.*not in the shipped package.*no patched version.*PR #194/);
    expect(Date.parse(e.expires) - Date.parse(e.approvedAt)).toBeLessThanOrEqual(14 * 86_400_000);
    expect(e.approvedBy).toMatch(/owner/);
  });
  it('while active: the five findings it covers pass, and the receipt records the exception and the raw counts', () => {
    const f = fixture();
    const r = createStabilizationReceipt({ ...f, audit: auditWith(), auditProd: cleanProd, now: during });
    expect(r.security).toMatchObject({ status: 'PASS', critical: 0, high: 0, audited: { high: 5 }, shipped: { critical: 0, high: 0 } });
    expect(r.security.exceptions).toEqual([expect.objectContaining({ advisory: OWNER_ADVISORY,
      covered: ['picomatch', 'fdir', 'tinyglobby', 'vite', 'vitest'] })]);
  });
  it('any other high finding still blocks, including one that is only partly the excepted advisory', () => {
    const f = fixture();
    const other = { lodash: { severity: 'high', via: [{ source: 2, title: 'x', url: url('GHSA-aaaa-bbbb-cccc'), severity: 'high' }] } };
    expect(() => createStabilizationReceipt({ ...f, audit: auditWith(other), auditProd: cleanProd, now: during })).toThrow(/SECURITY_NOT_PASS/);
    const mixed = { vite: { severity: 'high', via: ['picomatch', { source: 3, url: url('GHSA-2222-3333-4444'), severity: 'high' }] } };
    expect(() => createStabilizationReceipt({ ...fixture(), audit: auditWith(mixed), auditProd: cleanProd, now: during })).toThrow(/SECURITY_NOT_PASS/);
    const critical = { audit: { ...auditWith(), metadata: { vulnerabilities: { critical: 1, high: 5 } } } };
    expect(() => createStabilizationReceipt({ ...fixture(), ...critical, auditProd: cleanProd, now: during })).toThrow(/SECURITY_NOT_PASS/);
  });
  it('after it expires the same findings block again', () => {
    const after = Date.parse(config.exceptions[0].expires) + 1;
    expect(() => createStabilizationReceipt({ ...fixture(), audit: auditWith(), now: after })).toThrow(/SECURITY_NOT_PASS/);
  });
  it('an exception for another advisory, a longer one, or a malformed one is refused or does nothing', () => {
    const base = config.exceptions[0];
    const otherAdvisory = { exceptions: [{ ...base, advisory: 'GHSA-2222-3333-4444' }] };
    expect(() => createStabilizationReceipt({ ...fixture(), audit: auditWith(), exceptions: otherAdvisory, now: during })).toThrow(/SECURITY_NOT_PASS/);
    const tooLong = { exceptions: [{ ...base, expires: '2026-12-31T00:00:00Z' }] };
    expect(() => createStabilizationReceipt({ ...fixture(), audit: auditWith(), exceptions: tooLong, now: during })).toThrow(/past 14 days/);
    const malformed = { exceptions: [{ advisory: OWNER_ADVISORY }] };
    expect(() => createStabilizationReceipt({ ...fixture(), audit: auditWith(), exceptions: malformed, now: during })).toThrow(/malformed/);
  });
});

describe('the exception cannot be stretched or reused', () => {
  const ADV = 'GHSA-fc5q-39xc-vjpf';
  const url = `https://github.com/advisories/${ADV}`;
  const during = Date.parse('2026-11-20T00:00:00Z');
  const cleanProd = { metadata: { vulnerabilities: { critical: 0, high: 0 } } };
  const base = { advisory: ADV, packages: ['picomatch'], approvedBy: 'owner', approvedAt: '2026-11-17T00:00:00Z', expires: '2026-12-01T00:00:00Z', reason: 'dev-only' };
  const audit = (vulns, high) => ({ metadata: { vulnerabilities: { critical: 0, high } }, vulnerabilities: vulns });
  const pico = { picomatch: { severity: 'high', via: [{ url, severity: 'high' }] } };
  it('the same advisory reaching a package the exception does not list still blocks', () => {
    const vulns = { ...pico, 'some-runtime-dep': { severity: 'high', via: ['picomatch'] } };
    expect(() => createStabilizationReceipt({ ...fixture(), audit: audit(vulns, 2), auditProd: cleanProd, exceptions: { exceptions: [base] }, now: during })).toThrow(/SECURITY_NOT_PASS/);
  });
  it('a high finding in the shipped (--omit=dev) audit blocks, and an applied exception requires that audit', () => {
    const args = { ...fixture(), audit: audit(pico, 1), exceptions: { exceptions: [base] }, now: during };
    expect(() => createStabilizationReceipt({ ...args, auditProd: { metadata: { vulnerabilities: { critical: 0, high: 1 } } } })).toThrow(/SECURITY_NOT_PASS/);
    expect(() => createStabilizationReceipt({ ...fixture(), audit: audit(pico, 1), exceptions: { exceptions: [base] }, now: during })).toThrow(/--audit-prod/);
  });
  it('a future-dated approval or an expiry before approval is refused', () => {
    const future = { ...base, approvedAt: '2027-01-01T00:00:00Z', expires: '2027-01-14T00:00:00Z' };
    expect(() => createStabilizationReceipt({ ...fixture(), audit: audit(pico, 1), auditProd: cleanProd, exceptions: { exceptions: [future] }, now: during })).toThrow(/impossible approval window/);
    const backwards = { ...base, expires: '2026-11-16T00:00:00Z' };
    expect(() => createStabilizationReceipt({ ...fixture(), audit: audit(pico, 1), auditProd: cleanProd, exceptions: { exceptions: [backwards] }, now: during })).toThrow(/impossible approval window/);
  });
  it('a high finding whose roots are all moderate is never subtracted', () => {
    const vulns = { odd: { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-2222-3333-4444', severity: 'moderate' }] } };
    expect(() => createStabilizationReceipt({ ...fixture(), audit: audit(vulns, 1), auditProd: cleanProd, exceptions: { exceptions: [base] }, now: during })).toThrow(/SECURITY_NOT_PASS/);
  });
});
