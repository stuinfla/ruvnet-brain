import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { attestProduction, verifyProductionEvidence, sourceEvidenceDigest } from '../../scripts/oracle/production-evidence.mjs';
import { qualifyOracleSource } from '../../scripts/oracle/qualify-source.mjs';

const pair = crypto.generateKeyPairSync('ed25519');
const call = (callId, stage, host, model, ok = true) => ({ callId, stage, host, requestedModel: model,
  observedModels: [model], status: ok ? 0 : 1, timedOut: false, ok, error: ok ? null : 'host error',
  requestDigest: 'a'.repeat(64), transportDigest: 'b'.repeat(64) });
const labels = () => ({ schemaVersion: 1, kind: 'oracle-labels', repo: 'repo', commit: 'commit',
  rulesVersion: 'rules', diagnosticLegacy: false, suspended: null, productionComplete: true,
  roles: { generator: 'claude', judge: 'codex' },
  authentication: { claude: { eligible: true }, codex: { eligible: true } },
  producer: { generator: { host: 'claude', requestedModel: 'claude-fable-5-1' }, judge: { host: 'codex', requestedModel: 'gpt-6-astra' } },
  calls: [call('g', 'generator', 'claude', 'claude-fable-5-1'), call('j', 'judge', 'codex', 'gpt-6-astra')],
  labels: [{ unitId: 'u', producerCallId: 'g', direct: 'd', paraphrase: 'p', span: 's',
    judge: { host: 'codex', model: 'gpt-6-astra', callId: 'j', direct: { answers: 'yes' }, paraphrase: { answers: 'yes' }, equivalent: { answers: 'yes' } } }],
});

function attested() { const value = labels(); value.attestation = attestProduction(value, pair.privateKey); return value; }

describe('trusted production evidence', () => {
  it('keeps source identity portable without ignoring evidence changes', () => {
    const proof = { alpha: { snapshotDir: '/old/machine/checkout', commit: 'a'.repeat(40), labels: { digest: 'b'.repeat(64) } } };
    const relocated = structuredClone(proof); relocated.alpha.snapshotDir = '/new/machine/checkout';
    expect(sourceEvidenceDigest(relocated)).toBe(sourceEvidenceDigest(proof));
    relocated.alpha.labels.digest = 'c'.repeat(64);
    expect(sourceEvidenceDigest(relocated)).not.toBe(sourceEvidenceDigest(proof));
  });

  it('accepts only labels linked to successful calls with observed requested models', () => {
    expect(verifyProductionEvidence(attested(), pair.publicKey).verified).toBe(true);
  });
  it('fails closed for a wrong observed model', () => {
    const value = labels(); value.calls[1].observedModels = ['gpt-5-old']; value.attestation = attestProduction(value, pair.privateKey);
    expect(verifyProductionEvidence(value, pair.publicKey).verified).toBe(false);
  });
  it('fails closed when observed native events mix requested and wrong models', () => {
    const value = labels(); value.calls[1].observedModels = ['gpt-6-astra', 'gpt-5-old']; value.attestation = attestProduction(value, pair.privateKey);
    expect(verifyProductionEvidence(value, pair.publicKey).verified).toBe(false);
  });
  it('fails closed when a host errored even if the receipt says complete', () => {
    const value = labels(); value.calls[0] = call('g', 'generator', 'claude', 'claude-fable-5-1', false); value.attestation = attestProduction(value, pair.privateKey);
    expect(verifyProductionEvidence(value, pair.publicKey).verified).toBe(false);
  });
  it('requires a generator call for a judge accounted miss and validates its reason', () => {
    const value = labels(); value.labels[0].accountedMiss = true; value.labels[0].missReason = 'judge_verdict_no';
    value.labels[0].judge.direct.answers = 'no'; delete value.calls[0]; value.calls = value.calls.filter(Boolean);
    value.attestation = attestProduction(value, pair.privateKey);
    expect(verifyProductionEvidence(value, pair.publicKey).verified).toBe(false);
    value.calls.push(call('g', 'generator', 'claude', 'claude-fable-5-1')); value.labels[0].producerCallId = 'g';
    value.labels[0].missReason = 'spoofed'; value.attestation = attestProduction(value, pair.privateKey);
    expect(verifyProductionEvidence(value, pair.publicKey).verified).toBe(false);
  });
});

describe('source qualification partition binding', () => {
  const key = pair.publicKey;
  const inventory = { schemaVersion: 2, repo: 'repo-a', commit: 'c', U: 1, selected: [{ unitId: 'u' }] };
  const proof = { inventory, snapshotDir: '/missing', labels: { labels: [], attestation: { labelsDigest: 'l', keyId: 'k' } } };
  it('rejects a partition store that is not the authenticated inventory repo', async () => {
    const partitions = new Map([['p', { partition: 'p', store: 'repo-b', sourceCommit: 'c', inventorySha256: 'x', U: 1, selectedUnits: 1, unproduced: [], rulesVersion: 'oracle-source-units/2' }]]);
    await expect(qualifyOracleSource({ schemaVersion: 2 }, { partitions, labels: [] }, { evidence: { p: proof }, trustedProductionKey: key, embed: async () => [] })).rejects.toThrow(/store/);
  });
  it('rejects multipartition evidence with a missing partition', async () => {
    const partitions = new Map([['a', { partition: 'a' }], ['b', { partition: 'b' }]]);
    await expect(qualifyOracleSource({ schemaVersion: 2 }, { partitions, labels: [] }, { evidence: { a: proof }, trustedProductionKey: key, embed: async () => [] })).rejects.toThrow(/partition set/);
  });
});
