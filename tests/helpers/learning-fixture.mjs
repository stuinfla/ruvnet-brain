import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadNodeSqlite } from '../../plugin/scripts/node-sqlite.mjs';
import { learningQueueDepth } from '../../plugin/scripts/learning-observation.mjs';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
export function learningFixture(scope = 'project') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'learning-377-')));
  const home = path.join(root, 'home'); const project = path.join(root, 'project');
  fs.mkdirSync(home); fs.mkdirSync(project); fs.mkdirSync(path.join(project, '.swarm'));
  // Portable synthetic presence fixture; managed adoption is qualified separately
  // through installed Ruflo SDK initialization and exact native CLI readback.
  const { DatabaseSync: FixtureDatabase } = loadNodeSqlite();
  new FixtureDatabase(path.join(project, '.swarm', 'memory.db')).close();
  const queue = scope === 'user' ? path.join(home, '.cache', 'ruvnet-brain', 'learn') : path.join(project, '.swarm', 'ruvnet-brain-learn');
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  const calls = path.join(root, 'calls.jsonl');
  const native = path.join(root, 'learner.cjs');
  fs.writeFileSync(native, `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const args=process.argv.slice(2),arg=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({args,cwd:process.cwd(),daemon:process.env.RUFLO_DAEMON_AUTOSTART})+'\\n');
if(process.env.TEST_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.TEST_SLEEP));
if(process.env.TEST_NO_RECEIPT)process.exit(0);
const source=arg('--path')||arg('--db');fs.mkdirSync(path.dirname(source),{recursive:true});
const db=new DatabaseSync(source);
db.exec('CREATE TABLE IF NOT EXISTS memory_entries(id TEXT PRIMARY KEY,key TEXT,namespace TEXT,content TEXT,type TEXT,embedding TEXT,embedding_model TEXT,embedding_dimensions INTEGER,tags TEXT,metadata TEXT,owner_id TEXT,created_at INTEGER,updated_at INTEGER,expires_at INTEGER,last_accessed_at INTEGER,access_count INTEGER,status TEXT,provenance_type TEXT,UNIQUE(namespace,key))');
if(args[1]==='store') {
 if(process.env.TEST_SKIP_WRITE){db.close();process.exit(0);}
 const value=arg('--value');if(value.includes(process.env.TEST_FAIL_ACTION||'__no_failure__'))process.exit(1);
 db.prepare('INSERT OR IGNORE INTO memory_entries(id,key,namespace,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),arg('--key'),arg('--namespace'),value,'active',Date.now(),Date.now());
} else if(args[1]==='retrieve') { if(process.env.TEST_FAKE_RETRIEVE){console.log(process.env.TEST_FAKE_RETRIEVE);db.close();process.exit(0);}const r=db.prepare('SELECT content FROM memory_entries WHERE key=? AND namespace=?').get(arg('--key'),arg('--namespace'));if(r)console.log(r.content);else process.exit(1);
} else if(args[1]==='backup') { const dir=arg('--dir');fs.mkdirSync(dir,{recursive:true});db.exec("VACUUM INTO '"+path.join(dir,'snapshot-'+Date.now()+'.db').replaceAll("'","''")+"'");if(process.env.TEST_SNAPSHOT_ROW_MISMATCH){const image=new DatabaseSync(path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.db'))));image.prepare('DELETE FROM memory_entries WHERE namespace=?').run('learning-observations');image.close();}const copies=fs.readdirSync(dir).filter(n=>n.endsWith('.db')).sort();while(copies.length>Number(arg('--keep')||3))fs.rmSync(path.join(dir,copies.shift()));console.log(process.env.TEST_BACKUP_COPY?'memory DB backed up (byte-copy, encrypted-at-rest) → snapshot':'memory DB backed up → snapshot');
} else if(args[1]==='distill') { if(process.env.TEST_NO_DISTILL)process.exit(0);db.exec('CREATE TABLE IF NOT EXISTS reasoning_patterns(id INTEGER PRIMARY KEY,metadata TEXT); CREATE TABLE IF NOT EXISTS distill_state(namespace TEXT PRIMARY KEY,last_rowid INTEGER,last_run_at INTEGER)');db.prepare('INSERT INTO reasoning_patterns(metadata)VALUES(?)').run(JSON.stringify({namespace:'learning-observations'}));db.prepare('INSERT OR REPLACE INTO distill_state VALUES(?,?,?)').run('learning-observations',1,Date.now()); }
db.close();`);
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),cp=require('node:child_process'),original=cp.spawnSync;
const originalOpen=fs.opendirSync;fs.opendirSync=(dir,...args)=>{if(process.env.TEST_STALL_SCAN&&String(dir).includes('ruvnet-brain-learn'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);return originalOpen(dir,...args);};
cp.spawnSync=(file,args,options)=>original(file,['hooks','memory'].includes(args?.[0])?[process.env.TEST_NATIVE,...args]:args,options);
require('node:module').syncBuiltinESMExports();`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_LEARNING_SCOPE: scope,
    RUVNET_BRAIN_PROJECT_DIR: project, RUVNET_BRAIN_HOME: path.join(home, 'brain'),
    RUVNET_BRAIN_STATE_DIR: path.join(home, 'state'), RUFLO_BIN: process.execPath,
    NODE_OPTIONS: `--require=${preload}`, TEST_NATIVE: native, TEST_CALLS: calls,
    RUVNET_TURN_CAPTURE: 'off', RUVNET_CONTINUITY_CAPTURE: 'off' };
  if (scope === 'user') {
    const { DatabaseSync } = loadNodeSqlite(); const globalDir = path.join(home, '.claude', 'global-memory', '.swarm');
    fs.mkdirSync(globalDir, { recursive: true }); new DatabaseSync(path.join(globalDir, 'memory.db')).close();
    fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}');
  }
  return { root, home, project, queue, calls, env,
    write(sid, rows) { const file = path.join(queue, `session-${sid}.jsonl`); fs.writeFileSync(file, rows); return file; },
    run(script = 'plugin/scripts/learn-flush.mjs', args = ['--sync'], overrides = {}, input = {}) {
      return spawnSync(process.execPath, [path.join(repository, script), ...args], {
        cwd: project, env: { ...env, ...overrides }, input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000 });
    },
    depth() { return learningQueueDepth(queue); },
    readCalls() { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.args[1] === 'store'); } catch { return []; } },
    cleanup() { fs.rmSync(root, { force: true, recursive: true }); },
  };
}
