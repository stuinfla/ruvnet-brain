import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
let home;
afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); });
describe('forced refresh after a held pre-Undo measurement', () => {
  it('withdraws the old writer, coalesces repeated requests, and scans the restored project once', () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-refresh-queue-'));
    const program = `
      import fs from 'node:fs'; import path from 'node:path'; import {EventEmitter} from 'node:events';
      import {kickRefreshDetailed,serveCached,writeCache} from ${JSON.stringify(new URL('../../scripts/onboarding-console.mjs', import.meta.url).href)};
      const home=process.env.HOME, project=path.join(home,'restored-project'), file=path.join(home,'.claude/ruvnet-brain/state-cache.json');
      fs.mkdirSync(project,{recursive:true});
      const world=path.join(project,'settings.json'); fs.writeFileSync(world,JSON.stringify({npx:false}));
      const children=[], scopes=[];
      function spawnRefresh(_node,_args,options) {
        scopes.push(options.cwd); const child=new EventEmitter(); child.unref=()=>{};
        const snapshot=JSON.parse(fs.readFileSync(world));
        child.publish=()=>writeCache(file,new Date().toISOString(),{sections:{wiring:snapshot}},project);
        children.push(child); return child;
      }
      kickRefreshDetailed({force:true,cwd:project,spawnRefresh});
      // Undo restores the actual project while the pre-Undo snapshot's child is held.
      fs.writeFileSync(world,JSON.stringify({npx:true}));
      const queued=[];
      for(let i=0;i<3;i++) queued.push(kickRefreshDetailed({force:true,followUp:true,cwd:project,spawnRefresh}).queued);
      children[0].publish(); // A pre-Undo child publishes late, after invalidation.
      let answer; serveCached({writeHead(){},end(body){answer=JSON.parse(body);}},file,d=>d,project);
      const staleBefore=answer.stale, oldBefore=answer.sections.wiring.npx;
      children[0].emit('exit',0,null);
      const withdrawn=JSON.parse(fs.readFileSync(file)).at;
      children[1].publish(); children[1].emit('exit',0,null);
      const after=JSON.parse(fs.readFileSync(file));
      console.log(JSON.stringify({queued,staleBefore,oldBefore,withdrawn,children:children.length,scopes,project,
        afterScope:after.scope,restoredAfter:after.data.sections.wiring.npx}));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_CONSOLE_ROOT: home, RUVNET_BRAIN_IMPORT_ONLY: '1', RUVNET_BRAIN_HOME: path.join(home, '.cache/ruvnet-brain') },
      encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.queued).toEqual([true, true, true]); expect(out.oldBefore).toBe(false); expect(out.staleBefore).toBe(true);
    expect(out.withdrawn).toBe(new Date(0).toISOString()); expect(out.children).toBe(2);
    expect(out.scopes).toEqual([out.project, out.project]); expect(out.afterScope).toBe(out.project); expect(out.restoredAfter).toBe(true);
  });
});
