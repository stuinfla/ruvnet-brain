import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareClaudeTerminalMod, routeNativePrompt, validateDecision, writeReadinessReceipt } from '../../scripts/claude-terminal-mod.mjs';
import { createTurnCache, inspectDecision, classificationText, refusal } from '../../config/model-router/claude-terminal-mod/hooks/routing.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const now = Date.now();
const routes = { fast: { model: 'claude-sonnet-fixture', effort: 'low' }, medium: { model: 'claude-sonnet-fixture', effort: 'medium' }, hard: { model: 'claude-opus-fixture', effort: 'high' }, codingEffort: 'high' };
const candidates = Object.values(routes).filter(x=>x.model).map(x=>({ id:x.model,provider:'anthropic',harness:['claude-code'],subscription:['claude-code'],supportedEfforts:['low','medium','high'] }));
let dir, env, selection;
const put = (name, value) => fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
beforeEach(() => {
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-terminal-mod-'));
  selection={schemaVersion:1,reviewedAt:new Date(now-1000).toISOString(),maxAgeMs:604800000,routes:{'claude-code':routes}};
  put('routing-policy.json',selection);put('catalog.json',{candidates});
  put('profile.json',{harnesses:{'claude-code':{available:true,subscription:true}}});
  env={...process.env,MODEL_ROUTER_CONFIG_DIR:dir,MODEL_ROUTER_CATALOG:path.join(dir,'catalog.json'),MODEL_ROUTER_PROFILE:path.join(dir,'profile.json'),MODEL_ROUTER_SELECTION:path.join(dir,'routing-policy.json'),MODEL_ROUTER_DECISIONS:path.join(dir,'decisions.jsonl')};
});
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));
const route = (prompt,extra={}) => routeNativePrompt({prompt,env,...extra});
describe('native terminal policy bridge',()=>{
  test('mechanical, coding and hard prompts use exact reviewed model/effort with subscription semantics',()=>{
    expect(route('summarize these supplied notes')).toMatchObject({model:'claude-sonnet-fixture',effort:'low',taskClass:'fast',subscriptionCovered:true});
    expect(route('implement this module')).toMatchObject({model:'claude-sonnet-fixture',effort:'high',taskClass:'medium'});
    expect(route('perform a security audit')).toMatchObject({model:'claude-opus-fixture',effort:'high',taskClass:'hard'});
    const log=fs.readFileSync(path.join(dir,'decisions.jsonl'),'utf8');expect(log).not.toContain('supplied notes');
  });
  test('settled prompt cannot lower the original hard class',()=>{
    expect(route('summarize supplied notes',{minimumClass:'hard'})).toMatchObject({taskClass:'hard',model:'claude-opus-fixture',effort:'high'});
  });
  test.each(['Implement a risk register', 'Add a security banner', 'Explain this risk field'])('ordinary security-named task retains its medium class: %s',(prompt)=>{
    expect(route(prompt)).toMatchObject({model:'claude-sonnet-fixture',taskClass:'medium'});
  });
  test('medium classification preserves the exact original request for the owner policy',()=>{
    const prompt='Explain this risk field. Retain CONTEXT_91; no tools.';
    const observed=path.join(dir,'owner-prompt.txt');
    fs.writeFileSync(path.join(dir,'policy.mjs'),`import fs from 'node:fs'; export async function choose({features,selection,harness}) { fs.writeFileSync(${JSON.stringify(observed)},features.taskHints); return {...selection.routes[harness].medium,taskClass:'medium'}; }`);
    expect(route(prompt)).toMatchObject({taskClass:'medium'});
    expect(fs.readFileSync(observed,'utf8')).toBe(prompt);
  });
  test('below-medium owner choice refuses without inventing a review action',()=>{
    fs.writeFileSync(path.join(dir,'policy.mjs'),"export async function choose({selection,harness}) { return {...selection.routes[harness].fast,taskClass:'fast'}; }");
    expect(()=>route('Explain this risk field')).toThrow(/below canonical floor; no fallback/);
    expect(()=>route('Summarize these supplied notes',{minimumClass:'medium'})).toThrow(/below canonical floor; no fallback/);
  });
  test('actual native security review elevates an unchanged legacy owner policy before engine selection',()=>{
    const prompt='Architecture and security review: identify the most important risk of silently bypassing a subscription-only model router. Do not use tools. Answer in one sentence and repeat ROUTER_CLAUDE_CONTEXT_91.';
    const ownerPolicy="export async function choose({features,selection,harness}) { const taskClass=features.taskHints.includes('final substantive review')?'hard':'medium'; return {...selection.routes[harness][taskClass],taskClass}; }";
    fs.writeFileSync(path.join(dir,'policy.mjs'),ownerPolicy);
    const d=route(prompt,{minimumClass:'fast'});
    expect(d).toMatchObject({model:'claude-opus-fixture',effort:'high',taskClass:'hard'});
    expect(()=>inspectDecision(d,prompt,now)).not.toThrow();
    expect(fs.readFileSync(path.join(dir,'policy.mjs'),'utf8')).toBe(ownerPolicy);
  });
  test('classification hint preserves the complete original request for the owner policy',()=>{
    const prompt='Security assessment: identify bypass risks. Retain CONTEXT_91; no tools.';
    const observed=path.join(dir,'owner-prompt.txt');
    fs.writeFileSync(path.join(dir,'policy.mjs'),`import fs from 'node:fs'; export async function choose({features,selection,harness}) { fs.writeFileSync(${JSON.stringify(observed)},features.taskHints); return {...selection.routes[harness].hard,taskClass:'hard'}; }`);
    route(prompt);expect(fs.readFileSync(observed,'utf8')).toBe('final substantive review\n'+prompt);
  });
  test('headings-only security review data stays fast and ordinary architecture stays medium',()=>{
    expect(route('Summarize the headings in this supplied document titled Security and Risk Review; do not assess security or recommend changes.')).toMatchObject({taskClass:'fast',effort:'low'});
    expect(route('Review the architecture diagram labels for typos')).toMatchObject({taskClass:'medium',effort:'medium'});
  });
  test('an owner policy cannot silently lower the canonical security review floor',()=>{
    fs.writeFileSync(path.join(dir,'policy.mjs'),"export async function choose({selection,harness}) { return {...selection.routes[harness].medium,taskClass:'medium'}; }");
    expect(()=>route('Security review: identify the principal risk.')).toThrow(/below canonical floor; no fallback/);
  });
  test('honors a user policy that raises a simple task to the approved hard allocation',()=>{
    fs.writeFileSync(path.join(dir,'policy.mjs'), "export async function choose({selection,harness}) { return {...selection.routes[harness].hard,taskClass:'hard'}; }");
    const d=route('summarize supplied notes');
    expect(d).toMatchObject({model:'claude-opus-fixture',taskClass:'hard'});
    expect(()=>inspectDecision(d,'summarize supplied notes',now)).not.toThrow();
    fs.writeFileSync(path.join(dir,'policy.mjs'),'throw new Error("broken owner policy");');
    expect(()=>route('summarize supplied notes')).toThrow(/no fallback/);
  });
  test.each([['disabled',{available:false,subscription:true}],['not covered',{available:true,subscription:false}]])('%s host has no metered or native model fallback',(label,host)=>{
    put('profile.json',{harnesses:{'claude-code':host}});expect(()=>route('summarize notes')).toThrow(/no fallback/);
  });
  test('missing qualified hard model never uses medium',()=>{
    put('catalog.json',{candidates:candidates.filter(x=>x.id!=='claude-opus-fixture')});
    expect(()=>route('security audit')).toThrow(/no fallback/);
  });
  test.each([{...selection,maxAgeMs:0},{schemaVersion:9,reviewedAt:'bad'},null])('invalid policy rejects before any route',(invalid)=>{
    put('routing-policy.json',invalid);expect(()=>route('summarize notes')).toThrow(/no fallback/);
  });
  test('stale owner allocation remains authorized while evidence age is retained',()=>{
    put('routing-policy.json',{...selection,reviewedAt:new Date(now-604800001).toISOString()});
    expect(route('summarize notes')).toMatchObject({model:'claude-sonnet-fixture',effort:'low',subscriptionCovered:true});
  });
  test('foreign provider or non-subscription engine output cannot pass receipt validation',()=>{
    expect(()=>validateDecision({harness:'claude-code',provider:'openrouter',subscriptionCovered:false})).toThrow();
  });
  test('preparation copies the exact approved classifier and sandbox-only modules',()=>{
    const dest=path.join(dir,'mod');const prepared=prepareClaudeTerminalMod({destination:dest});
    expect(prepared.pluginDir).toBe(dest);
    expect(fs.readFileSync(prepared.policyPath,'utf8')).toBe(fs.readFileSync(path.join(root,'config/model-router/policy.default.mjs'),'utf8'));
    const runtime=fs.readFileSync(path.join(dest,'hooks/runtime.js'),'utf8');expect(runtime).toContain(JSON.stringify(process.execPath));
    const code=fs.readFileSync(path.join(dest,'hooks/register.js'),'utf8');expect(code).not.toMatch(/node:|process\.env/);
  });
  test('nonce readiness is atomic, private and explicitly bounded to hook activation',()=>{
    const receiptPath=path.join(dir,'ready.json'), nonce='a'.repeat(64);
    const pluginRoot=path.join(dir,'mod');prepareClaudeTerminalMod({destination:pluginRoot});
    const result=writeReadinessReceipt({nonce,receiptPath,pluginRoot,version:'2.1.289',sessionId:'fixture'});
    expect(JSON.parse(fs.readFileSync(receiptPath,'utf8'))).toMatchObject({nonce,status:'ready',nativeVersion:'2.1.289'});
    expect(result.scope).toContain('worker crash');
    // The standalone helper remains portable; private terminal launch is POSIX-only.
    if(process.platform !== 'win32') expect(fs.statSync(receiptPath).mode&0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter(name=>name.startsWith('.rnb-ready-'))).toEqual([]);
    expect(()=>writeReadinessReceipt({nonce:'wrong',receiptPath,pluginRoot,version:'2.1.289',sessionId:'fixture'})).toThrow();
  });
});
describe('exact user-turn cache',()=>{
  const d={model:'claude-sonnet-fixture',effort:'high',taskClass:'medium',expiresAt:now+60000};
  test('turn IDs never borrow another turn and completion removes its allocation',()=>{
    const c=createTurnCache();c.enqueue('implement module',d,now);c.bind({text:'implement module',turnId:'one'},now);
    expect(c.get({turnId:'one',index:0},now)).toEqual(d);
    expect(()=>c.get({turnId:'two',index:0},now)).toThrow();c.complete('one');expect(()=>c.get({turnId:'one',index:1},now)).toThrow();
  });
  test('wrong settled text and unbound/subagent steps refuse; review age does not revoke a running turn',()=>{
    const c=createTurnCache();c.enqueue('implement module',d,now);
    expect(()=>c.bind({text:'changed',turnId:'one'},now)).toThrow();
    c.bind({text:'changed',turnId:'one'},now,{...d,taskClass:'hard'});
    expect(()=>c.get({turnId:'one',index:0,agentId:'child'},now)).toThrow();
    expect(c.get({turnId:'one',index:0},now+604800001)).toMatchObject({taskClass:'hard'});
    expect(refusal({turnId:'absent',index:9})).toMatchObject({turnId:'absent',index:9,stopReason:'refusal',toolUses:[],usage:null});
  });
  test('bounded queue refuses overflow and preserves FIFO duplicate prompts',()=>{
    const c=createTurnCache();for(let i=0;i<32;i++)c.enqueue('same',d,now);
    expect(()=>c.enqueue('same',d,now)).toThrow();c.clear();expect(()=>c.bind({text:'same',turnId:'one'},now)).toThrow();
  });
  test('image-only classification uses a conservative hard review without editing user text',()=>{
    const text=classificationText('',[{}]);expect(text).toBe('final substantive review of supplied attachments');
    expect(()=>inspectDecision({...d,schemaVersion:1,subscriptionCovered:true,taskClass:'hard',model:'claude-opus-fixture',routeDigest:'a'.repeat(64)},text,now)).not.toThrow();
  });
});
