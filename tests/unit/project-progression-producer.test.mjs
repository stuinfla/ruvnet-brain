/**
 * The producer's two contracts: every field is TRACEABLE, and nothing private is PERSISTED.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createProgressionSnapshot, restoreProjectProgression } from '../../plugin/scripts/project-progression-contract.mjs';
import { expectedSchemaFingerprint } from '../../plugin/scripts/project-progression-reader.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DERIVED_TEXT_LIMIT,
  readOwnerNote,
  readSourceIdentity,
  readTranscriptReference,
  readWorkLedger,
} from '../../plugin/scripts/project-progression-sources.mjs';
import { PROVENANCE_SOURCES, buildProjectProgression } from '../../plugin/scripts/project-progression-producer.mjs';

const roots = [];
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
      .toMatch(/transcript format unknown for host codex/);
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
        user: 'Use sk-proj-ABCDEF1234567890 and password=hunter2 and password="alpha beta" and token="gamma delta" now.',
        assistant: 'Authorization: Bearer abcdef0123456789 is the token I used and will keep using.',
      })),
      host: 'claude',
      env: { RUVNET_WORK_LEDGER: path.join(temporaryRoot('noledger-'), 'absent.json') },
      now: () => '2026-09-11T00:00:00.000Z',
    });
    const serialized = JSON.stringify(produced);
    for (const secret of ['sk-proj-ABCDEF1234567890', 'hunter2', 'abcdef0123456789', 'alpha', 'beta', 'gamma', 'delta']) {
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


describe('durable state survives later automatic captures', () => {
  function scenario() {
    const resolution = resolutionFixture();
    const ledgerFile = path.join(temporaryRoot(), 'work.json');
    fs.writeFileSync(ledgerFile, JSON.stringify({ items: [
      { text: 'completed change', done: true }, { text: 'remaining change', done: false },
    ], objective: { text: 'finish the work', state: 'active' } }));
    const options = { resolution, env: { RUVNET_WORK_LEDGER: ledgerFile }, host: 'claude',
      payload: { session_id: 'source', hook_event_name: 'Stop' }, now: () => '2026-09-17T00:00:00.000Z' };
    const produced = buildProjectProgression(options).projectProgression;
    Object.assign(produced.completeProjectState, {
      blockers: ['await review'], failures: ['previous run failed'], commands: ['npm test'],
      proofArtifacts: ['receipt-1'], untested: ['real host'], customContext: { reason: 'keep this' },
    });
    const snapshot = createProgressionSnapshot({ ...produced, projectIdentity: resolution.projectIdentity,
      hostIdentity: { host: 'claude', adapterVersion: 'test' }, sessionIdentity: 'source', trigger: 'Stop' });
    // Only the throwaway unit-test store is written directly, never project memory.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(resolution.canonicalAgentDbPath);
    db.exec(`CREATE TABLE memory_entries (${expectedSchemaFingerprint().columns.map(x => `"${x}" TEXT`).join(',')})`);
    const insert = db.prepare('INSERT INTO memory_entries (key, namespace, content, status) VALUES (?, ?, ?, ?)');
    insert.run(snapshot.eventKey, 'project-progression', JSON.stringify(snapshot), 'active');
    return { resolution, ledgerFile, options, snapshot, db, insert };
  }

  it('rejects a valid snapshot stored under a different exact key', () => {
    const fx = scenario();
    fx.db.prepare('UPDATE memory_entries SET key=?').run('unrelated-stored-key');
    fx.db.close();
    expect(() => buildProjectProgression(fx.options)).toThrow(/exact key\/payload identity mismatch/);
  });

  it('preserves explicit cleared goals and decisions despite a newer contextual note', () => {
    const fx = scenario();
    const body = { ...fx.snapshot, dedupId: 'cleared', completeProjectState: {
      ...fx.snapshot.completeProjectState, currentGoal: null, nextAction: null, decisions: [],
      provenance: { ...fx.snapshot.completeProjectState.provenance,
        currentGoal: { source: 'model-checkpoint', authoritative: false },
        nextAction: { source: 'model-checkpoint', authoritative: false },
        decisions: { source: 'model-checkpoint', authoritative: false } },
    } };
    const cleared = createProgressionSnapshot(body);
    fx.db.prepare('DELETE FROM memory_entries').run();
    fx.insert.run(cleared.eventKey, 'project-progression', JSON.stringify(cleared), 'active');
    fx.insert.run('project-state-current-9', 'default', 'Old goal that must remain cleared.', 'active');
    fx.db.close(); fs.unlinkSync(fx.ledgerFile);
    const output = buildProjectProgression(fx.options).projectProgression.completeProjectState;
    expect(output.currentGoal).toBeNull(); expect(output.nextAction).toBeNull();
    expect(output.decisions).toEqual([]);
    for (const field of ['currentGoal', 'nextAction', 'decisions']) {
      expect(output.provenance[field]).toMatchObject({ source: 'prior-head', authoritative: false, origin: 'model-checkpoint' });
    }
  });

  it('carries the complete prior work and evidence after its original ledger disappears', () => {
    const fx = scenario(); fx.db.close(); fs.unlinkSync(fx.ledgerFile);
    const output = buildProjectProgression({ ...fx.options, host: 'codex', payload: { session_id: 'destination', hook_event_name: 'Stop' } });
    const state = output.projectProgression.completeProjectState;
    for (const field of ['currentGoal', 'nextAction', 'plan', 'completed', 'inProgress', 'decisions',
      'blockers', 'failures', 'commands', 'proofArtifacts', 'untested', 'customContext']) {
      expect(state[field], field).toEqual(fx.snapshot.completeProjectState[field]);
    }
    for (const field of ['plan', 'completed', 'inProgress', 'decisions']) expect(state.provenance[field].source).toBe('prior-head');
    expect(output.projectProgression.parentEventKeys).toEqual([fx.snapshot.eventKey]);
    expect(state.evidence.workLedger.present).toBe(false);
    expect(state.evidence.lastKnownInputs.workLedger).toEqual(fx.snapshot.completeProjectState.evidence.workLedger);
  });

  it('retains provenance for preserved checkpoint fields and readable ledger plan text', () => {
    const fx = scenario();
    expect(fx.snapshot.completeProjectState.plan[0]).toMatchObject({ text: 'remaining change', status: 'open' });
    const carried = createProgressionSnapshot({ ...fx.snapshot, completeProjectState: {
      ...fx.snapshot.completeProjectState, acceptanceContract: { required: ['real host verification'] },
      provenance: { ...fx.snapshot.completeProjectState.provenance,
        acceptanceContract: { source: 'model-checkpoint', authoritative: false },
        proofArtifacts: { source: 'model-checkpoint', authoritative: false },
      },
    } });
    fx.db.prepare('UPDATE memory_entries SET key=?, content=? WHERE key=?').run(carried.eventKey, JSON.stringify(carried), fx.snapshot.eventKey);
    fx.db.close(); fs.unlinkSync(fx.ledgerFile);
    const state = buildProjectProgression(fx.options).projectProgression.completeProjectState;
    for (const field of ['acceptanceContract', 'proofArtifacts']) {
      expect(state[field]).toEqual(carried.completeProjectState[field]);
      expect(state.provenance[field]).toEqual(carried.completeProjectState.provenance[field]);
    }
  });

  it('does not treat an agent-authored owner note as user authorization', () => {
    const fx = scenario();
    fx.db.prepare('DELETE FROM memory_entries WHERE namespace=?').run('project-progression');
    fx.insert.run('project-state-current-1', 'default', 'contextual operator narrative', 'active');
    fx.db.close(); fs.unlinkSync(fx.ledgerFile);
    const state = buildProjectProgression(fx.options).projectProgression.completeProjectState;
    expect(state.currentGoal).toBe('contextual operator narrative');
    expect(state.nextAction).toBeNull();
    for (const field of ['currentGoal', 'decisions']) {
      expect(state.provenance[field]).toEqual({ source: 'owner-note', authoritative: false });
    }
  });

  it('retains durable decisions when a contextual owner note remains available', () => {
    const fx = scenario();
    fx.insert.run('project-state-current-1', 'default', 'a different narrative', 'active');
    fx.db.close(); fs.unlinkSync(fx.ledgerFile);
    const state = buildProjectProgression(fx.options).projectProgression.completeProjectState;
    expect(state.decisions).toEqual(fx.snapshot.completeProjectState.decisions);
    expect(state.evidence.ownerNote.key).toBe('project-state-current-1');
    expect(state.evidence.priorCapture).toEqual({ eventKey: fx.snapshot.eventKey, payloadDigest: fx.snapshot.payloadDigest });
  });

  it('does not promote a carried transcript-derived goal to authoritative work', () => {
    const fx = scenario();
    const inferred = createProgressionSnapshot({ ...fx.snapshot,
      completeProjectState: { ...fx.snapshot.completeProjectState, provenance: {
        ...fx.snapshot.completeProjectState.provenance, currentGoal: { source: 'transcript-derived', authoritative: false },
      } },
    });
    fx.db.prepare('UPDATE memory_entries SET key=?, content=? WHERE key=?').run(inferred.eventKey, JSON.stringify(inferred), fx.snapshot.eventKey);
    fx.db.close(); fs.unlinkSync(fx.ledgerFile);
    const state = buildProjectProgression(fx.options).projectProgression.completeProjectState;
    expect(state.provenance.currentGoal).toEqual({ source: 'prior-head', authoritative: false, origin: 'transcript-derived' });
  });

  it('refuses an unreadable existing history instead of producing a parentless successor', () => {
    const fx = scenario(); fx.db.exec('ALTER TABLE memory_entries ADD COLUMN unexpected TEXT'); fx.db.close();
    expect(() => buildProjectProgression(fx.options)).toThrow(/progression store unreadable/);
  });

  it('refuses malformed or digest-invalid history instead of silently discarding it', () => {
    const fx = scenario();
    fx.db.prepare('UPDATE memory_entries SET content=?').run('{invalid'); fx.db.close();
    expect(() => buildProjectProgression(fx.options)).toThrow(/malformed snapshot/);
  });

  it('redacts truncated private keys and avoids slicing secret-bearing plan identifiers', () => {
    const ledgerFile = path.join(temporaryRoot(), 'ledger.json');
    fs.writeFileSync(ledgerFile, JSON.stringify({ items: [
      { text: '-----BEGIN PRIVATE KEY-----\nSENSITIVEPARTIALMATERIAL', done: false },
    ] }));
    const produced = buildProjectProgression({ resolution: resolutionFixture(), env: { RUVNET_WORK_LEDGER: ledgerFile } });
    expect(JSON.stringify(produced)).not.toContain('SENSITIVEPARTIALMATERIAL');
    expect(produced.projectProgression.completeProjectState.plan[0].id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('captures new transcript evidence even when the durable goal and tree do not change', () => {
    const fx = scenario(); fx.db.close();
    expect(buildProjectProgression(fx.options).skipped?.reason).toMatch(/no-op capture/);
    const produced = buildProjectProgression({ ...fx.options, payload: {
      ...fx.options.payload, transcript_path: transcriptFixture({ user: 'unchanged goal evidence', assistant: 'another observation' }),
    } });
    expect(produced.skipped).toBeUndefined();
    expect(produced.projectProgression.completeProjectState.currentGoal).toBe(fx.snapshot.completeProjectState.currentGoal);
    expect(produced.projectProgression.completeProjectState.evidence.transcript.excerptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honors an explicitly empty ledger without reviving previously open work', () => {
    const fx = scenario(); fx.db.close();
    fs.writeFileSync(fx.ledgerFile, JSON.stringify({ items: [] }));
    const state = buildProjectProgression(fx.options).projectProgression.completeProjectState;
    expect(state.currentGoal).toBeNull(); expect(state.nextAction).toBeNull();
    expect(state.plan).toEqual([]); expect(state.inProgress).toEqual([]); expect(state.completed).toEqual([]);
    expect(state.decisions).toEqual(fx.snapshot.completeProjectState.decisions);
  });

  it('does not silently consume conflicting heads with an empty automatic successor', () => {
    const fx = scenario();
    const sibling = createProgressionSnapshot({ ...fx.snapshot, sessionIdentity: 'parallel', dedupId: 'parallel',
      completeProjectState: { ...fx.snapshot.completeProjectState, currentGoal: 'different task' } });
    fx.insert.run(sibling.eventKey, 'project-progression', JSON.stringify(sibling), 'active'); fx.db.close();
    fs.unlinkSync(fx.ledgerFile);
    const output = buildProjectProgression(fx.options);
    expect(output.skipped?.reason).toMatch(/concurrent progression heads/);
    expect(output.projectProgression).toBeNull();
    const restored = restoreProjectProgression([fx.snapshot, sibling], { expectedProjectIdentity: fx.resolution.projectIdentity });
    expect(restored.heads).toHaveLength(2); expect(restored.state.resumeConflicts.some(x => x.field === 'currentGoal')).toBe(true);
  });
});
