#!/usr/bin/env node
// ADR-086 Step 15 — the C3 retrieval-accuracy gate.
//
// Dual's C3 definition, verbatim, is the contract this file implements:
//
//   metric: "Evidence-supporting Hit@5: a question succeeds only when the first five
//   customer-visible results contain correctly attributed source evidence sufficient to answer it.
//   A matching file path without the supporting span fails."
//
//   threshold: "Require 20 x successes >= 19 x N independently for each repository and each query
//   mode. Errors and timeouts count as failures. No pooled average, rounding, excluded failed
//   queries or post-failure denominator changes. N=0 is NOT MEASURED; only independently verified
//   empty sources can lack a retrieval score."
//
//   modes_and_partitions: "Run explicit-repository queries and ordinary full-corpus routed queries
//   separately. Gate each shipped store, each repository and each nonempty gist partition; an
//   aggregate score cannot hide one missing gist."
//
//   ground_truth: "Build labels from exact upstream bytes, not the candidate's passage sidecars...
//   Hold questions and labels out of indexing and tuning."
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT. The measurement runs against the EXTRACTED FINAL
// ARCHIVE through the customer query path (kb/forge-ask-all.mjs's searchAll — the same function the
// shipped CLI calls), never against the build directory and never against a private reimplementation
// of retrieval. The output is a DETACHED report bound to the final archive's digest; it is never
// inserted into the measured ZIP, because doing that would either change the archive after it was
// measured or force a second assembly, and ADR-086's invariants allow exactly one.
//
// BOUNDED RUNS ARE NOT PASSES. `--stores` / `--sample` / `--modes` exist because Step 14 measured
// the oracle producer at ~627s and ~10 model calls per source: a full 194-source oracle is ~33.8h of
// production, and a full benchmark sweep is correspondingly expensive. A bounded run writes
// `coverage.complete: false` with a `bounded` block naming exactly what was limited, and
// validateAccuracyReport() — the reader every gate uses — REFUSES a report whose coverage is not
// complete. A bounded run can therefore be read, reported and compared, but it can never seal a
// publishable corpus receipt.
//
// TIMEOUTS. The threshold text says errors and timeouts count as failures (they are never excluded
// from the denominator), and the Step 15 proof text additionally names "timeout" as a standalone
// blocker. Both readings are honoured, strictly: a timeout is counted as a failure in the
// arithmetic AND any timeout at all forces the run's state to FAIL. Strict is defensible here;
// loose is not.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../../kb/zip-extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// SCHEMA 2 (2026-09-14): ADR-086:248's denominator is now ENFORCED rather than documented. A schema-1
// oracle — unpaired questions with no unit inventory — and every report measured against one remain
// READABLE, but only as DIAGNOSTIC benchmarks: validateAccuracyReport refuses them for candidate
// acceptance and for publication, however high they score. Raised by Dual, verified in code.
export const ACCURACY_SCHEMA_VERSION = 2;
export const ACCURACY_KIND = 'ruvnet-brain-retrieval-accuracy';
export const ORACLE_SCHEMA_VERSION = 2;
export const LEGACY_ORACLE_SCHEMA_VERSION = 1;
export const ORACLE_KIND = 'ruvnet-brain-retrieval-accuracy-oracle';
// ADR-086:248: "Deterministically stratify and select min(100, U) units ... Each selected unit receives
// one direct and one meaning-preserving paraphrased question, so N = 2 × min(100, U)."
export const MAX_SELECTED_UNITS = 100;
export const QUESTION_FORMS = Object.freeze(['direct', 'paraphrase']);
export const C3_ACCEPTANCE = 'c3-acceptance';
export const DIAGNOSTIC = 'diagnostic';
export const ACCURACY_METRIC = 'evidence-supporting-hit@5';
export const HIT_AT_K = 5;
// 20 x successes >= 19 x N. Held as the two integers Dual named so the comparison stays exact
// integer arithmetic — no ratio, no rounding, no floating point anywhere on the gate path.
export const THRESHOLD_NUMERATOR = 19;
export const THRESHOLD_DENOMINATOR = 20;
export const QUERY_MODES = Object.freeze(['explicit-repository', 'full-corpus']);
export const DEFAULT_QUERY_TIMEOUT_MS = 120_000;
export const DEFAULT_ORACLE_FILE = 'data/retrieval-accuracy-oracle.json';

const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX_COMMIT = /^[a-f0-9]{7,64}$/i;
const PARTITION_KINDS = new Set(['repository', 'gist', 'derived']);

export function fail(message) {
  throw new Error(`[retrieval-accuracy] ${message}`);
}

export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Of(fs.readFileSync(file));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Whitespace-normalized comparison text. A span is "present" iff it is a contiguous substring here. */
export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Repository-relative path comparison: forward slashes, no leading ./ or /, case preserved. */
export function normalizePath(value) {
  return String(value ?? '').split(path.sep).join('/').replace(/^\.?\//, '').trim();
}

/** The gate arithmetic, isolated so a test can prove it never rounds. */
export function meetsThreshold(successes, n) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(n) || successes < 0 || n <= 0) return false;
  if (successes > n) return false;
  return THRESHOLD_DENOMINATOR * successes >= THRESHOLD_NUMERATOR * n;
}

function resultPaths(row) {
  return [row?.path, row?.sourcePath, row?.file].filter((value) => typeof value === 'string' && value);
}

function resultText(row) {
  return [row?.fullText, row?.text, row?.passage, row?.snippet]
    .filter((value) => typeof value === 'string').join('\n');
}

/**
 * Evidence-supporting Hit@5, verbatim from C3: within the first five customer-visible results one
 * must be attributed to the labelled source path AND carry the labelled verbatim span in its
 * customer-visible text. "A matching file path without the supporting span fails" is the reason the
 * span check is not optional and is not a similarity score — it is substring containment after
 * whitespace normalization, so a result that merely names the right file scores zero.
 *
 * "CORRECTLY ATTRIBUTED" MEANS THE RIGHT REPOSITORY (2026-09-14, raised by Dual, confirmed in code).
 * The previous version never looked at which store a result came from, and matched paths by suffix in
 * BOTH directions. In full-corpus mode another repository's file carrying the same sentence was
 * credited, and an expected `docs/README.md` was satisfied by ANY bare `README.md` in any directory of
 * any repository. Attribution now requires the result's store to equal the partition's store AND the
 * repository-relative path to be EXACTLY the labelled path. kb/forge-ask-all.mjs searchAll rows carry
 * `repo` in both query modes (measured against the live brain), which defaultSearch maps to `store`.
 */
export function scoreEvidenceHit({ results, label, store }) {
  const top = (Array.isArray(results) ? results : []).slice(0, HIT_AT_K);
  const wantPath = normalizePath(label?.sourcePath);
  const wantSpan = normalizeText(label?.span);
  if (!wantPath || !wantSpan) fail(`label ${label?.id || '(unnamed)'} has no source path or no span`);
  if (typeof store !== 'string' || !store) {
    fail(`label ${label?.id || '(unnamed)'} was scored without its partition's store — repository attribution cannot be skipped`);
  }
  let pathOnly = false;
  let wrongRepository = false;
  for (const row of top) {
    if (!resultPaths(row).map(normalizePath).some((candidate) => candidate === wantPath)) continue;
    const spanPresent = normalizeText(resultText(row)).includes(wantSpan);
    if (row?.store !== store) {
      if (spanPresent) wrongRepository = true;
      continue;
    }
    pathOnly = true;
    if (spanPresent) return { hit: true, reason: 'evidence-supporting' };
  }
  return {
    hit: false,
    reason: pathOnly ? 'path-matched-without-supporting-span'
      : wrongRepository ? 'evidence-from-wrong-repository'
        : 'no-attributed-result',
  };
}

/**
 * The oracle contract. Labels must trace to immutable upstream bytes, so every row carries the git
 * blob SHA and the sha256 of the exact unit bytes it was written from — the two identities
 * scripts/oracle/source-units.mjs binds and that a candidate passage sidecar cannot supply.
 *
 * HONEST LIMIT: this is a checkable PROXY for "built from upstream bytes, not from the candidate's
 * sidecars", not a proof of it. Proving the negative needs the upstream snapshot in hand; what this
 * does guarantee is that a label lifted from a passage sidecar cannot satisfy the schema without
 * someone forging a git blob identity, and that any in-place edit of a row breaks the seal below.
 */
export function validateAccuracyOracle(oracle) {
  if (!oracle || typeof oracle !== 'object') fail('oracle is missing or not an object');
  if (oracle.kind !== ORACLE_KIND
    || (oracle.schemaVersion !== ORACLE_SCHEMA_VERSION && oracle.schemaVersion !== LEGACY_ORACLE_SCHEMA_VERSION)) {
    fail('oracle schema version or kind is wrong');
  }
  // A legacy oracle is still validated in full — it must still be sealed and upstream-grounded — but it
  // is classified DIAGNOSTIC and can never satisfy C3, because it carries no unit inventory, no fixed
  // denominator and no direct/paraphrase pairing.
  const compliant = oracle.schemaVersion === ORACLE_SCHEMA_VERSION;
  if (!Array.isArray(oracle.partitions) || !oracle.partitions.length) fail('oracle declares no partitions');
  if (!Array.isArray(oracle.labels) || !oracle.labels.length) fail('oracle carries no labels');
  const partitions = new Map();
  for (const row of oracle.partitions) {
    const id = String(row?.partition || '');
    if (!id) fail('oracle partition row has no partition id');
    if (partitions.has(id)) fail(`oracle declares partition ${id} twice`);
    if (!PARTITION_KINDS.has(row.kind)) fail(`oracle partition ${id} has an unsupported kind`);
    if (typeof row.store !== 'string' || !row.store) fail(`oracle partition ${id} names no shipped store`);
    if (!HEX_COMMIT.test(String(row.sourceCommit || ''))) fail(`oracle partition ${id} has no upstream source commit`);
    const normalized = { partition: id, kind: row.kind, store: row.store, sourceCommit: String(row.sourceCommit).toLowerCase() };
    if (compliant) {
      if (!Number.isSafeInteger(row.U) || row.U < 1) {
        fail(`oracle partition ${id} carries no meaningful-unit count U >= 1 — N=0 is NOT MEASURED; a genuinely empty source belongs in emptySources with independent evidence`);
      }
      const expectedSelected = Math.min(MAX_SELECTED_UNITS, row.U);
      if (row.selectedUnits !== expectedSelected) {
        fail(`oracle partition ${id} selects ${row.selectedUnits} units; ADR-086:248 requires min(100, U=${row.U}) = ${expectedSelected}`);
      }
      if (row.N !== 2 * expectedSelected) {
        fail(`oracle partition ${id} declares N=${row.N}; ADR-086:248 requires N = 2 x min(100, U) = ${2 * expectedSelected}`);
      }
      if (!HEX64.test(String(row.inventorySha256 || '').toLowerCase())) {
        fail(`oracle partition ${id} binds no meaningful-unit inventory digest`);
      }
      if (typeof row.rulesVersion !== 'string' || !row.rulesVersion) fail(`oracle partition ${id} names no enumeration rules version`);
      if (!Array.isArray(row.unproduced)) fail(`oracle partition ${id} does not account for unproduced units`);
      const unproducedIds = new Set();
      const unproduced = row.unproduced.map((entry) => {
        const unitId = String(entry?.unitId || '');
        if (!unitId || typeof entry.reason !== 'string' || !entry.reason) fail(`oracle partition ${id} has an unproduced unit with no id or reason`);
        if (unproducedIds.has(unitId)) fail(`oracle partition ${id} lists unproduced unit ${unitId} twice`);
        unproducedIds.add(unitId);
        return { unitId, reason: entry.reason };
      });
      Object.assign(normalized, {
        U: row.U, selectedUnits: expectedSelected, N: row.N,
        inventorySha256: String(row.inventorySha256).toLowerCase(), rulesVersion: row.rulesVersion, unproduced,
      });
    }
    partitions.set(id, normalized);
  }
  const seen = new Set();
  const labels = [];
  for (const row of oracle.labels) {
    const id = String(row?.id || '');
    if (!id) fail('oracle label has no id');
    if (seen.has(id)) fail(`oracle label id ${id} appears twice`);
    seen.add(id);
    if (!partitions.has(row.partition)) fail(`oracle label ${id} names undeclared partition ${row.partition}`);
    if (typeof row.question !== 'string' || !normalizeText(row.question)) fail(`oracle label ${id} has no question`);
    if (typeof row.span !== 'string' || !normalizeText(row.span)) fail(`oracle label ${id} has no supporting span`);
    if (typeof row.sourcePath !== 'string' || !normalizePath(row.sourcePath)) fail(`oracle label ${id} has no source path`);
    if (!HEX40.test(String(row.blobSha || '').toLowerCase())) {
      fail(`oracle label ${id} carries no upstream git blob identity — labels must trace to upstream bytes, not candidate passage sidecars`);
    }
    if (!HEX64.test(String(row.unitSha256 || '').toLowerCase())) {
      fail(`oracle label ${id} carries no upstream unit byte digest`);
    }
    const normalized = {
      id,
      partition: row.partition,
      question: row.question,
      span: row.span,
      sourcePath: row.sourcePath,
      blobSha: String(row.blobSha).toLowerCase(),
      unitSha256: String(row.unitSha256).toLowerCase(),
    };
    if (compliant) {
      if (typeof row.unit !== 'string' || !row.unit) fail(`oracle label ${id} names no selected source unit`);
      if (!QUESTION_FORMS.includes(row.form)) fail(`oracle label ${id} is neither the direct nor the paraphrased question of its unit`);
      Object.assign(normalized, { unit: row.unit, form: row.form });
    }
    labels.push(normalized);
  }
  if (compliant) {
    // Exactly one direct and one paraphrase per produced unit, sharing one upstream evidence identity;
    // produced + unproduced must account for EVERY selected unit, so a missing, duplicate, extra or
    // substituted slot cannot quietly move the denominator.
    const byUnit = new Map();
    for (const label of labels) {
      const key = `${label.partition}\u0000${label.unit}`;
      if (!byUnit.has(key)) byUnit.set(key, new Map());
      const forms = byUnit.get(key);
      if (forms.has(label.form)) fail(`oracle unit ${label.unit} in partition ${label.partition} has two ${label.form} questions`);
      forms.set(label.form, label);
    }
    const producedByPartition = new Map();
    for (const [key, forms] of byUnit) {
      const [partitionId, unit] = key.split('\u0000');
      const direct = forms.get('direct');
      const paraphrase = forms.get('paraphrase');
      if (!direct || !paraphrase) fail(`oracle unit ${unit} in partition ${partitionId} is missing its ${direct ? 'paraphrase' : 'direct'} question`);
      for (const field of ['span', 'sourcePath', 'blobSha', 'unitSha256']) {
        if (direct[field] !== paraphrase[field]) fail(`oracle unit ${unit} in partition ${partitionId}: direct and paraphrase disagree on ${field}`);
      }
      if (normalizeText(direct.question).toLowerCase() === normalizeText(paraphrase.question).toLowerCase()) {
        fail(`oracle unit ${unit} in partition ${partitionId}: the paraphrase repeats the direct question`);
      }
      if (partitions.get(partitionId).unproduced.some((entry) => entry.unitId === unit)) {
        fail(`oracle unit ${unit} in partition ${partitionId} is listed as both produced and unproduced`);
      }
      producedByPartition.set(partitionId, (producedByPartition.get(partitionId) || 0) + 1);
    }
    for (const partition of partitions.values()) {
      const produced = producedByPartition.get(partition.partition) || 0;
      if (produced + partition.unproduced.length !== partition.selectedUnits) {
        fail(`oracle partition ${partition.partition} accounts for ${produced + partition.unproduced.length} of its ${partition.selectedUnits} selected units — a missing, duplicate or substituted slot would change N`);
      }
    }
  }
  const empties = [];
  for (const row of oracle.emptySources || []) {
    const store = String(row?.store || '');
    if (!store) fail('oracle emptySources row names no store');
    if (typeof row.evidence !== 'string' || !row.evidence.trim()) {
      fail(`oracle emptySources row ${store} carries no independent emptiness evidence — "zero extracted chunks is not proof of an empty source"`);
    }
    if (!HEX_COMMIT.test(String(row.sourceCommit || ''))) fail(`oracle emptySources row ${store} has no upstream source commit`);
    empties.push({ store, evidence: row.evidence, sourceCommit: String(row.sourceCommit).toLowerCase() });
  }
  // The seal: rows cannot be edited in place without the digests moving, and the digests are what
  // the corpus receipt and runProtectedCorpusSeed ultimately bind.
  const labelsSha256 = sha256Of(canonical(labels));
  const partitionsSha256 = sha256Of(canonical([...partitions.values()]));
  const seal = oracle.seal || {};
  if (seal.labelsSha256 !== labelsSha256 || seal.partitionsSha256 !== partitionsSha256) {
    fail('oracle seal does not match its own partition/label rows');
  }
  return {
    schemaVersion: oracle.schemaVersion,
    classification: compliant ? C3_ACCEPTANCE : DIAGNOSTIC,
    c3Eligible: compliant,
    partitions, labels, empties, labelsSha256, partitionsSha256,
  };
}

export function readAccuracyOracle(file) {
  const resolved = path.resolve(file || '');
  if (!resolved || !fs.existsSync(resolved)) {
    fail(`retrieval-accuracy oracle missing (${resolved || 'no path supplied'}) — ADR-086 Step 14 owns producing it; the C3 gate fails closed without it`);
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('retrieval-accuracy oracle is not a trusted regular file');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    fail(`retrieval-accuracy oracle unreadable/corrupt (${error.message})`);
  }
  const validated = validateAccuracyOracle(parsed);
  return {
    ...validated,
    file: path.relative(ROOT, resolved).split(path.sep).join('/'),
    sha256: sha256File(resolved),
    bytes: stat.size,
    oracleVersion: String(parsed.oracleVersion || ''),
  };
}

/** Stores actually shipped in the extracted archive — the partition universe the gate must cover. */
export function archiveStores(root) {
  return fs.readdirSync(root)
    .filter((name) => name.endsWith('.big.rvf'))
    .map((name) => name.slice(0, -'.big.rvf'.length))
    .sort();
}

async function defaultSearch({ dir, query, repos, timeoutMs }) {
  const module = await import('../../kb/forge-ask-all.mjs');
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });
  try {
    const answered = await Promise.race([
      module.searchAll({ dir, query, k: HIT_AT_K, ...(repos ? { repos } : {}) }),
      timeout,
    ]);
    if (answered?.__timedOut) return { timedOut: true, results: [] };
    return {
      timedOut: false,
      results: (answered?.results || []).map((row) => ({
        store: row.repo, path: row.path, text: row.fullText || row.text || '',
      })),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run the benchmark against an already-assembled archive and write the detached report.
 *
 * `search` is injected so the gate's arithmetic, coverage bookkeeping and fail-closed behaviour can
 * be proven in unit tests without a model cache or a half-gigabyte corpus; production passes no
 * override and gets kb/forge-ask-all.mjs's searchAll — the real customer path.
 */
export async function runRetrievalAccuracy({
  bundleFile,
  oracleFile = path.join(ROOT, DEFAULT_ORACLE_FILE),
  outFile,
  storeLimit = null,
  sampleLimit = null,
  modes = QUERY_MODES,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  search = defaultSearch,
  now = () => new Date().toISOString(),
} = {}) {
  const bundle = path.resolve(bundleFile || '');
  if (!bundle || !fs.existsSync(bundle) || !fs.statSync(bundle).isFile()) {
    fail(`archive missing (${bundle || 'no path supplied'})`);
  }
  const archive = { file: path.basename(bundle), sha256: sha256File(bundle), bytes: fs.statSync(bundle).size };
  const report = path.resolve(outFile || `${bundle}.accuracy.json`);
  const oracle = readAccuracyOracle(oracleFile);
  const selectedModes = QUERY_MODES.filter((mode) => modes.includes(mode));
  if (!selectedModes.length) fail('no supported query mode selected');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-accuracy-'));
  try {
    try {
      await extractZip(bundle, tmp);
    } catch (error) {
      fail(`cannot extract archive (${error.message})`);
    }
    // The measurement root is the EXTRACTED FINAL ARCHIVE, never the build directory.
    const manifests = [];
    const findRoot = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) fail(`extracted archive contains a symbolic link: ${file}`);
        if (entry.isDirectory()) findRoot(file);
        else if (entry.isFile() && entry.name === 'ARCHIVE-MANIFEST.json') manifests.push(file);
      }
    };
    findRoot(tmp);
    if (manifests.length !== 1) fail(`archive must contain exactly one ARCHIVE-MANIFEST.json; found ${manifests.length}`);
    const corpusDir = path.dirname(manifests[0]);
    const shipped = archiveStores(corpusDir);
    if (!shipped.length) fail('extracted archive ships no stores to measure');

    const labelsByPartition = new Map();
    for (const label of oracle.labels) {
      if (!labelsByPartition.has(label.partition)) labelsByPartition.set(label.partition, []);
      labelsByPartition.get(label.partition).push(label);
    }
    const orderedPartitions = [...oracle.partitions.values()].sort((a, b) => a.partition.localeCompare(b.partition));
    const measuredPartitions = storeLimit == null ? orderedPartitions : orderedPartitions.slice(0, storeLimit);

    const partitions = [];
    let timeouts = 0;
    let errors = 0;
    for (const partition of measuredPartitions) {
      const all = (labelsByPartition.get(partition.partition) || [])
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));
      const selected = sampleLimit == null ? all : all.slice(0, sampleLimit);
      // THE DENOMINATOR. For a compliant oracle N comes from the unit inventory — 2 x min(100, U) —
      // never from how many labels happened to survive production. Every unproduced unit keeps its two
      // slots and scores them as misses below. A bounded --sample run is incomplete and unacceptable
      // regardless, so it measures only what it sampled.
      const unproducedSlots = oracle.c3Eligible && sampleLimit == null ? partition.unproduced : [];
      for (const mode of selectedModes) {
        const row = {
          partition: partition.partition,
          partitionKind: partition.kind,
          store: partition.store,
          sourceCommit: partition.sourceCommit,
          ...(oracle.c3Eligible ? { U: partition.U, N: partition.N } : {}),
          mode,
          n: selected.length + 2 * unproducedSlots.length,
          unproducedQuestions: 2 * unproducedSlots.length,
          successes: 0,
          failures: 0,
          errors: 0,
          timeouts: 0,
          sampled: sampleLimit != null && selected.length < all.length,
          oracleRows: all.length,
          failedLabels: [],
        };
        if (!row.n) {
          // "N=0 is NOT MEASURED; only independently verified empty sources can lack a retrieval score."
          row.state = 'NOT-MEASURED';
          partitions.push(row);
          continue;
        }
        for (const label of selected) {
          let outcome;
          try {
            const answered = await search({
              dir: corpusDir,
              query: label.question,
              repos: mode === 'explicit-repository' ? [partition.store] : null,
              timeoutMs,
              mode,
            });
            if (answered?.timedOut) {
              row.timeouts += 1;
              timeouts += 1;
              outcome = { hit: false, reason: 'timeout' };
            } else {
              outcome = scoreEvidenceHit({ results: answered?.results, label, store: partition.store });
            }
          } catch (error) {
            row.errors += 1;
            errors += 1;
            outcome = { hit: false, reason: `error: ${error.message}` };
          }
          // No excluded failed queries and no post-failure denominator changes: every selected label
          // lands in exactly one of successes/failures, and n was fixed before the loop began.
          if (outcome.hit) row.successes += 1;
          else {
            row.failures += 1;
            if (row.failedLabels.length < 20) row.failedLabels.push({ id: label.id, reason: outcome.reason });
          }
        }
        for (const slot of unproducedSlots) {
          // Two questions per selected unit, both misses: the unit was selected, so it counts.
          row.failures += 2;
          if (row.failedLabels.length < 20) row.failedLabels.push({ id: `${partition.partition}::${slot.unitId}`, reason: `unproduced: ${slot.reason}` });
        }
        if (row.successes + row.failures !== row.n) {
          fail(`internal: partition ${row.partition} (${mode}) scored ${row.successes + row.failures} outcomes for n=${row.n}`);
        }
        if (oracle.c3Eligible && sampleLimit == null && row.n !== row.N) {
          fail(`internal: partition ${row.partition} (${mode}) measured n=${row.n} but its inventory fixes N=${row.N}`);
        }
        row.state = meetsThreshold(row.successes, row.n) && row.timeouts === 0 ? 'PASS' : 'FAIL';
        partitions.push(row);
      }
    }

    const measuredIds = new Set(measuredPartitions.map((row) => row.partition));
    const unmeasuredPartitions = orderedPartitions
      .filter((row) => !measuredIds.has(row.partition))
      .map((row) => row.partition);
    const emptyStores = new Set(oracle.empties.map((row) => row.store));
    const coveredStores = new Set(partitions.filter((row) => row.n > 0).map((row) => row.store));
    const uncoveredArchiveStores = shipped.filter((store) => !coveredStores.has(store) && !emptyStores.has(store));
    const sampledAny = partitions.some((row) => row.sampled);
    const boundedReasons = [];
    if (storeLimit != null) boundedReasons.push(`--stores ${storeLimit}`);
    if (sampleLimit != null) boundedReasons.push(`--sample ${sampleLimit}`);
    if (selectedModes.length !== QUERY_MODES.length) boundedReasons.push(`--modes ${selectedModes.join(',')}`);
    if (unmeasuredPartitions.length) boundedReasons.push(`${unmeasuredPartitions.length} oracle partition(s) not measured`);
    if (uncoveredArchiveStores.length) boundedReasons.push(`${uncoveredArchiveStores.length} shipped store(s) with no oracle coverage`);
    if (sampledAny) boundedReasons.push('at least one partition measured a sample of its oracle rows');
    const complete = boundedReasons.length === 0;

    const failingPartitions = partitions.filter((row) => row.state !== 'PASS');
    const state = complete && !failingPartitions.length && timeouts === 0 ? 'PASS' : 'FAIL';

    const payload = {
      schemaVersion: ACCURACY_SCHEMA_VERSION,
      kind: ACCURACY_KIND,
      // A legacy-oracle run is a DIAGNOSTIC benchmark: its number describes that oracle and this
      // evaluator only, and validateAccuracyReport refuses it for acceptance and publication.
      classification: oracle.classification,
      c3Eligible: oracle.c3Eligible,
      createdAt: now(),
      archive,
      oracle: {
        schemaVersion: oracle.schemaVersion,
        file: oracle.file,
        sha256: oracle.sha256,
        bytes: oracle.bytes,
        oracleVersion: oracle.oracleVersion,
        labelsSha256: oracle.labelsSha256,
        partitionsSha256: oracle.partitionsSha256,
      },
      generator: { retrievalAccuracySha256: sha256File(fileURLToPath(import.meta.url)) },
      metric: ACCURACY_METRIC,
      k: HIT_AT_K,
      threshold: { numerator: THRESHOLD_NUMERATOR, denominator: THRESHOLD_DENOMINATOR },
      modes: selectedModes,
      queryTimeoutMs: timeoutMs,
      coverage: {
        complete,
        bounded: complete ? null : { reasons: boundedReasons, storeLimit, sampleLimit, modes: selectedModes },
        archiveStores: shipped,
        oraclePartitions: orderedPartitions.length,
        measuredPartitions: measuredPartitions.length,
        unmeasuredPartitions,
        uncoveredArchiveStores,
        emptySources: oracle.empties,
      },
      totals: {
        n: partitions.reduce((sum, row) => sum + row.n, 0),
        successes: partitions.reduce((sum, row) => sum + row.successes, 0),
        failures: partitions.reduce((sum, row) => sum + row.failures, 0),
        errors,
        timeouts,
      },
      partitions,
      state,
    };
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, `${JSON.stringify(payload, null, 2)}\n`);
    return { reportFile: report, report: payload };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The STRICT C3 reader: schema, metric, threshold, c3Eligible, archive binding, complete coverage and
 * every per-partition PASS, all re-derived here rather than trusted from the report's summary fields.
 *
 * RETAINED DELIBERATELY THOUGH NOTHING IN THE RELEASE PATH CALLS IT SINCE 2026-09-15. C3 measured
 * 59.0% on a real archive and was demoted to a published diagnostic (readDiagnosticAccuracyReport is
 * what candidate acceptance and publication now use). This function is the RE-ARM path: when the
 * retrieval-quality work lands and C3 can be met, restoring the blocking predicate is a one-line
 * change back to this reader rather than a rewrite. Its behaviour stays pinned by
 * tests/unit/corpus-accuracy-gate.test.mjs so it cannot rot while it waits.
 */
export function validateAccuracyReport({
  report, archive, expectedOracleSha256 = null, expectedGeneratorSha256 = null,
} = {}) {
  if (!report || typeof report !== 'object') fail('accuracy report is missing or not an object');
  if (report.schemaVersion !== ACCURACY_SCHEMA_VERSION || report.kind !== ACCURACY_KIND) {
    fail('accuracy report schema version or kind is wrong');
  }
  if (report.metric !== ACCURACY_METRIC || report.k !== HIT_AT_K
    || report.threshold?.numerator !== THRESHOLD_NUMERATOR || report.threshold?.denominator !== THRESHOLD_DENOMINATOR) {
    fail('accuracy report does not measure the contracted metric, k or threshold');
  }
  if (report.c3Eligible !== true || report.classification !== C3_ACCEPTANCE
    || report.oracle?.schemaVersion !== ORACLE_SCHEMA_VERSION) {
    fail(`accuracy report is a ${report.classification || 'legacy'} benchmark against an oracle of schema ${report.oracle?.schemaVersion ?? 'unknown'} — only an ADR-086:248-compliant (schema ${ORACLE_SCHEMA_VERSION}) measurement can qualify a corpus for C3, however high it scored`);
  }
  // The BINDING: the report is bound to the exact final-archive bytes it was measured against. An
  // altered archive changes this digest and the report stops applying, which is the whole reason the
  // report is detached and digest-bound rather than packed inside the ZIP.
  if (!archive || report.archive?.sha256 !== archive.sha256 || report.archive?.bytes !== archive.bytes
    || report.archive?.file !== archive.file) {
    fail('accuracy report is not bound to this exact final archive');
  }
  if (!HEX64.test(String(report.oracle?.sha256 || ''))) fail('accuracy report binds no oracle digest');
  if (expectedOracleSha256 != null && report.oracle.sha256 !== expectedOracleSha256) {
    fail('accuracy report was measured against a different retrieval oracle than the one committed here');
  }
  if (expectedGeneratorSha256 != null && report.generator?.retrievalAccuracySha256 !== expectedGeneratorSha256) {
    fail('accuracy report was produced by a different benchmark generator than the one committed here');
  }
  if (report.coverage?.complete !== true) {
    const reasons = (report.coverage?.bounded?.reasons || []).join('; ') || 'coverage.complete is not true';
    fail(`accuracy report is a BOUNDED measurement, not a corpus-wide pass (${reasons})`);
  }
  if (Array.isArray(report.coverage?.unmeasuredPartitions) && report.coverage.unmeasuredPartitions.length) {
    fail(`accuracy report leaves ${report.coverage.unmeasuredPartitions.length} oracle partition(s) unmeasured`);
  }
  if (Array.isArray(report.coverage?.uncoveredArchiveStores) && report.coverage.uncoveredArchiveStores.length) {
    fail(`accuracy report leaves ${report.coverage.uncoveredArchiveStores.length} shipped store(s) ungated — an aggregate score cannot hide one missing partition`);
  }
  if (!Array.isArray(report.modes) || QUERY_MODES.some((mode) => !report.modes.includes(mode))) {
    fail('accuracy report does not measure both the explicit-repository and full-corpus query modes');
  }
  if (!Array.isArray(report.partitions) || !report.partitions.length) fail('accuracy report measured no partition');
  const seenModes = new Map();
  for (const row of report.partitions) {
    if (typeof row?.partition !== 'string' || !row.partition) fail('accuracy report partition row has no partition id');
    if (!QUERY_MODES.includes(row.mode)) fail(`accuracy report partition ${row.partition} names an unsupported mode`);
    if (!Number.isSafeInteger(row.n) || row.n <= 0) {
      fail(`accuracy report partition ${row.partition} (${row.mode}) is NOT MEASURED (N=0)`);
    }
    if (![row.successes, row.failures, row.errors, row.timeouts].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      fail(`accuracy report partition ${row.partition} (${row.mode}) has malformed counters`);
    }
    if (row.successes + row.failures !== row.n) {
      fail(`accuracy report partition ${row.partition} (${row.mode}) changed its denominator after the fact`);
    }
    if (!Number.isSafeInteger(row.U) || row.U < 1 || row.N !== 2 * Math.min(MAX_SELECTED_UNITS, row.U)) {
      fail(`accuracy report partition ${row.partition} (${row.mode}) carries no ADR-086:248 denominator (U=${row.U}, N=${row.N})`);
    }
    if (row.n !== row.N) {
      fail(`accuracy report partition ${row.partition} (${row.mode}) measured n=${row.n} but its inventory fixes N=${row.N} — a denominator taken from surviving labels`);
    }
    if (row.timeouts > 0) {
      fail(`accuracy report partition ${row.partition} (${row.mode}) recorded ${row.timeouts} timeout(s)`);
    }
    if (row.sampled === true) fail(`accuracy report partition ${row.partition} (${row.mode}) measured only a sample`);
    if (!meetsThreshold(row.successes, row.n)) {
      fail(`accuracy report partition ${row.partition} (${row.mode}) is below threshold: ${row.successes}/${row.n}`);
    }
    if (row.state !== 'PASS') fail(`accuracy report partition ${row.partition} (${row.mode}) is ${row.state}`);
    const key = row.partition;
    if (!seenModes.has(key)) seenModes.set(key, new Set());
    if (seenModes.get(key).has(row.mode)) fail(`accuracy report measures partition ${key} twice in ${row.mode}`);
    seenModes.get(key).add(row.mode);
  }
  for (const [partition, modes] of seenModes) {
    // "Run explicit-repository queries and ordinary full-corpus routed queries separately."
    if (QUERY_MODES.some((mode) => !modes.has(mode))) fail(`accuracy report partition ${partition} is missing a query mode`);
  }
  if (Number.isSafeInteger(report.totals?.timeouts) && report.totals.timeouts > 0) {
    fail(`accuracy report recorded ${report.totals.timeouts} timeout(s)`);
  }
  if (report.state !== 'PASS') fail(`accuracy report state is ${report.state}`);
  return report;
}

/**
 * Read a detached accuracy report from disk and validate it against the archive it must bind.
 * Returns the {file, sha256, bytes} identity A6 requires the corpus receipt to carry.
 */
/**
 * INTEGRITY-ONLY read of the machine-generated C3 measurement, for the lane where it is published as
 * a DIAGNOSTIC rather than used as the blocking predicate (ADR-086 amendment, 2026-09-15: C3 measured
 * 59.0% on the real archive and no longer blocks; scripts/oracle/repo-recall.mjs does).
 *
 * This still refuses a report that is malformed, or that describes a DIFFERENT archive — a diagnostic
 * that is not bound to the bytes it graded is worse than none, because it looks like evidence. What it
 * deliberately does NOT enforce is the 19/20 threshold, c3Eligible or the C3 classification, so a
 * failing-but-honest measurement can travel with the release and be read by anyone.
 */
export function readDiagnosticAccuracyReport({ reportFile, archive, expectedOracleSha256 = null, expectedGeneratorSha256 = null } = {}) {
  const resolved = path.resolve(reportFile || '');
  if (!resolved || !fs.existsSync(resolved)) fail(`diagnostic retrieval-accuracy report missing (${resolved || 'no path supplied'})`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('diagnostic retrieval-accuracy report is not a trusted regular file');
  let report;
  try { report = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { fail(`diagnostic retrieval-accuracy report unreadable/corrupt (${error.message})`); }
  if (report?.schemaVersion !== ACCURACY_SCHEMA_VERSION || report?.kind !== ACCURACY_KIND) {
    fail('diagnostic retrieval-accuracy report schema version or kind is wrong');
  }
  if (!archive || report.archive?.sha256 !== archive.sha256 || report.archive?.bytes !== archive.bytes) {
    fail('diagnostic retrieval-accuracy report is not bound to this exact final archive');
  }
  // The oracle and generator bindings are KEPT even though the score no longer blocks. A diagnostic
  // that does not name the instrument it was measured with is not a diagnostic, it is a number; and
  // silently swapping the oracle underneath a published 59.0% would make that figure meaningless.
  if (expectedOracleSha256 != null && report.oracle?.sha256 !== expectedOracleSha256) {
    fail('diagnostic retrieval-accuracy report was measured against a different retrieval oracle than the one committed here');
  }
  if (expectedGeneratorSha256 != null && report.generator?.retrievalAccuracySha256 !== expectedGeneratorSha256) {
    fail('diagnostic retrieval-accuracy report was produced by a different benchmark generator than the one committed here');
  }
  return {
    identity: { file: path.basename(resolved), sha256: sha256File(resolved), bytes: stat.size },
    state: report.state,
    classification: report.classification ?? null,
    c3Eligible: report.c3Eligible === true,
    totals: report.totals ?? null,
  };
}

export function readAccuracyReport({
  reportFile, archive, expectedOracleSha256 = null, expectedGeneratorSha256 = null,
} = {}) {
  const resolved = path.resolve(reportFile || '');
  if (!resolved || !fs.existsSync(resolved)) {
    fail(`detached retrieval-accuracy report missing (${resolved || 'no path supplied'})`);
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('detached retrieval-accuracy report is not a trusted regular file');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    fail(`detached retrieval-accuracy report unreadable/corrupt (${error.message})`);
  }
  const report = validateAccuracyReport({ report: parsed, archive, expectedOracleSha256, expectedGeneratorSha256 });
  return {
    identity: { file: path.basename(resolved), sha256: sha256File(resolved), bytes: stat.size },
    report,
  };
}

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function positiveInt(value, name) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const { report } = await runRetrievalAccuracy({
    bundleFile: arg(argv, '--bundle'),
    oracleFile: arg(argv, '--oracle', path.join(ROOT, DEFAULT_ORACLE_FILE)),
    outFile: arg(argv, '--out'),
    storeLimit: positiveInt(arg(argv, '--stores'), '--stores'),
    sampleLimit: positiveInt(arg(argv, '--sample'), '--sample'),
    modes: arg(argv, '--modes') ? String(arg(argv, '--modes')).split(',').map((mode) => mode.trim()) : QUERY_MODES,
    timeoutMs: positiveInt(arg(argv, '--timeout-ms'), '--timeout-ms') || DEFAULT_QUERY_TIMEOUT_MS,
  });
  process.stdout.write(`${JSON.stringify({
    ok: report.state === 'PASS',
    state: report.state,
    complete: report.coverage.complete,
    bounded: report.coverage.bounded,
    totals: report.totals,
    partitions: report.partitions.length,
  }, null, 2)}\n`);
  // A bounded or failing measurement is not an acceptable candidate input; say so with the exit code
  // as well as in the report, so a shell caller that forgets to read the JSON still fails closed.
  return report.state === 'PASS' ? 0 : 1;
}

// REALPATH BOTH SIDES, or this CLI silently no-ops. argv[1] is whatever the caller typed, symlinks
// and all, while node resolves a module URL THROUGH symlinks before it reaches import.meta.url — so a
// symlinked invocation compares a link path against a real path, decides it is not the entry point,
// runs nothing, and EXITS 0. On macOS every os.tmpdir() path is symlinked (/var/folders -> /private/
// var/folders), so any caller staging work in a temp directory hits this. Measured 2026-09-14:
// build-bundle.mjs and corpus-candidate.mjs both no-opped and prepareCorpusCandidate reported SUCCESS
// with no archive and no receipt on disk. Same defect, same fix as plugin/scripts/hook-input.mjs:518.
function isMain() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
