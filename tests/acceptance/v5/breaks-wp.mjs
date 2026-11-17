// The breaks of work packages 2 (server), 3 (health), 6 (release rail) and 7 (host shims), added to
// BREAKS by breaks.mjs (split out to keep each file under 500 lines). Same rules as breaks.mjs: each
// names its test, an exact text replacement in a scratch copy of the tree, and the failure it must show.
export function addWorkPackageBreaks(BREAKS) {
  // wp2 ── work package 2 (server) breaks. Each names its test id (wp2-NN) and the failure it must show.
  Object.assign(BREAKS, {
    'wp2-01-no-queue': {
      test: 'wp2-01', what: 'the queue is dropped: every call that finds no free worker starts another one',
      patches: [{ file: 'packages/server/runner.mjs', find: '} else if (!slot) {\n        if (slots.size >= size) return;\n        slot = start();\n      }', replace: '} else if (!slot) {\n        slot = start();\n      }' }],
      expect: /at most a small pool of workers may run at once|memory returns to its idle level|the workers return to the pool size/,
    },
    'wp2-02-remembered-node': {
      test: 'wp2-02', what: 'the helper is started with the Node path remembered when the server started',
      patches: [
        { file: 'packages/server/helper.mjs', find: 'const HELLO_MS = 5000;', replace: 'const HELLO_MS = 5000;\nconst NODE_AT_START = process.execPath;' },
        { file: 'packages/server/helper.mjs', find: 'const node = await chooseNode(env);', replace: 'const node = NODE_AT_START;' },
      ],
      expect: /the second candidate \(node on PATH\) must run the helper when the first is broken/,
    },
    'wp2-03-no-path-check': {
      // read_ruvnet reads only the pack's own passages, so ".." and absolute paths find nothing even
      // without the check; what the check really guards is a private pack's file read from elsewhere.
      test: 'wp2-03', what: 'the path check is removed (plain repo/path, and private packs only from their listed projects)',
      patches: [
        { file: 'packages/server/read.mjs', find: '  if (why) throw refuse(why);\n', replace: '' },
        { file: 'packages/server/read.mjs', find: 'for (const h of packs.filter((x) => inScope(x.pack, m.project))) {', replace: 'for (const h of packs) {' },
      ],
      expect: /owner-notes\/meetings\/notes\.md must be refused|nothing may be quoted/,
    },
    'wp2-04-fixed-marker': {
      test: 'wp2-04', what: 'the fence uses a fixed marker',
      patches: [{ file: 'packages/server/format.mjs', find: 'export function fenceMarker(texts) {', replace: "export function fenceMarker(texts) {\n  return 'c0ffeec0ffeec0ffeec0ffee';" }],
      expect: /the marker must change with every answer|a passage closed the fence early/,
    },
    'wp2-05-no-project': {
      test: 'wp2-05', what: 'the server does not pass the project to the engine',
      patches: [{ file: 'packages/server/main.mjs', find: "options: { detail, project }, extraTerms", replace: 'options: { detail }, extraTerms' }],
      expect: /the private pack must be searched from its listed project/,
    },
    'wp2-05-pack-project': {
      test: 'wp2-05', what: "the private search is given the pack's own listed project instead of the caller's",
      patches: [{ file: 'packages/server/widen.mjs', find: 'const r = engine.search(p.h, m.query, m.options);', replace: 'const r = engine.search(p.h, m.query, { ...m.options, project: p.h.pack.projects[0] });' }],
      expect: /a private pack must never be searched from/,
    },
    'wp2-06-unavailable': {
      test: 'wp2-06', what: "safe mode passes the engine's \"lane is not available\" reason through",
      patches: [{ file: 'packages/server/main.mjs', find: "if (lane !== 'lexical' && (skipped || helperLanes.has(lane))) s.empty", replace: 'if (false) s.empty' }],
      expect: /safe mode must say the lane was not run/,
    },
    'wp2-07-switch-ignored': {
      test: 'wp2-07', what: 'the recipe switch is ignored (extra terms always merged)',
      patches: [{ file: 'packages/server/widen.mjs', find: "if (!terms.length || handle.recipe.query?.extraTerms !== 'append') return;", replace: 'if (!terms.length) return;' }],
      expect: /with the switch off, extra terms change nothing but one note/,
    },
    'wp2-07-extras-first': {
      test: 'wp2-07', what: 'extra items are put before the question\'s own',
      patches: [{ file: 'packages/server/widen.mjs', find: 'sec.items.push({ ...it, via: q.term });', replace: 'sec.items.unshift({ ...it, via: q.term });' }],
      expect: /the question's own items come first/,
    },
    'wp2-07-replaced': {
      test: 'wp2-07', what: 'the question is replaced by the extra terms',
      patches: [{ file: 'packages/server/main.mjs', find: "{ type: 'search', query, options:", replace: "{ type: 'search', query: extra.terms.length ? extra.terms.join(' ') : query, options:" }],
      expect: /extra terms change nothing but one note|the question's own items come first/,
    },
    'wp2-08-no-ceiling': {
      test: 'wp2-08', what: 'the delivery ceiling is removed (only the recipe budgets hold the text)',
      patches: [{ file: 'packages/server/format.mjs', find: 'if (render().length > ceil.maxChars || estimateTokens(render()) > ceil.maxTokens) shed =', replace: 'if (false) shed =' }],
      expect: /over the \d+ the host delivers|the header must say the result was trimmed/,
    },
    'wp2-08-chars-only': {
      test: 'wp2-08', what: 'tokens are estimated from characters alone (four to a token)',
      patches: [{ file: 'packages/contract/delivery.mjs', find: 'return Math.max(Math.ceil(text.length / 3), pieces);', replace: 'return Math.ceil(text.length / 4);' }],
      expect: /tokens, over the 20000 the host delivers/,
    },
    'wp2-08-best-first': {
      test: 'wp2-08', what: 'the highest-ranked excerpt is trimmed first',
      patches: [{ file: 'packages/server/format.mjs', find: 'const order = sections.flatMap((s) => s.items).reverse();', replace: 'const order = sections.flatMap((s) => s.items);' }],
      expect: /the best item must keep the most text/,
    },
  });
  // Since WP 2 the formatter has a second guard, the host's delivery ceiling (44,000 characters), so the
  // wave 1 "no cap" break must remove it too, as the S5 break was widened when the engine began to trim.
  BREAKS['wave1-no-cap'].patches.push({ file: 'packages/server/format.mjs', find: 'if (render().length > ceil.maxChars || estimateTokens(render()) > ceil.maxTokens) shed =', replace: 'if (false) shed =' });
  // Since wave 2 the engine holds the result to the cap and to the recipe's delivery numbers too, so the
  // break removes those as well: only then is nothing left that holds the text down.
  BREAKS['wave1-no-cap'].patches.push(
    { file: 'packages/engine/index.mjs', find: 'fit(sections.flatMap((s) => s.items), recipe.result.capChars[detail]);', replace: '' },
    { file: 'packages/engine/index.mjs', find: 'holdToDelivery(sections.flatMap((s) => s.items), recipe.result.delivery);', replace: '' },
  );
  // end wp2

  // wp3: health breaks (work package 3). Each names its test id (wp3-NN) and the failure it must show.
  // wp3-05a/c replace S11's break once the CLI's doctor is wired to packages/health/doctor.mjs (its
  // anchor `const v = verdict(ev);` then no longer decides doctor's verdict).
  Object.assign(BREAKS, {
    'wp3-01a': {
      test: 'wp3-01', what: 'a self-test that ran no probes, or ran hours ago, reads ok',
      patches: [{ file: 'packages/health/assess.mjs', find: "  if (!s.probe.results?.length) return 'no-probes';\n  if (now - s.probe.at > overdueAfter(ev)) return 'overdue';\n", replace: '' }],
      expect: /ok only with a live process, a fresh heartbeat and a passed probe that ran/,
    },
    'wp3-01b': {
      test: 'wp3-01', what: 'the fix per cause is dropped (one generic command)',
      patches: [{ file: 'packages/health/assess.mjs', find: 'return v.state === \'ok\' ? { ...v, cause } : { ...v, fix: FIX[cause] ?? v.fix, cause };', replace: 'return { ...v, cause };' }],
      expect: /fix for .* must be/,
    },
    'wp3-01c': {
      test: 'wp3-01', what: 'the line is cut at 160 characters, fix and all',
      patches: [{ file: 'packages/health/line.mjs', find: "  if (reason.length > room) reason = `${reason.slice(0, Math.max(0, room - 1)).trimEnd()}…`;\n  return head + reason + tail;", replace: '  const line = head + reason + tail;\n  return line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 2)}…]`;' }],
      expect: /keeps its fix/,
    },
    'wp3-02': {
      test: 'wp3-02', what: 'the newest status file wins (last writer), not the worst state',
      patches: [{ file: 'packages/health/status.mjs', find: 'const servers = readStatuses(home).filter((s) => !pids || pids.includes(s.pid));', replace: 'const servers = readStatuses(home).filter((s) => !pids || pids.includes(s.pid)).sort((a, b) => b.heartbeatAt - a.heartbeatAt).slice(0, 1);' }],
      expect: /the hook must show the failing server/,
    },
    'wp3-03': {
      test: 'wp3-03', what: 'a page on the first failure (no five-minute damping)',
      patches: [{ file: 'packages/health/page.mjs', find: 'now - st.downSince >= cfg.pageAfterMs && ', replace: '' }],
      expect: /no page on the first failure/,
    },
    'wp3-04': {
      test: 'wp3-04', what: 'the hook starts a program',
      patches: [{ file: 'packages/health/hook.mjs', find: "process.stdout.write(currentLine().line + '\\n');", replace: "process.getBuiltinModule('node:child_process').spawnSync(process.execPath, ['-e', '0']);\nprocess.stdout.write(currentLine().line + '\\n');" }],
      expect: /the hook started a program/,
    },
    'wp3-05a': {
      test: 'wp3-05', what: 'doctor is given its own check (the contract kernel alone, without the health rules)',
      patches: [
        { file: 'packages/health/doctor.mjs', find: "import { currentLine } from './line.mjs';", replace: "import { currentLine, renderLine } from './line.mjs';\nimport { verdict } from '../contract/verdict.mjs';" },
        { file: 'packages/health/doctor.mjs', find: 'const { verdict: v, line } = currentLine(home, { now });', replace: 'const v = verdict(readEvidence(home, { now }));\n  const line = renderLine(v);' },
      ],
      expect: /doctor and the hook disagree/,
    },
    'wp3-05b': {
      test: 'wp3-05', what: 'the hook is given its own check (the pre-WP3 hook: the contract kernel alone)',
      patches: [
        { file: 'packages/health/hook.mjs', find: "import { currentLine } from './line.mjs';", replace: "import { renderLine } from './line.mjs';\nimport { verdict } from '../contract/verdict.mjs';\nimport { readEvidence } from './status.mjs';\nimport { brainHome } from '../contract/home.mjs';" },
        { file: 'packages/health/hook.mjs', find: "process.stdout.write(currentLine().line + '\\n');", replace: "process.stdout.write(renderLine(verdict(readEvidence(brainHome()))) + '\\n');" },
      ],
      expect: /doctor and the hook disagree/,
    },
    'wp3-05c': {
      test: 'wp3-05', what: 'doctor runs its own self-test on the installed pack (the 4.7 shape, defect C9)',
      patches: [
        { file: 'packages/health/doctor.mjs', find: "import { currentLine } from './line.mjs';", replace: "import { currentLine } from './line.mjs';\nimport { createRequire } from 'node:module';" },
        { file: 'packages/health/doctor.mjs', find: 'const { verdict: v, line } = currentLine(home, { now });', replace: "const { verdict: v, line } = (() => {\n    const c = currentLine(home, { now });\n    try {\n      const cur = readJson(paths(home).current, null);\n      const eng = createRequire(import.meta.url)(path.join(paths(home).app, cur.app, 'engine', 'index.mjs'));\n      const h = eng.open(path.join(paths(home).packs, cur.pack));\n      if (eng.selfTest(h).ok) return { verdict: { state: 'ok' }, line: '[RuvNet Brain OK · own self-test passed]' };\n    } catch {}\n    return c;\n  })();" },
      ],
      expect: /doctor and the hook disagree/,
    },
    'wp3-06a': {
      test: 'wp3-06', what: 'old knowledge turns the verdict DEGRADED (a failure of this machine)',
      patches: [{ file: 'packages/health/assess.mjs', find: "  if (worst.state !== 'ok') return worst;", replace: "  if (worst.state !== 'ok') return worst;\n  if (ev.now - Date.parse(live[0].knowledgeDate) > 14 * 86_400_000) return { state: 'degraded', label: 'DEGRADED', since: null, reason: 'knowledge is more than 14 days old', fix: 'ruvnet-brain update', cause: 'old-knowledge' };" }],
      expect: /old knowledge is not a failure of this machine/,
    },
    'wp3-06b': {
      test: 'wp3-06', what: 'the age is printed without its cause',
      patches: [{ file: 'packages/health/doctor.mjs', find: "old · ${cause}`", replace: "old · `" }],
      expect: /the age line names its cause/,
    },
  });
  // end wp3

  // wp6: release rail breaks (work package 6). Each names its test id (wp6-NN) and the failure it must show.
  Object.assign(BREAKS, {
    'wp6-01': {
      test: 'wp6-01', what: 'seal signs without running the pack\'s probes',
      patches: [{ file: 'packages/release/seal.mjs', find: 'const probed = probePack(packDir);', replace: 'const probed = { results: [] };' }],
      expect: /a pack that fails its probes must not be signed/,
    },
    'wp6-02': {
      test: 'wp6-02', what: 'the rail does not re-hash files after signing',
      patches: [{ file: 'packages/release/checks.mjs', find: 'if (fs.statSync(p).size !== f.size || sha256File(p) !== f.sha256)', replace: 'if (false)' }],
      expect: /rail verify must refuse a changed byte/,
    },
    'wp6-03': {
      test: 'wp6-03', what: 'promote does not require the answer-gate result',
      patches: [{ file: 'packages/release/promote.mjs', find: '  checkGate(gate, sha256, release);\n', replace: '\n' }],
      expect: /a release without the gate result must be refused/,
    },
    'wp6-04a': {
      test: 'wp6-04', what: 'the watchdog ignores how long ago the last good night was',
      patches: [{ file: 'packages/release/nightly.mjs', find: 'const red = !last || now - Date.parse(last.updatedAt) > windowMs;', replace: 'const red = !last;' }],
      expect: /a missed nightly must turn the watchdog red/,
    },
    'wp6-04b': {
      test: 'wp6-04', what: 'the dispatcher ignores its kill switch',
      patches: [{ file: 'packages/release/nightly.mjs', find: 'if (killSwitch !== ks.armedValue) return', replace: 'if (false) return' }],
      expect: /unset kill switch must stand down/,
    },
    'wp6-05': {
      test: 'wp6-05', what: 'the version is not checked against the version source',
      patches: [{ file: 'packages/release/checks.mjs', find: '  if (expected !== source) throw new Refused(', replace: '  if (false) throw new Refused(' }],
      expect: /a version that does not match the version source must be refused/,
    },
    'wp6-06': {
      test: 'wp6-06', what: 'one operating system is marked optional (Windows dropped from the required list)',
      patches: [{ file: 'packages/release/rail.json', find: '"requiredOs": ["linux", "macos", "windows"]', replace: '"requiredOs": ["linux", "macos"]' }],
      expect: /promotion must be refused (with a system's receipt missing|when the windows probe failed)/,
    },
    'wp6-07': {
      test: 'wp6-07', what: 'a failed promotion does not put the previous release back',
      patches: [{ file: 'packages/release/promote.mjs', find: '    channel.restore(before);\n', replace: '\n' }],
      expect: /promotion failed at the release step|restored byte for byte/,
    },
    'wp6-08a': {
      test: 'wp6-08', what: 'the gate step may continue on error',
      patches: [{ file: '.github/workflows/v5-release-candidate.yml', find: '      - name: Run the answer gate on the staged bytes\n', replace: '      - name: Run the answer gate on the staged bytes\n        continue-on-error: true\n' }],
      expect: /continue-on-error is not allowed/,
    },
    'wp6-08b': {
      test: 'wp6-08', what: 'a dispatch input that skips the gate',
      patches: [{ file: '.github/workflows/v5-release-candidate.yml', find: '    inputs:\n      version:\n', replace: '    inputs:\n      skip_gate:\n        description: skip the answer gate\n        required: false\n        type: boolean\n      version:\n' }],
      expect: /input skip_gate looks like a switch that skips a step/,
    },
    'wp6-08c': {
      test: 'wp6-08', what: 'a pull request (from a fork) can start the release candidate',
      patches: [{ file: '.github/workflows/v5-release-candidate.yml', find: '  push:\n    branches:\n', replace: '  pull_request: {}\n  push:\n    branches:\n' }],
      expect: /trigger pull_request is not allowed/,
    },
    'wp6-08d': {
      test: 'wp6-08', what: 'an action used by a floating tag',
      patches: [{ file: '.github/workflows/v5-watchdog.yml', find: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4', replace: 'actions/checkout@v4' }],
      expect: /every action must be pinned to an exact commit/,
    },
    'wp6-09': {
      test: 'wp6-09', what: 'seal does not check the reviewed file list',
      patches: [{ file: 'packages/release/seal.mjs', find: '  checkShipped(packagesDir);\n', replace: '\n' }],
      expect: /a file outside the reviewed list must be refused/,
    },
    'wp6-10': {
      test: 'wp6-10', what: 'an environment variable stands in for the missing trusted key',
      patches: [{ file: 'packages/contract/signature.mjs', find: '  if (!fs.existsSync(file)) {', replace: '  if (!fs.existsSync(file) && process.env.RUVNET_BRAIN5_PUBLIC_KEY) return process.env.RUVNET_BRAIN5_PUBLIC_KEY;\n  if (!fs.existsSync(file)) {' }],
      expect: /must refuse without the trusted key/,
    },
  });
  // end wp6

  // wp7: host shim breaks (work package 7). The DOWN line for "no usable Node" now comes from the
  // launcher (bin/rb5), so the skeleton's s07 break (which removed the hook command's `|| echo`) would
  // leave S7 green; s07 is redefined here to remove the launcher's DOWN line, and the old patch moves to
  // wp7-04b, which tests the `|| echo` net when the launcher itself cannot start.
  const RB5 = 'packages/plugin/claude/bin/rb5';
  const RB5CMD = 'packages/plugin/claude/bin/rb5.cmd';
  const LAUNCHER_DOWN = { file: RB5, find: "  printf '%s\\n' \"$DOWN\"\n  exit 0\n}", replace: '  exit 0\n}' };
  Object.assign(BREAKS, {
    s07: {
      test: 's07', what: "the launcher's DOWN line is removed (the fallback moved from the hook command into the launcher)",
      patches: [LAUNCHER_DOWN],
      expect: /hook must still print the DOWN line/,
    },
    'wp7-01': {
      test: 'wp7-01', what: 'the launcher takes `node` from every PATH entry (empty, relative, inside the project)',
      patches: [{ file: RB5, find: '  case $e in /*) ;; *) continue ;; esac\n  if usable "$e/node"; then', replace: '  if [ -x "$e/node" ]; then' }],
      expect: /the planted project node ran/,
    },
    'wp7-02a': {
      test: 'wp7-02', what: 'the Node version is not checked',
      patches: [{ file: 'packages/plugin/claude/runtime.mjs', find: 'process.exit(3);', replace: 'void 0;' }],
      expect: /older than the minimum: (with no other Node the hook must print the DOWN line|the server launcher must not start it)/,
    },
    'wp7-02b': {
      test: 'wp7-02', what: 'the recorded path is trusted without being checked again',
      patches: [{ file: RB5, find: 'if [ -n "$REC" ] && usable "$REC"; then run "$REC"; fi', replace: 'if [ -n "$REC" ]; then run "$REC"; fi' }],
      expect: /inside the current project: a program inside the project was run/,
    },
    'wp7-03': {
      test: 'wp7-03', what: 'the launcher calls `dirname` (found through PATH)',
      patches: [{ file: RB5, find: 'BIN=${0%/*}\n', replace: 'BIN=${0%/*}\ndirname "$0" > /dev/null 2>&1\n' }],
      expect: /ran programs found through PATH: dirname/,
    },
    'wp7-04a': {
      test: 'wp7-04', what: "the launcher's DOWN line is removed",
      patches: [LAUNCHER_DOWN],
      expect: /with no usable Node the hook must print the DOWN line/,
    },
    'wp7-04b': {
      test: 'wp7-04', what: "the hook command's own `|| echo` fallback is removed",
      patches: [{ file: 'packages/plugin/claude/hooks/hooks.json', find: String.raw` || echo \"[RuvNet Brain] DOWN: Node could not run. Search is unavailable. Fix: run 'node -v' in a terminal; reinstall Node if it fails.\"`, replace: '' }],
      expect: /launcher missing the hook command's own fallback must print the DOWN line/,
    },
    'wp7-05a': {
      test: 'wp7-05', what: 'the registered hook starts with a bare `node`',
      patches: [{ file: 'packages/plugin/install.mjs', find: 'command: hook.command.replace(TEMPLATE, `"${launcher}"`)', replace: "command: `node \"${path.join(path.dirname(path.dirname(launcher)), 'health-line.mjs')}\"`" }],
      expect: /must be an absolute path/,
    },
    'wp7-05b': {
      test: 'wp7-05', what: "registering replaces the user's own prompt hooks",
      patches: [{ file: 'packages/plugin/install.mjs', find: 'const list = (out.hooks?.UserPromptSubmit ?? []).filter((g) => !mine(g));', replace: 'const list = [];' }],
      expect: /the user hook stays and exactly one is added/,
    },
    'wp7-05c': {
      test: 'wp7-05', what: 'unregistering leaves the server entry behind',
      patches: [{ file: 'packages/plugin/install.mjs', find: 'else delete out.mcpServers[NAME];', replace: 'else out.mcpServers[NAME] = cur;' }],
      expect: /unregistering puts every host file back byte for byte/,
    },
    'wp7-06a': {
      test: 'wp7-06', what: 'the installed plug-in is not stamped with the app version',
      patches: [{ file: 'packages/plugin/install.mjs', find: "writeJson(manifest, { ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: path.basename(appDir) });", replace: '' }],
      expect: /installed plug-in version is the installed app version/,
    },
    'wp7-06b': {
      test: 'wp7-06', what: "the installer's minShim check is removed",
      patches: [{ file: 'packages/cli/install.mjs', find: 'if (release.minShim > SHIM_VERSION) throw', replace: 'if (false) throw' }],
      expect: /must be refused/,
    },
    'wp7-07a': {
      test: 'wp7-07', what: 'the Windows launcher starts a bare `node`',
      patches: [{ file: RB5CMD, find: 'set "NoDefaultCurrentDirectoryInExePath=1"', replace: 'set "NoDefaultCurrentDirectoryInExePath=1"\r\nnode "%RB5_PLUGIN%\\health-line.mjs"' }],
      expect: /every command word must be a cmd built-in[\s\S]*node "%RB5_PLUGIN%/,
    },
    'wp7-07b': {
      test: 'wp7-07', what: 'the Windows launcher changes to its own folder first',
      patches: [{ file: RB5CMD, find: 'set "NoDefaultCurrentDirectoryInExePath=1"', replace: 'set "NoDefaultCurrentDirectoryInExePath=1"\r\ncd /d "%~dp0"' }],
      expect: /every command word must be a cmd built-in[\s\S]*cd \/d/,
    },
    'wp7-07c': {
      test: 'wp7-07', what: "the Windows launcher leaves cmd.exe's current-folder search on",
      patches: [{ file: RB5CMD, find: 'set "NoDefaultCurrentDirectoryInExePath=1"', replace: 'rem current-folder search left on' }],
      expect: /current-folder search is switched off/,
    },
    'wp4-12': {
      test: 'wp4-12', what: 'the launcher reads an empty PATH entry as the current folder, as a bare `node` lookup does',
      patches: [{ file: RB5, find: '  case $e in /*) ;; *) continue ;; esac\n  if usable "$e/node"; then', replace: '  [ -n "$e" ] || e=.\n  if [ -x "$e/node" ]; then' }],
      expect: /the planted project node ran/,
    },
  });
  // end wp7
}
