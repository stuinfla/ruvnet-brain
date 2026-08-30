// self-retrieval-bench-hybrid-mode.test.mjs — kb/self-retrieval-bench.mjs's `KB_HYBRID=1` console
// label used to print "mode=HYBRID" even though the `searchKb()` call it measures (imported from
// forge-ask.mjs) has no KB_HYBRID gate at all — every run was dense-only regardless of the flag. That
// is a witness that cannot fail: it reports a hybrid-vs-dense comparison the script cannot actually
// run. "A guard that cannot fail is not a guard" is this repo's own stated discipline (docs/dream-
// cycle/LEDGER.md's disciplines list) — this test binds the fix: KB_HYBRID=1 must now refuse loudly
// instead of silently mislabeling.
import { describe, it, expect } from 'vitest';
import { resolveHybridMode } from '../../kb/self-retrieval-bench.mjs';

describe('kb/self-retrieval-bench.mjs refuses to claim a HYBRID mode it cannot measure', () => {
  it('KB_HYBRID unset (the common case) reports dense-only, unchanged from before tonight', () => {
    expect(resolveHybridMode({})).toBe('dense-only');
  });

  it('KB_HYBRID=0 (or any value other than "1") also reports dense-only', () => {
    expect(resolveHybridMode({ KB_HYBRID: '0' })).toBe('dense-only');
    expect(resolveHybridMode({ KB_HYBRID: 'true' })).toBe('dense-only');
  });

  it('TEETH: KB_HYBRID=1 refuses instead of printing the pre-fix false "mode=HYBRID" label', () => {
    expect(() => resolveHybridMode({ KB_HYBRID: '1' })).toThrow(/does not read KB_HYBRID/);
  });

  it('the refusal names the real reason (no live hybrid path) and points at ADR-025', () => {
    try {
      resolveHybridMode({ KB_HYBRID: '1' });
      throw new Error('expected resolveHybridMode to throw');
    } catch (err) {
      expect(err.message).toMatch(/searchKb/);
      expect(err.message).toMatch(/0025-hybrid-retrieval-and-self-retrieval-gate\.md/);
    }
  });
});
