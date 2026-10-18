// ADR-0091 D5 — per-store failure isolation for corpus reconciliation.
//
// One store failing to refresh must not abort the whole generation. This module owns the two
// pure decisions that make that safe, so the reconciler, the rehearsal and the tests share them:
//
//   1. WHICH failures are retried. Only transient ones (clone, fetch, runner I/O), exactly once, in a
//      fresh worker directory. A corpus-qa failure is never retried: the round-trip sample is
//      deterministic (FNV-1a, corpus-qa.mjs), so a retry re-embeds the whole store to reproduce it.
//      The class comes from WHERE the worker failed and from forge-refresh's exit status, never
//      from log text.
//   2. HOW MANY stores may be carried or missing before the failure is systemic and the generation
//      must fail loudly: carried + missing <= max(3, 5% of eligible).
//
// A generation inside that bound PUBLISHES like any other, each carried or missing store named in its
// sealed coverage (CORPUS-COVERAGE.json: `carry` / `failure` records). Whether installed clients accept
// it is proven every night by the customer canary (protected-release.yml `customer-canary`: a clean
// install, a private-overlay install and the previous runtime each apply the staged candidate through
// the real updater before anything is promoted; scripts/corpus-canary.mjs storeFreshness names each
// carried store), not by a hand-set constant. The former ADR-0091 D10 gate -- a committed
// `VALIDATOR_TRANSITION` plus a 14-day soak -- was removed on 2026-10-17: the tolerant validator
// (`eligibleRepositoryStanding`) has shipped in every code release since v4.3.36 (2026-09-29) and every
// corpus generation since 2026-10-01, the soak it demanded ended on 2026-10-13, and the constant was
// never set. Measured on the one night it decided (run 39069376585, 2026-10-17, runtime 4.7.10): the
// external source cognitum-one/ruOS had been deleted upstream; 4.7.10's `ifGone` entry carried it at
// b1762a71 while the live corpus served 576dc8c8, so the store was re-planned, the clone of the gone
// repository failed twice, the store was carried, the 201-store generation was built and sealed over
// ~1h40m, and this gate threw it away with exit 4 (4.7.11 fixed the `ifGone` commit). The four nights
// before it (38529261934, 38699673841, 38867855193, 39013743592) died earlier, exit 1, on the HTTP 404
// itself. A gate that only a code release can open, that nobody opens, is not a safety property.
// A CODE release still ships only an all-CURRENT corpus: scripts/corpus-next-seed.mjs --require-coverage
// refuses a degraded seed, because install verification requires eligibleCurrent === eligibleTotal.

/** kb/forge-refresh.mjs exits with this status when corpus-qa rejected its candidate. */
export const CORPUS_QA_FAILED_EXIT = 3;

export const FAILURE_CLASS = Object.freeze({
  TRANSIENT: 'transient',
  QA: 'qa',
  BUILD: 'build',
  INTEGRITY: 'integrity',
});

/** A worker failure carrying its structured class. `detail` is for logs only, never for shipped rows. */
export class StoreWorkerError extends Error {
  constructor({ store, stage, failureClass, detail = '' }) {
    super(`[corpus-reconcile] ${store}: ${stage} failed (${failureClass})${detail ? ` (${detail})` : ''}`);
    this.name = 'StoreWorkerError';
    this.store = store;
    this.stage = stage;
    this.failureClass = failureClass;
  }
}

export function isRetryable(error) {
  return error instanceof StoreWorkerError && error.failureClass === FAILURE_CLASS.TRANSIENT;
}

/**
 * The shipped, machine-readable reason. Stage and class only: stderr can quote runner paths, and a
 * coverage row travels to every user.
 */
export function failureReason(error) {
  if (error instanceof StoreWorkerError) return `${error.failureClass}: ${error.stage} failed`;
  return `${FAILURE_CLASS.INTEGRITY}: worker failed`;
}

/** Fixed rule: the failure is systemic above max(3, 5% of eligible). */
export function degradedBound(eligibleCount) {
  if (!Number.isSafeInteger(eligibleCount) || eligibleCount < 0) throw new Error('eligible count must be a non-negative integer');
  return Math.max(3, Math.floor(eligibleCount * 0.05));
}

/**
 * One line a run log or step summary can print for a generation's carried/missing stores; '' when none.
 * Rows are the reconciler's `{ store, ... }` records or the coverage sidecar's bare store names.
 */
export function describeDegraded({ carried = [], missing = [] } = {}) {
  if (!carried.length && !missing.length) return '';
  const names = (rows) => rows.map((row) => (typeof row === 'string' ? row : row.store)).join(', ') || 'none';
  return `${carried.length} carried (${names(carried)}), ${missing.length} missing (${names(missing)})`;
}
