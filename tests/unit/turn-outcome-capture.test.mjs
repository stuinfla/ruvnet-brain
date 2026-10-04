// Turn-outcome capture through the shared capture boundary (runSessionSnapshotHook).
// Every writer is a fake: `launch` records the steps the detached worker would run, so nothing here
// touches a real AgentDB store or the user's home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runSessionSnapshotHook } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { captureTurnOutcome, runSteps, resolveTurnDb, turnCapturePolicyFile, turnRecordingStatus, buildTurnRecord } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { CONTINUITY_EVENTS } from '../../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const roots = [];
const TRUSTED_ENV = { RUFLO_BIN: process.execPath };
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const OUTCOME = 'Concluded: the continuation gate continues most turns, so the final Stop carries '
  + 'stop_hook_active=true and must still be recorded; duplicates are removed by a per-session '
  + 'fingerprint of the outcome text and the files changed, never by skipping the flag.';
const USER_PROMPT = 'SECRET-USER-PROMPT please refactor the billing module for acme corp';

function harness({ withSwarm = true } = {}) {
  const home = tmp('turn-home-');
  const project = tmp('turn-project-');
  if (withSwarm) {
    fs.mkdirSync(path.join(project, '.swarm'));
    fs.writeFileSync(path.join(project, '.swarm', 'memory.db'), '');
  }
  const launches = [];
  const captureTurn = (opts) => captureTurnOutcome({
    ...opts, env: TRUSTED_ENV, home, ruflo: '/fake/bin/ruflo',
    launch: (steps) => { launches.push(steps); return { launched: true }; },
  });
  const fire = (event, payload, host = 'claude') => runSessionSnapshotHook(project, event, {
    rawInput: JSON.stringify({ hook_event_name: event, cwd: project, ...payload }), host, captureTurn,
  });
  return { home, project, launches, fire };
}

function transcript(dir, records) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

const stores = (launches) => launches.flat().filter((s) => s.kind === 'store');
const valueOf = (step) => step.args[step.args.indexOf('--value') + 1];
const flag = (step, name) => step.args[step.args.indexOf(name) + 1];

// Execute the real queued worker module in a separate process. Only its Ruflo launch/readback
// collaborator is replaced: a marker proves whether that boundary was reached, with no native DB writes.
function queuedWorker(steps, receipts, marker, workerModule = path.join(ROOT, 'plugin/scripts/turn-outcome-capture.mjs')) {
  const source = `import fs from 'node:fs';
    import { runSteps } from ${JSON.stringify(pathToFileURL(workerModule).href)};
    const request = JSON.parse(fs.readFileSync(0, 'utf8'));
    const rows = runSteps(request, {
      projectDir: request.steps[0]?.projectDir, brainHome: request.steps[0]?.brainHome,
      run: (bin, args) => { fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(args)+'\\n'); return {status:0}; },
      read: ({options}) => { if(!fs.existsSync(${JSON.stringify(marker)}))return null; const args=JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8').trim().split('\\n').at(-1)); return args[args.indexOf('--value')+1]; }
    });
    process.stdout.write(JSON.stringify(rows));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    input: JSON.stringify({ steps, receipts }), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, RUVNET_TURN_CAPTURE: 'force', ...TRUSTED_ENV },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('turn-outcome capture at the shared snapshot boundary', () => {
  it('(1) records a stop_hook_active=true Stop exactly once; an identical repeat records nothing', () => {
    const h = harness();
    const payload = { session_id: 's-1', stop_hook_active: true, last_assistant_message: OUTCOME };
    const first = h.fire('Stop', payload);
    const second = h.fire('Stop', payload);
    expect(first.turn.queued).toBe(true);
    expect(first.turn.recorded).toBe(false);
    expect(second.turn.recorded).toBe(false);
    expect(second.turn.skipped).toBe('same turn outcome already queued or verified');
    expect(stores(h.launches)).toHaveLength(1);
    expect(flag(stores(h.launches)[0], '-n')).toBe('turns');
  });

  it('(2) last_assistant_message wins over the transcript text', () => {
    const h = harness();
    const stale = 'STALE transcript text from the previous assistant message, which the host had not '
      + 'yet replaced with the closing message when Stop fired. '.repeat(3);
    const file = transcript(h.home, [
      { type: 'user', message: { role: 'user', content: USER_PROMPT } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: stale }] } },
    ]);
    h.fire('Stop', { session_id: 's-2', transcript_path: file, last_assistant_message: OUTCOME });
    const value = valueOf(stores(h.launches)[0]);
    expect(value).toContain('Concluded: the continuation gate');
    expect(value).not.toContain('STALE transcript text');
  });

  it('(3) a project with no store writes nothing; an existing store keeps its turns', () => {
    const h = harness({ withSwarm: false });
    expect(h.fire('Stop', { session_id: 's-3', last_assistant_message: OUTCOME }).turn.skipped).toContain('opt-in required');
    expect(stores(h.launches)).toHaveLength(0);
    expect(fs.existsSync(path.join(h.project, '.swarm'))).toBe(false);
    const p = harness();
    p.fire('Stop', { session_id: 's-3b', last_assistant_message: OUTCOME });
    expect(flag(stores(p.launches)[0], '--path')).toBe(path.join(p.project, '.swarm', 'memory.db'));
  });

  it('(4) a Codex-shaped Stop payload records correctly', () => {
    const h = harness();
    // codex-cli 0.158.0 stop.command.input: cwd, hook_event_name, last_assistant_message (nullable),
    // model, permission_mode, session_id, stop_hook_active, transcript_path (nullable), turn_id.
    const codex = { session_id: '01a0eb25-6d1c-79a0-8a1a-579ad830c784', turn_id: 'turn-7', model: 'gpt-5.5',
      permission_mode: 'default', stop_hook_active: false, transcript_path: null, last_assistant_message: OUTCOME };
    const result = h.fire('Stop', codex, 'codex');
    expect(result.turn.queued).toBe(true);
    expect(result.turn.recorded).toBe(false);
    const step = stores(h.launches)[0];
    expect(valueOf(step)).toContain('host=codex');
    expect(valueOf(step)).toContain('Concluded: the continuation gate');
    expect(flag(step, '--tags')).toContain('host=codex');
    const empty = h.fire('Stop', { ...codex, session_id: 'codex-2', last_assistant_message: null }, 'codex');
    expect(empty.turn.skipped).toBe('codex payload carried no last_assistant_message');
  });

  it('(5) the record never contains user prompt text, and keeps files + Bash descriptions', () => {
    const h = harness();
    const file = transcript(h.home, [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: USER_PROMPT }] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/billing.mjs', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the unit tests' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: OUTCOME }] } },
    ]);
    h.fire('Stop', { session_id: 's-5', transcript_path: file, last_assistant_message: OUTCOME });
    const value = valueOf(stores(h.launches)[0]);
    expect(value).not.toContain('SECRET-USER-PROMPT');
    expect(value).not.toContain('acme corp');
    expect(value).toContain('FILES CHANGED: /repo/src/billing.mjs');
    expect(value).toContain('ACTIONS: Run the unit tests');
  });

  it('(6) SessionEnd queues distill against the same db with --db, and records no turn', () => {
    const h = harness({ withSwarm: true });
    const result = h.fire('SessionEnd', { session_id: 's-6', reason: 'exit' });
    const db = path.join(h.project, '.swarm', 'memory.db');
    const distill = h.launches.flat().filter((s) => s.kind === 'distill');
    expect(distill).toHaveLength(1);
    expect(distill[0].args.slice(0, 3)).toEqual(['memory', 'distill', 'run']);
    expect(flag(distill[0], '--db')).toBe(db);
    expect(flag(distill[0], '--namespace')).toBe('turns');
    expect(result.turn.distill).toEqual({ queued: true, db });
    expect(stores(h.launches)).toHaveLength(0);
  });

  it('skips trivial turns and honours the RUVNET_TURN_CAPTURE=off switch', () => {
    const h = harness();
    expect(h.fire('Stop', { session_id: 's-t', last_assistant_message: 'Done.' }).turn.skipped).toBe('trivial turn');
    const off = captureTurnOutcome({ projectDir: h.project, event: 'Stop', payload: { session_id: 'x', last_assistant_message: OUTCOME },
      env: { RUVNET_TURN_CAPTURE: 'off' }, home: h.home, ruflo: '/fake/ruflo', launch: () => { throw new Error('must not launch'); } });
    expect(off.skipped).toBe('RUVNET_TURN_CAPTURE=off');
  });

  it('the worker runs store before distill, bounded, with the daemon autostart disabled', () => {
    const h = harness();
    const db = path.join(h.project, '.swarm', 'memory.db');
    const binding = { projectRoot: h.project, projectDir: h.project, brainHome: path.join(h.home, '.cache', 'ruvnet-brain') };
    const calls = [];
    const receipts = path.join(tmp('turn-receipts-'), 'r.jsonl');
    runSteps({ receipts, steps: [
      { ...binding, kind: 'store', ruflo: '/fake/ruflo', args: ['memory', 'store', '-k', 'k1', '--value', 'v', '-n', 'turns', '--path', db] },
      { ...binding, kind: 'distill', ruflo: '/fake/ruflo', args: ['memory', 'distill', 'run', '--db', db] },
    ] }, { env: TRUSTED_ENV, projectDir: h.project, brainHome: path.join(h.home, '.cache', 'ruvnet-brain'), run: (bin, args, opts) => { calls.push({ bin, args, opts }); return { status: 0 }; }, read: () => 'v' });
    expect(calls.map((c) => c.args[1])).toEqual(['store', 'distill']);
    expect(calls.every((c) => c.bin === process.execPath)).toBe(true);
    expect(calls.every((c) => c.opts.env.RUFLO_DAEMON_AUTOSTART === '0' && c.opts.timeout > 0)).toBe(true);
    // ruflo writes hnsw.index / ruvector.db relative to its cwd even with --path: contain them.
    expect(calls.every((c) => c.opts.cwd === path.dirname(db) && c.opts.env.CLAUDE_FLOW_MEMORY_PATH === path.dirname(db))).toBe(true);
    const rows = fs.readFileSync(receipts, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.kind, r.db, r.status])).toEqual([['store', db, 0], ['distill', db, 0]]);
  });
});

describe('turn privacy and receipt evidence', () => {
  it.each(['projectRoot', 'projectDir', 'brainHome'])('rejects a queued step missing its %s binding', (field) => {
    const h = harness();
    h.fire('Stop', { session_id: 'missing-binding', last_assistant_message: OUTCOME });
    const [step] = h.launches.flat();
    delete step[field];
    const marker = path.join(h.home, 'launches.jsonl');
    const receipts = path.join(h.home, '.cache', 'ruvnet-brain', 'turn-capture', 'receipts.jsonl');
    expect(queuedWorker([step], receipts, marker)[0]).toMatchObject({ status: 1, verified: false, error: 'queued step has no canonical project binding' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('revalidates a queued store and distill after directory replacement, records refusal, and permits retry', () => {
    const h = harness();
    const payload = { session_id: 'queue-swap', last_assistant_message: OUTCOME };
    h.fire('Stop', payload);
    h.fire('SessionEnd', { session_id: 'queue-distill' });
    const steps = h.launches.flat();
    expect(steps.every((step) => step.projectRoot === h.project && step.projectDir === h.project)).toBe(true);
    const receipts = path.join(h.home, '.cache', 'ruvnet-brain', 'turn-capture', 'receipts.jsonl');
    const marker = path.join(h.home, 'launches.jsonl');
    const store = path.join(h.project, '.swarm');
    const saved = path.join(h.project, '.swarm-saved');
    const foreign = tmp('foreign-queued-store-');
    fs.writeFileSync(path.join(foreign, 'memory.db'), 'foreign bytes');
    fs.renameSync(store, saved);
    fs.symlinkSync(foreign, store, 'dir');
    expect(queuedWorker(steps, receipts, marker).map((row) => row.status)).toEqual([1, 1]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(foreign, 'memory.db'), 'utf8')).toBe('foreign bytes');
    expect(fs.readdirSync(foreign)).toEqual(['memory.db']);
    // Source-bound negative control: removing the final guard reaches the forbidden launch boundary.
    const workerFile = path.join(ROOT, 'plugin/scripts/turn-outcome-capture.mjs');
    const source = fs.readFileSync(workerFile, 'utf8');
    const guard = 'const target = resolveTurnDb({ projectDir, brainHome, gitTimeoutMs: 1000 });';
    expect(source).toContain(guard);
    const mutantFile = path.join(tmp('queued-worker-mutant-'), 'capture.mjs');
    const originGuard = 'const origin = resolveTurnDb({ projectDir: binding.projectDir, brainHome, requestedStorePath: db, gitTimeoutMs: 1000 });';
    expect(source).toContain(originGuard);
    const mutant = source.replace(guard, 'const target = { db: queued.args[queued.args.indexOf(queued.kind === "store" ? "--path" : "--db") + 1], projectRoot: queued.projectRoot };')
      .replace(originGuard, 'const origin = { db, projectRoot: target.projectRoot };').replace(/from '(\.\/[^']+)'/g,
      (_, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(workerFile), relative)).href)}`);
    fs.writeFileSync(mutantFile, mutant);
    const mutantMarker = path.join(h.home, 'mutant-launches.jsonl');
    expect(queuedWorker(steps, null, mutantMarker, mutantFile).map((row) => row.status)).toEqual([0, 0]);
    expect(fs.existsSync(mutantMarker)).toBe(true);
    fs.rmSync(store);
    fs.renameSync(saved, store);
    const retry = h.fire('Stop', payload).turn;
    expect(retry.queued).toBe(true);
    expect(retry.key).toBe(flag(steps[0], '-k'));
    expect(queuedWorker(h.launches.at(-1), receipts, marker)[0]).toMatchObject({ status: 0, verified: true });
  });

  it.each(['off', 'path-off', 'malformed'])('honours %s persisted consent written after enqueue, including distillation', (mode) => {
    const h = harness();
    h.fire('Stop', { session_id: `queue-consent-${mode}`, last_assistant_message: OUTCOME });
    h.fire('SessionEnd', { session_id: 'queue-consent-distill' });
    const brainHome = path.join(h.home, '.cache', 'ruvnet-brain');
    const file = turnCapturePolicyFile(brainHome);
    fs.writeFileSync(file, mode === 'malformed' ? '{bad' : JSON.stringify({ schemaVersion: 1,
      projects: { [h.project]: mode === 'off' ? 'off' : 'on' }, paths: mode === 'path-off' ? { [h.project]: 'off' } : {} }));
    const marker = path.join(h.home, 'launches.jsonl');
    const rows = queuedWorker(h.launches.flat(), path.join(brainHome, 'turn-capture', 'receipts.jsonl'), marker);
    expect(rows.map((row) => row.status)).toEqual([1, 1]);
    expect(rows[0].error).toMatch(mode === 'malformed' ? /policy unreadable or invalid/ : /persisted.*opt-out/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each(['-wal', '-shm', '-journal'].flatMap((suffix) => ['symlink', 'hardlink'].map((kind) => ({ suffix, kind }))))(
    'refuses queued SQLite sidefile replacement $suffix $kind before a child can run', ({ suffix, kind }) => {
      const h = harness();
      h.fire('Stop', { session_id: 'queue-sidefile', last_assistant_message: OUTCOME });
      const foreign = path.join(tmp('foreign-sidefile-'), 'data');
      fs.writeFileSync(foreign, 'foreign bytes');
      const side = path.join(h.project, '.swarm', `memory.db${suffix}`);
      fs.rmSync(side, { force: true });
      if (kind === 'symlink') fs.symlinkSync(foreign, side); else fs.linkSync(foreign, side);
      const marker = path.join(h.home, 'launches.jsonl');
      const receipts = path.join(h.home, '.cache', 'ruvnet-brain', 'turn-capture', 'receipts.jsonl');
      expect(queuedWorker(h.launches.flat(), receipts, marker)[0]).toMatchObject({ status: 1, verified: false });
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign bytes');
    });

  it('redacts outcome, actions, paths and session before truncation and persistence', () => {
    const token = `ghp_${'SYNTHETIC'.repeat(5)}`;
    const h = harness();
    const file = transcript(h.home, [{ message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Write', input: { file_path: `/repo/${token}.mjs` } },
      { type: 'tool_use', name: 'Bash', input: { description: `Authorization: Bearer ${token}` } },
    ] } }]);
    const result = h.fire('Stop', { session_id: token, transcript_path: file, last_assistant_message: `${OUTCOME} ${token}` });
    const value = valueOf(stores(h.launches)[0]);
    expect(value).not.toContain(token);
    expect(value).toContain('[REDACTED:token]');
    const dir = path.join(h.home, '.cache', 'ruvnet-brain', 'turn-capture');
    expect(fs.readFileSync(path.join(dir, 'last-turn.json'), 'utf8')).not.toContain(token);
    const row = JSON.parse(fs.readFileSync(path.join(h.project, '.swarm', 'agentdb-turns.jsonl'), 'utf8'));
    expect(Object.keys(row).sort()).toEqual(['hash', 'key', 'len', 'ts']);
    expect(row.len).toBe(result.turn.value.length);
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(5000)}\n-----END PRIVATE KEY-----`;
    expect(buildTurnRecord({ turn: { finalText: privateKey, files: [], actions: [] }, project: 'p', host: 'codex', session: 's' })).not.toContain('AAAA');
  });

  it('rereads path/project opt-out, rejects invalid policy, and ignores global override', () => {
    const h = harness();
    const brainHome = path.join(h.home, '.cache', 'ruvnet-brain');
    const file = turnCapturePolicyFile(brainHome);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const capture = () => captureTurnOutcome({ projectDir: h.project, event: 'Stop', home: h.home,
      env: { RUVNET_TURN_GLOBAL_DB: '/foreign/global.db', RUVNET_TURN_CAPTURE: 'force' }, ruflo: '/fake/ruflo',
      payload: { session_id: 'policy', last_assistant_message: OUTCOME }, launch: () => { throw new Error('must not launch'); } });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: { [h.project]: 'off' } }));
    expect(capture().skipped).toBe('persisted turn capture opt-out');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: { [h.project]: 'on' }, paths: { [h.project]: 'off' } }));
    expect(capture().skipped).toBe('persisted turn capture opt-out');
    fs.writeFileSync(file, '{broken');
    expect(capture().skipped).toContain('policy unreadable');
    fs.rmSync(file);
    expect(resolveTurnDb({ projectDir: h.project, brainHome }).db).toBe(path.join(h.project, '.swarm', 'memory.db'));
  });

  it.each([
    { schemaVersion: 1, projects: [], paths: {} },
    { schemaVersion: 1, projects: {}, paths: 'off' },
    { schemaVersion: 1, projects: null },
    { schemaVersion: 1, projects: {}, paths: [] },
    { schemaVersion: 1, projects: {}, paths: null },
    { schemaVersion: 1, projects: { '/other/project': 'invalid' } },
    { schemaVersion: 1, projects: {}, paths: { '/other/path': false } },
  ])('fails closed for malformed consent maps/settings even with an existing store: %j', (policy) => {
    const h = harness();
    const file = turnCapturePolicyFile(path.join(h.home, '.cache', 'ruvnet-brain'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(policy));
    const result = captureTurnOutcome({ projectDir: h.project, event: 'Stop', home: h.home,
      env: { RUVNET_TURN_CAPTURE: 'force' }, ruflo: '/fake/ruflo',
      payload: { session_id: 'malformed-consent', last_assistant_message: OUTCOME },
      launch: () => { throw new Error('malformed consent must not launch'); } });
    expect(result.skipped).toBe('turn capture policy unreadable or invalid');
    expect(result.queued).toBe(false);
    expect(result.launch).toBeUndefined();
    expect(turnRecordingStatus({ projectDir: h.project, home: h.home, env: TRUSTED_ENV }).line).toContain('policy unreadable or invalid');
    expect(fs.existsSync(path.join(h.project, '.swarm', 'agentdb-turns.jsonl'))).toBe(false);
  });

  it('never treats exit zero, stale content, or stderr discarded as write proof', () => {
    const receipts = path.join(tmp('turn-status-'), 'r.jsonl');
    const h = harness();
    const step = { projectRoot: h.project, projectDir: h.project, brainHome: path.join(h.home, '.cache', 'ruvnet-brain'),
      kind: 'store', ruflo: '/fake/ruflo', args: ['memory', 'store', '-k', 'new-key', '--value', 'substantive new value', '-n', 'turns', '--path', path.join(h.project, '.swarm', 'memory.db')] };
    const stale = runSteps({ receipts, steps: [step] }, { env: TRUSTED_ENV, projectDir: h.project, brainHome: path.join(h.home, '.cache', 'ruvnet-brain'), run: () => ({ status: 0 }), read: () => 'stale value' });
    expect(stale[0]).toMatchObject({ status: 1, verified: false, error: 'exact turn key/content readback failed' });
    const token = `ghp_${'SYNTHETIC'.repeat(5)}`;
    const fail = runSteps({ receipts, steps: [step] }, { env: TRUSTED_ENV, projectDir: h.project, brainHome: path.join(h.home, '.cache', 'ruvnet-brain'), run: () => ({ status: 1, stderr: `refused ${token}\nsecond line` }) });
    expect(fail[0].error).toBe('refused [REDACTED:token]');
    expect(fs.readFileSync(receipts, 'utf8')).not.toContain(token);
  });

  it('retries an identical turn after a failed receipt and after a launch failure', () => {
    const h = harness();
    const payload = { session_id: 'retry', last_assistant_message: OUTCOME };
    const first = h.fire('Stop', payload).turn;
    const file = path.join(h.home, '.cache', 'ruvnet-brain', 'turn-capture', 'receipts.jsonl');
    fs.writeFileSync(file, JSON.stringify({ kind: 'store', key: first.key, status: 1, error: 'refused', verified: false }));
    const retried = h.fire('Stop', payload).turn;
    expect(retried.queued).toBe(true);
    expect(retried.key).toBe(first.key);
    const opts = { projectDir: h.project, home: h.home, env: TRUSTED_ENV, ruflo: '/fake/ruflo', event: 'Stop', host: 'codex',
      payload: { session_id: 'launch-fail', last_assistant_message: OUTCOME } };
    expect(captureTurnOutcome({ ...opts, launch: () => { throw new Error('spawn refused'); } }).queued).toBe(false);
    expect(captureTurnOutcome({ ...opts, launch: () => ({ launched: true }) }).queued).toBe(true);
  });

  it('redacts secret-shaped project names in keys, tags, breadcrumbs and receipt paths', () => {
    const root = tmp('turn-named-'); const token = `ghp_${'SYNTHETIC'.repeat(5)}`;
    const project = path.join(root, token); fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
    const db = path.join(project, '.swarm', 'memory.db'); fs.writeFileSync(db, '');
    const brainHome = path.join(root, 'brain'); let step;
    const report = captureTurnOutcome({ projectDir: project, event: 'Stop', host: 'codex', ruflo: '/fake/ruflo', env: TRUSTED_ENV, brainHome,
      payload: { session_id: 'named', last_assistant_message: OUTCOME }, launch: (steps) => { [step] = steps; return { launched: true }; } });
    expect(report.key).not.toContain(token);
    expect(flag(step, '--tags')).not.toContain(token);
    expect(valueOf(step)).not.toContain(token);
    expect(fs.readFileSync(path.join(project, '.swarm', 'agentdb-turns.jsonl'), 'utf8')).not.toContain(token);
    const receipts = path.join(brainHome, 'turn-capture', 'receipts.jsonl');
    runSteps({ steps: [step], receipts }, { env: TRUSTED_ENV, projectDir: project, brainHome, run: () => ({ status: 1, stderr: 'refused' }) });
    expect(fs.readFileSync(receipts, 'utf8')).not.toContain(token);
    expect(turnRecordingStatus({ projectDir: project, env: { RUVNET_BRAIN_HOME: brainHome } }).line).toContain('failing 1/1');
  });

  it('reports only this canonical database and marks old successes unverified historical', () => {
    const h = harness(); const db = path.join(h.project, '.swarm', 'memory.db');
    const file = path.join(h.home, '.cache', 'ruvnet-brain', 'turn-capture', 'receipts.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [ { kind: 'store', db: '/foreign/db', status: 1, at: new Date().toISOString(), error: 'foreign' },
      { kind: 'store', db, status: 0, at: new Date().toISOString() } ];
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
    expect(turnRecordingStatus({ projectDir: h.project, home: h.home, env: TRUSTED_ENV }).line).toMatch(/unverified historical/);
  });
});

describe('both hosts reach the capture boundary at Stop', () => {
  it('Codex registers session-snapshot at Stop in the policy and in codex-hooks.json', () => {
    expect(CONTINUITY_EVENTS.Stop.find((r) => r.id === 'session-snapshot')?.hosts).toEqual(['claude', 'codex']);
    const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/codex-hooks.json'), 'utf8'));
    const stop = codex.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)).join('\n');
    expect(stop).toMatch(/session-snapshot Stop/);
  });
});
