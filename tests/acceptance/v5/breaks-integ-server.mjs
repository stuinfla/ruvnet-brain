// The breaks of the server's review-fix tests (docs/REVIEW-FIXES.md, "Changes the integration owner must
// make": F02, F08, F09, F11, F17, F18, F22). Each removes one protection a server fix added and names
// the failure its test must show. Tests: tests/acceptance/v5/integ-server-*.test.mjs.
const MAIN = 'packages/server/main.mjs';
const HELPER = 'packages/server/helper.mjs';
const FORMAT = 'packages/server/format.mjs';
const READ = 'packages/server/read.mjs';
const p = (file, find, replace) => ({ file, find, replace });

export function addIntegServerBreaks(BREAKS) {
  Object.assign(BREAKS, {
    // F02: a helper lane never runs a Node from inside the project
    'integ-server-f02-no-check': { test: 'integ-server-f02', what: 'the helper probes candidates without the project check', patches: [p(HELPER, '    if (!outsideProject(c, env, cwd)) {', '    if (false) {')], expect: /a program inside the project was run/ },
    // F18: a path from the corpus cannot add a line to an answer
    'integ-server-f18-raw-path': { test: 'integ-server-f18', what: 'the formatter prints paths as they are', patches: [p(FORMAT, '.map((it) => ({ ...it, repo: one(it.repo), path: one(it.path), base:', '.map((it) => ({ ...it, base:')], expect: /search: a path added a line of its own/ },
    'integ-server-f18-raw-ref': { test: 'integ-server-f18', what: 'read_ruvnet takes a ref with a control character', patches: [p(READ, "  if (/[\\u0000-\\u001f\\u007f\\u2028\\u2029]/.test(ref)) return", '  if (false) return')], expect: /read: a ref with a control character is refused/ },
    // F22: protocol errors echo at most 200 characters of a request value
    'integ-server-f22-echo': { test: 'integ-server-f22', what: 'the unknown-tool error echoes the whole tool name', patches: [p(MAIN, 'new Error(`unknown tool ${clip(name)}`)', 'new Error(`unknown tool ${name}`)')], expect: /the unknown-tool error echoed \d+ characters/ },
  });
}
