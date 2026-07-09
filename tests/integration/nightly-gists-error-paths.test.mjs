// tests/integration/nightly-gists-error-paths.test.mjs — scripts/nightly-gists.sh (untracked, new
// launchd job for the com.ruvnet.brain-gists agent) had ZERO tests before this file. Its own header
// comment documents 3 FATAL guards plus one cost-discipline branch (skip the ~18min re-embed entirely
// when nothing changed) — none were exercised anywhere.
//
// TEST-ONLY SOURCE PATCH, DOCUMENTED UP FRONT: the real script's first executable line is
// `export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"` — a literal REASSIGNMENT, not an
// append to the caller's $PATH (its own comment explains why: launchd doesn't inherit a login shell's
// env, so PATH must be pinned to real absolute dirs). That single line defeats the PATH-stubbing
// technique this suite otherwise relies on everywhere (ingest-repo.test.mjs, ingest-gists.test.mjs):
// any env.PATH the test sets is thrown away before `gh` is ever checked. Worse, it makes the "gh
// missing" branch UNTESTABLE-BY-ACCIDENT on Stuart's own machine specifically, since `gh` genuinely
// lives at /opt/homebrew/bin there — a naive test setting env.PATH to something else would still find
// the real gh via the hardcoded line and silently test nothing.
// FIX APPLIED HERE (test-only, never touches the real file): copy the script into an isolated tmp
// root and replace ONLY that one line with `export PATH="${TEST_STUB_BIN:+$TEST_STUB_BIN:}$PATH"` —
// preserves the caller's PATH instead of discarding it, so stub `gh`/scripts become reachable. Confirmed
// by diffing the patched copy against the real file: exactly one line differs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const NODE_DIR = path.dirname(process.execPath);

let tmp, stubBin, callLog;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-gists-')));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'kb'), { recursive: true });
  stubBin = path.join(tmp, 'stub-bin');
  fs.mkdirSync(stubBin);
  callLog = path.join(tmp, 'calls.log');

  const real = fs.readFileSync(path.join(REPO_ROOT, 'scripts/nightly-gists.sh'), 'utf8');
  const pinnedLine = 'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"';
  if (!real.includes(pinnedLine)) {
    throw new Error('nightly-gists.sh no longer has the expected hardcoded PATH line — update this test\'s patch to match the new source.');
  }
  const patched = real.replace(pinnedLine, 'export PATH="${TEST_STUB_BIN:+$TEST_STUB_BIN:}$PATH"');
  fs.writeFileSync(path.join(tmp, 'scripts/nightly-gists.sh'), patched);

  // Stub gh: only implements `auth status`, dispatched on argv shape. Fails if GH_AUTH_FAIL=1.
  fs.writeFileSync(path.join(stubBin, 'gh'), [
    '#!/bin/sh',
    'echo "gh $*" >> "$CALL_LOG"',
    '[ "$1 $2" = "auth status" ] || { echo "unhandled gh args: $*" >&2; exit 1; }',
    '[ "$GH_AUTH_FAIL" = "1" ] && exit 1',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(stubBin, 'gh'), 0o755);

  // Stub scripts/ingest-gists.mjs: --index-only always "succeeds"; the plain call's behavior is
  // driven by INGEST_MODE so each test controls exactly one branch of nightly-gists.sh.
  fs.writeFileSync(path.join(tmp, 'scripts/ingest-gists.mjs'), [
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.CALL_LOG, `ingest ${process.argv.slice(2).join(' ')}\\n`);",
    "if (process.argv.includes('--index-only')) { console.log('index refreshed'); process.exit(0); }",
    "const mode = process.env.INGEST_MODE || 'nothing';",
    "if (mode === 'fail') { console.error('stub-forced ingest failure'); process.exit(1); }",
    "if (mode === 'nothing') { console.log('nothing to do'); process.exit(0); }",
    "console.log('3 gists changed'); process.exit(0);", // mode === 'changed'
  ].join('\n'));

  // Stub kb/forge-big.mjs: records every invocation (shard embeds + the final ingest). Exits 0 unless
  // FAIL_SHARD names an embed shard index to fail — lets one test prove a shard failure is swallowed.
  fs.writeFileSync(path.join(tmp, 'kb/forge-big.mjs'), [
    "import fs from 'node:fs';",
    "const argv = process.argv.slice(2);",
    "fs.appendFileSync(process.env.CALL_LOG, `forge-big ${argv.join(' ')}\\n`);",
    "const shardIdx = argv.indexOf('--shard');",
    "if (shardIdx !== -1 && argv[shardIdx + 1] === process.env.FAIL_SHARD) process.exit(1);",
  ].join('\n'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(env = {}) {
  const r = spawnSync('sh', ['scripts/nightly-gists.sh'], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      PATH: `${NODE_DIR}:/usr/bin:/bin`, // deliberately excludes any dir a real `gh` might live in
      TEST_STUB_BIN: stubBin,
      CALL_LOG: callLog,
      HOME: process.env.HOME,
      ...env,
    },
  });
  return {
    status: r.status,
    log: fs.existsSync(path.join(tmp, 'logs/gists-nightly.log'))
      ? fs.readFileSync(path.join(tmp, 'logs/gists-nightly.log'), 'utf8')
      : '',
    calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

describe('nightly-gists.sh — FATAL guards (verified against a patched-PATH copy, real file never touched)', () => {
  it('exits 1 and logs FATAL when gh is not reachable on PATH at all (no stub-bin)', () => {
    const out = run({ TEST_STUB_BIN: '' }); // omit the stub dir entirely -> gh genuinely not found
    expect(out.status).toBe(1);
    expect(out.log).toMatch(/FATAL: gh not on PATH/);
    expect(out.calls).toEqual([]); // never even reached the gh-auth check, let alone ingest
  });

  it('exits 1 and logs FATAL when gh exists but is not authenticated', () => {
    const out = run({ GH_AUTH_FAIL: '1' });
    expect(out.status).toBe(1);
    expect(out.log).toMatch(/FATAL: gh not authenticated/);
    expect(out.calls).toEqual(['gh auth status']); // ingest never invoked
  });

  it('exits 1 and logs FATAL when ingest-gists.mjs itself fails — re-embed never runs', () => {
    const out = run({ INGEST_MODE: 'fail' });
    expect(out.status).toBe(1);
    expect(out.log).toMatch(/FATAL: ingest failed/);
    expect(out.calls).toEqual(['gh auth status', 'ingest --index-only', 'ingest']);
    expect(out.calls.some((c) => c.startsWith('forge-big'))).toBe(false);
  });

  it('skips the ~18min re-embed and exits 0 when ingest reports "nothing to do" — the actual cost guarantee', () => {
    const out = run({ INGEST_MODE: 'nothing' });
    expect(out.status).toBe(0);
    expect(out.log).toMatch(/no new gists — skipping embed \(cost: 0\)/);
    expect(out.calls.some((c) => c.startsWith('forge-big'))).toBe(false);
  });

  it('runs all 8 embed shards + the final ingest when the corpus actually changed', () => {
    const out = run({ INGEST_MODE: 'changed' });
    expect(out.status).toBe(0);
    expect(out.log).toMatch(/done — ruv-gists store rebuilt/);
    const shardCalls = out.calls.filter((c) => c.startsWith('forge-big embed'));
    expect(shardCalls).toHaveLength(8);
    expect(out.calls).toContain('forge-big ingest --dir kb --name ruv-gists');
  });

  // LIVE BUG (found while auditing this file, not the "error-paths" set the file name promises):
  // the 8 embed shards run backgrounded (`&`) then joined with a bare `wait` (script's own lines
  // 52-57). Reproduced directly in a bare `sh` script before writing this test: `set -eu` does not
  // apply to backgrounded commands, and POSIX `wait` with no PID list always returns exit status 0
  // regardless of what any backgrounded job did — so a genuinely failed shard (OOM, a corrupt .rvf
  // shard, a killed ONNX process) is silently swallowed. The script proceeds to the final `ingest`
  // call and logs "done — store rebuilt" even though 1/8 of the corpus never got re-embedded, with
  // no non-zero exit and no distinguishing log line — the same "success that measured nothing" bug
  // class this suite has already found 3 other times (brain-grade-groundtruth.mjs, eval-brain.mjs,
  // behavioral-l1-l4.mjs). Not fixed here (flag-don't-touch norm) — the fix is trivial once flagged:
  // capture each backgrounded PID and `wait "$pid" || failed=1` per shard instead of a bare `wait`.
  it('LIVE BUG: a failing embed shard is silently swallowed — script still logs "done" and exits 0', () => {
    const out = run({ INGEST_MODE: 'changed', FAIL_SHARD: '3' });
    expect(out.status).toBe(0); // should be 1 — a real shard failure went undetected
    expect(out.log).toMatch(/done — ruv-gists store rebuilt/); // claims success anyway
    expect(out.calls.filter((c) => c.startsWith('forge-big embed'))).toHaveLength(8); // shard 3 DID run and DID fail — just never checked
  });
});
