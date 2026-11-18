// The breaks of the server's review-fix tests (docs/REVIEW-FIXES.md, "Changes the integration owner must
// make": F02, F08, F09, F11, F17, F18, F22). Each removes one protection a server fix added and names
// the failure its test must show. Tests: tests/acceptance/v5/integ-server-*.test.mjs.
const MAIN = 'packages/server/main.mjs';
const HELPER = 'packages/server/helper.mjs';
const FORMAT = 'packages/server/format.mjs';
const READ = 'packages/server/read.mjs';
const WIDEN = 'packages/server/widen.mjs';
const RUNNER = 'packages/server/runner.mjs';
const p = (file, find, replace) => ({ file, find, replace });
const ASK = p(MAIN, "clientRoots && ((project = null), send(", 'clientRoots && (send(');

export function addIntegServerBreaks(BREAKS) {
  Object.assign(BREAKS, {
    // F02: a helper lane never runs a Node from inside the project
    'integ-server-f02-no-check': { test: 'integ-server-f02', what: 'the helper probes candidates without the project check', patches: [p(HELPER, '    if (!outsideProject(c, env, cwd)) {', '    if (false) {')], expect: /a program inside the project was run/ },
    // F08: private access is fail-closed and never cached past a change
    'integ-server-f08-pending': { test: 'integ-server-f08', what: 'the start folder counts while roots are pending', patches: [ASK, p(MAIN, '        if (clientRoots) project = null;\n', '')], expect: /a private pack was searched while the roots request was pending/ },
    'integ-server-f08-empty': { test: 'integ-server-f08', what: 'an empty roots list keeps the previous project', patches: [ASK, p(MAIN, '      project = uri ? real(fileURLToPath(uri)) : null;', '      if (uri) project = real(fileURLToPath(uri));')], expect: /an empty roots list must revoke private access/ },
    'integ-server-f08-cached': { test: 'integ-server-f08', what: 'the private packs are opened once per worker', patches: [p(WIDEN, '    if (!p || p.text !== text) {', '    if (!p) {')], expect: /a project taken off the list must lose access at the next search/ },
    // F09: one deadline covers queue, search and fallback; the server thread never searches
    'integ-server-f09-main-thread': { test: 'integ-server-f09', what: 'safe mode searches on the server\'s own thread', patches: [p(MAIN, "      r = await a.safeRunner.call({ type: 'safe', query, options: { detail, lanes: ['lexical'], project } }, a.recipe.deadlineMs, { expiresAt: expiresAt + SAFE_MS });", "      const eng = await importFrom(a.appDir, 'engine', 'index.mjs');\n      r = eng.search(eng.open(a.packDir), query, { detail, lanes: ['lexical'], project });")], expect: /a stalled search answered after \d+ ms|a ping during the fallback took/ },
    'integ-server-f09-full-run': { test: 'integ-server-f09', what: 'the wait and the run each get a full deadline', patches: [p(RUNNER, '    const deadlineMs = Math.max(0, job.expiresAt - Date.now());', '    const deadlineMs = job.deadlineMs;'), p(RUNNER, '      }, expiresAt - Date.now());', '      }, deadlineMs);')], expect: /a stalled search answered after \d+ ms/ },
    // F11: a running server hands over to the new app's modules
    'integ-server-f11-static': { test: 'integ-server-f11', what: 'the server keeps the modules it started with', patches: [p(MAIN, '    if (ptr.app !== active?.app) use(await Promise.all(MODS.map((m) => importFrom(appDir, ...m))));\n', '')], expect: /the answer must come from the new app's formatter/ },
    // F17: private items merge under the section rules, cite their pack, and a shown text is sent once
    'integ-server-f17-no-limit': { test: 'integ-server-f17', what: 'private items are appended past the section\'s maxItems', patches: [p(WIDEN, '.slice(0, max);', ';')], expect: /FILES must hold at most 5 items with a private pack merged in/ },
    'integ-server-f17-bare-repo': { test: 'integ-server-f17', what: 'private items keep their bare repo name', patches: [p(WIDEN, 'sec.items.map((it) => ({ ...it, repo: `private:${p.name}/${it.repo}` }))', 'sec.items')], expect: /a private item must be cited as private:<pack>\/<repo>\/<path>/ },
    'integ-server-f17-dedupe-early': { test: 'integ-server-f17', what: 'the formatter deduplicates before trimming only', patches: [p(FORMAT, '  for (const s of sections) s.items = s.items.filter((it) => { const t = it.excerpt.replace(TRIM_NOTE, \'\');', '  for (const s of []) s.items = s.items.filter((it) => { const t = it.excerpt.replace(TRIM_NOTE, \'\');')], expect: /the same shown text was sent twice/ },
    // F18: a path from the corpus cannot add a line to an answer
    'integ-server-f18-raw-path': { test: 'integ-server-f18', what: 'the formatter prints paths as they are', patches: [p(FORMAT, '.map((it) => ({ ...it, repo: one(it.repo), path: one(it.path), base:', '.map((it) => ({ ...it, base:')], expect: /search: a path added a line of its own/ },
    'integ-server-f18-raw-ref': { test: 'integ-server-f18', what: 'read_ruvnet takes a ref with a control character', patches: [p(READ, "  if (/[\\u0000-\\u001f\\u007f\\u2028\\u2029]/.test(ref)) return", '  if (false) return')], expect: /read: a ref with a control character is refused/ },
    // F22: protocol errors echo at most 200 characters of a request value
    'integ-server-f22-echo': { test: 'integ-server-f22', what: 'the unknown-tool error echoes the whole tool name', patches: [p(MAIN, 'new Error(`unknown tool ${clip(name)}`)', 'new Error(`unknown tool ${name}`)')], expect: /the unknown-tool error echoed \d+ characters/ },
  });
}
