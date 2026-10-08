import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { learningFixture, repository } from '../helpers/learning-fixture.mjs';
import { loadNodeSqlite } from '../../plugin/scripts/node-sqlite.mjs';
import { withProgressionReader } from '../../plugin/scripts/project-progression-reader.mjs';
import { learningQueueDepth } from '../../plugin/scripts/learning-observation.mjs';
import { takeQueueLock, ownsQueueLock, pendingRecords } from '../../plugin/scripts/learning-queue.mjs';
const fixtures = [];
const setup = (scope) => { const f = learningFixture(scope); fixtures.push(f); return f; };
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
const row = (action = 'npm test') => JSON.stringify({ tool: 'Bash', action }) + '\n';
const waitFor = async (check) => { const until = Date.now() + 8000; while (!check() && Date.now() < until) await new Promise(r => setTimeout(r, 25)); expect(check()).toBe(true); };

test.each(['project', 'user'])('all older SIDs make bounded progress in %s scope and original learner cwd', scope => {
  const f = setup(scope);
  for (let i = 0; i < 48; i++) f.write(`orphan-${i}`, row().repeat(i < 10 ? 24 : 23));
  expect(f.depth()).toBe(1114);
  f.run(); expect(f.depth()).toBe(1106);
  expect(f.readCalls()).toHaveLength(8);
  const db = scope === 'user' ? path.join(f.home, '.claude', 'global-memory', '.swarm', 'memory.db') : path.join(f.project, '.swarm', 'memory.db');
  expect(f.readCalls().every(c => c.args[c.args.indexOf('--path') + 1] === db)).toBe(true);
  expect(f.readCalls().every(c => c.daemon === '0')).toBe(true);
});

test('OFF, malformed persisted consent, and unadopted project create zero capture bytes and call no learner', () => {
  for (const disabled of ['brain', 'learning', 'malformed', 'values', 'settings', 'unadopted']) {
    const f = setup(); fs.rmSync(f.queue, { recursive: true });
    let overrides = {};
    if (disabled === 'brain') overrides = { RUVNET_BRAIN_OFF: '1' };
    if (['learning','malformed','values','settings'].includes(disabled)) {
      fs.writeFileSync(path.join(f.project, '.swarm', 'ruvnet-brain-settings.json'), disabled === 'learning' ? '{"learningScope":"off"}' : disabled === 'values' ? '{"values":"broken"}' : disabled === 'settings' ? '{"settings":[]}' : '{broken');
    }
    if (disabled === 'unadopted') { fs.rmSync(path.join(f.project, '.swarm'), { recursive: true }); overrides = { RUVNET_LEARNING_SCOPE: '' }; }
    const run = f.run('plugin/scripts/learn-capture.mjs', [], overrides, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {success:true} });
    expect(run.status).toBe(0); expect(fs.existsSync(f.queue)).toBe(false); expect(f.readCalls()).toEqual([]);
  }
});

test('concurrent capture while an older file drains retains every event and strips private metadata', async () => {
  const f = setup(); const original = f.write('old', row('git status'));
  const worker = spawn(process.execPath, [path.join(repository, 'plugin/scripts/learn-flush.mjs'), '--sync'], {
    cwd: f.project, env: { ...f.env, TEST_SLEEP: '300' }, stdio: 'ignore' });
  await waitFor(() => f.readCalls().length === 1);
  for (let i = 0; i < 6; i++) f.run('plugin/scripts/learn-capture.mjs', [], {}, {
    session_id: '../../private-session', tool_name: 'Edit', tool_input: { file_path: '/private/sentinel-company-secret.md', new_string: 'token-secret-sentinel' }, tool_response: { success: true } });
  if (worker.exitCode === null) await new Promise(resolve => worker.once('exit', resolve));
  expect(fs.readFileSync(original, 'utf8')).toBe(row('git status'));
  const captured = fs.readdirSync(f.queue).filter(n => n.endsWith('.jsonl')).map(n => fs.readFileSync(path.join(f.queue, n), 'utf8'));
  expect(captured).toHaveLength(7); expect(captured.join('')).not.toMatch(/sentinel|token|company/);
  await waitFor(() => !fs.existsSync(path.join(f.queue, '.worker-lock')));
  f.run(); expect(f.depth()).toBe(0); expect(f.readCalls()).toHaveLength(7);
});

test('duplicate workers have one fenced owner, stale and torn lock recovery permits bounded progress', () => {
  const f = setup(); f.write('orphan', row());
  const context = { scope: 'project', queueDir: f.queue, projectDir: f.project };
  const token = takeQueueLock(context);
  expect(ownsQueueLock(context, token)).toBe(true); expect(takeQueueLock(context)).toBeNull();
  f.run(); expect(f.readCalls()).toEqual([]);
  const lock = path.join(f.queue, '.worker-lock'); fs.writeFileSync(lock, '{torn');
  fs.utimesSync(lock, new Date(Date.now() - 70000), new Date(Date.now() - 70000));
  f.run(); expect(f.depth()).toBe(0); expect(ownsQueueLock(context, token)).toBe(false);
});

test('replacement bytes invalidate acknowledgments; malformed and failed legacy records remain intact', () => {
  const f = setup(); const file = f.write('legacy', row('npm test'));
  f.run(); expect(f.depth()).toBe(0);
  fs.writeFileSync(file, row('git status') + 'private raw malformed\n');
  expect(pendingRecords(file).records).toHaveLength(2);
  f.run(); expect(f.depth()).toBe(1); expect(fs.readFileSync(file, 'utf8')).toContain('private raw malformed');
});

test('slow learner is killed on the worker deadline and shutdown scheduling stays below native cap', async () => {
  const f = setup(); f.write('slow', row());
  const start = Date.now(); const run = f.run(undefined, [], { TEST_SLEEP: '10000', LEARN_FLUSH_DEADLINE_MS: '250' });
  expect(run.status).toBe(0); expect(Date.now() - start).toBeLessThan(2500);
  await waitFor(() => {try{return JSON.parse(fs.readFileSync(path.join(f.queue,'.worker-lock'))).retirementUnconfirmed===true;}catch{return false;}});
  expect(f.depth()).toBe(1);
  await waitFor(()=>fs.readdirSync(f.queue).some(n=>n.startsWith('.run-')));
  const receipts = fs.readdirSync(f.queue).filter(n => n.startsWith('.run-')).map(n => JSON.parse(fs.readFileSync(path.join(f.queue, n))));
  expect(receipts.at(-1).failed).toBe(1); expect(receipts.at(-1).acknowledged).toBe(0);
});

test('exit zero without a recorded receipt acknowledges nothing', () => {
  const f = setup(); const file = f.write('noop', row()); const before = fs.readFileSync(file);
  f.run(undefined, undefined, { TEST_NO_RECEIPT: '1' });
  expect(f.depth()).toBe(1); expect(fs.readFileSync(file)).toEqual(before);
});

test('more than 128 retained history files cannot strand a later live session', () => {
  const f = setup();
  for (let i = 0; i < 130; i++) f.write(`history-${i}`, row());
  for (let i = 0; i < 17; i++) f.run();
  expect(f.depth()).toBe(0);
  f.write('later-live-session', row('git status'));
  f.run(); if (f.depth()) f.run();
  expect(f.depth()).toBe(0); expect(f.readCalls()).toHaveLength(131);
}, 60_000);

test('killed worker leaves original work available and successor replays after lease expiry', async () => {
  const f = setup(); const file = f.write('killed', row());
  const worker = spawn(process.execPath, [path.join(repository, 'plugin/scripts/learn-flush.mjs'), '--worker'], {
    cwd: f.project, env: { ...f.env, TEST_SLEEP: '400' }, stdio: 'ignore' });
  await waitFor(() => f.readCalls().length === 1);
  worker.kill('SIGKILL'); await new Promise(resolve => worker.once('exit', resolve));
  const lock = path.join(f.queue, '.worker-lock'); const owner = JSON.parse(fs.readFileSync(lock));
  fs.writeFileSync(lock, JSON.stringify({ ...owner, expires: 0 }));
  f.run(); expect(f.depth()).toBe(0); expect(f.readCalls()).toHaveLength(2);
  expect(fs.readFileSync(file, 'utf8')).toBe(row());
});

test('persisted OFF during a learner call prevents acknowledgment and receipt writes', async () => {
  const f = setup(); f.write('policy-flip', row());
  const worker = spawn(process.execPath, [path.join(repository, 'plugin/scripts/learn-flush.mjs'), '--worker'], {
    cwd: f.project, env: { ...f.env, TEST_SLEEP: '400' }, stdio: 'ignore' });
  await waitFor(() => f.readCalls().length === 1);
  fs.mkdirSync(f.env.RUVNET_BRAIN_STATE_DIR); fs.writeFileSync(path.join(f.env.RUVNET_BRAIN_STATE_DIR, 'brain-off'), '');
  await new Promise(resolve => worker.once('exit', resolve));
  expect(f.depth()).toBe(1);
  expect(fs.readdirSync(f.queue).some(name => name.includes('ack.json') || name.startsWith('.run-'))).toBe(false);
});

test('automatic project drain isolates legacy home history; explicit remedy retains home scope', () => {
  const f = setup(); f.write('project', row());
  const { DatabaseSync } = loadNodeSqlite(); const globalDir = path.join(f.home, '.claude', 'global-memory', '.swarm');
  fs.mkdirSync(globalDir, { recursive: true }); new DatabaseSync(path.join(globalDir, 'memory.db')).close();
  const legacy = path.join(f.home, '.cache', 'ruvnet-brain', 'learn'); fs.mkdirSync(legacy, { recursive: true });
  const file = path.join(legacy, 'session-old-user.jsonl'); const bytes = row('secret-unrecognized-command private-value'); fs.writeFileSync(file, bytes);
  f.run(); expect(learningQueueDepth(legacy)).toBe(1);
  const result = f.run('scripts/health-repair.mjs', ['--flush-legacy-user-learning']);
  expect(result.status, result.stdout + result.stderr).toBe(0); expect(learningQueueDepth(legacy)).toBe(0);
  expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  const call = f.readCalls().at(-1); expect(call.args).toContain(path.join(globalDir, 'memory.db')); expect(call.args.join(' ')).toContain('command');
  expect(call.args.join(' ')).not.toContain('private-value');
});

test('directory and queue symlinks are refused without modifying external bytes', () => {
  const f = setup(); const external = path.join(f.root, 'external'); fs.mkdirSync(external);
  const file = path.join(external, 'session-private.jsonl'); fs.writeFileSync(file, row());
  fs.rmSync(f.queue, { recursive: true }); fs.symlinkSync(external, f.queue, process.platform === 'win32' ? 'junction' : 'dir');
  const before = fs.readFileSync(file); f.run(); expect(f.readCalls()).toEqual([]); expect(fs.readFileSync(file)).toEqual(before);
});

test('nonzero or still-running native shell results create no capture bytes',()=>{
 for(const tool_response of ['Process exited with code 1\nprivate output','Process running with session ID 441']){const f=setup();fs.rmSync(f.queue,{recursive:true});f.run('plugin/scripts/learn-capture.mjs',[],{},{tool_name:'Bash',tool_input:{command:'npm test'},tool_response});expect(fs.existsSync(f.queue)).toBe(false);expect(f.readCalls()).toEqual([]);}
});
test('existing global store alone does not authorize user capture',()=>{
 const f=setup('user');fs.rmSync(f.queue,{recursive:true});fs.rmSync(path.join(f.home,'.config','ruvnet-brain','settings.json'));f.run('plugin/scripts/learn-capture.mjs',[],{},{hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'npm test'},tool_response:{success:true}});expect(fs.existsSync(f.queue)).toBe(false);expect(f.readCalls()).toEqual([]);
});
test('byte-copy backup is rejected without undo fiction; verified observations stay committed',()=>{
 const f=setup();f.write('backup-fallback',row());f.run();expect(f.depth()).toBe(0);const receipt=fs.readdirSync(f.queue).find(n=>n.startsWith('.run-'));const result=JSON.parse(fs.readFileSync(path.join(f.queue,receipt)));expect(result.distillation.completed).toBe(false);expect(result.recorded[0].independentRow).toBe(true);
 const manual=f.run('scripts/health-repair.mjs',['--train-learning'],{TEST_BACKUP_COPY:'1'});expect(manual.status).not.toBe(0);expect(manual.stderr).toContain('Exact inverse is unverified');
 const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);expect(calls.some(call=>call.args[1]==='backup')).toBe(true);expect(calls.some(call=>call.args[1]==='distill')).toBe(false);
});
test('an unsafe sibling sidecar cannot permanently strand safe older sessions',()=>{
 const f=setup();const bad=f.write('bad-first',row());fs.writeFileSync(bad+'.ack.json','{broken');const good=f.write('good-second',row());f.run();expect(pendingRecords(good).records).toHaveLength(0);expect(fs.readFileSync(bad+'.ack.json','utf8')).toBe('{broken');
});

test('mature retained queue cannot delay the native scheduler and every late record remains recoverable',async()=>{
 const f=setup();for(let i=0;i<4096;i++)f.write('retained-'+i,'');f.write('later-live',row());
 const start=Date.now();const r=f.run(undefined,[],{LEARN_FLUSH_DEADLINE_MS:'1500'});expect(r.status).toBe(0);expect(Date.now()-start).toBeLessThan(2500);
 await waitFor(()=>!fs.existsSync(path.join(f.queue,'.worker-lock')));
 for(let i=0;i<34&&f.depth();i++)f.run();expect(f.depth()).toBe(0);expect(f.readCalls()).toHaveLength(1);expect(fs.readdirSync(f.queue).filter(n=>n.endsWith('.jsonl'))).toHaveLength(4097);
},30000);
test('external supervisor retires a synchronously stalled scan at the absolute deadline',async()=>{
 const f=setup();const original=f.write('stalled',row());const start=Date.now();f.run(undefined,undefined,{TEST_STALL_SCAN:'1',LEARN_FLUSH_DEADLINE_MS:'300'});expect(Date.now()-start).toBeLessThan(2000);
 const file=fs.readdirSync(f.queue).find(n=>n.startsWith('.run-'));const result=JSON.parse(fs.readFileSync(path.join(f.queue,file)));expect(result.reason).toMatch(/deadline/);expect(result.retirementState).toBe('UNKNOWN');expect(result.treeVerified).toBe(false);expect(JSON.parse(fs.readFileSync(path.join(f.queue,'.worker-lock'))).retirementUnconfirmed).toBe(true);expect(f.depth()).toBe(1);expect(fs.readFileSync(original,'utf8')).toBe(row());await new Promise(r=>setTimeout(r,300));expect(f.readCalls()).toEqual([]);
});
test('automatic distillation is restricted while explicit cycles retain three snapshots and disclose the missing inverse',()=>{
 const f=setup();f.write('first-cycle',row());f.run();f.write('second-cycle',row());f.run();
 let calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);expect(calls.filter(c=>['backup','distill'].includes(c.args[1]))).toHaveLength(0);
 for(let i=0;i<4;i++){const r=f.run('scripts/health-repair.mjs',['--train-learning']);expect(r.status,r.stdout+r.stderr).toBe(0);expect(r.stderr).toContain('Exact inverse is unverified');}
 const dir=path.join(f.project,'.swarm','learning-backups');expect(fs.readdirSync(dir).filter(n=>n.endsWith('.db'))).toHaveLength(3);expect(fs.existsSync(path.join(dir,'latest-receipt.json'))).toBe(true);expect(f.depth()).toBe(0);
},20000);

test('P031 successful PostToolUse cannot adopt an absent canonical store through project env selection', async () => {
  const f=setup();fs.rmSync(path.join(f.project,'.swarm'),{recursive:true});
  const result=f.run('plugin/scripts/learn-capture.mjs',[],{RUVNET_LEARNING_SCOPE:'project'},
    {hook_event_name:'PostToolUse',session_id:'p031-unadopted',tool_name:'Bash',tool_input:{command:'npm test'},tool_response:{success:true}});
  try {expect(result.status).toBe(0);expect(fs.existsSync(f.queue)).toBe(false);expect(f.readCalls()).toEqual([]);}
  finally {await waitFor(()=>!fs.existsSync(path.join(f.queue,'.worker-lock')));}
});


test('P031 exact CLI claims cannot acknowledge absent independent canonical rows', () => {
  const f=setup();const bytes=row();const file=f.write('independent-refusal',bytes);
  const value=JSON.stringify({schemaVersion:1,tool:'Bash',action:'npm test',scope:'project',authoritative:false,provenance:'system-observation',outcome:'host-reported-success'});
  const result=f.run(undefined,undefined,{TEST_SKIP_WRITE:'1',TEST_FAKE_RETRIEVE:value});
  expect(result.status).toBe(0);expect(fs.readFileSync(file,'utf8')).toBe(bytes);expect(f.depth()).toBe(1);
  const receipt=fs.readdirSync(f.queue).find(n=>n.startsWith('.run-'));
  expect(JSON.parse(fs.readFileSync(path.join(f.queue,receipt),'utf8')).recorded).toEqual([]);
});

test.each(['directory-only','missing-file'])('P031 canonical adoption refuses %s even with successful selected project input', async mode => {
  const f=setup();fs.rmSync(path.join(f.project,'.swarm','memory.db'));
  fs.rmSync(f.queue,{recursive:true});
  if(mode==='missing-file')fs.rmSync(path.join(f.project,'.swarm'),{recursive:true});
  const result=f.run('plugin/scripts/learn-capture.mjs',[],{},
    {hook_event_name:'PostToolUse',tool_name:'Edit',tool_input:{file_path:'private.md',new_string:'private'},tool_response:{success:true}});
  expect(result.status).toBe(0);expect(fs.existsSync(f.queue)).toBe(false);expect(f.readCalls()).toEqual([]);
});


test.each(['off','malformed','on'])('P031 linked canonical project %s consent applies to successful capture with env/local selection', async state => {
  const f=setup();const git=(args)=>execFileSync('git',args,{cwd:f.project,stdio:'pipe'});
  git(['init','-q']);git(['-c','core.hooksPath='+path.join(f.root,'no-hooks'),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','private linked fixture']);
  const linked=path.join(f.root,'linked');git(['worktree','add','-qb','linked-fixture',linked]);
  fs.mkdirSync(path.join(linked,'.swarm'));fs.writeFileSync(path.join(linked,'.swarm','ruvnet-brain-settings.json'),JSON.stringify({learningScope:'project'}));
  fs.writeFileSync(path.join(f.project,'.swarm','ruvnet-brain-settings.json'),state==='malformed'?'{malformed':JSON.stringify({learningScope:state==='off'?'off':'project'}));
  const input={hook_event_name:'PostToolUse',tool_name:'Edit',tool_input:{file_path:'safe.js',new_string:'private'},tool_response:{success:true}};
  const run=spawnSync(process.execPath,[path.join(repository,'plugin/scripts/learn-capture.mjs')],{cwd:linked,env:{...f.env,RUVNET_BRAIN_PROJECT_DIR:linked,RUVNET_BRAIN_PROJECT_SETTINGS_FILE:path.join(linked,'.swarm','ruvnet-brain-settings.json')},input:JSON.stringify(input),encoding:'utf8',timeout:10000});
  const queue=path.join(linked,'.swarm','ruvnet-brain-learn');
  try {
    expect(run.status).toBe(0);
    const {learningContext}=await import('../../plugin/scripts/runtime-preferences.mjs');
    const context=learningContext({env:{...f.env,RUVNET_BRAIN_PROJECT_DIR:linked},cwd:linked});
    expect(context.projectDir).toBe(fs.realpathSync.native(linked));
    if(state==='on'){
      expect(fs.existsSync(queue)).toBe(true);
      await waitFor(()=>!fs.existsSync(path.join(queue,'.worker-lock')) && fs.readdirSync(queue).some(n=>n.startsWith('.run-')));
      const report=JSON.parse(fs.readFileSync(path.join(queue,fs.readdirSync(queue).find(n=>n.startsWith('.run-'))),'utf8'));
      expect(report.recorded[0]).toMatchObject({db:path.join(f.project,'.swarm','memory.db'),exactCli:true,independentRow:true});
      const stored=withProgressionReader(report.recorded[0].db,r=>r.readContent('learning-observations',report.recorded[0].key));
      expect(stored.ok).toBe(true);
      expect(JSON.parse(stored.value)).toEqual({schemaVersion:1,tool:'Edit',action:'edit file',scope:'project',authoritative:false,provenance:'system-observation',outcome:'host-reported-success'});
    } else {expect(context.enabled).toBe(false);expect(fs.existsSync(queue)).toBe(false);expect(f.readCalls()).toEqual([]);}
  } finally {await waitFor(()=>!fs.existsSync(path.join(queue,'.worker-lock')));}
});

test('P031 successful user capture refuses a missing adopted user store even with persisted user consent', () => {
  const f=setup('user');fs.rmSync(f.queue,{recursive:true});
  fs.rmSync(path.join(f.home,'.claude','global-memory','.swarm','memory.db'));
  const result=f.run('plugin/scripts/learn-capture.mjs',[],{},
    {hook_event_name:'PostToolUse',tool_name:'Bash',tool_input:{command:'npm test'},tool_response:{success:true}});
  expect(result.status).toBe(0);expect(fs.existsSync(f.queue)).toBe(false);expect(f.readCalls()).toEqual([]);
});


test('P032 source-reported online snapshot with mismatched observation rows refuses before any distillation',()=>{
 const f=setup();const bytes=row();const file=f.write('snapshot-verification',bytes);f.run();
 const before=fs.readFileSync(file);
 const result=f.run('scripts/health-repair.mjs',['--train-learning'],{TEST_SNAPSHOT_ROW_MISMATCH:'1'});
 expect(result.status).not.toBe(0);expect(fs.readFileSync(file)).toEqual(before);
 const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);
 expect(calls.some(c=>c.args[1]==='backup')).toBe(true);expect(calls.some(c=>c.args[1]==='distill')).toBe(false);
});
