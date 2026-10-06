import { test, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { selectDecision, eligibleCandidates, extractFeatures, assertCurrentSelection, selectionEvidenceStatus, loadCatalog, catalogSource } from '../../scripts/model-router-engine.mjs';
import { choose, classify } from '../../config/model-router/policy.default.mjs';
import { buildLaunch, dispatch, validateDispatchDecision, assertSubscriptionAuth, subscriptionEnvironment } from '../../scripts/model-router-dispatch.mjs';

const selection = { schemaVersion: 1, reviewedAt: new Date().toISOString(), maxAgeMs: 604800000,
  routes: { codex: { fast: {model:'luna',effort:'low'}, medium:{model:'sol',effort:'medium'}, hard:{model:'astra',effort:'high'} },
    'claude-code': {fast:{model:'sonnet',effort:'low'},medium:{model:'sonnet',effort:'medium'},hard:{model:'opus',effort:'high'},codingEffort:'high'} } };
const candidates = ['luna','sol','astra'].map(id => ({ id,provider:'openai',harness:['codex'],subscription:['codex'],tier:'mid' }))
  .concat(['sonnet','opus'].map(id=>({id,provider:'anthropic',harness:['claude-code'],subscription:['claude-code'],tier:'mid'})))
  .concat([{id:'paid',provider:'openrouter',harness:['codex'],subscription:[],tier:'cheap'}]);
const nativeSupport = candidates.filter(m=>m.provider==='openai').map(m=>({slug:m.id,supported_reasoning_levels:['low','medium','high','xhigh','max'].map(effort=>({effort}))}));
const profile={harnesses:{codex:{available:true,subscription:true},'claude-code':{available:true,subscription:true}}};
const route = (prompt, harness='codex', extras={}) => selectDecision({prompt,harness,candidates,profile,selection,
  policy:{choose},learnedRoute:async()=>({routedBy:'COLD-START'}),...extras});

test('fast extraction, ordinary code, and bounded hard work select model AND effort', async()=>{
  expect(await route('extract names from this list')).toMatchObject({model:'luna',taskClass:'fast',effort:'low'});
  expect(await route('implement an extraction function')).toMatchObject({model:'sol',taskClass:'medium',effort:'medium'});
  expect(await route('security audit of cryptographic consensus')).toMatchObject({model:'astra',taskClass:'hard',effort:'high'});
  expect(await route('implement API endpoint','claude-code')).toMatchObject({model:'sonnet',effort:'high'});
  expect(await route('research onboarding documentation','claude-code')).toMatchObject({model:'sonnet',effort:'medium'});
});
test('learned results cannot bypass explicit owner allocation or authorize paid/unknown models',async()=>{
  for(const model of ['paid','absent','astra']) {
    const learnedRoute=vi.fn(async()=>({model,routedBy:'@metaharness/router'}));
    expect(await route('implement code','codex',{learnedRoute})).toMatchObject({model:'sol',effort:'medium'});
    expect(learnedRoute.mock.calls[0][1].map(m=>m.id)).toEqual(['sol']);
  }
});
test('missing subscription profile, unavailable harness, and unqualified policy fail closed',async()=>{
  expect(eligibleCandidates(candidates,null,'codex')).toEqual([]);
  await expect(route('hello','codex',{profile:{harnesses:{codex:{available:false,subscription:true}}}})).rejects.toThrow('No available');
  await expect(route('hello','codex',{policy:{choose:()=>({model:'paid'})}})).rejects.toThrow('unauthorized');
  await expect(route('hello','codex',{policy:{choose:()=>({model:'astra',taskClass:'medium',effort:'high'})}})).rejects.toThrow('exceeds reviewed');
});
test('stale evidence retains owner approval without renewing its original date',()=>{
  const approved={...selection,reviewedAt:'2020-01-01',inventory:{checkedAt:new Date().toISOString()}};
  expect(assertCurrentSelection(approved)).toBe(approved);
  expect(selectionEvidenceStatus(approved)).toMatchObject({reviewedAt:'2020-01-01',stale:true});
  expect(selectionEvidenceStatus({...approved,maxAgeMs:1e15})).toMatchObject({maxAgeMs:604800000,stale:true});
});
test('native launch argv binds effort and model and cannot silently fallback',()=>{
  const decision={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,
    selectionReviewedAt:selection.reviewedAt,selectionRouteDigest:selectionEvidenceStatus(selection).routeDigest};
  expect(buildLaunch(decision,{cwd:'/tmp/code'})).toEqual({command:'codex',args:['exec','--ignore-user-config','--model','sol','-c','model_reasoning_effort="medium"','-c','model_provider="openai"','-c','service_tier="default"','-c','features.fast_mode=false','--cd','/tmp/code','-']});
  expect(buildLaunch({...decision,harness:'claude-code',provider:'anthropic',model:'sonnet'}).args).toContain('--effort');
  expect(()=>buildLaunch(decision,{interactive:true})).toThrow('stdin');
  expect(()=>buildLaunch({...decision,model:null})).toThrow();
  expect(()=>buildLaunch({...decision,subscriptionCovered:false})).toThrow();
});
test('actual dispatch uses argv arrays and stdin; receipts never retain raw prompt',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-contract-'));
  const receiptFile=path.join(tmp,'receipt.jsonl');
  const end=vi.fn();
  const spawnWorker=vi.fn(()=>{const child=new EventEmitter();child.stdin={end};queueMicrotask(()=>child.emit('exit',0,null));return child;});
  const prompt='private $(touch unsafe) `token`';
  const decision={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt,selectionRouteDigest:selectionEvidenceStatus(selection).routeDigest};
  try{
    expect(await dispatch(decision,prompt,{spawnWorker,checkAuth:vi.fn(),checkAllowance:async()=>({ordinaryUsageAllowed:true,checkedAt:'fixture'}),verifyDecision:vi.fn(),receiptFile,env:{OPENAI_API_KEY:'secret',PATH:'/bin'}})).toBe(0);
    expect(spawnWorker.mock.calls[0][2]).toMatchObject({shell:false,env:{PATH:'/bin'}});
    expect(spawnWorker.mock.calls[0][1]).not.toContain(prompt);
    expect(end).toHaveBeenCalledWith(prompt);
    const raw=fs.readFileSync(receiptFile,'utf8');
    expect(raw).not.toContain('private');
    expect(raw).not.toContain('secret');
    expect(JSON.parse(raw.trim().split('\n')[1])).toMatchObject({model:'sol',effort:'medium',status:'process-completed',modelObserved:false});
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('OAuth shape and auth status fail closed without exposing credentials',()=>{
  expect(()=>assertSubscriptionAuth('codex',{env:{CODEX_HOME:'/fixture'},read:()=>JSON.stringify({OPENAI_API_KEY:'secret'})})).toThrow('OAuth');
  expect(()=>assertSubscriptionAuth('codex',{env:{CODEX_HOME:'/fixture'},read:()=>JSON.stringify({tokens:{access_token:'secret'},auth_mode:'chatgpt'})})).not.toThrow();
  expect(()=>assertSubscriptionAuth('claude-code',{probe:()=>JSON.stringify({loggedIn:true,authMethod:'api_key'})})).toThrow('subscription');
  expect(subscriptionEnvironment({ANTHROPIC_API_KEY:'secret',CLAUDE_CODE_USE_VERTEX:'1',PATH:'/bin'})).toEqual({PATH:'/bin'});
});

test('dispatch rechecks current allocation and per-user eligibility before launch',()=>{
  const d={harness:'codex',model:'sol',taskClass:'medium',effort:'medium',selectionReviewedAt:selection.reviewedAt,selectionRouteDigest:selectionEvidenceStatus(selection).routeDigest};
  expect(()=>validateDispatchDecision(d,{selection,profile,candidates,nativeModels:nativeSupport})).not.toThrow();
  expect(()=>validateDispatchDecision({...d,model:'paid'},{selection,profile,candidates,nativeModels:nativeSupport})).toThrow('allocation');
  expect(()=>validateDispatchDecision(d,{selection,profile:{harnesses:{}},candidates})).toThrow('allocation');
  expect(()=>validateDispatchDecision(d,{selection:{...selection,reviewedAt:new Date(Date.now()-1000).toISOString()},profile,candidates,nativeModels:nativeSupport})).toThrow('changed');
});

test('real subprocess receives bound native model+effort argv and prompt stdin without inference',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'native-dispatch-'));
  const capture=path.join(tmp,'captured.json');
  const stub=path.join(tmp,'codex.mjs');
  fs.writeFileSync(stub,`#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.DISPATCH_CAPTURE,JSON.stringify({args:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')}));\n`,{mode:0o755});
  const decision={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt,selectionRouteDigest:selectionEvidenceStatus(selection).routeDigest};
  try{
    const code=await dispatch(decision,'extract code implementation',{spawnWorker:(_command,args,options)=>spawn(process.execPath,[stub,...args],options),cwd:tmp,receiptFile:path.join(tmp,'receipt.jsonl'),
      env:{PATH:tmp,DISPATCH_CAPTURE:capture},checkAuth:vi.fn(),checkAllowance:async()=>({ordinaryUsageAllowed:true,checkedAt:'fixture'}),verifyDecision:d=>validateDispatchDecision(d,{selection,profile,candidates,nativeModels:nativeSupport})});
    expect(code).toBe(0);
    const observed=JSON.parse(fs.readFileSync(capture,'utf8'));
    expect(observed.args).toEqual(buildLaunch(decision,{cwd:tmp}).args);
    expect(observed.stdin).toBe('extract code implementation');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('missing or malformed catalog fails without stale built-in candidates',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'router-catalog-required-'));
  try{
    const file=path.join(tmp,'catalog.json');
    expect(()=>loadCatalog(file)).toThrow('no built-in');
    expect(catalogSource(file)).toBe('unavailable');
    fs.writeFileSync(file,'{"candidates":[]}');
    expect(()=>loadCatalog(file)).toThrow('no built-in');
    fs.writeFileSync(file,JSON.stringify({candidates}));
    expect(loadCatalog(file)).toEqual(candidates);
    expect(catalogSource(file)).toBe('catalog');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('bounded difficult reviews and planning escalate, routine inspection stays medium',async()=>{
  for(const prompt of ['perform final review','do an independent review','difficult planning of rollout','review complex architecture']) {
    expect(await route(prompt)).toMatchObject({taskClass:'hard',model:'astra',effort:'high'});
  }
  expect(await route('inspect architecture documentation')).toMatchObject({taskClass:'medium',model:'sol',effort:'medium'});
  expect(await route('plan ordinary implementation work')).toMatchObject({taskClass:'medium',model:'sol',effort:'medium'});
});

test('exceptional xhigh requires a named caller reason and native support; arbitrary max rejects',async()=>{
  const reviewed={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,exceptional:{model:'astra',effort:'xhigh',requiresNamedReason:true}}}};
  const features=extractFeatures('check a proof','codex',{taskType:'review',exceptionalReason:'cryptographic-proof'});
  const decision=await route('check a proof','codex',{selection:reviewed,features});
  expect(buildLaunch({...decision,harness:'codex'}).args).toContain('model_reasoning_effort="xhigh"');
  expect(()=>validateDispatchDecision({...decision,harness:'codex'},{selection:reviewed,profile,candidates,nativeModels:nativeSupport})).not.toThrow();
  const supported=candidates.map(m=>({...m,supportedEfforts:['low','medium','high']}));
  await expect(route('check a proof','codex',{selection:reviewed,features,candidates:supported})).rejects.toThrow('effort unavailable');
  await expect(route('check a proof','codex',{selection:reviewed,features,policy:{choose:()=>({...decision,exceptionalReason:undefined})}})).rejects.toThrow('named reason');
  const maxPolicy={...reviewed,routes:{...reviewed.routes,codex:{...reviewed.routes.codex,exceptional:{model:'astra',effort:'max',requiresNamedReason:true}}}};
  await expect(route('check a proof','codex',{selection:maxPolicy,features})).rejects.toThrow('no automatic max');
  const normalHigh={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,hard:{model:'astra',effort:'xhigh'}}}};
  await expect(route('independent review','codex',{selection:normalHigh})).rejects.toThrow('named reason');
  const d={harness:'claude-code',provider:'anthropic',model:'opus',taskClass:'hard',effort:'high',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt,selectionRouteDigest:selectionEvidenceStatus(selection).routeDigest};
  expect(()=>buildLaunch(d,{interactive:true})).toThrow('stdin');
  expect(()=>buildLaunch({...d,effort:'none'})).toThrow('unauthorized');
});

test('invalid allocation ages still reject even when evidence expiry does not revoke approval',()=>{
  for(const maxAgeMs of ['invalid','604800000',null,true,NaN,Infinity,-1,0,1.5,Number.MAX_SAFE_INTEGER+1]) {
    expect(()=>assertCurrentSelection({...selection,reviewedAt:'2020-01-01',maxAgeMs})).toThrow('finite positive integer');
  }
  expect(()=>assertCurrentSelection({...selection,maxAgeMs:1000},Date.parse(selection.reviewedAt))).not.toThrow();
  for(const reviewedAt of ['not-a-date','1','2026-02-30']) expect(()=>assertCurrentSelection({...selection,reviewedAt})).toThrow('invalid');
  expect(()=>assertCurrentSelection({...selection,reviewedAt:new Date(Date.now()+60000).toISOString()})).toThrow('future');
  expect(()=>assertCurrentSelection(undefined)).toThrow('missing');
});

test('legacy custom policy without class fails explicitly rather than converting summary to medium',async()=>{
  await expect(route('summarize this document','claude-code',{
    policy:{choose:()=>({model:'sonnet',provider:'anthropic',reason:'legacy policy'})},
  })).rejects.toThrow('update legacy policy');
});

test('substantial work uses an explicitly qualified Sol high route, never silent routine medium',async()=>{
  const updated={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}};
  expect(await route('substantial implementation across modules','codex',{selection:updated})).toMatchObject({taskClass:'substantial',model:'sol',effort:'high',classificationSource:'free-text-heuristic'});
  expect(await route('implement a small input validator','codex',{selection:updated})).toMatchObject({taskClass:'medium',model:'sol',effort:'medium'});
  await expect(route('substantial implementation across modules')).rejects.toThrow('unavailable');
  await expect(route('substantial implementation','codex',{selection:updated,policy:{choose:()=>({model:'sol',taskClass:'medium',effort:'medium'})}})).rejects.toThrow('cannot silently use medium');
});

test('structured caller facts distinguish reasoning uncertainty from missing information or environment problems',async()=>{
  const updated={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}};
  for(const facts of [{taskType:'planning',uncertainty:'architecture'},{taskType:'planning',consequentialPlanning:true},{taskType:'review',finalSubstantiveReview:true},{taskType:'coding',uncertainty:'coupled-implementation'}]) {
    expect(await route('assess task','codex',{selection:updated,features:extractFeatures('assess task','codex',facts)})).toMatchObject({model:'astra',effort:'high',taskClass:'hard',classificationSource:'caller-task-facts'});
  }
  for(const uncertainty of ['missing-information','environment']) {
    expect(await route('inspect task','codex',{selection:updated,features:extractFeatures('inspect task','codex',{taskType:'coding',scope:'routine',uncertainty})})).toMatchObject({model:'sol',effort:'medium',taskClass:'medium'});
  }
  expect(await route('build requested feature','codex',{selection:updated,features:extractFeatures('build requested feature','codex',{taskType:'coding',scope:'substantial'})})).toMatchObject({model:'sol',effort:'high',taskClass:'substantial'});
  await expect(route('task','codex',{features:extractFeatures('task','codex',{uncertainty:'unknown-kind'})})).rejects.toThrow('Invalid');
});

test('native dispatch rejects an unsupported model or effort even when policy approves it',()=>{
  const d={harness:'codex',model:'sol',taskClass:'medium',effort:'medium',selectionReviewedAt:selection.reviewedAt,selectionRouteDigest:selectionEvidenceStatus(selection).routeDigest};
  expect(()=>validateDispatchDecision(d,{selection,profile,candidates,nativeModels:[]})).toThrow('Native Codex');
  expect(()=>validateDispatchDecision(d,{selection,profile,candidates,nativeModels:[{slug:'sol',supported_reasoning_levels:[{effort:'low'}]}]})).toThrow('Native Codex');
});

test('allowance denial blocks actual worker launch even with subscription auth and credits',async()=>{
  const spawnWorker=vi.fn();
  const d={harness:'codex',provider:'openai',model:'sol',taskClass:'medium',effort:'medium',subscriptionCovered:true,selectionReviewedAt:selection.reviewedAt,selectionRouteDigest:selectionEvidenceStatus(selection).routeDigest};
  await expect(dispatch(d,'implementation',{spawnWorker,checkAuth:vi.fn(),verifyDecision:vi.fn(),checkAllowance:async()=>{throw Error('ordinary allowance denied');}})).rejects.toThrow('allowance denied');
  expect(spawnWorker).not.toHaveBeenCalled();
});

test('ambiguous architecture and tightly coupled uncertain implementation go directly hard without penalizing routine inspection',async()=>{
  expect(await route('architecture is ambiguous; assess competing designs')).toMatchObject({model:'astra',effort:'high',taskClass:'hard'});
  expect(await route('tightly coupled implementation with uncertain invariants')).toMatchObject({model:'astra',effort:'high',taskClass:'hard'});
  expect(await route('inspect architecture documentation for missing environment variables')).toMatchObject({model:'sol',effort:'medium',taskClass:'medium'});
  await expect(route('assess task','codex',{features:extractFeatures('assess task','codex',{uncertainty:'architecture'}),policy:{choose:()=>({model:'sol',effort:'medium',taskClass:'medium'})}})).rejects.toThrow('explicit qualified hard');
});

test('managed dispatcher CLI keeps structured task facts out of actual worker prompt and enforces substantial effort',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'structured-dispatch-cli-'));
  try{
    const files={catalog:path.join(tmp,'catalog.json'),profile:path.join(tmp,'profile.json'),selection:path.join(tmp,'routing-policy.json'),native:path.join(tmp,'models_cache.json'),capture:path.join(tmp,'capture.json')};
    fs.writeFileSync(files.catalog,JSON.stringify({candidates}));
    fs.writeFileSync(files.profile,JSON.stringify(profile));
    fs.writeFileSync(files.selection,JSON.stringify({...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}}));
    fs.writeFileSync(files.native,JSON.stringify({models:nativeSupport}));
    fs.writeFileSync(path.join(tmp,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{fixture:true}}));
    const stub=path.join(tmp,'codex.mjs'), preload=path.join(tmp,'native-spawn.cjs');
    fs.writeFileSync(preload,`const cp=require('node:child_process'); const spawn=cp.spawn; cp.spawn=(cmd,args,opts)=>cmd==='codex'?spawn(process.execPath,[${JSON.stringify(stub)},...args],opts):spawn(cmd,args,opts); require('node:module').syncBuiltinESMExports();`);
    fs.writeFileSync(stub,`#!${process.execPath}\nimport fs from 'node:fs'; import readline from 'node:readline'; if(process.argv[2]==='app-server'){readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id)process.stdout.write(JSON.stringify({id:r.id,result:r.id===1?{}:{ordinaryUsageAllowed:true}})+'\\n');});}else{fs.writeFileSync(process.env.DISPATCH_CAPTURE,JSON.stringify({args:process.argv.slice(2),prompt:fs.readFileSync(0,'utf8')}));}`,{mode:0o755});
    execFileSync(process.execPath,['--require',preload,'scripts/model-router-dispatch.mjs','--harness','codex','--request-json','--policy','config/model-router/policy.default.mjs'],{
      input:JSON.stringify({prompt:'implement PRIVATE_STRUCTURED_TASK',taskFacts:{taskType:'coding',scope:'substantial'}}),encoding:'utf8',
      env:{...process.env,PATH:tmp,CODEX_HOME:tmp,MODEL_ROUTER_CATALOG:files.catalog,MODEL_ROUTER_PROFILE:files.profile,MODEL_ROUTER_SELECTION:files.selection,MODEL_ROUTER_NATIVE_MODELS:files.native,MODEL_ROUTER_DECISIONS:path.join(tmp,'decisions.jsonl'),MODEL_ROUTER_DISPATCH_RECEIPTS:path.join(tmp,'receipts.jsonl'),DISPATCH_CAPTURE:files.capture},
    });
    const received=JSON.parse(fs.readFileSync(files.capture,'utf8'));
    expect(received.prompt).toBe('implement PRIVATE_STRUCTURED_TASK');
    expect(received.args).toContain('model_reasoning_effort="high"');
    expect(received.args).toContain('service_tier="default"');
    expect(fs.readFileSync(path.join(tmp,'receipts.jsonl'),'utf8')).not.toContain('PRIVATE_STRUCTURED_TASK');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('substantial planning and review go directly Astra high while substantial coding remains Sol high',async()=>{
  const updated={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}};
  for(const taskType of ['planning','review']) {
    expect(await route('assess requested work','codex',{selection:updated,features:extractFeatures('assess requested work','codex',{taskType,scope:'substantial'})})).toMatchObject({taskClass:'hard',model:'astra',effort:'high'});
  }
  expect(await route('build requested work','codex',{selection:updated,features:extractFeatures('build requested work','codex',{taskType:'coding',scope:'substantial'})})).toMatchObject({taskClass:'substantial',model:'sol',effort:'high'});
});

test('nontrivial system planning and architecture design route hard without escalating ordinary plans and inspection',async()=>{
  for(const prompt of ['plan a new system','design a new architecture','substantive planning of rollout','perform substantive review']) {
    expect(await route(prompt)).toMatchObject({taskClass:'hard',model:'astra',effort:'high'});
  }
  for(const prompt of ['plan ordinary implementation work','inspect architecture documentation']) {
    expect(await route(prompt)).toMatchObject({taskClass:'medium',model:'sol',effort:'medium'});
  }
});

test('partial task facts cannot downgrade high-consequence text or substantial work',async()=>{
  for(const facts of [{},{taskType:'mechanical'},{taskType:'coding',scope:'routine',uncertainty:'environment'},{uncertainty:'missing-information'}]) {
    const prompt='security audit of cryptographic consensus';
    expect(await route(prompt,'codex',{features:extractFeatures(prompt,'codex',facts)})).toMatchObject({taskClass:'hard',model:'astra',effort:'high'});
  }
  const updated={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}};
  expect(await route('substantial implementation','codex',{selection:updated,features:extractFeatures('substantial implementation','codex',{})})).toMatchObject({taskClass:'substantial',model:'sol',effort:'high'});
  expect(await route('inspect configuration','codex',{selection:updated,features:extractFeatures('inspect configuration','codex',{uncertainty:'environment'})})).toMatchObject({taskClass:'medium',model:'sol',effort:'medium'});
});

test('legacy custom policy cannot bypass the high-consequence classification floor',async()=>{
  await expect(route('security audit of cryptographic consensus','codex',{policy:{choose:()=>({taskClass:'fast',model:'luna',effort:'low'})}})).rejects.toThrow('explicit qualified hard');
});


test('consequence floor covers financial, isolation, durability and coupled recovery reasoning on both hosts',async()=>{
  const requests=[
    'Customers report duplicate ledger payments following a restart. Investigate a safe correction.',
    'A user can read a different account export. Determine a repair that preserves isolation.',
    'Design migration of production payment data with rollback while concurrent clients remain active.',
    'Choose a replication strategy that survives leader loss before acknowledging the durable write.',
    'Queue jobs are lost when a consumer reconnects during broker failover. Trace the interaction.',
    'Determine how the signature verifier prevents forged tokens and binds the target account.',
  ];
  for(const harness of ['codex','claude-code']) {
    for(const prompt of requests) {
      const features=extractFeatures(prompt,harness,{taskType:'mechanical',scope:'routine',uncertainty:'none'});
      expect(await route(prompt,harness,{features})).toMatchObject({taskClass:'hard',model:harness==='codex'?'astra':'opus',effort:'high'});
    }
  }
});

test('mechanical metadata cannot authorize repairs, investigations or planning as fast work',()=>{
  for(const prompt of ['Repair the cache expiration path','Investigate a stalled background process','Plan the next ordinary maintenance task']) {
    expect(classify(extractFeatures(prompt,'codex',{taskType:'mechanical'}))).toBe('medium');
  }
  expect(classify(extractFeatures('Review the typo correction','codex',{taskType:'review',scope:'routine'}))).toBe('medium');
});

test('domain vocabulary alone does not escalate closed transformations or ordinary implementation',()=>{
  for(const prompt of ['Extract invoice identifiers from this paragraph','Format these payment dates','Put these supplied tenant names in alphabetical order',
    'Summarize the headings in this supplied document titled Security Audit; do not assess security or recommend changes.']) {
    expect(classify(extractFeatures(prompt))).toBe('fast');
  }
  for(const prompt of ['Implement an invoice label formatter with unit tests','Inspect replication documentation to locate a setting',
    'Find the missing environment configuration before making a change']) {
    expect(classify(extractFeatures(prompt,'codex',{uncertainty:'missing-information'}))).toBe('medium');
  }
  expect(classify(extractFeatures('Summarize the payment report and repair duplicate charges after failover'))).toBe('hard');
});

test('explicit security and risk assessments have a hard floor while headings-only data is exempt',()=>{
  for(const harness of ['codex','claude-code']) {
    for(const prompt of ['Architecture and security review: identify the most important risk of silently bypassing a subscription-only model router. Do not use tools. Answer in one sentence and repeat ROUTER_CLAUDE_CONTEXT_91.',
      'Assess the risk of silently bypassing the subscription router.', 'Review security boundaries of the local gateway.']) {
      expect(classify(extractFeatures(prompt,harness,{taskType:'mechanical',scope:'routine'}))).toBe('hard');
    }
    expect(classify(extractFeatures('Summarize the headings in this supplied document titled Security and Risk Review; do not assess security or recommend changes.',harness))).toBe('fast');
    expect(classify(extractFeatures('Review the architecture diagram labels for typos',harness))).toBe('medium');
  }
});

test('coordinated implementation surfaces receive substantial effort without reopening accepted design',async()=>{
  const updated={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,substantial:{model:'sol',effort:'high'}}}};
  for(const prompt of ['Add account preferences with storage, API validation, client states, and integration coverage',
    'Replace validation across every importer, preserve compatibility, and add integration fixtures']) {
    expect(await route(prompt,'codex',{selection:updated})).toMatchObject({taskClass:'substantial',model:'sol',effort:'high'});
  }
});

test('retained stale approved route passes mandatory native checks and receipts disclose original evidence age',async()=>{
  const retained={...selection,reviewedAt:'2020-01-01'};
  const decision={...await route('implement an ordinary endpoint','codex',{selection:retained}),harness:'codex'};
  expect(decision).toMatchObject({model:'sol',effort:'medium',selectionReviewedAt:'2020-01-01',selectionEvidence:{stale:true}});
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'retained-selection-'));
  const receiptFile=path.join(tmp,'receipt.jsonl');
  const checkAuth=vi.fn(); const checkAllowance=vi.fn(async()=>({ordinaryUsageAllowed:true,checkedAt:'fixture'}));
  const spawnWorker=vi.fn(()=>{const child=new EventEmitter();child.stdin={end:vi.fn()};queueMicrotask(()=>child.emit('exit',0,null));return child;});
  try {
    await dispatch(decision,'PRIVATE retained prompt',{spawnWorker,checkAuth,checkAllowance,receiptFile,
      verifyDecision:d=>validateDispatchDecision(d,{selection:retained,profile,candidates,nativeModels:nativeSupport})});
    expect(checkAuth).toHaveBeenCalledOnce(); expect(checkAllowance).toHaveBeenCalledOnce(); expect(spawnWorker).toHaveBeenCalledOnce();
    const raw=fs.readFileSync(receiptFile,'utf8');
    expect(JSON.parse(raw.split('\n')[0])).toMatchObject({selectionReviewedAt:'2020-01-01',selectionRouteDigest:decision.selectionRouteDigest,
      selectionEvidenceStale:true,modelObserved:false});
    expect(raw).not.toContain('PRIVATE');
    expect(()=>validateDispatchDecision(decision,{selection:retained,profile,candidates,nativeModels:[]})).toThrow('Native Codex');
    expect(()=>validateDispatchDecision(decision,{selection:retained,profile:{harnesses:{}},candidates,nativeModels:nativeSupport})).toThrow('allocation');
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});

test('route digest is stable under key reordering but detects mutations with the same approval date',async()=>{
  const decision={...await route('implement ordinary code'),harness:'codex'};
  const reordered={...selection,routes:Object.fromEntries(Object.entries(selection.routes).reverse().map(([host,routes])=>
    [host,Object.fromEntries(Object.entries(routes).reverse())]))};
  expect(selectionEvidenceStatus(reordered).routeDigest).toBe(decision.selectionRouteDigest);
  expect(()=>validateDispatchDecision(decision,{selection:reordered,profile,candidates,nativeModels:nativeSupport})).not.toThrow();
  const changed={...selection,routes:{...selection.routes,codex:{...selection.routes.codex,medium:{model:'astra',effort:'high'}}}};
  expect(()=>validateDispatchDecision(decision,{selection:changed,profile,candidates,nativeModels:nativeSupport})).toThrow('changed');
  expect(()=>validateDispatchDecision({...decision,selectionRouteDigest:undefined},{selection,profile,candidates,nativeModels:nativeSupport})).toThrow('changed');
});

test('retention cannot authorize unknown native models or expand custom policy authority',async()=>{
  const retained={...selection,reviewedAt:'2020-01-01'};
  await expect(route('implement ordinary code','codex',{selection:retained,policy:{choose:()=>({model:'astra',taskClass:'medium',effort:'high'})}})).rejects.toThrow('exceeds reviewed');
  const changed={...retained,routes:{...retained.routes,codex:{...retained.routes.codex,medium:{model:'unknown-native',effort:'medium'}}}};
  const expanded=[...candidates,{id:'unknown-native',provider:'openai',harness:['codex'],subscription:['codex']}];
  const decision={...await route('implement ordinary code','codex',{selection:changed,candidates:expanded}),harness:'codex'};
  expect(()=>validateDispatchDecision(decision,{selection:changed,profile,candidates:expanded,nativeModels:nativeSupport})).toThrow('Native Codex');
});

test('accepts native six-digit ISO review precision without changing dates or route binding',()=>{
  const now=Date.parse('2026-10-04T14:00:00Z');
  for(const reviewedAt of ['2026-10-04T13:32:24.704091Z','2026-10-04T13:32:24.704091123Z']){
    const original={...selection,reviewedAt}; const bytes=JSON.stringify(original);
    expect(assertCurrentSelection(original,now)).toBe(original);
    expect(selectionEvidenceStatus(original,now)).toMatchObject({reviewedAt,routeDigest:selectionEvidenceStatus(selection).routeDigest});
    expect(JSON.stringify(original)).toBe(bytes);
  }
  for(const reviewedAt of ['2026-10-04T13:32:24.7040911234Z','2026-02-30T13:32:24.704091Z','2026-10-04T25:32:24.704091Z','2026-10-05T13:32:24.704091Z'])
    expect(()=>assertCurrentSelection({...selection,reviewedAt},now)).toThrow('invalid or future');
  expect(()=>assertCurrentSelection({...selection,reviewedAt:'2026-10-04T13:32:24.704091Z',maxAgeMs:0},now)).toThrow('maxAgeMs');
});
