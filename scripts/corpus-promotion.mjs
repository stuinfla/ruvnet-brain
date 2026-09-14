#!/usr/bin/env node
// scripts/corpus-promotion.mjs — the ordering rule for customer corpus releases (ADR-086 step 17).
//
// This lives in its own module rather than inside scripts/release.mjs for one concrete reason:
// release.mjs runs its whole gate flow at import time (`npm test`, vitest, version sync), so a test
// that imported it to check one pure function would execute a full release preflight as a side
// effect. A decision this load-bearing must be directly testable.
//
// WHAT IT DECIDES. A corpus tag is the archive's own digest, so two tags carry no ordering between
// them — nothing in `corpus-sha256-<a>` versus `corpus-sha256-<b>` says which came later. Promotion
// to `releases/latest` therefore needs an explicit, PUBLISHED ordering key, and the rule is strict
// monotonicity in it: a generation may take latest only if it is strictly newer than the corpus
// generation already there. Everything ambiguous fails closed, because "cannot prove we are newer"
// and "we are older" have the same correct answer.

export const CORPUS_GENERATION_FIELD = 'Corpus generation:';
export const CORPUS_TAG_PATTERN = /^corpus-sha256-[0-9a-f]{64}$/;

export function parseCorpusGeneration(body) {
  const line = String(body || '').split('\n').map((row) => row.trim())
    .find((row) => row.startsWith(CORPUS_GENERATION_FIELD));
  if (!line) return null;
  const value = line.slice(CORPUS_GENERATION_FIELD.length).trim();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { value, epoch: parsed } : null;
}

export function evaluateCorpusPromotion({ tag, generation, currentLatest } = {}) {
  if (!currentLatest) return { allowed: true, reason: 'no published latest release to move' };
  if (currentLatest.tagName === tag) {
    return { allowed: false, reason: `${tag} is already the published latest release` };
  }
  if (!CORPUS_TAG_PATTERN.test(String(currentLatest.tagName || ''))) {
    // A code release holds latest. Corpus promotion does not regress the runtime, because
    // scripts/approved-runtime.mjs has already proved this archive's executables ARE the
    // owner-approved shipped runtime, byte for byte.
    return {
      allowed: true,
      reason: `current latest ${currentLatest.tagName} is a code release; runtime equality is enforced by the approved runtime pin`,
    };
  }
  const published = parseCorpusGeneration(currentLatest.body);
  if (!published) {
    return {
      allowed: false,
      reason: `current latest ${currentLatest.tagName} is a corpus release with no readable "${CORPUS_GENERATION_FIELD}" ordering key`,
    };
  }
  const mine = Date.parse(generation);
  if (!Number.isFinite(mine)) return { allowed: false, reason: 'this candidate has no readable corpus generation timestamp' };
  if (mine <= published.epoch) {
    return {
      allowed: false,
      reason: `refusing to move customers backward: ${currentLatest.tagName} published generation ${published.value} is not older than ${generation}`,
    };
  }
  return { allowed: true, reason: `newer than ${currentLatest.tagName} (${published.value})` };
}
