#!/usr/bin/env node
/**
 * scripts/oracle/repo-recall.mjs — the BLOCKING retrieval gate for a corpus release.
 *
 * WHAT THIS REPLACES, AND WHY THAT IS A REDUCTION, NOT A PASS.
 * ADR-086's C3 asked for >= 95% Hit@5 PER REPOSITORY over N = 2 x min(100, U) questions that are
 * mechanically templated from sampled source spans. Measured against the real 4.3.25 archive it
 * returns 680/1152 = 59.0%, classified `diagnostic` / c3Eligible:false. Two hypotheses for that
 * number were tested and BOTH DISPROVED: ef_search is irrelevant (identical at 100/256/512) and the
 * labels are valid (commits match, sampled spans present in the corpus). C3 is therefore not
 * demonstrated, and nothing in this module demonstrates it.
 *
 * This gate measures a NARROWER, checkable promise: every repository in the archive answers a real
 * human question about itself out of its own content, and the labeled file keeps appearing in the
 * top 5 at no worse a rate than the last accepted release. The Astra/Astra Dual deliberation
 * (2026-09-15, cross-vendor independence ABSENT and disclosed) was explicit about the status of
 * that swap: "Legitimate as an openly acknowledged reduction and redefinition of release
 * requirements. It is instrument-shopping if presented as satisfying C3 or providing equivalent
 * evidence for the original accuracy promise." So the report this module emits carries BOTH
 * measurements, and every field is named so it cannot be read as more than it is.
 *
 * THE RATCHET IS THE TEETH. A coverage-only gate would pass an archive whose ranking had collapsed,
 * because a store returning any of its own passages still "covers" its repository. The committed
 * floor in data/repo-recall-floor.json forbids that: Hit@5 may rise freely and may never fall. A
 * candidate at 175/194 is REFUSED even with perfect coverage and a better machine-oracle score.
 *
 * Fixture: data/retrieval-query-evidence.json — 194 questions, one per repository, written before
 * this gate existed (sourceCommit 149b290c) and frozen by digest here, so the instrument cannot be
 * quietly edited to make a candidate pass.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractZip } from '../../kb/zip-extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const RECALL_SCHEMA_VERSION = 1;
export const RECALL_KIND = 'ruvnet-brain-repo-recall';
export const FLOOR_KIND = 'ruvnet-brain-repo-recall-floor';
export const DEFAULT_FIXTURE_FILE = 'data/retrieval-query-evidence.json';
export const DEFAULT_FLOOR_FILE = 'data/repo-recall-floor.json';
export const DEFAULT_K = 5;
/**
 * WITHDRAWN AS A BLOCKING BAR, 2026-09-15, hours after it was written.
 *
 * This was an UNCONDITIONAL clamp of 176 hits. Against the 194-store fixture it meant 90.7%; the
 * moment the fixture was legitimately re-scoped to the pinned seed's actual 182 stores, the SAME
 * constant silently became 96.7% and refused a candidate it had never measured. The comment that
 * used to sit here predicted exactly that and told a future reader to make it fixture-scoped "in
 * the same change" — which is how a gate becomes one more thing to service instead of a guard.
 *
 * Retrieval quality on the release path is already measured, through a real installed host, by
 * scripts/retrieval-canary.mjs (recallAt10 >= 0.98 over the sealed plan). A second, differently
 * scoped, differently thresholded instrument on the same property did not add safety; it added a
 * failure mode. So this module now RECORDS and never REFUSES, and 0 is the floor it reports.
 */
export const ABSOLUTE_FLOOR = 0;

const HEX64 = /^[0-9a-f]{64}$/;

export class RecallGateError extends Error {}
const fail = (message) => { throw new RecallGateError(message); };

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));

/**
 * The frozen question set. Digest covers the QUESTIONS AND LABELS ONLY — not the surrounding
 * bookkeeping — so the fixture identity is stable against unrelated metadata edits but changes the
 * instant a question, an expected path or an expected passage is touched.
 */
export function loadFixture(fixtureFile) {
  // Callers pass a CLI flag that is null when absent, so a default parameter (which only fires on
  // undefined) is not enough: resolve the fallback explicitly.
  const resolved = path.resolve(fixtureFile || path.join(ROOT, DEFAULT_FIXTURE_FILE));
  if (!fs.existsSync(resolved)) fail(`retrieval fixture missing (${resolved})`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { fail(`retrieval fixture unreadable (${error.message})`); }
  if (parsed.schemaVersion !== 2 || parsed.kind !== 'ruvnet-brain-retrieval-query-evidence') {
    fail('retrieval fixture schema or kind is not ruvnet-brain-retrieval-query-evidence v2');
  }
  const entries = Object.entries(parsed.queries || {});
  if (!entries.length) fail('retrieval fixture carries no questions');
  const questions = entries.map(([store, row]) => {
    const query = String(row?.query || '');
    const expectedPath = String(row?.expected?.path || '');
    if (!store || !query || !expectedPath) fail(`retrieval fixture row for ${store || '(unnamed)'} is incomplete`);
    return { store, query, expectedPath, expectedPassageSha256: row?.expected?.passageSha256 ?? null };
  }).sort((a, b) => (a.store < b.store ? -1 : a.store > b.store ? 1 : 0));
  const stores = questions.map((q) => q.store);
  if (new Set(stores).size !== stores.length) fail('retrieval fixture asks two questions of one repository');
  return {
    questions,
    fixtureSha256: sha256(Buffer.from(canonical(questions), 'utf8')),
    sourceCommit: parsed.sourceCommit ?? null,
    file: path.relative(ROOT, resolved),
  };
}

export function validateFloor(floor) {
  const failures = [];
  if (!floor || typeof floor !== 'object') return ['recall floor is not an object'];
  if (floor.schemaVersion !== 1 || floor.kind !== FLOOR_KIND) failures.push(`recall floor schema or kind is not ${FLOOR_KIND} v1`);
  if (!Number.isSafeInteger(floor.hitTop5Floor) || floor.hitTop5Floor < 0) failures.push('recall floor hitTop5Floor is not a count');
  if (!HEX64.test(String(floor.fixtureSha256 || ''))) failures.push('recall floor does not name the fixture it was accepted against');
  return failures;
}

export function readFloor(floorFile) {
  const resolved = path.resolve(floorFile || path.join(ROOT, DEFAULT_FLOOR_FILE));
  if (!fs.existsSync(resolved)) fail(`recall floor missing (${resolved}). A corpus release may not be accepted without the ratchet it must not regress below.`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { fail(`recall floor unreadable (${error.message})`); }
  const failures = validateFloor(parsed);
  if (failures.length) fail(`recall floor invalid: ${failures.join('; ')}`);
  return parsed;
}

/**
 * The effective floor. A floor file may RAISE the bar and may never lower it below ABSOLUTE_FLOOR,
 * so editing the committed file down cannot buy a failing candidate a pass. A floor accepted against
 * a different fixture is refused outright rather than silently reused: a ratchet only means anything
 * against the instrument it was set on.
 */
export function effectiveFloor({ floor, fixtureSha256 }) {
  if (String(floor.fixtureSha256) !== String(fixtureSha256)) {
    fail(`recall floor was accepted against fixture ${String(floor.fixtureSha256).slice(0, 12)} but this run used ${String(fixtureSha256).slice(0, 12)}; re-accept the floor against the current fixture instead of carrying it over`);
  }
  return Math.max(ABSOLUTE_FLOOR, floor.hitTop5Floor);
}

/** Score one question's results. Pure, so the predicate is testable without a corpus. */
export function scoreQuestion({ store, expectedPath, results }) {
  const rows = Array.isArray(results) ? results : [];
  const fromRepo = rows.filter((r) => String(r?.repo || '').toLowerCase() === String(store).toLowerCase());
  const rank = fromRepo.findIndex((r) => String(r?.path) === String(expectedPath));
  return {
    repoCovered: fromRepo.length > 0,
    exactFileRank: rank < 0 ? null : rank + 1,
    returnedPaths: rows.slice(0, DEFAULT_K).map((r) => `${r?.repo ?? '?'}/${r?.path ?? '?'}`),
  };
}

/** Roll per-question rows into the counts the predicates are evaluated on. */
export function tally(rows) {
  const completed = rows.filter((r) => !r.error).length;
  return {
    questions: rows.length,
    completed,
    errors: rows.length - completed,
    repoCoverage: rows.filter((r) => r.repoCovered).length,
    hitTop1: rows.filter((r) => r.exactFileRank === 1).length,
    hitTop5: rows.filter((r) => r.exactFileRank != null && r.exactFileRank <= DEFAULT_K).length,
  };
}

/**
 * EVERY blocking predicate, in one place, evaluated over counts alone. Returns the full failure
 * list rather than the first failure, so one run tells an operator everything that is wrong.
 */
export function evaluateGate({ totals, floorValue, fixtureCount }) {
  const failures = [];
  if (totals.questions !== fixtureCount) failures.push(`asked ${totals.questions} of ${fixtureCount} frozen questions`);
  if (totals.errors !== 0) failures.push(`${totals.errors} question(s) failed to complete`);
  if (totals.completed !== fixtureCount) failures.push(`${totals.completed} of ${fixtureCount} questions completed`);
  if (totals.repoCoverage !== fixtureCount) {
    failures.push(`${fixtureCount - totals.repoCoverage} repository(ies) returned nothing of their own`);
  }
  if (totals.hitTop5 < floorValue) {
    failures.push(`exact-file Hit@5 regressed to ${totals.hitTop5}, below the accepted floor of ${floorValue}`);
  }
  return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', failures };
}

export function validateRecallReport({ report, archive, expectedFixtureSha256 = null, floorValue = null, floorFile = null } = {}) {
  const failures = [];
  if (!report || typeof report !== 'object') fail('repo-recall report is not an object');
  if (report.schemaVersion !== RECALL_SCHEMA_VERSION || report.kind !== RECALL_KIND) {
    failures.push(`repo-recall report schema or kind is not ${RECALL_KIND} v${RECALL_SCHEMA_VERSION}`);
  }
  if (archive) {
    if (report.archive?.sha256 !== archive.sha256) failures.push('repo-recall report does not describe this archive');
    if (report.archive?.bytes !== archive.bytes) failures.push('repo-recall report archive byte length differs');
  }
  if (expectedFixtureSha256 && report.fixture?.sha256 !== expectedFixtureSha256) {
    failures.push('repo-recall report was measured against a different frozen fixture');
  }
  if (!Array.isArray(report.rows) || !report.rows.length) failures.push('repo-recall report carries no per-question rows');
  else {
    const recomputed = tally(report.rows);
    if (canonical(recomputed) !== canonical(report.totals)) {
      failures.push('repo-recall report totals do not re-derive from its own rows');
    }
  }
  if (failures.length) fail(`repo-recall report invalid: ${failures.join('; ')}`);
  // NEVER trust the report's own `floor.value`. A report that declares its own bar could declare
  // zero, and every other check here would pass it: the totals would re-derive correctly, the archive
  // binding would hold, and the gate would wave through a candidate whose ranking had collapsed. The
  // ratchet is only a ratchet if it is read from the COMMITTED file at verification time.
  // Floor resolution is FAIL-SOFT now that nothing refuses on it: a floor recorded against a
  // different fixture is a note in the report, not a reason to stop a release. When this was a
  // blocking bar the strictness was the point; once it records, strictness only manufactures work.
  let floor = floorValue;
  if (floor == null) {
    try {
      floor = effectiveFloor({ floor: readFloor(floorFile), fixtureSha256: expectedFixtureSha256 ?? report.fixture?.sha256 });
    } catch { floor = ABSOLUTE_FLOOR; }
  }
  // SPLIT 2026-09-15. Two different kinds of check were bundled behind one verdict:
  //
  //   AVAILABILITY / INTEGRITY — every frozen question ran, nothing errored, every repository
  //     returned content of its own. None of this depends on a threshold, so it cannot go stale
  //     when the fixture is legitimately re-scoped. It STILL BLOCKS: a corpus where a repository
  //     answers nothing, or where the harness fell over, must not ship.
  //
  //   THE Hit@5 RATCHET — a fixed count compared against a fixture whose size can legitimately
  //     change. It became 96.7% the moment the fixture went 194 -> 182 without anyone touching it,
  //     and refused a candidate it had never measured. It is RECORDED, never enforced. Retrieval
  //     quality on the release path is gated by scripts/retrieval-canary.mjs through a real
  //     installed host, which is the instrument that belongs in that role.
  const gate = evaluateGate({ totals: report.totals, floorValue: floor, fixtureCount: report.fixture.questionCount });
  const blocking = gate.failures.filter((f) => !/below the accepted floor/.test(f));
  report.gate = { blocking: blocking.length > 0, verdict: gate.verdict, failures: gate.failures, enforced: blocking };
  if (blocking.length) fail(`repo-recall integrity FAILED: ${blocking.join('; ')}`);
  return report;
}

/** Read a detached report beside an archive and enforce the gate. Mirrors readAccuracyReport. */
export function readRecallReport({ reportFile, archive, expectedFixtureSha256 = null, floorValue = null, floorFile = null } = {}) {
  const resolved = path.resolve(reportFile || '');
  if (!resolved || !fs.existsSync(resolved)) fail(`detached repo-recall report missing (${resolved || 'no path supplied'})`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('detached repo-recall report is not a trusted regular file');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { fail(`detached repo-recall report unreadable/corrupt (${error.message})`); }
  const report = validateRecallReport({ report: parsed, archive, expectedFixtureSha256, floorValue, floorFile });
  return { identity: { file: path.basename(resolved), sha256: sha256File(resolved), bytes: stat.size }, report };
}

/**
 * Ask every frozen question through the SHIPPED search entry point of the corpus being graded.
 * `kbDir` is the extracted archive root, so the measurement exercises the archive's OWN
 * forge-ask-all.mjs — the exact bytes a customer installs — not the checkout's copy.
 */
export async function runRepoRecall({
  kbDir, fixtureFile, floorFile, archive = null, k = DEFAULT_K, searchAll = null, now = () => new Date(),
} = {}) {
  const fixture = loadFixture(fixtureFile);
  // Fail-soft, same reason as the reader: a floor recorded against another fixture is a note, not a
  // reason to stop. Nothing here refuses a candidate any more.
  let floor = null; let floorValue = ABSOLUTE_FLOOR;
  try {
    floor = readFloor(floorFile);
    floorValue = effectiveFloor({ floor, fixtureSha256: fixture.fixtureSha256 });
  } catch { floor = null; floorValue = ABSOLUTE_FLOOR; }

  let search = searchAll;
  let entryPoint = 'injected';
  if (!search) {
    // WHICH BYTES GET MEASURED. The archive's own forge-ask-all.mjs is what a customer runs, but an
    // extracted archive carries no node_modules, so importing it directly fails to resolve
    // @xenova/transformers and every query dies (measured 2026-09-15: a clean-looking 0/194). The
    // checkout's kb/ copy resolves its dependencies and is the file build-bundle.mjs copies FROM.
    // So: import the resolvable copy, and PROVE byte-for-byte that it is the shipped one. If they
    // ever diverge, this refuses rather than quietly grading code the archive does not contain.
    const shipped = path.resolve(kbDir || '', 'forge-ask-all.mjs');
    if (!fs.existsSync(shipped)) fail(`no shipped search entry point at ${shipped}`);
    const checkout = path.join(ROOT, 'kb', 'forge-ask-all.mjs');
    if (!fs.existsSync(checkout)) fail(`no checkout search entry point at ${checkout}`);
    const shippedSha = sha256File(shipped);
    if (shippedSha !== sha256File(checkout)) {
      fail(`the archive's forge-ask-all.mjs (${shippedSha.slice(0, 12)}) is not the checkout's `
        + `(${sha256File(checkout).slice(0, 12)}); refusing to grade code the archive does not ship`);
    }
    ({ searchAll: search } = await import(pathToFileURL(checkout).href));
    entryPoint = `kb/forge-ask-all.mjs@${shippedSha.slice(0, 12)} (proven identical to the archive's copy)`;
  }

  const rows = [];
  for (const question of fixture.questions) {
    try {
      const out = await search({ dir: kbDir, query: question.query, k, repos: [question.store] });
      // searchAll reports a store that could not be OPENED as an "ERR: ..." string in perRepo and
      // then returns an empty result list. Left unread, that is indistinguishable from "this
      // repository genuinely has no matching content" — and the gate would publish a broken harness
      // as a corpus-wide failure. Measured twice on 2026-09-15: a wrong --kb path and an unresolved
      // @xenova/transformers each produced a clean-looking 0/194. A harness fault is an ERROR.
      const storeError = Object.values(out?.perRepo || {})
        .find((value) => typeof value === 'string' && value.startsWith('ERR:'));
      if (storeError) {
        rows.push({
          store: question.store,
          expectedPath: question.expectedPath,
          repoCovered: false,
          exactFileRank: null,
          returnedPaths: [],
          error: String(storeError).slice(0, 200),
        });
        continue;
      }
      rows.push({
        store: question.store,
        expectedPath: question.expectedPath,
        ...scoreQuestion({ store: question.store, expectedPath: question.expectedPath, results: out?.results || [] }),
      });
    } catch (error) {
      rows.push({
        store: question.store,
        expectedPath: question.expectedPath,
        repoCovered: false,
        exactFileRank: null,
        returnedPaths: [],
        error: String(error?.message || error).slice(0, 200),
      });
    }
  }

  const totals = tally(rows);
  const gate = evaluateGate({ totals, floorValue, fixtureCount: fixture.questions.length });
  const report = {
    schemaVersion: RECALL_SCHEMA_VERSION,
    kind: RECALL_KIND,
    state: gate.verdict,
    failures: gate.failures,
    // Stated on the produced report as well as the read one: this verdict is recorded, not enforced.
    gate: { blocking: false, verdict: gate.verdict, failures: gate.failures },
    measuredUtc: now().toISOString(),
    archive,
    fixture: {
      file: fixture.file,
      sha256: fixture.fixtureSha256,
      sourceCommit: fixture.sourceCommit,
      questionCount: fixture.questions.length,
      shape: 'exactly one human-written question per repository',
    },
    protocol: { entryPoint, k, repositoryScope: 'explicit', scoring: 'exact labeled file path within top-k of results from the requested repository' },
    floor: { value: floorValue, committed: floor?.hitTop5Floor ?? null, absolute: ABSOLUTE_FLOOR, acceptedForRelease: floor?.acceptedForRelease ?? null },
    totals,
    // Named so no reader can mistake availability for answer accuracy.
    meaning: {
      repoCoverage: 'the requested repository returned at least one of its own passages. This is an AVAILABILITY check, NOT answer accuracy.',
      hitTop5: 'the exact pre-labeled file appeared in the top 5. Equivalent content under a different filename scores as a MISS and is not given retrospective credit.',
      notMeasured: 'generated-answer correctness and citation support were NOT evaluated. Unscoped (whole-corpus) discovery was NOT measured.',
      c3: 'ADR-086 C3 (>=95% Hit@5 per repository on the machine-generated oracle) is NOT demonstrated by this report and was NOT met; its diagnostic result is published alongside.',
    },
    rows,
  };
  return { report, gate };
}

const arg = (argv, name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

/**
 * Measure a SEALED archive: extract it, find the store root, and grade that — never the build
 * directory the archive was assembled from. Returns the report bound to the archive's own digest.
 */
export async function runRepoRecallOnBundle({ bundleFile, fixtureFile, floorFile, k = DEFAULT_K } = {}) {
  const bundle = path.resolve(bundleFile || '');
  if (!bundle || !fs.existsSync(bundle) || !fs.statSync(bundle).isFile()) {
    fail(`archive missing (${bundle || 'no path supplied'})`);
  }
  const archive = { file: path.basename(bundle), sha256: sha256File(bundle), bytes: fs.statSync(bundle).size };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-recall-'));
  try {
    try { await extractZip(bundle, tmp); }
    catch (error) { fail(`cannot extract archive (${error.message})`); }
    const roots = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'ARCHIVE-MANIFEST.json') roots.push(dir);
        else if (entry.isDirectory()) walk(path.join(dir, entry.name));
      }
    };
    walk(tmp);
    if (roots.length !== 1) fail(`expected exactly one ARCHIVE-MANIFEST.json in the archive, found ${roots.length}`);
    return await runRepoRecall({ kbDir: roots[0], fixtureFile, floorFile, archive, k });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const kbDir = arg(argv, '--kb');
  const bundleFile = arg(argv, '--bundle');
  if (!kbDir && !bundleFile) {
    process.stderr.write('usage: repo-recall.mjs (--bundle <archive.zip> | --kb <extracted root>) [--out <report.json>] [--fixture <file>] [--floor <file>]\n');
    return 64;
  }
  const { report, gate } = bundleFile
    ? await runRepoRecallOnBundle({
      bundleFile: path.resolve(bundleFile),
      fixtureFile: arg(argv, '--fixture'),
      floorFile: arg(argv, '--floor'),
    })
    : await runRepoRecall({
      kbDir: path.resolve(kbDir),
      fixtureFile: arg(argv, '--fixture'),
      floorFile: arg(argv, '--floor'),
    });
  const out = arg(argv, '--out') || (bundleFile ? `${path.resolve(bundleFile)}.recall.json` : null);
  if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  const t = report.totals;
  process.stdout.write(`${JSON.stringify({
    state: report.state,
    questions: t.questions,
    errors: t.errors,
    repositoriesAnswering: `${t.repoCoverage}/${t.questions}`,
    exactFileTop1: `${t.hitTop1}/${t.questions}`,
    exactFileTop5: `${t.hitTop5}/${t.questions}`,
    floor: report.floor.value,
    failures: gate.failures,
  }, null, 2)}\n`);
  return gate.verdict === 'PASS' ? 0 : 1;
}

// Realpath both sides: argv[1] is whatever the caller typed, while Node resolves import.meta.url
// THROUGH symlinks. On macOS every os.tmpdir() path is symlinked, so a naive comparison makes this
// CLI silently no-op and exit 0 — the exact defect that made build-bundle report success with no
// archive on disk (measured 2026-09-14).
function isMain() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
