// tests/integration/prove-classification.test.mjs — scripts/prove.mjs is the "proof of retrieval"
// grader: it runs a question battery through the REAL searchAll() engine, classifies each result
// pass/fail, computes a median relevance score, and writes PROOF.md + data/proof-results.json with
// an exit code that reflects whether every question passed. Despite being the artifact Stuart's
// "never wrongly doubt" confidence claims are built on, it has zero tests. Found + explicitly
// deferred by the 2026-07-07/08 coverage-gap passes (memory `test-coverage-gaps-2026-07-07`),
// grouped with the harness/grading tier (behavioral-l1-l4.mjs, brain-grade-groundtruth.mjs,
// brain-stamp.mjs) as needing live infra to exercise meaningfully.
//
// THE ACTUAL GAP (more specific than "no test yet"): prove.mjs has NO importable functions at all —
// classification (repoOk/relOk/pass, lines 40-42), the median calc (lines 49-50), and the PROOF.md
// table rendering (lines 60-90) are all inline in one top-level script that also imports searchAll()
// from kb/forge-ask-all.mjs and calls process.exit() at the end. That means:
//   (a) it cannot be imported in-process (process.exit + top-level await would kill the runner), and
//   (b) even via subprocess, its PURE classification logic cannot be exercised without ALSO paying
//       for a real built .rvf fixture + a loaded ONNX model, because searchAll() isn't swappable —
//       there's no dependency-injection seam, no --mock flag, nothing to stub the way
//       ingest-repo.mjs's git/node calls could be PATH-stubbed.
// This is a design gap as much as a test gap: extracting the classification math into an exported,
// pure `classifyResult({ got, eff, score, q })` function (no I/O, no searchAll call) would make
// everything below unit-testable in milliseconds, with zero infra. That refactor is out of scope for
// this pass (it changes product code, not just adds tests) but is the highest-leverage next step for
// this specific file — flagging it rather than writing tests that only look green.
//
// Below: the concrete cases a real test suite should cover, once either (1) that extraction happens,
// or (2) someone accepts the cost of a tiny real fixture (build a 1-2-file sample repo's .rvf via
// kb/forge-build.mjs, matching the fixture forge-mcp-server.test.mjs's deferred success-path .todo
// already calls for) and drives prove.mjs as a subprocess against it with a matching --questions file.

import { describe, it } from 'vitest';

describe.todo('prove.mjs — repoOk classification (scripts/prove.mjs:40)', () => {
  it.todo('passes when expectRepo is a single string and got matches it exactly');
  it.todo('passes when expectRepo is an array and got matches ANY entry');
  it.todo('passes when got does not match expectRepo directly but the "eff" (effective/primer) repo does');
  it.todo('passes automatically (repoOk=true) when a question has no expectRepo at all — an unconstrained probe');
  it.todo('fails when got matches neither the string/array expectRepo nor eff');
});

describe.todo('prove.mjs — the "eff" primer-repo fallback (scripts/prove.mjs:36)', () => {
  it.todo('when top hit repo is "concepts" and has a path like "ruv-fann/some-article.md", eff resolves to "ruv-fann"');
  it.todo('when top hit repo is "concepts" but path is empty/missing, eff falls back to "concepts" itself (the `|| got` branch)');
  it.todo('when top hit repo is anything other than "concepts", eff equals got unchanged');
});

describe.todo('prove.mjs — relOk relevance threshold (scripts/prove.mjs:41)', () => {
  it.todo('passes automatically (relOk=true) when score is null — no numeric comparison attempted');
  it.todo('uses -3 as the default minRelevance when a question does not specify one');
  it.todo('honors a question-specific minRelevance override, both above and below the default -3');
});

describe.todo('prove.mjs — overall pass computation (scripts/prove.mjs:42)', () => {
  it.todo('fails overall when got is null even if repoOk/relOk would both be true (guards the "no hit at all" case)');
  it.todo('requires BOTH repoOk and relOk true, not just one, to mark pass=true');
});

describe.todo('prove.mjs — resilience when searchAll() throws mid-battery (scripts/prove.mjs:32-33)', () => {
  it.todo('logs "ERR #<n> <message>" and continues to the next question rather than crashing the whole run');
  it.todo('a thrown question contributes got=null/pass=false to the results array and to the exit-code computation, not a silent skip');
});

describe.todo('prove.mjs — median relevance calculation (scripts/prove.mjs:49-50)', () => {
  it.todo('returns null when zero questions produced a numeric score');
  it.todo('returns that single value when exactly one question has a numeric score');
  it.todo('for an even-length sorted array, returns index floor(n/2) — the upper-middle element, NOT an averaged true median (worth confirming this approximation is intentional, not a bug, before ever tightening a threshold on it)');
});

describe.todo('prove.mjs — bySet grouping + PROOF.md rendering (scripts/prove.mjs:51-52, 60-90)', () => {
  it.todo('groups results under q.set, or the literal string "other" when a question has no set');
  it.todo('esc() escapes a literal "|" character in a query or citedPath so it cannot break the markdown table');
  it.todo('PROOF.md headline reports "N/total" passed and the computed median (or "n/a") verbatim');
});

describe.todo('prove.mjs — exit code + artifact writes (scripts/prove.mjs:55-57, 91, 96)', () => {
  it.todo('exits 0 only when passed === results.length (every question passed), not on a partial-pass threshold');
  it.todo('exits 1 when even one question fails');
  it.todo('always writes data/<outbase>-results.json and <OUTBASE>.md regardless of pass/fail, so a failing run still leaves an inspectable artifact');
});
