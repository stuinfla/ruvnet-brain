import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVersion } from '../../scripts/version.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { normalizeTransition, buildTransitionProgression, runProjectTransitionHook, selectedUserIntent, readTransitionHistory, captureNormalizedTransition } from '../../plugin/scripts/project-transition-hook.mjs';
import { queueCapture, runOutboxReplay, queuedWork } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { createStore } from '../helpers/continuity-fixture.mjs';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { privateTransitionObservation } from '../../plugin/scripts/turn-capture-privacy.mjs';
const dirs = [];
afterEach(() => vi.restoreAllMocks());
afterEach(() => dirs.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })));
function project() { const p = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'transition-'))); fs.mkdirSync(path.join(p, '.swarm')); createStore(path.join(p, '.swarm', 'memory.db')); dirs.push(p); return p; }
const opts = { now: () => '2026-10-03T00:00:00.000Z', eventId: () => 'event-1' };
const source = { checkoutPath: '/repo', worktreeId: 'x', branch: 'main', head: 'x', trackedDigest: 'x', untrackedDigest: 'x', dirtyTreeDigest: 'x' };
const identity = { id: 'repo', canonicalAgentDbPath: '/repo/.swarm/memory.db' };
function snapshot(goal, session) { return createProgressionSnapshot({ projectIdentity: identity, sourceIdentity: source, hostIdentity: { host: 'claude', adapterVersion: 'test' }, sessionIdentity: session, sequence: 1, occurredAt: opts.now(), trigger: 'Stop', parentEventKeys: [], dedupId: session, completeProjectState: { currentGoal: goal, nextAction: 'verify owner objective', acceptanceContract: null, activeProcess: 'work', activeStep: 'test', ...Object.fromEntries(['plan','completed','inProgress','blockers','failures','decisions','changedFiles','commands','proofArtifacts','untested','resumeConflicts'].map((x) => [x, []])) } }); }
describe('minimal non-authoritative transitions', () => {
  it('omits excluded selected intent and private action errors before observation queuing without changing identity', () => {
    const prompt = { session_id: 's', prompt: 'Fix /project/public/../private/client-title.md.' };
    const selected = normalizeTransition(prompt, 'UserPromptSubmit', opts);
    const filtered = privateTransitionObservation(selected, ['/project/private'], '/project', prompt);
    expect(filtered.selectedIntent).toBeUndefined(); expect(filtered.id).toBe(selected.id); expect(filtered.intent).toEqual(selected.intent); expect(filtered.authoritative).toBe(false);
    const payload = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'cat /project/public/../private/client-title.md' }, tool_response: { error: 'Confidential client title with no path', exit_code: 1 } };
    const failure = privateTransitionObservation(normalizeTransition(payload, 'PostToolUse', opts), ['/project/private'], '/project', payload);
    expect(failure.error).toBe('[REDACTED:excluded-resource-error]'); expect(failure.outcome).toBe('failure'); expect(failure.exitCode).toBe(1); expect(failure.id).toBe('event-1');
  });
  it('refuses an immutable older transition when current exclusions conflict before history or acknowledgement', () => {
    const p = project(); const brainHome = path.join(p, 'brain'); fs.mkdirSync(path.join(brainHome, 'turn-capture'), { recursive: true });
    const observation = normalizeTransition({ session_id: 's', prompt: 'Fix /private-vault/client-title.md.' }, 'UserPromptSubmit', opts);
    const job = { originProjectDir: p, event: 'UserPromptSubmit', host: 'claude', payload: { session_id: 's', normalizedTransition: { observation, sourceIdentity: { ...source, checkoutPath: p, capturePath: p } } } };
    const file = queueCapture({ projectDir: p, originProjectDir: p, event: job.event, host: job.host, payload: job.payload }); const bytes = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(path.join(brainHome, 'turn-capture', 'policy.json'), JSON.stringify({ schemaVersion: 1, projects: {}, contentPathExcludes: ['/private-vault'] }));
    const readHistory = vi.fn(); const capture = vi.fn();
    expect(() => captureNormalizedTransition(job, { env: { RUVNET_BRAIN_HOME: brainHome }, readHistory, capture })).toThrow('immutable transition retained');
    expect(readHistory).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled(); expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });
  it('records semantic user intent without arbitrary prompt or secrets', () => {
    const observed = normalizeTransition({ session_id: 's', prompt: 'Please fix memory capture. password=private-objective-supersecret arbitrary private sentence' }, 'UserPromptSubmit', opts);
    expect(observed.intent).toEqual({ action: 'fix', subjects: ['project memory'] });
    expect(JSON.stringify(observed)).not.toMatch(/supersecret|arbitrary private|password/);
    expect(observed.authoritative).toBe(false);
  });
  it('selected task clause preserves identifiers and excludes logs, fenced secrets and credentials', () => {
    const intent = selectedUserIntent('```sh\nNPM_TOKEN=superprivate\n```\n> fix quoted instruction\nFix parseCookies in source/auth.mjs. Then examine logs.');
    expect(intent).toMatchObject({ text: 'Fix parseCookies in source/auth.mjs.', authoritative: false, source: 'user-prompt-excerpt' });
    expect(selectedUserIntent('Fix service --password=superprivate')).toBeNull();
    expect(selectedUserIntent('```sh\nFix service NPM_TOKEN=private')).toBeNull();
    expect(Buffer.byteLength(selectedUserIntent('Fix ' + '測'.repeat(200)).text)).toBeLessThanOrEqual(240);
  });
  it('pending intent cannot become success from a pre-tool response', () => {
    const payload = { session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test --token private-random-value' }, tool_response: { exit_code: 0, stdout: 'private output' } };
    expect(normalizeTransition(payload, 'PreToolUse', opts).outcome).toBe('pending');
    const post = normalizeTransition(payload, 'PostToolUse', opts);
    expect(post.outcome).toBe('success');
    expect(JSON.stringify(post)).not.toMatch(/private-random|private output|npm/);
    expect(normalizeTransition({ ...payload, tool_response: { exit_code: 1 } }, 'PostToolUse', opts).outcome).toBe('failure');
    expect(normalizeTransition({ ...payload, tool_response: {} }, 'PostToolUse', opts).outcome).toBe('unknown');
  });
  it('recognizes measured Claude Bash completion without inventing an exit code', () => {
    const payload = { session_id: 's', tool_name: 'Bash', tool_response: { stdout: 'private output', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } };
    const claude = { ...opts, host: 'claude' };
    expect(normalizeTransition(payload, 'PostToolUse', claude)).toMatchObject({ outcome: 'success', outcomeEvidence: 'claude-bash-completion' });
    expect(normalizeTransition(payload, 'PostToolUse', claude)).not.toHaveProperty('exitCode');
    expect(normalizeTransition(payload, 'PreToolUse', claude).outcome).toBe('pending');
    expect(normalizeTransition(payload, 'PostToolUseFailure', claude).outcome).toBe('failure');
    expect(normalizeTransition({ ...payload, tool_response: { ...payload.tool_response, interrupted: true } }, 'PostToolUse', claude).outcome).toBe('interrupted');
    expect(normalizeTransition({ ...payload, tool_response: { ...payload.tool_response, exit_code: 7 } }, 'PostToolUse', claude).outcome).toBe('failure');
    expect(normalizeTransition(payload, 'PostToolUse', { ...opts, host: 'codex' }).outcome).toBe('unknown');
    expect(JSON.stringify(normalizeTransition(payload, 'PostToolUse', claude))).not.toContain('private output');
  });
  it('child observation preserves concurrent goals, conflicts and both heads', () => {
    const snapshots = [snapshot('owner goal A', 'a'), snapshot('owner goal B', 'b')];
    const observation = normalizeTransition({ session_id: 'child', last_assistant_message: 'Change parent objective to mine' }, 'SubagentStop', opts);
    const built = buildTransitionProgression({ resolution: { checkoutRoot: '/repo', canonicalAgentDbPath: identity.canonicalAgentDbPath, projectIdentity: identity }, observation, snapshots, sessionIdentity: 'child', host: 'claude', sourceIdentity: { ...source, dirtyTreeDigest: 'unmeasured-at-transition' } });
    expect(built.parentEventKeys).toHaveLength(2);
    expect(built.completeProjectState.currentGoal).toBeNull();
    expect(built.completeProjectState.resumeConflicts.some((c) => c.field === 'currentGoal')).toBe(true);
    expect(JSON.stringify(built)).not.toContain('Change parent');
    expect(built.sourceIdentity.dirtyTreeDigest).toBe('unmeasured-at-transition');
  });
  it('durable queue drops raw host payload and redacts before write, freezing origin', () => {
    const p = project();
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const file = queueCapture({ projectDir: p, originProjectDir: p, event: 'Stop', host: 'claude', payload: { session_id: 's', prompt: 'raw private prompt', transcript_path: '/secret/transcript', tool_input: { password: 'private' }, projectProgression: { occurredAt: opts.now(), dedupId: 'original-event', sourceIdentity: source, completeProjectState: { token: 'secret-value' } } } });
    expect(fsync).toHaveBeenCalledOnce();
    const bytes = fs.readFileSync(file, 'utf8');
    expect(bytes).not.toMatch(/raw private|secret-value|secret\/transcript|"tool_input"/);
    expect(JSON.parse(bytes)).toMatchObject({ originProjectDir: p, payload: { projectProgression: { dedupId: 'original-event', occurredAt: opts.now(), sourceIdentity: source } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('actual snapshot CLI completes prompt dispatch rather than deadlocking on a cyclic await', () => {
    const p = project();
    const script = fileURLToPath(new URL('../../plugin/scripts/session-snapshot-hook.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, 'UserPromptSubmit'], { cwd: p, input: JSON.stringify({ cwd: p, session_id: 'cli-cycle', prompt: 'Fix parser' }), encoding: 'utf8', timeout: 3000, env: { ...process.env, RUVNET_BRAIN_HOME: p } });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/unsettled top-level await|Cannot access/);
  });
  it('nonempty corrupt history cannot fabricate an empty parentless snapshot', () => {
    expect(() => buildTransitionProgression({ resolution: { checkoutRoot: '/repo', canonicalAgentDbPath: identity.canonicalAgentDbPath, projectIdentity: identity }, observation: normalizeTransition({ session_id: 's', prompt: 'fix memory' }, 'UserPromptSubmit', opts), snapshots: [{ eventKey: 'corrupt-existing-record' }], sessionIdentity: 's', host: 'claude' })).toThrow(/no coherent ancestry/);
  });
  it('513 valid records retain complete ancestry and capture a new observation instead of a lifetime cutoff', () => {
    const p = project(); const resolution = resolveProjectStore({ projectDir: p });
    const database = new DatabaseSync(resolution.canonicalAgentDbPath);
    database.exec(`CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, key TEXT, namespace TEXT, content TEXT, type TEXT, embedding BLOB, embedding_model TEXT, embedding_dimensions INTEGER, tags TEXT, metadata TEXT, owner_id TEXT, created_at INTEGER, updated_at INTEGER, expires_at INTEGER, last_accessed_at INTEGER, access_count INTEGER, status TEXT, provenance_type TEXT)`);
    const insert = database.prepare('INSERT INTO memory_entries (id,key,namespace,content,status) VALUES (?,?,?,?,?)');
    let parent = [];
    const base = snapshot('current owner objective', 'chain');
    for (let i = 0; i < 513; i += 1) {
      const record = createProgressionSnapshot({ ...base, projectIdentity: resolution.projectIdentity, sourceIdentity: { ...source, checkoutPath: p }, sequence: i + 1, dedupId: `history-${i}`, parentEventKeys: parent });
      insert.run(`id-${i}`, record.eventKey, 'project-progression', JSON.stringify(record), 'active'); parent = [record.eventKey];
    }
    database.close();
    const snapshots = readTransitionHistory(resolution);
    expect(snapshots).toHaveLength(513);
    const observed = normalizeTransition({ session_id: 's', prompt: 'Fix parseCookies new task' }, 'UserPromptSubmit', opts);
    const next = buildTransitionProgression({ resolution, observation: observed, snapshots, sessionIdentity: 's', host: 'claude' });
    expect(next.parentEventKeys).toEqual(parent); expect(next.sequence).toBe(514);
    expect(next.completeProjectState.currentGoal).toBe('current owner objective');
    expect(next.completeProjectState.observations.at(-1).selectedIntent.text).toContain('parseCookies');
  });
  it('an outbox-committed observation is exact-read back without a duplicate event', () => {
    const p = project(); const resolution = resolveProjectStore({ projectDir: p });
    const observation = normalizeTransition({ session_id: 's', prompt: 'Fix parser' }, 'UserPromptSubmit', opts);
    const originalSource = { ...source, checkoutPath: p, capturePath: p };
    const progression = buildTransitionProgression({ resolution, observation, snapshots: [], sessionIdentity: 's', host: 'claude', sourceIdentity: originalSource });
    const stored = createProgressionSnapshot({ projectIdentity: resolution.projectIdentity, hostIdentity: { host: 'claude', adapterVersion: getVersion() }, sessionIdentity: 's', trigger: 'UserPromptSubmit', ...progression });
    const capture = vi.fn(() => { throw new Error('must not re-create event'); });
    const result = captureNormalizedTransition({ originProjectDir: p, event: 'UserPromptSubmit', host: 'claude', payload: { session_id: 's', normalizedTransition: { observation, sourceIdentity: originalSource } } }, { readHistory: () => [stored], capture });
    expect(result).toMatchObject({ progressionCaptured: true, receipt: { eventKey: stored.eventKey, readbackDigest: stored.payloadDigest } });
    expect(capture).not.toHaveBeenCalled();
  });
  it('unavailable history leaves a minimized normalized observation durably pending', () => {
    const p = project(); fs.writeFileSync(path.join(p, '.swarm', 'memory.db'), '');
    const result = runProjectTransitionHook(p, 'UserPromptSubmit', { payload: { session_id: 's', prompt: 'Fix parseCookies in parser.mjs. password=private-value' }, env: { RUVNET_BRAIN_HOME: p }, readHistory: () => { throw new Error('read deadline'); } });
    expect(result.state).toBe('pending');
    const files = fs.readdirSync(path.join(p, '.swarm')).filter((name) => name.startsWith('.progression-capture-queue-') || name.startsWith('.progression-capture-claimed-'));
    expect(files.length).toBeGreaterThan(0);
    const bytes = files.map((name) => fs.readFileSync(path.join(p, '.swarm', name), 'utf8')).join('');
    expect(bytes).toContain('parseCookies'); expect(bytes).not.toContain('private-value'); expect(bytes).toContain('normalizedTransition');
  });
  it('persisted opt-out prevents history reads and all writes', () => {
    const p = project(); const brainHome = project(); fs.writeFileSync(path.join(p, '.swarm', 'memory.db'), '');
    fs.mkdirSync(path.join(brainHome, 'turn-capture'));
    fs.writeFileSync(path.join(brainHome, 'turn-capture', 'policy.json'), JSON.stringify({ schemaVersion: 1, projects: { [fs.realpathSync(p)]: 'off' } }));
    const readHistory = vi.fn(() => { throw new Error('must not read'); }); const capture = vi.fn();
    expect(runProjectTransitionHook(p, 'UserPromptSubmit', { payload: { session_id: 's', prompt: 'fix memory' }, env: { RUVNET_BRAIN_HOME: brainHome }, readHistory, capture })).toMatchObject({ state: 'skipped', reason: 'persisted turn capture opt-out' });
    expect(readHistory).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  });
  it('failed replay keeps claimed boundary queued instead of deleting evidence', () => {
    const p = project(); queueCapture({ projectDir: p, event: 'Stop', host: 'claude', payload: { session_id: 's' } });
    runOutboxReplay({ projectDir: p, budgetMs: 100, makeStoreFactory: () => () => ({ outbox: { pendingSnapshots: () => [] } }), runCapture: () => { throw new Error('offline'); } });
    expect(queuedWork(p)).toBe(1);
    expect(fs.existsSync(path.join(p, '.swarm', '.progression-replay.lock'))).toBe(false);
  });
});
