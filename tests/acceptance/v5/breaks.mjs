// The break that must turn each acceptance test red (ROADMAP A2 "must fail when" column), applied
// to a scratch copy of the tree only when V5_BREAK names it. `expect` is the failure the run must
// show, so a red run caused by something else (a bad patch, a syntax error) is not counted.
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
    test: 's05', what: 'the trim step is removed',
    patches: [{ file: 'packages/server/format.mjs', find: 'trimToBudgets(sections, (s) => renderSection(s, marker), render, cap);', replace: '' }],
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
    test: 's11', what: 'doctor is given its own separate check',
    // The 4.7 shape (defect C9): doctor runs its own in-process search instead of reading the verdict.
    patches: [{ file: 'packages/cli/ruvnet-brain.mjs', find: 'const v = verdict(ev);', replace: "const v = await (async () => { const cur = JSON.parse(fs.readFileSync(p.current, 'utf8')); const eng = await import(process.getBuiltinModule('node:url').pathToFileURL(path.join(p.app, cur.app, 'engine', 'index.mjs')).href); const h = eng.open(path.join(p.packs, cur.pack)); return eng.selfTest(h).ok ? { state: 'ok', label: 'OK', knowledgeDate: h.pack.knowledgeDate } : verdict(ev); })().catch(() => verdict(ev));" }],
    expect: /doctor exit code disagrees with the health line/,
  },
  s12: {
    test: 's12', what: 'the shim is made to run a project file',
    patches: [{ file: 'packages/plugin/claude/health-line.mjs', find: 'let line;', replace: "try { await import(process.getBuiltinModule('node:url').pathToFileURL(process.cwd() + '/scripts/ascii-drift.mjs').href); } catch {}\nlet line;" }],
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
