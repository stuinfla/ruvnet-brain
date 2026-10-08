import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { learningFixture } from '../helpers/learning-fixture.mjs';
import { learningContext } from '../../plugin/scripts/runtime-preferences.mjs';
import { superviseLearning } from '../../plugin/scripts/learning-worker-supervisor.mjs';
import { takeQueueLock } from '../../plugin/scripts/learning-queue.mjs';
import { writeAtomic } from '../../plugin/scripts/learning-queue.mjs';
const fixtures=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.cleanup()));
function setup(){const f=learningFixture();fixtures.push(f);const context=learningContext({env:f.env,cwd:f.project});const token=takeQueueLock(context);const child=new EventEmitter();child.pid=999001;child.unref=()=>{};child.connected=false;return{f,context,token,child};}
test.each(['posix','win32'])('failed retirement cannot release the queue fence on %s',async platform=>{
 const {f,context,token,child}=setup();const original=f.write('pending','{"kind":"original"}\n');const bytes=fs.readFileSync(original);
 // This injected child/group proof measures the timer contract, not host scheduling or native retirement.
 vi.useFakeTimers();
 try {
  const start=Date.now(),pending=superviseLearning(context,token,start+20,{env:f.env,platform,spawnEngine:()=>child,killOwned:()=>false,groupAlive:()=>true});
  await vi.advanceTimersByTimeAsync(650);const result=await pending;
  expect(Date.now()-start).toBeLessThan(1200);expect(result.retirementConfirmed).toBe(false);const lock=JSON.parse(fs.readFileSync(path.join(f.queue,'.worker-lock')));expect(lock.retirementUnconfirmed).toBe(true);expect(takeQueueLock(context,Date.now()+120000)).toBeNull();expect(fs.readFileSync(original).equals(bytes)).toBe(true);expect(fs.readdirSync(f.queue).some(name=>name.startsWith('.ack'))).toBe(false);
 } finally { vi.useRealTimers(); }
});
test('worker crash may retire its group but cannot surrender unknown tree authority',async()=>{
 const {f,context,token,child}=setup();let live=true;let killed=0;const spawnEngine=()=>{queueMicrotask(()=>child.emit('exit',1));return child;};
 const result=await superviseLearning(context,token,Date.now()+500,{env:f.env,platform:'posix',spawnEngine,groupAlive:()=>live,killOwned:()=>{killed++;live=false;return true;}});
 expect(result.retirementConfirmed).toBe(false);expect(result.groupRetired).toBe(true);expect(killed).toBe(1);expect(fs.existsSync(path.join(f.queue,'.worker-lock'))).toBe(true);expect(takeQueueLock(context)).toBeNull();
});
test('reported completion with no observed exit cannot claim Windows tree retirement',async()=>{
 const {f,context,token,child}=setup();const spawnEngine=()=>{queueMicrotask(()=>child.emit('message',{type:'learning-worker-complete'}));return child;};
 const result=await superviseLearning(context,token,Date.now()+100,{env:f.env,platform:'win32',spawnEngine,killOwned:()=>true,groupAlive:()=>false});expect(result.retirementConfirmed).toBe(false);expect(takeQueueLock(context,Date.now()+120000)).toBeNull();
});
test('diagnostic failure cannot skip mandatory unconfirmed-retirement fencing',async()=>{
 const {f,context,token,child}=setup();const result=await superviseLearning(context,token,Date.now()+10,{env:f.env,platform:'posix',spawnEngine:()=>child,killOwned:()=>false,groupAlive:()=>true,writeDiagnostic:()=>{throw Object.assign(new Error('full'),{code:'ENOSPC'});}});
 expect(result).toMatchObject({retirementConfirmed:false,fencePersisted:true,retirementState:'UNKNOWN',treeVerified:false});expect(takeQueueLock(context,Date.now()+120000)).toBeNull();
});
test('failed fence persistence is reported without claiming durable blocking',async()=>{
 const {f,context,token,child}=setup();let writes=0;const result=await superviseLearning(context,token,Date.now()+10,{env:f.env,platform:'posix',spawnEngine:()=>child,killOwned:()=>false,groupAlive:()=>true,persistFence:(file,body)=>{if(writes++)throw new Error('read-only');writeAtomic(file,body);}});
 expect(result).toMatchObject({retirementConfirmed:false,fencePersisted:false,retirementState:'UNKNOWN',treeVerified:false});const receipt=fs.readdirSync(f.queue).find(name=>name.startsWith('.run-'));expect(JSON.parse(fs.readFileSync(path.join(f.queue,receipt))).reason).toContain('fence persistence failed');
 expect(takeQueueLock(context,Date.now()+120000)).toBeNull();
});
test('no worker launches when its durable retirement requirement cannot be saved',async()=>{
 const {f,context,token}=setup();let launches=0;const result=await superviseLearning(context,token,Date.now()+10,{env:f.env,spawnEngine:()=>{launches++;},persistFence:()=>{throw new Error('read-only');}});
 expect(launches).toBe(0);expect(result).toEqual({retirementConfirmed:true,fencePersisted:false,launched:false});
});

test('P033 trusted completion retains bounded group-only semantics, never full tree proof',async()=>{
 const {f,context,token,child}=setup();let live=true;
 const result=await superviseLearning(context,token,Date.now()+500,{env:f.env,platform:'posix',spawnEngine:()=>{queueMicrotask(()=>child.emit('message',{type:'learning-worker-complete'}));return child;},killOwned:()=>{live=false;return true;},groupAlive:()=>live});
 expect(result).toMatchObject({retirementConfirmed:true,groupRetired:true,retirementState:'GROUP_ONLY',retirementScope:'owned-process-group',treeVerified:false});
 expect(fs.existsSync(path.join(f.queue,'.worker-lock'))).toBe(false);
});


test('P033 deadline retirement cannot be upgraded by late completion during group polling',async()=>{
 const {f,context,token,child}=setup();const file=f.write('late-original','{"kind":"original"}\n'),bytes=fs.readFileSync(file);let live=true,lateDelivered=false;
 const result=await superviseLearning(context,token,Date.now()+10,{env:f.env,platform:'posix',spawnEngine:()=>child,killOwned:()=>{
  setTimeout(()=>{lateDelivered=true;child.emit('message',{type:'learning-worker-complete'});live=false;},5);return true;
 },groupAlive:()=>live});
 expect(lateDelivered).toBe(true);expect(result).toMatchObject({groupRetired:true,retirementConfirmed:false,retirementState:'UNKNOWN',treeVerified:false});
 expect(JSON.parse(fs.readFileSync(path.join(f.queue,'.worker-lock'))).retirementUnconfirmed).toBe(true);
 expect(takeQueueLock(context,Date.now()+120000)).toBeNull();expect(fs.readFileSync(file)).toEqual(bytes);
});

test('P033 completion delivered after absolute deadline before timer callback remains UNKNOWN',async()=>{
 const {f,context,token,child}=setup();const deadline=Date.now()+20;
 const result=await superviseLearning(context,token,deadline,{env:f.env,platform:'posix',spawnEngine:()=>{
  queueMicrotask(()=>{while(Date.now()<=deadline){}child.emit('message',{type:'learning-worker-complete'});});return child;
 },killOwned:()=>true,groupAlive:()=>false});
 expect(result).toMatchObject({groupRetired:true,retirementConfirmed:false,retirementState:'UNKNOWN',treeVerified:false});
 expect(JSON.parse(fs.readFileSync(path.join(f.queue,'.worker-lock'))).retirementUnconfirmed).toBe(true);
 expect(takeQueueLock(context,Date.now()+120000)).toBeNull();
});
