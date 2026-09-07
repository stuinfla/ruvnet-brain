import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveRuflo, rufloInvocation } from '../../plugin/scripts/ruflo-bin.mjs';
import { npmInvocation } from '../helpers/npm-invocation.mjs';
import { packedCandidate } from '../helpers/packed-candidate.mjs';
import { tarExtractionInvocation } from '../../scripts/publication-receipt.mjs';

// Packed adapters + real managed Ruflo, not native model sessions or filesystem relocation.
const ROOT = path.resolve(import.meta.dirname, '../..');
const ruflo = resolveRuflo();
let temporaryRoot, packageRoot, scripts, contract, Store, resolveProjectStore, artifactSha256;
const run = (binary, args, options = {}) => {
  const invocation = binary === 'npm' ? npmInvocation(args) : binary === ruflo
    ? rufloInvocation(binary, args) : { executable: binary, args };
  return spawnSync(invocation.executable, invocation.args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...options, shell: false,
  });
};
const successful = (result) => expect(result.status, result.stderr || result.stdout).toBe(0);

beforeAll(async () => {
  expect(ruflo, 'global Ruflo is required; this acceptance must not vacuously skip').toBeTruthy();
  temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packed-cross-host-')));
  const archive = packedCandidate({ sealedPackage: process.env.RUVNET_SEALED_PACKAGE,
    root: ROOT, destination: temporaryRoot, run });
  artifactSha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const extraction = tarExtractionInvocation(archive, temporaryRoot);
  successful(run('tar', extraction.args, { cwd: extraction.cwd }));
  packageRoot = path.join(temporaryRoot, 'package');
  scripts = path.join(packageRoot, 'plugin', 'scripts');
  const imported = (name) => import(pathToFileURL(path.join(scripts, name)).href);
  contract = await imported('project-progression-contract.mjs');
  ({ ProjectProgressionStore: Store } = await imported('project-progression-store.mjs'));
  ({ resolveProjectStore } = await imported('project-store-resolver.mjs'));
}, 120_000);

afterAll(() => { if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true }); });

function fixture(label) {
  const project = path.join(temporaryRoot, label);
  fs.mkdirSync(project);
  const isolatedHome = path.join(project, 'fixture-home');
  const stateDir = path.join(isolatedHome, '.cache', 'ruvnet-brain');
  fs.mkdirSync(stateDir, { recursive: true });
  // Exercise the normal fresh-maintenance receipt path; no updater or host activation runs.
  for (const name of ['.last-update-check', '.seed-attempted']) {
    fs.writeFileSync(path.join(stateDir, name), String(Math.floor(Date.now() / 1000)));
  }
  fs.writeFileSync(path.join(stateDir, '.auto-update-pref'), 'no');
  const resolution = resolveProjectStore({ projectDir: project });
  const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: isolatedHome, USERPROFILE: isolatedHome, RUFLO_BIN: ruflo, RUFLO_DAEMON_AUTOSTART: '0',
    CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: path.join(packageRoot, 'plugin'),
    PLUGIN_ROOT: path.join(packageRoot, 'plugin'), RUVNET_BRAIN_HOME: stateDir,
    RUVNET_BRAIN_METER: '0', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
  successful(run(ruflo, ['memory', 'init', '--backend', 'agentdb', '--path', resolution.canonicalAgentDbPath],
    { cwd: project, env }));
  const store = new Store({ projectDir: project, rufloBinary: ruflo,
    runner: (binary, args, options) => run(binary, args, { ...options, env }) });
  return { project, env, resolution, store };
}

function sessionStart(f, host) {
  const entry = host === 'codex' ? 'codex-hook-adapter.mjs' : 'hook-shim.mjs';
  const result = run(process.execPath, [path.join(scripts, entry), 'session-start'], {
    cwd: f.project, env: { ...f.env, RUVNET_HOOK_HOST: host },
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume', cwd: f.project, session_id: `${host}-resume` }),
  });
  successful(result);
  if (host === 'claude') return result.stdout;
  const envelope = JSON.parse(result.stdout);
  expect(envelope.hookSpecificOutput.hookEventName).toBe('SessionStart');
  return envelope.hookSpecificOutput.additionalContext;
}

describe('packed interrupted cross-host project resume', () => {
  it.each([['claude', 'codex'], ['codex', 'claude']])('%s interruption resumes exactly once through packaged %s', (from, to) => {
    const f = fixture(`${from}-to-${to}`);
    const state = { currentGoal: 'Resume fixture without losing evidence', acceptanceContract: { required: ['exact resume'] },
      plan: [{ id: 'resume', status: 'in-progress' }], activeProcess: 'ProjectContinuity', activeStep: 'resume',
      completed: ['capture'], inProgress: ['resume'], blockers: [], failures: [], decisions: [], changedFiles: [],
      commands: [], proofArtifacts: [], untested: ['native model session', 'filesystem relocation'],
      nextAction: 'Check the interrupted fixture', resumeConflicts: [] };
    const payload = { session_id: `${from}-interrupted`, hook_event_name: 'SessionEnd', cwd: f.project,
      projectProgression: { sequence: 1, occurredAt: '2026-09-05T20:00:00.000Z', dedupId: `${from}:interruption`,
        parentEventKeys: [], canonicalAgentDbPath: f.resolution.canonicalAgentDbPath,
        sourceIdentity: { checkoutPath: f.project, worktreeId: 'primary', branch: 'fixture', head: 'a'.repeat(40),
          trackedDigest: 'b'.repeat(64), untrackedDigest: 'c'.repeat(64), dirtyTreeDigest: 'd'.repeat(64) },
        completeProjectState: state } };
    if (from === 'claude') {
      const progression = payload.projectProgression;
      payload.project_progression = { sequence: progression.sequence, occurred_at: progression.occurredAt,
        dedup_id: progression.dedupId, parent_event_keys: progression.parentEventKeys,
        canonical_agent_db_path: progression.canonicalAgentDbPath, source_identity: progression.sourceIdentity,
        complete_project_state: progression.completeProjectState };
      delete payload.projectProgression;
    }
    const captureCode = `
      import fs from 'node:fs';
      process.on('exit', () => fs.writeFileSync('unexpected-graceful-exit', 'exit'));
      import { captureProjectTransition } from ${JSON.stringify(pathToFileURL(path.join(scripts, 'project-progression-hook.mjs')).href)};
      import { ProjectProgressionStore } from ${JSON.stringify(pathToFileURL(path.join(scripts, 'project-progression-store.mjs')).href)};
      captureProjectTransition({ host: ${JSON.stringify(from)}, projectDir: process.cwd(), payload: ${JSON.stringify(payload)},
        storeFactory(options) { const store = new ProjectProgressionStore(options);
          const capture = store.capture.bind(store);
          store.capture = (snapshot) => capture(snapshot, { onPhase(phase) {
            if (phase === 'outbox-fsynced') {
              fs.writeFileSync('interrupted-phase', phase);
              process.kill(process.pid, 'SIGKILL');
            }
          } }); return store; } });`;
    const interrupted = run(process.execPath, ['--input-type=module', '-e', captureCode], { cwd: f.project, env: f.env });
    expect(interrupted.error, interrupted.stderr).toBeUndefined();
    expect(interrupted.status, interrupted.stderr).not.toBe(0);
    // Windows reports native process termination via an exit code, not always a POSIX signal.
    expect(interrupted.signal === 'SIGKILL' || (process.platform === 'win32'
      && interrupted.signal === null && Number.isInteger(interrupted.status))).toBe(true);
    expect(fs.readFileSync(path.join(f.project, 'interrupted-phase'), 'utf8')).toBe('outbox-fsynced');
    expect(fs.existsSync(path.join(f.project, 'unexpected-graceful-exit'))).toBe(false);
    const [snapshot] = f.store.outbox.pendingSnapshots();
    expect(snapshot.projectIdentity).toEqual(f.resolution.projectIdentity);
    expect(snapshot.hostIdentity.host).toBe(from);
    expect(snapshot.completeProjectState).toMatchObject(state);
    expect(contract.validateProgressionSnapshot(snapshot, { expectedProjectIdentity: f.resolution.projectIdentity }).ok).toBe(true);
    expect(f.store.listSnapshotKeys()).toEqual([]);

    const context = sessionStart(f, to);
    expect(context).toContain('[RuvNet Brain — PROJECT CONTINUITY RESTORED]');
    const resumed = JSON.parse(context.split('\n').find((line) => line.startsWith('{"schema":"ruvnet-brain.project-resume"')));
    expect(resumed.projectIdentity).toEqual(snapshot.projectIdentity);
    expect(resumed.heads).toEqual([snapshot.eventKey]);
    expect(resumed.state).toEqual({ ...snapshot.completeProjectState,
      journalHeads: [snapshot.eventKey], sourceIdentity: snapshot.sourceIdentity });
    expect(resumed.evidence).toMatchObject({ structurallyEnumerated: 1, exactRetrieved: 1, rejectedCandidates: [] });
    const exact = f.store.retrieveSnapshots([snapshot.eventKey]).snapshots[0];
    expect(contract.digestCanonical(exact)).toBe(contract.digestCanonical(snapshot));
    expect(exact.payloadDigest).toBe(snapshot.payloadDigest);
    expect(f.store.outbox.pendingSnapshots()).toEqual([]);
    const committed = fs.readFileSync(f.store.outbox.path, 'utf8');
    expect(f.store.outbox.records().filter((row) => row.type === 'commit')).toHaveLength(1);
    expect(sessionStart(f, to)).toContain(snapshot.eventKey);
    expect(fs.readFileSync(f.store.outbox.path, 'utf8')).toBe(committed);
    expect(f.store.listSnapshotKeys()).toEqual([snapshot.eventKey]);

    const foreign = fixture(`${from}-foreign`);
    expect(foreign.resolution.projectIdentity).not.toEqual(snapshot.projectIdentity);
    expect(() => foreign.store.capture(snapshot)).toThrow(/foreign project|foreign canonical/i);
    // A transferred raw row must also be rejected at restoration, not just at capture.
    successful(run(ruflo, ['memory', 'store', '--key', snapshot.eventKey, '--value', JSON.stringify(snapshot),
      '--namespace', 'project-progression', '--path', foreign.resolution.canonicalAgentDbPath],
    { cwd: foreign.project, env: foreign.env }));
    const rejected = sessionStart(foreign, to);
    expect(rejected).toContain('PROJECT CONTINUITY UNKNOWN');
    expect(rejected).not.toContain('PROJECT CONTINUITY RESTORED');
    expect(rejected).not.toContain(state.currentGoal);
    console.info(JSON.stringify({ proof: 'packed-adapter-cross-host-interrupted-resume', from, to, artifactSha256,
      exactIdentity: true, durableReplayOnce: true, foreignProjectRejected: true,
      untested: ['native model sessions', 'filesystem relocation'] }));
  }, 120_000);
});
