// Owner-selected inventory data never grants permission or proves comprehension.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {redactText} from './continuity-events.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const need=(value,message)=>{if(!value)throw Error(message);};
const id=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const hash=/^[a-f0-9]{64}$/;
const inside=(root,file)=>file.startsWith(root+path.sep);
function boundedRegularRead(root,file,{deadlineAt,signal}){
  need(Number.isInteger(fs.constants.O_NONBLOCK)&&fs.constants.O_NONBLOCK!==0
    &&Number.isInteger(fs.constants.O_NOFOLLOW)&&fs.constants.O_NOFOLLOW!==0,'Nonblocking no-follow file access unsupported');
  const live=()=>need(!signal?.aborted&&Date.now()<deadlineAt,'File read expired or cancelled');live();
  const anchor=fs.lstatSync(file);need(anchor.isFile(),'Bounded regular file required');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const before=fs.fstatSync(fd);need(before.isFile()&&before.size<=120000,'Bounded regular file required');
    need(before.dev===anchor.dev&&before.ino===anchor.ino,'File changed between path validation and open');
    const buffer=Buffer.alloc(120001);let count=0;
    while(count<buffer.length){live();const read=fs.readSync(fd,buffer,count,buffer.length-count,null);if(read===0)break;count+=read;}
    need(count<=120000,'File grew beyond bounded byte limit');
    const after=fs.fstatSync(fd),current=fs.lstatSync(file);live();
    need(['dev','ino','size','mtimeMs','ctimeMs'].every(key=>before[key]===after[key])&&count===after.size
      &&current.isFile()&&current.dev===after.dev&&current.ino===after.ino
      &&fs.realpathSync(file)===file&&inside(root,file),'File source changed during same-FD read');
    return buffer.subarray(0,count);
  }finally{fs.closeSync(fd);}
}
export function validateOwnerInventory(value){
  need(value?.schemaVersion===1&&Array.isArray(value.requirements)&&value.requirements.length>0&&value.requirements.length<=1000,'Versioned bounded owner inventory required');
  const ids=new Set();
  for(const requirement of value.requirements){
    need(id.test(requirement?.id)&&!ids.has(requirement.id),'Duplicate or invalid original requirement ID');ids.add(requirement.id);
    need(typeof requirement.statement==='string'&&requirement.statement.trim().length>=12&&requirement.statement.length<=4000,'Original requirement statement required');
    need(['in-scope','pending','excluded'].includes(requirement.disposition),'Owner disposition required');
    need(Array.isArray(requirement.taskMappings),'Owner requirement mappings required');
    need(requirement.disposition==='in-scope'?requirement.taskMappings.length>0:requirement.taskMappings.length===0,'Pending/excluded requirement cannot authorize tasks');
    if(requirement.disposition==='excluded')need(typeof requirement.dispositionReason==='string'&&requirement.dispositionReason.trim(),'Owner exclusion reason required');
    for(const mapping of requirement.taskMappings)need(id.test(mapping?.taskId)&&Array.isArray(mapping.criterionIds)&&mapping.criterionIds.length>0
      &&new Set(mapping.criterionIds).size===mapping.criterionIds.length&&mapping.criterionIds.every(v=>id.test(v))
      &&Array.isArray(mapping.checkIds)&&mapping.checkIds.length>0&&new Set(mapping.checkIds).size===mapping.checkIds.length&&mapping.checkIds.every(v=>id.test(v)), 'Exact owner task/criterion/check mapping required');
  }
  need(value.requirements.some(r=>r.disposition==='in-scope'),'Owner execution cohort required');
  return value;
}

/** Called only after the existing private ordinary callback witness is verified. */
export function captureOwnerInventory(originalPrompt,projectDir,{deadlineAt,signal}={}){
  if(!originalPrompt.startsWith('/scope-manifest '))return null;
  const match=/^\/scope-manifest ([^\s]+) ([a-f0-9]{64}) -- (\S[\s\S]*)$/.exec(originalPrompt);
  need(match,'Explicit project manifest path, exact digest and task required');
  need(!signal?.aborted&&Number.isFinite(deadlineAt)&&Date.now()<deadlineAt,'Owner manifest read expired or cancelled');
  const root=fs.realpathSync(projectDir),relative=match[1];
  need(!path.isAbsolute(relative)&&!relative.split(/[\\/]/).includes('..'),'External owner manifest refused');
  const file=fs.realpathSync(path.join(root,relative));need(inside(root,file),'Owner manifest escaped project');
  const bytes=boundedRegularRead(root,file,{deadlineAt,signal});
  need(!signal?.aborted&&Date.now()<deadlineAt&&sha(bytes)===match[2],'Owner selected manifest digest changed');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  need(redactText(text)===text,'Owner manifest redaction loss; explicit sanitized restatement required');
  const manifest=validateOwnerInventory(JSON.parse(text));
  return {origin:'owner-enumerated',sourceRef:{path:file,digest:sha(bytes)},sourceDigest:sha(bytes),
    manifestText:text,requirements:structuredClone(manifest.requirements),digest:sha(JSON.stringify(manifest.requirements))};
}

export function bindScopeContract(inventory,request,receipt){
  if(!inventory)return null;
  need(receipt?.namespace==='continuity-events'&&typeof receipt.key==='string'&&hash.test(receipt.valueSha256),'Exact original inventory intake receipt required');
  validateOwnerInventory({schemaVersion:1,requirements:inventory.requirements});
  need(sha(inventory.manifestText)===inventory.sourceDigest&&sha(JSON.stringify(inventory.requirements))===inventory.digest
    &&JSON.stringify(JSON.parse(inventory.manifestText).requirements)===JSON.stringify(inventory.requirements),'Frozen owner inventory bytes changed');
  return {schemaVersion:1,requestBinding:{workflowId:request.id,originalPromptDigest:sha(request.originalPrompt),userInstructionReceipt:structuredClone(receipt)},
    inventory:structuredClone(inventory),coverage:[],sourceReview:{state:'pending-independent-preflight',observedAccess:[],comprehension:'UNKNOWN'},unresolved:[]};
}

export function validateScopeMappings(contract,tasks,registry){
  if(!contract)return;
  validateOwnerInventory({schemaVersion:1,requirements:contract.inventory.requirements});
  const covered=new Set(),coverage=[];
  for(const requirement of contract.inventory.requirements){
    for(const mapping of requirement.taskMappings){
      const task=tasks.find(t=>t.id===mapping.taskId);need(task,'Owner requirement task omitted');
      need(mapping.criterionIds.every(cid=>task.acceptanceCriteria.some(c=>c.id===cid)),'Owner requirement criterion omitted');
      for(const cid of mapping.criterionIds){const criterion=task.acceptanceCriteria.find(c=>c.id===cid);
        need(JSON.stringify([...criterion.checkIds].sort())===JSON.stringify([...mapping.checkIds].sort()),'Owner requirement checker mapping changed');
        need(mapping.checkIds.every(checkId=>registry.some(check=>check.id===checkId)),'Owner requirement checker unregistered');covered.add(`${task.id}:${cid}`);}
    }
    coverage.push({requirementId:requirement.id,taskMappings:structuredClone(requirement.taskMappings),remainingState:requirement.disposition==='in-scope'?'queued':requirement.disposition});
  }
  need(tasks.every(t=>t.acceptanceCriteria.every(c=>covered.has(`${t.id}:${c.id}`))),'Task criterion has no owner inventory requirement');
  return coverage;
}

export function assertScopeContractBinding(contract,request){
  if(!contract)return;
  const binding=contract.requestBinding;
  need([1,2].includes(contract.schemaVersion)&&binding?.workflowId===request.id&&binding.originalPromptDigest===sha(request.originalPrompt)
    &&JSON.stringify(binding.userInstructionReceipt)===JSON.stringify(request.continuationRegistration?.userInstructionReceipt),'Original scope contract binding changed');
  need(JSON.stringify(validateScopeMappings(contract,request.tasks,request.checkerRegistry))===JSON.stringify(contract.coverage),'Frozen inventory coverage changed');
}

/** Actual bounded byte access is evidence of delivery, never comprehension. */
export function readScopeBoundary(boundary,projectDir,{deadlineAt,signal}={}){
  need(!signal?.aborted&&Number.isFinite(deadlineAt)&&Date.now()<deadlineAt,'Scope read expired or cancelled');
  const root=fs.realpathSync(projectDir),file=fs.realpathSync(boundary.sourceRef.path);
  need(inside(root,file)&&hash.test(boundary.sourceRef.digest),'Scope boundary escaped project');
  const bytes=boundedRegularRead(root,file,{deadlineAt,signal});
  need(!signal?.aborted&&Date.now()<deadlineAt&&sha(bytes)===boundary.sourceRef.digest,'Scope source digest changed');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),lines=text.split('\n');
  need(redactText(text)===text,'Source redaction loss blocks scope delivery; full same-read source scan required');
  need(Array.isArray(boundary.ranges)&&boundary.ranges.length>0&&boundary.ranges.length<=32,'Explicit bounded read ranges required');
  const ranges=boundary.ranges.map(({startLine,endLine})=>{
    need(Number.isInteger(startLine)&&Number.isInteger(endLine)&&startLine>=1&&endLine>=startLine&&endLine<=lines.length,'Scope read range outside source');
    const delivered=lines.slice(startLine-1,endLine).join('\n');
    const text=redactText(delivered);
    return{startLine,endLine,bytes:Buffer.byteLength(delivered),digest:sha(delivered),text,
      originalDigest:sha(delivered),storedDigest:sha(text),redactionLoss:text!==delivered};
  });
  return{kind:'observed-file-byte-access',sourceRef:{path:file,digest:sha(bytes)},sourceBytes:bytes.length,ranges,observedAt:new Date().toISOString(),comprehension:'UNKNOWN'};
}

export const SCOPE_DIMENSIONS=['entry','caller','consumer','config','native-host','state-transition','crash-recovery','error'];
export function automaticScopeContract(proposal,request,receipt){
  need(Array.isArray(proposal.obligations)&&proposal.obligations.length>0&&proposal.obligations.length<=128,'Bounded original obligation proposals required');
  const requirements=proposal.obligations.map(value=>{
    need(value.disposition!=='excluded','Planner cannot exclude original obligations');
    if(value.originalLocator){const {start,end,quote}=value.originalLocator;
      need(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>start&&end<=request.originalPrompt.length
        &&request.originalPrompt.slice(start,end)===quote,'Original obligation text locator changed');
    }else need(typeof value.inferenceRationale==='string'&&value.inferenceRationale.trim().length>=12,'Inferred obligation requires explicit fallible rationale');
    return structuredClone(value);
  });
  const manifestText=JSON.stringify({schemaVersion:1,requirements});
  need(Buffer.byteLength(manifestText)<=32000&&redactText(manifestText)===manifestText,'Bounded privacy-safe obligation inventory required');
  const contract=bindScopeContract({origin:'extracted-proposed',sourceRef:structuredClone(receipt),sourceDigest:sha(manifestText),
    manifestText,requirements,digest:sha(JSON.stringify(requirements))},request,receipt);
  contract.schemaVersion=2;return contract;
}

export function scopeSourcePacket(contract,boundaries,request,{signal}={}){
  need(Array.isArray(boundaries)&&boundaries.length>=8&&boundaries.length<=32,'All eight bounded source dimensions required');
  const ids=new Set(),requirements=new Set(contract.inventory.requirements.map(r=>r.id)),entries=[];
  for(const boundary of boundaries){
    need(id.test(boundary.id)&&!ids.has(boundary.id)&&SCOPE_DIMENSIONS.includes(boundary.dimension),'Unique source boundary identity required');ids.add(boundary.id);
    need(Array.isArray(boundary.requirementIds)&&boundary.requirementIds.length>0&&boundary.requirementIds.every(value=>requirements.has(value)),'Source boundary requirement mapping missing');
    need(['read','not-applicable'].includes(boundary.state),'Relevant unread source boundary blocks preflight');
    if(boundary.state==='not-applicable')need(typeof boundary.reason==='string'&&boundary.reason.trim().length>=12,'Source-bound not-applicable rationale required');
    const access=readScopeBoundary(boundary,request.projectRoot,{deadlineAt:request.deadline,signal});
    need(access.ranges.every(range=>!range.redactionLoss),'Relevant source redaction loss blocks preflight');
    entries.push({id:boundary.id,dimension:boundary.dimension,requirementIds:boundary.requirementIds,state:boundary.state,
      reason:boundary.reason??null,access});
    need(Buffer.byteLength(JSON.stringify(entries))<=16384,'Aggregate source packet exceeds bounded delivery limit');
  }
  need(SCOPE_DIMENSIONS.every(dimension=>entries.some(entry=>entry.dimension===dimension)),'Missing source dimension blocks preflight');
  need(contract.inventory.requirements.filter(r=>r.disposition==='in-scope').every(requirement=>SCOPE_DIMENSIONS.every(dimension=>entries.some(entry=>entry.dimension===dimension
    &&entry.requirementIds.includes(requirement.id)))),'Every selected requirement needs source-bound coverage in all eight dimensions');
  return{schemaVersion:1,entries,digest:sha(JSON.stringify(entries)),comprehension:'UNKNOWN'};
}

export function validateScopePreflight(contract,tasks,packet,verdict){
  need(verdict?.schemaVersion===1&&verdict.kind==='scope-preflight'&&verdict.passed===true,'Independent scope preflight did not qualify');
  need(verdict.originalPromptDigest===contract.requestBinding.originalPromptDigest&&verdict.inventoryDigest===contract.inventory.digest
    &&verdict.tasksDigest===sha(JSON.stringify(tasks))&&verdict.packetDigest===packet.digest,'Scope preflight exact submitted digest mismatch');
  need(Array.isArray(verdict.findings)&&verdict.findings.length===0&&Array.isArray(verdict.omissions)&&verdict.omissions.length===0,'Relevant scope findings or omissions block effects');
  need(Array.isArray(verdict.requirementIds)&&JSON.stringify([...verdict.requirementIds].sort())===JSON.stringify(contract.inventory.requirements.map(r=>r.id).sort()),'Preflight omitted original requirement IDs');
  need(Array.isArray(verdict.boundaryIds)&&JSON.stringify([...verdict.boundaryIds].sort())===JSON.stringify(packet.entries.map(r=>r.id).sort()),'Preflight omitted actual source boundary IDs');
  need(Array.isArray(verdict.criterionCoverage)&&tasks.every(task=>task.acceptanceCriteria.every(criterion=>verdict.criterionCoverage.some(item=>item.taskId===task.id
    &&item.criterionId===criterion.id&&JSON.stringify(item.checkIds)===JSON.stringify(criterion.checkIds)&&item.passed===true))),'Preflight original criterion mapping missing');
  return{kind:'fallible-scope-attestation',processSeparation:true,comprehension:'UNKNOWN',inventoryDigest:verdict.inventoryDigest,tasksDigest:verdict.tasksDigest,packetDigest:verdict.packetDigest};
}
