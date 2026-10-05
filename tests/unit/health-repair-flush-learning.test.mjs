// Actual repair process and canonical observations share one selected queue/store.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { learningFixture } from '../helpers/learning-fixture.mjs';
const fixtures=[];
const setup=scope=>{const f=learningFixture(scope);fixtures.push(f);fs.mkdirSync(path.join(f.project,'plugin'),{recursive:true});fs.cpSync(new URL('../../plugin/scripts/',import.meta.url),path.join(f.project,'plugin','scripts'),{recursive:true});return f;};
afterEach(()=>fixtures.splice(0).forEach(f=>f.cleanup()));
const row=JSON.stringify({tool:'Bash',action:'npm test'})+'\n';
it.each(['project','user'])('repair drains every SID across bounded rounds in %s canonical scope',scope=>{
 const f=setup(scope);f.write('first-real-sid',row.repeat(12));f.write('second-real-sid',row.repeat(3));
 const r=f.run('scripts/health-repair.mjs',['--flush-learning']);
 expect(r.status,r.stdout+r.stderr).toBe(0);expect(r.stdout).toMatch(/fed 15 captured events/);expect(f.depth()).toBe(0);expect(f.readCalls()).toHaveLength(15);
 const db=scope==='project'?path.join(f.project,'.swarm','memory.db'):path.join(f.home,'.claude','global-memory','.swarm','memory.db');
 expect(f.readCalls().every(c=>c.args[c.args.indexOf('--path')+1]===db)).toBe(true);
},30000);
it('unverified canonical delivery fails honestly and preserves original queue',()=>{
 const f=setup('user');const file=f.write('failed',row.repeat(4));const before=fs.readFileSync(file);
 const r=f.run('scripts/health-repair.mjs',['--flush-learning'],{TEST_NO_RECEIPT:'1'});
 expect(r.status).not.toBe(0);expect(r.stdout).toMatch(/fed 0 of 4 queued events/);expect(r.stdout).toMatch(/preserved for retry/);expect(f.depth()).toBe(4);expect(fs.readFileSync(file)).toEqual(before);
});
it('persisted OFF leaves the queue untouched and does not call Ruflo',()=>{
 const f=setup();f.write('off',row);fs.writeFileSync(path.join(f.project,'.swarm','ruvnet-brain-settings.json'),'{"learningScope":"off"}');
 const r=f.run('scripts/health-repair.mjs',['--flush-learning']);expect(r.status).toBe(0);expect(r.stdout).toMatch(/switched off/);expect(f.depth()).toBe(1);expect(f.readCalls()).toEqual([]);
});
it('empty selected queue reports its exact scope as caught up',()=>{
 const f=setup('user');const r=f.run('scripts/health-repair.mjs',['--flush-learning']);expect(r.status).toBe(0);expect(r.stdout).toMatch(/nothing queued in .*ruvnet-brain\/learn/);expect(f.readCalls()).toEqual([]);
});
