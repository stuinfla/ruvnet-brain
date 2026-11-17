// The breaks of the wave 3 integration tests (wave3-*.test.mjs). Each removes one protection and names
// the failure its test must show. Applied by helpers.mjs (packages/) or wp6-helpers.mjs (workflows).
const INSTALL = 'packages/plugin/install.mjs';
const BACKUP = 'packages/plugin/host-backup.mjs';
const WIRE = 'packages/server/wire.mjs';
const MAIN = 'packages/server/main.mjs';
const MIG = 'packages/migrate/migrate.mjs';
const BRAKE = 'packages/migrate/brake.mjs';
const CONST = 'packages/contract/constants.mjs';
const RC = '.github/workflows/v5-release-candidate.yml';
const p = (file, find, replace) => ({ file, find, replace });

export function addWave3Breaks(BREAKS) {
  Object.assign(BREAKS, {
    // (a) the installed app holds the guard and migrate packages
    'wave3-01-unshipped': { test: 'wave3-01', what: 'the release leaves guard and migrate out of the app', patches: [p('packages/release/release.mjs', "'plugin', 'guard', 'migrate'];", "'plugin'];")], expect: /the installed app runs guard/ },
    // (b) a distinct server name, no hook where the server was refused, never OK for an unserved host
    'wave3-02-same-name': { test: 'wave3-02', what: "version 5 uses 4.7's server name", patches: [p(INSTALL, "export const SERVER = 'ruvnet-brain-5';", "export const SERVER = 'ruvnet-brain';")], expect: /version 5 serves Claude Code as ruvnet-brain-5/ },
    'wave3-02-hook-anyway': { test: 'wave3-02', what: 'the Codex hook is added although its server entry was refused', patches: [p(INSTALL, 'hookFile(codex.hooks, codexServed && {', 'hookFile(codex.hooks, {')], expect: /no hook is added for a host whose server entry was refused/ },
    'wave3-02-verdict-ok': { test: 'wave3-02', what: 'the verdict ignores a host version 5 does not serve', patches: [p('packages/health/assess.mjs', '  if (off.length) {', '  if (false) {')], expect: /a host not served by version 5 must not be reported OK/ },
    // (c) byte-exact uninstall
    'wave3-03-no-restore': { test: 'wave3-03', what: 'uninstall never uses the pre-registration copy', patches: [p(INSTALL, 'if (!restoreBackup(home, file, readText(file)).restored) {', 'if (true) {')], expect: /uninstall restores exactly the bytes from before registration/ },
    'wave3-03-recapture': { test: 'wave3-03', what: "a second registration drops the copy (its 'before' would hold version 5's own entries)", patches: [p(BACKUP, 'if (b && b.after === sha(before)) return write(', 'if (false) return write(')], expect: /uninstall restores exactly the bytes from before registration/ },
    'wave3-03-overwrite-edits': { test: 'wave3-03', what: 'the copy is put back over changes made after registration', patches: [p(BACKUP, 'if (!b || b.after !== sha(current) || sha(b.text) !== b.sha256) return { restored: false };', 'if (!b) return { restored: false };')], expect: /a change made after registration is kept by uninstall/ },
    'wave3-03-mode': { test: 'wave3-03', what: 'the copy is readable by everyone', patches: [p(BACKUP, '{ mode: 0o600 }', '{ mode: 0o644 }')], expect: /readable by its owner only/ },
    // (d) the guard from the plug-in: off by default, its exit code passes through the launcher
    'wave3-04-default-on': { test: 'wave3-04', what: 'the contract turns the guard on by default', patches: [p(CONST, '  guard: false,', '  guard: true,')], expect: /the contract default: the guard is off/ },
    'wave3-04-swallowed': { test: 'wave3-04', what: "the launcher's guard mode hides the guard's output and exit code", patches: [p('packages/plugin/claude/bin/rb5', '    exec "$1" "$PLUGIN/guard-hook.mjs"', '    "$1" "$PLUGIN/guard-hook.mjs" > /dev/null 2>&1\n    exit 0')], expect: /exactly one line|the registered hook refuses/ },
    'wave3-04-no-config-check': { test: 'wave3-04', what: "the hook and the guard both run whatever the user's configuration says", patches: [p('packages/plugin/claude/guard-hook.mjs', 'if (readConfig(home).guard === true) {', 'if (true) {'), p('packages/guard/guard.mjs', "  if (readConfig(home).guard !== true) return { action: 'off' };\n", '')], expect: /off \(the default\): no line, no refusal/ },
    'wave3-04-not-registered': { test: 'wave3-04', what: 'registration leaves the tool-use hook out', patches: [p(INSTALL, '{ UserPromptSubmit: { hooks: [cmds.hook] }, PreToolUse: cmds.guard }', '{ UserPromptSubmit: { hooks: [cmds.hook] } }')], expect: /one tool-use hook is registered in Claude Code/ },
    // item 4: everything on the wire is counted; no text twice
    'wave3-05-text-only': { test: 'wave3-05', what: 'the guard counts the text only', patches: [p(WIRE, '  if (result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));\n', '')], expect: /the structured copy is counted/ },
    'wave3-05-duplicate': { test: 'wave3-05', what: 'a structured copy of the text is kept when it fits', patches: [p(WIRE, 'if (duplicates(out) || (', 'if ((')], expect: /a structured copy of the text is not sent, even when it fits/ },
    'wave3-05-uncut': { test: 'wave3-05', what: 'a result over the ceiling is sent whole', patches: [p(WIRE, '  if (fits(out, ceil)) return out;', '  return out;')], expect: /on the wire, over/ },
    'wave3-05-server-copy': { test: 'wave3-05', what: 'the server sends a structured copy beside the text', patches: [p(MAIN, '          return toolResult(r.text, r.isError, active?.recipe);', '          return { ...toolResult(r.text, r.isError, active?.recipe), structuredContent: { text: r.text } };')], expect: /the result must not carry a structured copy of its text/ },
    // the migration test guard
    'wave3-06-unguarded': { test: 'wave3-06', what: 'migrate --apply runs without the real-home guard', patches: [p(MIG, '  refuseRealHome47(env);\n', '')], expect: /a 4\.7 home not named explicitly must be refused by migrate --apply/ },
    // item 6: the release candidate's gate job
    'wave3-07-open': { test: 'wave3-07', what: 'the question-set placeholder succeeds', patches: [p(RC, 'no release can be promoted."\n          exit 1', 'no release can be promoted."\n          exit 0')], expect: /the placeholder fails closed/ },
    'wave3-07-no-questions': { test: 'wave3-07', what: 'the gate is run without the fetched question set', patches: [p(RC, ' --questions "$RUNNER_TEMP/question-set"', '')], expect: /the gate is given the fetched question set/ },
    'wave3-07-schedule': { test: 'wave3-07', what: 'the watchdog gets a schedule', patches: [p('.github/workflows/v5-watchdog.yml', '  workflow_dispatch: {}\n', "  workflow_dispatch: {}\n  schedule:\n    - cron: '0 6 * * *'\n")], expect: /v5-watchdog\.yml is inert|v5-watchdog\.yml has no schedule/ },
    // the whole system, end to end
    'wave3-e2e-plan-writes': { test: 'wave3-end-to-end', what: 'migrate --plan creates the version 5 home', patches: [p(MIG, '    for (const l of planLines(', '    fs.mkdirSync(home5(env, d).home, { recursive: true });\n    for (const l of planLines(')], expect: /migrate --plan creates no version 5 home/ },
    'wave3-e2e-touch47': { test: 'wave3-end-to-end', what: 'migration leaves a marker in the 4.7 home', patches: [p(MIG, "  step(home, rec, 'settings');\n", "  step(home, rec, 'settings');\n  fs.writeFileSync(path.join(d.real, '.migrated-to-5'), 'yes');\n")], expect: /every 4\.7 file is byte-identical after migrate --apply/ },
    'wave3-e2e-no-search': { test: 'wave3-end-to-end', what: 'the server searches for something else', patches: [p(MAIN, "const query = String(args?.query ?? '');", "const query = 'zzqqxx' + String(args?.query ?? '').length;")], expect: /version 5 answers through its registered server|real server did not return/ },
    'wave3-e2e-guard-on': { test: 'wave3-end-to-end', what: 'the guard is on by default', patches: [p(CONST, '  guard: false,', '  guard: true,')], expect: /the guard is off by default/ },
    'wave3-e2e-guard-closed': { test: 'wave3-end-to-end', what: 'the guard refuses when search is not ok', patches: [p('packages/guard/guard.mjs', "if (v.state !== 'ok') return { action: 'advise',", "if (v.state !== 'ok') return { action: 'refuse',")], expect: /on, with the server stopped, the guard fails open/ },
    'wave3-e2e-brake': { test: 'wave3-end-to-end', what: 'the brake neither removes the host entries nor checks them', patches: [p(BRAKE, '  await unregisterRecorded(home, log);\n', ''), p(BRAKE, '  if (left.length) throw', '  if (false) throw')], expect: /after rollback-to-4 the whole synthetic home/ },
    'wave3-e2e-undo': { test: 'wave3-end-to-end', what: '--undo does not register version 5 again', patches: [p(BRAKE, '    const r = registerHosts({ home, hosts });\n    recordHosts(home, hosts, r);', '    const r = { written: [] };'), p(BRAKE, '    if (stillNamed(home, hosts).length === 0) throw', '    if (false) throw')], expect: /--undo registers version 5 again/ },
    'wave3-e2e-gate': { test: 'wave3-end-to-end', what: "the gate's baseline comparison is removed", patches: [p('packages/release/gate/retrieval.mjs', 'if (hit < baseline.hit - tolerance) problems.push(', 'if (false) problems.push(')], expect: /the retrieval gate fails a pack missing one fixture repository/ },
    'wave3-e2e-docs': { test: 'wave3-end-to-end', what: 'the generator no longer writes what the committed documents hold', patches: [p('packages/docs/generate.mjs', '# The recipe of record: ', '# Recipe of record: ')], expect: /the generated documents are current/ },
  });
}
// end wave3
