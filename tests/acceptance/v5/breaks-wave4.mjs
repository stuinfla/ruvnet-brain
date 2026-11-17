// The breaks of the wave 4 (L+ layered store) tests (wave4-*.test.mjs). Each removes one protection
// and names the failure its test must show. Applied by helpers.mjs to a scratch copy of packages/.
const STORE = 'packages/builder/layered/store.mjs';
const QUERY = 'packages/engine/layered/query.mjs';
const p = (file, find, replace) => ({ file, find, replace });

export function addWave4Breaks(BREAKS) {
  Object.assign(BREAKS, {
    // test 4 (Codex F03): history screened whole, before the split
    'wave4-04-split-first': { test: 'wave4-04', what: 'history items are screened per piece after the split, as before the fix', patches: [p('packages/builder/extract.mjs', 'cfg: s.history, screen, hostile });', 'cfg: s.history, hostile });')], expect: /a secret reached history\.db/ },
    // test 5: gists, the Brain's header removed
    'wave4-05-header-kept': { test: 'wave4-05', what: "the Brain's passage header is kept in the gist text", patches: [p('packages/builder/gists.mjs', 'files.get(fp).chunks.push({ n, body: o.text.slice(m[0].length) });', 'files.get(fp).chunks.push({ n, body: o.text });')], expect: /verbatim gist text/ },
    // test 6: layered.db health in the one signal
    'wave4-06-unchecked': { test: 'wave4-06', what: 'the self-test leaves the layered store out', patches: [p('packages/engine/index.mjs', '  const layered = checkLayered(h.packDir, h.pack, h.recipe);', '  const layered = null;')], expect: /lane layered unavailable|a good layered store is reported available/ },
    // test 7: answers byte-identical to the golden set after compaction
    'wave4-07-short-cut': { test: 'wave4-07', what: "an extract's text is cut one line short at read time", patches: [p(QUERY, 'const l2Text = (h, r) => span(linesOf(h, r.repo, r.path), r.line_start, r.line_end);', 'const l2Text = (h, r) => span(linesOf(h, r.repo, r.path), r.line_start, r.line_end - 1);')], expect: /answer differs from the golden set/ },
    // test 8: a very large repository's facts
    'wave4-08-spread': { test: 'wave4-08', what: "a repository's rows are spread as call arguments again", patches: [p(QUERY, "      else if (r.kind === 'repository') add(h.db.prepare(`SELECT * FROM l2 WHERE repo=?${kindSql}`).all(r.repo, ...kp));", "      else if (r.kind === 'repository') rows.push(...h.db.prepare(`SELECT * FROM l2 WHERE repo=?${kindSql}`).all(r.repo, ...kp));")], expect: /Maximum call stack size exceeded/ },
    // test 1: extracts verbatim, screened, from the untruncated text
    'wave4-01-off-by-one': { test: 'wave4-01', what: 'an L2 row stores one line more than its range', patches: [p(STORE, 'const t = span(lines, r.line_start, r.line_end);', 'const t = span(lines, r.line_start, r.line_end + 1);')], expect: /verbatim: |sha256 of |stored length of / },
    'wave4-01-unscreened': { test: 'wave4-01', what: 'the layered store is cut from the source before the secret screen', patches: [p(STORE, 'const { text, hits } = redactSecrets(d.full ?? d.text, s.screen.secrets, s.screen.redaction);', 'const { text, hits } = { text: d.full ?? d.text, hits: [] };')], expect: /verbatim: |no secret key/ },
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
