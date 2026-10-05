import { test, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeAgentLaunch, decideViaEngine, loadNativeModels, loadScope } from '../../scripts/model-router-agent-hook.mjs';

const model='gpt-fixture-sol';
const decide=vi.fn(()=>({harness:'codex',model,effort:'medium',taskClass:'medium',subscriptionCovered:true}));
const nativeModels=()=>[{slug:model,multi_agent_version:'v2',supported_reasoning_levels:[{effort:'medium'}]}];
const input={message:'implement private API',task_name:'api',fork_turns:'3',agent_type:'worker',resource:{lease:'unchanged'},run_in_background:true};
const event={hook_event_name:'PreToolUse',tool_name:'spawn_agent',tool_input:input};
const hook=(ev=event,opts={})=>routeAgentLaunch(ev,{harness:'codex',decide,nativeModels,scope:()=>({enabled:true,strict:true}),...opts});

test('supported native v2 launch rewrites model and effort preserving complete input/context',()=>{
  const result=hook().hookSpecificOutput;
  expect(result).toMatchObject({hookEventName:'PreToolUse',permissionDecision:'allow'});
  expect(result.updatedInput).toEqual({...input,model,reasoning_effort:'medium'});
  expect(event.tool_input).toEqual(input);
  expect(decide).toHaveBeenCalledWith(input.message,'codex');
});
test('full-history context is never silently dropped to make a model override fit',()=>{
  for(const fork_turns of [undefined,'all','ALL','']){
    const args={...input};if(fork_turns===undefined)delete args.fork_turns;else args.fork_turns=fork_turns;
    const result=hook({...event,tool_input:args}).hookSpecificOutput;
    expect(result.permissionDecision).toBe('deny');expect(result.updatedInput).toBeUndefined();
    expect(args.fork_turns).toBe(fork_turns);
  }
  expect(hook({...event,tool_input:{...input,fork_turns:'none'}}).hookSpecificOutput.permissionDecision).toBe('allow');
});
test('stale policy, unsupported native model/effort, invalid task and fork inputs deny',()=>{
  expect(hook(event,{decide:()=>{throw Error('private raw task');}}).hookSpecificOutput.permissionDecision).toBe('deny');
  expect(hook(event,{nativeModels:()=>[]}).hookSpecificOutput.permissionDecision).toBe('deny');
  expect(hook(event,{nativeModels:()=>[{slug:model,multi_agent_version:'disabled',supported_reasoning_levels:[{effort:'medium'}]}]}).hookSpecificOutput.permissionDecision).toBe('deny');
  expect(hook(event,{decide:()=>({harness:'codex',model,effort:'none',taskClass:'medium',subscriptionCovered:true})}).hookSpecificOutput.permissionDecision).toBe('deny');
  for(const args of [{...input,message:''},{...input,fork_turns:'0'},{...input,fork_context:false}]){
    expect(hook({...event,tool_input:args}).hookSpecificOutput.permissionDecision).toBe('deny');
  }
});
test('unrelated tools and non-PreToolUse events do not touch routing or permissions',()=>{
  const untouched=vi.fn();
  expect(hook({...event,tool_name:'Bash'},{decide:untouched})).toEqual({});
  expect(hook({...event,hook_event_name:'PostToolUse'},{decide:untouched})).toEqual({});
  expect(untouched).not.toHaveBeenCalled();
});
test('Claude no per-call effort schema advises without blocking workflows or inventing fields',()=>{
  const result=routeAgentLaunch({hook_event_name:'PreToolUse',tool_name:'Agent',tool_input:{prompt:'summarize private notes',model:'opus',subagent_type:'researcher'}},
    {harness:'claude-code',scope:()=>({enabled:true,strict:true}),decide:()=>({harness:'claude-code',model:'claude-fixture-sonnet',effort:'low',taskClass:'fast',subscriptionCovered:true})});
  expect(result.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(result.hookSpecificOutput.updatedInput).toBeUndefined();
  expect(result.hookSpecificOutput.additionalContext).toContain('per-call schema');
  expect(JSON.stringify(result)).not.toContain('private notes');
});
test('engine subprocess receives task through stdin with bounded policy-only arguments',()=>{
  const run=vi.fn(()=>JSON.stringify({model}));
  expect(decideViaEngine('private task','codex',{engine:'/fixture/engine.mjs',run})).toEqual({model});
  expect(run.mock.calls[0][1]).toEqual(['/fixture/engine.mjs','--harness','codex','--policy-only','--json']);
  expect(run.mock.calls[0][2]).toMatchObject({input:'private task',timeout:2000,stdio:['pipe','pipe','pipe']});
});
test('real hook subprocess returns bounded JSON using engine fixture without inference',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-hook-'));
  try{
    const engine=path.join(tmp,'engine.mjs');
    fs.writeFileSync(engine,`import fs from 'node:fs'; fs.readFileSync(0,'utf8'); process.stdout.write(${JSON.stringify(JSON.stringify({harness:'codex',model,effort:'medium',taskClass:'medium',subscriptionCovered:true}))});`);
    const scope={nativeAgentRouting:{codex:{enabled:true,strict:true}}};
    fs.writeFileSync(path.join(tmp,'profile.json'),JSON.stringify(scope));
    fs.writeFileSync(path.join(tmp,'routing-policy.json'),JSON.stringify(scope));
    const cache=path.join(tmp,'models.json');fs.writeFileSync(cache,JSON.stringify({models:nativeModels()}));
    expect(loadNativeModels(cache)).toEqual(nativeModels());
    const codex=path.join(tmp,'codex.mjs');
    const preload=path.join(tmp,'native-spawn.cjs');
    fs.writeFileSync(preload,`const cp=require('node:child_process'); const spawn=cp.spawn; cp.spawn=(cmd,args,opts)=>cmd==='codex'?spawn(process.execPath,[${JSON.stringify(codex)},...args],opts):spawn(cmd,args,opts); require('node:module').syncBuiltinESMExports();`);
    fs.writeFileSync(codex,`#!${process.execPath}\nimport readline from 'node:readline'; const lines=readline.createInterface({input:process.stdin}); lines.on('line',line=>{const r=JSON.parse(line);if(r.id)process.stdout.write(JSON.stringify({id:r.id,result:r.id===1?{}:{ordinaryUsageAllowed:true}})+'\\n');});`,{mode:0o755});
    const raw=execFileSync(process.execPath,['--require',preload,'scripts/model-router-agent-hook.mjs','--harness','codex'],{
      input:JSON.stringify(event),encoding:'utf8',env:{...process.env,PATH:tmp,MODEL_ROUTER_ENGINE:engine,MODEL_ROUTER_NATIVE_MODELS:cache,MODEL_ROUTER_PROFILE:path.join(tmp,'profile.json'),MODEL_ROUTER_SELECTION:path.join(tmp,'routing-policy.json')},
    });
    expect(JSON.parse(raw).hookSpecificOutput.updatedInput).toEqual({...input,model,reasoning_effort:'medium'});
    expect(fs.readdirSync(tmp).sort()).toEqual(['codex.mjs','engine.mjs','models.json','native-spawn.cjs','profile.json','routing-policy.json']);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('agent routing requires explicit per-user and reviewed scope opt-in',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-scope-'));
  try{
    const enabled={nativeAgentRouting:{codex:{enabled:true,strict:true}}};
    expect(loadScope('codex',{routerDir:tmp})).toEqual({enabled:false,strict:false});
    fs.writeFileSync(path.join(tmp,'profile.json'),JSON.stringify(enabled));
    fs.writeFileSync(path.join(tmp,'routing-policy.json'),'{}');
    expect(loadScope('codex',{routerDir:tmp}).enabled).toBe(false);
    fs.writeFileSync(path.join(tmp,'routing-policy.json'),JSON.stringify(enabled));
    expect(loadScope('codex',{routerDir:tmp})).toEqual({enabled:true,strict:true});
    expect(hook(event,{scope:()=>({enabled:false,strict:false})})).toEqual({});
    expect(hook({...event,tool_input:{...input,fork_turns:'all'}},{scope:()=>({enabled:true,strict:false})}).hookSpecificOutput.permissionDecision).toBeUndefined();
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('full-fork match uses observed parent evidence and never trusts requested override fields',()=>{
  const ev={...event,tool_input:{...input,fork_turns:'all',model,reasoning_effort:'medium'}};
  expect(hook(ev).hookSpecificOutput.permissionDecision).toBe('deny');
  const result=hook(ev,{parentState:{observed:true,model,effort:'medium'}}).hookSpecificOutput;
  expect(result.permissionDecision).toBeUndefined();
  expect(result.updatedInput).toBeUndefined();
  expect(result.additionalContext).toContain('already matches');
});

test('Claude classification failure remains advisory even when strict opt-in is requested',()=>{
  const result=routeAgentLaunch({tool_name:'Agent',tool_input:{prompt:'private'}},{harness:'claude-code',scope:()=>({enabled:true,strict:true}),decide:()=>{throw Error('stale');}});
  expect(result.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(result.hookSpecificOutput.additionalContext).toContain('allocation unavailable');
});

test('substantial native agent selection carries Sol high, exceptional xhigh requires named reason',()=>{
  const models=()=>[{slug:model,multi_agent_version:'v2',supported_reasoning_levels:[{effort:'high'},{effort:'xhigh'}]}];
  const substantial=hook(event,{nativeModels:models,decide:()=>({harness:'codex',model,effort:'high',taskClass:'substantial',subscriptionCovered:true})});
  expect(substantial.hookSpecificOutput.updatedInput.reasoning_effort).toBe('high');
  const exceptional=hook(event,{nativeModels:models,decide:()=>({harness:'codex',model,effort:'xhigh',taskClass:'exceptional',exceptionalReason:'cryptographic-proof',subscriptionCovered:true})});
  expect(exceptional.hookSpecificOutput.additionalContext).toContain('cryptographic-proof');
  const unnamed=hook(event,{nativeModels:models,decide:()=>({harness:'codex',model,effort:'xhigh',taskClass:'exceptional',subscriptionCovered:true})});
  expect(unnamed.hookSpecificOutput.permissionDecision).toBe('deny');
});
