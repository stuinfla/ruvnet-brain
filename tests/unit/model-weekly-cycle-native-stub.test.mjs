import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {runWeeklyCycle} from '../../scripts/model-weekly-cycle.mjs';
// POSIX only: the native stubs are #!/bin/sh scripts, so the release contract lists this file for linux and macos.
const dirs=[],NOW=Date.now(),WEEK=604800000;const write=(d,f,v)=>fs.writeFileSync(path.join(d,f),JSON.stringify(v));
const releases=[{id:'openai/sol-20261001',provider:'openai',aliases:['openai/sol']},{id:'anthropic/sonnet-20261001',provider:'anthropic',aliases:['anthropic/sonnet']}];
function inventory(extra=[]){return JSON.stringify({data:[...Array.from({length:50},(_,i)=>({id:'other/model'+i})),...releases.map(r=>({id:r.aliases[0],canonical_slug:r.id,architecture:{output_modalities:['text']}})),...extra]});}
const fetcher=(body=inventory())=>vi.fn(async()=>({ok:true,text:async()=>body}));
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
// fixtures shaped like model-native-qualification.mjs expects; no real model or network is touched.
const STUB=`const fs=require('node:fs'),host=process.env.STUB_HOST,a=process.argv.slice(2);
if(a[0]==='--version'){console.log(host==='claude'?'2.1.296 (Claude Code)':'codex-cli 0.162.1');process.exit(0);}
if(a[0]==='auth'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));process.exit(0);}
let buf='';const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
 if(host==='claude'&&m.type==='control_request'){const ok=r=>out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:r}});
  if(m.request.subtype==='initialize')ok({session_state:'idle',models:[{resolvedModel:'claude-sonnet-5-5',supportsEffort:true,supportedEffortLevels:['medium']}]});
  if(m.request.subtype==='get_usage')ok({rate_limits_available:true,rate_limits:{extra_usage:{is_enabled:false},five_hour:{utilization:4,locked_reason:null},seven_day:{utilization:7,locked_reason:null},model_scoped:[],limits:[]}});}
 if(host==='codex'&&m.id){const ok=r=>out({id:m.id,result:r});
  if(m.method==='initialize')ok({});if(m.method==='account/read')ok({account:{type:'chatgpt'}});
  if(m.method==='account/rateLimits/read')ok({ordinaryUsageAllowed:true});
  if(m.method==='model/list')ok({data:[{model:'gpt-5.6-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:null});}}});
process.stdin.on('end',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));`;
it('runs a full scheduled cycle in a temp HOME with stubbed native binaries: native catalog current, cycle unchanged',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'weekly-cycle-home-'));dirs.push(home);
  const ext=path.join(home,'.vscode-server/extensions'),claudeExt=path.join(ext,'anthropic.claude-code-2.1.296'),codexExt=path.join(ext,'openai.chatgpt-1');
  const arch=process.arch==='arm64'?'aarch64':process.arch==='x64'?'x86_64':process.arch,plat=process.platform==='darwin'?'macos':process.platform;
  const stubJs=path.join(home,'native-stub.cjs');fs.writeFileSync(stubJs,STUB);
  const stub=(file,host)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`#!/bin/sh\nSTUB_HOST=${host} exec '${process.execPath}' '${stubJs}' "$@"\n`,{mode:0o755});};
  stub(path.join(claudeExt,'resources/native-binary/claude'),'claude');stub(path.join(codexExt,'bin',`${plat}-${arch}`,'codex'),'codex');
  fs.writeFileSync(path.join(ext,'extensions.json'),JSON.stringify([{identifier:{id:'anthropic.claude-code'},location:{path:claudeExt}},{identifier:{id:'openai.chatgpt'},location:{path:codexExt}}]));
  fs.mkdirSync(path.join(home,'.codex'));fs.writeFileSync(path.join(home,'.codex/auth.json'),JSON.stringify({tokens:{},auth_mode:'chatgpt'}));
  const dir=path.join(home,'.claude/model-router');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'routing-policy.json'),'{"schemaVersion":1,"routes":{}}');
  write(dir,'profile.json',{automaticModelRoutingUpdates:true,harnesses:{codex:{available:true,subscription:true},'claude-code':{available:true,subscription:true}}});
  write(dir,'catalog.json',{candidates:[]});
  write(dir,'weekly-model-discovery.json',{schemaVersion:1,checkedAt:new Date(NOW-WEEK-1).toISOString(),releases,baselineReleaseIds:releases.map(r=>r.id),pendingReleases:[]});
  const env={...process.env,HOME:home,CODEX_HOME:path.join(home,'.codex')};
  const result=await runWeeklyCycle({routerDir:dir,now:NOW,env,fetchImpl:fetcher(),maxMs:120000});
  expect(result.stages).toEqual([{component:'native-catalog',status:'current',exitCode:0}]);
  expect(result).toMatchObject({status:'unchanged',policyApplied:false});
  const availability=JSON.parse(fs.readFileSync(path.join(dir,'native-availability.json')));
  expect(availability.nativeModelIds).toEqual(['anthropic/claude-sonnet-5-5','openai/gpt-5.6-sol']);
  expect(availability.hosts.find(h=>h.host==='claude-code').harnessVersion).toBe('2.1.296 (Claude Code)');
  expect(fs.existsSync(path.join(home,'.cache/ruvnet-brain/model-routing/terminal-launcher-config.json'))).toBe(false);
},60000);
