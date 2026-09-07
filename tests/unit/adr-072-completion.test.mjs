import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateCompletion } from '../../scripts/adr-072-completion.mjs';
import { signCapabilityClaimAggregate } from '../../plugin/scripts/capability-claim-evidence.mjs';

const roots = [];
const SHA = 'a'.repeat(40);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-072-completion-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const receiptFile = path.join(root, 'receipt.json');
  const keys = crypto.generateKeyPairSync('ed25519');
  const capabilityClaims = signCapabilityClaimAggregate({
    identity: { sourceSha: SHA, artifactSha256: 'b'.repeat(64) },
    lanes: ['linux', 'macos', 'windows'].flatMap((laneOs) => ['claude', 'codex'].map((host, index) => ({
      host, os: laneOs, verdict: 'PASS',
      claims: {
        installation: 'PASS', behavior: 'PASS', currentVersion: 'PASS', latestVersion: 'PASS', health: 'PASS',
      },
      receiptSha256: `${laneOs.length}${index}`.padEnd(64, 'a'),
    }))),
    sourceClaimDigests: ['c'.repeat(64)], liveSurfaceDigests: ['d'.repeat(64)], untested: [],
  }, keys.privateKey);
  fs.writeFileSync(receiptFile, JSON.stringify({ schemaVersion: 1, kind: 'ruvnet-brain-product-integrity',
    verdict: 'PASS', sourceSha: SHA, version: '9.9.9', mechanicalScore: 98,
    release: { state: 'install-verified', publicAggregateVerified: true },
    coverage: { eligibleCurrent: 207, eligibleTotal: 207, gistCurrent: 479, gistTotal: 479 },
    retrieval: { deltaCitationRate: 1, recallAt10: 0.98, skipped: 0, unknown: 0 },
    hosts: { passed: 9, required: 9 }, lifecycle: { nativeRuns: 2, secondVerdict: 'noop',
      redundantCopyCount: 0, withinRetentionBudget: true },
    continuity: { verdict: 'PASS', crashResumeVerified: true, concurrentWritersVerified: true,
      hosts: ['claude', 'codex'] },
    capabilityClaims,
    reviews: ['claude-fable-5', 'gpt-5.6-sol'].map((id) => ({ id, score: 95, sourceSha: SHA, untested: [] })) }));
  const run = (_cwd, bin, args) => {
    const key = `${bin} ${args.join(' ')}`;
    if (key === 'git status --porcelain=v1 --untracked-files=all') return '';
    if (key === 'git branch --show-current') return 'main';
    if (key === 'git rev-parse HEAD' || key === 'git rev-parse origin/main') return SHA;
    if (bin === 'npm') return JSON.stringify('9.9.9');
    if (bin === 'gh') return JSON.stringify({ tagName: 'v9.9.9', targetCommitish: SHA, isDraft: false, isPrerelease: false });
    throw new Error(`unexpected ${key}`);
  };
  return { root, receiptFile, run, capabilityClaimPublicKey: keys.publicKey };
}
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('ADR-072 completion boundary', () => {
  it('accepts only clean pushed source bound to the exact public install proof', () => {
    const f = fixture();
    expect(evaluateCompletion(f)).toMatchObject({ ok: true, head: SHA, version: '9.9.9' });
  });

  it.each([
    ['dirty checkout', (f) => { const base = f.run; f.run = (cwd, bin, args) =>
      `${bin} ${args.join(' ')}`.startsWith('git status ') ? ' M file' : base(cwd, bin, args); }],
    ['incomplete corpus', (f) => { const r = JSON.parse(fs.readFileSync(f.receiptFile)); r.coverage.eligibleCurrent -= 1;
      fs.writeFileSync(f.receiptFile, JSON.stringify(r)); }],
    ['weak recall', (f) => { const r = JSON.parse(fs.readFileSync(f.receiptFile)); r.retrieval.recallAt10 = 0.979;
      fs.writeFileSync(f.receiptFile, JSON.stringify(r)); }],
    ['missing host', (f) => { const r = JSON.parse(fs.readFileSync(f.receiptFile)); r.hosts.passed = 8;
      fs.writeFileSync(f.receiptFile, JSON.stringify(r)); }],
    ['unproven continuity', (f) => { const r = JSON.parse(fs.readFileSync(f.receiptFile));
      r.continuity.crashResumeVerified = false; fs.writeFileSync(f.receiptFile, JSON.stringify(r)); }],
    ['unproven capability claims', (f) => { const r = JSON.parse(fs.readFileSync(f.receiptFile));
      r.capabilityClaims.lanes[0].claims.behavior = 'UNKNOWN'; fs.writeFileSync(f.receiptFile, JSON.stringify(r)); }],
    ['untested review scope', (f) => { const r = JSON.parse(fs.readFileSync(f.receiptFile)); r.reviews[0].untested = ['windows'];
      fs.writeFileSync(f.receiptFile, JSON.stringify(r)); }],
  ])('fails closed on %s', (_name, mutate) => {
    const f = fixture(); mutate(f);
    expect(evaluateCompletion(f).ok).toBe(false);
  });
});
