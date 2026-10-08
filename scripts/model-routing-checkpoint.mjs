// Reproducible loop artifact only. Canonical task receipts remain authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {readCheckpoint,writeCheckpoint,checkCheckpoint} from './loop-checkpoint.mjs';
import {resolveProjectStore} from '../plugin/scripts/project-store-resolver.mjs';
import {withProgressionReader} from '../plugin/scripts/project-progression-reader.mjs';
import {CONTINUITY_NAMESPACE} from '../plugin/scripts/continuity-events.mjs';
import {canonicalJson} from '../plugin/scripts/coverage-integrity.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const requireValue=(value,reason)=>{if(!value)throw Error('Loop checkpoint blocked: '+reason);};
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function createRoutingCheckpoint(request) {
  const directory=path.join(request.projectRoot,'.ruvnet-brain','loops',request.id);
  const file=path.join(directory,'checkpoint.json');
  const binding=sha(canonicalJson({workflowId:request.id,originalPrompt:request.originalPrompt,
    permissions:request.permissions,deadline:request.deadline,maxAttempts:request.maxAttempts,maxConcurrent:request.maxConcurrent,
    allowedWorktrees:request.allowedWorktrees,contextRefs:request.contextRefs,tasks:request.tasks,checks:request.checkerRegistry}));
  const objective=fileURLToPath(new URL('../plugin/scripts/continuation-objective.mjs',import.meta.url));
  const registration=request.continuationRegistration;
  const script=`const m=await import(${JSON.stringify(objective)});const {isDeepStrictEqual}=await import('node:util');const b=${canonicalJson(registration.binding)};`
    +`const p=m.readContinuationLedger(${JSON.stringify(registration.ledgerFile)}).managedTasks?.find(p=>isDeepStrictEqual(p.binding,b));`
    +`const t=p&&m.readManagedContinuationTask(p,{projectDir:${JSON.stringify(request.projectRoot)},host:b.host,nativeSessionId:b.nativeSessionId,frontendInstanceId:b.frontendInstanceId,submissionSequence:b.submissionSequence,deadlineAt:Date.now()+1000});process.exit(t?.state==='complete'?0:1);`;
  const command=[process.execPath,'--input-type=module','-e',script].map(quote).join(' ');
  let iteration=0,entered=false;
  const stat=entry=>{try{return fs.lstatSync(entry);}catch(error){requireValue(error.code==='ENOENT','checkpoint path inspection failed');return null;}};
  const safePath=()=>{
    let current=request.projectRoot;
    for(const part of ['.ruvnet-brain','loops',request.id]){
      current=path.join(current,part);
      const parent=stat(current);if(parent)requireValue(parent.isDirectory()&&!parent.isSymbolicLink()&&fs.realpathSync(current)===current,'foreign checkpoint directory');
    }
    const artifact=stat(file);if(artifact)requireValue(artifact.isFile()&&!artifact.isSymbolicLink()&&artifact.size<=65536,'unsafe checkpoint artifact');
    requireValue(!stat(file+'.tmp'),'Existing temporary checkpoint artifact retained');
  };
  const canonicalHead=head=>{
    const resolution=resolveProjectStore({projectDir:request.projectRoot,deadlineAt:request.deadline});
    const value=withProgressionReader(resolution.canonicalAgentDbPath,r=>r.readContent(CONTINUITY_NAMESPACE,head?.key),{deadlineAt:request.deadline});
    requireValue(head?.namespace===CONTINUITY_NAMESPACE&&value.ok&&typeof value.value==='string'&&sha(value.value)===head.valueSha256,'canonical head changed or unavailable');
    const detail=JSON.parse(value.value).detail;
    requireValue(detail.workflowId===request.id&&detail.originalPromptDigest===sha(request.originalPrompt),'foreign canonical workflow');
    const ledger=JSON.parse(fs.readFileSync(registration.ledgerFile,'utf8'));
    const pointer=ledger.managedTasks?.find(p=>isDeepStrictEqual(p.binding,registration.binding));
    requireValue(pointer&&isDeepStrictEqual(pointer.receipt,head),'out-of-date checkpoint canonical head');
    return detail;
  };
  const run=retained=>{
    requireValue(retained===command,'retained command substitution');
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:request.projectRoot,stdio:'ignore',timeout:Math.max(1,Math.min(1500,request.deadline-Date.now()))});
    return result.status;
  };
  return {file,command,
    readFirst(){try{
      safePath();const checkpoint=readCheckpoint(file);
      if(!checkpoint){requireValue(!fs.existsSync(file),'Unreadable or tampered checkpoint projection');entered=true;return{code:0};}
      const metadata=JSON.parse(checkpoint.blockers);
      requireValue(metadata.binding===binding&&checkpoint.doneCriteria===command&&Number.isSafeInteger(checkpoint.iteration),'foreign or tampered frozen criteria');
      const detail=canonicalHead(metadata.canonicalHead);iteration=checkpoint.iteration;
      const verdict=checkCheckpoint(file,run);
      if(verdict.code===0&&!entered&&(detail.status==='blocked'||detail.taskChecklist?.some(task=>task.attempted||task.state==='verified')))
        return{code:2,verdict:'Prior blocked/attempted work retained; exact reconciliation required, no executor replay'};
      entered=true;return verdict;
    }catch(error){error.code='CHECKPOINT_RECONCILIATION_REQUIRED';throw error;}
    },
    writeLast(receipt,head,next=receipt.resumeHandoff.nextStep){try{
      safePath();const detail=canonicalHead(head);
      requireValue(Date.now()<request.deadline,'original deadline exhausted');
      writeCheckpoint({iteration:iteration++,doneCriteria:command,
        next:detail.remainingRequirements?.length?'Retain unfinished original obligations: '+detail.remainingRequirements.join(', '):next,
        blockers:JSON.stringify({binding,canonicalHead:head,reason:detail.reason??detail.failure??'',status:detail.status})},file);
    }catch(error){error.code='CHECKPOINT_RECONCILIATION_REQUIRED';throw error;}
    },
  };
}
