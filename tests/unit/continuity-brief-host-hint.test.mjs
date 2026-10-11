// continuity-brief-host-hint.test.mjs — the brief's MORE line names a door that exists on the host
// reading it (RNBC review 2026-10-01). `/ruvnet-brain:rnb-brief` is a Claude Code plugin command
// (plugin/commands/rnb-brief.md); Codex has no such command and no rnb-brief skill (plugin/skills/),
// so a Codex session must be handed the node command alone.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildBrief } from '../../plugin/scripts/continuity-brief.mjs';
import { spawnSync } from 'node:child_process';
import { adoptedProject, cleanup } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
afterEach(cleanup);

const moreLine = (env, p) => buildBrief({ projectDir: p.dir, env, home: p.home, persistState: false })
  .context.split('\n').find((l) => l.startsWith('MORE: '));

describe('continuity brief: host-appropriate MORE hint', () => {
  it('labels an actual local Git tag without certifying publication', () => {
    const p = adoptedProject();
    const base = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];
    for (const args of [['commit', '--allow-empty', '-m', 'fixture'], ['tag', '-a', 'vfixture', '-m', 'fixture']]) {
      const result = spawnSync('git', [...base, ...args], { cwd: p.dir, env: p.env, encoding: 'utf8', timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
    }
    const brief = buildBrief({ projectDir: p.dir, env: p.env, home: p.home, persistState: false });
    expect(brief.context).toContain('local tag vfixture (publication unverified)');
    expect(brief.context).not.toContain('latest tag vfixture');
  });
  it.skipIf(process.platform === 'win32')('bounds all slow Git commands by one restore deadline and preserves the prior brief checkpoint', () => {
    const p = adoptedProject(); const bin = path.join(p.home, 'bin'); fs.mkdirSync(bin);
    const calls = path.join(p.home, 'git-calls.jsonl');
    const git = path.join(bin, 'git');
    fs.writeFileSync(git, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,90);process.exit(1);\n`);
    fs.chmodSync(git, 0o700);
    const state = path.join(p.dir, '.swarm', '.continuity-brief-state.json'); const prior = '{"lastBriefAt":12345}'; fs.writeFileSync(state, prior);
    const source = `import {restoreWithBrief} from ${JSON.stringify(new URL('../../plugin/scripts/continuity-brief.mjs', import.meta.url).href)};
      const start=Date.now();const r=await restoreWithBrief({env:process.env,cwd:process.cwd(),deadlineAt:start+450,
      restore:()=>({status:'restored',context:'fixture checkpoint'}),launch:()=>{throw new Error('unexpected launch')}});
      console.log(JSON.stringify({elapsedMs:Date.now()-start,degraded:r.degraded,brief:r.brief,context:r.context}));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: p.dir, encoding: 'utf8', timeout: 2500,
      env: { ...process.env, HOME: p.home, USERPROFILE: p.home, CLAUDE_PROJECT_DIR: p.dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    expect(run.status, run.stderr).toBe(0); const result = JSON.parse(run.stdout);
    expect(result.elapsedMs).toBeLessThan(1200); expect(result.degraded).toBe(true);
    // Project identity now fails CLOSED when Git is present but unusable (resolver safeGit), so an unusable Git
    // reports brief-read-failed; a slow-but-working Git reports deadline-exceeded. Both are 'unknown', never fabricated.
    expect(result.brief.status).toBe('unknown');
    expect(['deadline-exceeded', 'brief-read-failed']).toContain(result.brief.reason);
    expect(result.context).toContain('PROJECT CONTINUITY UNKNOWN'); expect(result.context).toContain('fixture checkpoint');
    expect(fs.readFileSync(state, 'utf8')).toBe(prior); expect(fs.readFileSync(calls, 'utf8').trim().split('\n').length).toBeLessThan(6);
  });
  it('Claude Code sessions get the plugin command, which exists', () => {
    const p = adoptedProject();
    expect(fs.existsSync(path.join(ROOT, 'plugin', 'commands', 'rnb-brief.md'))).toBe(true);
    const line = moreLine(p.env, p);
    expect(line).toContain('/ruvnet-brain:rnb-brief');
    expect(line).toMatch(/node ".*continuity-brief\.mjs" --full/);
  });

  it('Codex sessions (RUVNET_HOOK_HOST=codex) get only the node command — no Claude-only slash command', () => {
    const p = adoptedProject();
    expect(fs.readdirSync(path.join(ROOT, 'plugin', 'skills'))).not.toContain('rnb-brief');
    const line = moreLine({ ...p.env, RUVNET_HOOK_HOST: 'codex' }, p);
    expect(line).not.toContain('/ruvnet-brain:rnb-brief');
    expect(line).toMatch(/^MORE: node ".*continuity-brief\.mjs" --full/);
  });
});
