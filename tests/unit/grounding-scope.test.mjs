import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validate, saveSettings, loadSettings } from '../../plugin/scripts/user-settings.mjs';
import { groundingScopeMatches, groundingSubjectAllowed } from '../../plugin/scripts/ruvnet-gate1-pattern.mjs';
import { armFor, writeArm, readMarker, consumeMarker } from '../../plugin/scripts/grounding-turn-mark.mjs';
import { decide } from '../../plugin/scripts/grounding-turn-gate.mjs';
import { auditAssertions } from '../../plugin/scripts/grounding-turn-evidence.mjs';
const root = path.resolve(import.meta.dirname, '../../plugin');
const homes = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
const scope = ['ruvector', 'metaharness'];
function home(scopeValue = scope) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb320-')); homes.push(h);
  const brain = path.join(h, '.cache/ruvnet-brain'), code = path.join(brain, 'versions/owned/plugin');
  fs.mkdirSync(code, { recursive: true }); fs.cpSync(path.join(root, 'scripts'), path.join(code, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/codex-hook-wrapper.mjs'), path.join(brain, 'codex-hook.mjs'));
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ codeRoot: code, version: 'owned', generation: 1 }));
  fs.writeFileSync(path.join(brain, '.stack-versions-checked'), String(Math.floor(Date.now()/1000)));
  const settings = path.join(h, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({ version: 1, settings: { groundingScope: scopeValue, advocacy: 1 } }));
  return { h, brain, code, settings };
}
function fire(f, host, id, payload) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'hooks', host === 'codex' ? 'codex-hooks.json' : 'hooks.json')));
  const command = Object.values(manifest.hooks).flat().flatMap(x => x.hooks).find(x => x.command.includes(` ${id}`))?.command;
  expect(command).toBeTruthy();
  const started = performance.now();
  const r = spawnSync('bash', ['-c', command], { input: JSON.stringify({ ...payload, cwd: f.h }), cwd: f.h, encoding: 'utf8', timeout: 12000,
    env: { PATH: process.env.PATH, HOME: f.h, CODEX_HOME: path.join(f.h, '.codex'), CLAUDE_PLUGIN_ROOT: f.code,
      RUVNET_BRAIN_HOME: f.brain, RUVNET_SETTINGS_FILE: f.settings, RUVNET_AGENTDB_FIRST: 'off', RUVNET_BRAIN_NO_NETWORK: '1', RUVNET_HOOK_HOST: host } });
  expect(r.status, r.stderr).toBe(0); return { ...r, elapsedMs: performance.now() - started };
}
describe('Issue320 conversational scope contract', () => {
  it('validates aliases and preserves malformed/unknown/empty inputs as all with errors', () => {
    expect(validate({ groundingScope: ['RuVector', 'RVF', 'ruvector-postgres', 'MetaHarness'] }).values.groundingScope).toEqual(scope);
    for (const raw of [[], ['unknown'], null, false, {}, ['ruvector', 1], 'none']) {
      const r = validate({ groundingScope: raw }); expect(r.ok).toBe(false); expect(r.values.groundingScope).toBe('all');
    }
    expect(validate({}).values.groundingScope).toBe('all');
    for (const term of ['ruvector', 'RVF', 'ruvector-postgres', 'metaharness']) expect(groundingScopeMatches(term, scope)).toBe(true);
    for (const term of ['ruflo', 'agentdb', 'agentic-flow', 'swarm', 'sparc']) expect(groundingScopeMatches(term, scope)).toBe(false);
  });
  it('saves and reloads the setting without changing other owner choices', () => {
    const f = home(); const r = saveSettings({ groundingScope: ['RVF'] }, { file: f.settings }); expect(r.ok).toBe(true);
    const stored = loadSettings(f.settings).values; expect(stored.groundingScope).toEqual(['ruvector']); expect(stored.advocacy).toBe(1); expect(stored.brainProfile).toBe('complete');
  });
  it('does not rearm excluded fork capability questions through the second classifier', () => {
    expect(armFor({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'What can Ruflo do?' }, ['ruflo'], scope)).toMatchObject({ gate1: true, assert: false, groundingScope: scope });
    expect(armFor({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'What can PostgreSQL do?' }, ['postgresql'], scope)?.assert).toBe(true);
    expect(auditAssertions({ message: 'Ruflo supports persistent memory.', subjects: ['ruflo'], sources: [], subjectAllowed: s => groundingSubjectAllowed(s, scope) }).findings).toEqual([]);
    expect(auditAssertions({ message: 'PostgreSQL supports transactions.', subjects: ['postgresql'], sources: [], subjectAllowed: s => groundingSubjectAllowed(s, scope) }).findings.length).toBeGreaterThan(0);
  });
  it('freezes scope in the episode and merges queued arms conservatively', () => {
    const f=home(), file=path.join(f.h,'marker.json'); writeArm(file,{gate1:true,assert:false,subjects:[],groundingScope:scope});
    writeArm(file,{gate1:true,assert:false,subjects:[],groundingScope:['ruflo']}); expect(readMarker(file).groundingScope).toEqual([...scope,'ruflo']);
    expect(decide({ hookInput:{ last_assistant_message:'Ruflo supports memory.' }, marker:{gate1:true,assert:true,subjects:['ruflo'],groundingScope:scope},markerMs:Date.now(),env:{RUVNET_HOOK_HOST:'codex'} })).toBeNull();
  });
});
describe.skipIf(process.platform === 'win32')('Issue320 actual registered command deliveries', () => {
  for (const host of ['claude','codex']) {
    it(`${host}: original pin and fork assertion prompts remain quiet; selected claims still require sources`, () => {
      const f=home();
      for (const [i,prompt] of ['bump the ruflo pin in my setup script to 3.42.5','What can Ruflo do?'].entries()) {
        const payload={hook_event_name:'UserPromptSubmit',session_id:`excluded-${i}`,prompt};
        const directive=fire(f,host,'ground-ruvnet',payload); expect(directive.stdout).not.toContain('ground before you assert'); expect(directive.elapsedMs).toBeLessThan(4500);
        fire(f,host,'grounding-turn-mark',payload); expect(readMarker(path.join(f.brain,'grounding-turn',`excluded-${i}.json`)).groundingScope).toEqual(scope);
        expect(fire(f,host,'grounding-turn-gate',{hook_event_name:'Stop',session_id:`excluded-${i}`,last_assistant_message:'Ruflo supports memory.'}).stdout).toBe('');
      }
      fire(f,host,'grounding-turn-mark',{hook_event_name:'UserPromptSubmit',session_id:'introduced',prompt:'What can Ruflo do?'});
      expect(fire(f,host,'grounding-turn-gate',{hook_event_name:'Stop',session_id:'introduced',last_assistant_message:'RuVector supports automatic cross-cloud transactions.'}).stdout).toContain('search_ruvnet');
      for (const [i,prompt] of ['RVF storage','ruvector-postgres','MetaHarness routing'].entries()) {
        const payload={hook_event_name:'UserPromptSubmit',session_id:`selected-${i}`,prompt};
        expect(fire(f,host,'ground-ruvnet',payload).stdout).toContain('ground before you assert');
        fire(f,host,'grounding-turn-mark',payload);
        expect(fire(f,host,'grounding-turn-gate',{hook_event_name:'Stop',session_id:`selected-${i}`,last_assistant_message:'RuVector supports vector search.'}).stdout).toContain('search_ruvnet');
      }
    });
    it(`${host}: default and corrupt scope retain all-product grounding`, () => {
      for (const raw of ['all', [], ['unknown']]) {
        const f=home(raw),payload={hook_event_name:'UserPromptSubmit',session_id:'default',prompt:'ruflo memory'};
        expect(fire(f,host,'ground-ruvnet',payload).stdout).toContain('ground before you assert');
        fire(f,host,'grounding-turn-mark',payload);expect(fs.existsSync(path.join(f.brain,'grounding-turn/default.json'))).toBe(true);
      }
    });
  }
  it('scope opt-out never opens AgentDB write or managed raw SQL guards', () => {
    const f=home();fs.mkdirSync(path.join(f.h,'.claude/model-router'),{recursive:true});fs.writeFileSync(path.join(f.h,'.claude/model-router/profile.json'),'{}');
    for (const content of ['import agentdb\n', 'import agentdb\nimport sqlite3\ndb=sqlite3.connect(".swarm/memory.db")\ndb.execute("DELETE FROM memory_entries")']) {
      const r=spawnSync('bash',[path.join(root,'scripts/ground-before-write.sh')],{input:JSON.stringify({tool_name:'Write',tool_input:{file_path:path.join(f.h,'unsafe.py'),content}}),encoding:'utf8',env:{...process.env,HOME:f.h,RUVNET_SETTINGS_FILE:f.settings},cwd:f.h});expect(r.status,r.stderr).toBe(2);
    }
  });
});


describe('Issue320 marker ownership and monotonic obligation', () => {
  const arm = groundingScope => ({ gate1:true, assert:false, architecture:false, subjects:[], groundingScope });
  it('retains all when it is committed just before a delayed narrowed publication', () => {
    const f=home(), file=path.join(f.h,'interleaved.json'); writeArm(file,arm(['ruvector']));
    const original=fs.renameSync; let intercepted=false;
    try {
      fs.renameSync=(from,to) => {
        if (to===file && !intercepted) { intercepted=true; writeArm(file,arm('all')); }
        return original(from,to);
      };
      writeArm(file,arm(['metaharness']));
    } finally { fs.renameSync=original; }
    expect(intercepted).toBe(true);expect(readMarker(file).groundingScope).toBe('all');
    const episode=consumeMarker(file);expect(episode.marker.groundingScope).toBe('all');
    expect(decide({hookInput:{last_assistant_message:'Ruflo supports persistent memory.'},marker:episode.marker,markerMs:episode.markerMs,env:{RUVNET_HOOK_HOST:'codex'}})).toContain('search_ruvnet');
  });
  it('does not consume a held prompt or remove its owner; contention remains all', () => {
    const f=home(),file=path.join(f.h,'held.json');writeArm(file,arm(['ruvector']));
    fs.writeFileSync(file+'.lock','successor-token');
    const original=fs.readFileSync(file,'utf8'),result=consumeMarker(file);
    expect(result.marker.groundingScope).toBe('all');expect(fs.readFileSync(file,'utf8')).toBe(original);
    expect(fs.readFileSync(file+'.lock','utf8')).toBe('successor-token');
    expect(readMarker(file).groundingScope).toBe('all');
  });
  it('marker read failure cannot silently downgrade the merged obligation', () => {
    const f=home(),file=path.join(f.h,'read-error.json');writeArm(file,arm(['ruvector']));
    const original=fs.readFileSync;
    try {fs.readFileSync=(target,...args)=>{if(target===file) throw Object.assign(new Error('owned EIO'),{code:'EIO'});return original(target,...args);};writeArm(file,arm(['metaharness']));}
    finally {fs.readFileSync=original;}
    expect(readMarker(file).groundingScope).toBe('all');
  });
  it('release failure and replacement owner retain the conservative obligation', () => {
    const f=home(),file=path.join(f.h,'release-error.json'),original=fs.unlinkSync;
    try {fs.unlinkSync=target=>{if(target===file+'.lock') throw Object.assign(new Error('owned release error'),{code:'EIO'});return original(target);};writeArm(file,arm(['ruvector']));}
    finally {fs.unlinkSync=original;}
    expect(readMarker(file).groundingScope).toBe('all');expect(fs.existsSync(file+'.lock')).toBe(true);
    fs.unlinkSync(file+'.lock');
    const rename=fs.renameSync;
    try {fs.renameSync=(from,to)=>{const result=rename(from,to);if(to===file) fs.writeFileSync(file+'.lock','new-owner-token');return result;};writeArm(file,arm(['metaharness']));}
    finally {fs.renameSync=rename;}
    expect(fs.readFileSync(file+'.lock','utf8')).toBe('new-owner-token');expect(readMarker(file).groundingScope).toBe('all');
  });
  it('a contending prompt published during Stop consumption survives for the next boundary', () => {
    const f=home(),file=path.join(f.h,'stop-overlap.json');writeArm(file,arm(['ruvector']));
    const original=fs.unlinkSync;let once=false;
    try {fs.unlinkSync=target=>{if(target===file&&!once){once=true;writeArm(file,arm('all'));}return original(target);};consumeMarker(file);}
    finally {fs.unlinkSync=original;}
    expect(once).toBe(true);expect(readMarker(file).groundingScope).toBe('all');expect(consumeMarker(file).marker.groundingScope).toBe('all');
  });
  it('loss of owner before staged commit cannot publish narrow data or remove successor lock', () => {
    const f=home(),file=path.join(f.h,'commit-fence.json');writeArm(file,arm(['ruvector']));const before=fs.readFileSync(file,'utf8'),rename=fs.renameSync;
    try {fs.renameSync=(from,to)=>{const result=rename(from,to);if(to.startsWith(file+'.staged-'))fs.writeFileSync(file+'.lock','replacement-owner');return result;};writeArm(file,arm(['metaharness']));}
    finally {fs.renameSync=rename;}
    expect(fs.readFileSync(file,'utf8')).toBe(before);expect(fs.readFileSync(file+'.lock','utf8')).toBe('replacement-owner');expect(readMarker(file).groundingScope).toBe('all');
  });
  it.skipIf(process.platform==='win32')('sidecar symlinks never narrow evidence or read/change the target', () => {
    const f=home(),file=path.join(f.h,'symlink.json'),target=path.join(f.h,'owner-note');fs.writeFileSync(target,'private owned sentinel');writeArm(file,arm(['ruvector']));
    fs.symlinkSync(target,file+'.all'); const result=consumeMarker(file);
    expect(result.marker.groundingScope).toBe('all');expect(fs.readFileSync(target,'utf8')).toBe('private owned sentinel');expect(fs.lstatSync(file+'.all').isSymbolicLink()).toBe(true);expect(fs.existsSync(file)).toBe(true);
  });
  it('no episode remains silent and creates no cache or lock', () => {
    const f=home(),file=path.join(f.h,'never-created','weather.json');expect(consumeMarker(file)).toBeNull();expect(fs.existsSync(path.dirname(file))).toBe(false);
  });
});
