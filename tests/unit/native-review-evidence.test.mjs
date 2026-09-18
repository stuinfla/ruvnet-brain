import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeReviewEvidenceDigest, writeNativeEvidenceSidecar, readNativeCompletion } from '../../scripts/native-review-evidence.mjs';
import { bindStageContent, validateStageValue } from '../../scripts/dual-deliberation-contract.mjs';
import { digest } from '../../scripts/coverage-integrity.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const evidence = (host = 'codex') => ({ schemaVersion: 1, kind: 'ruvnet-brain-native-review-evidence', nativeHost: host, clientVersion: host === 'codex' ? 'codex-cli 0.154.0' : 'claude-code 2.1.220', requestedModel: host === 'codex' ? 'gpt-6-astra' : 'claude-fable-5-1', modelIdentityClass: 'requested-only', threadId: host === 'codex' ? 'thread-1' : null, sessionId: host === 'claude-code' ? 'session-1' : null, completionStatus: 'completed', status: 0, signal: null, startedAt: '2026-09-16T00:00:00.000Z', completedAt: '2026-09-16T00:00:01.000Z', prompt: 'review', stdout: '{"type":"turn.completed"}\n', stderr: '' });

describe('native review evidence retention', () => {
  it('canonicalizes and hashes the full transport envelope', () => {
    const first = nativeReviewEvidenceDigest(evidence());
    const reordered = { stdout: '{"type":"turn.completed"}\n', ...evidence() };
    expect(nativeReviewEvidenceDigest(reordered)).toBe(first);
    expect(nativeReviewEvidenceDigest({ ...evidence(), stdout: 'tampered' })).not.toBe(first);
  });

  it('writes a mode-0600 immutable sidecar and refuses replacement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-evidence-')); dirs.push(dir);
    const file = path.join(dir, 'receipt.native-evidence.json');
    const digest = writeNativeEvidenceSidecar(file, evidence());
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.evidenceSha256).toBe(digest);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => writeNativeEvidenceSidecar(file, evidence())).toThrow(/already exists/);
  });

  it('rejects incomplete, failed, or oversized transport evidence', () => {
    expect(() => nativeReviewEvidenceDigest({ ...evidence(), threadId: '' })).toThrow(/identity|threadId/);
    expect(() => nativeReviewEvidenceDigest({ ...evidence(), completionStatus: 'failed' })).toThrow(/completion/);
    expect(() => nativeReviewEvidenceDigest({ ...evidence(), stderr: 'x'.repeat(1_000_001) })).toThrow(/budget/);
    expect(() => nativeReviewEvidenceDigest({ ...evidence(), extra: true })).toThrow(/unknown field/);
    expect(() => nativeReviewEvidenceDigest({ ...evidence('claude-code'), threadId: 'forged' })).toThrow(/Claude identity/);
  });
});

describe('native completion boundary', () => {
  const events = [
    { type:'thread.started', thread_id:'t1' },
    { type:'item.completed', item:{ type:'agent_message', text:'{"proposal":{"decision":"one owner"}}' } },
    { type:'turn.completed' },
  ];
  const decode = rows => readNativeCompletion('codex', rows.map(row => JSON.stringify(row)).join('\n'), 'gpt-6-astra');
  it('retains session identity without inventing model observation', () => {
    expect(decode(events)).toMatchObject({ threadId:'t1', sessionId:null, observedModels:[], value:{proposal:{decision:'one owner'}} });
  });
  it.each(['error', 'turn.failed', 'turn.aborted', 'model.rerouted', 'model_reroute'])('rejects %s even alongside a completed turn', type => {
    expect(() => decode([events[0], {type}, ...events.slice(1)])).toThrow(/failed|rerouted/);
  });
  it('rejects missing, contradictory, and truncated transport', () => {
    expect(() => decode(events.slice(1))).toThrow(/thread.started/);
    expect(() => decode(events.slice(0,-1))).toThrow(/turn.completed/);
    expect(() => decode([...events, events[1]])).toThrow(/terminal/);
    expect(() => decode([events[0], {...events[1], item:{type:'agent_message', text:'"tail",]'}}, events[2]])).toThrow();
  });
  it('rejects failed Claude envelopes and observed model substitutions', () => {
    const envelope = { session_id:'s1', is_error:false, modelUsage:{'claude-fable-5-1':{}}, result:'{"findings":["retained"]}' };
    const read = row => readNativeCompletion('claude-code', JSON.stringify(row), 'claude-fable-5-1');
    expect(read(envelope).observedModels).toEqual(['claude-fable-5-1']);
    expect(read({...envelope,modelUsage:{'claude-haiku-4-5-20251001':{},...envelope.modelUsage}}).observedModels).toEqual(['claude-haiku-4-5-20251001','claude-fable-5-1']);
    expect(() => read({...envelope,is_error:true})).toThrow(/failed/);
    expect(() => read({...envelope,is_error:undefined})).toThrow(/failed/);
    expect(() => read({...envelope,type:'result'})).toThrow(/failed/);
    expect(() => read({...envelope,session_id:null})).toThrow(/identity/);
    expect(() => read({...envelope,modelUsage:{other:{}}})).toThrow(/different model/);
    expect(() => read({...envelope,result:'trailing incomplete JSON'})).toThrow();
  });
  it.each(['proposal','critique','synthesis','revise'])('computes %s identities from received content, never from model hashes', stage => {
    const key = stage === 'proposal' ? 'proposal' : stage === 'critique' ? 'findings' : 'artifact';
    const content = stage === 'critique' ? ['one issue'] : {decision:'one owner'};
    const result = bindStageContent(stage, {schemaVersion:1,stage,[key]:content,contentDigest:'fake',artifactSha256:'fake'});
    expect(result.contentDigest).toBe(digest(content));
    expect(result.artifactSha256).toBe(digest({schemaVersion:1,kind:'dual-planning-artifact',stage,content}));
    expect(() => validateStageValue(stage,result)).not.toThrow();
  });
  it.each(['verify','reverify'])('does not repair %s subject identities', stage => {
    const response = {stage,artifactSha256:'wrong-subject',contentDigest:'wrong-content'};
    expect(bindStageContent(stage,response)).toBe(response);
  });
  it('hashes new review findings while preserving the reviewed artifact identity', () => {
    const value = bindStageContent('review',{artifactSha256:'wrong-subject',contentDigest:'invented',findings:['observed']});
    expect(value.artifactSha256).toBe('wrong-subject');
    expect(value.contentDigest).toBe(digest(['observed']));
  });
});
