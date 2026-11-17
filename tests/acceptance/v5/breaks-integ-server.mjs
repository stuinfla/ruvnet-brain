// The breaks of the server's review-fix tests (docs/REVIEW-FIXES.md, "Changes the integration owner must
// make": F02, F08, F09, F11, F17, F18, F22). Each removes one protection a server fix added and names
// the failure its test must show. Tests: tests/acceptance/v5/integ-server-*.test.mjs.
const MAIN = 'packages/server/main.mjs';
const p = (file, find, replace) => ({ file, find, replace });

export function addIntegServerBreaks(BREAKS) {
  Object.assign(BREAKS, {
    // F22: protocol errors echo at most 200 characters of a request value
    'integ-server-f22-echo': { test: 'integ-server-f22', what: 'the unknown-tool error echoes the whole tool name', patches: [p(MAIN, 'new Error(`unknown tool ${clip(name)}`)', 'new Error(`unknown tool ${name}`)')], expect: /the unknown-tool error echoed \d+ characters/ },
  });
}
