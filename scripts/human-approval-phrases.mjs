// human-approval-phrases.mjs — the matcher behind single-source B6 (tracked instructions) and B12 (the
// local CLAUDE.md / AGENTS.md): no instruction may put a person clicking in GitHub back into the release
// path (CONTRIBUTING.md, "What replaces a human approval").
//
// Two gaps the 4.3.39 review measured, both closed here:
//  • Markdown emphasis broke the match: "Stuart's approval** of the …" did not match "Stuart's approval of".
//    Lines are matched after stripping `*` and backticks.
//  • B6 exempted any line containing "never" ANYWHERE, so "The owner approves the Production deployment;
//    never skip it." passed. A negation now counts only inside the same clause as the matched phrase.

/** Phrases that re-introduce a person as a release gate (B6, tracked instruction files). */
export const HUMAN_APPROVAL_STEP = /(owner|stuart'?s?|maintainer) (approves?|approval|click|must approve)\b[^.;]*(deployment|release|publish|gate)|approves? the Production|hand (it|the work) over[^.;]*click|required[- ]reviewers?\b|standing authori[sz]ation permits|owner[- ]approved/i;

/** B12: the same, plus the local-file drifts that file has carried (npx ruflo, retired npm scripts). */
export const LOCAL_INSTRUCTION_DRIFT = /npx (-y )?(@claude-flow|claude-flow|ruflo)\b|standing authori[sz]ation permits|owner (approves?|click)|Stuart's approval (of|in GitHub)|approves? the Production|hand (it|the work) over[^.]*click|npm run (build|dev|test:integration|test:coverage|test:security)\b|not direct Agent tool|owner[- ]approved/i;

const NEGATION = /\b(no|not|never|nobody|none|without|cannot|isn't|is not|removed|retired)\b/i;

/** Markdown emphasis and code ticks are formatting, not words. */
export const plainText = (line) => String(line).replace(/[*`]/g, '');

/** The clause around [start, end): bounded by . ; : ! ? or the line ends. */
function clauseAround(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const from = Math.max(...['.', ';', ':', '!', '?'].map((c) => before.lastIndexOf(c))) + 1;
  const stops = ['.', ';', ':', '!', '?'].map((c) => after.indexOf(c)).filter((i) => i >= 0);
  const to = end + (stops.length ? Math.min(...stops) : after.length);
  return text.slice(from, to);
}

/**
 * Hits of `pattern` in `line` that are not negated in their own clause.
 * @returns {string[]} the matched phrases that count
 */
export function approvalHits(line, pattern = HUMAN_APPROVAL_STEP, { allowNegation = true } = {}) {
  const text = plainText(line);
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const hits = [];
  for (const match of text.matchAll(global)) {
    const clause = clauseAround(text, match.index, match.index + match[0].length);
    if (allowNegation && NEGATION.test(clause)) continue;
    hits.push(match[0]);
  }
  return hits;
}
