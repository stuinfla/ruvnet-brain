import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { learningFixture } from '../helpers/learning-fixture.mjs';
import { learningContext } from '../../plugin/scripts/runtime-preferences.mjs';
import { superviseLearning } from '../../plugin/scripts/learning-worker-supervisor.mjs';
import { takeQueueLock } from '../../plugin/scripts/learning-queue.mjs';
import { writeAtomic } from '../../plugin/scripts/learning-queue.mjs';
const fixtures=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.cleanup()));
function setup(){const f=learningFixture();fixtures.push(f);const context=learningContext({env:f.env,cwd:f.project});const token=takeQueueLock(context);const child=new EventEmitter();child.pid=999001;child.unref=()=>{};child.connected=false;return{f,context,token,child};}
test.each(['posix','win32'])('failed retirement cannot release the queue fence on %s',async platform=>{
 const {f,context,token,child}=setup();const start=Date.now();const result=await superviseLearning(context,token,Date.now()+20,{env:f.env,platform,spawnEngine:()=>child,killOwned:()=>false,groupAlive:()=>true});
 expect(Date.now()-start).toBeLessThan(1200);expect(result.retirementConfirmed).toBe(false);const lock=JSON.parse(fs.readFileSync(path.join(f.queue,'.worker-lock')));expect(lock.retirementUnconfirmed).toBe(true);expect(takeQueueLock(context,Date.now()+120000)).toBeNull();
});
test('worker crash with a live descendant retires the group before surrendering authority',async()=>{
 const {f,context,token,child}=setup();let live=true;let killed=0;const spawnEngine=()=>{queueMicrotask(()=>child.emit('exit',1));return child;};
 const result=await superviseLearning(context,token,Date.now()+500,{env:f.env,platform:'posix',spawnEngine,groupAlive:()=>live,killOwned:()=>{killed++;live=false;return true;}});
 expect(result.retirementConfirmed).toBe(true);expect(killed).toBe(1);expect(fs.existsSync(path.join(f.queue,'.worker-lock'))).toBe(false);expect(takeQueueLock(context)).toBeTruthy();
});
test('reported completion with no observed exit cannot claim Windows tree retirement',async()=>{
 const {f,context,token,child}=setup();const spawnEngine=()=>{queueMicrotask(()=>child.emit('message',{type:'learning-worker-complete'}));return child;};
 const result=await superviseLearning(context,token,Date.now()+100,{env:f.env,platform:'win32',spawnEngine,killOwned:()=>true,groupAlive:()=>false});expect(result.retirementConfirmed).toBe(false);expect(takeQueueLock(context,Date.now()+120000)).toBeNull();
});
test('diagnostic failure cannot skip mandatory unconfirmed-retirement fencing',async()=>{
 const {f,context,token,child}=setup();const result=await superviseLearning(context,token,Date.now()+10,{env:f.env,platform:'posix',spawnEngine:()=>child,killOwned:()=>false,groupAlive:()=>true,writeDiagnostic:()=>{throw Object.assign(new Error('full'),{code:'ENOSPC'});}});
 expect(result).toEqual({retirementConfirmed:false,fencePersisted:true});expect(takeQueueLock(context,Date.now()+120000)).toBeNull();
});
test('failed fence persistence is reported without claiming durable blocking',async()=>{
 const {f,context,token,child}=setup();let writes=0;const result=await superviseLearning(context,token,Date.now()+10,{env:f.env,platform:'posix',spawnEngine:()=>child,killOwned:()=>false,groupAlive:()=>true,persistFence:(file,body)=>{if(writes++)throw new Error('read-only');writeAtomic(file,body);}});
 expect(result).toEqual({retirementConfirmed:false,fencePersisted:false});const receipt=fs.readdirSync(f.queue).find(name=>name.startsWith('.run-'));expect(JSON.parse(fs.readFileSync(path.join(f.queue,receipt))).reason).toContain('fence persistence failed');
 expect(takeQueueLock(context,Date.now()+120000)).toBeNull();
});
test('no worker launches when its durable retirement requirement cannot be saved',async()=>{
 const {f,context,token}=setup();let launches=0;const result=await superviseLearning(context,token,Date.now()+10,{env:f.env,spawnEngine:()=>{launches++;},persistFence:()=>{throw new Error('read-only');}});
 expect(launches).toBe(0);expect(result).toEqual({retirementConfirmed:true,fencePersisted:false,launched:false});
});
