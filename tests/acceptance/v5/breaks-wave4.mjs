// The breaks of the wave 4 (L+ layered store) tests (wave4-*.test.mjs). Each removes one protection
// and names the failure its test must show. Applied by helpers.mjs to a scratch copy of packages/.
const STORE = 'packages/builder/layered/store.mjs';
const QUERY = 'packages/engine/layered/query.mjs';
const p = (file, find, replace) => ({ file, find, replace });

export function addWave4Breaks(BREAKS) {
  Object.assign(BREAKS, {
    // test 1: extracts verbatim, screened, from the untruncated text
    'wave4-01-off-by-one': { test: 'wave4-01', what: 'an L2 row stores one line more than its range', patches: [p(STORE, 'const t = span(lines, r.line_start, r.line_end);', 'const t = span(lines, r.line_start, r.line_end + 1);')], expect: /verbatim: / },
    'wave4-01-unscreened': { test: 'wave4-01', what: 'the layered store is cut from the source before the secret screen', patches: [p(STORE, 'const { text, hits } = redactSecrets(d.full ?? d.text, s.screen.secrets, s.screen.redaction);', 'const { text, hits } = { text: d.full ?? d.text, hits: [] };')], expect: /verbatim: |no secret key bytes anywhere in layered\.db/ },
    'wave4-01-truncated': { test: 'wave4-01', what: 'the layered store reads the passage text, cut at 12,000 characters', patches: [p(STORE, 'redactSecrets(d.full ?? d.text,', 'redactSecrets(d.text,')], expect: /still becomes an L1 row/ },
    // test 2: the page cap and exact paging
    'wave4-02-uncapped': { test: 'wave4-02', what: 'pages are not held to layered.pageChars', patches: [p(QUERY, 'const fits = (h, o) => JSON.stringify(o).length <= h.cfg.pageChars - SLACK;', 'const fits = () => true;'), p(QUERY, '  if (text.length > h.cfg.pageChars) throw new Error(', '  if (false) throw new Error(')], expect: /page is \d+ characters, over 20000/ },
    'wave4-02-cursor-skip': { test: 'wave4-02', what: 'the next cursor skips one row', patches: [p(QUERY, '  if (i < rows.length) out.next = i;', '  if (i < rows.length) out.next = i + 1;')], expect: /a row was skipped/ },
    // test 3: served by the real server
    'wave4-03-no-rules': { test: 'wave4-03', what: 'search_ruvnet is described without the answer rules', patches: [p('packages/server/tools.mjs', '`context_ruvnet (ADRs) and source_ruvnet (the file, line by line). ${RULES}`', "'context_ruvnet (ADRs) and source_ruvnet (the file, line by line).'")], expect: /search_ruvnet carries the answer rules verbatim/ },
    'wave4-03-unlisted': { test: 'wave4-03', what: 'tools/list leaves the layered tools out', patches: [p('packages/server/main.mjs', 'return { tools: [SEARCH, READ, ...layeredList()] };', 'return { tools: [SEARCH, READ] };')], expect: /the server lists seven tools/ },
    'wave4-03-traversal': { test: 'wave4-03', what: 'the path check lets .. and absolute paths through', patches: [p('packages/server/layered-tools.mjs', "  if (/\\\\/.test(p) || /^([a-zA-Z]:|\\/|~)/.test(p) || p.split('/').some((s) => !s || s === '.' || s === '..')) return [null, `${p} is not a path inside a repository`];\n", '')], expect: /must be refused/ },
    'wave4-03-required': { test: 'wave4-03', what: 'the layered store is a required pack file, so its damage takes search down', patches: [p('packages/engine/index.mjs', ", 'layered-db', 'layered-coverage']);", ']);')], expect: /search keeps working with a damaged layered store/ },
  });
}
