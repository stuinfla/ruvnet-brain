import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  THRESHOLDS, checkNonTrivial, checkParaphraseDiffers, checkVerbatim, checkNoLeak,
  jaccard, leakyQuestionFor, ngramCoverage, normalizeWs, validateLabels,
} from '../../scripts/oracle/validate-labels.mjs';
import { gitBlobSha, sha256Hex } from '../../scripts/oracle/source-units.mjs';

/**
 * Every check gets a GREEN and a RED case. Per this repo's rule ("a test that cannot fail on broken
 * code is not a test"), the red cases are the point: each one is a label that a careless producer
 * really does emit, and each must be rejected with a named reason.
 */
const UNIT = [
  '## Retry policy',
  '',
  'The client retries a failed request up to three times. Each retry waits twice as long as the',
  'previous attempt, starting at 250 milliseconds, and the whole sequence is abandoned after the',
  'total elapsed time exceeds the configured request budget.',
].join('\n');

describe('check (a) verbatim span against the pinned unit bytes', () => {
  it('GREEN: an exact contiguous substring passes', () => {
    const r = checkVerbatim(UNIT, { span: 'starting at 250 milliseconds', spanStartLine: 4, spanEndLine: 4 });
    expect(r.pass).toBe(true);
    expect(r.reason).toBe('');
  });
  it('RED: a span the producer re-typed with collapsed whitespace is NOT verbatim, and is reported as such', () => {
    const reflowed = 'Each retry waits twice as long as the previous attempt, starting at 250 milliseconds';
    expect(UNIT.includes(reflowed)).toBe(false); // the real unit has a newline inside this sentence
    const r = checkVerbatim(UNIT, { span: reflowed, spanStartLine: 3, spanEndLine: 4 });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/whitespace normalisation/);
    expect(r.normalizedMatch).toBe(true); // the diagnostic that tells Step 15 how close it was
  });
  it('RED: an invented span that never appears in the unit fails with "not found"', () => {
    const r = checkVerbatim(UNIT, { span: 'the client retries up to five times', spanStartLine: 3, spanEndLine: 3 });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('span not found in unit');
    expect(r.normalizedMatch).toBe(false);
  });
  it('RED: an empty span fails', () => {
    expect(checkVerbatim(UNIT, { span: '', spanStartLine: 0, spanEndLine: 0 })).toMatchObject({ pass: false, reason: 'empty span' });
  });
  it('records whether the producer\'s line numbers actually point at the span', () => {
    expect(checkVerbatim(UNIT, { span: 'starting at 250 milliseconds', spanStartLine: 4, spanEndLine: 4 }).lineRangeMatch).toBe(true);
    expect(checkVerbatim(UNIT, { span: 'starting at 250 milliseconds', spanStartLine: 1, spanEndLine: 1 }).lineRangeMatch).toBe(false);
  });
});

describe('check (b) non-trivial span', () => {
  it('GREEN: a real sentence passes', () => {
    expect(checkNonTrivial(UNIT, 'The client retries a failed request up to three times.').pass).toBe(true);
  });
  it('RED: a span shorter than the character floor fails', () => {
    expect(checkNonTrivial(UNIT, 'three times')).toMatchObject({ pass: false });
    expect(checkNonTrivial(UNIT, 'three times').reason).toMatch(/chars < 40/);
  });
  it('RED: the whole unit as the span fails', () => {
    expect(checkNonTrivial(UNIT, UNIT)).toMatchObject({ pass: false, reason: 'span is the whole unit' });
  });
  it('RED: a span that is almost the whole unit fails on the fraction rule', () => {
    const almost = UNIT.slice(0, Math.floor(UNIT.length * 0.95));
    expect(checkNonTrivial(UNIT, almost).pass).toBe(false);
    expect(checkNonTrivial(UNIT, almost).reason).toMatch(/% of the unit/);
  });
  it('RED: a heading line alone fails even when it is long enough', () => {
    const headingUnit = `## A very long configuration heading indeed\n\n${'body '.repeat(40)}`;
    const r = checkNonTrivial(headingUnit, '## A very long configuration heading indeed');
    expect(r).toMatchObject({ pass: false, reason: 'span is a heading line alone' });
  });
  it('RED: a long span of punctuation has too few real tokens', () => {
    expect(checkNonTrivial(UNIT, '--------------------------------------------------').reason).toMatch(/tokens < 6/);
  });
});

describe('check (c) no answer leakage', () => {
  const span = 'The client retries a failed request up to three times.';
  it('GREEN: a genuine question that does not restate the answer passes', () => {
    const r = checkNoLeak({ question: 'How many attempts does the client make before giving up?', span, cos: 0.61 });
    expect(r.pass).toBe(true);
  });
  it('RED: a question that copies the span verbatim fails on n-gram coverage even at a low cosine', () => {
    const r = checkNoLeak({ question: `According to the text, ${span}`, span, cos: 0.1 });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/4-gram coverage/);
    expect(r.ngramCoverage).toBeGreaterThanOrEqual(THRESHOLDS.leakNgramCoverage);
  });
  it('RED: a near-duplicate question fails on cosine even when it shares no 4-gram', () => {
    const r = checkNoLeak({ question: 'Three times is the retry ceiling for one failed client request', span, cos: 0.95 });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/cosine 0\.950 >= 0\.92/);
  });
  it('the synthetic leaky question used for calibration is built from the span\'s own words', () => {
    const leaky = leakyQuestionFor(span);
    expect(ngramCoverage(leaky, span)).toBeGreaterThanOrEqual(THRESHOLDS.leakNgramCoverage);
  });
});

describe('check (d) paraphrase differs from the direct question', () => {
  const direct = 'How many times does the client retry a failed request before giving up?';
  it('GREEN: a genuine reword passes', () => {
    const r = checkParaphraseDiffers(direct, 'What is the maximum number of retry attempts for one failing call?');
    expect(r.pass).toBe(true);
  });
  it('RED: an identical paraphrase fails', () => {
    expect(checkParaphraseDiffers(direct, direct)).toMatchObject({ pass: false, reason: 'paraphrase equals direct question' });
  });
  it('RED: a paraphrase differing only in case and trailing space fails', () => {
    expect(checkParaphraseDiffers(direct, `  ${direct.toUpperCase()} `).pass).toBe(false);
  });
  it('RED: a one-word edit is above the Jaccard ceiling and fails', () => {
    const r = checkParaphraseDiffers(direct, 'How many times does the client retry a failed request before stopping?');
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/Jaccard/);
    expect(r.jaccard).toBeGreaterThan(THRESHOLDS.paraphraseMaxJaccard);
  });
  it('RED: an empty paraphrase fails', () => {
    expect(checkParaphraseDiffers(direct, '   ')).toMatchObject({ pass: false, reason: 'empty paraphrase' });
  });
});

describe('helpers', () => {
  it('jaccard and ngramCoverage behave at the edges', () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
    expect(ngramCoverage('', 'anything')).toBe(0);
    expect(normalizeWs(' a \n b ')).toBe('a b');
  });
});

describe('validateLabels end to end (stubbed embedder, real bytes on disk)', () => {
  let root;
  let blobSha;
  const rel = 'doc.md';
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-validate-'));
    fs.writeFileSync(path.join(root, rel), `# Doc\n\n${UNIT}\n`);
    blobSha = gitBlobSha(fs.readFileSync(path.join(root, rel)));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const label = (extra) => ({
    unitId: 'u1', path: rel, blobSha, startLine: 3, endLine: 7, bytesSha256: sha256Hex(Buffer.from(UNIT, 'utf8')),
    kind: 'md-section', language: 'markdown',
    direct: 'How many attempts does the client make before abandoning the request?',
    paraphrase: 'What is the ceiling on retry attempts for a single failing call?',
    span: 'The client retries a failed request up to three times.', spanStartLine: 3, spanEndLine: 3, skip: false,
    ...extra,
  });
  // Orthogonal unit vectors → cosine 0; leakage can then only be driven by the n-gram rule, which
  // keeps this test about the plumbing rather than about embedding behaviour.
  const embed = async (texts) => texts.map((_, i) => Array.from({ length: 8 }, (_, j) => (j === i % 8 ? 1 : 0)));

  it('passes a well-formed label and reports every check', async () => {
    const out = await validateLabels({ labels: { repo: 'r', commit: 'c', labels: [label()] }, snapshotDir: root, embed });
    expect(out.aggregate.total).toBe(1);
    expect(out.aggregate.pass).toBe(1);
    expect(out.perLabel[0].checks.a.pass).toBe(true);
    expect(out.aggregate.byCheck.a).toEqual({ pass: 1, fail: 0 });
  });

  it('RED: a producer error counts as a failure of every check, never as a skip', async () => {
    const out = await validateLabels({ labels: { repo: 'r', commit: 'c', labels: [label({ producerError: 'timeout' })] }, snapshotDir: root, embed });
    expect(out.aggregate.pass).toBe(0);
    expect(out.aggregate.producerErrors).toBe(1);
    for (const key of ['a', 'b', 'c', 'd']) expect(out.perLabel[0].checks[key]).toMatchObject({ pass: false, reason: 'producer error: timeout' });
  });

  it('RED: a producer-skipped unit counts as a failure', async () => {
    const out = await validateLabels({ labels: { repo: 'r', commit: 'c', labels: [label({ skip: true, skipReason: 'no askable content' })] }, snapshotDir: root, embed });
    expect(out.aggregate.pass).toBe(0);
    expect(out.aggregate.skipped).toBe(1);
    expect(out.perLabel[0].checks.a.reason).toMatch(/skipped by producer/);
  });

  it('RED: upstream drift (the file changed since the inventory) fails everything', async () => {
    const out = await validateLabels({ labels: { repo: 'r', commit: 'c', labels: [label({ blobSha: 'f'.repeat(40) })] }, snapshotDir: root, embed });
    expect(out.aggregate.pass).toBe(0);
    expect(out.perLabel[0].checks.a.reason).toMatch(/drift/);
  });

  it('RED: a label whose span is not in the unit fails check (a) while (b) and (d) can still pass', async () => {
    const out = await validateLabels({
      labels: { repo: 'r', commit: 'c', labels: [label({ span: 'The client retries a failed request up to seventeen times.' })] },
      snapshotDir: root, embed,
    });
    expect(out.aggregate.pass).toBe(0);
    expect(out.aggregate.byCheck.a).toEqual({ pass: 0, fail: 1 });
    expect(out.aggregate.byCheck.b).toEqual({ pass: 1, fail: 0 });
    expect(out.aggregate.byCheck.d).toEqual({ pass: 1, fail: 0 });
  });

  it('carries the cross-vendor verdict through and counts both-yes agreement', async () => {
    const codex = { direct: { answers: 'yes', reason: 'r' }, paraphrase: { answers: 'no', reason: 'r' } };
    const out = await validateLabels({ labels: { repo: 'r', commit: 'c', labels: [label({ codex })] }, snapshotDir: root, embed });
    expect(out.aggregate.codex).toMatchObject({ withVerdicts: 1, directYes: 1, paraphraseYes: 0, bothYes: 0 });
  });
});
