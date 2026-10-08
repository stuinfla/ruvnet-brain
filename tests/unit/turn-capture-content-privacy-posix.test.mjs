import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureTurnOutcome, resolveTurnDb } from '../../plugin/scripts/turn-outcome-capture.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
 const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'private-policy-denial-'))); roots.push(home);
 const projectDir = path.join(home, 'project'), brainHome = path.join(home, 'brain');
 fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true }); fs.writeFileSync(path.join(projectDir, '.swarm', 'memory.db'), '');
 const policy = path.join(brainHome, 'turn-capture/policy.json'); fs.mkdirSync(path.dirname(policy), { recursive: true });
 return { home, projectDir, brainHome, env: { HOME: home, USERPROFILE: home, RUFLO_BIN: process.execPath },
   write: extra => fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, projects: {}, ...extra })) };
}
it('inaccessible persisted OFF policy parent refuses actual capture rather than treating policy as absent',()=>{
  expect(process.getuid?.(), 'Real permission-denial qualification requires an unprivileged POSIX runner').not.toBe(0);
  const h=fixture();h.write({projects:{[h.projectDir]:'off'}});const file=path.join(h.brainHome,'turn-capture','policy.json'),parent=path.dirname(file);let launches=0;
  try{
    fs.chmodSync(parent,0o000);expect(()=>fs.statSync(file)).toThrow();
    expect(resolveTurnDb({projectDir:h.projectDir,brainHome:h.brainHome}).skipped).toBe('turn capture policy unreadable or invalid');
    const result=captureTurnOutcome({projectDir:h.projectDir,event:'Stop',payload:{last_assistant_message:'Controlled denial fixture only, never a claimed native observation. '.repeat(3)},
      env:{...process.env,...h.env,RUVNET_TURN_CAPTURE:'force'},home:h.home,brainHome:h.brainHome,launch:()=>{launches++;return{};}});
    expect(result.queued).toBe(false);expect(result.skipped).toBe('turn capture policy unreadable or invalid');expect(launches).toBe(0);
  }finally{fs.chmodSync(parent,0o700);}
});
