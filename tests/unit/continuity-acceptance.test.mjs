import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDurablyCommitted, nativeEventStructure, nativeFinalAnswer, nativeRolloutContextEvidence, nativeTerminalSuccess, runCampaign, sourceFence, withNativeFixture } from '../../scripts/continuity-acceptance.mjs';
import { digestCanonical } from '../../plugin/scripts/project-progression-contract.mjs';

describe('native continuity receipt admission', () => {
  it('uses the canonical full source identity recipe for campaign fencing', () => {
    const fence = sourceFence();
    expect(fence.recipe).toBe('git-source-bytes-v1');
    expect(fence.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(fence.files).toBeGreaterThan(100);
  });
  it('cleans a disposable fixture when injected transition work fails', async () => {
    let fixtureRoot;
    await expect(withNativeFixture('claude', `cleanup-${Date.now()}`, async (fixture) => {
      fixtureRoot = fixture.root;
      expect(fs.existsSync(fixture.root)).toBe(true);
      throw new Error('injected inspection failure');
    })).rejects.toThrow('injected inspection failure');
    expect(fixtureRoot).toBeTruthy();
    expect(fs.existsSync(fixtureRoot)).toBe(false);
  });

  it('distinguishes delivered context from repeated final nonce without retaining text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-rollout-test-'));
    const nonce = 'continuity-source-0123456789abcdef01234567';
    try {
      fs.mkdirSync(path.join(root, 'sessions'));
      fs.writeFileSync(path.join(root, 'sessions', 'synthetic.jsonl'), [
        { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: `[RuvNet Brain — PROJECT CONTINUITY RESTORED] ${nonce}` }] } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ text: `${nonce} ${nonce}` }] } },
        { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'unrelated context must never be retained' }] } },
      ].map(JSON.stringify).join('\n'));
      const evidence = nativeRolloutContextEvidence(root, nonce);
      expect(evidence.files).toBe(1);
      expect(evidence.messages.map((message) => message.nonceCount)).toEqual([1, 2, 0]);
      expect(evidence.messages[0].continuityHeader).toBe(true);
      expect(JSON.stringify(evidence)).not.toContain(nonce);
      const diagnostic = nativeRolloutContextEvidence(root, nonce, { syntheticContextText: true });
      expect(diagnostic.messages[0].syntheticContextText).toContain(nonce);
      expect(diagnostic.messages[1]).not.toHaveProperty('syntheticContextText');
      expect(JSON.stringify(diagnostic)).not.toContain('unrelated context must never be retained');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const snapshotWithDigest = JSON.parse(fs.readFileSync(new URL('../fixtures/progression/legacy-v1-snapshot.json', import.meta.url)));
  const eventKey = snapshotWithDigest.eventKey;

  it('requires the exact event, payload digest, and matching outbox readback', () => {
    expect(isDurablyCommitted(snapshotWithDigest, [{ type: 'commit', eventKey, payloadDigest: snapshotWithDigest.payloadDigest, readbackDigest: snapshotWithDigest.payloadDigest }])).toBe(true);
  });

  it('rejects a claimed commit with a mismatched or missing readback', () => {
    expect(isDurablyCommitted(snapshotWithDigest, [{ type: 'commit', eventKey, payloadDigest: 'other', readbackDigest: 'other' }])).toBe(false);
    expect(isDurablyCommitted(snapshotWithDigest, [{ type: 'commit', eventKey, payloadDigest: snapshotWithDigest.payloadDigest }])).toBe(false);
  });

  it('rejects a row from another schema even when the outbox looks valid', () => {
    expect(isDurablyCommitted({ ...snapshotWithDigest, schema: 'other' }, [{ type: 'commit', eventKey, payloadDigest: snapshotWithDigest.payloadDigest, readbackDigest: snapshotWithDigest.payloadDigest }])).toBe(false);
  });

  it('rejects a nonempty but tampered payload digest', () => {
    expect(isDurablyCommitted({ ...snapshotWithDigest, payloadDigest: 'digest-1' }, [{ type: 'commit', eventKey, payloadDigest: 'digest-1', readbackDigest: 'digest-1' }])).toBe(false);
  });

  it('rejects an incomplete schema even when its payload digest and readback agree', () => {
    const row = { schema: 'ruvnet-brain.project-progression', eventKey: 'event-prod', completeProjectState: { evidence: { workLedger: { present: true } } } };
    row.payloadDigest = digestCanonical(row);
    expect(isDurablyCommitted(row, [{ type: 'commit', eventKey: row.eventKey, payloadDigest: row.payloadDigest, readbackDigest: row.payloadDigest }])).toBe(false);
  });

  it('extracts only the final Codex agent message, ignoring echoed prompt and hook events', () => {
    const nonce = 'continuity-source-1-abcd';
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `echo ${nonce}` } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'function_call', name: 'hook', arguments: nonce } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `restored ${nonce}` } }),
    ].join('\n');
    expect(nativeFinalAnswer('codex', stream)).toBe(`restored ${nonce}`);
  });

  it('does not accept a nonce appearing only in non-final Codex output', () => {
    const nonce = 'continuity-source-1-abcd';
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `echo ${nonce}` } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    ].join('\n');
    expect(nativeFinalAnswer('codex', stream)).toBe('final answer');
    expect(nativeFinalAnswer('codex', stream)).not.toContain(nonce);
  });

  it('requires a native terminal completion envelope', () => {
    expect(nativeTerminalSuccess('codex', '{"type":"turn.completed"}')).toBe(true);
    expect(nativeTerminalSuccess('codex', '{"type":"item.completed","item":{"type":"error"}}\n{"type":"turn.completed"}')).toBe(false);
    expect(nativeTerminalSuccess('codex', '{"type":"item.completed","item":{"type":"error","message":"clamping SessionEnd hook timeout to 3s"}}\n{"type":"item.completed","item":{"type":"error","message":"Skill descriptions were shortened to fit the skills context budget."}}\n{"type":"turn.completed"}')).toBe(true);
    expect(nativeTerminalSuccess('claude', JSON.stringify({ subtype: 'success', is_error: false }))).toBe(true);
    expect(nativeTerminalSuccess('claude', JSON.stringify({ subtype: 'success', is_error: true }))).toBe(false);
  });

  it('diagnoses Codex terminal failures structurally without retaining error text', () => {
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'private output' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'error', error: { message: 'private failure' } } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    expect(nativeEventStructure('codex', stream)).toMatchObject({ turnCompleted: 1, turnFailed: 0, errorEvents: 1, lastType: 'turn.completed' });
    expect(nativeEventStructure('codex', stream)).not.toHaveProperty('errorMessages');
  });
});


describe('continuity campaign evidence accounting', () => {
  const passing = (entry) => ({ direction: `${entry.from}->${entry.to}`, index: entry.index,
    interrupted: entry.interrupted, verdict: entry.interrupted ? 'INTERRUPTED_RECOVERED' : 'PASS',
    sourceStable: true, fixture: { cleaned: true } });

  it('persists the fixed plan and completed receipts, then stops at the first failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-campaign-test-'));
    const calls = [];
    try {
      const out = path.join(root, 'receipt.json');
      const result = await runCampaign({ normal: 1, interrupted: 1, out, runTransition: async (entry) => {
        calls.push(entry);
        return { ...passing(entry), ...(calls.length === 2 ? { verdict: 'INTERRUPTED_NO_RECOVERY' } : {}) };
      } });
      expect(calls).toHaveLength(2);
      expect(result).toMatchObject({ complete: false, planned: 4, executionMode: 'injected' });
      expect(result.summary.gaps).toHaveLength(1);
      expect(result.summary.unexecuted).toHaveLength(2);
      expect(JSON.parse(fs.readFileSync(`${out}.plan.json`)).plan).toHaveLength(4);
      expect(JSON.parse(fs.readFileSync(out))).toEqual(result);
      expect(fs.readdirSync(root).sort()).toEqual(['receipt.json', 'receipt.json.case-01.json', 'receipt.json.case-02.json', 'receipt.json.plan.json']);
      await expect(runCampaign({ normal: 1, interrupted: 1, out, runTransition: async () => {
        throw new Error('must not execute when evidence already exists');
      } })).rejects.toThrow(/EEXIST/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('never promotes injected execution into native acceptance, even if every case passes', async () => {
    const result = await runCampaign({ normal: 1, interrupted: 1, runTransition: async (entry) => passing(entry) });
    expect(result.cases).toHaveLength(4);
    expect(result.summary.gaps).toEqual([]);
    expect(result.summary.unexecuted).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.executionMode).toBe('injected');
  });

  it.each([
    { verdict: 'PASS' }, { direction: 'codex->claude' }, { index: 999 },
    { interrupted: false }, { sourceStable: false }, { fixture: { cleaned: false } },
  ])('rejects a mismatched last case even when its verdict is otherwise allowed: %j', async (bad) => {
    let calls = 0;
    const result = await runCampaign({ normal: 1, interrupted: 1, runTransition: async (entry) => {
      calls++;
      return { ...passing(entry), ...(calls === 4 ? bad : {}) };
    } });
    expect(result.cases).toHaveLength(4);
    expect(result.summary.gaps).toHaveLength(1);
    expect(result.complete).toBe(false);
  });
});
