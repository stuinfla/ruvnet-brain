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
// LIVE-REPRODUCED FINDING (not fixed here, same norm as every other gap file in this suite — flagged,
// not silently patched): a gist file with `truncated: true` and a `raw_url` is NEVER actually fetched
// from that raw_url. `body = f.truncated && f.raw_url ? '' : (f.content || '')` unconditionally sets
// body to the EMPTY STRING for any truncated file, so it falls into `if (!body.trim()) { skipped++;
// continue; }` and is silently dropped — the exact case the `raw_url` field exists to handle. A large
// gist (>1MB, the GitHub truncation threshold) contributes ZERO of its real content to the KB, with no
// error and no signal beyond the aggregate "N skipped" count in stdout. Reproduced for real below.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

let tmp, binDir, logFile, fixtures;

beforeEach(() => {
  // realpathSync: macOS's os.tmpdir() resolves through a /tmp -> /private/tmp symlink; the child
  // process resolves its own script path to the REAL path, so string comparisons need the same form.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-gists-')));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'kb'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/ingest-gists.mjs'), path.join(tmp, 'scripts/ingest-gists.mjs'));

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

function writeFixture(name, obj) {
  fs.writeFileSync(path.join(fixtures, name), JSON.stringify(obj));
}

function runGists(args, { forceFail = false } = {}) {
  const r = spawnSync(process.execPath, ['scripts/ingest-gists.mjs', ...args], {
    cwd: tmp,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      LOGFILE: logFile,
      FIXTURES: fixtures,
      GH_FAIL: forceFail ? '1' : '',
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

const ONE_GIST = [{
  id: 'abc12345', updated_at: '2026-07-01T00:00:00Z', description: 'Flywheel notes',
  files: { 'flywheel.md': {} },
}];
const ONE_GIST_FULL = {
  id: 'abc12345', updated_at: '2026-07-01T00:00:00Z', description: 'Flywheel notes',
  files: { 'flywheel.md': { content: 'Some flywheel content here.', truncated: false } },
};

describe('ingest-gists.mjs — --index-only (the actual nightly-CI invocation)', () => {
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

describe('ingest-gists.mjs — --dry-run', () => {
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

describe('ingest-gists.mjs — real ingest, banner + chunking', () => {
  it('writes passages.jsonl with the provenance banner prepended to every passage, plus meta.json and the cache', () => {
    writeFixture('list.json', ONE_GIST);
    writeFixture('gists/abc12345.json', ONE_GIST_FULL);
    const r = runGists([]);
    expect(r.code).toBe(0);

    const passages = fs.readFileSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(passages).toHaveLength(1);
    expect(passages[0].path).toBe('abc12345/flywheel.md'); // single chunk: no `#N` suffix
    expect(passages[0].text).toMatch(/^SOURCE: GitHub gist by @ruvnet — "Flywheel notes"/);
    expect(passages[0].text).toMatch(/GIST STATUS: rUv's own notes/);
    expect(passages[0].text).toMatch(/Some flywheel content here\.$/);

    const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'kb/ruv-gists.meta.json'), 'utf8'));
    expect(meta.entries['0'].path).toBe('abc12345/flywheel.md');
    expect(meta.entries['0'].kind).toBe('doc');

    const cache = JSON.parse(fs.readFileSync(path.join(tmp, 'kb/.ruv-gists.cache.json'), 'utf8'));
    expect(cache).toEqual({ abc12345: '2026-07-01T00:00:00Z' });

    // writeIndex also runs at the end of a real ingest, not just --index-only.
    expect(fs.existsSync(path.join(tmp, 'docs/RUV-GISTS.md'))).toBe(true);
  });

  it('forwards --owner into the list call instead of the "ruvnet" default', () => {
    writeFixture('list.json', ONE_GIST);
    const r = runGists(['--owner', 'someorg', '--dry-run']);
    expect(r.calls[0]).toBe('gh api users/someorg/gists?per_page=100 --paginate --slurp');
  });
});

describe('ingest-gists.mjs — code files are silently excluded by design (TEXT_EXT), counted as neither indexed nor skipped', () => {
  it('indexes only the .md file in a gist that also contains a .mjs file', () => {
    writeFixture('list.json', [{ id: 'def67890', updated_at: '2026-07-02T00:00:00Z', description: 'Mixed gist', files: { 'run.mjs': {}, 'notes.md': {} } }]);
    writeFixture('gists/def67890.json', {
      id: 'def67890', updated_at: '2026-07-02T00:00:00Z', description: 'Mixed gist',
      files: {
        'run.mjs': { content: 'console.log(1)', truncated: false },
        'notes.md': { content: 'Prose notes.', truncated: false },
      },
    });
    const r = runGists([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/1 text files/); // not 2 — run.mjs never even reaches the skip counter
    const passages = fs.readFileSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(passages).toHaveLength(1);
    expect(passages[0].path).toBe('def67890/notes.md');
  });
});

describe('ingest-gists.mjs — LIVE BUG: truncated content is silently dropped, never fetched from raw_url', () => {
  it('a truncated file with a raw_url present still produces ZERO passages for that file', () => {
    writeFixture('list.json', [{ id: 'trunc001', updated_at: '2026-07-03T00:00:00Z', description: 'Huge gist', files: { 'big-log.md': {} } }]);
    writeFixture('gists/trunc001.json', {
      id: 'trunc001', updated_at: '2026-07-03T00:00:00Z', description: 'Huge gist',
      files: { 'big-log.md': { truncated: true, raw_url: 'https://gist.githubusercontent.com/ruvnet/trunc001/raw/big-log.md', content: '' } },
    });
    const r = runGists([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/1 skipped/); // the ONLY signal this ever happened is an aggregate count
    // passages.jsonl is still written (main() has no early-return here) but with ZERO real content —
    // the truncated file's text never made it in, despite raw_url being available on the fixture.
    const passages = fs.readFileSync(path.join(tmp, 'kb/ruv-gists.passages.jsonl'), 'utf8').trim();
    expect(passages).toBe('');
    // Proves the bug: `gh()` (and therefore the stub) was NEVER called a second time for the raw_url,
    // even though one exists on the fixture — only the original per-gist fetch call is logged.
    expect(r.calls.filter((c) => c.includes('trunc001'))).toHaveLength(1);
  });
});

describe('ingest-gists.mjs — gh failure propagates as a real, non-zero-exit error', () => {
  it('exits non-zero with the gh() error message when the list call fails', () => {
    writeFixture('list.json', ONE_GIST); // unused — GH_FAIL short-circuits before the case statement
    const r = runGists(['--dry-run'], { forceFail: true });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/gh api users\/ruvnet\/gists.*failed: stub-forced-failure/);
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
