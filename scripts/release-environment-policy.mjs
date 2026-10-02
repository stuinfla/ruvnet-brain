// release-environment-policy.mjs — the ONE verdict on the npm-scoped Production environment
// ("Production – ruvnet-brain"), as GitHub's environments API reports it.
//
// The design (CONTRIBUTING.md, "What replaces a human approval"): the environment is a scoping boundary —
// a branch policy (protected branches only) and admins cannot bypass — and NO person is part of it. A
// required reviewer coming back (someone re-adds one in the GitHub UI) silently re-inserts a human click
// into every release; it must turn single-source C3 red, not pass because the other two rules still hold.
export const PRODUCTION_ENVIRONMENT = 'Production – ruvnet-brain';

/**
 * @param {object|null} environment one element of `GET /repos/{o}/{r}/environments` `.environments[]`
 * @returns {{ ok: boolean, problems: string[], detail: string }}
 */
export function productionEnvironmentVerdict(environment) {
  if (!environment || typeof environment !== 'object') {
    return { ok: false, problems: [`environment "${PRODUCTION_ENVIRONMENT}" was not found`], detail: 'not found' };
  }
  const rules = Array.isArray(environment.protection_rules) ? environment.protection_rules : [];
  const branchPolicies = rules.filter((rule) => rule?.type === 'branch_policy').length;
  const reviewerRules = rules.filter((rule) => rule?.type === 'required_reviewers');
  const reviewers = reviewerRules.flatMap((rule) => (Array.isArray(rule.reviewers) ? rule.reviewers : [])
    .map((entry) => entry?.reviewer?.login || entry?.reviewer?.slug || entry?.reviewer?.name || entry?.type || 'unknown'));
  const problems = [];
  if (environment.can_admins_bypass !== false) problems.push('admins can bypass the environment (can_admins_bypass is not false)');
  if (branchPolicies === 0) problems.push('no branch_policy rule (any branch could deploy)');
  if (reviewerRules.length) problems.push(`a required reviewer is back on the environment (${reviewers.join(', ') || 'unnamed'}) — no human approves a release`);
  return {
    ok: problems.length === 0,
    problems,
    detail: `can_admins_bypass=${environment.can_admins_bypass}; branch_policy rules: ${branchPolicies}; required_reviewers rules: ${reviewerRules.length}`
      + (problems.length ? `\n${problems.join('\n')}` : ''),
  };
}
