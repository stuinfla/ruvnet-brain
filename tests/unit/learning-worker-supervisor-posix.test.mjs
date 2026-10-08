// Physical POSIX process-group proofs: selected only by the POSIX qualification contract.
// Cross-platform injected timer/fence cases remain in learning-worker-supervisor.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';
import { learningFixture } from '../helpers/learning-fixture.mjs';
import { learningContext } from '../../plugin/scripts/runtime-preferences.mjs';
import { superviseLearning } from '../../plugin/scripts/learning-worker-supervisor.mjs';
import { takeQueueLock } from '../../plugin/scripts/learning-queue.mjs';
const fixtures=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.cleanup()));

test('actual POSIX grouped descendant is killed after root exit but tree authority remains UNKNOWN',async()=>{
 const f=learningFixture();fixtures.push(f);const context=learningContext({env:f.env,cwd:f.project}),token=takeQueueLock(context);
 const original=f.write('pending-real','{"kind":"original-retained"}\n'),bytes=fs.readFileSync(original),pidFile=path.join(f.root,'descendant.pid');let pid,liveAfterRootExit=false;
 const code="const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));setTimeout(()=>process.exit(1),60);";
 try {
  const result=await superviseLearning(context,token,Date.now()+2000,{env:f.env,spawnEngine:()=>{const child=spawn(process.execPath,['-e',code,pidFile],{detached:true,stdio:'ignore',env:f.env});pid=child.pid;return child;},killOwned:owned=>{process.kill(-owned,0);liveAfterRootExit=true;process.kill(-owned,'SIGKILL');return true;}});
  expect(liveAfterRootExit).toBe(true);expect(result.retirementConfirmed).toBe(false);expect(result.groupRetired).toBe(true);expect(fs.existsSync(path.join(f.queue,'.worker-lock'))).toBe(true);expect(fs.readFileSync(original).equals(bytes)).toBe(true);expect(takeQueueLock(context)).toBeNull();
 }finally{if(pid)try{process.kill(-pid,'SIGKILL');}catch{}}
});

test('P033 unexpected owned root exit retains UNKNOWN fence while its escaped child is still alive',async()=>{
 const f=learningFixture();fixtures.push(f);const context=learningContext({env:f.env,cwd:f.project});const token=takeQueueLock(context);
 const file=f.write('retained-escape','{"kind":"original"}\n'),bytes=fs.readFileSync(file),pidFile=path.join(f.root,'escape.pid');let rootPid,escaped;
 const code="const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));c.unref();setTimeout(()=>process.exit(1),100);";
 try{
  const result=await superviseLearning(context,token,Date.now()+2000,{env:f.env,spawnEngine:()=>{const child=spawn(process.execPath,['-e',code,pidFile],{detached:true,stdio:'ignore',env:f.env});rootPid=child.pid;return child;}});
  escaped=Number(fs.readFileSync(pidFile,'utf8'));expect(()=>process.kill(escaped,0)).not.toThrow();
  expect(result.retirementConfirmed).toBe(false);expect(result.treeVerified).toBe(false);expect(result.retirementState).toBe('UNKNOWN');
  expect(JSON.parse(fs.readFileSync(path.join(f.queue,'.worker-lock'))).retirementUnconfirmed).toBe(true);
  expect(takeQueueLock(context,Date.now()+120000)).toBeNull();expect(fs.readFileSync(file)).toEqual(bytes);
 }finally{if(escaped)try{process.kill(escaped,'SIGKILL');}catch{}if(rootPid)try{process.kill(-rootPid,'SIGKILL');}catch{}}
});
