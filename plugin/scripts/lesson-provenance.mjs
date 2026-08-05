export const SOURCE_CLASS = Object.freeze({
  CURRENT_USER: 'current-user',
  IMPORTED_OWNER: 'imported-owner',
  MODEL_INFERRED: 'model-inferred',
  DEMONSTRATION: 'demonstration',
});

/**
 * STATUS — the ratification ladder. A lesson does not become policy by existing.
 * candidate → ratified (a human agreed) → active (in force at its trigger).
 *
 * It lives HERE, beside the provenance it is read with, because `isUntouchedOwnerSeedRow` below
 * needs both and neither may import the other's module. lesson-store re-exports it, so every
 * existing importer is unaffected.
 */
export const STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  RATIFIED: 'ratified',
  ACTIVE: 'active',
});

export const BUNDLED_OWNER_SEED_IDS = new Set([
  'L01-verify-with-a-capable-channel',
  'L02-check-before-you-assert',
  'L03-research-before-recommending',
  'L04-never-relay-a-number',
  'L05-version-is-the-update-signal',
  'L06-use-the-real-tool',
  'L07-blast-radius-not-social-comfort',
  'L08-status-is-a-table',
  'L09-gradeable-is-not-valuable',
  'L10-under-enumeration-is-a-tell',
  'L11-retrieval-without-volition-is-broken',
  'L12-efficiency-seeking-is-the-tell',
]);

/**
 * Is this stored row STILL an untouched bundled maintainer seed row?
 *
 * THE FACT BELONGS TO THE WRITERS, NOT TO THE READER. Issue #111: loadLessons decided it by
 * fingerprinting the store's ID SET — "exactly these twelve IDs, nothing more, nothing less" — and
 * that predicate is invariant under every legitimate change it needed to detect. A store seeded from
 * the bundle carries those twelve IDs forever, so the quarantine overwrite re-ran on EVERY load,
 * forcing `origin`/`sourceClass`/`status`/`demoted`/`ratifiedBy` back to imported-candidate-demoted
 * and discarding ratification the console itself had recorded. Rows the user had promoted to
 * `enforcement: block` then failed makeLesson's own trust boundary ("enforcement:block requires
 * origin:user-stated") against the origin the overwrite had just invented, and were dropped with a
 * warning that read like a schema change.
 *
 * So ask it the way the writers answer it, per row. Ratification is stamped by `ratify()` — the one
 * human action in this store — as `status` plus `ratifiedBy`. A row carrying either has been through
 * a person, and a person's decision is not maintainer history to be re-quarantined. An untouched
 * seed row carries neither, because the seed ships every lesson as an unratified candidate on
 * purpose ("the model does not get to ratify its own rules").
 *
 * Dropping the whole-store fingerprint also fixes its under-counting twin: a legacy store holding
 * the twelve bundled rows PLUS the user's own lessons matched nothing at all, so the maintainer rows
 * in it were never quarantined. Per row, they are.
 */
export function isUntouchedOwnerSeedRow(stored) {
  if (!stored || !BUNDLED_OWNER_SEED_IDS.has(stored.id)) return false;
  if (stored.status === STATUS.RATIFIED || stored.status === STATUS.ACTIVE) return false;
  return !stored.ratifiedBy;
}
