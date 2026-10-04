import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { adoptedProject, cleanup, fakeRuflo, rows } from '../helpers/continuity-fixture.mjs';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { runSessionSnapshotHook, queueCapture } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { ContinuityJournal, captureContinuityEvents, drain } from '../../plugin/scripts/continuity-journal.mjs';
import { makeEvent } from '../../plugin/scripts/continuity-events.mjs';

function fixture() {
  const f = adoptedProject(); const cli = fakeRuflo();
  const env = { ...f.env, RUVNET_BRAIN_HOME: `${f.home}/brain`, RUVNET_CONTINUITY_CAPTURE: 'on', RUVNET_TURN_CAPTURE: 'on' };
  const origin = `${f.dir}/private`; fs.mkdirSync(origin);
  const policyFile = `${env.RUVNET_BRAIN_HOME}/turn-capture/policy.json`;
  fs.mkdirSync(`${env.RUVNET_BRAIN_HOME}/turn-capture`, { recursive: true });
  const policy = (setting) => fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, projects: { [f.dir]: 'on' }, paths: { [origin]: setting } }));
  policy('on');
  const store = new ProjectProgressionStore({ projectDir: origin, env, rufloBinary: cli.bin });
  const snapshot = createProgressionSnapshot({ projectIdentity: store.resolution.projectIdentity,
    sourceIdentity: { checkoutPath: f.dir, capturePath: origin, worktreeId: 'primary', branch: 'main', head: 'a', trackedDigest: 'b', untrackedDigest: 'c', dirtyTreeDigest: 'd' },
    hostIdentity: { host: 'claude', adapterVersion: 'test' }, sessionIdentity: 'consent', sequence: 1,
    occurredAt: '2026-10-03T20:00:00.000Z', trigger: 'Stop', dedupId: 'consent', parentEventKeys: [],
    completeProjectState: { currentGoal: 'private result', acceptanceContract: null, activeProcess: 'repair', activeStep: 'test', plan: [], completed: [], inProgress: [], blockers: [], failures: [], decisions: [], changedFiles: [], commands: [], proofArtifacts: [], untested: [], resumeConflicts: [], nextAction: 'verify' } });
  return { ...f, cli, env, origin, policy, store, snapshot };
}
afterEach(cleanup);

it.each(['Stop', 'PreCompact', 'SessionEnd'])('%s persists nothing at a currently opted-out original path', (event) => {
  const f = fixture(); f.policy('off'); const calls = [];
  const before = fs.readdirSync(`${f.dir}/.swarm`).sort();
  const result = runSessionSnapshotHook(f.origin, event, { env: f.env,
    rawInput: JSON.stringify({ session_id: 'consent', hook_event_name: event, last_assistant_message: 'Decision: private result.' }),
    captureTurn: () => { calls.push('turn'); return {}; }, captureEvents: () => { calls.push('events'); return {}; },
    produce: () => { calls.push('produce'); return {}; }, spawnReplay: () => { calls.push('replay'); return true; } });
  expect(result.skipped).toMatch(/opt-out/); expect(calls).toEqual([]);
  expect(fs.readdirSync(`${f.dir}/.swarm`).sort()).toEqual(before);
  expect(rows(f.store.resolution.canonicalAgentDbPath, 'project-progression')).toEqual([]);
});

it.each(['Stop', 'PreCompact', 'SessionEnd'])('native %s launcher leaves opted-out storage untouched', (event) => {
  const f = fixture(); f.policy('off');
  const before = fs.readdirSync(`${f.dir}/.swarm`).sort();
  const script = fileURLToPath(new URL('../../plugin/scripts/session-snapshot-hook.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, event], { cwd: f.dir,
    env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir, RUVNET_HOOK_HOST: 'claude' },
    input: JSON.stringify({ session_id: 'native-consent', hook_event_name: event, cwd: f.origin, last_assistant_message: 'Decision: private native result.' }),
    encoding: 'utf8', timeout: 3000 });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
  expect(fs.readdirSync(`${f.dir}/.swarm`).sort()).toEqual(before);
  expect(rows(f.store.resolution.canonicalAgentDbPath, 'project-progression')).toEqual([]);
});

it('direct event journal refuses new records while original path is off', () => {
  const f = fixture(); f.policy('off');
  const journal = new ContinuityJournal({ projectRoot: f.dir, projectDir: f.origin, env: f.env });
  expect(() => journal.record([makeEvent({ kind: 'lesson', at: Date.now(), source: 'explicit', authoritative: true, summary: 'Private learning.' })])).toThrow(/opt-out/);
  expect(fs.existsSync(journal.path)).toBe(false);
});

it('retains legacy event debt when its original path is unknown under a descendant opt-out', () => {
  const f = fixture(); const journal = new ContinuityJournal({ projectRoot: f.dir, env: f.env, ruflo: f.cli.bin });
  const [record] = journal.record([makeEvent({ kind: 'lesson', at: Date.now(), source: 'explicit', authoritative: true, summary: 'Legacy learning.' })]);
  delete record.capturePath;
  fs.writeFileSync(journal.path, `${JSON.stringify(record)}\n`);
  const before = fs.readFileSync(journal.path); f.policy('off');
  expect(drain(journal)).toMatchObject({ committed: 0, remaining: 1, skipped: expect.stringMatching(/origin.*opt-out/) });
  expect(fs.readFileSync(journal.path)).toEqual(before); expect(f.cli.calls()).toEqual([]);
});

it('direct capture refuses before creating a new progression outbox', () => {
  const f = fixture(); f.policy('off');
  expect(() => f.store.capture(f.snapshot)).toThrow(/opt-out/);
  expect(f.store.outbox.records()).toEqual([]); expect(f.cli.calls()).toEqual([]);
  expect(fs.existsSync(f.store.outbox.path)).toBe(false);
});

it('direct queue refuses to freeze or persist new opted-out work', () => {
  const f = fixture(); f.policy('off');
  expect(queueCapture({ projectDir: f.dir, originProjectDir: f.origin, env: f.env, event: 'Stop', host: 'claude', payload: { session_id: 'consent', projectProgression: { private: 'result' } } })).toBeNull();
  expect(fs.readdirSync(`${f.dir}/.swarm`).filter((name) => name.includes('capture-queue'))).toEqual([]);
});

it('direct material-event capture refuses before reading or journaling private content', () => {
  const f = fixture(); f.policy('off'); let read = false; let launch = false;
  const result = captureContinuityEvents({ projectDir: f.origin, env: f.env, event: 'Stop', payload: { transcript_path: 'private-transcript', last_assistant_message: 'Decision: private result.' },
    readTranscript: () => { read = true; return []; }, launch: () => { launch = true; return true; } });
  expect(result.skipped).toMatch(/opt-out/); expect(read).toBe(false); expect(launch).toBe(false);
  expect(fs.existsSync(`${f.dir}/.swarm/continuity-events-outbox.jsonl`)).toBe(false);
});

it('suspends existing progression and event debt without changing it, then exact-replays after opt-in', () => {
  const f = fixture(); f.store.outbox.appendSnapshot(f.snapshot);
  const journal = new ContinuityJournal({ projectRoot: f.dir, projectDir: f.origin, env: f.env, ruflo: f.cli.bin });
  journal.record([makeEvent({ kind: 'lesson', at: Date.now(), source: 'explicit', authoritative: true, summary: 'Private learning.' })]);
  const progressionBytes = fs.readFileSync(f.store.outbox.path); const eventBytes = fs.readFileSync(journal.path);
  f.policy('off'); expect(() => f.store.replay()).toThrow(/opt-out/);
  expect(drain(journal)).toMatchObject({ committed: 0, remaining: 1, skipped: expect.stringMatching(/opt-out/) });
  expect(fs.readFileSync(f.store.outbox.path)).toEqual(progressionBytes); expect(fs.readFileSync(journal.path)).toEqual(eventBytes); expect(f.cli.calls()).toEqual([]);
  f.policy('on'); expect(f.store.replay()).toHaveLength(1); expect(drain(journal)).toMatchObject({ committed: 1, remaining: 0 });
  expect(f.store.retrieveSnapshots([f.snapshot.eventKey]).snapshots).toEqual([f.snapshot]);
  expect(rows(journal.db, 'continuity-events')).toHaveLength(1);
});

it('rechecks consent before another event write within the same drain', () => {
  const f = fixture(); const journal = new ContinuityJournal({ projectRoot: f.dir, projectDir: f.origin, env: f.env, ruflo: f.cli.bin });
  journal.record(['first', 'second'].map((text) => makeEvent({ kind: 'lesson', at: Date.now(), source: 'explicit', authoritative: true, summary: text })));
  let writes = 0; const committed = new Map();
  const result = drain(journal, { store: ({ key, value }) => { writes += 1; committed.set(key, value); f.policy('off'); return { status: 0 }; },
    readBack: ({ key }) => ({ content: committed.get(key), readPath: 'fixture-exact' }) });
  expect(writes).toBe(1); expect(result).toMatchObject({ committed: 1, remaining: 1, skipped: expect.stringMatching(/opt-out/) });
});
