/**
 * REAL-HOST TESTS MUST DISTINGUISH "THE HOST COULD NOT SERVE" FROM "THE PRODUCT IS BROKEN."
 *
 * Measured 2026-08-06 while closing issue #78. Its acceptance test drives a real `codex exec`, and
 * it went red — exit 1, with this on the wire:
 *
 *     {"type":"error","message":"You've hit your usage limit. Visit …/settings/usage to purchase
 *      more credits or try again at Aug 7th, 2026 11:33 PM."}
 *
 * Nothing about the Brain had regressed. The account was out of credits. The existing skip
 * predicate asked only whether the `codex` BINARY exists and whether `auth.json` exists — neither
 * of which implies the account can actually serve a turn — so a third party's billing state was
 * being reported as our defect.
 *
 * That is the same disease this repo has been bitten by repeatedly, pointed the other way: a gate
 * reporting something other than what it measured. A false RED is not harmless. It trains people to
 * discount the suite, and on a release day it is indistinguishable from a real regression.
 *
 * The honest outcome is SKIPPED-WITH-A-REASON — never a silent pass. A vacuous green here would be
 * the worse failure of the two, because it would claim proof we do not have.
 */

/**
 * Classify a finished `codex` invocation. Returns a human reason when the HOST could not serve the
 * request, or null when the run is genuinely the product's to answer for.
 *
 * Deliberately narrow: it matches quota/auth/transport conditions that make a turn impossible, and
 * nothing that could plausibly be a Brain defect. A matcher that swallowed real failures would
 * convert this from a false-red fix into a false-green — strictly worse than the bug it replaces.
 */
export function codexHostCouldNotServe(result) {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}`;

  if (/hit your usage limit|purchase more credits|quota|insufficient_quota/i.test(text)) {
    return 'the Codex account is out of credits / over its usage limit';
  }
  if (/\b429\b|rate[- ]limit/i.test(text)) return 'the Codex API is rate-limiting this account';
  if (/not logged in|please (run )?`?codex login|auth.*(expired|invalid)|401|unauthorized/i.test(text)) {
    return 'Codex auth is present but not usable (expired or unauthorized)';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network (error|unreachable)|getaddrinfo/i.test(text)) {
    return 'the Codex host is unreachable from this machine';
  }
  return null;
}

/**
 * Skip the running test WITH A VISIBLE REASON when the host could not serve. Returns true when it
 * skipped, so callers can bail out before asserting.
 *
 * `ctx.skip()` reports the test as SKIPPED rather than passed — the distinction that keeps this
 * from becoming a vacuous green.
 */
export function skipIfCodexHostUnavailable(ctx, result) {
  const reason = codexHostCouldNotServe(result);
  if (!reason) return false;
  process.stderr.write(`\n  ⏭  real-Codex test skipped: ${reason}. This is NOT a product result.\n\n`);
  ctx.skip(`real Codex host unavailable — ${reason}`);
  return true;
}
