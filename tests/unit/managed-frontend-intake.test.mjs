import {it,expect,afterEach} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {PassThrough,Writable} from 'node:stream';import {EventEmitter} from 'node:events';
import {launchCodexManagedTerminal} from '../../scripts/codex-managed-terminal.mjs';
import {runManagedPrompt} from '../../scripts/model-managed-prompt.mjs';
import {recordManagedFrontendIntent,claimManagedFrontendIntent} from '../../scripts/managed-frontend-intake.mjs';
import {planManagedTask as actualPlanManagedTask,executeManagedWorkflow,commitManagedReceipt,captureCheckerRegistry} from '../../scripts/model-managed-workflow-service.mjs';
import {readManagedContinuationTask} from '../../plugin/scripts/continuation-objective.mjs';
import {ContinuityJournal,drain} from '../../plugin/scripts/continuity-journal.mjs';
import {adoptedProject,fakeRuflo,cleanup} from '../helpers/continuity-fixture.mjs';
afterEach(cleanup);const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
// Controlled observations qualify mechanical fixture joins, never native model review.
const preflightFixture=async args=>{const packet=JSON.parse(args.prompt);
 expect(packet.responseSchema.required).toContain('criterionCoverage');expect(packet.responseSchema.required).toContain('boundaryIds');
 expect(packet.responseSchema.properties.kind.const).toBe('scope-preflight');expect(packet.instructions).toContain('responseSchema');expect(packet.instructions).not.toContain('artifactDigest');
 return{completed:true,model:args.decision.model,effort:args.decision.effort,sessionId:'fixture-preflight-'+crypto.randomUUID(),
 answer:JSON.stringify({schemaVersion:1,kind:'scope-preflight',passed:true,originalPromptDigest:packet.originalPromptDigest,inventoryDigest:packet.inventoryDigest,tasksDigest:packet.tasksDigest,packetDigest:packet.packetDigest,
 requirementIds:packet.inventory.requirements.map(r=>r.id),boundaryIds:packet.sourcePacket.entries.map(r=>r.id),criterionCoverage:packet.tasks.flatMap(t=>t.acceptanceCriteria.map(c=>({taskId:t.id,criterionId:c.id,checkIds:c.checkIds,passed:true}))),findings:[],omissions:[]})};};
const planManagedTask=(input,options={})=>actualPlanManagedTask(input,{...options,runPreflight:options.runPreflight??preflightFixture,runPlanner:async args=>{
 if(typeof options.runPlanner!=='function')throw Error('Fixture planner unavailable');
 const observation=await options.runPlanner(args),value=JSON.parse(observation.answer);
 const requirements=value.obligations??args.request.continuationRegistration.ownerInventory?.requirements??[{id:'original-1',statement:'Preserve the entire original fixture request and its scoped acceptance',disposition:'in-scope',
  originalLocator:{start:0,end:input.originalPrompt.length,quote:input.originalPrompt},taskMappings:value.tasks.map(t=>({taskId:t.id,criterionIds:t.acceptanceCriteria.map(c=>c.id),checkIds:t.checkIds}))}];
 if(!value.obligations)value.obligations=requirements;
 if(!value.sourceBoundaries){const file=path.join(input.projectRoot,fs.existsSync(path.join(input.projectRoot,'accepted.test.mjs'))?'accepted.test.mjs':'package.json'),bytes=fs.readFileSync(file);
  value.sourceBoundaries=['entry','caller','consumer','config','native-host','state-transition','crash-recovery','error'].map((dimension,index)=>({id:'boundary-'+index,dimension,requirementIds:requirements.map(r=>r.id),state:index<3?'read':'not-applicable',
   ...(index<3?{}:{reason:'Disposable mechanical fixture has no additional '+dimension+' implementation; independent fixture comparison only'}),sourceRef:{path:file,digest:sha(bytes)},ranges:[{startLine:1,endLine:1}]}));}
 return{...observation,answer:JSON.stringify(value)};
}});
async function preflightCase({prompt='Implement the first obligation and retain the second obligation.',maxAttempts=6,observe=preflightFixture,pending=false,afterPlan,recallMemory,instructions}={}){
 const f=setup(),t=terminal(),decision={harness:'codex',provider:'openai',model:'fixture',effort:'medium'};let plannerCalls=0,preflightCalls=0;
 fs.writeFileSync(path.join(f.p.dir,'package.json'),JSON.stringify({scripts:{test:'node --test accepted.test.mjs'}}));fs.writeFileSync(path.join(f.p.dir,'accepted.test.mjs'),'import assert from "node:assert/strict";assert.equal(1,1);');
 const checkId=captureCheckerRegistry(f.p.dir).registry.find(c=>c.kind==='command').id;
 const running=launchCodexManagedTerminal({binary:'/native',cwd:f.p.dir,env:f.env,...t,readConfig:async()=>config(f.p.dir),captureFrontendIntent:f.capture,managedPrompt:async options=>{
  try{const plan=await planManagedTask({originalPrompt:options.originalPrompt,harness:'codex',projectRoot:f.p.dir,allowedWorktrees:[f.p.dir],nativeContext:options.nativeContext,permissions:options.permissions,contextRefs:[],deadline:options.deadline,maxAttempts,maxConcurrent:1},
   {frontendIntake:options.frontendIntake,env:f.env,recordRegistration:f.commit,route:async()=>decision,recallMemory:recallMemory??(async args=>({outcome:'ok-empty',receipt:{binding:args.binding,observedAt:new Date().toISOString(),queryDigest:sha(args.prompt)}})),sampleCapacity:()=>({workers:1}),
    runPreflight:async args=>{preflightCalls++;return observe(args);},runPlanner:async()=>{plannerCalls++;return{completed:true,model:decision.model,effort:decision.effort,sessionId:'fixture-planner',answer:JSON.stringify({unresolvedObligations:[],tasks:[{id:'work',instructions:instructions??'Inspect the fixture original behavior and preserve source scope',mode:'read',worktree:f.p.dir,paths:[],dependsOn:[],checkIds:[checkId],acceptanceCriteria:[{id:'result',assertion:'The existing behavioral fixture proves the selected original result',checkIds:[checkId]}]}],
     ...(pending?{obligations:[{id:'P001',statement:'Implement original P001 scoped behavior now',disposition:'in-scope',originalLocator:{start:0,end:prompt.length,quote:prompt},taskMappings:[{taskId:'work',criterionIds:['result'],checkIds:[checkId]}]},
      {id:'P002',statement:'Retain original P002 business obligation pending',disposition:'pending',originalLocator:{start:0,end:prompt.length,quote:prompt},taskMappings:[]}]}:{})})};}});
   if(afterPlan)await afterPlan(plan,f,decision);return{sessionId:'11111111-1111-4111-8111-111111111111'};
  }finally{t.input.write('/exit\n');}
 }});setImmediate(()=>t.input.write(prompt+'\n'));return{f,running,counts:()=>({plannerCalls,preflightCalls})};
}
function terminal(){const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};const output=new Writable({write(_x,_e,done){done();}});output.isTTY=true;return{input,output,diagnostics:new PassThrough(),signalSource:new EventEmitter()};}
for(const mode of ['fresh','stale','private','overflow'])it('preflight actually delivers fresh bounded private history: '+mode,async()=>{
 let delivered;const value=await preflightCase({instructions:mode==='overflow'?'Scoped instructions '.repeat(2250):undefined,
  recallMemory:async args=>{const result={outcome:'ok-empty',block:'UNTRUSTED '+args.binding.phase+' sentinel',receipt:{binding:args.binding,observedAt:new Date().toISOString(),queryDigest:sha(args.prompt)}};
   if(args.binding.phase==='scope-preflight'){if(mode==='stale')result.receipt.binding={...args.binding,phase:'planner'};
    if(mode==='private')result.block='NPM_TOKEN=SYNTHETIC_PREFLIGHT_PRIVATE_VALUE';if(mode==='overflow')result.picks=[{preview:'x'.repeat(14000)}];}return result;},
  observe:async args=>{delivered=args.prompt;const packet=JSON.parse(delivered);expect(packet.untrustedMemoryData.block).toBe('UNTRUSTED scope-preflight sentinel');
   expect(packet.untrustedMemoryData.receipt.binding.phase).toBe('scope-preflight');expect(args.request.memoryRecall).toEqual(packet.untrustedMemoryData);
   expect(delivered).not.toContain('UNTRUSTED planner sentinel');return preflightFixture(args);},
  afterPlan:async plan=>{const ref=plan.request.scopeContract.sourceReview.packetRef;expect(fs.readFileSync(ref.path,'utf8')).toBe(delivered);expect(ref.digest).toBe(sha(delivered));expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(65536);}});
 if(mode==='fresh'){await value.running;expect(value.counts().preflightCalls).toBe(1);}
 else{await expect(value.running).rejects.toThrow(mode==='stale'?/history unavailable/:mode==='private'?/privacy loss/:/Bounded total preflight delivery/);expect(value.counts().preflightCalls).toBe(0);}
});
function config(cwd,trusted=true){return{config:{approval_policy:'never',sandbox_mode:'workspace-write',projects:{[cwd]:{trust_level:trusted?'trusted':'untrusted'}}},layers:[]};}
function setup(){const p=adoptedProject(),ruflo=process.env.RNB_REAL_FRONTEND_RUFLO?{bin:process.env.RNB_REAL_FRONTEND_RUFLO}:fakeRuflo(),ledger=path.join(p.home,'frontend-ledger.json'),env={...p.env,RUVNET_WORK_LEDGER:ledger};
 class Journal extends ContinuityJournal{constructor(options){super({...options,env,home:p.home});}}
 const capture=args=>recordManagedFrontendIntent({...args,deadlineAt:Math.min(args.deadlineAt??Infinity,Date.now()+4500.5),Journal,drainJournal:(journal,options)=>drain(journal,{...options,ruflo:ruflo.bin,backoff:[]})});
 const commit=(request,receipt)=>commitManagedReceipt(request,receipt,{Journal,drainJournal:(journal,options)=>drain(journal,{...options,ruflo:ruflo.bin,backoff:[]})});return{p,env,ledger,capture,commit};}
it('caller JSON, env/native-SID labels cannot mint ordinary frontend intake',async()=>{
 const f=setup();await expect(f.capture({witness:{host:'codex',inputKind:'interactive',frontendInstanceId:'fake',nativeSessionId:'fake'},host:'codex',originalPrompt:'finish original task',projectDir:f.p.dir,env:f.env})).rejects.toThrow('witness');
 expect(fs.existsSync(f.ledger)).toBe(false);
});
it('ordinary callback canonically requires automatic scope preflight without a manifest command',async()=>{
 const f=setup(),t=terminal(),prompt='Inspect both original obligations and implement the authorized behavior.';
 const running=launchCodexManagedTerminal({binary:'/native',cwd:f.p.dir,env:f.env,...t,readConfig:async()=>config(f.p.dir),captureFrontendIntent:f.capture,
  managedPrompt:async options=>{try{const value=claimManagedFrontendIntent(options.frontendIntake,{id:'workflow-marker-fixture',harness:'codex',originalPrompt:prompt,
    permissions:options.permissions,allowedWorktrees:[f.p.dir],maxConcurrent:1,maxAttempts:6,deadline:options.deadline,nativeContext:options.nativeContext});
   expect(value.detail.scopeContractRequired).toEqual({schemaVersion:2,kind:'automatic-inventory-preflight'});
   expect(value.detail.ownerInventory).toBeUndefined();
  }finally{t.input.write('/exit\n');}return{sessionId:'11111111-1111-4111-8111-111111111111'};
  }});setImmediate(()=>t.input.write(prompt+'\n'));await running;
});
it('original total four cannot reserve required calls and never reaches planner or preflight',async()=>{
 const value=await preflightCase({maxAttempts:4});await expect(value.running).rejects.toThrow('Original attempt budget');expect(value.counts()).toEqual({plannerCalls:0,preflightCalls:0});
});
it('independently controlled reviewer rejects the omitted explicit second obligation before task effects',async()=>{
 const value=await preflightCase({prompt:'Implement P001 and preserve P002 as an original business obligation.',observe:async args=>{const observation=await preflightFixture(args),verdict=JSON.parse(observation.answer);
  verdict.passed=false;verdict.findings=['Controlled comparison: explicit P002 absent from extracted inventory'];return{...observation,answer:JSON.stringify(verdict)};}});
 await expect(value.running).rejects.toThrow('did not qualify');expect(value.counts()).toEqual({plannerCalls:1,preflightCalls:1});
});
for(const mutation of ['packet','inventory','tasks','same-session','incomplete','secret-verdict'])it('preflight '+mutation+' cannot qualify the original canonical definition',async()=>{
 const value=await preflightCase({observe:async args=>{const observation=await preflightFixture(args),verdict=JSON.parse(observation.answer);
  if(['packet','inventory','tasks'].includes(mutation))verdict[mutation+'Digest']='0'.repeat(64);
  if(mutation==='same-session')observation.sessionId='fixture-planner';if(mutation==='incomplete')observation.completed=false;
  if(mutation==='secret-verdict')verdict.extra='sk_test_123456789012345678901234567890';return{...observation,answer:JSON.stringify(verdict)};}});
 await expect(value.running).rejects.toThrow(/digest mismatch|separate read-only|privacy loss/);expect(value.counts().preflightCalls).toBe(1);
 expect(JSON.parse(fs.readFileSync(value.f.ledger)).managedTasks[0].definitionReceipt).toBeUndefined();
});
it('whole original payload secret is refused before preflight delivery',async()=>{
 const value=await preflightCase({prompt:'Implement the original behavior while preserving sk_test_123456789012345678901234567890'});
 await expect(value.running).rejects.toThrow(/privacy|redaction/);expect(value.counts().preflightCalls).toBe(0);
});
it('reserved unknown preflight survives failure and fresh recovery refuses an attempt reset',async()=>{
 const value=await preflightCase({observe:async()=>{throw Error('Controlled crash-before-preflight-completion');}});
 await expect(value.running).rejects.toThrow('crash-before');const pointer=JSON.parse(fs.readFileSync(value.f.ledger)).managedTasks[0];
 const {recoverManagedFrontendIntent}=await import('../../scripts/managed-frontend-intake.mjs');
 // The original intake reference, not the preparation event, restores authority/data.
 const restored=recoverManagedFrontendIntent({receipt:{namespace:'continuity-events',key:pointer.binding.userInstructionRef},projectDir:value.f.p.dir,env:value.f.env});
 expect(restored.state).toBe('blocked');expect(restored.preparationAttempts).toMatchObject({originalTotal:6,planner:1,preflight:1,state:'reserved-or-unknown'});
 expect(restored.blockers.join(' ')).toContain('attempt reset');
});
it('actual scoped checks and final review leave the second original obligation pending, not whole complete',async()=>{
 let outcome;const value=await preflightCase({prompt:'Implement P001 now; retain P002 pending.',pending:true,afterPlan:async(plan,f,decision)=>{
  const createAdapters=async({captureObservation})=>({codex:{id:'pending-fixture',readiness:async()=>({ready:true}),prepare:async({worker})=>({worker}),launch:async state=>{
   const packet=JSON.parse(state.worker.prompt.split('\n')[0]),review=state.worker.role==='reviewer';
   const answer=review?{passed:true,artifactDigest:packet.acceptance.artifactDigest,findings:[],evidence:['Controlled exact fixture artifacts'],criterionCoverage:[{taskId:'work',criterionId:'result',checkIds:plan.request.tasks[0].acceptanceCriteria[0].checkIds,passed:true,evidence:['Actual behavioral check']}],coverage:['entry','caller','consumer','config','error'].map(dimension=>({dimension,state:'not-applicable',evidence:['Mechanical fixture only']})),omissions:[]}:{outcome:'Controlled scoped fixture result',artifacts:[],decisions:[],risks:[]};
   state.observed={completed:true,model:state.worker.configuredModel,effort:state.worker.configuredEffort,sessionId:'fixture-'+state.worker.id,answer:JSON.stringify(answer)};captureObservation(state.worker,state.observed);return state;},observe:async state=>state.observed,
   interpret:state=>({workerId:state.worker.id,activity:state.worker.activity,role:state.worker.role,host:'codex',status:'succeeded',exitCategory:'success',provider:'openai',providerProvenance:'observed',configuredModel:state.worker.configuredModel,observedModel:state.observed.model,configuredEffort:state.worker.configuredEffort,observedEffort:state.observed.effort,sessionId:state.observed.sessionId,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),durationMs:0,transcriptRefs:[],failure:null,usage:null}),summarize:()=>({outcome:'Controlled fixture'}),cancel:async()=>({}),cleanup:async()=>({})}});
  outcome=await executeManagedWorkflow(plan.request,{env:f.env,recordReceipt:f.commit,route:async()=>decision,verifyDecision:()=>{},sampleCapacity:()=>({workers:1}),createAdapters,
   recallMemory:async args=>({outcome:'ok-empty',receipt:{binding:args.binding,observedAt:new Date().toISOString(),queryDigest:sha(args.prompt)}}),check:async checker=>{const {spawnSync}=await import('node:child_process');const result=spawnSync(checker.command,checker.args,{cwd:checker.cwd});return{passed:result.status===0,exitCode:result.status};}});
  const pointer=JSON.parse(fs.readFileSync(f.ledger)).managedTasks[0],current=readManagedContinuationTask(pointer,{projectDir:f.p.dir,host:'codex',frontendInstanceId:pointer.binding.frontendInstanceId,submissionSequence:1,deadlineAt:Date.now()+1900});
  expect(current.state).toBe('active');expect(current.receipt.status).toBe('cohort-complete');expect(current.receipt.remainingRequirements).toEqual(['P002']);
 }});await value.running;expect(outcome.status).toBe('unfinished');expect(outcome.remainingRequirements).toEqual(['P002']);
});
it('actual owner manifest callback freezes original IDs and fresh resume restores the same unqualified contract',async()=>{
 const f=setup(),decision={harness:'codex',provider:'openai',model:'fixture',effort:'medium'};
 fs.writeFileSync(path.join(f.p.dir,'package.json'),JSON.stringify({scripts:{test:'node --test accepted.test.mjs'}}));
 fs.writeFileSync(path.join(f.p.dir,'accepted.test.mjs'),'import assert from "node:assert/strict";assert.equal(2+2,4);');
 const checkId=captureCheckerRegistry(f.p.dir).registry.find(check=>check.kind==='command').id;
 const inventory={schemaVersion:1,requirements:[{id:'P001',statement:'Preserve the exact owner inventory mapping for this scoped task',disposition:'in-scope',taskMappings:[{taskId:'inventory',criterionIds:['traceability'],checkIds:[checkId]}]},
  {id:'P002',statement:'Keep the second original rule pending without implementation',disposition:'pending',taskMappings:[]}]};
 const bytes=JSON.stringify(inventory);fs.writeFileSync(path.join(f.p.dir,'owner.json'),bytes);
 const prompt=`/scope-manifest owner.json ${sha(bytes)} -- Implement only P001`,recall=async args=>({outcome:'ok-empty',receipt:{binding:args.binding,observedAt:new Date().toISOString(),queryDigest:sha(args.prompt)}});
 let first,restored,plannerCalls=0;
 const run=async(value,recovery)=>{const t=terminal();const running=launchCodexManagedTerminal({binary:'/native',cwd:f.p.dir,env:f.env,...t,readConfig:async()=>config(f.p.dir),captureFrontendIntent:f.capture,
  managedPrompt:async options=>{const input={originalPrompt:options.originalPrompt,harness:'codex',projectRoot:f.p.dir,allowedWorktrees:[f.p.dir],nativeContext:options.nativeContext,permissions:options.permissions,contextRefs:[],deadline:options.deadline,maxAttempts:6,maxConcurrent:1};
   const plan=await planManagedTask(input,{frontendIntake:options.frontendIntake,env:f.env,recordRegistration:f.commit,route:async()=>decision,recallMemory:recall,sampleCapacity:()=>({workers:1,tier:'fixture'}),runPlanner:async()=>{plannerCalls++;return{completed:true,model:decision.model,effort:decision.effort,sessionId:'fixture-planner',answer:JSON.stringify({unresolvedObligations:[],tasks:[{id:'inventory',instructions:'Verify the exact predeclared fixture checker mapping',mode:'read',worktree:f.p.dir,paths:[],dependsOn:[],checkIds:[checkId],acceptanceCriteria:[{id:'traceability',assertion:'The existing behavioral checker proves this scoped mapping',checkIds:[checkId]}]}]})};}});
   if(recovery)restored=plan;else first=plan;
   const variants=[];
   for(const mutation of ['drop-both','drop-inventory','drop-contract','changed-contract','changed-state','drop-registration']){
    const copy=structuredClone(plan.request);
    if(['drop-both','drop-inventory'].includes(mutation))delete copy.continuationRegistration.ownerInventory;
    if(['drop-both','drop-contract'].includes(mutation))delete copy.scopeContract;
    if(mutation==='changed-contract')copy.scopeContract.inventory.requirements[1].statement='Substituted original owner obligation text';
    if(mutation==='changed-state'){copy.continuationRegistration.state='UNVERIFIED';delete copy.continuationRegistration.ownerInventory;delete copy.scopeContract;}
    if(mutation==='drop-registration'){delete copy.continuationRegistration;delete copy.scopeContract;}
    let adapters=0,receipts=0,rejection=null;
    try{await executeManagedWorkflow(copy,{env:f.env,createAdapters:async()=>{adapters++;throw Error('unexpected adapter');},recordReceipt:async()=>{receipts++;return{durable:true,agentDbCommitted:true};}});}catch(error){rejection=error.message;}
    variants.push({mutation,adapters,receipts,rejected:!!rejection});
   }
   expect(variants).toEqual(['drop-both','drop-inventory','drop-contract','changed-contract','changed-state','drop-registration'].map(mutation=>({mutation,adapters:0,receipts:0,rejected:true})));
   expect(plan.request.scopeContract.sourceReview.state).toBe('qualified');
   const unqualified=structuredClone(plan.request);delete unqualified.scopeContract.sourceReview.attestationRef;
   let effects=0;await expect(executeManagedWorkflow(unqualified,{env:f.env,createAdapters:async()=>{effects++;throw Error('unexpected effect');}})).rejects.toThrow(/Canonical definition|scope receipt/);expect(effects).toBe(0);
   t.input.write('/exit\n');return{sessionId:'11111111-1111-4111-8111-111111111111'};
  }});setImmediate(()=>t.input.write(value+'\n'));await running;};
 await run(prompt,false);const pointer=JSON.parse(fs.readFileSync(f.ledger)).managedTasks[0];
 expect(pointer.definitionReceipt).toBeDefined();expect(first.request.scopeContract.inventory.manifestText).toBe(bytes);
 expect(first.request.scopeContract.coverage.map(r=>[r.requirementId,r.remainingState])).toEqual([['P001','queued'],['P002','pending']]);
 await run('/resume-frontend '+pointer.binding.userInstructionRef,true);
 expect(restored.request.id).toBe(first.request.id);expect(restored.request.scopeContract).toEqual(first.request.scopeContract);expect(plannerCalls).toBe(1);
 expect(readManagedContinuationTask(JSON.parse(fs.readFileSync(f.ledger)).managedTasks[0],{projectDir:f.p.dir,host:'codex',frontendInstanceId:pointer.binding.frontendInstanceId,submissionSequence:1,deadlineAt:Date.now()+1900}).state).toBe('active');
});
it('actual ordinary question callback commits intent and frontend-owned task before planner without native SID',async()=>{
 const f=setup(),t=terminal();fs.writeFileSync(path.join(f.p.dir,'package.json'),JSON.stringify({scripts:{test:'node --test accepted.test.mjs'}}));fs.writeFileSync(path.join(f.p.dir,'accepted.test.mjs'),'import assert from "node:assert/strict";assert.equal(2+2,4);');
 const prompt='Finish the supplied original acceptance task.',decision={harness:'codex',provider:'openai',model:'fixture',effort:'medium'};let received,plan;
 const recall=async args=>({outcome:'ok-empty',receipt:{binding:args.binding,observedAt:new Date().toISOString(),queryDigest:sha(args.prompt)}});
 const checkId=captureCheckerRegistry(f.p.dir).registry.find(check=>check.kind==='command').id;
 const running=launchCodexManagedTerminal({binary:'/native',cwd:f.p.dir,env:f.env,...t,readConfig:async()=>config(f.p.dir),captureFrontendIntent:f.capture,
  managedPrompt:async options=>{received=options;expect(options.inputKind).toBe('interactive');expect(options.nativeContext.sessionId).toBeUndefined();
   const input={originalPrompt:options.originalPrompt,harness:'codex',projectRoot:f.p.dir,allowedWorktrees:[f.p.dir],nativeContext:options.nativeContext,permissions:options.permissions,contextRefs:[],deadline:options.deadline,maxAttempts:6,maxConcurrent:1};
   await expect(planManagedTask(input,{frontendIntake:JSON.parse(JSON.stringify(options.frontendIntake))})).rejects.toThrow(/callback capability|Actual frontend capability/);
   plan=await planManagedTask(input,{frontendIntake:options.frontendIntake,env:f.env,recordRegistration:f.commit,route:async()=>decision,recallMemory:recall,sampleCapacity:()=>({workers:1,tier:'fixture'}),
    runPlanner:async()=>{const pointer=JSON.parse(fs.readFileSync(f.ledger)).managedTasks[0];expect(pointer.binding.nativeSessionId).toBeUndefined();
     expect(readManagedContinuationTask(pointer,{projectDir:f.p.dir,host:'codex',frontendInstanceId:pointer.binding.frontendInstanceId,submissionSequence:1,deadlineAt:Date.now()+1900}).state).toBe('active');
     return{completed:true,model:decision.model,effort:decision.effort,sessionId:'observed-planner-only',answer:JSON.stringify({unresolvedObligations:[],tasks:[{id:'work',instructions:'Run the exact predeclared fixture checker',mode:'read',worktree:f.p.dir,paths:[],dependsOn:[],checkIds:[checkId],acceptanceCriteria:[{id:'requested-result',assertion:'The existing fixture checker proves the original required result',checkIds:[checkId]}]}]})};}});
   for(const changed of [{maxConcurrent:6},{allowedWorktrees:[]},{permissions:{...input.permissions,network:true}},{nativeContext:{sessionId:'fake',resume:true}}])
    expect(()=>claimManagedFrontendIntent(options.frontendIntake,{...input,...changed,id:plan.request.id})).toThrow('escalation');
   await expect(planManagedTask(input,{frontendIntake:options.frontendIntake})).rejects.toThrow(/callback capability|Actual frontend capability/);
   const createAdapters=async({captureObservation})=>({codex:{id:'frontend-fixture',readiness:async()=>({ready:true}),prepare:async({worker})=>({worker}),
    launch:async state=>{const packet=JSON.parse(state.worker.prompt.split('\n')[0]);
     const answer=state.worker.role==='reviewer'?{passed:true,artifactDigest:packet.acceptance.artifactDigest,findings:[],evidence:['Original fixture scope inspected'],criterionCoverage:[{taskId:'work',criterionId:'requested-result',checkIds:[checkId],passed:true,evidence:['Actual registered test']}],coverage:['entry','caller','consumer','config','error'].map(dimension=>({dimension,state:'not-applicable',evidence:['Mechanical fixture only']})),omissions:[]}:{outcome:'Actual fixture checker result',artifacts:[],decisions:[],risks:[]};
     state.observed={completed:true,model:state.worker.configuredModel,effort:state.worker.configuredEffort,sessionId:'fixture-'+state.worker.id,answer:JSON.stringify(answer)};captureObservation(state.worker,state.observed);return state;},observe:async state=>state.observed,
    interpret:state=>({workerId:state.worker.id,activity:state.worker.activity,role:state.worker.role,host:'codex',status:'succeeded',exitCategory:'success',provider:'openai',providerProvenance:'observed',configuredModel:state.worker.configuredModel,observedModel:state.observed.model,configuredEffort:state.worker.configuredEffort,observedEffort:state.observed.effort,sessionId:state.observed.sessionId,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),durationMs:0,transcriptRefs:[],failure:null,usage:null}),summarize:()=>({outcome:'Fixture'}),cancel:async()=>({}),cleanup:async()=>({})}});
   const result=await executeManagedWorkflow(plan.request,{env:f.env,recordReceipt:f.commit,route:async()=>decision,recallMemory:recall,sampleCapacity:()=>({workers:1,tier:'fixture'}),createAdapters,verifyDecision:()=>{},
    check:async checker=>{const {spawnSync}=await import('node:child_process');const value=spawnSync(checker.command,checker.args,{cwd:checker.cwd});return{passed:value.status===0,exitCode:value.status};}});
   expect(result.status).toBe('complete');
   t.input.write('/exit\n');return{sessionId:'11111111-1111-4111-8111-111111111111'};
  }});
 setImmediate(()=>t.input.write(prompt+'\n'));await running;expect(received.originalPrompt).toBe(prompt);expect(plan.request.continuationRegistration.state).toBe('VERIFIED_MANAGED_FRONTEND');
 const pointer=JSON.parse(fs.readFileSync(f.ledger)).managedTasks[0];expect(pointer.definitionReceipt).toBeDefined();expect(pointer.binding.nativeSessionId).toBeUndefined();
 expect(readManagedContinuationTask(pointer,{projectDir:f.p.dir,host:'codex',frontendInstanceId:pointer.binding.frontendInstanceId,submissionSequence:1,deadlineAt:Date.now()+1900}).state).toBe('complete');
});
it('fresh ordinary resume callback restores the same frozen JS-writer plan and dispatches its exact syntax and behavioral checks',async()=>{
 const f=setup(),prompt='Implement the exact existing module acceptance task.',decision={harness:'codex',provider:'openai',model:'fixture',effort:'medium'};
 fs.writeFileSync(path.join(f.p.dir,'package.json'),JSON.stringify({scripts:{test:'node --test accepted.test.mjs'}}));
 fs.writeFileSync(path.join(f.p.dir,'module.mjs'),'export const value=1;');
 fs.writeFileSync(path.join(f.p.dir,'accepted.test.mjs'),'import assert from "node:assert/strict";import {value} from "./module.mjs";assert.equal(value,2);');
 const checkId=captureCheckerRegistry(f.p.dir).registry.find(check=>check.kind==='command').id;
 const recall=async args=>({outcome:'ok-empty',receipt:{binding:args.binding,observedAt:new Date().toISOString(),queryDigest:sha(args.prompt)}});
 const input=options=>({originalPrompt:options.originalPrompt,harness:'codex',projectRoot:f.p.dir,allowedWorktrees:options.allowedWorktrees??[f.p.dir],nativeContext:options.nativeContext,
  permissions:options.permissions,contextRefs:[],deadline:options.deadline,maxAttempts:options.maxAttempts??6,maxConcurrent:options.maxConcurrent??1});
 let original,resumed,result;
 const first=terminal(),initial=launchCodexManagedTerminal({binary:'/native',cwd:f.p.dir,env:f.env,...first,readConfig:async()=>config(f.p.dir),captureFrontendIntent:f.capture,
  managedPrompt:async options=>{original=await planManagedTask({...input(options),deadline:Date.now()+60000},{frontendIntake:options.frontendIntake,env:f.env,recordRegistration:f.commit,
   route:async()=>decision,recallMemory:recall,sampleCapacity:()=>({workers:1}),runPlanner:async()=>({completed:true,model:decision.model,effort:decision.effort,sessionId:'planner-fixture',
    answer:JSON.stringify({unresolvedObligations:[],tasks:[{id:'work',instructions:'Change module value to two',mode:'write',worktree:f.p.dir,paths:['module.mjs'],dependsOn:[],checkIds:[checkId],
     acceptanceCriteria:[{id:'value-is-two',assertion:'The real module exports value two',checkIds:[checkId]}]}]})})});throw Error('defined but never dispatched fixture');}});
 setImmediate(()=>first.input.write(prompt+'\n'));await expect(initial).rejects.toThrow('defined but never dispatched fixture');
 const pointer=JSON.parse(fs.readFileSync(f.ledger)).managedTasks[0],second=terminal(),checked=[];
 const running=launchCodexManagedTerminal({binary:'/native',cwd:f.p.dir,env:f.env,...second,readConfig:async()=>config(f.p.dir),captureFrontendIntent:f.capture,
  managedPrompt:async options=>{expect(options.originalPrompt).toBe(prompt);expect(options.deadline).toBe(original.request.deadline);expect(options.maxConcurrent).toBe(1);
   resumed=await planManagedTask(input(options),{frontendIntake:options.frontendIntake,env:f.env,recordRegistration:f.commit,recallMemory:recall,route:async()=>{throw Error('Recovered definition must not replan');}});
   expect(resumed.request.id).toBe(original.request.id);expect(resumed.request.checkerRegistry).toEqual(original.request.checkerRegistry);
   expect(original.request.scopeContract.sourceReview.attempts).toEqual({originalTotal:6,planner:1,preflight:1,primaryReserved:1,controllerRemaining:3});
   expect(resumed.request.maxAttempts).toBe(3);expect(resumed.request.scopeContract.sourceReview).toEqual(original.request.scopeContract.sourceReview);
   expect(resumed.request.memoryRecall.receipt.binding).toMatchObject({workflowId:original.request.id,phase:'planner-recovery',requestDigest:sha(prompt)});
   const createAdapters=async({captureObservation})=>({codex:{id:'resume-fixture',readiness:async()=>({ready:true}),prepare:async({worker})=>({worker}),launch:async state=>{
    const packet=JSON.parse(state.worker.prompt.split('\n')[0]);if(state.worker.role!=='reviewer')fs.writeFileSync(path.join(f.p.dir,'module.mjs'),'export const value=2;');
    const answer=state.worker.role==='reviewer'?{passed:true,artifactDigest:packet.acceptance.artifactDigest,findings:[],evidence:['Mechanical resume fixture'],
     criterionCoverage:[{taskId:'work',criterionId:'value-is-two',checkIds:[checkId],passed:true,evidence:['Actual registered checker']}],
     coverage:['entry','caller','consumer','config','error'].map(dimension=>({dimension,state:'not-applicable',evidence:['Mechanical fixture only']})),omissions:[]}
     :{outcome:'Fixture module actually changed to two',artifacts:[],decisions:[],risks:[]};
    state.observed={completed:true,model:state.worker.configuredModel,effort:state.worker.configuredEffort,sessionId:'fixture-'+state.worker.id,answer:JSON.stringify(answer)};captureObservation(state.worker,state.observed);return state;},
    observe:async state=>state.observed,interpret:state=>({workerId:state.worker.id,activity:state.worker.activity,role:state.worker.role,host:'codex',status:'succeeded',exitCategory:'success',provider:'openai',providerProvenance:'configured',
     configuredModel:state.worker.configuredModel,observedModel:state.observed.model,configuredEffort:state.worker.configuredEffort,observedEffort:state.observed.effort,sessionId:state.observed.sessionId,
     startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),durationMs:0,transcriptRefs:[],failure:null,usage:null}),summarize:()=>({outcome:'Mechanical fixture'}),cancel:async()=>({}),cleanup:async()=>({})}});
   result=await executeManagedWorkflow(resumed.request,{env:f.env,recordReceipt:f.commit,route:async()=>decision,recallMemory:recall,sampleCapacity:()=>({workers:1}),createAdapters,verifyDecision:()=>{},
    check:async checker=>{const {spawnSync}=await import('node:child_process');checked.push(checker.id);const value=spawnSync(checker.command,checker.args,{cwd:checker.cwd});return{passed:value.status===0,exitCode:value.status};}});
   expect(result.status).toBe('complete');expect(checked).toContain(checkId);expect(checked.some(id=>id.startsWith('syntax-'))).toBe(true);
   const closed=JSON.parse(fs.readFileSync(f.ledger)).managedTasks.find(task=>task.binding.workflowId===original.request.id);
   expect(readManagedContinuationTask(closed,{projectDir:f.p.dir,host:'codex',frontendInstanceId:closed.binding.frontendInstanceId,
     submissionSequence:closed.binding.submissionSequence,deadlineAt:Date.now()+1900}).state).toBe('complete');
   throw Error('completed fixture without native parent association');}});
 setImmediate(()=>second.input.write('/resume-frontend '+pointer.binding.userInstructionRef+'\n'));await expect(running).rejects.toThrow('completed fixture without native parent association');
 expect(result.workflowId).toBe(original.request.id);expect(fs.readFileSync(path.join(f.p.dir,'module.mjs'),'utf8')).toBe('export const value=2;');
});

it('permission revocation at actual submit narrows scope; argv never receives an interactive witness',async()=>{
 const f=setup(),t=terminal();let reads=0;const observed=[];
 const running=launchCodexManagedTerminal({binary:'/native',args:['argv input'],cwd:f.p.dir,env:f.env,...t,captureFrontendIntent:f.capture,readConfig:async()=>config(f.p.dir,++reads<3),
  managedPrompt:async options=>{observed.push(options);if(observed.length===1)t.input.write('ordinary followup\n');else t.input.write('/exit\n');return{sessionId:'11111111-1111-4111-8111-111111111111'};}});
 await running;expect(observed[0].frontendIntake).toBeUndefined();expect(observed[0].inputKind).toBe('argv');expect(observed[1].permissions.write).toBe(false);expect(observed[1].frontendIntake.status).toBe('verified');
});

it('actual frontend callback rejects a partial status reply and retains its unfinished canonical task',async()=>{
 const f=setup(),t=terminal(),decision={harness:'codex',provider:'openai',model:'fixture',effort:'medium'};let parentCalls=0;
 fs.writeFileSync(path.join(f.p.dir,'package.json'),JSON.stringify({scripts:{test:'node --test accepted.test.mjs'}}));fs.writeFileSync(path.join(f.p.dir,'accepted.test.mjs'),'import assert from "node:assert/strict";assert.equal(1,1);');
 const checkId=captureCheckerRegistry(f.p.dir).registry.find(value=>value.kind==='command').id;
 const recall=async args=>({outcome:'ok-empty',receipt:{binding:args.binding,observedAt:new Date().toISOString(),queryDigest:sha(args.prompt)}});
 const pending=launchCodexManagedTerminal({binary:'/native',cwd:f.p.dir,env:f.env,...t,readConfig:async()=>config(f.p.dir),captureFrontendIntent:f.capture,
  managedPrompt:options=>runManagedPrompt({...options,taskFacts:{taskType:'coding',scope:'substantial'},recallFn:async()=>({block:''}),
   primaryTurn:async()=>{parentCalls++;throw Error('must not render partial as complete');},
   planTask:(input,privateOptions)=>planManagedTask(input,{...privateOptions,env:f.env,recordRegistration:f.commit,route:async()=>decision,recallMemory:recall,sampleCapacity:()=>({workers:1,tier:'fixture'}),
    runPlanner:async()=>({completed:true,model:decision.model,effort:decision.effort,sessionId:'actual-planner-fixture',answer:JSON.stringify({unresolvedObligations:[],tasks:[{id:'work',instructions:'Finish the requested bounded task',mode:'read',worktree:f.p.dir,paths:[],dependsOn:[],checkIds:[checkId],acceptanceCriteria:[{id:'requested-result',assertion:'Existing registered test proves the requested task result',checkIds:[checkId]}]}]})})}),
   executeWorkflow:async()=>({status:'running',answer:'Only a status reply; task remains active'})})});
 setImmediate(()=>t.input.write('Implement the original bounded feature and verify its results.\n'));
 await expect(pending).rejects.toThrow('exact request completion');expect(parentCalls).toBe(0);
 const pointer=JSON.parse(fs.readFileSync(f.ledger)).managedTasks[0];expect(pointer.binding.nativeSessionId).toBeUndefined();
 expect(readManagedContinuationTask(pointer,{projectDir:f.p.dir,host:'codex',frontendInstanceId:pointer.binding.frontendInstanceId,submissionSequence:1,deadlineAt:Date.now()+1900}).state).toBe('active');
});
