import { test, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import * as controlledClaude from '../../scripts/claude-controlled-terminal.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createGuardedWorkflowAdapters, readCodexWorkerObservation, claudeWorkflowResponse } from '../../scripts/model-routing-execution-adapters.mjs';
import { validateExecutionAdapter, validateWorkerResult } from '@pacphi/agentic-kit/src/lib/execution/schema.mjs';

function fixture(overrides = {}) {
  const request = { originalPrompt: 'Translate hello.', cwd: process.cwd(), contextRefs: [], permissions: { write: false } };
  const worker = { id: 'worker-one', activity: 'implementation', role: 'developer', host: 'codex', configuredModel: 'fixture-model',
    decision: { harness: 'codex', model: 'fixture-model', effort: 'medium', provider: 'openai' }, ownership: { mode: 'read' },
    prompt: JSON.stringify({ originalPrompt: request.originalPrompt }) };
  const map = createGuardedWorkflowAdapters({ request, budget: { deadline: Date.now() + 10000 }, binaries: { codex: process.execPath, claude: process.execPath },
    verifyDecision: () => {}, executeNative: async () => ({ model: 'fixture-model', effort: 'medium', completed: true, sessionId: 'fixture-session', answer: '{"outcome":"done","artifacts":[],"decisions":[],"risks":[]}' }), ...overrides });
  return { request, worker, adapter: map.codex, claude: map.claude };
}
test('adapter conforms to actual runner lifecycle and requires native observation', async () => {
  const { worker, adapter } = fixture(); validateExecutionAdapter(adapter);
  const state = await adapter.prepare({ worker, timeoutMs: 5000 });
  await adapter.launch(state); const observation = await adapter.observe(state);
  const result = validateWorkerResult(adapter.interpret(state, observation));
  assert.equal(result.status, 'succeeded'); assert.equal(result.observedModel, 'fixture-model');
  assert.equal(result.providerProvenance, 'configured');
  assert.equal(adapter.summarize(state).outcome, 'done'); await assert.rejects(adapter.cleanup(state), /not confirmed/); // Injected executor returned no owned-child close proof.
});
test('Claude workflow uses only the bound native final JSON after commentary', async () => {
  const { worker, claude: adapter } = fixture({ executeNative: undefined });
  worker.decision = { ...worker.decision, harness: 'claude-code', provider: 'anthropic' };
  const finalAnswer = '{"outcome":"done","artifacts":[],"decisions":[],"risks":[]}';
  const turn = { sessionId: crypto.randomUUID(), decision: worker.decision, finalAnswer, structuredOutput: true,
    modelObserved: true, effortSettingsObserved: true };
  const native = vi.spyOn(controlledClaude, 'runControlledClaudeTurn').mockImplementation(async options => {
    options.output?.('I will inspect the source.');
    options.output?.(finalAnswer);
    options.receipt({ status: 'completed', model: worker.decision.model, effort: worker.decision.effort });
    return turn;
  });
  try {
    const state = await adapter.prepare({ worker, timeoutMs: 5000 });
    await adapter.launch(state);
    const observation = await adapter.observe(state);
    assert.equal(observation.answer, finalAnswer);
    assert.equal(observation.sessionId, turn.sessionId);
    assert.equal(adapter.interpret(state, observation).status, 'succeeded');
    assert.equal(adapter.summarize(state).outcome, 'done');
    for (const override of [{ structuredOutput: false }, { finalAnswer: undefined }, { finalAnswer: {} },
      { decision: { ...worker.decision, model: 'other' } }, { effortSettingsObserved: false }]) {
      native.mockResolvedValueOnce({ ...turn, ...override });
      const rejected = await adapter.prepare({ worker, timeoutMs: 5000 });
      await adapter.launch(rejected);
      assert.equal(adapter.interpret(rejected, await adapter.observe(rejected)).status, 'blocked');
    }
    native.mockResolvedValueOnce({ ...turn, finalAnswer: 'malformed final JSON' });
    const malformed = await adapter.prepare({ worker, timeoutMs: 5000 });
    await adapter.launch(malformed);
    assert.equal(adapter.interpret(malformed, await adapter.observe(malformed)).status, 'blocked');
    assert.match(malformed.error.message, /schema invalid/);
  } finally { native.mockRestore(); }
});

test('exit success without observed model or completion cannot succeed', async () => {
  for (const observation of [{ model: 'other', effort: 'medium', completed: true }, { model: 'fixture-model', effort: 'medium', completed: false }]) {
    const { worker, adapter } = fixture({ executeNative: async () => observation });
    const state = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(state);
    assert.equal(adapter.interpret(state, await adapter.observe(state)).status, 'blocked');
  }
});
test('write authority and original context cannot expand or disappear', async () => {
  const { worker, adapter } = fixture();
  await assert.rejects(adapter.prepare({ worker: { ...worker, ownership: { mode: 'write', paths: ['src/'] } }, timeoutMs: 5000 }), /authority/);
  await assert.rejects(adapter.prepare({ worker: { ...worker, prompt: 'weak summary only' }, timeoutMs: 5000 }), /original request/);
});
test('denied launch stays blocked and unconfirmed retirement cannot be retried as success', async () => {
  const { worker, adapter } = fixture({ executeNative: async () => { throw new Error('consent denied'); } });
  const state = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(state);
  assert.equal(adapter.interpret(state, await adapter.observe(state)).status, 'blocked');
  const pending = await adapter.prepare({ worker, timeoutMs: 5000 });
  assert.equal((await adapter.cancel(pending)).type, 'orphaned');
  assert.equal(adapter.interpret(pending, { type: 'orphaned' }).exitCategory, 'orphaned');
  await assert.rejects(adapter.cleanup(pending), /not confirmed/);
});
test('native rollout is exact session-bound and ambiguous/missing turns refuse', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-worker-rollout-'));
  const id = crypto.randomUUID(), date = new Date().toISOString().slice(0, 10).split('-'), directory = path.join(home, 'sessions', ...date);
  fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, `rollout-${id}.jsonl`);
  const row = { type: 'turn_context', payload: { model: 'fixture-model', effort: 'medium', cwd: home, sandbox_policy: { type: 'read-only' } } };
  try {
    fs.writeFileSync(file, JSON.stringify(row) + '\n');
    assert.equal(readCodexWorkerObservation(id, { home }).model, 'fixture-model');
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    assert.throws(() => readCodexWorkerObservation(id, { home }), /unexpected turn/);
    assert.throws(() => readCodexWorkerObservation(crypto.randomUUID(), { home }), /unavailable/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('owned edit publication rejects the whole batch before any escaped or stale write', async () => {
  const {applyOwnedCodexEdits}=await import('../../scripts/model-routing-execution-adapters.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-owned-edits-'));
  const worker={ownership:{worktree:fs.realpathSync(root),paths:['a.mjs','b.mjs']}};
  fs.writeFileSync(path.join(root,'a.mjs'),'old');
  const sha=crypto.createHash('sha256').update('old').digest('hex');
  try {
    for(const invalid of [{path:'foreign.mjs',oldSha256:null,content:'bad'},{path:'b.mjs',oldSha256:'stale',content:'bad'}]) {
      assert.throws(()=>applyOwnedCodexEdits(worker,JSON.stringify({edits:[{path:'a.mjs',oldSha256:sha,content:'new'},invalid]})),/ownership|precondition/);
      assert.equal(fs.readFileSync(path.join(root,'a.mjs'),'utf8'),'old');
    }
    const refs=applyOwnedCodexEdits(worker,JSON.stringify({edits:[{path:'a.mjs',oldSha256:sha,content:'new'},{path:'b.mjs',oldSha256:null,content:'created'}]}));
    assert.equal(refs.length,2);assert.equal(fs.readFileSync(path.join(root,'b.mjs'),'utf8'),'created');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('owned edits refuse symlinks and cancellation before any publication', async () => {
  const {applyOwnedCodexEdits}=await import('../../scripts/model-routing-execution-adapters.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-owned-links-'));
  fs.writeFileSync(path.join(root,'real'),'old');fs.symlinkSync('real',path.join(root,'alias'));
  const worker={ownership:{worktree:fs.realpathSync(root),paths:['alias','new']}};
  try {
    assert.throws(()=>applyOwnedCodexEdits(worker,JSON.stringify({edits:[{path:'alias',oldSha256:null,content:'bad'}]})),/Symlink/);
    assert.throws(()=>applyOwnedCodexEdits(worker,JSON.stringify({edits:[{path:'new',oldSha256:null,content:'bad'}]}),{signal:AbortSignal.abort()}),/cancelled/);
    assert.equal(fs.existsSync(path.join(root,'new')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('native resumed evidence requires exactly one new context and retains original session', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-resume-evidence-')),id=crypto.randomUUID();
  const dir=path.join(home,'sessions','2025','01','01');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`rollout-${id}.jsonl`),row={type:'turn_context',payload:{model:'first',effort:'low'}};
  try{
    fs.writeFileSync(file,JSON.stringify(row)+'\n');
    assert.equal(readCodexWorkerObservation(id,{home,allowHistory:true}).turnCount,1);
    fs.appendFileSync(file,JSON.stringify({...row,payload:{model:'second',effort:'high'}})+'\n');
    assert.equal(readCodexWorkerObservation(id,{home,expectedPriorTurns:1,evidencePath:file}).model,'second');
    assert.throws(()=>readCodexWorkerObservation(id,{home,expectedPriorTurns:2,evidencePath:file}),/unexpected turn/);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('native observation consuming the remaining deadline launches no worker', async () => {
  const { executeCodexWorkflowWorker } = await import('../../scripts/model-routing-execution-adapters.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-observation-deadline-')); let now = 0, launches = 0;
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: {}, auth_mode: 'chatgpt' }));
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    await assert.rejects(executeCodexWorkflowWorker({ binary: '/owned/native', prompt: 'Inspect the supplied fixture.', cwd: home,
      sessionId: crypto.randomUUID(), readOnly: true, timeoutMs: 1000, env: { HOME: home, CODEX_HOME: home },
      decision: { harness: 'codex', provider: 'openai', taskClass: 'medium', model: 'fixture-model', effort: 'medium',
        subscriptionCovered: true, selectionReviewedAt: new Date().toISOString() },
      allowance: async () => ({ ordinaryUsageAllowed: true }),
      observe: () => { now = 1001; return { turnCount: 1, evidence: { path: '/owned/history', byteLength: 1, sha256: '0'.repeat(64) } }; },
      launch: () => { launches++; throw new Error('must not launch'); } }), /deadline expired before launch/);
    assert.equal(launches, 0);
  } finally { clock.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('live child errors, failed kills and overflow cannot settle as clean success', async () => {
  const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
  const {executeCodexWorkflowWorker}=await import('../../scripts/model-routing-execution-adapters.mjs');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-worker-auth-'));
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{},auth_mode:'chatgpt'}));
  const decision={harness:'codex',provider:'openai',taskClass:'medium',model:'fixture-model',effort:'medium',subscriptionCovered:true,selectionReviewedAt:new Date().toISOString()};
  try{for(const mode of ['error','kill-error','overflow']){
    let child,unref=0;const kills=[];
    const launch=()=>{
      child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.unref=()=>unref++;
      child.kill=s=>{kills.push(s);if(mode==='kill-error')child.emit('error',Error('kill failed'));if(mode==='overflow')queueMicrotask(()=>child.emit('close',0,null));return false;};
      child.stdin.end=()=>queueMicrotask(()=>{if(mode==='error')child.emit('error',Error('failed send'));if(mode==='overflow')child.stdout.emit('data',Buffer.alloc(16*1024*1024+1));});return child;
    };
    await assert.rejects(executeCodexWorkflowWorker({binary:'/fixture',decision,prompt:'fixture',cwd:home,readOnly:true,timeoutMs:mode==='kill-error'?10:2000,
      env:{CODEX_HOME:home},launch,allowance:async()=>({ordinaryUsageAllowed:true}),observe:()=>({})}),/retirement|interrupted/);
    assert.ok(kills.includes('SIGTERM'));if(mode!=='overflow'){assert.ok(kills.includes('SIGKILL'));assert.equal(unref,1);assert.ok([child.stdin,child.stdout,child.stderr].every(s=>s.destroyed));}
  }}finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('independent native reviewer receives canonical original context plus trusted verdict contract', async () => {
  let dispatched;
  const {worker,adapter}=fixture({executeNative:async input=>{dispatched=input.prompt;return {model:'fixture-model',effort:'medium',completed:true,sessionId:'independent-native-session',answer:'{}'};}});
  const review={...worker,role:'reviewer',reviewContract:'Return strict independent verdict JSON.'};
  const state=await adapter.prepare({worker:review,timeoutMs:1000});await adapter.launch(state);
  assert.equal(dispatched,worker.prompt+'\n'+review.reviewContract);
  const result=adapter.interpret(state,await adapter.observe(state));
  assert.equal(result.observedEffort,'medium');assert.equal(result.configuredEffort,'medium');assert.equal(result.sessionId,'independent-native-session');
});

test('native commentary cannot contaminate the final structured answer', async () => {
  const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
  const {executeCodexWorkflowWorker}=await import('../../scripts/model-routing-execution-adapters.mjs');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'rnb-worker-final-'));fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{},auth_mode:'chatgpt'}));
  const id=crypto.randomUUID(),decision={harness:'codex',provider:'openai',taskClass:'medium',model:'fixture-model',effort:'medium',subscriptionCovered:true,selectionReviewedAt:new Date().toISOString()};
  try{
    const launch=()=>{
      const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
      child.stdin.end=()=>queueMicrotask(()=>{child.stdout.emit('data',[
        {type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text:'I will inspect the source.'}},
        {type:'item.completed',item:{type:'agent_message',text:'{"tasks":[]}'}},{type:'turn.completed',usage:{}}
      ].map(JSON.stringify).join('\n')+'\n');child.emit('close',0,null);});return child;
    };
    const result=await executeCodexWorkflowWorker({binary:'/fixture',decision,prompt:'fixture',cwd:home,readOnly:true,timeoutMs:2000,env:{CODEX_HOME:home},launch,
      allowance:async()=>({ordinaryUsageAllowed:true}),observe:()=>({sessionId:id,model:decision.model,effort:decision.effort,cwd:home,sandbox:{type:'read-only'}})});
    assert.equal(result.answer,'{"tasks":[]}');assert.equal(result.modelObserved,true);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('allowance metadata uses the validated native executable even when PATH points to the managed wrapper', async () => {
  const { executeCodexWorkflowWorker } = await import('../../scripts/model-routing-execution-adapters.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-worker-native-allowance-'));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: {}, auth_mode: 'chatgpt' }));
  const decision = { harness: 'codex', provider: 'openai', taskClass: 'medium', model: 'fixture-model', effort: 'medium', subscriptionCovered: true, selectionReviewedAt: new Date().toISOString() };
  const seen = [];
  try {
    await assert.rejects(executeCodexWorkflowWorker({ binary: '/validated/native/codex', decision, prompt: 'fixture', cwd: home, readOnly: true, timeoutMs: 1000,
      env: { CODEX_HOME: home, PATH: '/managed/wrapper' },
      launch: (...args) => { seen.push(args); return {}; },
      allowance: async options => { options.spawnHost('codex', ['app-server'], { env: options.env }); return { ordinaryUsageAllowed: false }; }
    }), /allowance/);
    assert.equal(seen.length, 1); assert.equal(seen[0][0], '/validated/native/codex');
    assert.deepEqual(seen[0][1], ['app-server']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test('Claude adapter floors fractional remaining time and never extends the absolute deadline', async () => {
  const native = vi.spyOn(controlledClaude, 'runControlledClaudeTurn').mockResolvedValue({});
  const now = vi.spyOn(Date, 'now').mockReturnValue(100000);
  try {
    const { worker, claude: adapter } = fixture({ executeNative: undefined, budget: { deadline: 105000 } });
    worker.decision = { ...worker.decision, harness: 'claude-code', provider: 'anthropic' };
    const fractional = await adapter.prepare({ worker, timeoutMs: 4998.938959 });
    await adapter.launch(fractional);
    assert.equal(native.mock.calls[0][0].timeoutMs, 4998);
    assert.equal(Number.isSafeInteger(native.mock.calls[0][0].timeoutMs), true);
    const delayed = await adapter.prepare({ worker, timeoutMs: 4998.938959 });
    now.mockReturnValue(104000);
    await adapter.launch(delayed);
    assert.equal(native.mock.calls[1][0].timeoutMs, 1000);
    const expired = await adapter.prepare({ worker, timeoutMs: 1000 });
    now.mockReturnValue(105001);
    await adapter.launch(expired);
    assert.equal(native.mock.calls.length, 2);
    assert.match(expired.error.message, /deadline exhausted/);
    now.mockReturnValue(100000);
    const exhaustedFraction = await adapter.prepare({ worker, timeoutMs: 0.8 });
    await adapter.launch(exhaustedFraction);
    assert.equal(native.mock.calls.length, 2);
    assert.match(exhaustedFraction.error.message, /deadline exhausted/);
  } finally { now.mockRestore(); native.mockRestore(); }
});


test('host-owned Claude schemas preserve existing role envelopes and negative reviews', () => {
  const planner = claudeWorkflowResponse('planner');
  assert.equal(planner.validateStructuredOutput({ tasks: [{ id: 'work', instructions: 'Read context', mode: 'read', checkIds: ['inspect'], acceptanceCriteria: [{ id: 'scope', assertion: 'Inspect bounded source context', checkIds: ['inspect'] }] }], unresolvedObligations: [] }), true);
  assert.equal(planner.validateStructuredOutput({ tasks: [{ id: 'work', instructions: 'Read context', mode: 'execute', checkIds: [] }] }), false);
  assert.equal(planner.validateStructuredOutput({ tasks: [{ id: 'work', instructions: 'Read context', mode: 'read', checkIds: [], command: 'unsafe' }] }), false);
  for (const role of ['worker', 'developer']) {
    const output = claudeWorkflowResponse(role);
    assert.equal(output.validateStructuredOutput({ outcome: 'done', artifacts: [{ path: 'proof' }], decisions: [1], risks: [null] }), true);
    assert.equal(output.validateStructuredOutput({ outcome: 'done', artifacts: [], decisions: [] }), false);
  }
  const review = claudeWorkflowResponse('reviewer');
  assert.equal(review.validateStructuredOutput({ passed: false, artifactDigest: 'a'.repeat(64), findings: [{ defect: true }], evidence: [{ inspected: true }] }), true);
  assert.equal(review.validateStructuredOutput({ passed: true, artifactDigest: 'a'.repeat(64), findings: [], evidence: [] }), false);
  for (const role of ['unknown', 'constructor', undefined]) assert.throws(() => claudeWorkflowResponse(role), /Unknown/);
});

test('Claude native allow rules still encounter owned scope and unresolved approval cannot replace that bound', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-clause-'))), calls = [];
  const worker = { id: 'bounded', host: 'claude', role: 'worker', configuredModel: 'fixture-model',
    decision: { harness: 'claude-code', provider: 'anthropic', model: 'fixture-model', effort: 'medium' },
    ownership: { mode: 'write', worktree: root, paths: ['owned.mjs'] }, prompt: 'Implement the original function.' };
  const request = { originalPrompt: worker.prompt, projectRoot: root, contextRefs: [], permissions: { write: true, apiBilling: false } };
  const native = vi.spyOn(controlledClaude, 'runControlledClaudeTurn').mockImplementation(async options => {
    const owned = { tool_name: 'Write', input: { file_path: path.join(root, 'owned.mjs') } }, outside = { tool_name: 'Write', input: { file_path: path.join(root, '..', 'outside.mjs') } };
    assert.equal(await options.scopeTool(owned), true); assert.equal(await options.scopeTool(outside), false);
    assert.equal(await options.scopeTool({ tool_name: 'Bash', input: { command: 'touch outside' } }), false);
    assert.equal(await options.scopeTool({ tool_name: 'Agent', input: {} }), false);
    assert.equal(await options.approve(outside), false); assert.equal(calls.length, 0);
    assert.equal(await options.approve(owned), false); assert.equal(calls.length, 1);
    return { decision: worker.decision, sessionId: crypto.randomUUID(), modelObserved: true, effortSettingsObserved: true,
      structuredOutput: true, finalAnswer: '{"outcome":"fixture","artifacts":[],"decisions":[],"risks":[]}' };
  });
  try {
    const adapter = createGuardedWorkflowAdapters({ request, budget: { deadline: Date.now() + 10000 }, binaries: { codex: process.execPath, claude: process.execPath }, verifyDecision: () => {},
      approve: async (permission, scope) => { calls.push([permission, scope]); return false; } }).claude;
    const state = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(state);
    assert.equal(adapter.interpret(state, await adapter.observe(state)).status, 'succeeded');
    assert.equal(calls[0][1].workerId, worker.id); assert.deepEqual(calls[0][1].ownership, worker.ownership);
    assert.equal(fs.existsSync(path.join(root, 'owned.mjs')), false);
  } finally { native.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('unconfirmed owned process retirement holds adapter cleanup fence after launch settles', async () => {
  const { worker, adapter } = fixture({ executeNative: async () => { throw Object.assign(new Error('owned close not observed'), {
    retirementUnconfirmed: true, retirementEvidence: { scope: 'owned-direct-child-only', retired: false, closeObserved: false, treeVerified: false },
  }); } });
  const state = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(state);
  assert.equal(state.finished, false); assert.equal(state.retirementUnconfirmed, true);
  assert.equal(adapter.interpret(state, await adapter.observe(state)).exitCategory, 'orphaned');
  await assert.rejects(adapter.cleanup(state), /not confirmed/);
});


test('P067 coordination lease cannot supply missing original write permission', async () => {
  let executions = 0;
  const { request, worker, adapter } = fixture({ executeNative: async () => { executions++; } });
  request.lease = { granted: true, mode: 'write', tools: ['Write'], network: true, apiBilling: true };
  worker.lease = request.lease;
  worker.ownership = { mode: 'write', worktree: fs.realpathSync(process.cwd()), paths: ['owned.mjs'] };
  await assert.rejects(adapter.prepare({ worker, timeoutMs: 5000 }), /write authority unavailable/);
  assert.equal(executions, 0);
});

test('P067 explicit read success with unbound policy remains unqualified policy evidence', async () => {
  const { request, worker, adapter } = fixture();
  request.lease = { granted: true, policyAuthorized: true, receiptId: 'coordination-only' };
  worker.lease = request.lease;
  const state = await adapter.prepare({ worker, timeoutMs: 5000 }); await adapter.launch(state);
  const result = adapter.interpret(state, await adapter.observe(state));
  assert.equal(result.status, 'succeeded'); // Domain mock result, not native/provider completion.
  assert.equal(result.policyAuthorization.enforced, false);
  assert.equal(result.policyAuthorization.evidence[0].status, 'UNKNOWN_UNBOUND');
  assert.equal(result.policyAuthorization.completionEligibility, 'not-established-by-authorization');
  assert.notEqual(result.nativeLaunched, true);
});
