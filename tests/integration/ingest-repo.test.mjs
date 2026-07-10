// tests/integration/ingest-repo.test.mjs — scripts/ingest-repo.mjs is the on-demand "load a new
// RuvNet repo into the brain" pipeline (clone -> MiniLM embed -> bge-768 sharp embed -> symbol
// index). It has never had a test: prior coverage-gap passes (2026-07-07/08, memory
// `test-coverage-gaps-2026-07-07`) explicitly deferred it as "best suited to a subprocess
// integration test" and left it untouched. This is that test.
//
// WHY SUBPROCESS + CLONED ROOT, NOT IMPORT: ingest-repo.mjs runs its whole pipeline at module-load
// time via synchronous execFileSync calls and ends with process.exit() — importing it in-process
// would attempt a REAL `git clone` against github.com and could exit the test runner. It also
// computes ROOT from its own file location (fileURLToPath(import.meta.url) + '..'), so `clones/`
// and `kb/` always resolve to whatever directory the copy of the script lives in — copying only
// scripts/ingest-repo.mjs into a fresh tmpdir (mirroring build-bundle-fence.test.mjs's approach)
// gives it a fully isolated ROOT with no risk of writing into the real repo's clones/ or kb/.
//
// WHY PATH-STUBBED git/node, NOT REAL: the real pipeline needs network access (git clone) and a
// loaded ONNX model cache (forge-build.mjs/forge-big.mjs) — neither belongs in a fast test tier.
// Stub executables prepended to PATH let us observe exactly what ingest-repo.mjs would have run
// (command, args, order, cwd) without any of that, and let us simulate failure branches (e.g.
// build-symbols.mjs erroring) that would be slow/flaky to provoke for real.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

let tmp;
let binDir;
let logFile;

beforeEach(() => {
  // realpathSync: macOS's os.tmpdir() is under a symlink (/tmp -> /private/tmp); the child process
  // resolves its own script location to the REAL path, so comparisons must use the same resolution.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-repo-')));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'kb'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/ingest-repo.mjs'), path.join(tmp, 'scripts/ingest-repo.mjs'));
  // ingest-repo.mjs statically imports the SHARED depth config (scripts/full-hints.mjs — the
  // one map both it and self-update.mjs read, so --full/--keep hints can never drift between
  // entrypoints again). The isolated ROOT must carry the script's real dependency set.
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/full-hints.mjs'), path.join(tmp, 'scripts/full-hints.mjs'));

  binDir = path.join(tmp, 'stub-bin');
  fs.mkdirSync(binDir);
  logFile = path.join(tmp, 'calls.log');

  // Stub `git`: record argv, never touch the network, always succeed.
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\necho "git $*" >> "$LOGFILE"\nexit 0\n`);
  fs.chmodSync(path.join(binDir, 'git'), 0o755);

  // Stub `node`: record argv. Fails when invoked for build-symbols.mjs (so the try/catch swallow
  // around that call, line 54 of ingest-repo.mjs, can be exercised deterministically), or when
  // FAIL_SHARD names a specific `--shard N` embed invocation (so RUVNET_BIG_SHARDS failure
  // propagation can be exercised the same way pass 29's nightly-gists.sh FAIL_SHARD knob did).
  fs.writeFileSync(path.join(binDir, 'node'),
    `#!/bin/sh\necho "node $*" >> "$LOGFILE"\ncase "$*" in\n  *build-symbols.mjs*) exit 1 ;;\nesac\nif [ -n "$FAIL_SHARD" ]; then\n  case "$*" in\n    *"--shard $FAIL_SHARD --of"*) exit 1 ;;\n  esac\nfi\nexit 0\n`);
  fs.chmodSync(path.join(binDir, 'node'), 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runIngest(args, extraEnv = {}) {
  // process.execPath (absolute) for the OUTER process bypasses PATH entirely, so only the INNER
  // run('git', ...) / run('node', ...) calls made by the script itself resolve to our stubs.
  const r = spawnSync(process.execPath, ['scripts/ingest-repo.mjs', ...args], {
    cwd: tmp,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, LOGFILE: logFile, ...extraEnv },
    encoding: 'utf8',
  });
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    calls: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

describe('ingest-repo.mjs — CLI argument guard', () => {
  it('exits 2 with a usage message when --name is missing', () => {
    const r = runIngest([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Usage: node scripts\/ingest-repo\.mjs --name <repo> \[--org <github-org>\]/);
    expect(r.calls).toEqual([]); // fails before ever shelling out
  });
});

describe('ingest-repo.mjs — clone vs. update branch selection', () => {
  it('clones (--depth 1) from github.com/<org>/<name> when clones/<name>/.git does not exist yet, defaulting org to "ruvnet"', () => {
    const r = runIngest(['--name', 'zzz-fixture']);
    expect(r.calls[0]).toBe(`git clone --depth 1 https://github.com/ruvnet/zzz-fixture ${path.join(tmp, 'clones/zzz-fixture')}`);
    expect(r.stdout).toMatch(/\[clone\] ruvnet\/zzz-fixture/);
  });

  it('forwards a custom --org into the clone URL instead of the ruvnet default', () => {
    const r = runIngest(['--name', 'zzz-fixture', '--org', 'some-collaborator-org']);
    expect(r.calls[0]).toMatch(/^git clone --depth 1 https:\/\/github\.com\/some-collaborator-org\/zzz-fixture /);
  });

  it('fetches + hard-resets (no clone) when clones/<name>/.git already exists', () => {
    fs.mkdirSync(path.join(tmp, 'clones/zzz-fixture/.git'), { recursive: true });
    const r = runIngest(['--name', 'zzz-fixture']);
    const dir = path.join(tmp, 'clones/zzz-fixture');
    expect(r.calls[0]).toBe(`git -C ${dir} fetch --depth 1 origin`);
    expect(r.calls[1]).toBe(`git -C ${dir} reset --hard origin/HEAD`);
    expect(r.calls.some((c) => c.startsWith('git clone'))).toBe(false);
    expect(r.stdout).toMatch(/\[update\] ruvnet\/zzz-fixture/);
  });
});

describe('ingest-repo.mjs — embed pipeline invocation order + cwd', () => {
  it('runs forge-build.mjs (MiniLM-384) before forge-big.mjs (bge-768 sharp), both from the kb/ cwd', () => {
    const r = runIngest(['--name', 'zzz-fixture']);
    const nodeCalls = r.calls.filter((c) => c.startsWith('node '));
    expect(nodeCalls[0]).toMatch(/forge-build\.mjs --repo .* --out \. --name zzz-fixture --canonical-url/);
    expect(nodeCalls[1]).toMatch(/forge-big\.mjs both --dir \. --name zzz-fixture/);
    expect(r.stdout).toMatch(/\[embed MiniLM-384\] zzz-fixture[\s\S]*\[embed bge-768 sharp\] zzz-fixture/);
  });
});

describe('ingest-repo.mjs — depth config (--full/--keep) forwarding into forge-build.mjs', () => {
  // Before this (2026-07-10), ingest-repo.mjs never passed --full at all: any repo rebuilt through
  // this entrypoint silently lost its full-body source indexing. 'ruview' is a real FULL_HINTS AND
  // KEEP_DIRS entry in the shared scripts/full-hints.mjs map, so one name exercises both lookups.
  it('forwards the shared FULL_HINTS/KEEP_DIRS lookup for a name present in the map', () => {
    const r = runIngest(['--name', 'ruview']);
    const buildCall = r.calls.find((c) => c.includes('forge-build.mjs'));
    expect(buildCall).toMatch(/--full firmware\/esp32-csi-node,firmware\/esp32-hello-world,v2\/crates/);
    expect(buildCall).toMatch(/--keep v2/);
  });

  it('an explicit --full/--keep CLI arg overrides the shared-map lookup', () => {
    const r = runIngest(['--name', 'ruview', '--full', 'custom/prefix', '--keep', 'legacy']);
    const buildCall = r.calls.find((c) => c.includes('forge-build.mjs'));
    expect(buildCall).toMatch(/--full custom\/prefix/);
    expect(buildCall).toMatch(/--keep legacy/);
  });

  it('omits --full/--keep entirely for a name absent from both maps and with no CLI override', () => {
    const r = runIngest(['--name', 'zzz-fixture']);
    const buildCall = r.calls.find((c) => c.includes('forge-build.mjs'));
    expect(buildCall).not.toMatch(/--full|--keep/);
  });
});

describe('ingest-repo.mjs — RUVNET_BIG_SHARDS parallel embed', () => {
  it('defaults to a single "forge-big.mjs both" call when RUVNET_BIG_SHARDS is unset', () => {
    const r = runIngest(['--name', 'zzz-fixture']);
    const bigCalls = r.calls.filter((c) => c.includes('forge-big.mjs'));
    expect(bigCalls).toHaveLength(1);
    expect(bigCalls[0]).toMatch(/forge-big\.mjs both --dir \. --name zzz-fixture/);
  });

  it('RUVNET_BIG_SHARDS=3 fans out 3 "embed --shard N --of 3" calls, then exactly one "ingest" call, never "both"', () => {
    const r = runIngest(['--name', 'zzz-fixture'], { RUVNET_BIG_SHARDS: '3' });
    // Reaches the final store-existence check (same [FAIL] as the sibling "final store-existence
    // check" tests below — the stub never writes real .rvf files) rather than crashing mid-shard.
    expect(r.stdout).toMatch(/\[FAIL\] zzz-fixture: expected stores missing after build\./);
    const bigCalls = r.calls.filter((c) => c.includes('forge-big.mjs'));
    expect(bigCalls.some((c) => c.includes(' both '))).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(bigCalls.some((c) => c.includes(`--shard ${i} --of 3`))).toBe(true);
    }
    expect(bigCalls.filter((c) => c.includes(' ingest '))).toHaveLength(1);
  });

  it('a failing embed shard aborts the pipeline non-zero instead of silently proceeding to the final ingest', () => {
    // Same "success that measured nothing" bug class this suite has flagged 4x elsewhere
    // (brain-grade-groundtruth.mjs, eval-brain.mjs, behavioral-l1-l4.mjs, nightly-gists.sh) — this
    // proves the NEW sharded path does NOT join that list.
    const r = runIngest(['--name', 'zzz-fixture'], { RUVNET_BIG_SHARDS: '3', FAIL_SHARD: '1' });
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => c.includes('forge-big.mjs ingest'))).toBe(false);
  });
});

describe('ingest-repo.mjs — build-symbols.mjs failure is swallowed, not fatal', () => {
  it('logs "(symbols skipped — sparse repo)" and still reaches the final store check when build-symbols.mjs exits non-zero', () => {
    const r = runIngest(['--name', 'zzz-fixture']);
    expect(r.stdout).toMatch(/\(symbols skipped — sparse repo\)/);
    // Reaches the final existence check rather than crashing on the build-symbols.mjs failure.
    expect(r.stdout).toMatch(/expected stores missing after build|ingested → searchable now/);
  });
});

describe('ingest-repo.mjs — final store-existence check', () => {
  it('exits 1 and reports FAIL when the stub pipeline never actually produced the .rvf files', () => {
    // node is stubbed to a no-op, so <name>.rvf / <name>.big.rvf never actually get written —
    // this exercises the "trust but verify your own pipeline's output" check on line 56.
    const r = runIngest(['--name', 'zzz-fixture']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\] zzz-fixture: expected stores missing after build\./);
  });

  it.todo('exits 0 and reports success when both <name>.rvf and <name>.big.rvf exist in kb/ after the pipeline runs (requires letting the node stub touch the two files, or running the real embed pipeline against a tiny fixture repo)');
});
