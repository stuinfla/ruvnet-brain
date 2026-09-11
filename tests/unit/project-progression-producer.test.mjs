/**
 * The producer's two contracts: every field is TRACEABLE, and nothing private is PERSISTED.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
