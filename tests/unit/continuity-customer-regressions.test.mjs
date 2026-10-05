import fs from 'node:fs';
import path from 'node:path';
import { constants } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedProject, tmp, cleanup, fakeRuflo } from '../helpers/continuity-fixture.mjs';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';
import { ProjectProgressionStore, projectResumePayloadToBound } from '../../plugin/scripts/project-progression-store.mjs';
import { enrichStateWithObservation } from '../../plugin/scripts/project-progression-hook.mjs';
import { digestCanonical, createProgressionSnapshot, validateProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { recordManagedCliObservation, readLiveSurfaceReceipts } from '../../plugin/scripts/capability-claim-evidence.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { buildTransitionProgression, captureNormalizedTransition, normalizeTransition } from '../../plugin/scripts/project-transition-hook.mjs';
import { callManagedCli } from '../../plugin/mcp/managed-cli-interface.mjs';

afterEach(cleanup);
const stateDefaults = () => ({ ...Object.fromEntries(['plan', 'completed', 'inProgress', 'blockers', 'failures', 'decisions', 'changedFiles', 'commands', 'proofArtifacts', 'untested', 'resumeConflicts'].map((field) => [field, []])), currentGoal: 'goal', nextAction: 'action', activeProcess: null, activeStep: null, acceptanceContract: null });
const snapshot = { eventKey: 'synthetic-a', payloadDigest: 'a'.repeat(64), completeProjectState: { currentGoal: 'goal' } };
const makeOutbox = () => { const p = tmp('outbox-stream-'); fs.mkdirSync(path.join(p, '.swarm')); return new ProgressionOutbox({ projectRoot: p }); };

describe('customer continuity regressions #387 and #389', () => {
  it('decodes split UTF8, blanks, CRLF and complete undelimited tails in source order', () => {
    const outbox = makeOutbox();
    // The first multibyte code point begins at the last byte of a read chunk.
    const first = { label: 'x'.repeat(65525) + '測🙂' };
    fs.writeFileSync(outbox.path, JSON.stringify(first) + '\r\n\n\r\n' + JSON.stringify({ label: 'tail' }));
    expect(outbox.records()).toEqual([first, { label: 'tail' }]);
    outbox.appendRecord({ label: 'appended' });
    expect(outbox.records().map((row) => row.label)).toEqual([first.label, 'tail', 'appended']);
    fs.appendFileSync(outbox.path, '{"torn":');
    expect(outbox.records()).toHaveLength(3);
    const before = fs.readFileSync(outbox.path);
    expect(() => outbox.appendRecord({ label: 'refused' })).toThrow(/torn tail/);
    expect(fs.readFileSync(outbox.path)).toEqual(before);
  });
  it('reports a malformed interior physical line after blank and CRLF lines', () => {
    const outbox = makeOutbox(); fs.writeFileSync(outbox.path, '\n\r\n{"ok":true}\r\n{bad}\n');
    expect(() => outbox.records()).toThrow(/line 4/);
  });
  it('replays a real disposable journal exceeding the Node total-string limit without changing evidence', () => {
    const outbox = makeOutbox();
    const record = Buffer.from(JSON.stringify({ type: 'snapshot', ...snapshot, snapshot: { ...snapshot, padding: 'x'.repeat(65536) } }) + '\n');
    const fd = fs.openSync(outbox.path, 'wx', 0o600);
    const count = Math.ceil((constants.MAX_STRING_LENGTH + 1) / record.length);
    try { for (let i = 0; i < count; i += 1) fs.writeSync(fd, record); } finally { fs.closeSync(fd); }
    // A complete but undelimited final record must use the bounded tail inspector on this history.
    fs.truncateSync(outbox.path, fs.statSync(outbox.path).size - 1);
    const originalSize = fs.statSync(outbox.path).size;
    expect(originalSize).toBeGreaterThan(constants.MAX_STRING_LENGTH);
    expect(() => fs.readFileSync(outbox.path, 'utf8')).toThrow();
    expect(outbox.pendingSnapshots()).toEqual([{ ...snapshot, padding: 'x'.repeat(65536) }]);
    outbox.markCommitted({ eventKey: snapshot.eventKey, payloadDigest: snapshot.payloadDigest, readbackDigest: snapshot.payloadDigest, committedAt: '2026-10-04T00:00:00Z' });
    expect(outbox.pendingSnapshots()).toEqual([]);
    expect(fs.statSync(outbox.path).size).toBeGreaterThan(originalSize);
  }, 120000);
  it('omits large observations and groups repeated conflicts with exact digests without changing source records', () => {
    const input = { heads: ['head-a', 'head-b'], state: { currentGoal: 'exact goal', nextAction: 'exact action',
      observations: Array.from({ length: 100 }, (_, id) => ({ id, text: '測'.repeat(300) })),
      resumeConflicts: Array.from({ length: 109 }, (_, id) => ({ field: id % 2 ? 'sourceIdentity' : 'currentGoal', values: [{ head: 'head-a', value: `value-${id}` }, { head: 'head-b', value: 'opposed' }] })) } };
    const frozen = JSON.stringify(input); const result = projectResumePayloadToBound(input, 7700);
    expect(result).not.toBeNull(); expect(Buffer.byteLength(result.rendered)).toBeLessThanOrEqual(7700);
    expect(result.payload.state.observations).toEqual({ omitted: true, count: 100, sha256: digestCanonical(input.state.observations) });
    expect(result.payload.state.currentGoal).toBe(input.state.currentGoal); expect(result.payload.state.nextAction).toBe(input.state.nextAction);
    expect(result.payload.heads).toEqual(input.heads); expect(result.payload.state.resumeConflicts).toHaveLength(2);
    for (const group of result.payload.state.resumeConflicts) {
      const exact = input.state.resumeConflicts.filter((row) => row.field === group.field);
      expect(group).toEqual({ field: group.field, conflictCount: exact.length, valueCount: exact.length * 2, conflictsDigest: digestCanonical(exact) });
    }
    expect(JSON.stringify(input)).toBe(frozen);
    expect(projectResumePayloadToBound({ ...input, state: { ...input.state, currentGoal: 'g'.repeat(9000) } }, 7700)).toBeNull();
  });
});

describe('canonical bounded restore #389', () => {
  it('restores through the native canonical reader while the full AgentDB row stays exact', () => {
    const { dir } = adoptedProject(); const resolution = resolveProjectStore({ projectDir: dir });
    const state = { ...stateDefaults(), observations: Array.from({ length: 100 }, (_, id) => ({ id, detail: 'retained'.repeat(100) })), resumeConflicts: Array.from({ length: 109 }, (_, id) => ({ field: 'sourceIdentity', values: [{ head: 'a', value: id }, { head: 'b', value: -id }] })) };
    const row = createProgressionSnapshot({ projectIdentity: resolution.projectIdentity, sourceIdentity: { checkoutPath: dir, worktreeId: 'a', branch: 'main', head: 'a', trackedDigest: 'a', untrackedDigest: 'a', dirtyTreeDigest: 'a' }, hostIdentity: { host: 'codex', adapterVersion: 'test' }, sessionIdentity: 's', sequence: 1, occurredAt: '2026-10-04T00:00:00Z', trigger: 'Stop', parentEventKeys: [], dedupId: 'bounded', completeProjectState: state });
    const content = JSON.stringify(row); const db = new DatabaseSync(resolution.canonicalAgentDbPath);
    db.prepare('INSERT INTO memory_entries (id,key,namespace,content,status) VALUES (?,?,?,?,?)').run('id', row.eventKey, 'project-progression', content, 'active');
    const store = new ProjectProgressionStore({ projectDir: dir, rufloBinary: fakeRuflo().bin, runner: () => { throw new Error('native reader must not use CLI fallback'); } });
    const restored = store.restoreLatest({ replayPending: false, projectToBound: true, maxOutputBytes: 7700 });
    expect(restored.projected).toBe(true); expect(restored.payload.evidence).toMatchObject({ exactRetrieved: 1, readPath: 'node:sqlite' });
    expect(restored.payload.heads).toEqual([row.eventKey]); expect(restored.payload.state).toMatchObject({ currentGoal: 'goal', nextAction: 'action', observations: { omitted: true, count: 100, sha256: digestCanonical(state.observations) } });
    expect(restored.payload.state.resumeConflicts).toEqual([{ field: 'sourceIdentity', conflictCount: 109, valueCount: 218, conflictsDigest: digestCanonical(state.resumeConflicts) }]);
    expect(db.prepare('SELECT content FROM memory_entries WHERE namespace=? AND key=?').get('project-progression', row.eventKey).content).toBe(content); db.close();
  });
});

describe('customer terminal evidence regression #386', () => {
  it.each([
    [{ exit_code: null, error: 'timed out after 30000ms', stderr: 'startup banner' }, 'failure'],
    [{ exit_code: 7, stdout: 'partial output' }, 'failure'],
    [{ exit_code: null, signal: 'SIGTERM', stdout: 'partial output' }, 'interrupted'],
    [{ exit_code: 0, outcome: 'failure', stdout: '[ERROR] refused' }, 'failure'],
    [{ exit_code: 0, stdout: 'complete' }, 'success'],
  ])('retains observed terminal facts in a valid immutable redacted snapshot', (response, outcome) => {
    const { dir } = adoptedProject();
    const state = enrichStateWithObservation(stateDefaults(), { hook_event_name: 'PostToolUse', tool_name: 'ruflo', tool_input: { command: 'ruflo status' }, tool_response: response });
    const observation = state.commands[0]; expect(observation.outcome).toBe(outcome);
    const normalized = normalizeTransition({ session_id: 's', tool_name: 'Bash', tool_response: response }, 'PostToolUse');
    expect(normalized.outcome).toBe(outcome);
    if ('exit_code' in response) expect(normalized.exitCode).toBe(response.exit_code);
    if (response.error) expect(normalized.error).toBe(response.error);
    if (response.signal) expect(normalized.signal).toBe(response.signal);
    if ('exit_code' in response) expect(observation.exitCode).toBe(response.exit_code);
    if (response.error) expect(observation.error).toBe(response.error);
    if (response.signal) expect(observation.signal).toBe(response.signal);
    const record = createProgressionSnapshot({ projectIdentity: { id: 'synthetic', canonicalAgentDbPath: path.join(dir, '.swarm/memory.db') }, sourceIdentity: { checkoutPath: dir, worktreeId: 'a', branch: 'main', head: 'a', trackedDigest: 'a', untrackedDigest: 'a', dirtyTreeDigest: 'a' }, hostIdentity: { host: 'codex', adapterVersion: 'test' }, sessionIdentity: 's', sequence: 1, occurredAt: '2026-10-04T00:00:00Z', trigger: 'PostToolUse', parentEventKeys: [], dedupId: 'd', completeProjectState: state });
    expect(validateProgressionSnapshot(record).ok).toBe(true);
    expect(record.completeProjectState.commands[0]).toEqual(observation);
  });
  it('redacts terminal credentials before bounding and writes diagnostic health receipts', () => {
    const file = path.join(tmp('health-terminal-'), 'receipts.jsonl');
    const error = 'timed out token=super-private-terminal-token ' + 'x'.repeat(5000);
    const state = enrichStateWithObservation({}, { hook_event_name: 'PostToolUse', tool_name: 'ruflo', tool_response: { exit_code: null, error, signal: 'SIGTERM' } });
    expect(state.commands[0].error).not.toContain('super-private'); expect(state.commands[0].error.length).toBeLessThan(4200);
    const receipt = recordManagedCliObservation({ toolName: 'ruvnet_cli_run', executable: 'ruflo', argv: ['status'], execution: { code: null, stdout: 'startup banner', stderr: '', error, signal: 'SIGTERM' }, env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: file } });
    expect(receipt).toMatchObject({ healthVerdict: 'FAIL', reachable: false, terminal: { outcome: 'failure', exitCode: null, signal: 'SIGTERM' } });
    expect(receipt.terminal.error).not.toContain('super-private'); expect(receipt.terminal.error.length).toBeLessThanOrEqual(4096);
    expect(readLiveSurfaceReceipts({ file })).toEqual([receipt]);
  });
  it.each(['timeout', 'exit', 'signal', 'fatal', 'failed-fatal', 'success'])('actual managed subprocess returns output together with terminal diagnosis: %s', async (mode) => {
    const home = tmp('terminal-cli-'); const binDir = path.join(home, 'bin'); fs.mkdirSync(binDir);
    // Launch the actual Node executable through a managed name, with no shebang or shell shim.
    fs.symlinkSync(process.execPath, path.join(binDir, process.platform === 'win32' ? 'ruvector.exe' : 'ruvector'), 'file');
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, HOME: home,
      RUVNET_BRAIN_HOME: home, RUVNET_BRAIN_PROJECT_DIR: home, RUVNET_BRAIN_MANAGED_CLI_TIMEOUT_MS: '1000' };
    const help = await callManagedCli('ruvnet_cli_help', { executable: 'ruvector', argv: [] }, env);
    expect(help.isError).toBe(false);
    const source = mode === 'timeout' ? 'setInterval(() => {}, 1000)' : mode === 'signal' ? "process.kill(process.pid, 'SIGTERM')" : `process.exit(${['exit', 'failed-fatal'].includes(mode) ? 7 : 0})`;
    const script = path.join(home, 'fixture.cjs');
    fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(['fatal', 'failed-fatal'].includes(mode) ? '[ERROR] refused\n' : 'partial output\n')}); process.stderr.write('startup banner\\n'); ${source}\n`);
    const result = await callManagedCli('ruvnet_cli_run', { executable: 'ruvector', argv: [script] }, env);
    expect(result.isError).toBe(mode !== 'success'); expect(result.structuredContent.stdout).toContain(['fatal', 'failed-fatal'].includes(mode) ? '[ERROR]' : 'partial output'); expect(result.structuredContent.stderr).toBe('startup banner\n');
    if (mode === 'timeout') { expect(result.content[0].text).toContain('timed out after 1000ms'); expect(result.structuredContent).toMatchObject({ code: null, signal: null, error: 'timed out after 1000ms', outcome: 'failure' }); }
    if (['exit', 'failed-fatal'].includes(mode)) expect(result.content[0].text).toContain('exit 7');
    if (mode === 'signal') {
      // Windows TerminateProcess exposes a failure exit code rather than a POSIX signal.
      if (process.platform === 'win32') expect(result.structuredContent).toMatchObject({ code: 1, signal: null, outcome: 'failure' });
      else expect(result.content[0].text).toContain('signal SIGTERM');
    }
    if (mode === 'fatal') expect(result.content[0].text).toContain('fatal output');
  });
});


describe('single trusted restore regression #385', () => {
  it('capture performs the same full validation as the exported builder once and does not trust caller state', () => {
    const { dir } = adoptedProject(); const resolution = resolveProjectStore({ projectDir: dir });
    const sourceIdentity = { checkoutPath: dir, worktreeId: 'a', branch: 'main', head: 'a', trackedDigest: 'a', untrackedDigest: 'a', dirtyTreeDigest: 'a' };
    const original = createProgressionSnapshot({ projectIdentity: resolution.projectIdentity, sourceIdentity, hostIdentity: { host: 'codex', adapterVersion: 'test' }, sessionIdentity: 'prior', sequence: 1, occurredAt: '2026-10-04T00:00:00Z', trigger: 'Stop', parentEventKeys: [], dedupId: 'prior', completeProjectState: stateDefaults() });
    let reads = 0;
    const watched = new Proxy(original, { get(target, key) { if (key === 'schemaVersion') reads += 1; return target[key]; } });
    const observation = { id: 'observed', occurredAt: '2026-10-04T01:00:00Z', trigger: 'UserPromptSubmit', kind: 'user-goal-observation', authoritative: false };
    const args = { resolution, observation, snapshots: [watched], sessionIdentity: 's', host: 'codex', sourceIdentity };
    const built = buildTransitionProgression(args); const independentlyValidatedReads = reads; reads = 0;
    let captured;
    const result = captureNormalizedTransition({ originProjectDir: dir, host: 'codex', event: 'UserPromptSubmit', payload: { session_id: 's', normalizedTransition: { observation, sourceIdentity } } }, { readHistory: () => [watched], capture: (_dir, _event, options) => { captured = JSON.parse(options.rawInput).projectProgression; return { progressionCaptured: false }; } });
    expect(independentlyValidatedReads).toBeGreaterThan(0); expect(reads).toBe(independentlyValidatedReads);
    expect(captured).toEqual(built); expect(result.eventId).toBe(observation.id);
    expect(() => buildTransitionProgression({ ...args, snapshots: [{ eventKey: 'malformed' }], restored: { ok: true, state: stateDefaults(), heads: [] } })).toThrow(/no coherent ancestry/);
  });
});
