import {it,expect,afterEach} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';
import {adoptedProject,fakeRuflo,cleanup} from '../helpers/continuity-fixture.mjs';
afterEach(cleanup);
const repo=path.resolve(import.meta.dirname,'../..');
for(const crashPhase of ['before-planner','during-planner','during-preflight'])it('kill '+crashPhase+' then fresh-process recovery preserves intent and consumed scope without old WeakMap or SID',async()=>{
 const p=adoptedProject(),ruflo=fakeRuflo(),ledger=path.join(p.home,'restart-ledger.json'),childFile=path.join(p.home,'crash.mjs');
 const text='Implement the original bounded task.\nPreserve every stated criterion and scope.\n'+('Exact original detail must survive. '.repeat(50));
 const script=`import fs from 'node:fs';import {PassThrough,Writable} from 'node:stream';import {EventEmitter} from 'node:events';
 import {launchCodexManagedTerminal} from ${JSON.stringify('file://'+repo+'/scripts/codex-managed-terminal.mjs')};
 import {recordManagedFrontendIntent} from ${JSON.stringify('file://'+repo+'/scripts/managed-frontend-intake.mjs')};
 import {planManagedTask,commitManagedReceipt,captureCheckerRegistry} from ${JSON.stringify('file://'+repo+'/scripts/model-managed-workflow-service.mjs')};
 import crypto from 'node:crypto';
 import {ContinuityJournal,drain} from ${JSON.stringify('file://'+repo+'/plugin/scripts/continuity-journal.mjs')};
 const dir=${JSON.stringify(p.dir)},ledger=${JSON.stringify(ledger)},ruflo=${JSON.stringify(ruflo.bin)};
 const phase=${JSON.stringify(crashPhase)},original=${JSON.stringify(text)},sha=x=>crypto.createHash('sha256').update(x).digest('hex');
 fs.writeFileSync(dir+'/package.json',JSON.stringify({scripts:{test:'node --test accepted.test.mjs'}}));fs.writeFileSync(dir+'/accepted.test.mjs','import assert from "node:assert/strict";assert.equal(1,1);');
 const checkpoint=async()=>{const pointer=JSON.parse(fs.readFileSync(ledger)).managedTasks[0];console.log(JSON.stringify({ready:true,receipt:pointer.registrationReceipt,intake:pointer.binding.userInstructionRef,goal:pointer.binding.workflowId}));await new Promise(()=>{});};
 class Journal extends ContinuityJournal{constructor(options){super({...options,env:process.env,home:process.env.HOME});}}
 const draining=(journal,options)=>drain(journal,{...options,ruflo,backoff:[]});
 const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};const output=new Writable({write(_x,_e,done){done();}});output.isTTY=true;
 const hold=setInterval(()=>{},1000);setImmediate(()=>input.write(${JSON.stringify('\x1b[200~'+text+'\x1b[201~\n')}));
 await launchCodexManagedTerminal({binary:'/native',cwd:dir,input,output,diagnostics:new PassThrough(),signalSource:new EventEmitter(),env:process.env,
 readConfig:async()=>({config:{approval_policy:'never',sandbox_mode:'workspace-write',projects:{[dir]:{trust_level:'trusted'}}},layers:[]}),
 captureFrontendIntent:args=>recordManagedFrontendIntent({...args,Journal,drainJournal:draining}),
 managedPrompt:async options=>planManagedTask({originalPrompt:options.originalPrompt,harness:'codex',nativeContext:options.nativeContext,permissions:options.permissions,
 projectRoot:dir,allowedWorktrees:[dir],contextRefs:[],deadline:options.deadline,maxAttempts:6,maxConcurrent:1},{frontendIntake:options.frontendIntake,env:process.env,
 recordRegistration:(request,receipt)=>commitManagedReceipt(request,receipt,{Journal,drainJournal:draining}),route:async()=>{if(phase==='before-planner')await checkpoint();return{harness:'codex',model:'fixture',effort:'medium'};},sampleCapacity:()=>({workers:1}),recallMemory:async args=>({outcome:'ok-empty',receipt:{binding:args.binding,observedAt:new Date().toISOString(),queryDigest:sha(args.prompt)}}),
 runPlanner:async()=>{if(phase==='during-planner')await checkpoint();const check=captureCheckerRegistry(dir).registry.find(c=>c.kind==='command').id;return{completed:true,model:'fixture',effort:'medium',sessionId:'fixture-planner',answer:JSON.stringify({unresolvedObligations:[],tasks:[{id:'work',instructions:'Verify the original scoped behavioral fixture',mode:'read',worktree:dir,paths:[],dependsOn:[],checkIds:[check],acceptanceCriteria:[{id:'criterion',assertion:'Actual behavioral checker proves the original fixture result',checkIds:[check]}]}],
 obligations:[{id:'original-1',statement:'Retain complete original intent with exact behavioral mapping',disposition:'in-scope',originalLocator:{start:0,end:original.length,quote:original},taskMappings:[{taskId:'work',criterionIds:['criterion'],checkIds:[check]}]}],
 sourceBoundaries:['entry','caller','consumer','config','native-host','state-transition','crash-recovery','error'].map((dimension,i)=>({id:'boundary-'+i,dimension,requirementIds:['original-1'],state:'read',sourceRef:{path:dir+'/accepted.test.mjs',digest:sha(fs.readFileSync(dir+'/accepted.test.mjs'))},ranges:[{startLine:1,endLine:1}]}))})};},runPreflight:checkpoint})});`;
 fs.writeFileSync(childFile,script);
 const env={...p.env,RUVNET_WORK_LEDGER:ledger};const child=spawn(process.execPath,[childFile],{env,stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',x=>errors+=x);let buf='';
 const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('No exact preplanner checkpoint: '+errors));},15000);
  child.stdout.on('data',x=>{buf+=x;for(const line of buf.split('\n')){try{const value=JSON.parse(line);if(value.ready){clearTimeout(timer);resolve(value);return;}}catch{}}});
  child.on('exit',code=>{clearTimeout(timer);reject(Error('Child exited before checkpoint '+code+': '+errors));});});
 const ended=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await ended;
 const read=`import {recoverManagedFrontendIntent} from ${JSON.stringify('file://'+repo+'/scripts/managed-frontend-intake.mjs')};
 import {withProgressionReader} from ${JSON.stringify('file://'+repo+'/plugin/scripts/project-progression-reader.mjs')};
 const receipt={namespace:'continuity-events',key:${JSON.stringify(ready.intake)}};
 const value=JSON.parse(withProgressionReader(${JSON.stringify(path.join(p.dir,'.swarm/memory.db'))},r=>r.readContent(receipt.namespace,receipt.key)).value).detail;
 const scope={...value.scopeLimits,permissions:value.permissions};
 console.log(JSON.stringify({restored:recoverManagedFrontendIntent({receipt,projectDir:${JSON.stringify(p.dir)},currentScope:scope}),
 widened:recoverManagedFrontendIntent({receipt,projectDir:${JSON.stringify(p.dir)},currentScope:{...scope,maxConcurrent:scope.maxConcurrent+1}}),
 revoked:recoverManagedFrontendIntent({receipt,projectDir:${JSON.stringify(p.dir)},currentScope:{...scope,permissions:{apiBilling:false,write:false}}}),
 unavailable:recoverManagedFrontendIntent({receipt,projectDir:${JSON.stringify(p.dir)}})}));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',read],{env,encoding:'utf8'});expect(result.status,result.stderr).toBe(0);
 const recovery=JSON.parse(result.stdout);expect(recovery.restored.originalRequest).toBe(text);expect(recovery.restored.goalId).toBe(ready.goal);
 expect(recovery.restored.state).toBe(crashPhase==='before-planner'?'recovered-unfinished':'blocked');expect(recovery.restored.taskState).toBe('active');expect(recovery.restored.canExecute).toBe(false);
 if(crashPhase!=='before-planner'){expect(recovery.restored.preparationAttempts).toMatchObject({originalTotal:6,planner:1,preflight:crashPhase==='during-planner'?0:1,state:'reserved-or-unknown'});expect(recovery.restored.blockers.join(' ')).toContain('attempt reset');}
 expect(recovery.widened.state).toBe('blocked');expect(recovery.unavailable.state).toBe('blocked');expect(recovery.revoked.state).toBe('blocked');
});

it('redaction loss is explicit and cannot pretend full original intent reconstruction',async()=>{
 const p=adoptedProject(),ruflo=fakeRuflo();
 const {ContinuityJournal,drain}=await import('../../plugin/scripts/continuity-journal.mjs');
 const {recoverManagedFrontendIntent}=await import('../../scripts/managed-frontend-intake.mjs');
 const {continuationProjectIdentity}=await import('../../plugin/scripts/continuation-objective.mjs');
 const {redactText}=await import('../../plugin/scripts/continuity-events.mjs');
 const crypto=await import('node:crypto'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
 const raw='Complete original task using api_key=secret-private-fixture-key-value.';
 const text=redactText(raw);expect(text).not.toBe(raw);
 const identity=continuationProjectIdentity(p.dir),journal=new ContinuityJournal({projectDir:p.dir,projectRoot:p.dir,env:p.env,home:p.home});
 const detail={kind:'managed-frontend-intent',goalId:'workflow-original',host:'codex',projectId:identity.projectId,worktreeId:identity.worktreeId,
  userInstructionDigest:sha(raw),permissions:{apiBilling:false,write:false},scopeLimits:{allowedWorktrees:[p.dir],maxConcurrent:1,maxAttempts:4,deadline:Date.now()+60000},
  originalRequest:{text,originalDigest:sha(raw),storedDigest:sha(text),completeWithinBound:true,redactionLoss:true}};
 const [row]=journal.record([{schema:'continuity-event-v1',kind:'decision',id:'1234567890abcdef',at:new Date().toISOString(),source:'managedFrontendPromptSubmit',authoritative:false,summary:'Negative loss fixture',detail}]);
 drain(journal,{ruflo:ruflo.bin,budgetMs:2000,backoff:[]});
 const view=recoverManagedFrontendIntent({receipt:{namespace:'continuity-events',key:row.key},projectDir:p.dir,env:p.env,currentScope:{...detail.scopeLimits,permissions:detail.permissions}});
 expect(view.state).toBe('blocked');expect(view.redactionLoss).toBe(true);expect(view.originalRequest).not.toContain('secret-private-fixture-key-value');
 expect(view.blockers.join(' ')).toContain('cannot be fully reconstructed');expect(view.canExecute).toBe(false);
});
