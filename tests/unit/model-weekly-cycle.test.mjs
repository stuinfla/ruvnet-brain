import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {afterEach,expect,it,vi} from 'vitest';
import {digest} from '../../scripts/model-currency-evidence.mjs';
import {runWeeklyCycle,runCycleStage,canonicalTextReleases,maybeLaunchWeeklyCycle} from '../../scripts/model-weekly-cycle.mjs';
const dirs=[],NOW=Date.now(),WEEK=604800000;const write=(d,f,v)=>fs.writeFileSync(path.join(d,f),JSON.stringify(v));
const releases=[{id:'openai/sol-20261001',provider:'openai',aliases:['openai/sol']},{id:'anthropic/sonnet-20261001',provider:'anthropic',aliases:['anthropic/sonnet']}];
function inventory(extra=[]){return JSON.stringify({data:[...Array.from({length:50},(_,i)=>({id:'other/model'+i})),...releases.map(r=>({id:r.aliases[0],canonical_slug:r.id,architecture:{output_modalities:['text']}})),...extra]});}
function fixture(withState=true){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-cycle-test-'));dirs.push(dir);fs.writeFileSync(path.join(dir,'routing-policy.json'),'{"schemaVersion":1,"routes":{}}');fs.writeFileSync(path.join(dir,'weekly-analyst-instruction.md'),'Owner instruction');if(withState)write(dir,'weekly-model-discovery.json',{schemaVersion:1,checkedAt:new Date(NOW).toISOString(),releases,baselineReleaseIds:releases.map(r=>r.id),pendingReleases:[]});return dir;}
function currency(dir,now=NOW){const checkedAt=new Date(now).toISOString();write(dir,'currency.json',{schemaVersion:1,inventory:{checkedAt,discoveryOnly:true,models:Array(50).fill({})},evaluations:{checkedAt,sources:[{checkedAt,sha256:'a'.repeat(64)}],records:[{}]},lastAttempt:{status:'complete'}});}
const fetcher=(body=inventory())=>vi.fn(async()=>({ok:true,text:async()=>body}));
const newRelease={id:'openai/new-sol',canonical_slug:'openai/new-sol-20261008',architecture:{output_modalities:['text']}};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
it('collapses canonical aliases and effort variants; excludes unrelated providers and image-only rows',()=>{
  const variants=['low','medium','high'].map(effort=>({id:'openai/sol:'+effort,canonical_slug:releases[0].id,architecture:{output_modalities:['text']}}));
  const result=canonicalTextReleases(inventory([...variants,{id:'openai/image',canonical_slug:'openai/image-v1',architecture:{output_modalities:['image']}}]));
  expect(result).toHaveLength(2);expect(result.find(r=>r.provider==='openai').aliases).toHaveLength(4);
});
it('initializes the authorized baseline and retains policy without claiming semantic review or running inference',async()=>{
  const dir=fixture(false),stage=vi.fn(),before=fs.readFileSync(path.join(dir,'routing-policy.json'));
  const result=await runWeeklyCycle({routerDir:dir,now:NOW,stage,fetchImpl:fetcher()});
  expect(result).toMatchObject({status:'baseline-established-policy-retained',reviewExecuted:false,policyApplied:false});expect(stage).not.toHaveBeenCalled();expect(fs.existsSync(path.join(dir,'semantic-current.json'))).toBe(false);expect(fs.readFileSync(path.join(dir,'routing-policy.json'))).toEqual(before);
  expect(JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json'))).semanticReviewClaimed).toBe(false);
});
it('reuses a recent digest-bound initial inventory without a network or native call',async()=>{
  const dir=fixture(false),body=inventory(),sha256=digest(body);fs.mkdirSync(path.join(dir,'evidence'));fs.writeFileSync(path.join(dir,'evidence',sha256+'.json'),body);
  write(dir,'currency.json',{inventory:{source:{url:'https://openrouter.ai/api/v1/models',checkedAt:new Date(NOW).toISOString(),sha256}}});
  const fetchImpl=vi.fn(),stage=vi.fn();expect((await runWeeklyCycle({routerDir:dir,now:NOW,fetchImpl,stage})).status).toBe('baseline-established-policy-retained');expect(fetchImpl).not.toHaveBeenCalled();expect(stage).not.toHaveBeenCalled();
});
it('unchanged weekly discovery never refreshes expensive evidence or runs an old semantic review',async()=>{
  const dir=fixture(),stage=vi.fn(),fetchImpl=fetcher();write(dir,'semantic-current.json',{completedAt:'2020-01-01'});
  expect((await runWeeklyCycle({routerDir:dir,now:NOW+WEEK,stage,fetchImpl})).status).toBe('unchanged');expect(fetchImpl).toHaveBeenCalledOnce();expect(stage).not.toHaveBeenCalled();expect(JSON.parse(fs.readFileSync(path.join(dir,'semantic-current.json'))).completedAt).toBe('2020-01-01');
});
it('only genuinely new canonical releases trigger full collection then guarded native analysis',async()=>{
  const dir=fixture(),calls=[],now=NOW+WEEK,before=fs.readFileSync(path.join(dir,'routing-policy.json'));
  const stage=async options=>{calls.push(options);if(options.script==='model-currency.mjs'){currency(dir,now);return{code:0,result:{status:'current'}};}if(options.script==='model-weekly-qualification.mjs')return{code:0,result:{status:'unchanged',terminal:true}};return{code:0,result:{status:'validated-semantic-report',completedAt:new Date(now).toISOString(),runDir:'/private/receipt'}};};
  const result=await runWeeklyCycle({routerDir:dir,now,stage,fetchImpl:fetcher(inventory([newRelease])),env:{OPENAI_API_KEY:'neverforward',ANTHROPIC_API_KEY:'neverforward',PATH:'/bin'}});
  expect(result).toMatchObject({status:'complete',reviewExecuted:true,policyApplied:false});expect(calls.map(c=>c.script)).toEqual(['model-currency.mjs','model-weekly-analyst.mjs','model-weekly-qualification.mjs']);expect(calls[1].timeoutMs).toBeLessThanOrEqual(452000);expect(calls[1].env.OPENAI_API_KEY).toBeUndefined();expect(calls[1].env.ANTHROPIC_API_KEY).toBeUndefined();expect(fs.readFileSync(path.join(dir,'routing-policy.json'))).toEqual(before);
  const state=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));expect(state.pendingReleases).toEqual([]);expect(state.baselineReleaseIds).toContain(newRelease.canonical_slug);
});
it('failed new-release review preserves pending delta and retries after cooldown without marking it reviewed',async()=>{
  const dir=fixture(),now=NOW+WEEK;const stage=async options=>{if(options.script==='model-currency.mjs'){currency(dir,now);return{code:0,result:{status:'current'}};}return{code:1,result:{status:'failed'}};};
  expect((await runWeeklyCycle({routerDir:dir,now,stage,fetchImpl:fetcher(inventory([newRelease]))})).status).toBe('failed');
  const state=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));expect(state.pendingReleases[0].id).toBe(newRelease.canonical_slug);expect(state.baselineReleaseIds).not.toContain(newRelease.canonical_slug);
  const retry=vi.fn(stage);expect((await runWeeklyCycle({routerDir:dir,now:now+3600001,stage:retry,fetchImpl:fetcher()})).status).toBe('failed');expect(retry).toHaveBeenCalledTimes(2);
});
it('source failure is unknown and preserves prior baseline; public removals alert without native-availability claims',async()=>{
  const dir=fixture(),before=fs.readFileSync(path.join(dir,'weekly-model-discovery.json')),stage=vi.fn();
  expect((await runWeeklyCycle({routerDir:dir,now:NOW+WEEK,stage,fetchImpl:async()=>{throw new Error('offline')}})).releaseStatus).toBe('unknown-or-pending');expect(fs.readFileSync(path.join(dir,'weekly-model-discovery.json'))).toEqual(before);
  const body=inventory();const parsed=JSON.parse(body);parsed.data=parsed.data.filter(r=>r.id!=='openai/sol');parsed.data.push({id:'openai/other-existing',canonical_slug:'openai/other-existing',architecture:{output_modalities:['text']}});
  // Keep both-provider coverage, and seed that existing release so this is removal-only.
  const s=JSON.parse(before);s.baselineReleaseIds.push('openai/other-existing');write(dir,'weekly-model-discovery.json',s);
  const result=await runWeeklyCycle({routerDir:dir,now:NOW+WEEK+3600001,stage,fetchImpl:fetcher(JSON.stringify(parsed))});expect(result.status).toBe('availability-alert-policy-retained');expect(result.publicAvailabilityAlert.nativeAvailability).toMatch(/unknown/);expect(stage).not.toHaveBeenCalled();
});
it('offline prompt path stays quiet without a new release and fences one background cycle',()=>{
  const dir=fixture(),launch=vi.fn(()=>({once(){},unref(){}}));expect(maybeLaunchWeeklyCycle({routerDir:dir,now:NOW,launch})).toMatchObject({status:'current',launched:false,reviewRequired:false});
  const s=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));s.pendingReleases=[{id:newRelease.canonical_slug}];write(dir,'weekly-model-discovery.json',s);
  expect(maybeLaunchWeeklyCycle({routerDir:dir,now:NOW,launch})).toMatchObject({status:'launched',launched:true,reviewRequired:true});expect(maybeLaunchWeeklyCycle({routerDir:dir,now:NOW,launch}).status).toBe('busy');expect(launch).toHaveBeenCalledOnce();
});
it('deduplicates and fences delayed old-worker writes and cleanup after successor claim',async()=>{
  const dir=fixture(),s=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));s.pendingReleases=[{id:newRelease.canonical_slug}];write(dir,'weekly-model-discovery.json',s);let finishOld,finishNew;
  const old=runWeeklyCycle({routerDir:dir,now:NOW,stage:()=>new Promise(r=>{finishOld=r;})});expect((await runWeeklyCycle({routerDir:dir,now:NOW,stage:vi.fn()})).status).toBe('busy');
  const newer=runWeeklyCycle({routerDir:dir,now:NOW+1201000,stage:()=>new Promise(r=>{finishNew=r;})});const owner=fs.readFileSync(path.join(dir,'weekly-cycle-owner.json'));finishOld({code:1,result:{status:'failed'}});expect((await old).status).toBe('failed');expect(fs.readFileSync(path.join(dir,'weekly-cycle-owner.json'))).toEqual(owner);finishNew({code:1,result:{status:'failed'}});await newer;
});
it('kills hung subprocesses and rejects malformed completion instead of certifying scheduled success',async()=>{
  const spawnHost=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>queueMicrotask(()=>child.emit('exit',null));return child;};await expect(runCycleStage({script:'model-currency.mjs',args:[],timeoutMs:10,env:{},spawnHost})).rejects.toThrow('bounded deadline');
  const invalid=()=>{const child=spawnHost();queueMicrotask(()=>{child.stdout.emit('data','not a receipt');child.emit('exit',0);});return child;};await expect(runCycleStage({script:'model-currency.mjs',args:[],timeoutMs:100,env:{},spawnHost:invalid})).rejects.toThrow('receipt missing');
});

it('keeps a deferred proposal and resumes only qualification rather than repeating native analysis',async()=>{
 const dir=fixture(),now=NOW+WEEK,calls=[];
 const stage=async o=>{calls.push(o.script);if(o.script==='model-currency.mjs'){currency(dir,now);return{code:0,result:{status:'current'}};}
 if(o.script==='model-weekly-analyst.mjs')return{code:0,result:{status:'validated-semantic-report',runDir:'/private/bound-review',completedAt:new Date(now).toISOString()}};
 return{code:0,result:{status:'deferred',terminal:false,reason:'native allowance unavailable'}};};
 const first=await runWeeklyCycle({routerDir:dir,now,stage,fetchImpl:fetcher(inventory([newRelease]))});
 expect(first.status).toBe('qualification-pending');expect(first.policyApplied).toBe(false);
 const state=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));expect(state.pendingReleases).toHaveLength(1);expect(state.pendingSemanticReceipt.runDir).toBe('/private/bound-review');
 calls.length=0;
 const resumed=await runWeeklyCycle({routerDir:dir,now:now+3600001,stage:async o=>{calls.push(o.script);return{code:0,result:{status:'promoted',terminal:true}};},fetchImpl:fetcher()});
 expect(calls).toEqual(['model-weekly-qualification.mjs']);expect(resumed).toMatchObject({status:'complete',policyApplied:true,reviewExecuted:false});
 expect(JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json'))).pendingReleases).toEqual([]);
});
it('a reasoned rejected candidate is terminal and does not repeat expensive review',async()=>{
 const dir=fixture(),state=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));state.pendingReleases=[{id:newRelease.canonical_slug}];state.pendingSemanticReleaseIds=[newRelease.canonical_slug];state.pendingSemanticReceipt={runDir:'/private/bound-review',completedAt:new Date(NOW).toISOString()};write(dir,'weekly-model-discovery.json',state);
 const before=fs.readFileSync(path.join(dir,'routing-policy.json'));
 const first=await runWeeklyCycle({routerDir:dir,now:NOW,stage:async()=>({code:0,result:{status:'rejected',terminal:true,reason:'quality below floor'}})});
 expect(first).toMatchObject({status:'complete',policyApplied:false});expect(fs.readFileSync(path.join(dir,'routing-policy.json'))).toEqual(before);
 const stage=vi.fn();expect((await runWeeklyCycle({routerDir:dir,now:NOW+1,stage})).status).toBe('unchanged');expect(stage).not.toHaveBeenCalled();
});

it('refreshes an expired pending semantic review once before retrying qualification',async()=>{
 const dir=fixture(),state=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));
 state.pendingReleases=[{id:newRelease.canonical_slug}]; state.pendingSemanticReleaseIds=[newRelease.canonical_slug];
 state.pendingSemanticReceipt={runDir:'/private/expired',completedAt:new Date(NOW-WEEK-1).toISOString()};write(dir,'weekly-model-discovery.json',state);
 const calls=[]; const result=await runWeeklyCycle({routerDir:dir,now:NOW,stage:async o=>{
  calls.push(o.script); if(o.script==='model-currency.mjs'){currency(dir);return {code:0,result:{status:'current'}};}
  if(o.script==='model-weekly-analyst.mjs')return {code:0,result:{status:'validated-semantic-report',runDir:'/private/new',completedAt:new Date(NOW).toISOString()}};
  return {code:0,result:{status:'unchanged',terminal:true}};
 }});
 expect(result.status).toBe('complete');expect(calls).toEqual(['model-currency.mjs','model-weekly-analyst.mjs','model-weekly-qualification.mjs']);
});

function ownedStageChild(kill=()=>false){
 const child=new EventEmitter();child.pid=4242;
 for(const name of ['stdout','stderr']){child[name]=new EventEmitter();child[name].destroy=vi.fn();}
 child.unref=vi.fn();child.kill=vi.fn(kill);return child;
}
const stageFor=(child,timeoutMs=100)=>runCycleStage({script:'model-currency.mjs',args:[],timeoutMs,env:{},spawnHost:()=>child});
const fakeStageTime=()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date','performance']});
it.each(['false','throws'])('settles within its entire budget when kill %s and no exit/error/close ever arrives',async(mode)=>{
 fakeStageTime();const child=ownedStageChild(()=>{if(mode==='throws')throw new Error('ESRCH');return false;});
 const result=stageFor(child).catch(e=>e);
 await vi.advanceTimersByTimeAsync(89);expect(child.kill).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(11);const error=await result;
 expect(error.message).toMatch(/bounded deadline/);expect(child.kill.mock.calls).toEqual([['SIGTERM'],['SIGKILL']]);
 expect(error.stageCleanup).toEqual({ownedChildPid:4242,childExitObserved:false,ownedChildRetirement:'unverified',descendantRetirement:'unproven'});
 expect(child.stdout.destroy).toHaveBeenCalledOnce();expect(child.stderr.destroy).toHaveBeenCalledOnce();expect(child.unref).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 // A late receipt or process error cannot turn the already failed request into a success.
 child.stdout.emit('data','{"status":"promoted"}\n');child.emit('exit',0);child.emit('error',new Error('late'));
 expect(await result).toBe(error);expect(child.unref).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('a success-shaped receipt during retirement still fails, while acknowledging only the observed child exit',async()=>{
 fakeStageTime();const child=ownedStageChild(),result=stageFor(child).catch(e=>e);
 await vi.advanceTimersByTimeAsync(90);child.stdout.emit('data','{"status":"current"}\n');child.emit('exit',0);
 const error=await result;expect(error.message).toMatch(/bounded deadline/);expect(error.stageCleanup).toMatchObject({childExitObserved:true,ownedChildRetirement:'exit-observed',descendantRetirement:'unproven'});
 expect(child.kill.mock.calls).toEqual([['SIGTERM']]);expect(vi.getTimerCount()).toBe(0);
});
it.each(['stdout-utf8','stderr','combined'])('bounds cumulative %s bytes even if the overflowing child never exits',async(source)=>{
 fakeStageTime();const child=ownedStageChild(),result=stageFor(child).catch(e=>e);
 if(source==='stdout-utf8')child.stdout.emit('data','€'.repeat(90000));
 else if(source==='stderr')child.stderr.emit('data',Buffer.alloc(262145));
 else {child.stdout.emit('data',Buffer.alloc(200000));child.stderr.emit('data',Buffer.alloc(62145));}
 expect(child.kill).toHaveBeenCalledWith('SIGTERM');await vi.advanceTimersByTimeAsync(10);
 expect((await result).message).toMatch(/output limit/);expect(child.kill).toHaveBeenCalledWith('SIGKILL');expect(child.unref).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('host errors settle without exit and successful/nonzero receipts settle once without a later timeout kill',async()=>{
 fakeStageTime();const unavailable=ownedStageChild(),failed=stageFor(unavailable).catch(e=>e);
 unavailable.emit('error',new Error('spawn failure'));await vi.advanceTimersByTimeAsync(10);expect((await failed).message).toMatch(/host unavailable/);
 for(const code of [0,1]){
  const child=ownedStageChild(),result=stageFor(child);child.stderr.emit('data','diagnostic');child.stdout.emit('data','{"status":"current"}\n');child.emit('exit',code);
  expect(await result).toEqual({code,result:{status:'current'}});child.emit('error',new Error('late'));child.stdout.emit('data',Buffer.alloc(262145));await vi.advanceTimersByTimeAsync(100);
  expect(child.kill).not.toHaveBeenCalled();expect(child.unref).toHaveBeenCalledOnce();expect(child.stdout.destroy).toHaveBeenCalledOnce();expect(child.stderr.destroy).toHaveBeenCalledOnce();
 }
 expect(vi.getTimerCount()).toBe(0);
});
it('records bounded retirement uncertainty while retaining the incumbent policy, pending release and ownership fence',async()=>{
 fakeStageTime();vi.setSystemTime(NOW);const dir=fixture(),state=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));
 state.pendingReleases=[{id:newRelease.canonical_slug}];write(dir,'weekly-model-discovery.json',state);const before=fs.readFileSync(path.join(dir,'routing-policy.json')),child=ownedStageChild();
 const result=runWeeklyCycle({routerDir:dir,now:NOW,stage:options=>runCycleStage({...options,timeoutMs:100,spawnHost:()=>child})});
 await vi.advanceTimersByTimeAsync(100);const receipt=await result;
 expect(receipt).toMatchObject({status:'failed',policyApplied:false,changed:false,reviewExecuted:false,releaseStatus:'unknown-or-pending',stageCleanup:{ownedChildRetirement:'unverified',descendantRetirement:'unproven'}});
 expect(JSON.parse(fs.readFileSync(path.join(dir,'weekly-cycle-last-attempt.json')))).toEqual(receipt);expect(fs.readFileSync(path.join(dir,'routing-policy.json'))).toEqual(before);
 expect(JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')))).toEqual(state);expect(fs.existsSync(path.join(dir,'weekly-cycle-owner.json'))).toBe(false);
});
it('bounds and releases an actual owned Node child without launching a provider or claiming descendant retirement',async()=>{
 let child;const started=Date.now();
 const error=await runCycleStage({script:'model-currency.mjs',args:[],timeoutMs:1000,env:{},spawnHost:(binary,_args,options)=>{
  child=spawn(binary,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],options);return child;
 }}).catch(e=>e);
 expect(error.message).toMatch(/bounded deadline/);expect(Date.now()-started).toBeLessThan(3000);
 expect(error.stageCleanup).toMatchObject({ownedChildPid:child.pid,descendantRetirement:'unproven'});
 expect(child.stdout.destroyed).toBe(true);expect(child.stderr.destroyed).toBe(true);
});
it.each(['late-receipt-and-exit','late-exit'])('refuses %s when monotonic time passed the deadline before any timer ran',async(mode)=>{
 fakeStageTime();const child=ownedStageChild(),result=stageFor(child,20).catch(e=>e);
 if(mode==='late-exit')child.stdout.emit('data','{"status":"promoted","terminal":true}\n');
 // Advancing only the clock models a blocked event loop dispatching exit before its overdue timer.
 vi.spyOn(performance,'now').mockReturnValue(45);vi.setSystemTime(NOW-100000);
 if(mode==='late-receipt-and-exit')child.stdout.emit('data','{"status":"promoted","terminal":true}\n');
 child.emit('exit',0);const error=await result;
 expect(error.message).toMatch(/bounded deadline/);expect(error.stageCleanup).toMatchObject({childExitObserved:true,descendantRetirement:'unproven'});
 expect(child.stdout.destroy).toHaveBeenCalledOnce();expect(child.unref).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('a late promotion-shaped qualification cannot mark the cycle promoted or retire the pending release',async()=>{
 fakeStageTime();vi.setSystemTime(NOW);const dir=fixture(),state=JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')));
 state.pendingReleases=[{id:newRelease.canonical_slug}];state.pendingSemanticReleaseIds=[newRelease.canonical_slug];
 state.pendingSemanticReceipt={runDir:'/private/bound-review',completedAt:new Date(NOW).toISOString()};write(dir,'weekly-model-discovery.json',state);
 const before=fs.readFileSync(path.join(dir,'routing-policy.json')),child=ownedStageChild();
 const result=runWeeklyCycle({routerDir:dir,now:NOW,stage:options=>runCycleStage({...options,timeoutMs:20,spawnHost:()=>child})});
 vi.spyOn(performance,'now').mockReturnValue(45);child.stdout.emit('data','{"status":"promoted","terminal":true}\n');child.emit('exit',0);
 const receipt=await result;expect(receipt).toMatchObject({status:'failed',changed:false,policyApplied:false,reviewExecuted:false});
 expect(JSON.parse(fs.readFileSync(path.join(dir,'weekly-model-discovery.json')))).toEqual(state);expect(fs.readFileSync(path.join(dir,'routing-policy.json'))).toEqual(before);
 expect(JSON.parse(fs.readFileSync(path.join(dir,'weekly-cycle-last-attempt.json')))).toEqual(receipt);
});
