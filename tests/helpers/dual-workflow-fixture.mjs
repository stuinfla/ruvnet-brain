import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { sourceIdentity } from '../../scripts/qa-contract.mjs';
import { dualFileDigest } from '../../scripts/dual-workflow.mjs';
import { bindStageContent, TOP_SUBSCRIPTION_MODELS } from '../../scripts/dual-deliberation-contract.mjs';
import { nativeReviewEvidenceDigest } from '../../scripts/native-review-evidence.mjs';

// Synthetic transcripts exist only in disposable tests, never in product approval.
export function fixtureStageEvidence(host, stage, payload, value) {
  const stdout = host === 'codex'
    ? [{type:'thread.started',thread_id:'fixture-thread'}, {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}].map(row=>JSON.stringify(row)).join('\n')
    : JSON.stringify({type:'result',subtype:'success',session_id:'fixture-session',is_error:false,modelUsage:{[TOP_SUBSCRIPTION_MODELS[host]]:{}},result:JSON.stringify(value)});
  const evidence = {schemaVersion:1,kind:'ruvnet-brain-native-review-evidence',nativeHost:host,clientVersion:'test-fixture',
    requestedModel:TOP_SUBSCRIPTION_MODELS[host],modelIdentityClass:'requested-only',threadId:host==='codex'?'fixture-thread':null,sessionId:host==='claude-code'?'fixture-session':null,
    completionStatus:'completed',status:0,signal:null,startedAt:'2026-09-17T00:00:00.000Z',completedAt:'2026-09-17T00:00:01.000Z',
    prompt:JSON.stringify(payload),stdout,stderr:''};
  return {host,stage,evidence,canonicalDigest:nativeReviewEvidenceDigest(evidence)};
}

export function fixtureNativeApproval(brief, approval) {
  approval.requestedModels = TOP_SUBSCRIPTION_MODELS;
  approval.artifact = bindStageContent('synthesis',{schemaVersion:1,stage:'synthesis',artifact:approval.artifact.artifact});
  approval.verification = {schemaVersion:1,stage:'verify',verdict:'accept',corrections:[],
    artifactSha256:approval.artifact.artifactSha256,contentDigest:approval.artifact.contentDigest};
  approval.nativeEvidence = [];
  const task = 'Synthetic disposable workflow fixture', proposals = {}, critiques = {};
  const emit = (host,stage,payload,value) => approval.nativeEvidence.push(fixtureStageEvidence(host,stage,
    {task,...payload,implementation:{brief,briefDigest:digest(brief)}},value));
  for (const host of ['codex','claude-code']) {
    proposals[host] = bindStageContent('proposal',{schemaVersion:1,stage:'proposal',proposal:{decision:'fixture',host}});
    emit(host,'proposal',{},proposals[host]);
  }
  for (const host of ['codex','claude-code']) {
    critiques[host] = bindStageContent('critique',{schemaVersion:1,stage:'critique',findings:['fixture review']});
    emit(host,'critique',{proposal:proposals[host==='codex'?'claude-code':'codex']},critiques[host]);
  }
  emit(approval.roles.scribe,'synthesis',{proposals,critiques,correctionLedger:[]},approval.artifact);
  emit(approval.roles.verifier,'verify',{artifact:approval.artifact,correctionLedger:[]},approval.verification);
}

export function workflowFixture({firstText='first.txt\n'} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-workflow-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'work');
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.swarm/\n.claude-flow/\n');
  for (const file of ['goals.md', 'first.txt', 'second.txt']) fs.writeFileSync(path.join(root, file), file==='first.txt'?firstText:`${file}\n`);
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  const source = sourceIdentity(root);
  const brief = { schemaVersion: 2, source,
    inventory: ['first.txt', 'goals.md', 'second.txt'].map(file => ({ path: file, canonicalOwner: file,
      sha256: dualFileDigest(root, file), byteSha256:createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'), disposition: 'retain', reason: 'Fixture source reviewed' })),
    objectives: { path: 'goals.md', documentSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'goals.md'))).digest('hex'),
      goals: [{ id: 'working', outcome: 'Requested behavior works', acceptance: 'All specified checks pass' }] },
    worktrees: [{ path: root, stateDigest: source.digest, disposition: 'canonical', reason: 'One fixture checkout' }] };
  const evidenceFile = path.join(root,'.git','review-evidence.txt');
  fs.writeFileSync(evidenceFile,'Synthetic fixture review only; never authorizes product work.');
  const byteHash = value => createHash('sha256').update(value).digest('hex');
  const review = { schemaVersion:1, sourceDigest:source.digest,
    artifacts:[{id:'fixture-evidence',path:evidenceFile,sha256:byteHash(fs.readFileSync(evidenceFile))}],
    sources:brief.inventory.map(row => ({path:row.path,byteSha256:row.byteSha256,kind:'text',lines:1,readRanges:[[1,1]],assessment:'Fixture content has one line and one independent owner',evidenceId:'fixture-evidence'})),
    candidates:[{id:'c1',status:'accepted',jobId:'first',reason:'Exercise first fixture behavior',evidenceId:'fixture-evidence'}],
    adjudications:[{id:'a1',status:'rejected',reason:'Second file is a distinct fixture behavior',evidenceId:'fixture-evidence'}] };
  const reviewFile = path.join(root,'.git','review-manifest.json');
  fs.writeFileSync(reviewFile,JSON.stringify(review));
  brief.review = {path:reviewFile,sha256:byteHash(fs.readFileSync(reviewFile)),sourceDigest:source.digest,counts:{candidates:1,adjudications:1}};
  const plan = { schemaVersion: 1, briefDigest: digest(brief), adr: 'Use existing source owners', ddd: 'Keep the two responsibilities separate', unresolved: [],
    jobs: ['first', 'second'].map((id, i) => ({ id, outcome: `Finish ${id}`, dependsOn: i ? ['first'] : [], paths: [`${id}.txt`], goals: ['working'],
      checks: [{ id: `${id}-acceptance`, command: process.execPath, args: ['-e', 'console.log("verified")'], timeoutMs: 5000, kind: 'behavior', expectedOutput: 'verified', proves: 'Fixture process completes' }] })),
    completion: { jobId: 'second', clean: false, branch: 'work', worktreeCount: 1 } };
  const approval = { status: 'accepted', dual: true, planAccepted: true, verifiedOutcome: false,
    roles: { scribe: 'codex', verifier: 'claude-code' },
    artifact: { artifact: plan, contentDigest: digest(plan), artifactSha256: source.digest },
    verification: { verdict: 'accept', corrections: [], contentDigest: digest(plan), artifactSha256: source.digest } };
  approval.workflow = { brief, completed: [] };
  fixtureNativeApproval(brief,approval);
  return { root, brief, review, reviewFile, plan, workflow: { brief, approval, completed: [] }, git,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
