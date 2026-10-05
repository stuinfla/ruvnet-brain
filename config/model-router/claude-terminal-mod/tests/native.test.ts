import type { On, HookStream, TurnStepChunk, TurnStepResult } from 'claude-code';
import { expect, test } from 'claude-code/testing';
const nonce = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const now = 1791120000000;
function stubs(on: On, decisions: Record<string, unknown>[], captures: Record<string, unknown>[], fail = false) {
  on('clock.now', () => ({ value: now }));
  on('env.get', ($, e) => ({ value: e.name === 'RNB_CLAUDE_MOD_NONCE' ? nonce : '/tmp/receipt.json' }));
  on('session.version', () => ({ value: { version: '2.1.289' } }));
  on('session.id', () => ({ value: 'native-fixture-session' }));
  on('process.run', ($, e) => {
    if (e.argv.includes('--ready')) return { value: { exitCode: 0, stdout: JSON.stringify({nonce,status:'ready'}), stderr:'',isStdoutTruncated:false,isStderrTruncated:false } };
    captures.push(JSON.parse(e.init!.stdin!));
    const decision = decisions.shift();
    if (fail) throw new Error('helper failed');
    return { value: {exitCode:0, stdout:JSON.stringify({schemaVersion:1,subscriptionCovered:true,expiresAt:now+60000,routeDigest:digest,...decision}),stderr:'',isStdoutTruncated:false,isStderrTruncated:false} };
  });
  on('session.start', ($, e) => ({cwd:e.cwd}));
  on('prompt.submit', ($, e) => { if(e.attachments) captures.push({passedAttachments:e.attachments});return {text:e.text}; });
  on('turn.start', ($, e) => ({turnId:e.turnId}));
  on('turn.step', async function* ($, e) {
    captures.push({model:e.model,effort:e.effort,turnId:e.turnId,index:e.index});
    yield {kind:'text',index:0,text:'native stream preserved'};
    return {turnId:e.turnId,index:e.index,answer:'native stream preserved',toolUses:[],stopReason:'end_turn',usage:null};
  });
}
async function resultOf(stream: HookStream<TurnStepChunk, TurnStepResult>) { let result; for (;;) {const item=await stream.next();if(item.done){result=item.value;break;}} return result; }
test('two user turns route different models and efforts while streaming native results', async ($, on) => {
  const captures: Record<string, unknown>[]=[];
  stubs(on,[{model:'claude-sonnet-fixture',effort:'low',taskClass:'fast'},{model:'claude-opus-fixture',effort:'high',taskClass:'hard'}],captures);
  await $.session.start({cwd:'/tmp',surface:'terminal',isInteractive:true});
  for (const [turnId,text] of [['one','summarize these supplied notes'],['two','perform a security audit and prove correctness']] as const) {
    await $.prompt.submit({text});
    await $.turn.start({text,turnId});
    const result=await resultOf($.turn.step({turnId,index:0,model:'wrong-default',effort:'medium',messageCount:1}));
    expect(result.answer).toBe('native stream preserved');
  }
  expect(captures.filter(x=>x.turnId)).toEqual([
    {model:'claude-sonnet-fixture',effort:'low',turnId:'one',index:0},
    {model:'claude-opus-fixture',effort:'high',turnId:'two',index:0},
  ]);
});
test('unbound model step refuses without passing to core', async ($, on) => {
  const captures: Record<string, unknown>[]=[];stubs(on,[],captures);
  await $.session.start({cwd:'/tmp',surface:'terminal',isInteractive:true});
  const result=await resultOf($.turn.step({turnId:'missing',index:7,model:'wrong',messageCount:1}));
  expect(result.stopReason).toBe('refusal');expect(result.turnId).toBe('missing');expect(result.index).toBe(7);
  expect(captures.length).toBe(0);
});
test('helper exception drops prompt through immediate catch', async ($, on) => {
  const captures: Record<string, unknown>[]=[];stubs(on,[],captures,true);
  await $.session.start({cwd:'/tmp',surface:'terminal',isInteractive:true});
  expect('drop' in await $.prompt.submit({text:'summarize notes'})).toBe(true);
});
test('coding uses high effort and final hook rewrite keeps original hard floor', async ($, on) => {
  const captures: Record<string, unknown>[]=[];
  stubs(on,[{model:'claude-sonnet-fixture',effort:'high',taskClass:'medium'},
    {model:'claude-opus-fixture',effort:'high',taskClass:'hard'},
    {model:'claude-opus-fixture',effort:'high',taskClass:'hard'}],captures);
  await $.session.start({cwd:'/tmp',surface:'terminal',isInteractive:true});
  await $.prompt.submit({text:'implement this module'});await $.turn.start({text:'implement this module',turnId:'code'});
  await resultOf($.turn.step({turnId:'code',index:1,model:'wrong',messageCount:2}));
  await $.prompt.submit({text:'security audit'});await $.turn.start({text:'summarize notes',turnId:'changed'});
  await resultOf($.turn.step({turnId:'changed',index:0,model:'wrong',messageCount:2}));
  expect(captures.some(x=>x.minimumClass==='hard')).toBe(true);
  expect(captures.filter(x=>x.turnId).map(x=>x.effort)).toEqual(['high','high']);
});

test('invalid or non-subscription bridge replies drop before prompt reaches core', async ($, on) => {
  const captures: Record<string, unknown>[]=[];
  stubs(on,[{model:'claude-sonnet-fixture',effort:'low',taskClass:'fast',subscriptionCovered:false},
    {model:'claude-sonnet-fixture',effort:'low',taskClass:'fast',routeDigest:'invalid'}],captures);
  await $.session.start({cwd:'/tmp',surface:'terminal',isInteractive:true});
  expect('drop' in await $.prompt.submit({text:'summarize notes'})).toBe(true);
  expect('drop' in await $.prompt.submit({text:'summarize notes'})).toBe(true);
});
test('image-only user prompt retains attachments and binds a conservative hard allocation', async ($, on) => {
  const captures: Record<string, unknown>[]=[];
  stubs(on,[{model:'claude-opus-fixture',effort:'high',taskClass:'hard'}],captures);
  await $.session.start({cwd:'/tmp',surface:'terminal',isInteractive:true});
  await $.prompt.submit({text:'',attachments:[{type:'image',mediaType:'image/png',filename:'fixture.png'}]});
  await $.turn.start({text:'',turnId:'image'});
  await resultOf($.turn.step({turnId:'image',index:0,model:'wrong',messageCount:1}));
  expect(captures.find(x=>x.passedAttachments)?.passedAttachments).toEqual([{type:'image',mediaType:'image/png',filename:'fixture.png'}]);
  expect(captures.filter(x=>x.turnId)[0]?.model).toBe('claude-opus-fixture');
});
