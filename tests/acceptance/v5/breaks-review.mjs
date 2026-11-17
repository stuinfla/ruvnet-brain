// The breaks of the review-fix tests (docs/REVIEW-FIXES.md: the Codex review of v5, findings F01-F24).
// Each removes one protection a review fix added and names the failure its test must show.
const EV = 'packages/release/evidence.mjs';
const p = (file, find, replace) => ({ file, find, replace });

export function addReviewBreaks(BREAKS) {
  Object.assign(BREAKS, {
    // F01: promotion recomputes the gate decision and requires complete receipts
    'wp6-11-trust-passed': { test: 'wp6-11', what: 'promotion trusts the gate result\'s passed flag', patches: [p(EV, '  const why = gateProblems(gate, pin);\n', '  const why = [];\n')], expect: /asserted success with a score of 0 of 1 must be refused/ },
    'wp6-11-trust-ok': { test: 'wp6-11', what: 'promotion trusts a receipt\'s ok flag', patches: [p(EV, '    if (why) throw new Refused(`the install-and-probe receipt', '    if (false) throw new Refused(`the install-and-probe receipt')], expect: /abbreviated ok receipts must be refused/ },
    'wp6-11-no-ci': { test: 'wp6-11', what: 'promotion ignores which run and runner wrote a receipt', patches: [p(EV, "  const ci = env.GITHUB_ACTIONS === 'true' ? env.GITHUB_RUN_ID : null;", '  const ci = null;')], expect: /receipts with no run identity in GitHub Actions must be refused/ },
    // F02: the installer's Node selector never runs anything inside the project
    'wp7-09-no-check': { test: 'wp7-09', what: 'the selector probes candidates without the project check', patches: [p('packages/cli/node-pick.mjs', '    if (!outsideProject(c, env, cwd)) {', '    if (false) {')], expect: /an absolute PATH entry inside the project: a program inside the project was run/ },
    'wp7-09-lexical': { test: 'wp7-09', what: 'the selector checks folders but not where a link really points', patches: [p('packages/cli/node-pick.mjs', '[path.dirname(file), real(path.dirname(file)), rf, rf && path.dirname(rf)]', '[path.dirname(file), real(path.dirname(file))]')], expect: /an outside node that links into the project: a program inside the project was run/ },
    // F19: the candidate artifact keeps the signed hidden plugin files
    'wp6-08-hidden': { test: 'wp6-08', what: 'the channel upload drops hidden files', patches: [p('.github/workflows/v5-release-candidate.yml', '          name: v5-channel\n          path: ${{ runner.temp }}/channel\n          if-no-files-found: error\n          include-hidden-files: true\n', '          name: v5-channel\n          path: ${{ runner.temp }}/channel\n          if-no-files-found: error\n')], expect: /upload v5-channel must keep hidden files/ },
  });
}
