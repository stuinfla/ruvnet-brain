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
