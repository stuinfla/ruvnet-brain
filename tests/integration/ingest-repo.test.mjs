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

  binDir = path.join(tmp, 'stub-bin');
  fs.mkdirSync(binDir);
  logFile = path.join(tmp, 'calls.log');

  // Stub `git`: record argv, never touch the network, always succeed.
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\necho "git $*" >> "$LOGFILE"\nexit 0\n`);
  fs.chmodSync(path.join(binDir, 'git'), 0o755);

  // Stub `node`: record argv. Fails ONLY when invoked for build-symbols.mjs, so the try/catch
  // swallow around that call (line 54 of ingest-repo.mjs) can be exercised deterministically.
  fs.writeFileSync(path.join(binDir, 'node'),
    `#!/bin/sh\necho "node $*" >> "$LOGFILE"\ncase "$*" in\n  *build-symbols.mjs*) exit 1 ;;\n  *) exit 0 ;;\nesac\n`);
  fs.chmodSync(path.join(binDir, 'node'), 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runIngest(args) {
  // process.execPath (absolute) for the OUTER process bypasses PATH entirely, so only the INNER
  // run('git', ...) / run('node', ...) calls made by the script itself resolve to our stubs.
  const r = spawnSync(process.execPath, ['scripts/ingest-repo.mjs', ...args], {
    cwd: tmp,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, LOGFILE: logFile },
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
