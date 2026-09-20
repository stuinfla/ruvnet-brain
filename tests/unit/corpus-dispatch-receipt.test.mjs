import { describe, expect, it } from 'vitest';
import { selectCorpusDispatch } from '../../scripts/corpus-dispatch-receipt.mjs';
const identity = { sha: 'a'.repeat(40), dispatchId: 'corpus-123-1', notBefore: '2026-09-19T20:00:00Z' };
const target = { id: 5, event: 'workflow_dispatch', head_sha: identity.sha, head_branch: 'main',
  display_title: `protected-release corpus ${identity.dispatchId}`, created_at: '2026-09-19T20:00:01Z' };
describe('nightly child correlation', () => {
  it('does not mistake a later manual run of the same SHA for its child', () => {
    const manual = { ...target, id: 6, display_title: 'protected-release', created_at: '2026-09-19T20:01:00Z' };
    expect(selectCorpusDispatch([target, manual], identity)).toEqual(target);
    expect(selectCorpusDispatch([manual], identity)).toBeNull();
  });
  it('rejects ambiguous correlation instead of picking the latest match', () => {
    expect(() => selectCorpusDispatch([target, { ...target, id: 7 }], identity)).toThrow(/multiple/);
  });
  it.each([{ event: 'schedule' }, { head_branch: 'other' }, { head_sha: 'b'.repeat(40) },
    { created_at: '2026-09-19T19:59:59Z' }])('excludes a wrong boundary %j', patch => {
    expect(selectCorpusDispatch([{ ...target, ...patch }], identity)).toBeNull();
  });
});
