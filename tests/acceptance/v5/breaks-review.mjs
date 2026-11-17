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
    // F14: OK needs a completed self-test on the installed generation
    'wp3-07-incomplete': { test: 'wp3-07', what: 'assess accepts a passed probe without checking its results and time', patches: [p('packages/health/assess.mjs', "  if (!probeComplete(s.probe, now)) return 'incomplete';\n", ''), p('packages/contract/verdict.mjs', '  if (!Number.isFinite(s.probe.at) || !Array.isArray(r) || !r.length || r.some((x) => x?.pass !== true)) {', '  if (false) {')], expect: /must not be OK/ },
    'wp3-07-generation': { test: 'wp3-07', what: 'assess ignores which generation the server runs', patches: [p('packages/health/assess.mjs', "  if (ev.pointer && (s.app !== ev.pointer.app || s.pack !== ev.pointer.pack)) return 'generation';\n", '')], expect: /a server on another generation must not be OK/ },
    'wp3-07-schema': { test: 'wp3-07', what: 'any JSON file with a pid counts as a status file', patches: [p('packages/health/status.mjs', "s && s.schema === 'ruvnet-brain/status' && s.version === 1 && Number.isInteger(s.pid) && n === `${s.pid}.json`", 's && Number.isInteger(s.pid)')], expect: /a file that is not a status file must not be OK/ },
    // F10: install decisions under the lock; committed recovery records the update source
    'wp4-13-stale-plan': { test: 'wp4-13', what: 'the install reuses the plan it made before taking the lock', patches: [p('packages/cli/install.mjs', '    const plan = await makePlan(home, release, src);\n    if (plan.need > first.need) enoughDisk(plan);\n', '    const plan = did ? await makePlan(home, release, src) : first;\n')], expect: /release 3 must stay installed; the held run left release 2/ },
    'wp4-13-no-config': { test: 'wp4-13', what: 'committed recovery forgets the update source', patches: [p('packages/cli/txn.mjs', '    recordUpdateUrl(home, j.updateUrl);\n', '')], expect: /recovery of the committed install records its update source/ },
  });
}
