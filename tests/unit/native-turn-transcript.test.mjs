import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeTurnLines } from '../../plugin/scripts/native-turn-transcript.mjs';
import { collectTurnEvents } from '../../plugin/scripts/continuity-events.mjs';
import { captureTurnOutcome, runSteps, resolveTurnDb, turnCapturePolicyFile } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { captureContinuityEvents, ContinuityJournal, drain } from '../../plugin/scripts/continuity-journal.mjs';
import { adoptedProject, cleanup, fakeRuflo } from '../helpers/continuity-fixture.mjs';
const ri = payload => JSON.stringify({ type: 'response_item', payload });
const outcome = 'Decision: retain the native lifecycle source and make the canonical AgentDB journal recoverable. '.repeat(3);
const lines = [
  ri({ type: 'message', role: 'user', content: [{type:'input_text',text:'PRIVATE USER PROMPT. From now on, retain exact receipts.'}] }),
  ri({ type: 'function_call', name: 'exec_command', call_id:'call-a', arguments:JSON.stringify({cmd:'npm test'}) }),
  ri({ type: 'function_call_output', call_id:'call-a', output:JSON.stringify({session_id:123,output:'running'}) }),
  ri({ type: 'function_call', name: 'write_stdin', call_id:'call-b', arguments:JSON.stringify({session_id:123}) }),
  ri({ type: 'function_call_output', call_id:'call-b', output:JSON.stringify({exit_code:0,output:'Tests 12 passed'}) }),
  ri({ type: 'message', role:'assistant',channel:'final',content:[{type:'output_text',text:outcome}] }),
  '{"type":"response_item","payload":',
];
afterEach(cleanup);
describe('bounded native Codex lifecycle capture', () => {
  it('correlates completed native tool outputs, ignores torn records, retains only unconfirmed corrections', () => {
    const events = collectTurnEvents({lines,host:'codex',session:'s',project:'p'});
    expect(events.filter(e=>e.kind==='gate').map(e=>e.detail.outcome)).toEqual(['unknown','pass']);
    expect(events.find(e=>e.kind==='decision')).toMatchObject({ authoritative:false,detail:{status:'detected-unconfirmed'} });
    expect(events.find(e=>e.kind==='lesson')).toMatchObject({authoritative:false,summary:'From now on, retain exact receipts.'});
    expect(JSON.stringify(events)).not.toContain('PRIVATE USER PROMPT');
    expect(nativeTurnLines(['not-json'], 'codex')).toEqual([]);
  });
  it('reads actual SessionEnd transcript payload without last_assistant_message and deduplicates later Stop', () => {
    const p=adoptedProject();const transcript=path.join(p.dir,'native.jsonl');fs.writeFileSync(transcript,lines.join('\n'));
    const env={RUFLO_BIN:process.execPath,RUVNET_BRAIN_HOME:path.join(p.home,'.cache','ruvnet-brain')};const launch=()=>({launched:true});
    const opts={projectDir:p.dir,home:p.home,env,event:'SessionEnd',host:'codex',ruflo:'/fake/ruflo',launch,
      payload:{session_id:'s',transcript_path:transcript,last_assistant_message:null}};
    const end=captureTurnOutcome(opts);expect(end.queued).toBe(true);expect(end.value).toContain(outcome.slice(0,80));
    expect(end.value).not.toContain('PRIVATE USER PROMPT');
    expect(captureTurnOutcome({...opts,event:'Stop'}).skipped).toContain('same turn outcome');
    const events=captureContinuityEvents({...opts,launch:()=>false});expect(events.recorded).toBeGreaterThan(0);
    const repeat=captureContinuityEvents({...opts,event:'Stop',launch:()=>false});expect(repeat.recorded).toBe(0);
  });
  it('requires native insert and exact readback before acknowledging a durable turn', () => {
    const p=adoptedProject();const env={RUFLO_BIN:process.execPath,RUVNET_BRAIN_HOME:path.join(p.home,'.cache','ruvnet-brain')};let queued;
    const brainHome=path.join(p.home,'.cache','ruvnet-brain');
    const turn=captureTurnOutcome({projectDir:p.dir,brainHome,env,host:'codex',event:'SessionEnd',ruflo:'/fake/ruflo',payload:{session_id:'s',last_assistant_message:outcome},launch:steps=>{queued=steps;}});
    let reads=0;const refused=runSteps({steps:queued.filter(s=>s.kind==='store')},{projectDir:p.dir,brainHome,env,
      read:()=>++reads===1?null:turn.value,run:()=>({status:1,stderr:'native writer refused'})});
    expect(refused[0]).toMatchObject({status:1,verified:false});
    let args;const success=runSteps({steps:queued.filter(s=>s.kind==='store')},{projectDir:p.dir,brainHome,env,
      read:()=>null,run:(_,a)=>{args=a;return {status:0};}});
    expect(args).toContain('--require-native');expect(args).toContain('--append-only');expect(args).toContain('--no-upsert');expect(success[0].verified).toBe(false);
  });
  it('recovers event_msg native final output when its response record is torn', () => {
    const transcript=[ri({type:'message',role:'user',content:[{type:'input_text',text:'older turn'}]}),
      JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'current private intent'}}),
      JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'Decision: keep a durable retry.'}}),'{broken'];
    const events=collectTurnEvents({lines:transcript,host:'codex',session:'s'});expect(events).toHaveLength(1);expect(events[0].summary).toBe('Decision: keep a durable retry.');
  });
  it('persisted user default enrolls only when no project/path override applies', () => {
    const p=adoptedProject();const brainHome=path.join(p.home,'brain');
    const file=turnCapturePolicyFile(brainHome);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,default:'on',projects:{},paths:{[p.dir]:'off'}}));
    expect(resolveTurnDb({projectDir:p.dir,brainHome}).skipped).toBe('persisted turn capture opt-out');
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,default:'on',projects:{}}));
    expect(resolveTurnDb({projectDir:p.dir,brainHome}).optedIn).toBe(true);
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,default:'invalid',projects:{}}));
    expect(resolveTurnDb({projectDir:p.dir,brainHome}).skipped).toContain('invalid');
  });
  it('global default cannot enroll an absent non-Git store without explicit project consent', () => {
    const p=adoptedProject();fs.rmSync(path.join(p.dir,'.git'),{recursive:true});fs.rmSync(path.join(p.dir,'.swarm'),{recursive:true});
    const brainHome=path.join(p.home,'brain'),file=turnCapturePolicyFile(brainHome);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,default:'on',projects:{}}));
    expect(resolveTurnDb({projectDir:p.dir,brainHome}).skipped).toContain('explicit project/path');
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,default:'on',projects:{[p.dir]:'on'}}));
    expect(resolveTurnDb({projectDir:p.dir,brainHome}).optedIn).toBe(true);
  });
  it('global default cannot bypass safe-root eligibility through the turn worker', () => {
    const p=adoptedProject();fs.rmSync(path.join(p.dir,'.swarm'),{recursive:true});
    const brainHome=path.join(p.home,'brain'),file=turnCapturePolicyFile(brainHome);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,default:'on',projects:{}}));
    expect(resolveTurnDb({projectDir:p.dir,brainHome}).skipped).toContain('safe Git project root');
    expect(fs.existsSync(path.join(p.dir,'.swarm'))).toBe(false);
    fs.writeFileSync(file,JSON.stringify({schemaVersion:1,default:'on',projects:{[p.dir]:'on'}}));
    expect(resolveTurnDb({projectDir:p.dir,brainHome}).optedIn).toBe(true);
  });
  it('keeps short detected decisions independent of the turn outcome threshold', () => {
    const events=collectTurnEvents({lastAssistantMessage:'Decision: retain append-only native capture.',host:'codex',session:'s'});
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({kind:'decision',authoritative:false});
  });
  it('refuses to treat an unreadable outbox as an empty history', () => {
    const p=adoptedProject();const j=new ContinuityJournal({projectRoot:p.dir,projectDir:p.dir,env:p.env,ruflo:'/fake'});
    fs.mkdirSync(j.path);expect(()=>j.scan()).toThrow('outbox unreadable');
  });
  it('reports native distillation unavailable without calling it completed', () => {
    const p=adoptedProject();const brainHome=path.join(p.home,'brain');const env={RUFLO_BIN:process.execPath};let steps;
    captureTurnOutcome({projectDir:p.dir,brainHome,env,host:'codex',event:'SessionEnd',ruflo:'/fake',payload:{session_id:'s'},launch:queued=>{steps=queued;}});
    const rows=runSteps({steps:steps.filter(s=>s.kind==='distill')},{projectDir:p.dir,brainHome,env,run:()=>({status:0,stdout:'Distillation skipped\nskipped: better-sqlite3 unavailable\n'})});
    expect(rows[0]).toMatchObject({status:0,skipped:'better-sqlite3 unavailable'});expect(rows[0].verified).toBeUndefined();
  });
  it('native refusal with coincident matching readback remains pending until a later verified replay', () => {
    const p=adoptedProject();const r=fakeRuflo();const j=new ContinuityJournal({projectRoot:p.dir,projectDir:p.dir,env:p.env,ruflo:r.bin});
    const event=collectTurnEvents({lastAssistantMessage:outcome,host:'codex',session:'s',project:'p'})[0];j.record([event]);
    const value=JSON.stringify(j.pending()[0].event);let calls=0;
    const refused=drain(j,{store:()=>({status:1,output:'native writer refused'}),readBack:()=>({content:++calls===1?null:value}),budgetMs:100,backoff:[1000],sleep:()=>{}});
    expect(refused).toMatchObject({committed:0,remaining:1});
    const recovered=drain(j,{store:()=>({status:0}),readBack:()=>({content:value,readPath:'ruflo-cli'}),backoff:[0],sleep:()=>{}});
    expect(recovered).toMatchObject({committed:1,remaining:0});
  });
});
