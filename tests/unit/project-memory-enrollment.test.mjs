import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { enrollmentPlan, ensureProjectMemory, enrollProjectMemory } from '../../plugin/scripts/project-memory-enrollment.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';

const roots = [];
function fixture({ git = true, policy = { schemaVersion: 1, projects: {}, paths: {}, default: 'on' } } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-enrollment-test-'))); roots.push(root);
  const home = path.join(root, 'home'); const project = path.join(home, 'projects', 'example');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(path.join(brainHome, 'turn-capture'), { recursive: true });
  if (git) execFileSync('git', ['init', '-q'], { cwd: project });
  fs.writeFileSync(path.join(brainHome, 'turn-capture', 'policy.json'), JSON.stringify(policy));
  return { root, home, project, brainHome, env: { ...process.env, RUVNET_TURN_CAPTURE: 'force', HOME: home, RUVNET_BRAIN_HOME: brainHome } };
}
function policy(f, change) {
  const file = path.join(f.brainHome, 'turn-capture', 'policy.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change }));
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const planOptions = { temporaryRoots: [], systemRoots: [] };

describe('consent-gated project memory enrollment', () => {
  it('enrolls legitimate Git projects under default on while excluding temporary roots', () => {
    const f = fixture();
    expect(enrollmentPlan({ projectDir: f.project, env: f.env, ...planOptions }).state).toBe('pending');
    expect(enrollmentPlan({ projectDir: f.project, env: f.env }).state).toBe('disabled');
    expect(fs.existsSync(path.join(f.project, '.swarm'))).toBe(false);
  });
  it('requires explicit on for non-Git and preserves path off over project and default on', () => {
    const f = fixture({ git: false });
    expect(enrollmentPlan({ projectDir: f.project, env: f.env, ...planOptions }).state).toBe('disabled');
    policy(f, { projects: { [f.project]: 'on' } });
    expect(enrollmentPlan({ projectDir: f.project, env: f.env }).state).toBe('pending');
    policy(f, { paths: { [f.project]: 'off' } });
    expect(ensureProjectMemory({ projectDir: f.project, env: f.env, launch: () => { throw new Error('must not launch'); } }).state).toBe('disabled');
    expect(fs.existsSync(path.join(f.project, '.swarm'))).toBe(false);
  });
  it('preserves an existing store byte for byte without bootstrapping', () => {
    const f = fixture(); fs.mkdirSync(path.join(f.project, '.swarm'));
    const db = path.join(f.project, '.swarm', 'memory.db'); fs.writeFileSync(db, 'existing store fixture');
    expect(ensureProjectMemory({ projectDir: f.project, env: f.env, launch: () => { throw new Error('must not launch'); } }).state).toBe('existing');
    expect(fs.readFileSync(db, 'utf8')).toBe('existing store fixture');
  });
  it('queues the first derived boundary before launch without raw prompt, transcript or excluded content', () => {
    const f = fixture(); policy(f, { projects: { [f.project]: 'on' }, contentPathExcludes: [path.join(f.project, 'private')] });
    let atLaunch;
    const result = ensureProjectMemory({ projectDir: f.project, env: f.env, event: 'Stop', payload: {
      session_id: 'first', last_assistant_message: `Decision: inspect ${f.project}/private/record`, prompt: 'SECRET', transcript_path: '/secret/transcript' },
    launch: () => { atLaunch = fs.readdirSync(path.join(f.project, '.swarm', '.memory-enrollment-pending')); return true; } });
    expect(result).toMatchObject({ state: 'pending', queued: true, launched: true });
    expect(atLaunch).toHaveLength(1);
    const queued = fs.readFileSync(path.join(f.project, '.swarm', '.memory-enrollment-pending', atLaunch[0]), 'utf8');
    expect(queued).not.toMatch(/SECRET|transcript|private\/record/);
    expect(queued).toContain('REDACTED');
  });
  it('withholds assistant text from the queue while turn capture is off, without suspending the boundary', () => {
    const f = fixture(); policy(f, { projects: { [f.project]: 'on' } });
    const swarm = path.join(f.project, '.swarm'); fs.mkdirSync(swarm, { recursive: true });
    fs.writeFileSync(path.join(swarm, 'memory.db'), 'half-enrolled store');
    fs.writeFileSync(path.join(swarm, '.memory-enrollment.json'), JSON.stringify({ schemaVersion: 1, state: 'pending' }));
    const result = ensureProjectMemory({ projectDir: f.project, env: { ...f.env, RUVNET_TURN_CAPTURE: 'off' }, event: 'Stop', launch: () => false,
      payload: { session_id: 'off', last_assistant_message: 'OFFSECRETWORDS we decided something important about storage.' } });
    expect(result).toMatchObject({ state: 'pending', queued: true });
    const queue = path.join(swarm, '.memory-enrollment-pending');
    const files = fs.readdirSync(queue).filter((n) => /\.json$/.test(n));
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(queue, files[0]), 'utf8')).not.toContain('OFFSECRETWORDS');
  });
  it('self-heals after a hook was killed mid-write: torn receipt and torn queue entry never wedge enrollment', async () => {
    const f = fixture(); policy(f, { projects: { [f.project]: 'on' } });
    const swarm = path.join(f.project, '.swarm'); fs.mkdirSync(swarm, { recursive: true });
    fs.writeFileSync(path.join(swarm, '.memory-enrollment.json'), '');           // torn pending receipt
    expect(enrollmentPlan({ projectDir: f.project, env: f.env }).state).toBe('pending');
    const queued = ensureProjectMemory({ projectDir: f.project, env: f.env, event: 'Stop', launch: () => false,
      payload: { session_id: 'torn', last_assistant_message: 'We decided to keep the append-only native store for this project.' } });
    expect(queued).toMatchObject({ state: 'pending', queued: true });
    const queue = path.join(swarm, '.memory-enrollment-pending');
    const torn = `${'a'.repeat(64)}.json`; fs.writeFileSync(path.join(queue, torn), '');   // torn queue entry
    let stored; const replayed = [];
    const run = (_, args) => { if (args[1] === 'store') { stored = args[args.indexOf('--value') + 1]; return { status: 0 }; } return { status: 0, stdout: stored }; };
    const result = await enrollProjectMemory({ projectDir: f.project, env: f.env, run,
      replay: (dir, event, options) => { replayed.push(event); return { turn: { queued: true } }; } });
    expect(result.state).toBe('ready');
    expect(replayed).toEqual(['Stop']);                                           // the valid boundary still replayed
    expect(fs.existsSync(path.join(queue, torn))).toBe(false);
    expect(fs.existsSync(path.join(queue, `${torn}.corrupt`))).toBe(true);        // evidence preserved
    expect(JSON.parse(fs.readFileSync(path.join(swarm, '.memory-enrollment.json'), 'utf8')).state).toBe('ready');
  });
  it('keeps partial bootstrap pending until exact same-path readback succeeds, with strict native flags', async () => {
    const f = fixture(); policy(f, { projects: { [f.project]: 'on' } });
    ensureProjectMemory({ projectDir: f.project, env: f.env, launch: () => false });
    let stored; const calls = [];
    const run = (_, args, options) => {
      calls.push({ args, cwd: options.cwd });
      if (args[1] === 'store') { stored = args[args.indexOf('--value') + 1]; fs.writeFileSync(path.join(f.project, '.swarm', 'memory.db'), 'partial fixture'); return { status: 1 }; }
      return { status: 0, stdout: stored };
    };
    const failed = await enrollProjectMemory({ projectDir: f.project, env: f.env, run: (_, args) => {
      if (args[1] === 'store') fs.writeFileSync(path.join(f.project, '.swarm', 'memory.db'), 'partial fixture');
      return { status: 1, stdout: '' };
    } });
    expect(failed.state).toBe('pending');
    expect(enrollmentPlan({ projectDir: f.project, env: f.env }).state).toBe('pending');
    expect((await enrollProjectMemory({ projectDir: f.project, env: f.env, run })).state).toBe('ready');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--require-native', '--append-only', '--no-upsert', '--no-embedding']));
    expect(calls[1].args[calls[1].args.indexOf('--path') + 1]).toBe(calls[0].args[calls[0].args.indexOf('--path') + 1]);
    expect(calls[0].cwd).not.toBe(f.project);
    expect(fs.existsSync(calls[0].cwd)).toBe(false);
  });
  it('anchors nested non-Git projects at the nearest marker or existing store', () => {
    const f = fixture({ git: false }); const nested = path.join(f.project, 'src', 'deep'); fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(f.project, 'package.json'), '{}');
    expect(resolveProjectStore({ projectDir: nested }).projectRoot).toBe(f.project);
    fs.mkdirSync(path.join(f.project, 'src', '.swarm')); fs.writeFileSync(path.join(f.project, 'src', '.swarm', 'memory.db'), 'fixture');
    expect(resolveProjectStore({ projectDir: nested }).projectRoot).toBe(path.join(f.project, 'src'));
  });
  it('fails closed for corrupt Git identity instead of treating it as a non-Git project', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.project, '.git', 'HEAD'), 'INVALID\n');
    expect(() => resolveProjectStore({ projectDir: f.project })).toThrow(/Git project identity unavailable/);
  });
});

it('retains a derived first tool observation and declared outcome without unrelated tool inputs', () => {
  const f = fixture(); policy(f, { projects: { [f.project]: 'on' } });
  ensureProjectMemory({ projectDir: f.project, env: f.env, event: 'PostToolUse', host: 'claude', payload: {
    session_id: 'first-tool', tool_name: 'Bash', tool_input: { command: 'npm test', arbitrary: 'DO NOT RETAIN' },
    tool_response: { exit_code: 1, stderr: 'test failed', arbitrary: 'DO NOT RETAIN' } }, launch: () => false });
  const queue = path.join(f.project, '.swarm', '.memory-enrollment-pending');
  const queued = JSON.parse(fs.readFileSync(path.join(queue, fs.readdirSync(queue)[0]), 'utf8'));
  expect(queued.payload).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'npm test' },
    tool_response: { exitCode: 1, outcome: 'failure', stderr: 'test failed' } });
  expect(JSON.stringify(queued)).not.toContain('DO NOT RETAIN');
});
it('runs the enrollment snapshot before the prompt recall surface on both hosts', () => {
  for (const file of ['hooks.json', 'codex-hooks.json']) {
    const manifest = JSON.parse(fs.readFileSync(new URL(`../../plugin/hooks/${file}`, import.meta.url), 'utf8'));
    const commands = manifest.hooks.UserPromptSubmit.flatMap((registration) => registration.hooks.map((hook) => hook.command));
    expect(commands.findIndex((command) => command.includes('session-snapshot UserPromptSubmit')))
      .toBeLessThan(commands.findIndex((command) => command.includes('unprompted-speech UserPromptSubmit')));
  }
});
