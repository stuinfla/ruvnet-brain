import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditEvidenceBoundCapabilityClaims,
  buildSourceClaimReceipt,
  readLiveSurfaceReceipts,
  recordManagedCliObservation,
  recordRegistryLatestObservation,
  signCapabilityClaimAggregate,
  verifyCapabilityClaimAggregate,
} from '../../plugin/scripts/capability-claim-evidence.mjs';

const roots = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-claim-evidence-'));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function groundingReceipt() {
  return {
    v: 1,
    id: 'grounding-1',
    ts: '2026-08-22T12:00:00.000Z',
    query: 'Can Ruflo orchestrate agents?',
    repos: 1,
    sources: [{
      repo: 'ruflo',
      path: 'src/swarm/coordinator.ts',
      sha: 'a'.repeat(64),
      packages: [],
      origins: [],
      symbols: [{ name: 'orchestrate', pkg: 'ruflo' }],
      posture: [],
      negatives: [],
      enforceable: true,
      claimBinding: { method: 'tight-source-token-pair', query: 'Can Ruflo orchestrate agents?' },
    }],
  };
}

describe('source-bound RuvNet behavior claims', () => {
  it('seals exact grounding evidence and accepts only the bound behavior claim', () => {
    const source = buildSourceClaimReceipt({
      claim: 'Ruflo can orchestrate agents.',
      groundingReceipt: groundingReceipt(),
      sourcePath: 'ruflo/src/swarm/coordinator.ts',
      observedAt: '2026-08-22T12:01:00.000Z',
    });
    expect(source).toMatchObject({ kind: 'ruvnet-brain-source-claim', verdict: 'PASS' });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo can orchestrate agents.', {
      sourceClaims: [source], liveSurfaces: [], now: '2026-08-22T12:02:00.000Z',
    })).toMatchObject({ verdict: 'PASS' });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo can encrypt databases.', {
      sourceClaims: [source], liveSurfaces: [], now: '2026-08-22T12:02:00.000Z',
    })).toMatchObject({ verdict: 'UNKNOWN' });
  });

  it('requires explicit negative source evidence for a negative behavior claim', () => {
    const receipt = groundingReceipt();
    receipt.query = 'Does Ruflo export destroyAll?';
    receipt.sources[0].negatives = [{ symbol: 'destroyAll', quote: 'does not export destroyAll' }];
    receipt.sources[0].claimBinding = null;
    const source = buildSourceClaimReceipt({
      claim: 'Ruflo does not export destroyAll.', groundingReceipt: receipt,
      sourcePath: 'ruflo/src/swarm/coordinator.ts',
    });
    expect(source.verdict).toBe('PASS');
    expect(() => buildSourceClaimReceipt({
      claim: 'Ruflo does not export eraseEverything.', groundingReceipt: receipt,
      sourcePath: 'ruflo/src/swarm/coordinator.ts',
    })).toThrow(/does not bind/i);
  });
});

describe('live version and health evidence', () => {
  it('records only content-bound safe facts from managed CLI output', () => {
    const root = makeRoot();
    const file = path.join(root, 'live.jsonl');
    const version = recordManagedCliObservation({
      toolName: 'ruvnet_cli_help', executable: 'ruflo', argv: ['--help'],
      execution: { code: 0, stdout: 'ruflo v3.38.16\nRuflo help', stderr: '', error: null },
      env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: file, RUVNET_HOOK_HOST: 'codex' },
      observedAt: '2026-08-22T12:00:00.000Z',
    });
    const health = recordManagedCliObservation({
      toolName: 'ruvnet_cli_run', executable: 'ruflo', argv: ['doctor'],
      execution: { code: 0, stdout: 'All checks passed. System healthy.', stderr: '', error: null },
      env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: file, RUVNET_HOOK_HOST: 'claude' },
      observedAt: '2026-08-22T12:00:10.000Z',
    });
    expect(version).toMatchObject({ observationClass: 'current-version', observedVersion: '3.38.16' });
    expect(health).toMatchObject({ observationClass: 'health', healthVerdict: 'PASS', reachable: true });
    expect(readLiveSurfaceReceipts({ file })).toHaveLength(2);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('All checks passed');
  });

  it('fails mismatched current-version and health claims, and leaves latest UNKNOWN without registry proof', () => {
    const evidenceFile = path.join(makeRoot(), 'live.jsonl');
    const version = recordManagedCliObservation({
      toolName: 'ruvnet_cli_help', executable: 'ruflo', argv: ['--help'],
      execution: { code: 0, stdout: 'ruflo v3.38.16', stderr: '', error: null },
      env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: evidenceFile, RUVNET_HOOK_HOST: 'codex' },
      observedAt: '2026-08-22T12:00:00.000Z',
    });
    const health = recordManagedCliObservation({
      toolName: 'ruvnet_cli_run', executable: 'ruflo', argv: ['doctor'],
      execution: { code: 0, stdout: 'All checks passed. System healthy.', stderr: '', error: null },
      env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: evidenceFile },
      observedAt: '2026-08-22T12:00:30.000Z',
    });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo current version is 3.38.16.', {
      sourceClaims: [], liveSurfaces: [version], now: '2026-08-22T12:01:00.000Z',
    })).toMatchObject({ verdict: 'PASS' });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo current version is 3.37.0.', {
      sourceClaims: [], liveSurfaces: [version], now: '2026-08-22T12:01:00.000Z',
    })).toMatchObject({ verdict: 'FAIL' });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo current version is 3.38.16.', {
      sourceClaims: [], liveSurfaces: [version], host: 'claude', now: '2026-08-22T12:01:00.000Z',
    })).toMatchObject({ verdict: 'UNKNOWN' });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo 3.38.16 is the latest version.', {
      sourceClaims: [], liveSurfaces: [version], now: '2026-08-22T12:01:00.000Z',
    })).toMatchObject({ verdict: 'UNKNOWN' });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo is healthy.', {
      sourceClaims: [], liveSurfaces: [health], host: 'claude', now: '2026-08-22T12:01:00.000Z',
    })).toMatchObject({ verdict: 'PASS' });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo is unhealthy.', {
      sourceClaims: [], liveSurfaces: [health], host: 'codex', now: '2026-08-22T12:01:00.000Z',
    })).toMatchObject({ verdict: 'FAIL' });
  });

  it('binds latest-version claims only to an exact fresh registry receipt', () => {
    const evidenceFile = path.join(makeRoot(), 'live.jsonl');
    const latest = recordRegistryLatestObservation({
      executable: 'ruflo', packageName: 'ruflo', version: '3.38.16',
      registryUrl: 'https://registry.npmjs.org/ruflo/latest',
      responseBody: '{"name":"ruflo","version":"3.38.16"}',
      env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: evidenceFile, RUVNET_HOOK_HOST: 'codex' },
      observedAt: '2026-08-22T12:00:00.000Z',
    });
    expect(latest).toMatchObject({
      host: 'shared', executable: 'ruflo', observationClass: 'latest-version',
      observedVersion: '3.38.16', registryPackage: 'ruflo',
    });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo 3.38.16 is the latest version.', {
      sourceClaims: [], liveSurfaces: [latest], host: 'claude', now: '2026-08-22T12:01:00.000Z',
    })).toMatchObject({ verdict: 'PASS' });
    expect(auditEvidenceBoundCapabilityClaims('Ruflo 3.37.0 is the latest version.', {
      sourceClaims: [], liveSurfaces: [latest], host: 'codex', now: '2026-08-22T12:01:00.000Z',
    })).toMatchObject({ verdict: 'FAIL' });
    expect(() => recordRegistryLatestObservation({
      executable: 'ruflo', packageName: 'ruflo', version: 'not-semver',
      registryUrl: 'https://registry.npmjs.org/ruflo/latest', responseBody: '{}',
      env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: evidenceFile },
    })).toThrow(/semantic version/i);
  });
});

describe('signed S-12 candidate aggregate', () => {
  it('signs and verifies exact local host evidence while preserving non-local lanes as untested', () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const aggregate = signCapabilityClaimAggregate({
      identity: { sourceSha: 'b'.repeat(40), artifactSha256: 'c'.repeat(64) },
      os: 'macos',
      lanes: ['claude', 'codex'].map((host) => ({
        host, os: 'macos', verdict: 'PARTIAL',
        claims: {
          installation: 'PASS', behavior: 'PASS', currentVersion: 'PASS',
          latestVersion: 'UNKNOWN', health: 'PASS',
        },
        receiptSha256: host === 'claude' ? 'd'.repeat(64) : 'e'.repeat(64),
      })),
      sourceClaimDigests: ['f'.repeat(64)],
      liveSurfaceDigests: ['1'.repeat(64)],
      untested: ['latest-registry', 'linux', 'windows', 'public-byte'],
    }, keys.privateKey);
    expect(aggregate).toMatchObject({ verdict: 'PARTIAL', hosts: ['claude', 'codex'], os: ['macos'] });
    expect(verifyCapabilityClaimAggregate(aggregate, keys.publicKey)).toBe(aggregate);
    aggregate.lanes[0].verdict = 'FAIL';
    expect(() => verifyCapabilityClaimAggregate(aggregate, keys.publicKey)).toThrow(/digest|incomplete/i);
  });
});
