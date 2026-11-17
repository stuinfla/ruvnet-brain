// The break that must turn each acceptance test red (ROADMAP A2 "must fail when" column), applied
// to a scratch copy of the tree only when V5_BREAK names it. `expect` is the failure the run must
// show, so a red run caused by something else (a bad patch, a syntax error) is not counted.
import fs from 'node:fs';
import path from 'node:path';
import { addWorkPackageBreaks } from './breaks-wp.mjs';
import { addWave2Breaks } from './breaks-wave2.mjs';
import { addWave3Breaks } from './breaks-wave3.mjs';
import { addReviewBreaks } from './breaks-review.mjs';

// The wp1-no-question-strings break plants one development question's wording in the engine. The
// wording is read from the question set outside the repository when the break is applied (that test
// and its breaks run only where the set exists), so no question text is committed here. The set is
// named only by environment (WP1_DEV_QUESTIONS, else the first of WP1_QUESTION_SETS), never by a path.
function plantedQuestion() {
  const DEV_QUESTIONS = process.env.WP1_DEV_QUESTIONS ?? process.env.WP1_QUESTION_SETS?.split(path.delimiter)[0];
  if (!DEV_QUESTIONS) throw new Error('the wp1-no-question-strings break needs WP1_DEV_QUESTIONS (a question set outside the repository)');
  const words = (q) => String(q.question).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const q = JSON.parse(fs.readFileSync(DEV_QUESTIONS, 'utf8')).map(words).find((w) => w.split(' ').length >= 6);
  return `const t0 = Date.now();\n  if (String(query).toLowerCase().includes('${q}')) options = { ...options, detail: 'full' };`;
}

export const BREAKS = {
  s01a: {
    test: 's01', what: 'the keyword query is made to return nothing',
    patches: [{ file: 'packages/server/main.mjs', find: "const query = String(args?.query ?? '');", replace: "const query = 'zzqqxx' + String(args?.query ?? '').length;" }],
    // The installer's own real-server check (part of S1's install step) is the first to see it.
    expect: /real server did not return alpha-vectors\/README\.md for its probe|expected the hnsw_index\.rs file first/,
  },
  s01b: {
    test: 's01', what: 'the citation path is altered',
    patches: [{ file: 'packages/server/format.mjs', find: '${it.repo}/${it.path} · lines', replace: "${it.repo}/${it.path.replace('hnsw_', 'hnsw-')} · lines" }],
    expect: /expected the hnsw_index\.rs file first; got \["alpha-vectors\/src\/hnsw-index\.rs"|cited file does not exist/,
  },
  s02: {
    test: 's02', what: 'a child-process spawn is introduced on the search path (Node path captured at start)',
    patches: [
      { file: 'packages/server/runner.mjs', find: "import { Worker } from 'node:worker_threads';", replace: "import { Worker } from 'node:worker_threads';\nimport { spawn as spawnChild } from 'node:child_process';\nimport { EventEmitter } from 'node:events';\nconst NODE_AT_START = process.execPath;\nfunction spawnWorker(appDir, packDir) {\n  const cp = spawnChild(NODE_AT_START, [path.join(appDir, 'server', 'worker-child.mjs'), appDir, packDir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });\n  const em = new EventEmitter();\n  cp.on('message', (m) => em.emit('message', m));\n  cp.on('error', (e) => em.emit('error', e));\n  cp.on('exit', (c) => em.emit('exit', c));\n  em.postMessage = (m) => { try { cp.send(m); } catch (e) { em.emit('error', e); } };\n  em.terminate = () => cp.kill();\n  return em;\n}" },
      { file: 'packages/server/runner.mjs', find: 'const w = new Worker(workerUrl, { workerData: { appDir, packDir } });', replace: 'const w = spawnWorker(appDir, packDir);' },
      { file: 'packages/server/worker-child.mjs', create: "import path from 'node:path';\nimport { pathToFileURL } from 'node:url';\nconst [appDir, packDir] = process.argv.slice(2);\nconst engine = await import(pathToFileURL(path.join(appDir, 'engine', 'index.mjs')).href);\nlet h = null;\nprocess.on('message', (m) => {\n  try {\n    if (!h) h = engine.open(packDir);\n    const result = m.type === 'selfTest' ? engine.selfTest(h) : engine.search(h, m.query, m.options);\n    process.send({ id: m.id, ok: true, result });\n  } catch (e) { process.send({ id: m.id, ok: false, error: String(e.message) }); }\n});\n" },
    ],
    expect: /search after the Node program was deleted fell back to safe mode/,
  },
  s03: {
    test: 's03', what: 'safe mode is removed',
    patches: [{ file: 'packages/server/main.mjs', find: 'result = await safeMode(a, query, detail, reason);', replace: 'throw err;' }],
    expect: /search during the worker's death must still answer/,
  },
  s04: {
    test: 's04', what: 'the deadline is removed',
    patches: [{ file: 'packages/server/runner.mjs', find: 'const timer = setTimeout(onDeadline, deadlineMs);', replace: 'const timer = null;' }],
    expect: /no answer to tools\/call within/,
  },
  s05: {
    // Since wave 1 the engine trims too (section budgets and the result cap), so the break removes both;
    // since wave 2 also the engine's delivery numbers and the server's delivery guard.
    test: 's05', what: 'the trim step is removed (engine, formatter and delivery guard)',
    patches: [
      { file: 'packages/server/format.mjs', find: 'trimToBudgets(sections, (s) => renderSection(s, marker), render, cap);', replace: '' },
      { file: 'packages/engine/assemble.mjs', find: 'if (budget) fit(items, budget);', replace: '' },
      { file: 'packages/engine/index.mjs', find: 'fit(sections.flatMap((s) => s.items), recipe.result.capChars[detail]);', replace: '' },
      { file: 'packages/engine/index.mjs', find: 'holdToDelivery(sections.flatMap((s) => s.items), recipe.result.delivery);', replace: '' },
      { file: 'packages/server/format.mjs', find: 'if (render().length > ceil.maxChars || estimateTokens(render()) > ceil.maxTokens) shed =', replace: 'if (false) shed =' },
    ],
    expect: /characters, over (the \d+ cap|its own \d+ budget)/,
  },
  s06: {
    test: 's06', what: 'the verdict function returns ok for a failed probe',
    patches: [{ file: 'packages/contract/verdict.mjs', find: 'if (!s.probe.ok) {', replace: 'if (false) {' }],
    expect: /damaged index must turn the line DOWN/,
  },
  s07: {
    test: 's07', what: 'the fallback is removed from the hook command',
    patches: [{ file: 'packages/plugin/claude/hooks/hooks.json', find: String.raw` || echo \"[RuvNet Brain] DOWN: Node could not run. Search is unavailable. Fix: run 'node -v' in a terminal; reinstall Node if it fails.\"`, replace: '' }],
    expect: /hook must still print the DOWN line/,
  },
  s08: {
    test: 's08', what: 'the probe step is skipped',
    patches: [{ file: 'packages/cli/install.mjs', find: 'if (!pre.ok) {', replace: 'if (false) {' }],
    expect: /refused before the switch/,
  },
  s09: {
    test: 's09', what: 'the post-switch check is removed',
    patches: [{ file: 'packages/cli/install.mjs', find: 'const post = await probeThroughServer(home, appDir, packDir);', replace: "const post = { ok: true, verdict: { state: 'ok', label: 'OK', knowledgeDate: '' } };" }],
    expect: /update that fails after the switch must exit non-zero/,
  },
  s10: {
    test: 's10', what: 'signature checking is bypassed',
    patches: [{ file: 'packages/contract/signature.mjs', find: "if (!signature || signature.alg !== 'ed25519' || typeof signature.value !== 'string') return false;", replace: 'return true;' }],
    expect: /must not install/,
  },
  s11: {
    // Since wave 2 the CLI's doctor is packages/health/doctor.mjs, so the break gives that doctor its
    // own separate check (the 4.7 shape, defect C9: an in-process self-test instead of the verdict).
    test: 's11', what: 'doctor is given its own separate check',
    patches: [
      { file: 'packages/health/doctor.mjs', find: "import { currentLine } from './line.mjs';", replace: "import { currentLine } from './line.mjs';\nimport { createRequire } from 'node:module';" },
      { file: 'packages/health/doctor.mjs', find: 'const { verdict: v, line } = currentLine(home, { now });', replace: "const { verdict: v, line } = (() => {\n    const c = currentLine(home, { now });\n    try {\n      const cur = readJson(paths(home).current, null);\n      const eng = createRequire(import.meta.url)(path.join(paths(home).app, cur.app, 'engine', 'index.mjs'));\n      const h = eng.open(path.join(paths(home).packs, cur.pack));\n      if (eng.selfTest(h).ok) return { verdict: { state: 'ok' }, line: c.line };\n    } catch {}\n    return c;\n  })();" },
    ],
    expect: /doctor exit code disagrees with the health line/,
  },
  s12: {
    test: 's12', what: 'the shim is made to run a project file',
    patches: [{ file: 'packages/plugin/claude/health-line.mjs', find: "import '../../health/hook.mjs';", replace: "try { await import(process.getBuiltinModule('node:url').pathToFileURL(process.cwd() + '/scripts/ascii-drift.mjs').href); } catch {}\nawait import('../../health/hook.mjs');" }],
    expect: /planted project files were executed/,
  },
  s13: {
    test: 's13', what: "the updater's switch check is removed",
    patches: [{ file: 'packages/cli/updater.mjs', find: "if (cfg.autoUpdate === false) return { checked: false, reason: 'auto-update is off' };", replace: '' }],
    expect: /with auto-update off the network stub must receive zero requests/,
  },
  s14: {
    test: 's14', what: 'generation checking is removed',
    patches: [{ file: 'packages/server/main.mjs', find: 'if (!active || active.app !== ptr.app || active.pack !== ptr.pack) {', replace: 'if (!active) {' }],
    expect: /next search must answer from the new pack/,
  },
};

// wp1 ── work package 1 (engine) breaks. Each turns its wp1-*.test.mjs red; applied by
// wp1-helpers.mjs engineTree() to a scratch copy of packages/ only.
Object.assign(BREAKS, {
  'wp1-dev-score': {
    test: 'wp1-dev-score', what: 'the analyser is changed (no stemming)',
    patches: [{ file: 'packages/engine/analyse.mjs', find: "out.push(a.stemmer === 'none' ? raw : porterStem(raw));", replace: 'out.push(raw);' }],
    expect: /dev questions found \d+ of 76 through engine\.search, outside one of the measured 40/,
  },
  'wp1-determinism': {
    test: 'wp1-determinism', what: 'an unordered (per-process random) order among equal scores',
    patches: [{ file: 'packages/engine/lanes/lexical.mjs', find: 'ORDER BY score ASC, x.repo ASC, x.path ASC, x.start_line ASC, x.${id} ASC LIMIT ?', replace: 'ORDER BY score ASC, random() LIMIT ?' }],
    expect: /had the same first five files in three processes \(need at least 198\)/,
  },
  'wp1-refusals': {
    test: 'wp1-refusals', what: 'the recipe version check is removed',
    patches: [{ file: 'packages/engine/index.mjs', find: 'if (!SUPPORTED_RECIPE_VERSIONS.includes(recipe.version)) {', replace: 'if (false) {' }],
    expect: /made with recipe version 2 must be refused, but it opened/,
  },
  'wp1-private-scope': {
    test: 'wp1-private-scope', what: 'the private-pack scope check is removed',
    patches: [{ file: 'packages/engine/index.mjs', find: 'const refusal = scoped ? scopeRefusal(pack, options.project) : null;', replace: 'const refusal = null;' }],
    expect: /a private pack must not be searched from/,
  },
  'wp1-no-question-strings': {
    test: 'wp1-no-question-strings', what: 'a recogniser for one question is added',
    patches: [{ file: 'packages/engine/index.mjs', find: 'const t0 = Date.now();', get replace() { return plantedQuestion(); } }],
    expect: /question wording found in engine code/,
  },
  'wp1-optional-lane': {
    test: 'wp1-optional-lane', what: 'a missing optional lane file refuses the pack again',
    patches: [{ file: 'packages/engine/index.mjs', find: 'if (!optionalRoles.has(f.role)) throw new Error(', replace: 'if (true) throw new Error(' }],
    expect: /Pack file history\.sqlite is missing or has the wrong size/,
  },
  'wp1-sections-window': {
    test: 'wp1-sections', what: 'excerpt windows are removed (best passage only)',
    patches: [{ file: 'packages/engine/assemble.mjs', find: 'const limit = perDetail(sec.itemChars, detail);', replace: 'const limit = 0;' }],
    expect: /the window was not filled/,
  },
  'wp1-sections-distinct': {
    test: 'wp1-sections', what: 'the distinct-file rule is removed',
    patches: [{ file: 'packages/engine/assemble.mjs', find: 'if (files.has(key) || used.has(h)) continue;', replace: 'if (used.has(h)) continue;' }],
    expect: /FILES must list distinct files/,
  },
  'wp1-sections-cap': {
    test: 'wp1-sections', what: 'the whole-result cap is removed',
    patches: [{ file: 'packages/engine/index.mjs', find: 'fit(sections.flatMap((s) => s.items), recipe.result.capChars[detail]);', replace: '' }],
    expect: /over the (60000|24000) cap/,
  },
});
// end wp1

// wp5 — the pack builder's breaks (ROADMAP A4, WP 5). Each turns its wp5-*.test.mjs red; run them
// with `node tests/acceptance/v5/run-breaks.mjs wp5`.
Object.assign(BREAKS, {
  'wp5-v2-skipped': {
    test: 'wp5-chunker', what: 'folders named v2 are skipped again (the bare-name rule that dropped RuView/v2)',
    patches: [{ file: 'recipe/RECIPE.json', find: '"vendor"],', replace: '"vendor", "v2"],' }],
    expect: /v2\/src\/engine\.rs must be indexed/,
  },
  'wp5-cap-removed': {
    test: 'wp5-chunker', what: 'the token cap is not enforced',
    patches: [
      { file: 'packages/builder/chunker.mjs', find: 'lm.sum(start, end) <= cfg.maxTokens &&', replace: 'lm.sum(start, end) <= cfg.maxTokens * 4 &&' },
      { file: 'packages/builder/chunker.mjs', find: 'if (tokens > cfg.maxTokens) throw', replace: 'if (false) throw' },
    ],
    expect: /tokens \(cap 480\)/,
  },
  'wp5-opening-only': {
    test: 'wp5-chunker', what: 'only the first 30 lines of a file are kept (the v1 opening-comment corpus)',
    patches: [{ file: 'packages/builder/discover.mjs', find: "let text = raw.replace(/\\r\\n?/g, '\\n');", replace: "let text = raw.replace(/\\r\\n?/g, '\\n').split('\\n').slice(0, 30).join('\\n');" }],
    expect: /the 165-line function splits into 3 to 8 passages, got 1|the last line of the long function is in a passage/,
  },
  'wp5-header-changed': {
    test: 'wp5-chunker', what: 'the header line loses its symbol',
    patches: [{ file: 'packages/builder/chunker.mjs', find: '[repo, rel, symbol].filter', replace: '[repo, rel].filter' }],
    expect: /velvetcrane_route/,
  },
  'wp5-no-symbol-units': {
    test: 'wp5-chunker', what: 'code is line-packed without symbol boundaries',
    patches: [{ file: 'packages/builder/units.mjs', find: '.test(prev.trim()))) starts.push(i);', replace: '.test(prev.trim()))) void i;' }],
    expect: /second_shape/,
  },
  'wp5-clock-in-manifest': {
    test: 'wp5-incremental', what: 'a build time is written into the pack',
    patches: [{ file: 'packages/builder/manifest.mjs', find: "schema: 'ruvnet-brain/build-manifest',", replace: "schema: 'ruvnet-brain/build-manifest', builtAt: new Date().toISOString() + process.pid," }],
    expect: /byte-identical pack/,
  },
  'wp5-key-no-content': {
    test: 'wp5-incremental', what: 'the cache key drops the source content hash',
    patches: [{ file: 'packages/builder/build.mjs', find: 'sha256(`${recipeHash}\\n${snap.contentHash}\\n${historyHash}`)', replace: 'sha256(`${recipeHash}\\n${snap.meta.repo}\\n${historyHash}`)' }],
    expect: /only the changed repository is rebuilt/,
  },
  'wp5-key-no-recipe': {
    test: 'wp5-incremental', what: 'the cache key drops the recipe hash',
    patches: [{ file: 'packages/builder/build.mjs', find: 'sha256(`${recipeHash}\\n${snap.contentHash}\\n${historyHash}`)', replace: 'sha256(`${snap.contentHash}\\n${historyHash}`)' }],
    expect: /a new recipe hash rebuilds everything/,
  },
  'wp5-no-carry': {
    test: 'wp5-carry', what: 'an unreadable source stops the build (no carry)',
    patches: [{ file: 'packages/builder/build.mjs', find: 'if (!(e instanceof Unreadable)) throw e;', replace: 'throw e;' }],
    expect: /one unreadable source of four must not stop the build/,
  },
  'wp5-no-carry-bound': {
    test: 'wp5-carry', what: 'the carry bound is removed',
    patches: [{ file: 'packages/builder/build.mjs', find: 'if (unreadable.length && (unreadable.length === sources.length || unreadable.length > allowed)) {', replace: 'if (false) {' }],
    expect: /two of four unreadable is over the carry bound/,
  },
  'wp5-probe-wrong-file': {
    test: 'wp5-probes', what: 'probes name a file the pack does not cite, and the build-time probe check is skipped',
    patches: [
      { file: 'packages/builder/probes.mjs', find: "expect: f, repo });", replace: 'expect: f.slice(repo.length + 1), repo });' },
      { file: 'packages/builder/build.mjs', find: 'if (!t.ok) throw new Error(`a probe failed', replace: 'if (false) throw new Error(`a probe failed' },
    ],
    expect: /"pass":false/,
  },
  'wp5-no-secret-screen': {
    test: 'wp5-screen', what: 'secrets are not redacted',
    patches: [{ file: 'packages/builder/extract.mjs', find: 'const { text, hits } = redactSecrets(doc.text, s.screen.secrets, s.screen.redaction);', replace: 'const { text, hits } = { text: doc.text, hits: [] };' }],
    expect: /secret (aws|gh|key) appears in/,
  },
  'wp5-no-hostile-screen': {
    test: 'wp5-screen', what: 'the hostile flag is not set',
    patches: [{ file: 'packages/builder/extract.mjs', find: "flag: rule ? 'hostile' : null, flag_rule: rule,\n        uid: sha(JSON.stringify([s.chunker.name", replace: "flag: null, flag_rule: rule,\n        uid: sha(JSON.stringify([s.chunker.name" }],
    expect: /and carries the hostile flag/,
  },
  'wp5-default-cap': {
    test: 'wp5-recipe', what: 'the builder falls back to its own token cap',
    patches: [{ file: 'packages/builder/settings.mjs', find: 'maxTokens: int(recipe, `${sc}.maxTokens`, 64, 8192),', replace: 'maxTokens: recipe.units.passage.symbolChunker.maxTokens ?? 480,' }],
    expect: /the token cap is missing: the build must fail/,
  },
  'wp5-models-ignored': {
    test: 'wp5-recipe', what: 'models named in the recipe are ignored',
    patches: [{ file: 'packages/builder/settings.mjs', find: "for (const m of list(recipe, 'models')) {", replace: 'for (const m of []) {' }],
    expect: /a model the builder does not load: the build must fail/,
  },
  'wp5-any-author': {
    test: 'wp5-history', what: 'issues, comments and releases by anyone are kept, not only the owner\'s',
    patches: [{ file: 'packages/builder/history.mjs', find: "const isOwner = (login) => typeof login === 'string' && login.toLowerCase() === owner.toLowerCase();", replace: 'const isOwner = () => true;' }],
    expect: /every commit, owner-written discussion only/,
  },
  'wp5-no-split': {
    test: 'wp5-history', what: 'history items are not split at the character bound',
    patches: [
      { file: 'packages/builder/history.mjs', find: 'while (p.length > max) {', replace: 'while (false) {' },
      { file: 'packages/builder/history.mjs', find: 'if (cur && cur.length + 2 + p.length > max) push();', replace: '' },
    ],
    expect: /every commit, owner-written discussion only/,
  },
});
// end wp5

// wave1 ── integration of work packages 1 and 5 (one pack format, one analyser). Each turns
// wave1-end-to-end.test.mjs red.
Object.assign(BREAKS, {
  'wave1-raw-index': {
    test: 'wave1-end-to-end', what: 'the builder indexes raw text instead of the engine analyser\'s tokens',
    patches: [{ file: 'packages/builder/store.mjs', find: "insF.run(i + 1, analyse(r.subject ?? '', analyser), analyse(r.text, analyser));", replace: "insF.run(i + 1, r.subject ?? '', r.text);" }],
    expect: /FILES hit through the shared analyser/,
  },
  'wave1-flag-dropped': {
    test: 'wave1-end-to-end', what: 'the engine drops the builder\'s hostile flag',
    patches: [{ file: 'packages/engine/assemble.mjs', find: "flag: take.some((t) => t.flag === 'hostile') ? 'hostile' : null,", replace: 'flag: null,' }],
    expect: /the hostile passage carries the flag in the result/,
  },
  'wave1-flag-unlabelled': {
    test: 'wave1-end-to-end', what: 'the server does not label a flagged passage',
    patches: [{ file: 'packages/server/format.mjs', find: '    if (it.flag) out.push(', replace: '    if (false) out.push(' }],
    expect: /the delivered text labels the flagged passage/,
  },
  'wave1-closing-dropped': {
    test: 'wave1-end-to-end', what: 'the server does not print the closing line',
    patches: [{ file: 'packages/server/format.mjs', find: 'if (result.closing) out.push(', replace: 'if (false) out.push(' }],
    expect: /the server prints the closing line/,
  },
  'wave1-no-cap': {
    test: 'wave1-end-to-end', what: 'the formatter does not hold the text to the result cap',
    patches: [{ file: 'packages/server/format.mjs', find: 'const cap = recipe.result.capChars[result.detail];', replace: 'const cap = Infinity;' }],
    expect: /over the 44000 cap/,
  },
  'wave1-no-history-degrades': {
    test: 'wave1-end-to-end', what: 'a pack built without history reports its history lane unavailable',
    patches: [{ file: 'packages/engine/index.mjs', find: 'if (absent.has(spec.name)) continue;', replace: 'if (false) continue;' }],
    // The installer's post-switch check already refuses such a pack; the health line would show it too.
    expect: /lane history unavailable|the OK health line for a pack without history/,
  },
});
// end wave1

// wp4: installer breaks (work package 4). Each names its test id (wp4-NN) and the failure it must show.
Object.assign(BREAKS, {
  'wp4-01': {
    test: 'wp4-01', what: 'the journal is not read (no recovery after a kill)',
    patches: [{ file: 'packages/cli/txn.mjs', find: 'const j = readJson(txnPaths(home).journal, null);', replace: 'const j = null;' }],
    expect: /killed at step \d+ .*(must match an uninterrupted|leftovers after the rerun|back byte for byte|rerun ended with|must still answer)/,
  },
  'wp4-02': {
    test: 'wp4-02', what: 'the resume request is dropped (a retry starts from byte 0)',
    patches: [{ file: 'packages/cli/source.mjs', find: 'start > 0 ? { range: `bytes=${start}-` } : {}', replace: '{}' }],
    expect: /must resume at byte|asked for exactly twice|bytes of blob\.bin cross the network/,
  },
  'wp4-03': {
    test: 'wp4-03', what: 'the folder source reads each file whole',
    patches: [{ file: 'packages/cli/source.mjs', find: 'yield* fs.createReadStream(file, { start, highWaterMark: 1 << 20 });', replace: 'yield fs.readFileSync(file).subarray(start);' }],
    expect: /greater than 2 GiB|ERR_FS_FILE_TOO_LARGE/,
  },
  'wp4-04': {
    test: 'wp4-04', what: 'the disk-space check is removed',
    patches: [{ file: 'packages/cli/install.mjs', find: 'if (first.free !== null && first.need + HEADROOM > first.free) {', replace: 'if (false) {' }],
    expect: /the refusal must name the shortfall/,
  },
  'wp4-05': {
    test: 'wp4-05', what: 'the installer writes one file outside the plan',
    patches: [{ file: 'packages/cli/install.mjs', find: "step(j, 'prune');", replace: "fs.writeFileSync(path.join(home, 'state', 'installed-by.txt'), 'x');\n    step(j, 'prune');" }],
    expect: /the files written must be exactly the plan's/,
  },
  'wp4-06a': {
    test: 'wp4-06', what: 'uninstall deletes private/',
    patches: [{ file: 'packages/cli/uninstall.mjs', find: '...(purgePrivate ? [p.private] : [])', replace: 'p.private' }],
    expect: /private\/ must be left byte for byte/,
  },
  'wp4-06b': {
    test: 'wp4-06', what: 'uninstall reports "nothing remains" without looking again',
    patches: [{ file: 'packages/cli/uninstall.mjs', find: 'const left = walk(home, kept ? [p.private] : []);', replace: 'const left = [];' }],
    expect: /with files left the exit code must be 1|must list what is left/,
  },
  'wp4-07': {
    test: 'wp4-07', what: 'older generations are not pruned',
    patches: [{ file: 'packages/cli/install.mjs', find: '    prune(home, next);\n', replace: '\n' }],
    expect: /exactly one earlier/,
  },
  'wp4-08': {
    test: 'wp4-08', what: 'the installer runs `npm --version`',
    patches: [{ file: 'packages/cli/install.mjs', find: "const src = typeof from === 'string' ? openSource(from) : from;", replace: "process.getBuiltinModule('node:child_process').spawnSync('npm', ['--version'], { stdio: 'ignore' });\n  const src = typeof from === 'string' ? openSource(from) : from;" }],
    expect: /a package manager was started|package manager stub on PATH was run/,
  },
  'wp4-09a': {
    test: 'wp4-09', what: "the installer's real-server check starts the remembered Node path",
    patches: [{ file: 'packages/cli/mcp-client.mjs', find: 'spawn(pickNode(env), [launcher]', replace: 'spawn(process.execPath, [launcher]' }],
    expect: /must be applied, not refused or rolled back/,
  },
  'wp4-09b': {
    test: 'wp4-09', what: 'the Node search looks in the current folder (relative PATH entries, current folder as working folder)',
    // Two guards make this safe (relative PATH entries are skipped; candidates are tested from a temp
    // folder); the break removes both, which is what "searches the current folder" means.
    patches: [
      { file: 'packages/cli/node-pick.mjs', find: '.filter((d) => d && path.isAbsolute(d))', replace: '.filter(() => true)' },
      { file: 'packages/cli/node-pick.mjs', find: "cwd: os.tmpdir(), windowsHide: true", replace: 'windowsHide: true' },
    ],
    expect: /planted in the session folder ran/,
  },
  'wp4-10': {
    test: 'wp4-10', what: 'the updater ignores an interrupted transaction',
    patches: [{ file: 'packages/cli/updater.mjs', find: 'if (!(result.available || interrupted) || !apply) return result;', replace: 'if (!result.available || !apply) return result;' }],
    expect: /the interrupted update was never put right/,
  },
  'wp4-11': {
    test: 'wp4-11', what: 'an installed copy of the release is trusted without re-checking its hashes',
    patches: [{ file: 'packages/cli/install.mjs', find: 's.fresh = !fs.existsSync(s.dest) || !(await matches(s.dest, s.files));', replace: 's.fresh = !fs.existsSync(s.dest);' }],
    expect: /the printed fix "ruvnet-brain install --repair" must work/,
  },
});
// end wp4

// Work packages 2, 3, 6 and 7 (breaks-wp.mjs) and the wave 2 integration (breaks-wave2.mjs).
addWorkPackageBreaks(BREAKS);
addWave2Breaks(BREAKS);
addWave3Breaks(BREAKS); // wave 3 integration (breaks-wave3.mjs)
addReviewBreaks(BREAKS); // review fixes (breaks-review.mjs, docs/REVIEW-FIXES.md)

// wp8 ── work package 8 (answer gate) breaks. Each removes one refusal from packages/release/gate/.
const R = 'packages/release/gate/retrieval.mjs';
const A = 'packages/release/gate/answer.mjs';
const V = 'packages/release/gate/verify.mjs';
const off = (file, find, replace) => ({ file, find, replace });
Object.assign(BREAKS, {
  'wp8-01': { test: 'wp8-01', what: 'the gate copies each question\'s text into its result', patches: [off(R, 'return { id: q.id, group: q.group, hit:', 'return { id: q.id, question: q.question, group: q.group, hit:')], expect: /no question text may reach the result file or the log/ },
  'wp8-02': { test: 'wp8-02', what: 'the comparison with the baseline is removed', patches: [off(R, 'if (hit < baseline.hit - tolerance) problems.push(', 'if (false) problems.push(')], expect: /a damaged pack must fail the gate/ },
  'wp8-03a': { test: 'wp8-03', what: 'the delivered-size check is removed', patches: [off(R, 'if (res.text.length > ceiling.maxChars) problems.push(', 'if (false) problems.push(')], expect: /a candidate with the size fault must fail the gate/ },
  'wp8-03b': { test: 'wp8-03', what: 'the no-text-twice check is removed', patches: [off(R, "if (b.trim() && bodies.has(b)) problems.push('twice: an excerpt appears twice');", '')], expect: /a candidate with the twice fault must fail the gate/ },
  'wp8-03c': { test: 'wp8-03', what: 'the two-process comparison is removed', patches: [off(R, "if (normalise(a[i].text) !== normalise(b[i].text)) problems.push('same: two processes served different results');", '')], expect: /a candidate with the same fault must fail the gate/ },
  'wp8-03d': { test: 'wp8-03', what: 'the empty-reason check is removed', patches: [off(R, 'if (Number(s[2]) === 0 && !/^ · no match: \\S/.test(s[3])) problems.push(', 'if (false) problems.push(')], expect: /a candidate with the reasons fault must fail the gate/ },
  'wp8-03e': { test: 'wp8-03', what: 'the probe check is removed', patches: [off(R, 'if (probesPassed !== probes.length || !probes.length) problems.push(', 'if (false) problems.push(')], expect: /a candidate with the probes fault must fail the gate/ },
  'wp8-04a': { test: 'wp8-04', what: 'a question set inside the repository is accepted', patches: [off('packages/release/gate/question-set.mjs', "return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));", 'return false;')], expect: /a question set inside the repository must be refused/ },
  'wp8-04b': { test: 'wp8-04', what: 'an empty pin is treated as no problem', patches: [off('packages/release/gate/question-set.mjs', "if (!pin) return 'no frozen", "if (!pin) return null;\n  if (!pin) return 'no frozen")], expect: /with no set pinned the gate must not pass/ },
  'wp8-05a': { test: 'wp8-05', what: 'the same command may answer and judge', patches: [off(A, '  if (r.answer.join(', '  if (false && r.answer.join(')], expect: /the same command answering and judging must be refused/ },
  'wp8-05b': { test: 'wp8-05', what: 'the mechanical caps are removed', patches: [off(A, 'return { cap, reasons: [...new Set(reasons)] };', 'return { cap: 10, reasons: [] };')], expect: /layer 2 with two different commands/ },
  'wp8-05c': { test: 'wp8-05', what: 'the judge calibration gate is removed', patches: [off(A, 'passed: withinOne >= minWithinOne && plantedCapped === planted', 'passed: true')], expect: /a judge that fails calibration must fail the run/ },
  'wp8-05d': { test: 'wp8-05', what: 'the time is written inside the hashed part', patches: [off(A, '    questions: [],\n  };', '    questions: [],\n    at: new Date().toISOString(),\n  };')], expect: /the hashed part is the same on a second run/ },
  'wp8-06a': { test: 'wp8-06', what: 'an answer-level result for other bytes is accepted', patches: [off(V, 'if (c.release !== sha256 || c.pack !== generation) problems.push(', 'if (false) problems.push(')], expect: /a result for other bytes must fail the gate/ },
  'wp8-06b': { test: 'wp8-06', what: 'the age limit is not checked', patches: [off(V, 'else if (now - at > l2.maxAgeDays * DAY)', 'else if (false)')], expect: /a result older than the set allows must fail the gate/ },
  'wp8-06c': { test: 'wp8-06', what: 'a failed judge calibration is accepted', patches: [off(V, 'else if (c.calibration.passed !== true)', 'else if (false)')], expect: /a result whose judge failed calibration must fail the gate/ },
});
// end wp8
