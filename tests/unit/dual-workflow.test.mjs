import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { validateDualBrief, validateDualPlan, validateDualProgress } from '../../scripts/dual-workflow-contract.mjs';
import { assertDualBriefCurrent, assertDualJob, verifyDualJob, verifyDualCompletion, observeDualWorktree, dualFileDigest, assertDualReconciliationAction } from '../../scripts/dual-workflow.mjs';
import { sourceIdentity } from '../../scripts/qa-contract.mjs';
import { workflowFixture, fixtureNativeApproval, fixtureStageEvidence } from '../helpers/dual-workflow-fixture.mjs';
import { deliberate } from '../../scripts/dual-host-deliberation.mjs';
import { bindStageContent } from '../../scripts/dual-deliberation-contract.mjs';
import { nativeReviewEvidenceDigest } from '../../scripts/native-review-evidence.mjs';

const fixtures = [];
const fixture = options => { const f = workflowFixture(options); fixtures.push(f); return f; };
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
const rebind = f => {
  f.plan.briefDigest = digest(f.brief);
  f.workflow.approval.artifact.contentDigest = digest(f.plan);
  f.workflow.approval.verification.contentDigest = digest(f.plan);
  fixtureNativeApproval(f.brief,f.workflow.approval);
};
const addUserCheckout = f => {
  const side = `${f.root}-user`;
  f.git('worktree','add','-b','side',side);
  fixtures.push({cleanup:()=>fs.rmSync(side,{recursive:true,force:true})});
  fs.writeFileSync(path.join(side,'user.txt'),'preserved user work');
  f.brief.worktrees.push({path:side,stateDigest:sourceIdentity(side).digest,disposition:'integrate',reason:'Preserve user content',mutablePaths:['user.txt'],immutableDigest:observeDualWorktree(side,['user.txt']).immutableDigest});
  return side;
};

describe('generic Dual implementation contract', () => {
  it('refuses missing implementation preparation before invoking either model', async () => {
    let calls = 0;
    const result = await deliberate('Implement the approved changes', { mode: 'implementation', runHost: () => { calls++; } });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ status: 'unresolved', planAccepted: false, verifiedOutcome: false });
  });
  it.each([false, true])('binds every debate stage to the generic plan and rejects incomplete synthesis: %s', async incomplete => {
    const f = fixture();
    let sawBrief = 0;
    const out = await deliberate('Transform the application', { mode: 'implementation', cwd: f.root, brief: f.brief,
      probes: { claude: { eligible: true }, codex: { eligible: true } },
      runHost: async (host, stage, payload) => {
        expect(payload.implementation.briefDigest).toBe(digest(f.brief)); sawBrief++;
        const content = stage === 'proposal' ? { plan: 'A proposal' } : stage === 'critique' ? ['Adversarial review'] : incomplete ? { adr: 'incomplete' } : f.plan;
        return { ok: true, value: { schemaVersion: 1, stage, artifactSha256: f.brief.source.digest,
          contentDigest: ['verify', 'reverify'].includes(stage) ? payload.artifact.contentDigest : digest(content),
          ...(stage === 'proposal' ? { proposal: content } : stage === 'critique' ? { findings: content }
            : ['verify', 'reverify'].includes(stage) ? { verdict: 'accept', corrections: [] } : { artifact: content }) } };
      } });
    expect(out.status).toBe(incomplete ? 'unresolved' : 'accepted');
    expect(out.verifiedOutcome).toBe(false);
    if (!incomplete) expect(out).toMatchObject({ planAccepted: true, executionAuthorized: false });
    expect(sawBrief).toBe(incomplete ? 5 : 6);
  });
  it('requires reviewed source and objectives before planning', () => {
    expect(() => validateDualBrief()).toThrow(/brief/);
    const f = fixture();
    expect(assertDualBriefCurrent(f.brief, f.root).digest).toBe(f.brief.source.digest);
    f.brief.inventory.pop();
    expect(() => validateDualBrief(f.brief)).toThrow(/incomplete/);
  });
  it('requires line coverage for valid UTF-8 source even when it contains NUL bytes',()=> {
    const f=fixture({firstText:'source\0with a NUL\n'});
    expect(()=>assertDualBriefCurrent(f.brief,f.root)).not.toThrow();
    Object.assign(f.review.sources.find(row=>row.path==='first.txt'),{kind:'binary',lines:0,readRanges:[]});
    fs.writeFileSync(f.reviewFile,JSON.stringify(f.review));
    f.brief.review.sha256=createHash('sha256').update(fs.readFileSync(f.reviewFile)).digest('hex');
    expect(()=>assertDualBriefCurrent(f.brief,f.root)).toThrow(/source kind differs/);
  });
  it.each(['inventory-only','wrong-variant','partial','mislabelled-binary','missing-adjudication','unresolved','duplicate-cycle','unplanned-owner','changed-evidence'])('rejects inadequate source review: %s', variant => {
    const f = fixture();
    if (variant === 'inventory-only') delete f.brief.review;
    if (variant === 'wrong-variant') f.review.sources[0].byteSha256 = 'a'.repeat(64);
    if (variant === 'partial') { f.review.sources[0].lines = 2; }
    if (variant === 'mislabelled-binary') Object.assign(f.review.sources[0],{kind:'binary',lines:0,readRanges:[]});
    if (variant === 'missing-adjudication') f.review.adjudications = [];
    if (variant === 'unresolved') f.review.candidates[0].status = 'unresolved';
    if (variant === 'duplicate-cycle') Object.assign(f.review.candidates[0],{status:'duplicate',duplicateOf:'c1'});
    if (variant === 'unplanned-owner') f.review.candidates[0].jobId = 'invented';
    if (variant === 'changed-evidence') fs.appendFileSync(f.review.artifacts[0].path,'changed');
    fs.writeFileSync(f.reviewFile,JSON.stringify(f.review));
    if (f.brief.review) f.brief.review.sha256 = createHash('sha256').update(fs.readFileSync(f.reviewFile)).digest('hex');
    expect(() => assertDualBriefCurrent(f.brief,f.root,{plan:f.plan})).toThrow();
  });
  it('rejects source changes and an omitted worktree before spending model calls', () => {
    const f = fixture();
    f.brief.worktrees[0].path = '/different';
    expect(() => assertDualBriefCurrent(f.brief, f.root)).toThrow(/checkout/);
    fs.writeFileSync(path.join(f.root, 'first.txt'), 'drift');
    expect(() => assertDualBriefCurrent(f.brief, f.root)).toThrow(/stale/);
  });
  it.each(['unmapped', 'cycle', 'duplicate-owner', 'unresolved', 'missing-check', 'unassigned-deletion','missing-retirement-root'])('rejects %s in the plan', variant => {
    const f = fixture();
    if (variant === 'unmapped') f.brief.objectives.goals.push({ id: 'missing', outcome: 'Another goal', acceptance: 'Actual behavior' });
    if (variant === 'cycle') f.plan.jobs[0].dependsOn = ['second'];
    if (variant === 'duplicate-owner') f.plan.jobs[1].paths = ['first.txt'];
    if (variant === 'unresolved') f.plan.unresolved = ['Unknown owner'];
    if (variant === 'missing-check') f.plan.jobs[0].checks = [];
    if (variant === 'unassigned-deletion') f.brief.inventory.find(row => row.path === 'goals.md').disposition = 'delete';
    if (variant === 'missing-retirement-root') Object.assign(f.brief.worktrees[0],{retireAfterJob:'first',ignoredFiles:[],disposablePaths:[]});
    rebind(f);
    expect(() => validateDualPlan(f.plan, f.brief)).toThrow(variant==='missing-retirement-root'?/explicit completion root/:undefined);
  });
  it.each([
    [undefined, 900000, 'integration', true], [undefined, 900001, 'integration', false],
    [false, 3600000, 'integration', false], [true, 3600000, 'integration', true],
    [true, 3600001, 'integration', false], ['yes', 1000, 'integration', false],
    [true, 1000, 'behavior', false], [true, 0, 'integration', false],
  ])('bounds declared full-suite budgets: %s %s %s', (fullSuite, timeoutMs, kind, valid) => {
    const f = fixture();
    Object.assign(f.plan.jobs[0].checks[0], { fullSuite, timeoutMs, kind });
    if (fullSuite === undefined) delete f.plan.jobs[0].checks[0].fullSuite;
    rebind(f);
    if (valid) expect(() => validateDualPlan(f.plan, f.brief)).not.toThrow();
    else expect(() => validateDualPlan(f.plan, f.brief)).toThrow(/deadline|full-suite/);
  });
  it('still rejects a timed-out command with an approved full-suite declaration', async () => {
    const f = fixture();
    Object.assign(f.plan.jobs[0].checks[0], { fullSuite: true, kind: 'integration', timeoutMs: 50,
      command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
    rebind(f);
    await expect(verifyDualJob(f.workflow, { root: f.root, jobId: 'first' })).rejects.toThrow(/acceptance failed/);
    expect(f.workflow.completed).toEqual([]);
  });
  it('completes jobs sequentially against actual command evidence on an arbitrary branch', async () => {
    const f = fixture();
    expect(() => assertDualJob(f.workflow, { root: f.root, jobId: 'second' })).toThrow(/next unfinished/);
    fs.writeFileSync(path.join(f.root, 'first.txt'), 'implemented');
    f.workflow.completed.push(await verifyDualJob(f.workflow, { root: f.root, jobId: 'first' }));
    expect(() => verifyDualCompletion(f.workflow, { root: f.root })).toThrow(/unfinished/);
    f.workflow.completed.push(await verifyDualJob(f.workflow, { root: f.root, jobId: 'second' }));
    expect(verifyDualCompletion(f.workflow, { root: f.root }).status).toBe('complete');
    f.workflow.completed.reverse();
    expect(() => validateDualProgress(f.workflow)).toThrow(/order/);
  });
  it('rejects out-of-scope edits, completed-job regressions, and plan changes', async () => {
    const f = fixture();
    expect(() => assertDualJob(f.workflow, { root: f.root, jobId: 'first', changedFiles: ['second.txt'] })).toThrow(/outside/);
    f.workflow.completed.push(await verifyDualJob(f.workflow, { root: f.root, jobId: 'first' }));
    fs.writeFileSync(path.join(f.root, 'first.txt'), 'later job drift');
    expect(() => assertDualJob(f.workflow, { root: f.root, jobId: 'second' })).toThrow(/drift|regressed/);
    f.plan.jobs[1].outcome = 'A different job';
    expect(() => validateDualProgress(f.workflow)).toThrow(/approval/);
  });
  it('stops at a failing acceptance check without running dependent checks', async () => {
    const f = fixture();
    f.plan.jobs[0].checks[0].args = ['-e', 'process.exit(1)'];
    f.plan.jobs[0].checks.push({ ...f.plan.jobs[0].checks[0], id: 'must-not-run', args: ['-e', 'require("fs").writeFileSync("sentinel", "bad")'] });
    rebind(f);
    await expect(verifyDualJob(f.workflow, { root: f.root, jobId: 'first' })).rejects.toThrow(/acceptance failed/);
    expect(fs.existsSync(path.join(f.root, 'sentinel'))).toBe(false);
    expect(f.workflow.completed).toHaveLength(0);
  });
  it('rejects self-reported done and forged zero-check receipts', () => {
    const f = fixture();
    f.workflow.completed.push({ jobId: 'first', done: true });
    expect(() => validateDualProgress(f.workflow)).toThrow();
  });
  it.each(['missing','different-brief','different-plan','lost-critique'])('refuses %s native approval evidence before execution', variant => {
    const f = fixture();
    if (variant === 'missing') delete f.workflow.approval.nativeEvidence;
    if (variant === 'different-brief') f.workflow.approval.nativeEvidence[0].evidence.prompt = '{}';
    if (variant === 'different-plan') f.workflow.approval.nativeEvidence.find(row=>row.stage==='synthesis').evidence.stdout = '{}';
    if (variant === 'lost-critique') f.workflow.approval.nativeEvidence = f.workflow.approval.nativeEvidence.filter(row=>!(row.host==='codex'&&row.stage==='critique'));
    expect(()=>assertDualJob(f.workflow,{root:f.root,jobId:'first'})).toThrow(/native|critique/);
  });
  it('rejects successful process exits without the approved result evidence', async () => {
    const f = fixture();
    f.plan.jobs[0].checks[0].args = ['-e', 'process.exit(0)']; rebind(f);
    await expect(verifyDualJob(f.workflow, { root: f.root, jobId: 'first' })).rejects.toThrow(/acceptance failed/);
  });
  it('cannot promote an unresolved native deliberation by changing only approval flags', async () => {
    const f = fixture();
    const out = await deliberate('Resolve every correction',{mode:'implementation',cwd:f.root,brief:f.brief,
      probes:{claude:{eligible:true},codex:{eligible:true}},runHost:async(host,stage,payload)=>{
        const value = bindStageContent(stage,{schemaVersion:1,stage,
          ...(stage==='proposal'?{proposal:{decision:'fixture'}}:stage==='critique'?{findings:['missing proof'],corrections:[{id:'c1',text:'prove closure'}]}
            :stage==='verify'?{verdict:'accept',corrections:[],artifactSha256:payload.artifact.artifactSha256,contentDigest:payload.artifact.contentDigest}:{artifact:f.plan})});
        return {ok:true,value,extra:fixtureStageEvidence(host,stage,payload,value)};
      }});
    expect(out.status).toBe('unresolved');
    out.status='accepted'; out.planAccepted=true;
    expect(()=>assertDualJob({brief:f.brief,approval:out,completed:[]},{root:f.root,jobId:'first'})).toThrow(/resolution/);
  });
  it.each(['cross-critique','synthesis','brief','downgraded-model'])('rejects retained but causally invalid evidence: %s', variant => {
    const f=fixture(), approval=f.workflow.approval;
    const row=approval.nativeEvidence.find(row=>row.stage===(variant==='cross-critique'?'critique':'synthesis'));
    const payload=JSON.parse(row.evidence.prompt);
    if(variant==='cross-critique') payload.proposal={unrelated:true};
    if(variant==='synthesis') payload.critiques={};
    if(variant==='brief') payload.implementation.brief={};
    if(variant==='downgraded-model') { approval.requestedModels={...approval.requestedModels,[row.host]:'weaker'}; row.evidence.requestedModel='weaker'; }
    row.evidence.prompt=JSON.stringify(payload); row.canonicalDigest=nativeReviewEvidenceDigest(row.evidence);
    expect(()=>assertDualJob(f.workflow,{root:f.root,jobId:'first'})).toThrow(/native/);
  });
  it('does not credit source mutated by an otherwise passing acceptance command', async () => {
    const f = fixture();
    f.plan.jobs[0].checks[0].args = ['-e', 'require("fs").writeFileSync("first.txt", "changed during check"); console.log("verified")'];
    rebind(f);
    await expect(verifyDualJob(f.workflow, { root: f.root, jobId: 'first' })).rejects.toThrow(/source changed/);
  });
  it('enforces the approved completion conditions without imposing main universally', async () => {
    const f = fixture();
    f.plan.completion.branch = 'main'; rebind(f);
    f.workflow.completed.push(await verifyDualJob(f.workflow, { root: f.root, jobId: 'first' }));
    await expect(verifyDualJob(f.workflow, { root: f.root, jobId: 'second' })).rejects.toThrow(/completion conditions/);
  });
  it.each(['missing', 'wrong-file', 'skipped', 'todo', 'empty', 'valid'])('requires the executed structured test population: %s', async variant => {
    const f = fixture();
    const check = f.plan.jobs[0].checks[0];
    check.report = {format:'vitest-json',files:['tests/required.test.mjs'],minTests:1};
    check.expectedOutput = 'true';
    const report = {success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,
      testResults:[{name:path.join(f.root,'tests/required.test.mjs'),status:'passed',assertionResults:[{fullName:'required behavior',status:'passed'}]}]};
    if (variant === 'wrong-file') report.testResults[0].name = 'tests/other.test.mjs';
    if (variant === 'skipped') report.testResults[0].assertionResults[0].status = 'pending';
    if (variant === 'todo') report.numTodoTests = 1;
    if (variant === 'empty') report.testResults[0].assertionResults = [];
    check.args = ['-e', `console.log(${JSON.stringify(variant === 'missing' ? 'true PASS' : JSON.stringify(report))})`];
    rebind(f);
    if (variant === 'valid') {
      const receipt = await verifyDualJob(f.workflow,{root:f.root,jobId:'first'});
      expect(receipt.checks[0].executedTests).toBe(1);
      f.workflow.completed.push(receipt);
      expect(validateDualProgress(f.workflow).nextJob.id).toBe('second');
    } else await expect(verifyDualJob(f.workflow,{root:f.root,jobId:'first'})).rejects.toThrow(/acceptance failed/);
  });
  it('permits exact external user refreshes while retaining every other freshness boundary', () => {
    const f = fixture(), side = addUserCheckout(f);
    expect(() => assertDualBriefCurrent(f.brief,f.root)).not.toThrow();
    fs.writeFileSync(path.join(side,'user.txt'),'new user work');
    expect(() => assertDualBriefCurrent(f.brief,f.root)).not.toThrow();
    fs.writeFileSync(path.join(side,'first.txt'),'external source drift');
    expect(() => assertDualBriefCurrent(f.brief,f.root)).toThrow(/outside preserved/);
  });
  it.each(['deleted','symlink'])('rejects %s substitution of preserved external data', variant => {
    const f = fixture(), side = addUserCheckout(f);
    fs.unlinkSync(path.join(side,'user.txt'));
    if (variant === 'symlink') fs.symlinkSync(path.join(side,'first.txt'),path.join(side,'user.txt'));
    expect(() => assertDualBriefCurrent(f.brief,f.root)).toThrow(/disappeared|symlink/);
  });
  it('binds external actions to an existing checkout, safe paths and the declared digest encoding', () => {
    const f = fixture(), side = addUserCheckout(f);
    f.plan.worktreeReconciliation = [{id:'preserve-user',jobId:'first',targetRoot:side,worktreeRoot:side,relativePath:'user.txt',targetPath:'user.txt',action:'preserve',expectedSha256:dualFileDigest(side,'user.txt'),digestEncoding:'dual-file-v1',reason:'Keep unique user bytes'}];
    rebind(f);
    expect(() => validateDualPlan(f.plan,f.brief)).not.toThrow();
    expect(assertDualReconciliationAction(f.brief,f.plan,'preserve-user').action).toBe('preserve');
    f.plan.worktreeReconciliation[0].digestEncoding = 'raw-sha256'; rebind(f);
    expect(() => validateDualPlan(f.plan,f.brief)).toThrow(/unsafe or unbound/);
    f.plan.worktreeReconciliation[0].digestEncoding = 'dual-file-v1';
    f.plan.worktreeReconciliation[0].targetPath = '../elsewhere'; rebind(f);
    expect(() => validateDualPlan(f.plan,f.brief)).toThrow(/unsafe or unbound/);
  });
  it.each(['lost-checkout','missing-copy','changed-copy','unlisted-private','missing-user-action','missing-user-copy','stale-user-copy','valid'])('requires completed preservation before retiring a checkout: %s', async variant=> {
    const f=fixture(), side=addUserCheckout(f), tree=f.brief.worktrees.at(-1);
    fs.mkdirSync(path.join(side,'.swarm'),{recursive:true});
    fs.writeFileSync(path.join(side,'.swarm/private.txt'),'unique private data');
    const sha256=dualFileDigest(side,'.swarm/private.txt',{privateData:true});
    Object.assign(tree,{retireAfterJob:'first',ignoredFiles:[{path:'.swarm/private.txt',sha256}],disposablePaths:[]});
    f.plan.worktreeReconciliation=[{id:'private-data',jobId:'first',worktreeRoot:side,relativePath:'.swarm/private.txt',targetRoot:f.root,
      targetPath:'.swarm/preserved.txt',action:'preserve',expectedSha256:sha256,digestEncoding:'dual-file-v1',reason:'Preserve unique ignored data'}];
    if (variant!=='missing-user-action') f.plan.worktreeReconciliation.push({id:'user-data',jobId:'first',worktreeRoot:side,relativePath:'user.txt',targetRoot:f.root,
      targetPath:'.swarm/preserved-user.txt',action:'preserve',expectedSha256:dualFileDigest(side,'user.txt'),digestEncoding:'dual-file-v1',reason:'Preserve unique nonignored user data'});
    f.plan.completion.root=f.root;
    if(variant==='stale-user-copy') {
      f.plan.jobs.splice(1,0,{...structuredClone(f.plan.jobs[0]),id:'middle',dependsOn:['first'],paths:['goals.md'],checks:[{...f.plan.jobs[0].checks[0],id:'middle-acceptance'}]});
      f.plan.jobs.at(-1).dependsOn=['middle']; tree.retireAfterJob='middle';
    }
    rebind(f);
    if(variant==='missing-user-action') {
      expect(()=>validateDualPlan(f.plan,f.brief)).toThrow(/user data has no preservation/); return;
    }
    expect(()=>assertDualBriefCurrent(f.brief,f.root,{plan:f.plan})).not.toThrow();
    if(variant==='lost-checkout') {
      f.git('worktree','remove','--force',side);
      await expect(verifyDualJob(f.workflow,{root:f.root,jobId:'first'})).rejects.toThrow(/disappeared/); return;
    }
    if(variant==='unlisted-private') {
      fs.writeFileSync(path.join(side,'.swarm/forgotten.txt'),'unaccounted');
      await expect(verifyDualJob(f.workflow,{root:f.root,jobId:'first'})).rejects.toThrow(/private inventory/); return;
    }
    if(variant==='missing-copy') {
      await expect(verifyDualJob(f.workflow,{root:f.root,jobId:'first'})).rejects.toThrow(/unfinished reconciliation/); return;
    }
    fs.mkdirSync(path.join(f.root,'.swarm'),{recursive:true});
    fs.copyFileSync(path.join(side,'.swarm/private.txt'),path.join(f.root,'.swarm/preserved.txt'));
    if(variant==='missing-user-copy') {
      await expect(verifyDualJob(f.workflow,{root:f.root,jobId:'first'})).rejects.toThrow(/unfinished reconciliation.*user-data/); return;
    }
    fs.copyFileSync(path.join(side,'user.txt'),path.join(f.root,'.swarm/preserved-user.txt'));
    f.workflow.completed.push(await verifyDualJob(f.workflow,{root:f.root,jobId:'first'}));
    if(variant==='stale-user-copy') {
      fs.writeFileSync(path.join(side,'user.txt'),'new user refresh after preservation');
      await expect(verifyDualJob(f.workflow,{root:f.root,jobId:'middle'})).rejects.toThrow(/source identity changed|user data/); return;
    }
    f.git('worktree','remove','--force',side);
    if(variant==='changed-copy') {
      fs.writeFileSync(path.join(f.root,'.swarm/preserved.txt'),'lost');
      await expect(verifyDualJob(f.workflow,{root:f.root,jobId:'second'})).rejects.toThrow(/not preserved/); return;
    }
    f.workflow.completed.push(await verifyDualJob(f.workflow,{root:f.root,jobId:'second'}));
    expect(verifyDualCompletion(f.workflow,{root:f.root}).status).toBe('complete');
  });
  it('finishes in the declared checkout with only observed user dirt preserved', async () => {
    const f = fixture(), side = addUserCheckout(f);
    Object.assign(f.plan.completion,{root:side,branch:'side',clean:true,worktreeCount:2,preservedPaths:['user.txt']});
    rebind(f);
    fs.writeFileSync(path.join(f.root,'first.txt'),'real completed implementation');
    f.workflow.completed.push(await verifyDualJob(f.workflow,{root:f.root,jobId:'first'}));
    fs.copyFileSync(path.join(f.root,'first.txt'),path.join(side,'first.txt'));
    f.git('-C',side,'add','first.txt');
    f.git('-C',side,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Transfer accepted implementation');
    fs.writeFileSync(path.join(side,'second.txt'),'final destination edit');
    f.git('-C',side,'add','second.txt');
    f.git('-C',side,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Complete final job');
    f.workflow.completed.push(await verifyDualJob(f.workflow,{root:side,jobId:'second'}));
    expect(verifyDualCompletion(f.workflow,{root:side}).status).toBe('complete');
    fs.writeFileSync(path.join(f.root,'first.txt'),'unrelated original-tree regression');
    expect(()=>verifyDualCompletion(f.workflow,{root:side})).toThrow(/drift|regressed/);
    fs.copyFileSync(path.join(side,'first.txt'),path.join(f.root,'first.txt'));
    expect(() => verifyDualCompletion(f.workflow,{root:f.root})).toThrow(/completion conditions/);
    fs.writeFileSync(path.join(side,'unexplained.txt'),'not excepted');
    expect(() => verifyDualCompletion(f.workflow,{root:side})).toThrow(/completion conditions/);
    fs.unlinkSync(path.join(side,'unexplained.txt'));
    fs.writeFileSync(path.join(side,'user.txt'),'concurrent update');
    expect(() => verifyDualCompletion(f.workflow,{root:side})).toThrow(/user state changed/);
  });
  it('finishes in main after preserving real changes and retiring the linked integration checkout', async()=> {
    const f=fixture(), integration=`${f.root}-integration`;
    f.git('worktree','add','-b','integration',integration);
    fixtures.push({cleanup:()=>fs.rmSync(integration,{recursive:true,force:true})});
    Object.assign(f.brief.worktrees[0],{path:integration,retireAfterJob:'first',ignoredFiles:[],disposablePaths:[]});
    f.brief.worktrees.push({path:f.root,stateDigest:sourceIdentity(f.root).digest,disposition:'integrate',reason:'Final primary checkout'});
    Object.assign(f.plan.completion,{root:f.root,clean:true,worktreeCount:1});
    rebind(f);
    expect(()=>assertDualBriefCurrent(f.brief,integration,{plan:f.plan})).not.toThrow();
    fs.writeFileSync(path.join(integration,'first.txt'),'accepted integration change');
    f.workflow.completed.push(await verifyDualJob(f.workflow,{root:integration,jobId:'first'}));
    fs.copyFileSync(path.join(integration,'first.txt'),path.join(f.root,'first.txt'));
    f.git('add','first.txt');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Integrate accepted source');
    f.git('worktree','remove','--force',integration);
    f.workflow.completed.push(await verifyDualJob(f.workflow,{root:f.root,jobId:'second'}));
    expect(verifyDualCompletion(f.workflow,{root:f.root}).status).toBe('complete');
  });
});
