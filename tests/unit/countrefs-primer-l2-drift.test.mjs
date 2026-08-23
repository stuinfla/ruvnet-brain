// tests/unit/countrefs-primer-l2-drift.test.mjs — scripts/build-l2.mjs and scripts/build-primer.mjs
// each hand-rolled their own copy of the citation-grounding gate (countRefs). Not found in any of
// the six prior 2026-07-07/08 coverage-gap passes (those covered build-concepts.mjs's PRIVATE_SLUGS
// duplication and build-symbols.mjs, but not this pair).
//
// WHY THIS WAS THE HIGHEST-SEVERITY GAP FOUND 2026-08-19: build-primer.mjs's own header comment
// claimed "Same proven shape as build-l2" — but the two copies had silently DIVERGED on the one
// thing that actually matters, whether ungrounded output gets rejected:
//   - build-l2.mjs (pre-fix)      accepted=false routed the article to kb/l2/rejected/ instead of
//                                   kb/l2/ — a real fail-closed gate.
//   - build-primer.mjs (pre-fix)  fs.writeFileSync ran UNCONDITIONALLY before the grounding check —
//                                   a primer that failed the exact same bar build-l2 enforced still
//                                   shipped to the live, force-routable kb/<name>-primer.md, with
//                                   zero rejection path and no retry.
// FIXED 2026-08-23 (Dream Cycle, grounding-quality): both scripts now import the shared
// countRefs/isGrounded/writeGated from scripts/lib/citation-gate.mjs. build-primer.mjs's write is
// gated on isGrounded() BEFORE fs.writeFileSync runs, exactly mirroring build-l2.mjs's existing
// accept/reject split. This file tests the shared predicate and the write-gate mechanics directly.
//
// STILL OPEN (not fixed tonight, kept to one conceptual change): build-l2.mjs's one-retry-then-
// reject loop and its per-topic (vs. build-primer's accumulated) citation scope are real script
// behaviors this file does not exercise end-to-end — that would need build-l2.mjs's own top-level
// generation loop guarded and its network calls mocked, which is a larger, separate refactor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { countRefs, isGrounded, writeGated } from '../../scripts/lib/citation-gate.mjs';

describe('countRefs(txt, candidatePaths)', () => {
  it('counts a path that appears verbatim in the text', () => {
    expect(countRefs('see `kb/forge-ask.mjs` for the ranker', ['kb/forge-ask.mjs'])).toEqual(['kb/forge-ask.mjs']);
  });

  it('counts a path whose bare basename appears in the text even when the full path does not', () => {
    expect(countRefs('implemented in `forge-ask.mjs`', ['kb/forge-ask.mjs'])).toEqual(['kb/forge-ask.mjs']);
  });

  it('does not count a path that appears nowhere in the text, verbatim or by basename', () => {
    expect(countRefs('no citations here', ['kb/forge-ask.mjs'])).toEqual([]);
  });

  it('dedups when the same path is passed twice (Set semantics)', () => {
    expect(countRefs('see `kb/forge-ask.mjs`', ['kb/forge-ask.mjs', 'kb/forge-ask.mjs'])).toEqual(['kb/forge-ask.mjs']);
  });

  it('BASENAME COLLISION: counts both candidates that share a basename when only the bare basename is cited', () => {
    const refs = countRefs('defined in `forge-ask.mjs`', ['kb/forge-ask.mjs', 'scripts/forge-ask.mjs']);
    expect(refs.sort()).toEqual(['kb/forge-ask.mjs', 'scripts/forge-ask.mjs'].sort());
  });

  it('is case-sensitive — different casing is NOT counted', () => {
    expect(countRefs('see `KB/Forge-Ask.mjs`', ['kb/forge-ask.mjs'])).toEqual([]);
  });

  it('returns an empty array, not a throw, when text is an empty string', () => {
    expect(countRefs('', ['kb/forge-ask.mjs'])).toEqual([]);
  });
});

describe('isGrounded(refs, minRefs)', () => {
  it('is true when refs meet the threshold', () => {
    expect(isGrounded(['a', 'b'], 2)).toBe(true);
  });
  it('is false when refs fall short of the threshold', () => {
    expect(isGrounded(['a'], 2)).toBe(false);
  });
  it('is true at exactly the threshold boundary', () => {
    expect(isGrounded(['a', 'b', 'c'], 3)).toBe(true);
  });
});

describe('writeGated({ liveDir, rejectedDir, filename, content, grounded })', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-gate-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('writes to liveDir when grounded, and never creates a file at the rejected path', () => {
    const liveDir = path.join(tmp, 'kb');
    const rejectedDir = path.join(tmp, 'kb', 'rejected');
    const { outPath, grounded } = writeGated({ liveDir, rejectedDir, filename: 'ruflo-primer.md', content: '# ruflo', grounded: true });
    expect(grounded).toBe(true);
    expect(outPath).toBe(path.join(liveDir, 'ruflo-primer.md'));
    expect(fs.readFileSync(outPath, 'utf8')).toBe('# ruflo');
    expect(fs.existsSync(path.join(rejectedDir, 'ruflo-primer.md'))).toBe(false);
  });

  it('REGRESSION THIS FILE EXISTS TO CATCH: a primer with zero real citations is written to rejectedDir, never to the live path', () => {
    const liveDir = path.join(tmp, 'kb');
    const rejectedDir = path.join(tmp, 'kb', 'rejected');
    const refs = countRefs('no real citations in this primer body', ['kb/forge-ask.mjs', 'kb/forge-rerank.mjs']);
    const grounded = isGrounded(refs, 6);
    const { outPath } = writeGated({ liveDir, rejectedDir, filename: 'thin-primer.md', content: 'thin', grounded });
    expect(grounded).toBe(false);
    expect(outPath).toBe(path.join(rejectedDir, 'thin-primer.md'));
    expect(fs.existsSync(path.join(liveDir, 'thin-primer.md'))).toBe(false);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('thin');
  });

  it('does not leave a stale live-path file behind: a second, ungrounded run does not touch a previously-written live file of the same name', () => {
    const liveDir = path.join(tmp, 'kb');
    const rejectedDir = path.join(tmp, 'kb', 'rejected');
    writeGated({ liveDir, rejectedDir, filename: 'ruflo-primer.md', content: '# good primer, 8 real refs', grounded: true });
    writeGated({ liveDir, rejectedDir, filename: 'ruflo-primer.md', content: '# thin rewrite, 0 real refs', grounded: false });
    expect(fs.readFileSync(path.join(liveDir, 'ruflo-primer.md'), 'utf8')).toBe('# good primer, 8 real refs');
    expect(fs.readFileSync(path.join(rejectedDir, 'ruflo-primer.md'), 'utf8')).toBe('# thin rewrite, 0 real refs');
  });
});
