// Ordinary controlled-frontend submissions are provenance, never native identity or effect authority.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ContinuityJournal,drain} from '../plugin/scripts/continuity-journal.mjs';
import {CONTINUITY_NAMESPACE,EVENT_SCHEMA,redactText} from '../plugin/scripts/continuity-events.mjs';
import {continuationLedgerPath,readContinuationLedger,readManagedContinuationTask} from '../plugin/scripts/continuation-objective.mjs';
import {resolveProjectStore} from '../plugin/scripts/project-store-resolver.mjs';
import {withProgressionReader} from '../plugin/scripts/project-progression-reader.mjs';
import {rufloInvocation} from '../plugin/scripts/ruflo-bin.mjs';
import {rufloRunDir} from '../plugin/scripts/project-progression-store.mjs';
import {captureOwnerInventory} from '../plugin/scripts/scope-contract.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const receipts=new WeakMap();
const requireValue=(value,message)=>{if(!value)throw Error(message);};

// The only mint is the private ordinary question callback in the named launcher. Reader exports
// cannot mint a witness; JSON/env/native-session labels have no WeakMap identity.
export async function recordManagedFrontendIntent({witness,host,originalPrompt,projectDir,env=process.env,deadlineAt=Date.now()+5000,
  signal,Journal=ContinuityJournal,drainJournal=drain}={}){
  requireValue(['codex','claude'].includes(host),'Controlled frontend host required');
  const reader=await import(host==='codex'?'./codex-managed-terminal.mjs':'./claude-controlled-terminal.mjs');
  const submitted=reader.readManagedFrontendWitness(witness);
  requireValue(submitted?.inputKind==='interactive'&&submitted.host===host&&submitted.originalPromptDigest===sha(originalPrompt)
    &&submitted.projectDir===fs.realpathSync(projectDir),'Actual ordinary frontend submission witness required');
  requireValue(!signal?.aborted&&Date.now()<deadlineAt,'Frontend intake cancelled or expired');
  const resolved=resolveProjectStore({projectDir,deadlineAt});
  requireValue(Buffer.byteLength(originalPrompt,'utf8')<=120000,'Bounded complete frontend request required; never truncate intent');
  const storedText=redactText(originalPrompt);
  const ownerInventory=captureOwnerInventory(originalPrompt,projectDir,{deadlineAt,signal});
  const detail={goalId:`workflow-frontend-${sha(`${submitted.frontendInstanceId}:${submitted.submissionSequence}`).slice(0,32)}`,
    originalRequest:{text:storedText,originalDigest:sha(originalPrompt),storedDigest:sha(storedText),redactionLoss:storedText!==originalPrompt,completeWithinBound:true},schemaVersion:1,kind:'managed-frontend-intent',status:'recorded',origin:{kind:'managed-frontend'},inputKind:'interactive',
    frontendInstanceId:submitted.frontendInstanceId,submissionSequence:submitted.submissionSequence,host,
    projectId:resolved.projectIdentity.id,worktreeId:sha(resolved.checkoutRoot),userInstructionDigest:sha(originalPrompt),
    permissions:submitted.permissions,scopeLimits:submitted.scopeLimits,parentPermissionRef:submitted.parentPermissionRef,sourceIdentity:submitted.sourceIdentity,
    scopeContractRequired:{schemaVersion:2,kind:'automatic-inventory-preflight'},
    ...(ownerInventory?{ownerInventory}: {})};
  const journal=new Journal({projectDir,projectRoot:resolved.projectRoot,env,deadlineAt,signal});
  const [row]=journal.record([{schema:EVENT_SCHEMA,kind:'decision',id:sha(JSON.stringify(detail)).slice(0,16),at:new Date().toISOString(),
    source:'managedFrontendPromptSubmit',authoritative:false,summary:'Controlled ordinary frontend intent; not native identity or new permission',detail}]);
  requireValue(row,'Canonical frontend intent enqueue unavailable');
  const target=new Proxy(journal,{get(object,key){if(key==='pending')return()=>object.pending().filter(item=>item.key===row.key);
    const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
  drainJournal(target,{budgetMs:Math.max(0,deadlineAt-Date.now()),backoff:[],store:({ruflo,db,key,value})=>{
    requireValue(!signal?.aborted&&Date.now()<deadlineAt,'Frontend intake cancelled or expired');
    const cwd=rufloRunDir(db);try{const invocation=rufloInvocation(ruflo,['memory','store','--key',key,'--value',value,
      '--namespace',CONTINUITY_NAMESPACE,'--no-upsert','--provenance','system_observation','--path',db]);
      const result=spawnSync(invocation.executable,invocation.args,{cwd,encoding:'utf8',timeout:Math.max(1,Math.floor(deadlineAt-Date.now())),killSignal:'SIGKILL',
        env:{...env,RUFLO_DAEMON_AUTOSTART:'0'}});return{status:result.status??1,output:result.stderr||''};
    }finally{fs.rmSync(cwd,{recursive:true,force:true});}},readBack:({db,key})=>{
      const value=withProgressionReader(db,reader=>reader.readContent(CONTINUITY_NAMESPACE,key),{deadlineAt,signal});
      return{key,content:value.ok?value.value:null,readPath:'canonical frontend exact readback'};}});
  const exact=withProgressionReader(resolved.canonicalAgentDbPath,reader=>reader.readContent(CONTINUITY_NAMESPACE,row.key),{deadlineAt,signal});
  requireValue(!signal?.aborted&&Date.now()<deadlineAt&&exact.ok&&exact.value===JSON.stringify(row.event),'Frontend intent exact canonical commit unavailable; queued is not intake');
  const receipt=Object.freeze({namespace:CONTINUITY_NAMESPACE,key:row.key,valueSha256:sha(exact.value)});
  const capability=Object.freeze({status:'verified',origin:{kind:'managed-frontend'},receipt});
  receipts.set(capability,{detail,receipt});
  const resume=/^\/resume-frontend (cevt-\d{8}T\d{9}Z-[a-z-]+-[a-f0-9]{16})$/.exec(originalPrompt.trim());
  if(resume){
    const currentScope={...detail.scopeLimits,permissions:detail.permissions};
    const recovered=recoverManagedFrontendIntent({receipt:{namespace:CONTINUITY_NAMESPACE,key:resume[1]},projectDir,env,currentScope,deadlineAt});
    requireValue(recovered.state==='recovered-unfinished','Frontend recovery BLOCKED: '+recovered.blockers.join('; '));
    const prior=withProgressionReader(resolved.canonicalAgentDbPath,reader=>reader.readContent(CONTINUITY_NAMESPACE,resume[1]),{deadlineAt});
    const old=JSON.parse(prior.value).detail;
    const adopted={...old,permissions:recovered.effectiveScope.permissions,scopeLimits:{...recovered.effectiveScope,parentContextDigest:detail.scopeLimits.parentContextDigest}};
    receipts.set(capability,{detail:adopted,receipt:recovered.originalReceipt,recovery:recovered,freshSubmissionReceipt:receipt});
  }
  return capability;
}

export function claimManagedFrontendIntent(capability,request){
  const value=receipts.get(capability);
  requireValue(value&&(!value.workflowId||value.workflowId===request.id),'Managed frontend provenance requires its actual callback capability, not caller JSON');
  requireValue(value.detail.host===(request.harness==='claude-code'?'claude':request.harness)
    &&value.detail.userInstructionDigest===sha(request.originalPrompt)&&request.permissions.apiBilling===false
    &&Object.keys(request.permissions).every(key=>['apiBilling','write'].includes(key))
    &&(!request.permissions.write||value.detail.permissions.write===true)
    &&JSON.stringify(request.allowedWorktrees)===JSON.stringify(value.detail.scopeLimits.allowedWorktrees)
    &&request.maxConcurrent<=value.detail.scopeLimits.maxConcurrent&&request.maxAttempts<=value.detail.scopeLimits.maxAttempts
    &&request.deadline<=value.detail.scopeLimits.deadline
    &&sha(JSON.stringify(request.nativeContext))===value.detail.scopeLimits.parentContextDigest,'Frontend permission or original instruction changed; escalation refused');
  value.workflowId=request.id;return structuredClone(value);
}


export function managedFrontendGoalId(capability){const value=receipts.get(capability);requireValue(value&&!value.planningClaimed,'Actual frontend capability required; repeated planning from the same submission is refused');value.planningClaimed=true;return value.detail.goalId;}
export function managedFrontendOriginalRequest(capability){const value=receipts.get(capability);requireValue(value,'Actual frontend capability required');return value.detail.originalRequest.text;}
export function managedFrontendRecoveryState(capability){return receipts.get(capability)?.recovery??null;}

/** Readonly recovery is canonical data, not old-process capability or new permission. */
export function recoverManagedFrontendIntent({receipt,projectDir,env=process.env,currentScope,deadlineAt=Date.now()+1900}={}){
 const resolved=resolveProjectStore({projectDir,deadlineAt});
 requireValue(receipt?.namespace===CONTINUITY_NAMESPACE&&typeof receipt.key==='string','Exact canonical frontend reference required');
 const row=withProgressionReader(resolved.canonicalAgentDbPath,reader=>reader.readContent(CONTINUITY_NAMESPACE,receipt.key),{deadlineAt});
 requireValue(row.ok&&typeof row.value==='string'&&(!receipt.valueSha256||sha(row.value)===receipt.valueSha256),'Frontend recovery canonical bytes unavailable or changed');
 const event=JSON.parse(row.value),detail=event.detail;
 requireValue(event.kind==='decision'&&event.source==='managedFrontendPromptSubmit'&&event.authoritative===false
   &&detail?.kind==='managed-frontend-intent'&&detail.projectId===resolved.projectIdentity.id&&detail.worktreeId===sha(resolved.checkoutRoot),
   'Original frontend project/intake reference mismatch');
 const text=detail.originalRequest?.text,loss=detail.originalRequest?.redactionLoss===true;
 requireValue(typeof text==='string'&&detail.originalRequest.completeWithinBound===true&&sha(text)===detail.originalRequest.storedDigest,
   'Complete redacted original request not reconstructable from this receipt');
 const ledger=readContinuationLedger(continuationLedgerPath({projectDir,env}));
 const pointer=ledger.managedTasks?.find(value=>value.binding?.userInstructionRef===receipt.key);
 const task=pointer?readManagedContinuationTask(pointer,{projectDir,host:detail.host,frontendInstanceId:detail.frontendInstanceId,
   submissionSequence:detail.submissionSequence,deadlineAt}):null;
 let definitions=[],frozenPlanner=null,frozenCheckerRegistry=null,frozenCheckerSourceRefs=null,frozenScope=null,scopeContract=null;
 if(pointer?.definitionReceipt){
   const defined=withProgressionReader(resolved.canonicalAgentDbPath,reader=>reader.readContent(CONTINUITY_NAMESPACE,pointer.definitionReceipt.key),{deadlineAt});
   requireValue(defined.ok&&sha(defined.value)===pointer.definitionReceipt.valueSha256,'Frozen task definition changed or unavailable');
   const definition=JSON.parse(defined.value).detail;
   definitions=definition.frozenTaskDefinitions??[];frozenPlanner=definition.planner??null;
   frozenCheckerRegistry=definition.frozenCheckerRegistry??null;frozenCheckerSourceRefs=definition.frozenCheckerSourceRefs??null;
   frozenScope=definition.frozenScope??null;
   scopeContract=definition.scopeContract??null;
   if(detail.ownerInventory)requireValue(scopeContract?.schemaVersion===2
     &&JSON.stringify(scopeContract.inventory)===JSON.stringify(detail.ownerInventory),'Original owner inventory missing or changed in definition');
 }
 const blockers=[];
 if(task?.receipt.preparationAttempts&&!definitions.length)blockers.push('Reserved or unknown native preflight attempt retained; no automatic attempt reset or replay');
 if(loss||sha(text)!==detail.userInstructionDigest)blockers.push('Redaction loss: original request cannot be fully reconstructed; owner restatement required');
 if(task?.state==='complete')blockers.push('Original goal already complete; replay as a new task refused');
 if(task&&task.state!=='active')blockers.push('Canonical task is blocked/unknown; inspect retained boundary evidence before effects');
 if(task?.receipt.taskChecklist?.some(value=>value.attempted||value.state==='verified'))blockers.push('Prior attempted/verified work retained; blind executor replay forbidden');
 const old=detail.scopeLimits;
 if(!currentScope)blockers.push('Fresh actual frontend permission/consent scope not observed; recovery is readonly');
 else if(currentScope.permissions?.apiBilling!==false||Object.keys(currentScope.permissions||{}).some(key=>!['apiBilling','write'].includes(key))
   ||currentScope.permissions.write&&!detail.permissions.write
   ||JSON.stringify(currentScope.allowedWorktrees)!==JSON.stringify(old.allowedWorktrees)
   ||currentScope.maxConcurrent>old.maxConcurrent||currentScope.maxAttempts>old.maxAttempts)
   blockers.push('Current scope widens original frozen boundary; adoption refused');
 if(currentScope?.permissions.write===false&&detail.permissions.write&&(!definitions.length||definitions.some(task=>task.ownership?.mode==='write')))blockers.push('Current native permissions revoke required remaining write effects');
 if(Date.now()>=old.deadline)blockers.push('Original deadline expired; no fresh effects authorized');
 return {state:blockers.length?'blocked':'recovered-unfinished',goalId:detail.goalId||pointer?.binding.workflowId,
   originalRequest:text,originalRequestDigest:detail.userInstructionDigest,redactionLoss:loss,originalScope:old,originalPermissions:detail.permissions,
   taskState:task?.state??'intake-only',taskChecklist:task?.receipt.taskChecklist??[],preparationAttempts:task?.receipt.preparationAttempts??scopeContract?.sourceReview?.attempts??null,frozenTaskDefinitions:definitions,frozenPlanner,frozenCheckerRegistry,frozenCheckerSourceRefs,
   scopeContract,definitionReceipt:pointer?.definitionReceipt??null,originalRegistrationReceipt:pointer?.registrationReceipt??null,originalReceipt:{namespace:CONTINUITY_NAMESPACE,key:receipt.key,valueSha256:sha(row.value)},
   effectiveScope:currentScope?{...old,maxConcurrent:Math.min(old.maxConcurrent,currentScope.maxConcurrent,frozenScope?.maxConcurrent??Infinity),maxAttempts:Math.min(old.maxAttempts,currentScope.maxAttempts,frozenScope?.maxAttempts??Infinity),
     deadline:Math.min(old.deadline,currentScope.deadline,frozenScope?.deadline??Infinity),permissions:{apiBilling:false,write:detail.permissions.write&&currentScope.permissions.write&&(frozenScope?.permissions.write??true)}}:null,
   blockers,requiresFreshCallback:true,canExecute:false,nonAuthorizing:true};
}
