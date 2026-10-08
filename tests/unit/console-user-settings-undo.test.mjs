// tests/unit/console-user-settings-undo.test.mjs — RNBC QA 2026-10-01.
//
// The Settings card says "every save is reversible". The config.json form returned an undo token;
// the user-settings form (what it learns from, how much it jumps in, may it act, new projects) did
// not, so its saves had no Undo button. Each save is now journalled and reversible exactly once,
// and an undo that would wipe a newer save is refused.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-us-undo-')));
const file = path.join(tmp, '.config', 'ruvnet-brain', 'settings.json');
const saved = {};
let mod;
const read = () => JSON.parse(fs.readFileSync(file, 'utf8')).settings;

beforeAll(async () => {
  for (const k of ['HOME', 'RUVNET_CONSOLE_ROOT', 'RUVNET_BRAIN_TEST', 'RUVNET_SETTINGS_FILE']) saved[k] = process.env[k];
  Object.assign(process.env, { HOME: tmp, RUVNET_CONSOLE_ROOT: tmp, RUVNET_BRAIN_TEST: '1', RUVNET_SETTINGS_FILE: file });
  mod = await import('../../scripts/onboarding-console.mjs');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('user-settings saves are reversible from the console', () => {
  it('first-ever save returns an undo that removes the file, once', () => {
    const r = mod.saveAdvocacy({ advocacy: 1, learningScope: 'user' });
    expect(r.ok, r.log).toBe(true);
    expect(typeof r.undoToken).toBe('string');
    expect(read()).toMatchObject({ advocacy: 1, learningScope: 'user' });
    const u = mod.undo(r.undoToken);
    expect(u.ok, u.log).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(mod.undo(r.undoToken).ok).toBe(false);
  });

  it('a later save makes an earlier undo refuse; the latest undo restores the prior values', () => {
    const a = mod.saveAdvocacy({ advocacy: 2 });
    const b = mod.saveAdvocacy({ advocacy: 5, autoApply: true });
    expect(read()).toMatchObject({ advocacy: 5, autoApply: true });
    const stale = mod.undo(a.undoToken);
    expect(stale.ok).toBe(false);
    expect(read()).toMatchObject({ advocacy: 5 });
    const ok = mod.undo(b.undoToken);
    expect(ok.ok, ok.log).toBe(true);
    expect(read()).toMatchObject({ advocacy: 2, autoApply: false });
  });

  // The journal's `at` stamp has millisecond resolution and two saves DO land in the same millisecond
  // (a fast Linux runner did, 2026-10-01): ordering by timestamp then saw no "later" save and let the
  // stale undo wipe the newer one. Freeze the clock so both saves share one stamp: order must come
  // from the append-only journal itself.
  it('same-millisecond saves: the earlier undo still refuses, the latest still restores', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
    try {
      const a = mod.saveAdvocacy({ advocacy: 3, autoApply: false });
      const b = mod.saveAdvocacy({ advocacy: 4, autoApply: true });
      expect(mod.undo(a.undoToken).ok).toBe(false);
      expect(read()).toMatchObject({ advocacy: 4, autoApply: true });
      const ok = mod.undo(b.undoToken);
      expect(ok.ok, ok.log).toBe(true);
      expect(read()).toMatchObject({ advocacy: 3, autoApply: false });
    } finally { vi.useRealTimers(); }
  });

  it('same-millisecond config.json saves: the earlier undo refuses too', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-01-01T00:00:01.000Z'));
    try {
      const a = mod.saveConfig({ provider: 'codex' });
      const b = mod.saveConfig({ provider: 'openai' });
      expect(a.ok, a.log).toBe(true); expect(b.ok, b.log).toBe(true);
      expect(mod.undo(a.undoToken).ok).toBe(false);
      const ok = mod.undo(b.undoToken);
      expect(ok.ok, ok.log).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

// Actual installed SDK databases; sidecar sentinels below are constructed preservation evidence.
describe('fleet undo never substitutes a newer snapshot or unsafe live restore',()=>{
 it('recorded SDK snapshot A plus newer B refuses with DB/WAL/SHM/snapshots unchanged',async()=>{
  const {initializeMemoryDatabase,storeEntry}=await import(path.join(saved.HOME || os.homedir(),'.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/memory/memory-initializer.js'));
  const db=path.join(tmp,'sdk-project','.swarm','memory.db'),backupDir=path.join(path.dirname(db),'backups'),A=path.join(backupDir,'snapshot-001.db'),B=path.join(backupDir,'snapshot-999.db');
  for(const [file,value]of[[db,'live'],[A,'recorded A'],[B,'newer B']]){fs.mkdirSync(path.dirname(file),{recursive:true});await initializeMemoryDatabase({dbPath:file,migrate:false});await storeEntry({dbPath:file,key:'p043-fixture',namespace:'p043-private',value,generateEmbeddingFlag:false,provenanceType:'system_observation'});}
  fs.writeFileSync(db+'-wal','constructed retained WAL sentinel');fs.writeFileSync(db+'-shm','constructed retained SHM sentinel');
  const files=[db,db+'-wal',db+'-shm',A,B],before=files.map(file=>fs.readFileSync(file));expect(before[0].equals(before[3])).toBe(false);expect(before[3].equals(before[4])).toBe(false);
  const dir=path.join(tmp,'.cache','ruvnet-brain','undo');fs.mkdirSync(dir,{recursive:true});const receipt=path.join(dir,'distill-fleet-sdk.json'),token='p043-sdk-fleet';
  fs.writeFileSync(receipt,JSON.stringify({stores:[{db,name:'SDK fixture',backupDir,snapshot:A}]}));fs.appendFileSync(path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl'),JSON.stringify({token,id:'learning:distill-fleet',kind:'restore-store-backups',receipt})+'\n');
  const result=mod.undo(token);expect(result.ok).toBe(false);expect(result.log).toMatch(/unavailable|offline/i);expect(result.log).toContain(A);files.forEach((file,i)=>expect(fs.readFileSync(file).equals(before[i])).toBe(true));
 });
});

it.each(['missing','outside','symlink','duplicate','broken-receipt'])('fleet undo refuses %s evidence without target mutation',fault=>{
 const root=path.join(tmp,'negative-'+fault),db=path.join(root,'.swarm','memory.db'),backupDir=path.join(path.dirname(db),'backups');fs.mkdirSync(backupDir,{recursive:true});fs.writeFileSync(db,'constructed private target');const snapshot=path.join(backupDir,'snapshot-001.db');fs.writeFileSync(snapshot,'constructed private snapshot');const prior=fs.readFileSync(db);
 const dir=path.join(tmp,'.cache','ruvnet-brain','undo'),receipt=path.join(dir,'distill-fleet-'+fault+'.json'),token='p043-'+fault;let row={db,name:'private',backupDir,snapshot};
 if(fault==='missing')row.snapshot=path.join(backupDir,'absent.db');
 if(fault==='outside'){row.snapshot=path.join(root,'foreign.db');fs.writeFileSync(row.snapshot,'foreign retained bytes');}
 if(fault==='symlink'){row.snapshot=path.join(backupDir,'link.db');fs.symlinkSync(snapshot,row.snapshot);}
 fs.writeFileSync(receipt,fault==='broken-receipt'?'{':JSON.stringify({stores:fault==='duplicate'?[row,row]:[row]}));fs.appendFileSync(path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl'),JSON.stringify({token,id:'learning:distill-fleet',kind:'restore-store-backups',receipt})+'\n');
 expect(mod.undo(token).ok).toBe(false);expect(fs.readFileSync(db).equals(prior)).toBe(true);expect(fs.readFileSync(snapshot,'utf8')).toBe('constructed private snapshot');
});

it('memory-index apply refuses before revalidation, undo journal or child when inverse is unavailable',()=>{
 const journal=path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});if(!fs.existsSync(journal))fs.writeFileSync(journal,'');const before=fs.readFileSync(journal);
 const result=mod.apply(['repair:memory-index']);expect(result.results[0].ok).toBe(false);expect(result.results[0].log).toMatch(/unavailable/i);expect(result.timings.undoJournalMs).toBe(0);expect(result.timings.childRemedyMs).toBe(0);expect(result.timings.revalidationMs).toBe(0);expect(fs.readFileSync(journal).equals(before)).toBe(true);
});
it('memory-index undo keeps SDK DB/rescueA/newerB and constructed sidecars unchanged',async()=>{
 const {initializeMemoryDatabase,storeEntry}=await import(path.join(saved.HOME || os.homedir(),'.npm-global/lib/node_modules/ruflo/node_modules/@claude-flow/cli/dist/src/memory/memory-initializer.js'));
 const db=path.join(tmp,'memory-index-sdk','.swarm','memory.db'),A=db+'.rescue-001',B=db+'.rescue-999';fs.mkdirSync(path.dirname(db),{recursive:true});
 for(const [file,value]of[[db,'live'],[A,'rescueA'],[B,'newerB']]){await initializeMemoryDatabase({dbPath:file,migrate:false});await storeEntry({dbPath:file,key:'p043-memory-fixture',namespace:'p043-private',value,generateEmbeddingFlag:false,provenanceType:'system_observation'});}
 fs.writeFileSync(db+'-wal','constructed WAL sentinel');fs.writeFileSync(db+'-shm','constructed SHM sentinel');const files=[db,A,B,db+'-wal',db+'-shm'],before=files.map(file=>fs.readFileSync(file));expect(before[0].equals(before[2])).toBe(false);
 fs.mkdirSync(path.join(tmp,'.cache','ruvnet-brain'),{recursive:true});fs.appendFileSync(path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl'),JSON.stringify({token:'memory-index-sdk',id:'repair:memory-index',kind:'restore-memory-backup',db})+'\n');const result=mod.undo('memory-index-sdk');expect(result.ok).toBe(false);expect(result.log).toMatch(/unavailable|offline/i);files.forEach((file,i)=>expect(fs.readFileSync(file).equals(before[i])).toBe(true));
});

it('an inverse availability flag cannot authorize an unbound memory target',async()=>{
 const {REMEDIES}=await import('../../scripts/remedy-registry.mjs'),remedy=REMEDIES.find(row=>row.key==='memory-index'),inverse=remedy.inverse;
 const journal=path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});if(!fs.existsSync(journal))fs.writeFileSync(journal,'');const before=fs.readFileSync(journal);
 try{remedy.inverse=()=>({...inverse(),available:true});const result=mod.apply(['repair:memory-index']);expect(result.results[0].ok).toBe(false);expect(result.results[0].log).toMatch(/exact database target/);expect(result.timings.undoJournalMs).toBe(0);expect(result.timings.childRemedyMs).toBe(0);expect(result.timings.revalidationMs).toBe(0);expect(fs.readFileSync(journal).equals(before)).toBe(true);}finally{remedy.inverse=inverse;}
});

it.each(['sync:ruflo','repair:agentdb','reconcile:demo'])('unsupported %s apply refuses before journal/revalidation/child',id=>{
 const journal=path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});if(!fs.existsSync(journal))fs.writeFileSync(journal,'');const before=fs.readFileSync(journal);const result=mod.apply([id]);expect(result.results[0].ok).toBe(false);expect(result.results[0].log).toMatch(/unavailable/i);expect(result.timings.undoJournalMs).toBe(0);expect(result.timings.revalidationMs).toBe(0);expect(result.timings.childRemedyMs).toBe(0);expect(fs.readFileSync(journal).equals(before)).toBe(true);
});
it('old reconcile token never copies newer B settings or consumes its receipt',()=>{
 const project='private-reconcile',dir=path.join(tmp,'Code',project),target=path.join(dir,'.claude','settings.json');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'{"state":"current"}');const A=target+'.bak-reconcile-001',B=target+'.bak-reconcile-999';fs.writeFileSync(A,'{"state":"originalA"}');fs.writeFileSync(B,'{"state":"newerB"}');const files=[target,A,B],before=files.map(file=>fs.readFileSync(file));const journal=path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl');fs.appendFileSync(journal,JSON.stringify({token:'old-reconcile',kind:'restore-backup',project})+'\n');const bytes=fs.readFileSync(journal);const result=mod.undo('old-reconcile');expect(result.ok).toBe(false);expect(result.log).toMatch(/unavailable/);files.forEach((file,i)=>expect(fs.readFileSync(file).equals(before[i])).toBe(true));expect(fs.readFileSync(journal).equals(bytes)).toBe(true);
});

it('legacy package undo refuses before fake npm child and token consumption',()=>{
 const bin=path.join(tmp,'fake-package-bin'),calls=path.join(tmp,'fake-package-calls');fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'npm'),'#!'+process.execPath+'\nrequire("node:fs").appendFileSync('+JSON.stringify(calls)+',"called\\n");\n');fs.chmodSync(path.join(bin,'npm'),0o755);
 const journal=path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});fs.appendFileSync(journal,JSON.stringify({token:'legacy-package',id:'sync:fixture-package',kind:'reinstall-version',pkg:'fixture-package',prevVersion:'1.0.0'})+'\n');const before=fs.readFileSync(journal),priorPath=process.env.PATH;
 try{process.env.PATH=bin+path.delimiter+priorPath;const result=mod.undo('legacy-package');expect(fs.existsSync(calls)).toBe(false);expect(result.ok).toBe(false);expect(result.log).toMatch(/unavailable/);expect(fs.readFileSync(journal).equals(before)).toBe(true);}finally{process.env.PATH=priorPath;}
});

it.each(['purge:shadows','learning:flush','learning:flush-legacy-user','learning:train'])('known unavailable %s cannot create journal or child',id=>{
 const journal=path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});if(!fs.existsSync(journal))fs.writeFileSync(journal,'');const before=fs.readFileSync(journal);const result=mod.apply([id]);expect(result.results[0].ok).toBe(false);expect(result.results[0].log).toMatch(/unavailable/);expect(result.timings.revalidationMs).toBe(0);expect(result.timings.undoJournalMs).toBe(0);expect(result.timings.childRemedyMs).toBe(0);expect(fs.readFileSync(journal).equals(before)).toBe(true);
});
it.each(['learning:flush','learning:flush-legacy-user','learning:train','purge:shadows'])('legacy %s no-op inverse is honestly unavailable and token retained',id=>{
 const journal=path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl');fs.mkdirSync(path.dirname(journal),{recursive:true});fs.appendFileSync(journal,JSON.stringify({token:'legacy-'+id,id,kind:id==='purge:shadows'?'auto-rebuild':'none',human:'old no-op claim'})+'\n');const before=fs.readFileSync(journal),result=mod.undo('legacy-'+id);expect(result.ok).toBe(false);expect(result.log).toMatch(/unavailable/);expect(fs.readFileSync(journal).equals(before)).toBe(true);
});

describe('configuration inverse owner joins use private sentinel owners only',()=>{
 async function owners(state='off'){
  const prefs=await import('../../plugin/scripts/runtime-preferences.mjs'),nightly=await import('../../scripts/nightly-controller.mjs');const pathSecret=path.join(tmp,'fake-encrypted-owner'),backup=pathSecret+'.recorded',marker=path.join(tmp,'fake-scheduler-owner');fs.writeFileSync(pathSecret,'prior encrypted sentinel');fs.writeFileSync(marker,state);let calls=0;
  const spies=[vi.spyOn(prefs,'saveOpenRouterCredential').mockImplementation(()=>{fs.writeFileSync(backup,fs.readFileSync(pathSecret));fs.writeFileSync(pathSecret,'new encrypted sentinel');return{ok:true,path:pathSecret,backup,existed:true};}),vi.spyOn(prefs,'openRouterCredentialStatus').mockReturnValue({present:true,source:'fake-encrypted-owner'}),vi.spyOn(nightly,'nightlyStatus').mockImplementation(()=>({state:fs.readFileSync(marker,'utf8'),artifact:{supported:true},runHealth:{state:'never-ran'}})),vi.spyOn(nightly,'applyNightlyChoice').mockImplementation(enabled=>{calls++;const before={state:fs.readFileSync(marker,'utf8')};fs.writeFileSync(marker,enabled?'on':'off');return{ok:true,before,state:enabled?'on':'off'};})];
  return{pathSecret,backup,marker,get calls(){return calls;},restore(){spies.reverse().forEach(spy=>spy.mockRestore());}};
 }
 it.each(['unknown','degraded'])('nightly prior %s refuses before secret/scheduler/config mutation',async state=>{
  const o=await owners(state),config=path.join(tmp,'.claude','ruvnet-brain','config.json'),before=fs.existsSync(config)?fs.readFileSync(config):null;try{const result=mod.saveConfig({nightly:true,openrouterKey:'sk-or-private-fixture-sentinel'});expect(result.ok).toBe(false);expect(result.log).toMatch(/inverse|prior|unavailable/i);expect(o.calls).toBe(0);expect(fs.readFileSync(o.marker,'utf8')).toBe(state);expect(fs.readFileSync(o.pathSecret,'utf8')).toBe('prior encrypted sentinel');expect(fs.existsSync(o.backup)).toBe(false);expect(fs.existsSync(config)?fs.readFileSync(config).equals(before):before===null).toBe(true);}finally{o.restore();}
 });
 it('valid recorded credential and known nightly inverse restores exact private sentinel owners',async()=>{
  const o=await owners('off');try{const saved=mod.saveConfig({nightly:true,openrouterKey:'sk-or-private-fixture-sentinel'});expect(saved.ok,saved.log).toBe(true);expect(fs.readFileSync(o.marker,'utf8')).toBe('on');expect(fs.readFileSync(o.pathSecret,'utf8')).toBe('new encrypted sentinel');const result=mod.undo(saved.undoToken);expect(result.ok,result.log).toBe(true);expect(fs.readFileSync(o.marker,'utf8')).toBe('off');expect(fs.readFileSync(o.pathSecret,'utf8')).toBe('prior encrypted sentinel');expect(o.calls).toBe(2);}finally{o.restore();}
 });
 it('missing recorded credential backup refuses undo before config mutation/token consumption',async()=>{
  const o=await owners('off');try{const saved=mod.saveConfig({provider:'codex',openrouterKey:'sk-or-private-fixture-sentinel'});expect(saved.ok,saved.log).toBe(true);fs.rmSync(o.backup);const config=path.join(tmp,'.claude','ruvnet-brain','config.json'),journal=path.join(tmp,'.cache','ruvnet-brain','console-undo.jsonl'),before=fs.readFileSync(config),record=fs.readFileSync(journal);const result=mod.undo(saved.undoToken);expect(result.ok).toBe(false);expect(result.log).toMatch(/credential.*backup|inverse.*unavailable/i);expect(fs.readFileSync(config).equals(before)).toBe(true);expect(fs.readFileSync(journal).equals(record)).toBe(true);expect(fs.readFileSync(o.pathSecret,'utf8')).toBe('new encrypted sentinel');}finally{o.restore();}
 });
});
