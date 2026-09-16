// brain-grade-summary.mjs — pure helper split out of brain-grade-groundtruth.mjs specifically so it
// can be unit tested. brain-grade-groundtruth.mjs is 100% top-level script: importing it for real
// shells out to OpenRouter (network) and requires a real questions file + repo clone, exactly the
// hazard tests/unit/brain-stamp-manifest.test.mjs's header and scripts/brain-stamp-resolve.mjs's own
// split documented for the sibling "clone freshness is not artifact freshness" fix. This module has
// zero side effects on import; brain-grade-groundtruth.mjs imports buildGradeSummary from here.
//
// ISSUE #258's fix (scripts/brain-score.mjs's readPanel()) prefers each grade file's own
// `summary.generatedAt` over the checkout's file mtime, so a panel graded weeks ago can no longer
// misreport as freshly current on a new clone. That half landed (commit 8caa157) — but no producer
// ever wrote the field: every real data/grade-*.json, and any future run of
// brain-grade-groundtruth.mjs, built its summary object without `generatedAt`, so readPanel()'s
// preferred branch was permanently unreachable and it silently fell back to mtime every time — the
// exact original defect, unchanged in effect, behind a comment that reads as if it were fixed. This
// is the missing write-side half: `generatedAt` is stamped at the moment the panel is actually
// measured, so the next real run of the producer finally makes readPanel()'s recorded-time branch
// reachable.
export function buildGradeSummary({ name, variant, questions, models, valid, gtFail, now = () => new Date() }) {
  const mean = (k) => valid.reduce((s, r) => s + r[k], 0) / valid.length;
  const minK = (k) => Math.min(...valid.map((r) => r[k]));
  return {
    name,
    variant,
    questions,
    models,
    avgStrict: +mean('avgStrict').toFixed(2),
    avgRealUse: +mean('avgRealUse').toFixed(2),
    minStrict: minK('avgStrict'),
    minRealUse: minK('avgRealUse'),
    poisonStrict: valid.filter((r) => r.avgStrict < 50).length,
    poisonRealUse: valid.filter((r) => r.avgRealUse < 50).length,
    groundTruthCitationFailures: gtFail,
    generatedAt: now().toISOString(),
  };
}
