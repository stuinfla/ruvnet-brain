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

// A PATH containing ONLY the tools nightly-gists.sh legitimately needs — and never `gh`.
//
// The old PATH was NODE_DIR + /usr/bin + /bin, commented "deliberately excludes any dir a real gh
// might live in". True on macOS (gh is /opt/homebrew/bin/gh). FALSE on Linux, where gh is
// /usr/bin/gh — so the "gh not on PATH" case FOUND gh, fell through to the auth guard, and logged
// "FATAL: gh not authenticated". The test passed here and failed on ubuntu because it encoded one
// machine's filesystem layout. (On Ubuntu /bin is a symlink to /usr/bin, so dropping one and keeping
// the other changes nothing.)
//
// Symlinking exactly the binaries we want makes the ABSENCE of gh a property of the test, not of the
// host — the same discipline the rest of this suite uses when it stubs its dependencies.
const SAFE_BIN = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safebin-'));
  // `dirname` is load-bearing: nightly-gists.sh's first line is `cd "$(dirname "$0")/.."`, and with
  // `set -eu` a missing dirname kills the script before it writes even one log line (symptom: the
  // assertion sees an empty log). Symlink every external the script actually invokes.
  for (const cmd of ['sh', 'dash', 'bash', 'dirname', 'basename', 'date', 'mkdir', 'grep', 'sed', 'cat', 'rm', 'env', 'sleep', 'tr']) {
    const r = spawnSync('sh', ['-c', 'command -v "$1"', '_', cmd], { encoding: 'utf8' });
    const resolved = (r.stdout || '').trim();
    if (!resolved || !fs.existsSync(resolved)) continue; // some are shell builtins — fine
    try { fs.symlinkSync(resolved, path.join(dir, cmd)); } catch { /* already linked */ }
  }
  return dir;
})();

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

  // Stub kb/forge-big.mjs: records every invocation (shard embeds + the final ingest). `embed`
  // exits 0 unless FAIL_SHARD names its shard index. `shard-all` — the real supervisor mode
  // nightly-gists.sh now calls instead of fanning shards out itself — mimics the real one closely
  // enough for this suite's contract: it spawns `--shards` copies of ITSELF in `embed` mode and
  // exits non-zero iff any of them did.
  fs.writeFileSync(path.join(tmp, 'kb/forge-big.mjs'), [
    "import fs from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "const argv = process.argv.slice(2);",
    "fs.appendFileSync(process.env.CALL_LOG, `forge-big ${argv.join(' ')}\\n`);",
    "const mode = argv[0];",
    "if (mode === 'embed') {",
    "  const shardIdx = argv.indexOf('--shard');",
    "  if (shardIdx !== -1 && argv[shardIdx + 1] === process.env.FAIL_SHARD) process.exit(1);",
    "  process.exit(0);",
    "}",
    "if (mode === 'shard-all') {",
    "  const n = Number(argv[argv.indexOf('--shards') + 1]);",
    "  let failed = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    const r = spawnSync(process.execPath, [process.argv[1], 'embed', '--dir', 'kb', '--name', 'ruv-gists', '--shard', String(i), '--of', String(n)], { stdio: 'inherit' });",
    "    if (r.status !== 0) failed++;",
    "  }",
    "  process.exit(failed > 0 ? 1 : 0);",
    "}",
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
      PATH: `${NODE_DIR}:${SAFE_BIN}`, // node + only the tools the script needs; gh absent on EVERY platform
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

// Windows cannot run these: POSIX shell-script stubs made executable with chmod (a no-op on Windows)
// and spawned by bare name off PATH. CI runs integration on ubuntu only; a Windows dev box skips cleanly.
const onPosix = describe.skipIf(process.platform === 'win32');

onPosix('nightly-gists.sh — FATAL guards (verified against a patched-PATH copy, real file never touched)', () => {
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

  it('runs shard-all (which fans out all 8 embed shards) + the final ingest when the corpus actually changed', () => {
    const out = run({ INGEST_MODE: 'changed' });
    expect(out.status).toBe(0);
    expect(out.log).toMatch(/done — ruv-gists store rebuilt/);
    expect(out.calls).toContain('forge-big shard-all --dir kb --name ruv-gists --shards 8 --stall-minutes 15');
    const shardCalls = out.calls.filter((c) => c.startsWith('forge-big embed'));
    expect(shardCalls).toHaveLength(8);
    expect(out.calls).toContain('forge-big ingest --dir kb --name ruv-gists');
  });

  // FIXED (F6, 2026-07-18 — was "LIVE BUG: a failing embed shard is silently swallowed"): the 8
  // embed shards ran backgrounded (`&`) joined by a bare `wait`, which under POSIX ALWAYS returns 0
  // regardless of what any backgrounded job did — so a genuinely failed shard (OOM, corrupt .rvf,
  // killed ONNX) was silently swallowed and the script logged "done — store rebuilt" over a corpus
  // that was 1/8 missing. That fix (per-PID `wait "$p" || FAILED_SHARDS+=1`) has since been
  // superseded (2026-09-11) by `forge-big.mjs shard-all`, a real supervisor that also detects a
  // STALLED shard (0% CPU, no failure, no exit) — something a bare `wait` could never see at all.
  // This test asserts the same externally-visible contract survived the handoff: a failing shard
  // fails the run LOUDLY, never claims "done", and never ingests a half-embedded corpus.
  it('a failing embed shard fails the run LOUDLY — exit 1, no "done" claim, no ingest', () => {
    const out = run({ INGEST_MODE: 'changed', FAIL_SHARD: '3' });
    expect(out.status).toBe(1); // shard failure is a run failure — the wrapper/watchdog see it
    expect(out.log).toMatch(/EMBED FAILED — shard-all reported a failure or a stall/); // names the damage
    expect(out.log).not.toMatch(/done — ruv-gists store rebuilt/); // success is never claimed
    expect(out.calls.filter((c) => c.startsWith('forge-big embed'))).toHaveLength(8); // all shards ran
    expect(out.calls).not.toContain('forge-big ingest --dir kb --name ruv-gists'); // half-embedded corpus never ingested
  });
});
