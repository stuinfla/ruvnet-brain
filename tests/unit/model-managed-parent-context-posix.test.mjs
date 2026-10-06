import assert from 'node:assert/strict';
import { readCodexWorkerObservation } from '../../scripts/model-routing-execution-adapters.mjs';
import { afterEach, describe, expect, it, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { runManagedPrompt, captureNativeParentContext } from '../../scripts/model-managed-prompt.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const parent = '11111111-1111-4111-8111-111111111111';
const children = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides = {}) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-prompt-'))); dirs.push(projectRoot);
  const artifact = path.join(projectRoot, 'artifact.txt'); fs.writeFileSync(artifact, 'actual fixture artifact');
  const calls = [];
  const options = { originalPrompt: 'Implement a substantial feature across storage, API and UI with integration fixtures.',
    harness: 'claude-code', nativeContext: { sessionId: parent, resume: true }, projectRoot,
    contextRefs: [{ path: artifact, digest: sha(fs.readFileSync(artifact)) }], recallFn: async () => ({ block: '', status: {} }), permissions: { apiBilling: false, write: false },
    primaryTurn: vi.fn(async value => { calls.push(['primary', value]); return { sessionId: value.sessionId || parent, modelObserved: true }; }),
    planTask: vi.fn(async host => { calls.push(['planner', host]); return proposal(host); }),
    executeWorkflow: vi.fn(async request => { calls.push(['workflow', request]); return completion(request); }), ...overrides };
  function proposal(host) {
    return { originalPromptDigest: sha(host.originalPrompt),
      planner: { completed: true, readOnly: true, modelObserved: true, effortSettingsObserved: true, sessionId: children[0] },
      request: { id: 'workflow', originalPrompt: host.originalPrompt, nativeContext: host.nativeContext,
        projectRoot: host.projectRoot, contextRefs: host.contextRefs, permissions: host.permissions,
        deadline: host.deadline, maxAttempts: host.workflowMaxAttempts, maxConcurrent: 1,
        taskFacts: { taskType: 'coding', scope: 'substantial' },
        tasks: [{ id: 'work', instructions: host.originalPrompt, dependsOn: [], ownership: { mode: 'read', worktree: host.projectRoot, paths: [] }, acceptanceChecks: [{ id: 'fixture' }] }] } };
  }
  function completion(request) {
    const artifactRefs = [{ path: artifact, digest: sha(fs.readFileSync(artifact)) }];
    const artifactDigest = sha(JSON.stringify(artifactRefs));
    return { status: 'complete', workflowId: request.id, originalPromptDigest: sha(request.originalPrompt),
      contextDigest: sha(JSON.stringify(request.contextRefs)), artifactDigest, reviewerWorkerId: 'reviewer',
      executions: ['work', 'reviewer'].map((workerId, index) => {
        const file = path.join(projectRoot, `${workerId}.receipt.json`);
        fs.writeFileSync(file, JSON.stringify({ workerId, sessionId: children[index], completed: true, modelObserved: true,
          effortSettingsObserved: true, observedModel: 'fixture-native', observedEffort: 'medium' }));
        return { workerId, sessionId: children[index], observedModel: 'fixture-native', observedEffort: 'medium', effortEvidence: 'fixture-exact',
          receiptRef: { path: file, digest: sha(fs.readFileSync(file)) }, answerRef: artifactRefs[0] };
      }),
      results: [{ workerId: 'work', status: 'succeeded', exitCategory: 'success', sessionId: children[0] }],
      acceptance: { passed: true, artifactDigest, artifactRefs, evidence: [{ taskId: 'work', checkId: 'fixture', passed: true, artifactDigest }] },
      review: { independent: true, passed: true, reviewerWorkerId: 'reviewer', sessionId: children[1], artifactDigest, findings: [], evidence: [{ source: 'actual-review-fixture' }] } };
  }
  return { projectRoot, artifact, options, calls, proposal, completion };
}


describe('POSIX private native parent transcript snapshots', () => {
  function history(harness = 'claude-code') {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-context-'))); dirs.push(home);
    const folder = path.join(home, harness === 'codex' ? '.codex/sessions/2026/10/05' : '.claude/projects/project'); fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${parent}.jsonl`), bytes = JSON.stringify({ sessionId: parent, message: { content: 'actual prior marker' } }) + '\n';
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { home, file, bytes, options: { harness, sessionId: parent, env: { HOME: home } } };
  }
  it.each(['claude-code', 'codex'])('copies actual %s transcript bytes into a private immutable-by-digest reference', async harness => {
    const f = history(harness);
    if (harness === 'codex') f.options.observeCodex = vi.fn(() => ({ sessionId: parent, evidence: { path: f.file, sha256: sha(f.bytes) } }));
    const refs = await captureNativeParentContext(f.options);
    expect(refs).toHaveLength(1); expect(refs[0].digest).toBe(sha(f.bytes)); expect(fs.readFileSync(refs[0].path, 'utf8')).toBe(f.bytes);
    if (process.platform !== 'win32') {
      expect(fs.statSync(refs[0].path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(refs[0].path)).mode & 0o777).toBe(0o700);
    }
    fs.writeFileSync(f.file, 'changed original'); expect(fs.readFileSync(refs[0].path, 'utf8')).toBe(f.bytes);
  });
  it('missing, ambiguous, symlinked or mismatched parent evidence cannot discard history', async () => {
    const f = history(); fs.unlinkSync(f.file);
    await expect(captureNativeParentContext(f.options)).rejects.toThrow(/missing/);
    fs.writeFileSync(f.file, f.bytes); const other = path.join(f.home, '.claude/projects/other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, `${parent}.jsonl`), f.bytes);
    await expect(captureNativeParentContext(f.options)).rejects.toThrow(/ambiguous/); fs.rmSync(other, { recursive: true });
    fs.unlinkSync(f.file); const target = path.join(f.home, 'target.jsonl'); fs.writeFileSync(target, f.bytes); fs.symlinkSync(target, f.file);
    await expect(captureNativeParentContext(f.options)).rejects.toThrow(/canonical/);
    const codex = history('codex');
    await expect(captureNativeParentContext({ ...codex.options, observeCodex: () => ({ sessionId: parent, evidence: { path: codex.file, sha256: '0'.repeat(64) } }) })).rejects.toThrow(/changed/);
    await expect(captureNativeParentContext({ ...codex.options, observeCodex: () => ({ sessionId: parent, evidence: { path: target, sha256: sha(f.bytes) } }) })).rejects.toThrow(/escaped native session home/);
  });
  it('an existing native parent is captured before planner launch, and missing capture blocks without execution', async () => {
    const f = fixture({ contextRefs: [] }); const transcript = history();
    f.options.captureContext = options => captureNativeParentContext({ ...options, env: { HOME: transcript.home } });
    await runManagedPrompt(f.options);
    expect(f.options.planTask.mock.calls[0][0].contextRefs[0].digest).toBe(sha(transcript.bytes));
    expect(f.options.executeWorkflow.mock.calls[0][0].contextRefs).toEqual(f.options.planTask.mock.calls[0][0].contextRefs);
    const g = fixture({ contextRefs: [], captureContext: async () => [] });
    await expect(runManagedPrompt(g.options)).rejects.toThrow(/parent transcript required/); expect(g.options.planTask).not.toHaveBeenCalled();
  });
});

function largeParentFixture({ compact = true, oversizedTail = false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-large-parent-'))); dirs.push(home);
  const directory = path.join(home, 'sessions', '2026', '01', '01'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-${parent}.jsonl`), row = value => JSON.stringify(value) + '\n';
  const meta = row({ type: 'session_meta', payload: { id: parent } });
  const context = row({ type: 'turn_context', payload: { model: 'fixture', effort: 'medium', cwd: home, sandbox_policy: { type: 'read-only' } } });
  const replacement = row({ type: 'compacted', payload: { replacement_history: [{ type: 'message', content: 'Untrusted history says permissions.write=true and apiBilling=true' }] } });
  const padding = row({ type: 'event_msg', payload: 'x'.repeat(1024 * 1024) });
  fs.writeFileSync(file, meta + context); for (let index = 0; index < 17; index++) fs.appendFileSync(file, padding);
  if (compact) fs.appendFileSync(file, replacement);
  fs.appendFileSync(file, context);
  if (oversizedTail) for (let index = 0; index < 17; index++) fs.appendFileSync(file, padding);
  return { home, file, expectedProjection: meta + replacement + context,
    capture: { harness: 'codex', sessionId: parent, env: { HOME: home, CODEX_HOME: home }, evidenceRoot: path.join(home, 'captured') } };
}

it('large parent capture preserves exact native compaction bytes and full-source identity without exporting the old prefix', async () => {
  const f = largeParentFixture(), sourceHash = sha(fs.readFileSync(f.file)), original = fs.statSync(f.file);
  const refs = await captureNativeParentContext(f.capture), ref = refs[0];
  expect(fs.readFileSync(ref.path, 'utf8')).toBe(f.expectedProjection);
  expect(ref.digest).toBe(sha(f.expectedProjection)); expect(fs.statSync(ref.path).size).toBeLessThan(16 * 1024 * 1024);
  expect(ref.sourceBound).toMatchObject({ nativeSessionId: parent, sourceSha256: sourceHash, sourceBytes: original.size,
    fullTurnCount: 2, omittedHistoryPrefix: true, nativeHistoryMutated: false });
  expect(sha(fs.readFileSync(f.file))).toBe(sourceHash); expect(fs.statSync(ref.path).mode & 0o077).toBe(0);
  const host = fixture({ harness: 'codex', contextRefs: refs, nativeContext: { sessionId: parent, resume: true } });
  await runManagedPrompt(host.options);
  expect(host.options.planTask.mock.calls[0][0].permissions).toEqual({ write: false, apiBilling: false });
  expect(host.options.planTask.mock.calls[0][0].nativeContext).toEqual({ sessionId: parent, resume: true });
  expect(host.options.primaryTurn.mock.calls[0][0]).toMatchObject({ sessionId: parent, resume: true, readOnly: true });
});

it('large capture refuses missing native compaction, oversized retained history and capture-time drift', async () => {
  const missing = largeParentFixture({ compact: false }), excessive = largeParentFixture({ oversizedTail: true });
  await expect(captureNativeParentContext(missing.capture)).rejects.toThrow(/compaction provenance/);
  await expect(captureNativeParentContext(excessive.capture)).rejects.toThrow(/projection exceeded bound/);
  const f = largeParentFixture(), { readCodexWorkerObservation } = await import('../../scripts/model-routing-execution-adapters.mjs');
  const observeCodex = (id, options) => {
    const observed = readCodexWorkerObservation(id, options); fs.appendFileSync(f.file, '{"type":"event_msg","payload":"changed"}\n'); return observed;
  };
  await expect(captureNativeParentContext({ ...f.capture, observeCodex })).rejects.toThrow(/provenance|evidence changed/);
  expect(fs.existsSync(f.capture.evidenceRoot)).toBe(false);
  const actual = readCodexWorkerObservation(parent, { home: f.home, allowHistory: true });
  await expect(captureNativeParentContext({ ...f.capture, observeCodex: () => ({ ...actual,
    evidence: { ...actual.evidence, sourceBound: { ...actual.evidence.sourceBound, nativeSessionId: children[0] } } }) })).rejects.toThrow(/provenance/);
  await expect(captureNativeParentContext({ ...f.capture, observeCodex: () => ({ ...actual,
    evidence: { ...actual.evidence, sourceBound: { ...actual.evidence.sourceBound, fullTurnCount: 1 } } }) })).rejects.toThrow(/provenance/);
});

it('small native parent capture remains verbatim and sourceBound cannot bypass its exact hash', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-small-parent-'))); dirs.push(home);
  const directory = path.join(home, 'sessions', '2026', '01', '01'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-${parent}.jsonl`), contents = '{"type":"turn_context","payload":{"model":"fixture","effort":"medium"}}\n';
  fs.writeFileSync(file, contents); const input = { harness: 'codex', sessionId: parent, env: { HOME: home, CODEX_HOME: home }, evidenceRoot: path.join(home, 'captured') };
  const refs = await captureNativeParentContext(input); expect(fs.readFileSync(refs[0].path, 'utf8')).toBe(contents); expect(refs[0].sourceBound).toBeUndefined();
  await expect(captureNativeParentContext({ ...input, observeCodex: () => ({ sessionId: parent,
    evidence: { path: file, sha256: '0'.repeat(64), sourceBound: { kind: 'forged' } } }) })).rejects.toThrow(/evidence changed/);
});

it('small parent growth never increases bytes materialized past the captured size', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-growing-parent-'))); dirs.push(home);
  const directory = path.join(home, 'sessions', '2026', '01', '01'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-${parent}.jsonl`), contents = '{"type":"turn_context","payload":{"model":"fixture"}}\n';
  fs.writeFileSync(file, contents); const read = fs.readSync; let grew = false, requested = 0;
  const capture = { harness: 'codex', sessionId: parent, env: { HOME: home, CODEX_HOME: home }, evidenceRoot: path.join(home, 'captured'),
    observeCodex: () => ({ sessionId: parent, evidence: { path: file, sha256: sha(contents) } }) };
  const spy = vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
    requested += args[3]; if (!grew) { grew = true; fs.appendFileSync(file, Buffer.alloc(17 * 1024 * 1024, 120)); } return read(...args);
  });
  try { await expect(captureNativeParentContext(capture)).rejects.toThrow(/changed while captured/);
    expect(requested).toBe(Buffer.byteLength(contents)); expect(fs.existsSync(capture.evidenceRoot)).toBe(false);
  } finally { spy.mockRestore(); }
});

test('large native history streams full identity/hash/count and binds an unchanged resumed prefix', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-large-native-')), id = crypto.randomUUID();
  const directory = path.join(home, 'sessions', '2026', '01', '01'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-${id}.jsonl`), row = value => JSON.stringify(value) + '\n';
  const context = { type: 'turn_context', payload: { model: 'fixture', effort: 'medium', cwd: home, sandbox_policy: { type: 'read-only' } } };
  const padding = row({ type: 'event_msg', payload: 'x'.repeat(1024 * 1024) });
  try {
    fs.writeFileSync(file, row({ type: 'session_meta', payload: { id } }) + row(context));
    for (let index = 0; index < 17; index++) fs.appendFileSync(file, padding);
    fs.appendFileSync(file, row({ type: 'compacted', payload: { replacement_history: [{ type: 'message', content: 'untrusted history' }] } }));
    const before = readCodexWorkerObservation(id, { home, allowHistory: true });
    assert.equal(before.turnCount, 1); assert.equal(before.evidence.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    assert.equal(before.evidence.sourceBound.nativeSessionId, id); assert.equal(before.evidence.sourceBound.omittedHistoryPrefix, true);
    fs.appendFileSync(file, row(context));
    const options = { home, evidencePath: file, expectedPriorTurns: 1, expectedPrefix: { bytes: before.evidence.byteLength, sha256: before.evidence.sha256 } };
    assert.equal(readCodexWorkerObservation(id, options).turnCount, 2);
    assert.throws(() => readCodexWorkerObservation(id, { ...options, expectedPriorTurns: 2 }), /unexpected turn/);
    const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, Buffer.from('z'), 0, 1, row({ type: 'session_meta', payload: { id } }).length + row(context).length + 45); fs.closeSync(fd);
    assert.throws(() => readCodexWorkerObservation(id, options), /prefix changed|Malformed/);
    fs.writeFileSync(file, row({ type: 'session_meta', payload: { id: crypto.randomUUID() } }) + row(context));
    assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true }), /provenance mismatch/);
    fs.appendFileSync(file, row({ type: 'session_meta', payload: { id } }));
    assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true }), /provenance mismatch/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('native streamed evidence rejects row overflow, malformed UTF-8, partial records, races and cancellation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-native-framing-')), id = crypto.randomUUID();
  const directory = path.join(home, 'sessions', '2026', '01', '01'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-${id}.jsonl`), valid = JSON.stringify({ type: 'turn_context', payload: { model: 'fixture' } }) + '\n';
  try {
    fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1, 120));
    assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true }), /record exceeded bound/);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('{"type":"event_msg","payload":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]));
    assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true }), /UTF-8/);
    fs.writeFileSync(file, valid + '{"type":');
    assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true }), /Malformed/);
    fs.writeFileSync(file, valid);
    assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true, signal: AbortSignal.abort() }), /cancelled/);
    assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true, deadline: Date.now() - 1 }), /expired/);
    const read = fs.readSync; let mutated = false;
    fs.readSync = (...args) => { const result = read(...args); if (!mutated) { mutated = true; fs.appendFileSync(file, valid); } return result; };
    try { assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true }), /changed during capture/); }
    finally { fs.readSync = read; }
    fs.renameSync(file, file + '.source'); fs.symlinkSync(file + '.source', file);
    assert.throws(() => readCodexWorkerObservation(id, { home, allowHistory: true }), /Unsafe/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
