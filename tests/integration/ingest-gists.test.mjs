// tests/integration/ingest-gists.test.mjs — scripts/ingest-gists.mjs (new in commit 9a8ff55, 2026-07-09)
// pulls rUv's public GitHub gists into their own KB store, fenced with a provenance banner so the
// brain never repeats a gist's PROPOSED/UNRELEASED claim as confirmed shipped behavior. It had ZERO
// tests before this file (confirmed via `grep -rl ingest-gists tests/` returning nothing) despite
// driving a real nightly GitHub Actions job (.github/workflows/gists-nightly.yml, --index-only).
//
// WHY SUBPROCESS + PATH-STUBBED `gh`, NOT IMPORT: same reasoning as tests/integration/ingest-repo.test.mjs
// — main() runs unconditionally at module-load time (`main();` on the last line) and shells out via
// spawnSync('gh', ...), so importing it in-process would hit the real, authenticated GitHub API. Unlike
// ingest-repo.mjs (which needs git + a loaded ONNX model), this file's ENTIRE external dependency is the
// `gh` CLI — no embedding happens here (that's a separate `forge-big.mjs` step per this file's own
// header) — so PATH-stubbing `gh` alone makes the whole script's logic reachable for real, not just
// documentable as .todo. That is genuinely more of this file testable than most "infra-gated" scripts
// this suite has hit (prove.mjs, brain-grade-groundtruth.mjs, eval-brain.mjs all need a live ONNX+built
// .rvf; this one does not).
//
// The ingest must fail closed: a truncated or failed gist cannot produce a receipt-only or partial
// corpus that looks searchable. The command is bounded per gist so the nightly cannot wedge forever.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

let tmp, binDir, logFile, fixtures;

// Step 2 (2026-09-13): ingest-gists.mjs's real content path now routes through the canonical
// gist-receipts.mjs pipeline instead of a self-contained fetch+write+chunk loop, so this hermetic
// fixture needs that pipeline's full static-import closure copied alongside it -- not just the one
// file. Every path here is a real, statically-resolvable local import (verified against the source
// files, not guessed); a new import added to any of them would need adding here too.
const DEPENDENCY_FILES = [
  'scripts/ingest-gists.mjs',
  'scripts/gist-receipts.mjs',
  'scripts/gist-git-source.mjs',
  'scripts/coverage-integrity.mjs',
  'scripts/rvf-generation.mjs',
  'scripts/version.mjs',
  'plugin/scripts/coverage-integrity.mjs',
  'kb/incremental-refresh.mjs',
  'kb/rvf-index.mjs',
  'plugin/.claude-plugin/plugin.json',
];

beforeEach(() => {
  // realpathSync: macOS's os.tmpdir() resolves through a /tmp -> /private/tmp symlink; the child
  // process resolves its own script path to the REAL path, so string comparisons need the same form.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-gists-')));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'kb'), { recursive: true });
  for (const relative of DEPENDENCY_FILES) {
    const destination = path.join(tmp, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relative), destination);
  }

  binDir = path.join(tmp, 'stub-bin');
  fs.mkdirSync(binDir);
  logFile = path.join(tmp, 'calls.log');
  fixtures = path.join(tmp, 'fixtures');
  fs.mkdirSync(path.join(fixtures, 'gists'), { recursive: true });

  // Stub `gh`: dispatches on argv shape alone, same technique as ingest-repo.test.mjs's git/node stubs.
  // `$2` is either `users/<owner>/gists?per_page=100` (list) or `gists/<id>` (single-gist fetch).
  const ghStub = [
    '#!/bin/sh',
    'echo "gh $*" >> "$LOGFILE"',
    'if [ "$GH_FAIL" = "1" ]; then echo "stub-forced-failure" >&2; exit 1; fi',
    'case "$2" in',
    '  users/*/gists*) cat "$FIXTURES/list.json" ;;',
    '  gists/*) id="${2#gists/}"; cat "$FIXTURES/gists/$id.json" ;;',
    '  *) echo "unhandled gh args: $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'gh'), ghStub);
  fs.chmodSync(path.join(binDir, 'gh'), 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Windows physically cannot run this technique: the `gh` stub is a POSIX shell script made executable
// with chmod (a no-op on Windows) and spawned by bare name off PATH (an extensionless script is not
// executable there). CI runs integration on ubuntu only, so this never fired — but a Windows
// contributor running `npm run test:integration` would get a wall of confusing failures. Skip, loudly.
const onPosix = describe.skipIf(process.platform === 'win32');

function writeFixture(name, obj) {
  fs.writeFileSync(path.join(fixtures, name), JSON.stringify(obj));
}

function runGists(args, { forceFail = false, env: extraEnv = {} } = {}) {
  const r = spawnSync(process.execPath, ['scripts/ingest-gists.mjs', ...args], {
    cwd: tmp,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      LOGFILE: logFile,
      FIXTURES: fixtures,
      GH_FAIL: forceFail ? '1' : '',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    calls: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

// Real gist ids are 32-char lowercase hex (captureGistSources now validates this, matching every
// other gist producer in this repo). Each id below is its old short fixture id repeated to 32 hex
// chars, so `.slice(0, 8)` — the passage-path truncation — reproduces the EXACT original 8-char
// prefix and every path assertion below still reads the same.
const GIST_A = 'abc12345'.repeat(4);
const GIST_B = 'def67890'.repeat(4);
const GIST_C = '7bad5eed'.repeat(4);

const ONE_GIST = [{
  id: GIST_A, updated_at: '2026-07-01T00:00:00Z', description: 'Flywheel notes',
  files: { 'flywheel.md': {} },
}];
const ONE_GIST_FULL = {
  id: GIST_A, updated_at: '2026-07-01T00:00:00Z', description: 'Flywheel notes',
  history: [{ version: 'c'.repeat(40) }],
  files: { 'flywheel.md': { content: 'Some flywheel content here.', truncated: false } },
};

onPosix('ingest-gists.mjs — --index-only (the actual nightly-CI invocation)', () => {
  it('writes docs/RUV-GISTS.md and returns BEFORE any per-gist fetch or KB write', () => {
    writeFixture('list.json', ONE_GIST);
    const r = runGists(['--index-only']);
    expect(r.code).toBe(0);
    const index = fs.readFileSync(path.join(tmp, 'docs/RUV-GISTS.md'), 'utf8');
    expect(index).toMatch(/Flywheel notes/);
    expect(index).toMatch(/1 gists · refreshed/);
    // Only the LIST call happened — no `gh api gists/<id>` fetch, confirming the workflow's own
    // "~5 API calls, no per-gist fetch" cost claim (.github/workflows/gists-nightly.yml header).
    expect(r.calls).toHaveLength(1);
    expect(fs.existsSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'))).toBe(false);
  });
});

onPosix('ingest-gists.mjs — --dry-run', () => {
  it('reports what would change and writes NOTHING to disk', () => {
    writeFixture('list.json', ONE_GIST);
    const r = runGists(['--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/1 new or updated since last run/);
    expect(r.stdout).toMatch(/2026-07-01\s+flywheel\.md/);
    expect(fs.existsSync(path.join(tmp, 'docs/RUV-GISTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'))).toBe(false);
  });
});

onPosix('ingest-gists.mjs — real ingest, banner + chunking', () => {
  it('writes passages.jsonl with the provenance banner prepended to every passage, plus meta.json, the receipt, and the local capture cache', () => {
    writeFixture('list.json', ONE_GIST);
    writeFixture(`gists/${GIST_A}.json`, ONE_GIST_FULL);
    const r = runGists([]);
    expect(r.code, r.stderr).toBe(0);

    const passages = fs.readFileSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(passages).toHaveLength(1);
    expect(passages[0].path).toBe('abc12345/flywheel.md'); // single chunk: no `#N` suffix
    // The canonical renderer (gist-receipts.mjs's renderGistPassages, the SAME implementation every
    // other gist producer in this repo now uses) titles the banner from the FILENAME -- the only
    // field the receipt schema actually carries -- not the gist's free-text description.
    expect(passages[0].text).toMatch(/^SOURCE: GitHub gist by @ruvnet — "flywheel\.md"/);
    expect(passages[0].text).toMatch(/GIST STATUS: rUv's own notes/);
    expect(passages[0].text).toMatch(/Some flywheel content here\.$/);

    const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'kb/ruv-gists.meta.json'), 'utf8'));
    expect(meta.entries['0'].path).toBe('abc12345/flywheel.md');
    expect(meta.entries['0'].kind).toBe('doc');

    // The ONE canonical schema-3 receipt -- not a private ad hoc cache file.
    const receipt = JSON.parse(fs.readFileSync(path.join(tmp, 'kb/ruv-gists.sources.json'), 'utf8'));
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.gists[GIST_A]).toMatchObject({ updatedAt: '2026-07-01T00:00:00Z', complete: true });
    expect(receipt.passagesSha256).toMatch(/^[a-f0-9]{64}$/);
    // The local, never-published capture cache -- a resumable optimization, not publication evidence.
    const cache = JSON.parse(fs.readFileSync(path.join(tmp, 'kb/.ruv-gists.capture-cache.json'), 'utf8'));
    expect(cache.gists[GIST_A].files[0].body).toBe('Some flywheel content here.');

    // writeIndex also runs at the end of a real ingest, not just --index-only.
    expect(fs.existsSync(path.join(tmp, 'docs/RUV-GISTS.md'))).toBe(true);
  });

  it('escapes Unicode line/paragraph separators so JSONL remains one physical line per passage', () => {
    // The canonical renderer (gist-receipts.mjs's renderGistPassages -- the SAME jsonLine escaping
    // every gist producer in this repo now shares) ESCAPES U+2028/U+2029 to the literal `\u2028`/
    // `\u2029` sequence at serialization time, rather than normalizing them to `\n` in the passage
    // text itself (the old, ingest-gists-only behavior). Both fixes solve the same JSONL-integrity
    // problem; only one implementation exists now, so this file's expectation follows it.
    writeFixture('list.json', ONE_GIST);
    writeFixture(`gists/${GIST_A}.json`, {
      ...ONE_GIST_FULL,
      files: { 'flywheel.md': { content: 'before\u2028after\u2029end', truncated: false } },
    });
    const r = runGists([]);
    expect(r.code, r.stderr).toBe(0);
    const raw = fs.readFileSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
    expect(raw).toContain('\\u2028');
    expect(raw).toContain('\\u2029');
    expect(JSON.parse(raw).text).toMatch(/before\u2028after\u2029end$/);
  });

  it('forwards --owner into the list call instead of the "ruvnet" default', () => {
    writeFixture('list.json', ONE_GIST);
    const r = runGists(['--owner', 'someorg', '--dry-run']);
    expect(r.calls[0]).toBe('gh api users/someorg/gists?per_page=100 --paginate --slurp');
  });
});

onPosix('ingest-gists.mjs — code files are silently excluded by design (TEXT_EXT), counted as neither indexed nor skipped', () => {
  it('indexes only the .md file in a gist that also contains a .mjs file', () => {
    writeFixture('list.json', [{ id: GIST_B, updated_at: '2026-07-02T00:00:00Z', description: 'Mixed gist', files: { 'run.mjs': {}, 'notes.md': {} } }]);
    writeFixture(`gists/${GIST_B}.json`, {
      id: GIST_B, updated_at: '2026-07-02T00:00:00Z', description: 'Mixed gist',
      history: [{ version: 'd'.repeat(40) }],
      files: {
        'run.mjs': { content: 'console.log(1)', truncated: false },
        'notes.md': { content: 'Prose notes.', truncated: false },
      },
    });
    const r = runGists([]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/fetched 1 fresh/); // not 2 — run.mjs never even reaches the skip counter
    const passages = fs.readFileSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(passages).toHaveLength(1);
    expect(passages[0].path).toBe('def67890/notes.md');
  });
});

onPosix('ingest-gists.mjs — truncated content is fetched via raw_url, not silently dropped', () => {
  // BEHAVIOR CHANGE (Step 2, 2026-09-13): the OLD ad hoc ingest loop treated ANY truncated file as
  // unusable and failed the whole run rather than fetching it. Routing through the canonical
  // captureGistSources/defaultFetchRaw transport (the same one buildGistAggregate and
  // corpus-reconcile.mjs use) fixes that: a truncated file's raw_url is fetched for real, exactly
  // like every other gist producer in this repo already does. A tiny local HTTP server stands in
  // for gist.githubusercontent.com so this stays hermetic.
  //
  // Deliberately run as a genuinely SEPARATE OS process (spawn), never an in-process http.Server:
  // runGists() below drives the real ingest via spawnSync, which blocks this test process's entire
  // event loop for the duration of the child run. An in-process server could never service the
  // child's raw_url request while frozen like that -- exactly the deadlock this was first written
  // against and hit immediately.
  let server;
  let rawBase;
  beforeEach(async () => {
    server = spawn(process.execPath, ['-e', [
      "const http = require('node:http');",
      "const s = http.createServer((req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end('The full, untruncated body.'); });",
      "s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port)); });",
    ].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'] });
    const port = await new Promise((resolve) => { server.stdout.once('data', (chunk) => resolve(String(chunk).trim())); });
    rawBase = `http://127.0.0.1:${port}`;
  });
  afterEach(() => {
    server.kill();
  });

  it('fetches the raw_url for a truncated file and ingests its full content', () => {
    // The list endpoint's file entries ALSO carry raw_url/size/type/language for real -- the exact
    // per-file identity captureGistSources cross-checks the detail fetch against.
    writeFixture('list.json', [{ id: GIST_C, updated_at: '2026-07-03T00:00:00Z', description: 'Huge gist',
      files: { 'big-log.md': { filename: 'big-log.md', raw_url: `${rawBase}/big-log.md`, size: 999999, type: 'text/plain', language: 'Markdown' } } }]);
    writeFixture(`gists/${GIST_C}.json`, {
      id: GIST_C, updated_at: '2026-07-03T00:00:00Z', description: 'Huge gist',
      history: [{ version: 'e'.repeat(40) }],
      files: { 'big-log.md': { filename: 'big-log.md', raw_url: `${rawBase}/big-log.md`, size: 999999, type: 'text/plain', language: 'Markdown',
        truncated: true, content: '' } },
    });
    const r = runGists([]);
    expect(r.code, r.stderr).toBe(0);
    const passages = fs.readFileSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(passages).toHaveLength(1);
    expect(passages[0].text).toMatch(/The full, untruncated body\.$/);
  });
});

onPosix('ingest-gists.mjs — gh failure falls back to the public API; only a dead fallback is fatal', () => {
  // Contract changed 2026-07-13 (gists-nightly was born broken: GITHUB_TOKEN is an App token and the
  // gists API is closed to those, so in Actions gh can NEVER list gists): a gh failure now falls back
  // to the unauthenticated public API. RUVNET_GISTS_API points the fallback at a dead local port so
  // this stays hermetic — no live API call — and the DOUBLE failure is what must exit non-zero.
  it('exits non-zero with both error trails when gh fails AND the public API is unreachable', () => {
    writeFixture('list.json', ONE_GIST); // unused — GH_FAIL short-circuits before the case statement
    const r = runGists(['--dry-run'], { forceFail: true, env: { RUVNET_GISTS_API: 'http://127.0.0.1:9' } });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/gh api users\/ruvnet\/gists.*failed: stub-forced-failure/); // trail 1: gh
    expect(r.stderr).toMatch(/falling back to unauthenticated API/); // the fallback engaged
    expect(r.stderr).toMatch(/fetch failed|ECONNREFUSED/); // trail 2: the fallback died too
  });
});

describe.todo('ingest-gists.mjs — remaining gaps blocked on module-private functions (no export seam; flagged, not applied per this suite\'s sign-off norm)', () => {
  it.todo('chunk(text) never splits WITHIN a single paragraph larger than `size` (3200) — one oversized paragraph becomes one oversized chunk, no hard cap enforced');
  it.todo('chunk(text) collapses 3+ consecutive newlines the same as exactly 2 (the `/\\n\\n+/` split regex)');
  it.todo('chunk("") and chunk(whitespace-only) both return [] rather than [""]');
  it.todo('banner(g, file) falls back to the filename when g.description is empty/missing');
  it.todo('banner(g, file) prints the literal string "undefined" for the updated date when g.updated_at is missing (g.updated_at?.slice(0,10) on undefined) — a real formatting gap, not just a hypothetical');
  it.todo('listGists\'s pages.flat() defensive handling: a --slurp response shaped as an array-of-pages (nested one level) flattens to the same result as an already-flat array');
  it.todo('the incremental "nothing to do" short-circuit (unchanged gists AND an existing passages.jsonl) only fires on a SECOND run — requires seeding kb/ruv-gists.passages.jsonl from a prior real run first, not just a fresh tmpdir');
  it.todo('--dry-run\'s "… and N more" truncation message when more than 20 gists have changed');
});
