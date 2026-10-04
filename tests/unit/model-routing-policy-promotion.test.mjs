import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { sha256, candidateSha256, validateRoutingProposal, promoteRoutingPolicy, rollbackRoutingPolicy } from '../../scripts/model-routing-policy-promotion.mjs';
import { buildWeeklyAssessment } from '../../scripts/model-weekly-assessment.mjs';

const dirs = []; afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const now = Date.parse('2026-10-04T15:00:00Z'); const sourceSha = 'a'.repeat(64);
const prior = { schemaVersion: 1, reviewedAt: '2026-10-01T00:00:00Z', maxAgeMs: 604800000,
  routes: { codex: { medium: { model: 'gpt-fixture-old', effort: 'medium' } } }, objectivePriority: ['correctness', 'subscription-allowance', 'completion-time'] };
function fixture({ revalidate = false } = {}) {
  // SYNTHETIC reviewed evidence proves the boundary mechanism, not any real model qualification.
  const candidatePolicy = structuredClone(prior); candidatePolicy.reviewedAt = new Date(now).toISOString();
  if (!revalidate) candidatePolicy.routes.codex.medium = { model: 'gpt-fixture-new', effort: 'high' };
  const route = candidatePolicy.routes.codex.medium;
  const evidence = ['availability', 'settings', 'handoff', 'role-quality'].map((kind) => {
    const r = { kind, sourceSha, candidateSha: candidateSha256(candidatePolicy), host: 'codex', role: 'medium',
      model: route.model, effort: route.effort, nativeObservedIdentity: route.model, nativeObservedEffort: route.effort,
      harness: 'codex', harnessVersion: 'fixture-1', sourceIds: ['b'.repeat(64)], checkedAt: new Date(now).toISOString(),
      available: true, nativeSubscription: true, provider: 'openai', supported: true, completed: true,
      identityReturned: true, effortObserved: true, reviewedBy: 'independent-reviewer', reviewedOutcome: 'accepted',
      benchmark: { suite: 'fixture-role-suite', version: '1' }, metrics: { correctness: 3 } };
    r.receiptSha256 = candidateSha256(r); return r;
  });
  const contract = { authority: 'independent-reviewed', sourceSha, maxEvidenceAgeMs: 604800000,
    trustedSourceIds: ['b'.repeat(64)], allowedRoutes: { 'codex/medium': [{ ...route, provider: 'openai', nativeSubscription: true }] },
    qualityFloors: { 'codex/medium': { correctness: { direction: 'minimum', value: 3, suite: 'fixture-role-suite', version: '1' } } },
    trustedReceipts: Object.fromEntries(evidence.map((r) => [r.receiptSha256, r.receiptSha256])) };
  contract.contractSha256 = candidateSha256(contract);
  return { currentPolicy: prior, candidatePolicy, evidence, contract, sourceSha, now };
}
function refreshContract(f) { delete f.contract.contractSha256; f.contract.contractSha256 = candidateSha256(f.contract); }
function trustedEdit(f, kind, edit) {
  const row = f.evidence.find((r) => r.kind === kind); edit(row); delete row.receiptSha256;
  row.receiptSha256 = candidateSha256(row); f.contract.trustedReceipts[row.receiptSha256] = row.receiptSha256; refreshContract(f);
}
function disk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-policy-promotion-')); dirs.push(dir);
  const policyPath = path.join(dir, 'routing-policy.json'); const bytes = Buffer.from(JSON.stringify(prior)); fs.writeFileSync(policyPath, bytes);
  const profilePath = path.join(dir, 'profile.json'); fs.writeFileSync(profilePath, '{"explicit":"keep"}');
  return { dir, policyPath, profilePath, bytes, expectedPriorSha: sha256(bytes) };
}

describe('reviewed routing policy promotion boundary', () => {
  it('qualifies only externally bound synthetic receipts', () => { expect(validateRoutingProposal(fixture()).status).toBe('qualified'); });
  it('blocks actual deterministic unqualified weekly proposal and preserves bytes/review date', () => {
    const d = disk(); const weekly = buildWeeklyAssessment({ policy: prior, priorPolicyBytes: d.bytes, now });
    expect(weekly.proposal.status).toBe('unqualified');
    const candidatePolicy = { ...prior, reviewedAt: new Date(now).toISOString(), routes: weekly.proposal.candidateRoutes };
    expect(promoteRoutingPolicy({ ...d, candidatePolicy, sourceSha, now }).ok).toBe(false);
    expect(fs.readFileSync(d.policyPath).equals(d.bytes)).toBe(true);
    expect(JSON.parse(fs.readFileSync(d.policyPath)).reviewedAt).toBe(prior.reviewedAt);
  });
  it.each(['availability', 'settings', 'handoff', 'role-quality'])('requires %s proof', (kind) => {
    const f = fixture(); f.evidence = f.evidence.filter((r) => r.kind !== kind); expect(validateRoutingProposal(f).ok).toBe(false);
  });
  it.each(['sourceSha', 'candidateSha', 'nativeObservedIdentity', 'nativeObservedEffort', 'harness'])('rejects unmatched %s even in trusted receipt', (key) => {
    const f = fixture(); trustedEdit(f, 'handoff', (r) => { r[key] = 'unmatched'; }); expect(validateRoutingProposal(f).ok).toBe(false);
  });
  it('rejects unknown or forged source provenance even in an otherwise trusted receipt', () => {
    const f = fixture(); trustedEdit(f, 'role-quality', (r) => { r.sourceIds = ['c'.repeat(64)]; }); expect(validateRoutingProposal(f).ok).toBe(false);
  });
  it('rejects forged evidence bytes and candidate self scores', () => {
    const f = fixture(); f.evidence[3].metrics.correctness = 999; expect(validateRoutingProposal(f).ok).toBe(false);
    const self = fixture(); trustedEdit(self, 'role-quality', (r) => { r.selfEvaluation = true; }); expect(validateRoutingProposal(self).ok).toBe(false);
  });
  it('rejects MODEL_OK or requested identity without observed handoff identity', () => {
    const f = fixture(); trustedEdit(f, 'handoff', (r) => { r.identityReturned = false; r.output = 'MODEL_OK'; }); expect(validateRoutingProposal(f).ok).toBe(false);
  });
  it('enforces independently chosen role floors without inventing scores or changing benchmark suite', () => {
    for (const edit of [(r) => { r.metrics.correctness = 2; }, (r) => { r.benchmark.version = '2'; }, (r) => { r.metrics = {}; }]) {
      const f = fixture(); trustedEdit(f, 'role-quality', edit); expect(validateRoutingProposal(f).ok).toBe(false);
    }
  });
  it('rejects stale/future receipts', () => {
    for (const date of ['2026-09-01T00:00:00Z', '2026-10-05T00:00:00Z']) {
      const f = fixture(); trustedEdit(f, 'availability', (r) => { r.checkedAt = date; }); expect(validateRoutingProposal(f).ok).toBe(false);
    }
  });
  it('does not add providers, roles, billing or policy controls', () => {
    for (const change of [(p) => { p.routes.codex.newRole = p.routes.codex.medium; }, (p) => { p.billing = 'API'; }, (p) => { p.maxAgeMs = 999999999; }, (p) => { p.routes.newHost = {}; }]) {
      const f = fixture(); change(f.candidatePolicy); expect(validateRoutingProposal(f).ok).toBe(false);
    }
  });
  it('preserves explicit profile allocation overrides', () => {
    const f = fixture(); f.overrides = { codex: { medium: { model: 'owner-pick' } } }; expect(validateRoutingProposal(f).ok).toBe(false);
  });
  it('retains unchanged review date; semantic research is separate from promotion', () => {
    const f = fixture({ revalidate: true }); expect(validateRoutingProposal(f).ok).toBe(false);
    expect(validateRoutingProposal({ currentPolicy: prior, candidatePolicy: prior, sourceSha, contract: f.contract, now }).status).toBe('unchanged');
    expect(validateRoutingProposal({ currentPolicy: prior, candidatePolicy: prior, now }).status).toBe('unchanged');
  });
  it('changed role qualification does not require requalifying unchanged approved roles', () => {
    const f = fixture(); f.currentPolicy = structuredClone(prior); f.currentPolicy.routes.codex.fast = { model: 'gpt-fixture-old', effort: 'low' };
    f.candidatePolicy.routes.codex.fast = f.currentPolicy.routes.codex.fast;
    for (const row of f.evidence) { delete row.receiptSha256; row.candidateSha = candidateSha256(f.candidatePolicy); row.receiptSha256 = candidateSha256(row); f.contract.trustedReceipts[row.receiptSha256] = row.receiptSha256; }
    refreshContract(f); expect(validateRoutingProposal(f).ok).toBe(true);
  });
  it('atomically promotes, archives exact prior bytes, repeats idempotently and rolls back', () => {
    const d = disk(); const f = fixture(); const r = promoteRoutingPolicy({ ...d, ...f });
    expect(r.status).toBe('promoted'); expect(fs.readFileSync(r.previousPath).equals(d.bytes)).toBe(true);
    expect(JSON.parse(fs.readFileSync(d.policyPath))).toEqual(f.candidatePolicy);
    expect(fs.readFileSync(d.profilePath, 'utf8')).toBe('{"explicit":"keep"}');
    expect(promoteRoutingPolicy({ ...d, ...f }).status).toBe('idempotent');
    expect(rollbackRoutingPolicy({ policyPath: d.policyPath, expectedCurrentSha: r.policySha, previousSha: d.expectedPriorSha }).status).toBe('rolled-back');
    expect(fs.readFileSync(d.policyPath).equals(d.bytes)).toBe(true);
  });
  it('fences concurrent promotion and stale prior bytes', () => {
    const d = disk(); fs.writeFileSync(`${d.policyPath}.promotion.lock`, 'other owner');
    expect(promoteRoutingPolicy({ ...d, ...fixture() }).reason).toMatch(/Concurrent/); expect(fs.readFileSync(d.policyPath).equals(d.bytes)).toBe(true);
    fs.unlinkSync(`${d.policyPath}.promotion.lock`); fs.appendFileSync(d.policyPath, '\n');
    expect(promoteRoutingPolicy({ ...d, ...fixture() }).reason).toMatch(/fencing/);
  });
  it('rechecks prior fence before rename and refuses rollback over newer policy', () => {
    const d = disk(); const f = fixture(); const r = promoteRoutingPolicy({ ...d, ...f, beforeCommit: () => { fs.appendFileSync(d.policyPath, ' '); } });
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/before atomic/);
    fs.writeFileSync(d.policyPath, d.bytes); const promoted = promoteRoutingPolicy({ ...d, ...f }); fs.appendFileSync(d.policyPath, '\n');
    expect(rollbackRoutingPolicy({ policyPath: d.policyPath, expectedCurrentSha: promoted.policySha, previousSha: d.expectedPriorSha }).ok).toBe(false);
  });
});


it('Windows promotion flushes file contents without unsupported directory fsync and preserves rollback', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const original = fs.fsyncSync;
  const flush = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    expect(fs.fstatSync(fd).isFile()).toBe(true);
    return original(fd);
  });
  try {
    const f = { ...fixture(), ...disk() };
    const r = promoteRoutingPolicy(f);
    expect(r.status, r.reason).toBe('promoted');
    expect(r.directorySync).toBe('unsupported');
    expect(flush).toHaveBeenCalled();
    expect(rollbackRoutingPolicy({ policyPath: f.policyPath, expectedCurrentSha: r.policySha, previousSha: f.expectedPriorSha }).status).toBe('rolled-back');
  } finally { vi.restoreAllMocks(); }
});

function configuredTurnFixture() {
  const f = fixture();
  Object.assign(f.contract, { schemaVersion: 2, identityEvidence: 'native-configured-turn', backendIdentityProved: false,
    reviewer: { host: 'codex', model: 'gpt-independent-reviewer', effort: 'high' } });
  for (const kind of ['availability', 'settings', 'handoff', 'role-quality']) trustedEdit(f, kind, row => Object.assign(row, {
    identityEvidence: 'native-configured-turn', backendIdentityProved: false, identityReturnedBasis: 'native-host-confirmed-configuration',
    nativeSessionId: 'fixture-native-session', nativeTurnId: 'fixture-completed-turn', transcriptSha256: 'c'.repeat(64),
    ...(kind === 'role-quality' ? { reviewerHost: f.contract.reviewer.host, reviewerModel: f.contract.reviewer.model, reviewerEffort: f.contract.reviewer.effort } : {}),
  }));
  return f;
}
it('v2 expressly qualifies native configured turns without claiming backend identity', () => {
  const f = configuredTurnFixture();
  expect(validateRoutingProposal(f).status).toBe('qualified');
  const result = promoteRoutingPolicy({ ...f, ...disk() });
  expect(result.status).toBe('promoted');
  expect(result).toMatchObject({ identityEvidence: 'native-configured-turn', backendIdentityProved: false });
});
it.each(['nativeSessionId', 'nativeTurnId', 'transcriptSha256', 'identityReturnedBasis'])('v2 refuses unbound completion missing %s', field => {
  const f = configuredTurnFixture(); trustedEdit(f, 'handoff', row => { delete row[field]; });
  expect(validateRoutingProposal(f).reason).toMatch(/transcript binding|configured identity basis/);
});
it('v2 refuses requested-only identity or a candidate acting as its own reviewer', () => {
  const f = configuredTurnFixture(); trustedEdit(f, 'settings', row => { row.identityEvidence = 'requested-argv'; });
  expect(validateRoutingProposal(f).ok).toBe(false);
  const self = configuredTurnFixture(); self.contract.reviewer.model = self.candidatePolicy.routes.codex.medium.model;
  trustedEdit(self, 'role-quality', row => { row.reviewerModel = self.contract.reviewer.model; });
  expect(validateRoutingProposal(self).reason).toMatch(/independent model reviewer/);
});

it('v2 refuses a reviewer receipt from a different native host', () => { const f = configuredTurnFixture(); trustedEdit(f, 'role-quality', row => { row.reviewerHost = 'claude-code'; }); expect(validateRoutingProposal(f).reason).toMatch(/independent model reviewer/); });
