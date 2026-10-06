import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const folder = path.join(home, '.claude/projects/project'); fs.mkdirSync(folder, { recursive: true });
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
    await expect(captureNativeParentContext({ ...f.options, harness: 'codex', observeCodex: () => ({ sessionId: parent, evidence: { path: target, sha256: '0'.repeat(64) } }) })).rejects.toThrow(/changed/);
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
