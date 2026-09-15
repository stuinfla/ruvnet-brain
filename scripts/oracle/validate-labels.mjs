#!/usr/bin/env node
/**
 * scripts/oracle/validate-labels.mjs — Step 14 (ADR-086 C3) deterministic label validation.
 *
 * NO LLM. Every produced label is checked against exact upstream bytes re-read from disk:
 *   (a) verbatim  — the span is an exact substring of the unit text at the pinned blob SHA (the blob is
 *                   re-hashed; drift fails everything). Diagnostics record whether the span would have
 *                   matched after whitespace normalisation, and whether the producer's line range points
 *                   at the same text — the two facts that decide the Step 15 span-binding design.
 *   (b) non-trivial — ≥ 40 chars and ≥ 6 tokens, not the whole unit (≤ 90% of it), not a heading alone.
 *   (c) no leakage  — neither question restates the answer: bge-base cosine(question, span) < 0.92 AND
 *                   4-gram coverage of the question by the span < 0.5. The 0.92 bound is calibrated in
 *                   the run itself: synthetic leaky questions built from the span's own words are
 *                   embedded and their cosine distribution is reported next to the real one.
 *   (d) paraphrase differs — token Jaccard(direct, paraphrase) ≤ 0.7 and not equal after normalisation.
 *   (e) informational, not scored — cosine(direct, paraphrase) ≥ 0.70 (a paraphrase that drifted).
 * Labels the producer skipped or failed on FAIL every check: errors count as failures (Dual threshold).
 *
 * The embedder is the local ONNX Xenova/bge-base-en-v1.5 already cached for the KB (768-dim, cls
 * pooling, normalised) — no network. If it is not cached the validator refuses rather than downloads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlobSha, sha256Hex, unitText } from './source-units.mjs';

export const THRESHOLDS = Object.freeze({
  minSpanChars: 40, minSpanTokens: 6, maxSpanFractionOfUnit: 0.9,
  leakCosine: 0.92, leakNgramCoverage: 0.5, ngram: 4,
  paraphraseMaxJaccard: 0.7, paraphraseMinCosine: 0.70,
});

export const normalizeWs = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const tokens = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9_]+/g) || [];
export function jaccard(a, b) {
  const A = new Set(a); const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
export function ngramCoverage(question, span, n = THRESHOLDS.ngram) {
  const q = tokens(question); const s = tokens(span);
  if (q.length < n) return q.length && q.every((t) => s.includes(t)) ? 1 : 0;
  const grams = new Set();
  for (let i = 0; i + n <= s.length; i++) grams.add(s.slice(i, i + n).join(' '));
  let hit = 0; let total = 0;
  for (let i = 0; i + n <= q.length; i++) { total++; if (grams.has(q.slice(i, i + n).join(' '))) hit++; }
  return total ? hit / total : 0;
}
export function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const isHeadingLine = (line) => /^\s*#{1,6}\s/.test(line);

export function checkVerbatim(unit, label) {
  const span = String(label.span ?? '');
  const pass = span.length > 0 && unit.includes(span);
  const normalizedMatch = span.length > 0 && normalizeWs(unit).includes(normalizeWs(span));
  const lines = unit.split('\n');
  const s = label.spanStartLine; const e = label.spanEndLine;
  let lineRangeMatch = false;
  if (Number.isInteger(s) && Number.isInteger(e) && s >= 1 && e >= s && e <= lines.length) {
    // CONTAINMENT, not Jaccard: a short span inside a long line is a correct line reference, and
    // Jaccard would score it ~0.27 purely because the line has other words on it.
    const rangeTokens = new Set(tokens(lines.slice(s - 1, e).join('\n')));
    const spanTokens = tokens(span);
    lineRangeMatch = spanTokens.length > 0 && spanTokens.filter((t) => rangeTokens.has(t)).length / spanTokens.length >= 0.8;
  }
  return { pass, reason: pass ? '' : span.length === 0 ? 'empty span' : normalizedMatch ? 'not verbatim (matches after whitespace normalisation)' : 'span not found in unit', normalizedMatch, lineRangeMatch };
}

export function checkNonTrivial(unit, span, t = THRESHOLDS) {
  span = String(span ?? '');
  const toks = tokens(span);
  if (span.length < t.minSpanChars) return { pass: false, reason: `span ${span.length} chars < ${t.minSpanChars}` };
  if (toks.length < t.minSpanTokens) return { pass: false, reason: `span ${toks.length} tokens < ${t.minSpanTokens}` };
  if (normalizeWs(span) === normalizeWs(unit)) return { pass: false, reason: 'span is the whole unit' };
  if (span.length > t.maxSpanFractionOfUnit * unit.length) return { pass: false, reason: `span is ${Math.round((100 * span.length) / unit.length)}% of the unit` };
  const contentLines = span.split('\n').filter((l) => l.trim());
  if (contentLines.length && contentLines.every((l) => isHeadingLine(l))) return { pass: false, reason: 'span is a heading line alone' };
  return { pass: true, reason: '' };
}

export function checkNoLeak({ question, span, cos }, t = THRESHOLDS) {
  const coverage = ngramCoverage(question, span, t.ngram);
  const reasons = [];
  if (cos >= t.leakCosine) reasons.push(`cosine ${cos.toFixed(3)} >= ${t.leakCosine}`);
  if (coverage >= t.leakNgramCoverage) reasons.push(`${t.ngram}-gram coverage ${coverage.toFixed(2)} >= ${t.leakNgramCoverage}`);
  return { pass: reasons.length === 0, reason: reasons.join('; '), cosine: cos, ngramCoverage: coverage };
}

export function checkParaphraseDiffers(direct, paraphrase, t = THRESHOLDS) {
  if (!normalizeWs(paraphrase)) return { pass: false, reason: 'empty paraphrase', jaccard: 0 };
  if (normalizeWs(direct).toLowerCase() === normalizeWs(paraphrase).toLowerCase()) return { pass: false, reason: 'paraphrase equals direct question', jaccard: 1 };
  const j = jaccard(tokens(direct), tokens(paraphrase));
  return { pass: j <= t.paraphraseMaxJaccard, reason: j <= t.paraphraseMaxJaccard ? '' : `token Jaccard ${j.toFixed(2)} > ${t.paraphraseMaxJaccard}`, jaccard: j };
}

function readUnit(snapshotDir, label, cache) {
  if (!cache.has(label.path)) {
    let buf;
    try { buf = fs.readFileSync(path.join(snapshotDir, label.path)); } catch { cache.set(label.path, null); return null; }
    cache.set(label.path, { blobSha: gitBlobSha(buf), lines: buf.toString('utf8').split('\n') });
  }
  const file = cache.get(label.path);
  if (!file || file.blobSha !== label.blobSha) return null;
  const text = unitText(file.lines, label.startLine, label.endLine);
  return sha256Hex(Buffer.from(text, 'utf8')) === label.bytesSha256 ? text : null;
}

const failAll = (reason) => ({ a: { pass: false, reason }, b: { pass: false, reason }, c: { pass: false, reason }, d: { pass: false, reason } });
const quantiles = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null);
  return { n: s.length, min: q(0), p10: q(0.1), p50: q(0.5), p90: q(0.9), max: q(1) };
};

/** Synthetic leaky question: the span's own first 20 tokens — what a lazy producer would emit. */
export const leakyQuestionFor = (span) => `According to the text, ${tokens(span).slice(0, 20).join(' ')}?`;

export async function validateLabels({ labels, snapshotDir, embed, thresholds = THRESHOLDS }) {
  const cache = new Map();
  const rows = labels.labels.map((label) => ({ label, unit: label.producerError || label.skip ? null : readUnit(snapshotDir, label, cache) }));
  const live = rows.filter((r) => r.unit !== null);
  const texts = [];
  const index = (t) => { texts.push(t); return texts.length - 1; };
  for (const r of live) r.emb = { d: index(r.label.direct), p: index(r.label.paraphrase), s: index(r.label.span), leak: index(leakyQuestionFor(r.label.span)) };
  const vectors = texts.length ? await embed(texts) : [];
  const perLabel = [];
  const leakyCos = [];
  const directCos = [];
  const paraCos = [];
  for (const { label, unit, emb } of rows) {
    if (label.producerError) { perLabel.push({ unitId: label.unitId, path: label.path, pass: false, checks: failAll(`producer error: ${label.producerError}`) }); continue; }
    if (label.skip) { perLabel.push({ unitId: label.unitId, path: label.path, pass: false, checks: failAll(`skipped by producer: ${label.skipReason}`) }); continue; }
    if (unit === null) { perLabel.push({ unitId: label.unitId, path: label.path, pass: false, checks: failAll('blob or unit drift: upstream bytes differ from the inventory') }); continue; }
    const v = (i) => vectors[i];
    const a = checkVerbatim(unit, label);
    const b = checkNonTrivial(unit, label.span, thresholds);
    const cd = checkNoLeak({ question: label.direct, span: label.span, cos: cosine(v(emb.d), v(emb.s)) }, thresholds);
    const cp = checkNoLeak({ question: label.paraphrase, span: label.span, cos: cosine(v(emb.p), v(emb.s)) }, thresholds);
    const c = { pass: cd.pass && cp.pass, reason: [cd.reason && `direct: ${cd.reason}`, cp.reason && `paraphrase: ${cp.reason}`].filter(Boolean).join('; '), direct: cd, paraphrase: cp };
    const d = checkParaphraseDiffers(label.direct, label.paraphrase, thresholds);
    const eCos = cosine(v(emb.d), v(emb.p));
    const e = { pass: eCos >= thresholds.paraphraseMinCosine, cosine: eCos, reason: eCos >= thresholds.paraphraseMinCosine ? '' : `cosine(direct, paraphrase) ${eCos.toFixed(3)} < ${thresholds.paraphraseMinCosine}` };
    leakyCos.push(cosine(v(emb.leak), v(emb.s)));
    directCos.push(cd.cosine);
    paraCos.push(cp.cosine);
    // Role-neutral judge verdicts: path B (2026-09-14) lets claude judge, so read `judge` and fall back to
    // the historical codex-shaped record. `codex` is still carried unchanged for existing consumers.
    const judge = label.judge ?? (label.codex ? { host: 'codex', ...label.codex } : undefined);
    perLabel.push({ unitId: label.unitId, path: label.path, kind: label.kind, pass: a.pass && b.pass && c.pass && d.pass, checks: { a, b, c, d }, informational: { e }, codex: label.codex, judge });
  }
  const count = (key) => ({ pass: perLabel.filter((r) => r.checks[key].pass).length, fail: perLabel.filter((r) => !r.checks[key].pass).length });
  const codexVerdicts = perLabel.filter((r) => r.codex && !r.codex.error);
  const yes = (side) => codexVerdicts.filter((r) => r.codex[side]?.answers === 'yes').length;
  return {
    schemaVersion: 1, kind: 'oracle-validation', repo: labels.repo, commit: labels.commit, thresholds,
    aggregate: {
      total: perLabel.length, pass: perLabel.filter((r) => r.pass).length,
      producerErrors: rows.filter((r) => r.label.producerError).length, skipped: rows.filter((r) => r.label.skip).length,
      byCheck: { a: count('a'), b: count('b'), c: count('c'), d: count('d') },
      informationalE: { pass: perLabel.filter((r) => r.informational?.e.pass).length, evaluated: perLabel.filter((r) => r.informational).length },
      secondary: {
        whitespaceNormalizedMatch: perLabel.filter((r) => r.checks.a.normalizedMatch).length,
        lineRangeMatch: perLabel.filter((r) => r.checks.a.lineRangeMatch).length,
        verbatimOrNormalized: perLabel.filter((r) => r.checks.a.pass || r.checks.a.normalizedMatch).length,
      },
      codex: {
        withVerdicts: codexVerdicts.length, directYes: yes('direct'), paraphraseYes: yes('paraphrase'),
        bothYes: codexVerdicts.filter((r) => r.codex.direct?.answers === 'yes' && r.codex.paraphrase?.answers === 'yes').length,
        bothYesAndAllChecksPass: codexVerdicts.filter((r) => r.pass && r.codex.direct?.answers === 'yes' && r.codex.paraphrase?.answers === 'yes').length,
      },
      // Whichever host judged. `allThreeYes` also requires the pair-equivalence verdict Dual required:
      // two supported questions are not proof the paraphrase means the same thing.
      judge: (() => {
        const judged = perLabel.filter((r) => r.judge && !r.judge.error && !r.judge.direct?.error);
        const yesOn = (side) => judged.filter((r) => r.judge[side]?.answers === 'yes').length;
        const allThree = (r) => ['direct', 'paraphrase', 'equivalent'].every((side) => r.judge[side]?.answers === 'yes');
        return {
          hosts: [...new Set(judged.map((r) => r.judge.host))], withVerdicts: judged.length,
          directYes: yesOn('direct'), paraphraseYes: yesOn('paraphrase'), equivalentYes: yesOn('equivalent'),
          allThreeYes: judged.filter(allThree).length, allThreeYesAndAllChecksPass: judged.filter((r) => r.pass && allThree(r)).length,
        };
      })(),
      cosineCalibration: { directVsSpan: quantiles(directCos), paraphraseVsSpan: quantiles(paraCos), syntheticLeakyVsSpan: quantiles(leakyCos) },
    },
    perLabel,
  };
}

/** Local ONNX bge-base via the KB's own loader. Refuses to download: validation must be offline. */
export async function loadBgeEmbedder({ kbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../kb') } = {}) {
  const [{ loadTransformers, chooseModelCache }, { BGE_MODEL, configureTransformersModel, modelCacheReady }] = await Promise.all([
    import(path.join(kbDir, 'resolve-deps.mjs')), import(path.join(kbDir, 'model-requirements.mjs')),
  ]);
  const { T } = await loadTransformers();
  const cache = chooseModelCache({ kbDir });
  if (!modelCacheReady(cache, BGE_MODEL)) throw new Error(`bge-base is not cached at ${cache}; set KB_MODEL_CACHE to a warm cache (validation never downloads)`);
  configureTransformersModel(T, cache, BGE_MODEL);
  T.env.allowRemoteModels = false;
  const fe = await T.pipeline('feature-extraction', BGE_MODEL, { quantized: true });
  return async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32).map((t) => (t && t.trim() ? t : ' '));
      const res = await fe(batch, { pooling: 'cls', normalize: true });
      const [, dim] = res.dims;
      for (let j = 0; j < batch.length; j++) out.push(Array.from(res.data.slice(j * dim, (j + 1) * dim)));
    }
    return out;
  };
}

function arg(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }

export async function main(argv = process.argv.slice(2)) {
  const labelsFile = arg(argv, '--labels');
  const snapshotDir = arg(argv, '--dir');
  const out = arg(argv, '--out');
  if (!labelsFile || !snapshotDir) { process.stderr.write('Usage: validate-labels.mjs --labels <labels.json> --dir <snapshot> [--out <validation.json>]\n'); return 64; }
  const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
  const embed = await loadBgeEmbedder();
  const validation = await validateLabels({ labels, snapshotDir: path.resolve(snapshotDir), embed });
  const json = `${JSON.stringify(validation, null, 2)}\n`;
  if (out) fs.writeFileSync(out, json); else process.stdout.write(json);
  const a = validation.aggregate;
  process.stderr.write(`[validate] ${labels.repo}: ${a.pass}/${a.total} pass | a=${a.byCheck.a.pass} b=${a.byCheck.b.pass} c=${a.byCheck.c.pass} d=${a.byCheck.d.pass} | ws-normalised=${a.secondary.whitespaceNormalizedMatch} line-range=${a.secondary.lineRangeMatch}\n`);
  return 0;
}

// Entry-point guard. Compares REALPATHS on both sides: path.resolve() normalizes a path but does
// NOT follow symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (npm bin
// shims, wrapper scripts, and every os.tmpdir() path on macOS) the two sides disagree, so main()
// never runs -- and because nothing throws, the process exits 0. A silent exit 0 is indistinguishable
// from "ran, found nothing", which is how prepareCorpusCandidate once reported SUCCESS with no
// archive on disk. Reproduced live 2026-07-27; pinned by tests/unit/entrypoint-symlink.test.mjs.
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) process.exitCode = await main();
