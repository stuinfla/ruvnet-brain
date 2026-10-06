import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { learningContext } from '../../plugin/scripts/runtime-preferences.mjs';
import { observeLearning } from '../../plugin/scripts/learning-observation.mjs';
import { loadNodeSqlite } from '../../plugin/scripts/node-sqlite.mjs';
import { learningFixture } from '../helpers/learning-fixture.mjs';
const fixtures=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.cleanup()));
const consoleUrl=new URL('../../scripts/onboarding-console.mjs',import.meta.url).href;
function seed(db,count){
 fs.mkdirSync(path.dirname(db),{recursive:true});const {DatabaseSync}=loadNodeSqlite();const c=new DatabaseSync(db);
 c.exec('CREATE TABLE IF NOT EXISTS memory_entries(id TEXT PRIMARY KEY,key TEXT,namespace TEXT,content TEXT,type TEXT,embedding TEXT,embedding_model TEXT,embedding_dimensions INTEGER,tags TEXT,metadata TEXT,owner_id TEXT,created_at INTEGER,updated_at INTEGER,expires_at INTEGER,last_accessed_at INTEGER,access_count INTEGER,status TEXT,provenance_type TEXT,UNIQUE(namespace,key));CREATE TABLE distill_state(namespace TEXT PRIMARY KEY,last_rowid INTEGER,last_run_at INTEGER);CREATE TABLE reasoning_patterns(id INTEGER PRIMARY KEY,metadata TEXT)');
 const insert=c.prepare('INSERT INTO memory_entries(id,key,namespace,content,status)VALUES(?,?,?,?,?)');for(let i=0;i<count;i++)insert.run(String(i),'seed-'+i,'learning-observations','safe observation','active');
 c.prepare('INSERT INTO distill_state VALUES(?,?,?)').run('learning-observations',1,Date.now()-1961280000);c.close();
}
function fixture({scope='project',noTraining=false}={}){
 const f=learningFixture(scope);fixtures.push(f);f.nested=path.join(f.project,'nested');fs.mkdirSync(f.nested);
 f.env={...f.env,RUVNET_BRAIN_TEST:'1',RUVNET_CONSOLE_ROOT:f.home,CLAUDE_PROJECT_DIR:f.project,TEST_NO_DISTILL:noTraining?'1':undefined};
 f.projectDb=path.join(f.project,'.swarm','memory.db');f.userDb=path.join(f.home,'.claude','global-memory','.swarm','memory.db');seed(f.projectDb,5);seed(f.userDb,1312);
 f.projectQueue=path.join(f.project,'.swarm','ruvnet-brain-learn');f.userQueue=path.join(f.home,'.cache','ruvnet-brain','learn');
 for(const [dir,count]of[[f.projectQueue,60],[f.userQueue,1114]]){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'session-orphan.jsonl'),'synthetic\n'.repeat(count));}return f;
}
function consoleProbe(f,apply=false){const r=spawnSync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(consoleUrl)});const before=m.observeLearning();const applied=${apply?"m.apply(['learning:train'])":'null'};console.log(JSON.stringify({before,applied,after:m.observeLearning()}));`],{cwd:f.nested,env:f.env,encoding:'utf8',timeout:30000});expect(r.status,r.stderr).toBe(0);return JSON.parse(r.stdout.trim().split('\n').at(-1));}
it.each(['project','user'])('Console reads %s canonical store and corresponding queue from served nested project',scope=>{
 const f=fixture({scope}),r=consoleProbe(f);expect(r.before).toMatchObject({projectDir:f.project,scope,queueKnown:true,statusKnown:true,queueDir:scope==='project'?f.projectQueue:f.userQueue,queueDepth:scope==='project'?60:1114,observations:scope==='project'?5:1312,learningDb:scope==='project'?f.projectDb:f.userDb});expect(fs.existsSync(f.calls)).toBe(false);
});
it.each([false,true])('Console Apply verifies separate canonical pattern progress, no-op=%s',noTraining=>{
 const f=fixture({noTraining}),r=consoleProbe(f,true);expect(r.applied.results[0].ok).toBe(!noTraining);expect(r.after.patterns).toBe(noTraining?0:1);
 const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);expect(calls.some(c=>c.args.includes('distill'))).toBe(true);expect(calls.every(c=>c.args[c.args.indexOf('--db')+1]===f.projectDb&&c.daemon==='0')).toBe(true);expect(observeLearning({env:{...f.env,RUVNET_LEARNING_SCOPE:'user'},cwd:f.project}).statusKnown).toBe(false);
 if(noTraining)expect(r.applied.results[0].log).toMatch(/without measurable pattern progress/);
});
it('OFF and unadopted observations neither initialize a learner nor read queues',()=>{
 const f=fixture();fs.mkdirSync(f.env.RUVNET_BRAIN_STATE_DIR);fs.writeFileSync(path.join(f.env.RUVNET_BRAIN_STATE_DIR,'brain-off'),'');expect(observeLearning({env:f.env,cwd:f.nested})).toMatchObject({enabled:false,queueDepth:0,statusKnown:false});expect(fs.existsSync(f.calls)).toBe(false);
 const stranger=path.join(f.root,'stranger');fs.mkdirSync(stranger);const env={...f.env,RUVNET_BRAIN_PROJECT_DIR:undefined,RUVNET_LEARNING_SCOPE:undefined,RUVNET_BRAIN_STATE_DIR:path.join(f.root,'other-state')};expect(learningContext({env,cwd:stranger})).toMatchObject({enabled:false,disabledReason:'unadopted',projectDir:stranger});expect(fs.readdirSync(stranger)).toEqual([]);
});
it('symlinked queue is unknown and retains private bytes',()=>{
 const f=fixture();fs.rmSync(f.projectQueue,{recursive:true});fs.symlinkSync(f.userQueue,f.projectQueue,process.platform==='win32'?'junction':'dir');expect(observeLearning({env:f.env,cwd:f.nested})).toMatchObject({queueKnown:false,queueDepth:0});expect(fs.readFileSync(path.join(f.userQueue,'session-orphan.jsonl'),'utf8')).toBe('synthetic\n'.repeat(1114));
});
