/**
 * search-outcome.mjs — say which of three different things happened, in words that cannot be
 * mistaken for each other.
 *
 * ISSUE #132. `search_ruvnet` had one empty-handed message for two unrelated events:
 *
 *   A. the search RAN across N repos and nothing matched
 *   B. the capability-card router DECLINED, so nothing was consulted at all
 *
 * Case B rendered as `Searched 0 RuvNet repos ()` followed by "nothing in the corpus matched this
 * query" — which a careful reader parses, correctly, as an empty installation. The reporter did
 * exactly that and told their user twice that their brain had no data indexed, on a machine holding
 * 1.5 GB across 30+ working repos. On a tool whose entire purpose is to be the trustworthy source,
 * "I have nothing" when the truth is "I declined to guess" is the most expensive sentence available.
 *
 * This lives in its own module because forge-mcp-all.mjs starts a server on import, so its wording
 * could not otherwise be tested by anything except reading the source — and a message is exactly the
 * kind of thing that must be asserted by what it SAYS.
 */

/**
 * @param {object} o
 * @param {string[]} o.repos              repos the search actually ran against
 * @param {object|null} o.routing         { attempted, accepted, reason } from the card router
 * @param {string} [o.staleness]          corpus-age preamble, already formatted
 * @param {number} [o.installedRepoCount] how many stores are installed — the fact that settles it
 * @returns {{declined: boolean, header: string, emptyBody: string}}
 */
export function describeSearchOutcome({ repos = [], routing = null, staleness = '', installedRepoCount = 0 }) {
  // DECLINED is a positive claim about what the router did, never inferred from an empty list alone:
  // zero repos can also mean a filter matched nothing, and mislabelling that as a decline would be
  // the same class of confident-wrong sentence in the other direction.
  //
  // AND IT REQUIRES AN ACTUAL CORPUS. The decline message exists to say "your brain is fine, I just
  // declined to guess" — on an installation with NO stores that sentence becomes "Your corpus is
  // intact: 0 repo store(s) are installed", which is absurd and false. Caught by the existing
  // token-meter suite, which runs the server against an empty KB: the first version of this fix
  // reassured the user about a corpus that did not exist. On a genuinely empty install the ORIGINAL
  // wording is the accurate one, so that case keeps it.
  const declined = repos.length === 0
    && installedRepoCount > 0
    && routing?.attempted === true
    && routing?.accepted === false;

  if (declined) {
    return {
      declined,
      header: 'NO SEARCH WAS RUN — the capability-card router declined to choose a repo.\n'
        + `Reason: ${routing.reason || 'no capability card matched with enough confidence'}.\n`
        + `Your corpus is intact: ${installedRepoCount} repo store(s) are installed and searchable. `
        + 'This is a ROUTING decline, NOT an empty or broken brain.\n\n',
      emptyBody: '➡ NAME A REPO or ask a narrower, artifact-shaped question and the search will run. '
        + 'Do NOT report to the user that the brain has no data — it was never asked.',
    };
  }

  return {
    declined,
    header: `Searched ${repos.length} RuvNet repos (${repos.join(', ')}).\n${staleness}`,
    emptyBody: '(no results — the search ran; nothing in the corpus matched this query)\n'
      + '➡ This means THIS QUERY found nothing, NOT that the capability is absent from the ecosystem. '
      + 'Try a narrower query or name a specific repo or artifact before concluding it must be built.',
  };
}
