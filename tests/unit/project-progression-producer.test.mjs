/**
 * The producer's two contracts: every field is TRACEABLE, and nothing private is PERSISTED.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DERIVED_TEXT_LIMIT,
  readOwnerNote,
  readSourceIdentity,
  readTranscriptReference,
  readWorkLedger,
} from '../../plugin/scripts/project-progression-sources.mjs';
import { PROVENANCE_SOURCES, buildProjectProgression } from '../../plugin/scripts/project-progression-producer.mjs';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { resolveRuflo, rufloInvocation } from '../../plugin/scripts/ruflo-bin.mjs';
import { withProgressionReader } from '../../plugin/scripts/project-progression-reader.mjs';

const roots = [];
it.each(['alias', 'exact'])('joins the actual canonical %s key before deriving prior goal/action', (mode) => {
  const root = temporaryRoot('prior-key-'), resolution = resolveProjectStore({ projectDir: root });
  const env = { ...process.env, HOME: root, USERPROFILE: root, RUFLO_DAEMON_AUTOSTART: '0', RUVNET_WORK_LEDGER: path.join(root, 'absent-ledger') };
  const binary = resolveRuflo(); expect(binary).toBeTruthy();
  const run = (args) => { const invocation = rufloInvocation(binary, args);
    const result = spawnSync(invocation.executable, invocation.args, { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    expect(result.status, result.stderr).toBe(0); };
  fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath));
  run(['memory', 'init', '--backend', 'agentdb', '--no-verify', '--path', resolution.canonicalAgentDbPath]);
  const state = { ...Object.fromEntries(['plan', 'completed', 'inProgress', 'blockers', 'failures', 'decisions', 'changedFiles', 'commands', 'proofArtifacts', 'untested', 'resumeConflicts'].map(key => [key, []])),
    currentGoal: 'Controlled canonical prior goal', nextAction: 'Controlled next action', acceptanceContract: null, activeProcess: null, activeStep: null };
  const snapshot = createProgressionSnapshot({ projectIdentity: resolution.projectIdentity,
    sourceIdentity: readSourceIdentity({ checkoutRoot: root, kind: resolution.kind }).identity,
    hostIdentity: { host: 'controlled-offline', adapterVersion: 'prior-key-proof' }, sessionIdentity: 'controlled-prior',
    sequence: 1, occurredAt: new Date().toISOString(), trigger: 'controlled-proof', parentEventKeys: [], dedupId: 'controlled-prior', completeProjectState: state });
  const key = mode === 'alias' ? 'controlled-alias-key' : snapshot.eventKey, value = JSON.stringify(snapshot);
  run(['memory', 'store', '--key', key, '--value', value, '--namespace', 'project-progression', '--no-upsert', '--path', resolution.canonicalAgentDbPath]);
  const produce = () => buildProjectProgression({ resolution, projectDir: root, host: 'codex', env,
    payload: { hook_event_name: 'Stop', session_id: 'controlled-later' } });
  if (mode === 'alias') expect(produce).toThrow(/exact key\/payload identity mismatch/);
  else { const produced = produce(); expect(produced.projectProgression.completeProjectState.currentGoal).toBe(state.currentGoal);
    expect(produced.projectProgression.parentEventKeys).toEqual([snapshot.eventKey]); }
  const exact = withProgressionReader(resolution.canonicalAgentDbPath, reader => ({ keys: reader.listKeys('project-progression'), value: reader.readContent('project-progression', key) }));
  expect(exact.ok).toBe(true); expect(exact.value.keys).toEqual([key]); expect(exact.value.value).toBe(value);
}, 30000);

it('an expired or cancelled producer cannot forge a source identity from an unread checkout', () => {
  const controller = new AbortController(); controller.abort();
  expect(() => readSourceIdentity({ checkoutRoot: '/unread-checkout', deadlineAt: Date.now() - 1 })).toThrow(/deadline exceeded/);
  expect(() => readSourceIdentity({ checkoutRoot: '/unread-checkout', signal: controller.signal })).toThrow(/deadline exceeded/);
});
it.skipIf(process.platform === 'win32')('bounds the actual six-Git identity path by one epoch rather than six reset timeouts', () => {
  // POSIX executable fixture only; portable cancellation/reader/wrapper cases remain selected on Windows.
  const root = temporaryRoot(); const bin = path.join(root, 'bin'); fs.mkdirSync(bin); const calls = path.join(root, 'calls');
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'git\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,90);process.exit(1);`); fs.chmodSync(path.join(bin, 'git'), 0o700);
  const source = `import {readSourceIdentity} from ${JSON.stringify(new URL('../../plugin/scripts/project-progression-sources.mjs', import.meta.url).href)};
    const start=Date.now();try{readSourceIdentity({checkoutRoot:process.cwd(),deadlineAt:start+350});console.log(JSON.stringify({unexpectedSuccess:true}));}
    catch(error){console.log(JSON.stringify({elapsedMs:Date.now()-start,error:error.message}));}`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', timeout: 2000,
    env: { ...process.env, HOME: root, USERPROFILE: root, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  expect(run.status, run.stderr).toBe(0); const result = JSON.parse(run.stdout);
  expect(result.error).toMatch(/deadline exceeded/); expect(result.elapsedMs).toBeLessThan(1000);
  expect(fs.readFileSync(calls, 'utf8').trim().split('\n').length).toBeLessThan(6);
});
function temporaryRoot(prefix = 'producer-') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

// An API key and a password, in the shapes redactProgression knows, planted where a careless
// producer would copy them verbatim into a stored field.
const SECRET_PROMPT = 'Finish the lane. Key sk-proj-ABCDEF1234567890, password=hunter2, do not lose it.';
const SECRET_REPLY = 'Understood. Authorization: Bearer abcdef0123456789 was used for the last call.';

function transcriptFixture({ user = SECRET_PROMPT, assistant = SECRET_REPLY } = {}) {
  const file = path.join(temporaryRoot('transcript-'), 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'summary', text: 'ignored' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: user } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistant }] } }),
  ].join('\n') + '\n');
  return file;
}

function resolutionFixture({ canonicalAgentDbPath = path.join(temporaryRoot('store-'), 'absent.db') } = {}) {
  const projectRoot = temporaryRoot('project-');
  return {
    kind: 'non-git',
    projectRoot,
    checkoutRoot: projectRoot,
    gitCommonDir: null,
    canonicalAgentDbPath,
    projectIdentity: { id: 'non-git-sha256:abc', canonicalAgentDbPath },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('progression sources', () => {
  it('reads a work ledger exactly where continuation-gate writes one, and reports absence honestly', () => {
    const home = temporaryRoot('home-');
    const dir = path.join(home, '.config', 'ruvnet-brain', 'work-ledgers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'git-sha256-deadbeef.json'), JSON.stringify({
      items: [
        { text: 'open one', done: false }, { text: 'finished', done: true }, { text: 'open two', done: false },
      ],
      objective: { text: 'ship the lane', state: 'active' },
    }));
    const ledger = readWorkLedger({ projectId: 'git-sha256:deadbeef', env: {}, home });
    expect(ledger).toMatchObject({ present: true, open: ['open one', 'open two'], done: ['finished'] });
    expect(ledger.objective.text).toBe('ship the lane');

    const absent = readWorkLedger({ projectId: 'git-sha256:nothing', env: {}, home });
    expect(absent).toMatchObject({ present: false, open: [], done: [], objective: null });
  });

  it('returns a transcript REFERENCE and bounded derivations — never the prompt or the reply', () => {
    const file = transcriptFixture();
    const read = readTranscriptReference(file, { host: 'claude' });
    expect(read.reference).toMatchObject({ path: file, byteOffset: 0, format: 'claude-jsonl', recordsRead: 2 });
    expect(read.reference.excerptSha256).toMatch(/^[0-9a-f]{64}$/);
    // A reference, not a copy: no field of the reference carries transcript text at all.
    expect(JSON.stringify(read.reference)).not.toContain('hunter2');
    expect(read.derivedGoal.length).toBeLessThanOrEqual(DERIVED_TEXT_LIMIT + 1);
    expect(read.derivedNextAction.length).toBeLessThanOrEqual(DERIVED_TEXT_LIMIT + 1);
    // First sentence only — the key and password live in the SECOND sentence of the fixture.
    expect(read.derivedGoal).toBe('Finish the lane.');
  });

  it('skips, with a reason, every transcript it cannot parse', () => {
    expect(readTranscriptReference(undefined).skipped).toMatch(/no transcript path/);
    expect(readTranscriptReference('/nonexistent/path.jsonl').skipped).toMatch(/unreadable/);
    expect(readTranscriptReference(transcriptFixture(), { host: 'codex' }).skipped)
      .toMatch(/current native Codex callback identity unavailable/);
    const notJsonl = path.join(temporaryRoot('plain-'), 'session.txt');
    fs.writeFileSync(notJsonl, 'plain text transcript');
    expect(readTranscriptReference(notJsonl).skipped).toMatch(/not a JSONL transcript/);
  });

  it('digests a non-git tree without fabricating hashes of nothing', () => {
    const root = temporaryRoot('nongit-');
    const { identity, headStable } = readSourceIdentity({ checkoutRoot: root, kind: 'non-git' });
    expect(headStable).toBe(true);
    expect(identity).toMatchObject({ checkoutPath: root, branch: 'non-git', head: 'non-git' });
    for (const field of ['worktreeId', 'trackedDigest', 'untrackedDigest', 'dirtyTreeDigest']) {
      expect(identity[field], field).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // Linux probe (2026-10-01): with no global gitignore listing .swarm/, the Brain's own memory.db made
  // every boundary a "changed tree". Run git with an EMPTY global config so no user ignore file can mask it.
  it('the Brain\'s own state (.swarm, .claude-flow, ruvector.db) never changes the source identity', () => {
    const emptyConfig = path.join(temporaryRoot('gitcfg-'), 'empty.gitconfig');
    fs.writeFileSync(emptyConfig, '');
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' });
    try {
      const root = temporaryRoot('brainstate-');
      const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
      run('init', '-q');
      fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1);\n');
      // A project that once committed its .swarm by accident: tracked Brain state must not count either.
      fs.mkdirSync(path.join(root, '.swarm'));
      fs.writeFileSync(path.join(root, '.swarm', 'memory.db'), 'v1');
      run('add', '-A'); run('commit', '-qm', 'init');
      const digests = () => { const { identity } = readSourceIdentity({ checkoutRoot: root });
        return { tracked: identity.trackedDigest, untracked: identity.untrackedDigest, dirty: identity.dirtyTreeDigest }; };
      const before = digests();
      fs.writeFileSync(path.join(root, '.swarm', 'memory.db'), 'v2 after a capture');
      for (const name of ['memory.db-wal', 'memory.db-shm', 'project-progression-outbox.jsonl']) fs.writeFileSync(path.join(root, '.swarm', name), name);
      fs.mkdirSync(path.join(root, '.claude-flow'));
      fs.writeFileSync(path.join(root, '.claude-flow', 'metrics.json'), '{}');
      fs.writeFileSync(path.join(root, 'ruvector.db'), 'x');
      expect(digests()).toEqual(before);
      // The customer's own changes still move every digest they should.
      fs.writeFileSync(path.join(root, 'notes.md'), 'new\n');
      expect(digests().untracked).not.toBe(before.untracked);
      fs.writeFileSync(path.join(root, 'app.js'), 'console.log(2);\n');
      expect(digests().dirty).not.toBe(before.dirty);
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it('carries only the head of the newest owner note, with a digest of exactly what it carried', () => {
    const rows = [
      { key: 'project-state-current-1', namespace: 'ruvnet-brain', content: 'older note' },
      { key: 'project-state-current-2', namespace: 'ruvnet-brain', content: `newest note ${'x'.repeat(2000)}` },
      { key: 'unrelated-key', namespace: 'ruvnet-brain', content: 'not a checkpoint' },
    ];
    const note = readOwnerNote(() => rows, { limit: 600 });
    expect(note.key).toBe('project-state-current-2');
    expect(note.excerpt).toHaveLength(600);
    expect(note.truncated).toBe(true);
    expect(note.excerptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readOwnerNote(() => [{ key: 'unrelated', content: 'x' }])).toBeNull();
    expect(readOwnerNote(() => { throw new Error('store unavailable'); })).toBeNull();
  });
});

describe('progression producer', () => {
  const payloadFor = (transcriptPath) => ({
    session_id: 'producer-session', hook_event_name: 'Stop', transcript_path: transcriptPath,
  });

  it('labels every field with a source, and marks transcript inferences non-authoritative', () => {
    const resolution = resolutionFixture();
    const produced = buildProjectProgression({
      resolution, payload: payloadFor(transcriptFixture()), host: 'claude',
      env: { RUVNET_WORK_LEDGER: path.join(temporaryRoot('noledger-'), 'absent.json') },
      now: () => '2026-09-11T00:00:00.000Z',
    });
    const { provenance } = produced;
    for (const [field, marker] of Object.entries(provenance)) {
      expect(PROVENANCE_SOURCES, field).toContain(marker.source);
      expect(typeof marker.authoritative, field).toBe('boolean');
    }
    // With no ledger and no prior head, the goal can only have come from the transcript — and it
    // must be flagged as an inference rather than presented as the user's instruction.
    expect(provenance.currentGoal).toEqual({ source: 'transcript-derived', authoritative: false });
    expect(produced.projectProgression.completeProjectState.currentGoal).toBe('Finish the lane.');
    expect(produced.projectProgression.sequence).toBe(1);
    expect(produced.projectProgression.parentEventKeys).toEqual([]);
  });

  it('prefers the user\'s own ledger over anything it could infer', () => {
    const home = temporaryRoot('home-');
    const ledgerFile = path.join(home, 'ledger.json');
    fs.writeFileSync(ledgerFile, JSON.stringify({
      items: [{ text: 'the goal the user wrote', done: false }, { text: 'the next thing', done: false }],
    }));
    const produced = buildProjectProgression({
      resolution: resolutionFixture(), payload: payloadFor(transcriptFixture()), host: 'claude',
      env: { RUVNET_WORK_LEDGER: ledgerFile }, now: () => '2026-09-11T00:00:00.000Z',
    });
    expect(produced.projectProgression.completeProjectState.currentGoal).toBe('the goal the user wrote');
    expect(produced.provenance.currentGoal).toEqual({ source: 'ledger', authoritative: true });
    expect(produced.projectProgression.completeProjectState.nextAction).toBe('the next thing');
  });

  it('keeps transcript prose out of the resumable next action when no durable action exists', () => {
    const produced = buildProjectProgression({
      resolution: resolutionFixture(), payload: payloadFor(transcriptFixture()), host: 'claude',
      env: { RUVNET_WORK_LEDGER: path.join(temporaryRoot('noledger-'), 'absent.json') },
      now: () => '2026-09-11T00:00:00.000Z',
    });
    expect(produced.projectProgression.completeProjectState.nextAction).toBeNull();
    expect(produced.provenance.nextAction).toEqual({ source: 'none', authoritative: false });
  });

  it('never lets secret-shaped transcript material reach ANY produced field', () => {
    const produced = buildProjectProgression({
      resolution: resolutionFixture(),
      payload: payloadFor(transcriptFixture({
        // Every secret in the FIRST sentence, so the sentence bound cannot be what saves us.
        user: 'Use sk-proj-ABCDEF1234567890 and password=hunter2 now, immediately, for everything.',
        assistant: 'Authorization: Bearer abcdef0123456789 is the token I used and will keep using.',
      })),
      host: 'claude',
      env: { RUVNET_WORK_LEDGER: path.join(temporaryRoot('noledger-'), 'absent.json') },
      now: () => '2026-09-11T00:00:00.000Z',
    });
    const serialized = JSON.stringify(produced);
    for (const secret of ['sk-proj-ABCDEF1234567890', 'hunter2', 'abcdef0123456789']) {
      expect(serialized, `leaked ${secret}`).not.toContain(secret);
    }
    // Redacted, not merely absent: the derived field still exists and still says something.
    expect(produced.projectProgression.completeProjectState.currentGoal).toMatch(/REDACTED/);
  });

  it('suppresses a capture that would add nothing', () => {
    const resolution = resolutionFixture();
    const options = {
      resolution, payload: payloadFor(transcriptFixture()), host: 'claude',
      env: { RUVNET_WORK_LEDGER: path.join(temporaryRoot('noledger-'), 'absent.json') },
      now: () => '2026-09-11T00:00:00.000Z',
    };
    // With no committed head there is nothing to be identical TO, so the first capture always runs.
    expect(buildProjectProgression(options).skipped).toBeUndefined();
    expect(buildProjectProgression(options).meaningDigest)
      .toBe(buildProjectProgression({ ...options, trigger: 'PreCompact' }).meaningDigest);
  });
});


it('PreCompact records a fresh canonical lifecycle boundary after identical Stop while other events still deduplicate', async () => {
  const { adoptedProject, fakeRuflo, rows, cleanup } = await import('../helpers/continuity-fixture.mjs');
  const { runSessionSnapshotHook } = await import('../../plugin/scripts/session-snapshot-hook.mjs');
  const { ProjectProgressionStore } = await import('../../plugin/scripts/project-progression-store.mjs');
  const f = adoptedProject();
  const cli = fakeRuflo(f.home);
  const env = { ...f.env, RUVNET_BRAIN_HOME: path.join(f.home, 'brain'), RUVNET_RUFLO_CWD_ROOT: path.join(f.home, 'scratch') };
  const db = path.join(f.dir, '.swarm', 'memory.db');
  const run = event => runSessionSnapshotHook(f.dir, event, { env, host: 'codex', budgetMs: 8000,
    rawInput: JSON.stringify({ session_id: 'native-lifecycle', hook_event_name: event, cwd: f.dir }),
    makeStoreFactory: () => options => new ProjectProgressionStore({ ...options, rufloBinary: cli.bin }),
  });
  try {
    const stop = run('Stop');
    expect(stop.progressionCaptured, JSON.stringify(stop)).toBe(true);
    const first = JSON.parse(rows(db, 'project-progression')[0].content);
    const repeatedStop = run('Stop');
    expect(repeatedStop.progressionCaptured).toBe(false);
    expect(repeatedStop.skipped).toMatch(/no-op capture/);
    expect(rows(db, 'project-progression')).toHaveLength(1);
    const compact = run('PreCompact');
    expect(compact.progressionCaptured, JSON.stringify(compact)).toBe(true);
    const snapshots = rows(db, 'project-progression').map(row => JSON.parse(row.content)).sort((a,b) => a.sequence-b.sequence);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ trigger: 'PreCompact', sessionIdentity: 'native-lifecycle', sequence: first.sequence + 1, parentEventKeys: [first.eventKey] });
    expect(snapshots[1].eventKey).not.toBe(first.eventKey);
    expect(compact.receipt.readbackDigest).toBe(snapshots[1].payloadDigest);
    expect(cli.calls().some(call => call.argv.includes('store') && call.key === compact.receipt.eventKey)).toBe(true);
    expect(run('SessionEnd').skipped).toMatch(/no-op capture/);
    expect(rows(db, 'project-progression')).toHaveLength(2);
  } finally { cleanup(); }
});

it.skipIf(process.platform === 'win32')('exact NUL Git names detect Unicode and newline untracked byte changes at the same HEAD', () => {
  const root = temporaryRoot('source-exactnames-');
  const run = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', ...args], { cwd: root, encoding: 'utf8' });
  run('init', '-q'); run('config', 'core.quotePath', 'true');
  fs.writeFileSync(path.join(root, 'tracked.mjs'), 'export const value=1;\n');
  run('add', '-A'); run('commit', '-qm', 'private fixture');
  const names = ['café-☃.mjs', 'line\nbreak.mjs'];
  names.forEach(name => fs.writeFileSync(path.join(root, name), 'first bytes'));
  expect(run('ls-files', '--others', '--exclude-standard')).toContain('"');
  const before = readSourceIdentity({ checkoutRoot: root, deadlineAt: Date.now() + 5000 });
  for (const name of names) {
    const previous = readSourceIdentity({ checkoutRoot: root });
    fs.writeFileSync(path.join(root, name), 'changed exact bytes');
    const current = readSourceIdentity({ checkoutRoot: root, deadlineAt: Date.now() + 5000 });
    expect(current.identity.head).toBe(before.identity.head);
    expect(current.identity.trackedDigest).toBe(before.identity.trackedDigest);
    expect(current.identity.untrackedDigest).not.toBe(previous.identity.untrackedDigest);
  }
});

it.skipIf(process.platform === 'win32')('an actually unreadable untracked name cannot mint an exact source identity', () => {
  const root = temporaryRoot('source-unreadable-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.symlinkSync('absent-target', path.join(root, 'unreadable.mjs'));
  expect(() => readSourceIdentity({ checkoutRoot: root })).toThrow(/untracked file unreadable/);
  expect(() => readSourceIdentity({ checkoutRoot: root, deadlineAt: Date.now() + 5000 })).toThrow(/untracked file unreadable/);
});

it.skipIf(process.platform === 'win32')('untracked newline names cannot alias two separate content/path records', () => {
  const root = temporaryRoot('source-name-alias-'); execFileSync('git', ['init', '-q'], { cwd: root });
  // A raw newline-joined digest/path serialization could confuse this single name with two records.
  const secondDigest = crypto.createHash('sha256').update('second bytes').digest('hex');
  const crafted = `first\n${secondDigest} second`;
  fs.writeFileSync(path.join(root, crafted), 'first bytes');
  const one = readSourceIdentity({ checkoutRoot: root });
  fs.unlinkSync(path.join(root, crafted));
  fs.writeFileSync(path.join(root, 'first'), 'first bytes'); fs.writeFileSync(path.join(root, 'second'), 'second bytes');
  const two = readSourceIdentity({ checkoutRoot: root });
  expect(two.identity.untrackedDigest).not.toBe(one.identity.untrackedDigest);
});

it.skipIf(process.platform === 'win32')('actual progression producer captures changed Unicode/newline bytes after an unchanged no-op', async () => {
  // The SQLite/Ruflo fixture is a disclosed persistence seam; Git and the producer/hook are real.
  const { adoptedProject, fakeRuflo, rows, cleanup } = await import('../helpers/continuity-fixture.mjs');
  const { runSessionSnapshotHook } = await import('../../plugin/scripts/session-snapshot-hook.mjs');
  const { ProjectProgressionStore } = await import('../../plugin/scripts/project-progression-store.mjs');
  const f = adoptedProject(), cli = fakeRuflo(f.home);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', ...args], { cwd: f.dir });
  try {
    git('init', '-q'); git('config', 'core.quotePath', 'true');
    fs.writeFileSync(path.join(f.dir, 'tracked.mjs'), 'export const value=1;\n'); git('add', 'tracked.mjs'); git('commit', '-qm', 'private fixture');
    const names = ['café-☃.mjs', 'line\nbreak.mjs']; names.forEach(name => fs.writeFileSync(path.join(f.dir, name), 'first bytes'));
    const env = { ...f.env, RUVNET_BRAIN_HOME: path.join(f.home, 'brain'), RUVNET_RUFLO_CWD_ROOT: path.join(f.home, 'scratch') };
    const run = () => runSessionSnapshotHook(f.dir, 'Stop', { env, host: 'codex', budgetMs: 8000,
      rawInput: JSON.stringify({ session_id: 'fixture-only-source-identity', hook_event_name: 'Stop', cwd: f.dir }),
      makeStoreFactory: () => options => new ProjectProgressionStore({ ...options, rufloBinary: cli.bin }) });
    expect(run().progressionCaptured).toBe(true);
    expect(run().skipped).toMatch(/no-op capture/);
    for (const [index, name] of names.entries()) {
      const before = JSON.parse(rows(path.join(f.dir, '.swarm/memory.db'), 'project-progression').at(-1).content);
      fs.writeFileSync(path.join(f.dir, name), `changed bytes ${index}`);
      const changed = run(); expect(changed.progressionCaptured, JSON.stringify(changed)).toBe(true);
      const snapshots = rows(path.join(f.dir, '.swarm/memory.db'), 'project-progression').map(row => JSON.parse(row.content));
      const after = snapshots.at(-1); expect(after.sourceIdentity.head).toBe(before.sourceIdentity.head);
      expect(after.sourceIdentity.untrackedDigest).not.toBe(before.sourceIdentity.untrackedDigest);
      expect(changed.receipt.readbackDigest).toBe(after.payloadDigest);
    }
  } finally { cleanup(); }
});
