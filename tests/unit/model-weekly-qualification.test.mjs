import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256, candidateSha256 } from '../../scripts/model-routing-policy-promotion.mjs';
import { runWeeklyQualification } from '../../scripts/model-weekly-qualification.mjs';

const priorImportOnly = process.env.RUVNET_BRAIN_IMPORT_ONLY;
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { serverDependencies } = await import('../../bin/install.mjs');
if (priorImportOnly === undefined) delete process.env.RUVNET_BRAIN_IMPORT_ONLY;
else process.env.RUVNET_BRAIN_IMPORT_ONLY = priorImportOnly;

const dirs = []; afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function setup({ two = false, sameReviewer = false, coupled = false, claudeOnly = false } = {}) {
  const routerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-qualification-')); dirs.push(routerDir);
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const bytes = typeof data === 'string' ? data : JSON.stringify(data);
    fs.writeFileSync(file, bytes); return sha256(bytes); };
  const policy = { schemaVersion: 1, reviewedAt: '2026-10-04T13:32:24.704091Z', maxAgeMs: 604800000,
    routes: { codex: { fast: { model: 'old', effort: 'low' }, medium: { model: 'old', effort: 'medium' },
      hard: { model: sameReviewer ? 'new' : 'reviewer', effort: 'high' } } } };
  if (coupled) policy.routes['claude-code'] = { medium: { model: 'old', effort: 'medium' }, codingEffort: 'high' };
  if (claudeOnly) policy.routes['claude-code'].hard = { model: 'reviewer', effort: 'high' };
  const policyPath = path.join(routerDir, 'routing-policy.json'); const policySha256 = write(policyPath, policy);
  write(path.join(routerDir, 'profile.json'), { automaticModelRoutingUpdates: true,
    harnesses: { codex: { available: !claudeOnly, subscription: !claudeOnly }, 'claude-code': { available: coupled, subscription: coupled } } });
  const runDir = path.join(routerDir, 'semantic-reviews', 'fixture'); fs.mkdirSync(runDir, { recursive: true });
  const sourceId = sha256('independent benchmark evidence'); write(path.join(routerDir, 'evidence', `${sourceId}.html`), 'independent benchmark evidence');
  const candidateRoutes = structuredClone(policy.routes);
  if (coupled) candidateRoutes['claude-code'].medium.model = 'new';
  else { candidateRoutes.codex.fast.model = 'new'; if (two) candidateRoutes.codex.medium.model = 'new'; }
  const report = { findings: [{ category: 'measurement', text: 'SYNTHETIC independent benchmark', evidence: [{ sourceId, quote: 'benchmark evidence' }] }],
    proposedRoutes: Object.entries(candidateRoutes).flatMap(([host, rows]) => Object.entries(rows).filter(([, row]) => typeof row === 'object')
      .map(([taskClass, route]) => ({ host, taskClass, ...route,
        action: route.model !== policy.routes[host][taskClass].model ? 'propose' : 'retain', sourceIds: [sourceId] }))) };
  const proposal = { schemaVersion: 1, priorPolicySha256: policySha256, candidateRoutes };
  write(path.join(runDir, 'original-policy.json'), policy); write(path.join(runDir, 'evidence-packet.json'), []);
  const receipt = { status: 'validated-semantic-report', completedAt: new Date().toISOString(), runDir, policySha256, reportSha256: write(path.join(runDir, 'report.json'), report),
    proposalSha256: write(path.join(runDir, 'proposal.json'), proposal), sourceIds: [sourceId] };
  const semanticReceipt = path.join(runDir, 'receipt.json'); write(semanticReceipt, receipt);
  const task = { prompt: 'SYNTHETIC fixed acceptance', rubric: 'Exact answers', cases: [{ id: 'one', expected: 1 }, { id: 'two', expected: 2 }] };
  const contract = { schemaVersion: 2, authority: 'independent-reviewed', suite: 'fixture', version: '1', maxChangedRoles: 1,
    identityEvidence: 'native-configured-turn', backendIdentityProved: false, roles: { fast: task, medium: task, substantial: task }, roleAliases: { codingEffort: 'substantial' },
    candidateFloors: { deterministicPassRate: 1, criticalDefects: 0, majorDefects: 0, unresolvedReviewerFindings: 0 },
    comparison: { noGreaterDefectsAtEachSeverity: true, incumbentEvidenceRequired: true }, reviewRubric: 'Grade A/B independently' };
  const contractPath = path.join(routerDir, 'fixture-contract.json'); write(contractPath, contract);
  const grade = { criticalDefects: 0, majorDefects: 0, minorDefects: 0, unresolvedReviewerFindings: 0 };
  const probe = vi.fn(async (request) => {
    const reviewed = { casesCovered: true, A: grade, B: grade, evidenceSufficient: true, reasons: ['Fixture answers correct'] };
    const output = request.model === 'reviewer' ? JSON.stringify(coupled ? { roles: ['claude-code/medium', 'claude-code/codingEffort']
      .map((role) => ({ role, caseIds: ['one', 'two'], ...reviewed })) } : reviewed)
      : JSON.stringify({ cases: [{ id: 'one', answer: 1 }, { id: 'two', answer: 2 }] });
    const transcript = JSON.stringify({ request: { model: request.model, effort: request.effort }, completed: true, output });
    return { completed: true, output, nativeModel: request.model, nativeEffort: request.effort, identityBasis: 'native-host-confirmed-configuration',
      backendIdentityProved: false, nativeSubscription: true, available: true, supported: true, harnessVersion: 'fixture-1', elapsedMs: 1,
      transcript, transcriptSha256: sha256(transcript), sourceReceipt: { host: request.host, backendIdentityProved: false,
        request: { model: request.model, effort: request.effort, promptSha256: sha256(request.prompt) },
        nativeSettings: Object.fromEntries(['before', 'after'].map((phase) => [phase, { model: request.model, effort: request.effort,
          provider: 'openai', serviceTier: 'default', threadId: 'fixture-thread' }])),
        allowance: { verified: true }, nativeTurn: { threadId: 'fixture-thread', turnId: `fixture-${probe.mock.calls.length}`, status: 'completed', toolEvents: [] } } };
  });
  const promote = vi.fn((args) => {
    if (sha256(fs.readFileSync(policyPath)) !== args.expectedPriorSha) return { ok: false, reason: 'Prior policy changed; fencing rejected' };
    expect(args.contract.schemaVersion).toBe(2); expect(args.evidence).toHaveLength(coupled ? 8 : 4);
    expect(args.evidence.every((r) => r.backendIdentityProved === false && r.identityEvidence === 'native-configured-turn')).toBe(true);
    expect(args.candidatePolicy.reviewedAt).toBe(policy.reviewedAt);
    expect(args.contract.contractSha256).toBe(candidateSha256(Object.fromEntries(Object.entries(args.contract).filter(([k]) => k !== 'contractSha256'))));
    fs.writeFileSync(policyPath, JSON.stringify(args.candidatePolicy, null, 2)); return { ok: true, status: 'promoted' };
  });
  return { routerDir, contractPath, semanticReceipt, policyPath, policy, probe, promote, write, runDir };
}
describe('bounded weekly native qualification (synthetic inference only)', () => {
  it('passes the integrated v2 real CAS validator and preserves exact prior bytes', async () => {
    const f = setup(); const prior = fs.readFileSync(f.policyPath);
    const { promoteRoutingPolicy } = await import(pathToFileURL(process.env.QUALIFICATION_PROMOTION_MODULE || path.resolve(import.meta.dirname, '../../scripts/model-routing-policy-promotion.mjs')).href);
    const r = await runWeeklyQualification({ ...f, promote: promoteRoutingPolicy });
    expect(r.status, r.reason).toBe('promoted'); expect(fs.readFileSync(r.promotion.previousPath)).toEqual(prior);
    expect(JSON.parse(fs.readFileSync(f.policyPath)).reviewedAt).toBe(f.policy.reviewedAt);
  });
  it('passes integrated real CAS for BOTH coupled Claude roles without partial adoption', async () => {
    const f = setup({ coupled: true }); const prior = fs.readFileSync(f.policyPath);
    const { promoteRoutingPolicy } = await import(pathToFileURL(process.env.QUALIFICATION_PROMOTION_MODULE || path.resolve(import.meta.dirname, '../../scripts/model-routing-policy-promotion.mjs')).href);
    const r = await runWeeklyQualification({ ...f, promote: promoteRoutingPolicy }); expect(r.status, r.reason).toBe('promoted');
    expect(r.promotion.qualifiedRoles).toEqual(['claude-code/medium', 'claude-code/codingEffort']);
    expect(fs.readFileSync(r.promotion.previousPath)).toEqual(prior); expect(f.probe).toHaveBeenCalledTimes(5);
  });
  it('qualifies one changed role with identical inputs, anonymized independent review and four bound receipts', async () => {
    const f = setup(); const r = await runWeeklyQualification(f); expect(r.status).toBe('promoted'); expect(r.terminal).toBe(true);
    expect(f.probe).toHaveBeenCalledTimes(3); expect(f.probe.mock.calls[0][0].prompt).toBe(f.probe.mock.calls[1][0].prompt);
    expect(f.probe.mock.calls[2][0].model).toBe('reviewer'); expect(f.probe.mock.calls[2][0].prompt).toContain('SOURCE-BOUND EXTERNAL EVIDENCE');
    expect(f.probe.mock.calls[2][0].prompt).not.toContain('"model":"new"');
    const evidence = JSON.parse(fs.readFileSync(path.join(r.evidencePaths[0], 'evidence.json')));
    expect(evidence[3].allowanceMeasurement).toBeNull(); expect(evidence[3].incumbentMetrics.deterministicPassRate).toBe(1);
  });
  it('rejects deterministic incorrect candidate without reviewer or promotion', async () => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockImplementation(async (r) => { const turn = await good(r);
      if (r.model === 'new') turn.output = '{"cases":[{"id":"one","answer":0},{"id":"two","answer":2}]}'; return turn; });
    const prior = fs.readFileSync(f.policyPath); const r = await runWeeklyQualification(f);
    expect(r.status).toBe('rejected'); expect(f.probe).toHaveBeenCalledTimes(2); expect(f.promote).not.toHaveBeenCalled(); expect(fs.readFileSync(f.policyPath)).toEqual(prior);
  });
  it.each(['not JSON', '{"cases":[]}', '{"cases":[{"id":"unknown"}]}'])('terminally rejects completed malformed candidate %s after archiving it', async (output) => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockImplementation(async (r) => ({ ...await good(r), ...(r.model === 'new' ? { output } : {}) }));
    const r = await runWeeklyQualification(f); expect(r.status).toBe('rejected'); expect(r.terminal).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(r.evidencePaths[0], 'candidate.json'))).output).toBe(output);
    expect((await runWeeklyQualification(f)).status).toBe('unchanged'); expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it('keeps malformed incumbent retryable and does not run a candidate', async () => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockImplementation(async (r) => ({ ...await good(r), output: 'bad JSON' }));
    expect((await runWeeklyQualification(f)).status).toBe('deferred'); expect(f.probe).toHaveBeenCalledTimes(1);
  });
  it('qualifies coupled medium/coding model at both efforts with five calls and eight bound receipt rows', async () => {
    const f = setup({ coupled: true }); const r = await runWeeklyQualification(f); expect(r.status).toBe('promoted'); expect(r.terminal).toBe(true);
    expect(r.qualifiedRoles).toEqual(['claude-code/medium', 'claude-code/codingEffort']); expect(f.probe).toHaveBeenCalledTimes(5);
    expect(f.probe.mock.calls.slice(0, 4).map(([x]) => [x.host, x.model, x.effort])).toEqual([
      ['claude-code', 'old', 'medium'], ['claude-code', 'new', 'medium'], ['claude-code', 'old', 'high'], ['claude-code', 'new', 'high']]);
    const evidence = JSON.parse(fs.readFileSync(path.join(r.evidencePaths[0], 'evidence.json')));
    expect(evidence).toHaveLength(8); expect(evidence.filter((x) => x.kind === 'role-quality').every((x) => x.incumbentTranscriptSha256 && x.reviewerTranscriptSha256)).toBe(true);
    expect(JSON.parse(fs.readFileSync(f.policyPath)).routes['claude-code']).toEqual({ medium: { model: 'new', effort: 'medium' }, codingEffort: 'high' });
    expect((await runWeeklyQualification(f)).status).toBe('unchanged'); expect(f.probe).toHaveBeenCalledTimes(5);
  });
  it('uses an independent approved Claude hard reviewer in a Claude-only subscribed installation', async () => {
    const f = setup({ coupled: true, claudeOnly: true }); const r = await runWeeklyQualification(f); expect(r.status).toBe('promoted');
    expect(f.probe.mock.calls[4][0].host).toBe('claude-code');
    const evidence = JSON.parse(fs.readFileSync(path.join(r.evidencePaths[0], 'evidence.json')));
    expect(evidence.filter((x) => x.kind === 'role-quality').every((x) => x.reviewerHost === 'claude-code')).toBe(true);
  });
  it('defers without inference if no different approved hard reviewer is available/subscribed', async () => {
    const f = setup(); f.write(path.join(f.routerDir, 'profile.json'), { automaticModelRoutingUpdates: true, harnesses: {} });
    expect((await runWeeklyQualification(f)).reason).toMatch(/Independent approved hard reviewer/); expect(f.probe).not.toHaveBeenCalled();
  });
  it('accepts exact post-turn thread/read identity with explicit inherited Standard-tier basis', async () => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockImplementation(async (r) => { const turn = await good(r);
      delete turn.sourceReceipt.nativeSettings.after.serviceTier; Object.assign(turn.sourceReceipt.nativeSettings.after,
        { basis: 'native-thread/read', serviceTierBasis: 'pre-turn-native-settings-and-fixed-host-configuration' }); return turn; });
    expect((await runWeeklyQualification(f)).status).toBe('promoted');
  });
  it('rejects a coding-suite regression even if medium is perfect, with no averaging or partial promotion', async () => {
    const f = setup({ coupled: true }); const good = f.probe.getMockImplementation(); const prior = fs.readFileSync(f.policyPath);
    f.probe.mockImplementation(async (r) => { const turn = await good(r); if (r.model === 'reviewer') {
      const report = JSON.parse(turn.output); report.roles[1].A.criticalDefects = 1; report.roles[1].B.criticalDefects = 1; turn.output = JSON.stringify(report); } return turn; });
    expect((await runWeeklyQualification(f)).status).toBe('rejected'); expect(fs.readFileSync(f.policyPath)).toEqual(prior); expect(f.promote).not.toHaveBeenCalled();
  });
  it('defers incomplete per-suite case coverage and preserves both allocations', async () => {
    const f = setup({ coupled: true }); const good = f.probe.getMockImplementation();
    f.probe.mockImplementation(async (r) => { const turn = await good(r); if (r.model === 'reviewer') {
      const report = JSON.parse(turn.output); report.roles[1].caseIds = ['one']; turn.output = JSON.stringify(report); } return turn; });
    expect((await runWeeklyQualification(f)).reason).toMatch(/exact case coverage/); expect(f.promote).not.toHaveBeenCalled();
  });
  it('loads installed CLI contract from router root, without requiring repository config layout', () => {
    const f = setup(); const bin = path.join(f.routerDir, 'bin'); fs.mkdirSync(bin);
    const source = fileURLToPath(new URL('../../scripts/model-weekly-qualification.mjs', import.meta.url));
    fs.copyFileSync(source, path.join(bin, path.basename(source)));
    for (const dep of serverDependencies(source)) {
      const target = path.resolve(bin, dep.spec);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(dep.from, target);
    }
    fs.copyFileSync(f.contractPath, path.join(f.routerDir, 'qualification-contract.json'));
    fs.writeFileSync(path.join(bin, 'model-native-qualification.mjs'), 'export async function runNativeQualification(){return {completed:false};}');
    const child = spawnSync(process.execPath, [path.join(bin, 'model-weekly-qualification.mjs'), '--router-dir', f.routerDir,
      '--semantic-receipt', f.semanticReceipt, '--deadline', String(Date.now() + 10000)], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, `${child.stdout} ${child.stderr}`).toBe(1); expect(JSON.parse(child.stdout).reason).toMatch(/Native completion identity/);
  });
  it('rejects independent defect grades regardless of confident reasons', async () => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockImplementation(async (r) => { const turn = await good(r);
      if (r.model === 'reviewer') turn.output = JSON.stringify({ casesCovered: true, A: { criticalDefects: 1, majorDefects: 0, minorDefects: 0, unresolvedReviewerFindings: 0 },
        B: { criticalDefects: 1, majorDefects: 0, minorDefects: 0, unresolvedReviewerFindings: 0 }, evidenceSufficient: true, reasons: ['Very confident'] }); return turn; });
    expect((await runWeeklyQualification(f)).status).toBe('rejected'); expect(f.promote).not.toHaveBeenCalled();
  });
  it.each(['nativeModel', 'nativeEffort', 'identityBasis', 'transcriptSha256'])('defers missing/unmatched %s and preserves policy', async (key) => {
    const f = setup(); const prior = fs.readFileSync(f.policyPath); const good = f.probe.getMockImplementation();
    f.probe.mockImplementation(async (r) => ({ ...await good(r), [key]: 'wrong' }));
    expect((await runWeeklyQualification(f)).status).toBe('deferred'); expect(f.promote).not.toHaveBeenCalled(); expect(fs.readFileSync(f.policyPath)).toEqual(prior);
  });
  it('refuses same-model independent reviewer before spending a turn', async () => {
    const f = setup({ sameReviewer: true }); expect((await runWeeklyQualification(f)).reason).toMatch(/Independent/); expect(f.probe).not.toHaveBeenCalled();
  });
  it('retains policy on transient native refusal, then resumes without new semantic analysis', async () => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockResolvedValueOnce({ completed: false, reason: 'usage unavailable' });
    expect((await runWeeklyQualification(f)).status).toBe('deferred'); f.probe.mockImplementation(good);
    expect((await runWeeklyQualification(f)).status).toBe('promoted');
  });
  it('caps one changed role and resumes the original bound proposal across only its own CAS lineage', async () => {
    const f = setup({ two: true }); const first = await runWeeklyQualification(f); expect(first.status).toBe('promoted'); expect(first.terminal).toBe(false); expect(first.pendingRoles).toEqual(['codex/medium']);
    const second = await runWeeklyQualification(f); expect(second.status).toBe('promoted'); expect(f.probe).toHaveBeenCalledTimes(6);
    expect((await runWeeklyQualification(f)).status).toBe('unchanged'); expect(f.probe).toHaveBeenCalledTimes(6);
  });
  it('rejects concurrent working policy change at promotion CAS', async () => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockImplementation(async (r) => { const turn = await good(r);
      if (r.model === 'reviewer') fs.appendFileSync(f.policyPath, '\n'); return turn; });
    expect((await runWeeklyQualification(f)).reason).toMatch(/fencing/); expect(JSON.parse(fs.readFileSync(f.policyPath))).toEqual(f.policy);
  });
  it('rejects altered proposal and archived source before native calls', async () => {
    const f = setup(); fs.appendFileSync(path.join(f.runDir, 'proposal.json'), '\n');
    expect((await runWeeklyQualification(f)).reason).toMatch(/digest mismatch/); expect(f.probe).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent owners and refuses expired deadline', async () => {
    const f = setup(); f.write(path.join(f.routerDir, 'qualification-owner.json'), { token: 'other', expiresAt: Date.now() + 50000 });
    expect((await runWeeklyQualification(f)).reason).toMatch(/lease/); expect(f.probe).not.toHaveBeenCalled();
    expect((await runWeeklyQualification({ ...f, deadline: Date.now() - 1 })).reason).toMatch(/deadline/);
  });
  it('requires owner authorization before native qualification and never enables it', async () => {
    const f = setup(); f.write(path.join(f.routerDir, 'profile.json'), {});
    expect((await runWeeklyQualification(f)).reason).toMatch(/Authorization required/); expect(f.probe).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'profile.json')))).toEqual({});
  });
  it('rejects requested-only identity or unbound host settings despite successful completion', async () => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockImplementation(async (r) => { const turn = await good(r);
      turn.sourceReceipt.nativeSettings.after.threadId = 'another-turn'; return turn; });
    expect((await runWeeklyQualification(f)).status).toBe('deferred'); expect(f.promote).not.toHaveBeenCalled();
  });
  it('rejects actual tool events even when an otherwise successful adapter result is supplied', async () => {
    const f = setup(); const good = f.probe.getMockImplementation(); f.probe.mockImplementation(async (r) => { const turn = await good(r);
      turn.sourceReceipt.nativeTurn.toolEvents.push({ type: 'command_execution' }); return turn; });
    expect((await runWeeklyQualification(f)).status).toBe('deferred'); expect(f.promote).not.toHaveBeenCalled();
  });
});

it('records unchanged qualification without native comparisons or policy writes', async () => {
  const f = setup(); const before = fs.readFileSync(f.policyPath);
  const proposalPath = path.join(f.runDir, 'proposal.json'); const proposal = JSON.parse(fs.readFileSync(proposalPath));
  proposal.candidateRoutes = structuredClone(f.policy.routes);
  const receipt = JSON.parse(fs.readFileSync(f.semanticReceipt));
  receipt.proposalSha256 = f.write(proposalPath, proposal); f.write(f.semanticReceipt, receipt);
  const result = await runWeeklyQualification(f);
  expect(result).toMatchObject({ status: 'unchanged', terminal: true, policyApplied: false, nativeComparisonsExecuted: false, pendingRoles: [] });
  expect(f.probe).not.toHaveBeenCalled(); expect(f.promote).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.policyPath)).toEqual(before);
  expect(JSON.parse(fs.readFileSync(path.join(f.routerDir, 'qualification-last-attempt.json')))).toEqual(result);
  expect(result.priorPolicySha256).toBe(sha256(before)); expect(result.semanticReceiptSha256).toBe(sha256(fs.readFileSync(f.semanticReceipt)));
});
