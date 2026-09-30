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

// ── THE CONSUMER'S CONSENT (customer canary) ─────────────────────────────────────────────────────
// The producer cannot declare success unless the consumer accepted. A corpus generation is staged as
// a prerelease (never latest); scripts/corpus-canary.mjs installs the approved runtime on a clean,
// secret-free runner and applies the staged candidate through that install's own updater; and
// promotion to releases/latest requires the canary's PASS verdict for THIS run, over EXACTLY the
// asset bytes still on the release. Every check below is required: a verdict that omits one, or a
// release whose assets changed after the canary downloaded them, is not consent.
export const CANARY_VERDICT_KIND = 'ruvnet-brain-corpus-canary-verdict';
export const REQUIRED_CANARY_CHECKS = Object.freeze([
  'candidate-release', 'updater-exit', 'signature-verified', 'staged-coverage', 'source-advanced',
  'runtime-identity', 'node-modules', 'single-kb-tree', 'store-freshness',
]);

const assetKey = (asset) => `${asset?.name}|${asset?.digest}`;

/**
 * @param verdict        the canary verdict JSON (scripts/corpus-canary.mjs)
 * @param tag            the staged corpus tag about to be promoted
 * @param runId          GITHUB_RUN_ID of the promoting run — the verdict must come from this run
 * @param runAttempt     GITHUB_RUN_ATTEMPT of the promoting run
 * @param approvedTag    vX.Y.Z the corpus was built at
 * @param releaseAssets  the release's assets as they are NOW ([{ name, digest }])
 */
export function evaluateCanaryVerdict({ verdict, tag, runId, runAttempt, approvedTag, releaseAssets } = {}) {
  const refuse = (reason) => ({ allowed: false, reason: `no customer consent: ${reason}` });
  if (!verdict || verdict.kind !== CANARY_VERDICT_KIND || verdict.schemaVersion !== 1) return refuse('not a canary verdict');
  if (verdict.verdict !== 'PASS') return refuse(`the customer canary reported ${verdict.verdict || '(no verdict)'}`);
  if (!CORPUS_TAG_PATTERN.test(String(tag || '')) || verdict.tag !== tag) return refuse(`the verdict is for ${verdict.tag}, not ${tag}`);
  if (verdict.archiveSha256 !== tag.slice('corpus-sha256-'.length)) return refuse('the verdict archive digest is not the tag digest');
  if (String(verdict.runId ?? '') !== String(runId ?? '') || String(verdict.runAttempt ?? '') !== String(runAttempt ?? '')
    || !runId || !runAttempt) {
    return refuse(`the verdict belongs to run ${verdict.runId}/${verdict.runAttempt}, not this run ${runId}/${runAttempt}`);
  }
  if (approvedTag !== `v${verdict.approvedVersion}`) return refuse(`the canary installed ${verdict.approvedVersion}, not ${approvedTag}`);
  const checks = Array.isArray(verdict.checks) ? verdict.checks : [];
  for (const name of REQUIRED_CANARY_CHECKS) {
    const entry = checks.find((row) => row?.name === name);
    if (!entry) return refuse(`required check ${name} is absent`);
    if (entry.ok !== true) return refuse(`required check ${name} failed (${entry.detail || 'no detail'})`);
  }
  const tested = (verdict.assets || []).map(assetKey).sort();
  const current = (releaseAssets || []).map(assetKey).sort();
  if (!tested.length || tested.some((key) => key.endsWith('|null') || key.endsWith('|undefined'))
    || JSON.stringify(tested) !== JSON.stringify(current)) {
    return refuse('the release assets are not byte-for-byte the ones the canary downloaded');
  }
  return { allowed: true, reason: `customer canary PASS in run ${runId}/${runAttempt} over ${tested.length} asset digest(s)` };
}
