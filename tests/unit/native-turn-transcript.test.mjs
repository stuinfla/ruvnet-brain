import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeTurnLines } from '../../plugin/scripts/native-turn-transcript.mjs';
import { collectTurnEvents } from '../../plugin/scripts/continuity-events.mjs';
import { captureTurnOutcome, claudeTurn, runSteps, resolveTurnDb, turnCapturePolicyFile } from '../../plugin/scripts/turn-outcome-capture.mjs';
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
  it('reports native distillation unavailable without calling it completed', () => {
    const p=adoptedProject();const brainHome=path.join(p.home,'brain');const env={RUFLO_BIN:process.execPath};let steps;
    captureTurnOutcome({projectDir:p.dir,brainHome,env,host:'codex',event:'SessionEnd',ruflo:'/fake',payload:{session_id:'s'},launch:queued=>{steps=queued;}});
    const rows=runSteps({steps:steps.filter(s=>s.kind==='distill')},{projectDir:p.dir,brainHome,env,run:()=>({status:0,stdout:'Distillation skipped\nskipped: better-sqlite3 unavailable\n'})});
    expect(rows[0]).toMatchObject({status:0,skipped:'better-sqlite3 unavailable'});expect(rows[0].verified).toBeUndefined();
  });
});

// #430: a Codex rollout whose closing answer survives only as event_msg task_complete (or the
// item_completed AgentMessage) must still be captured at native SessionEnd, once.
describe('Codex native SessionEnd outcome from task_complete (#430)', () => {
  const ev = payload => JSON.stringify({ type: 'event_msg', payload });
  const PROMPT = 'PRIVATE USER PROMPT 430 do not store';
  const rollout = [
    ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] }),
    ev({ type: 'task_started', turn_id: 't1' }),
    ev({ type: 'task_complete', turn_id: 't1', last_agent_message: outcome }),
  ];
  it('maps task_complete.last_agent_message into the current turn', () => {
    expect(claudeTurn(nativeTurnLines(rollout, 'codex')).finalText).toBe(outcome.trim());
  });
  it('the same answer in response_item, AgentMessage and task_complete counts once', () => {
    const short = 'Done: the fixture order is violet latch, then hatch 23.';
    const turn = claudeTurn(nativeTurnLines([rollout[0],
      ev({ type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: short }] } }),
      ri({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: short }] }),
      ev({ type: 'task_complete', last_agent_message: short })], 'codex'));
    expect(turn.finalText).toBe(short);
  });
  it('SessionEnd without last_assistant_message stores the outcome, never the prompt', () => {
    const p = adoptedProject(); const brainHome = path.join(p.home, 'brain');
    const file = path.join(p.home, 'rollout.jsonl'); fs.writeFileSync(file, rollout.join('\n') + '\n');
    const written = [];
    const report = captureTurnOutcome({ projectDir: p.dir, brainHome, env: { RUFLO_BIN: process.execPath }, host: 'codex', event: 'SessionEnd',
      ruflo: '/fake', payload: { session_id: 'codex-exec-430', transcript_path: file }, launch: () => ({ launched: true }),
      write: ({ steps }) => { written.push(...steps); return steps.map(() => ({ status: 0, verified: true })); } });
    expect(report.skipped).toBeUndefined();
    expect(report.recorded).toBe(true);
    const value = written[0].args[written[0].args.indexOf('--value') + 1];
    expect(value).toContain('Decision: retain the native lifecycle source');
    expect(value).not.toContain(PROMPT);
  });
});
