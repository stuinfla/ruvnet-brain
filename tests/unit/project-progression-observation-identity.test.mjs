import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createProgressionSnapshot,
  digestCanonical,
  validateProgressionSnapshot,
  restoreProjectProgression,
} from '../../plugin/scripts/project-progression-contract.mjs';

const legacy = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '../fixtures/progression/legacy-v1-snapshot.json'), 'utf8',
));

const baseInput = {
  projectIdentity: legacy.projectIdentity,
  hostIdentity: legacy.hostIdentity,
  sessionIdentity: legacy.sessionIdentity,
  sequence: legacy.sequence,
  occurredAt: legacy.occurredAt,
  trigger: legacy.trigger,
  parentEventKeys: legacy.parentEventKeys,
  dedupId: legacy.dedupId,
  sourceIdentity: legacy.sourceIdentity,
  completeProjectState: legacy.completeProjectState,
};

function snapshot(overrides = {}) {
  return createProgressionSnapshot({
    ...baseInput,
    ...overrides,
    sourceIdentity: { ...baseInput.sourceIdentity, ...overrides.sourceIdentity },
    hostIdentity: { ...baseInput.hostIdentity, ...overrides.hostIdentity },
    completeProjectState: { ...baseInput.completeProjectState, ...overrides.completeProjectState },
  });
}

describe('observation identity', () => {
  it.each([
    ['occurredAt', { occurredAt: '2026-09-18T00:00:00.000Z' }],
    ['parents', { parentEventKeys: ['parent-b', 'parent-a'] }],
    ['source', { sourceIdentity: { head: 'b'.repeat(40) } }],
    ['adapter', { hostIdentity: { adapterVersion: '4.3.27' } }],
    ['trigger', { trigger: 'session-start' }],
    ['state', { completeProjectState: { currentGoal: 'A different durable goal' } }],
    ['provenance', { completeProjectState: { provenance: { currentGoal: { source: 'owner-note', authoritative: false } } } }],
  ])('changes key and digest when %s changes', (_field, overrides) => {
    const original = snapshot();
    const changed = snapshot(overrides);
    expect(changed.observationDigest).not.toBe(original.observationDigest);
    expect(changed.eventKey).not.toBe(original.eventKey);
    expect(changed.payloadDigest).not.toBe(original.payloadDigest);
  });

  it('canonicalizes reordered input and parent order identically', () => {
    const original = snapshot({ parentEventKeys: ['parent-a', 'parent-b'] });
    const reordered = createProgressionSnapshot(Object.fromEntries(Object.entries({ ...baseInput, parentEventKeys: ['parent-b', 'parent-a'] }).reverse()));
    expect(reordered).toEqual(original);
  });

  it('binds redacted observations while treating different raw secrets as the same safe observation', () => {
    const first = snapshot({ completeProjectState: { currentGoal: 'apiKey=first-secret-value' } });
    const second = snapshot({ completeProjectState: { currentGoal: 'apiKey=second-secret-value' } });
    const alreadyRedacted = snapshot({ completeProjectState: { currentGoal: 'apiKey=[REDACTED:api-key]' } });
    expect(first.completeProjectState.currentGoal).toBe('apiKey=[REDACTED:api-key]');
    expect(second.observationDigest).toBe(first.observationDigest);
    expect(second.eventKey).toBe(first.eventKey);
    expect(alreadyRedacted.observationDigest).toBe(first.observationDigest);
  });

  it.each([
    ['null', null], ['empty', ''], ['uppercase', 'A'.repeat(64)], ['malformed', 'not-a-digest'],
  ])('rejects %s observation digest', (_label, value) => {
    const row = { ...snapshot(), observationDigest: value };
    expect(validateProgressionSnapshot(row).ok).toBe(false);
  });

  it('rejects a digest recomputed over a body with the digest field removed', () => {
    const row = snapshot();
    const { observationDigest: omitted, ...withoutObservation } = row;
    delete withoutObservation.payloadDigest;
    const tampered = { ...withoutObservation, payloadDigest: digestCanonical(withoutObservation) };
    const verdict = validateProgressionSnapshot(tampered);
    expect(verdict.errors).toContain('event key mismatch');
    expect(verdict.errors).not.toContain('payload digest mismatch');
  });

  it('rejects body tampering even when payload digest is recomputed', () => {
    const row = snapshot();
    const tampered = { ...row, trigger: 'tampered' };
    delete tampered.payloadDigest;
    tampered.payloadDigest = digestCanonical(tampered);
    const verdict = validateProgressionSnapshot(tampered);
    expect(verdict.errors).toContain('observation digest mismatch');
    expect(verdict.errors).not.toContain('payload digest mismatch');
  });

  it('keeps legacy rows readable by default but requires the exact new observation identity when requested', () => {
    expect(legacy.eventKey).toBe('project-progress-v1-legacy-fixture-codex-legacy-session-000000000001-4a588c398e4ee099f69258b3ff4ec3fd775602da4241dd1ca15903efcf6034ea');
    expect(legacy.payloadDigest).toBe('4e92a5a4ed49fe8b9e9e7a5709fcc11141e71035a1e2d8976df6347d86f7856d');
    expect(validateProgressionSnapshot(legacy).ok).toBe(true);
    expect(validateProgressionSnapshot(legacy, { requireObservationDigest: true }).ok).toBe(false);
    const current = snapshot();
    expect(validateProgressionSnapshot(current, { requireObservationDigest: true }).ok).toBe(true);
  });

  it('restores mixed legacy and new children without deduplicating distinct observations', () => {
    const current = snapshot({ parentEventKeys: [legacy.eventKey], sequence: 2, dedupId: 'new-child' });
    const distinct = snapshot({ parentEventKeys: [legacy.eventKey], sequence: 2, dedupId: 'other-child' });
    expect(current.eventKey).not.toBe(distinct.eventKey);
    expect(current.observationDigest).not.toBe(distinct.observationDigest);
    expect(current.payloadDigest).not.toBe(distinct.payloadDigest);
    const restored = restoreProjectProgression([legacy, current, distinct]);
    expect(restored.ok).toBe(true);
    expect(restored.heads).toEqual([current.eventKey, distinct.eventKey].sort());
  });
});
