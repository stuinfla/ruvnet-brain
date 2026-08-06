/**
 * ruflo-bin-resolution.test.mjs — issues #99 and #105: one defect, filed twice.
 *
 * Both scripts hardcoded `~/.npm-global/bin/ruflo`, the owner's npm prefix. On a Homebrew, nvm,
 * Volta, or plain `npm -g` install that directory does not exist, so:
 *   • #99  scripts/distill-project.mjs      died with "ruflo is not at ~/.npm-global/bin/ruflo"
 *   • #105 plugin/scripts/learn-flush.mjs   threw ENOENT on every feed, into `catch {}` — silent
 * on machines where ruflo was installed and on PATH the whole time.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * BORN RED — verbatim, `npx vitest run tests/unit/ruflo-bin-resolution.test.mjs` against the
 * unmodified scripts (HEAD, before either fix): 6 failed | 7 passed (13).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *   FAIL  #99 · runs when ruflo is on PATH but not under ~/.npm-global
 *     AssertionError: expected 'ruflo is not at ~/.npm-global/bin/ruf…' not to match /ruflo is not at/
 *
 *   FAIL  #99 · when ruflo is nowhere, it names BOTH places it looked
 *     AssertionError: expected 'ruflo is not at ~/.npm-global/bin/ruf…' to match /PATH/
 *
 *   FAIL  #105 · feeds the learner when ruflo is on PATH but not under ~/.npm-global
 *     AssertionError: expected 'learn-flush: 0/3 fed (ruflo hooks fai…' to match /fed 3\/3/
 *
 *   FAIL  #105 · a FAILING feed is OBSERVABLE — the error reaches stderr instead of `catch {}`
 *     AssertionError: expected '' to match /learn-flush:.*FAILED/
 *
 *   FAIL  #105 · reports ONCE, bounded, when ruflo is nowhere at all — not eight silent ENOENTs
 *     AssertionError: expected '' to match /learn-flush: 0\/3 fed/
 *
 *   FAIL  #105 · TEETH: a healthy learner produces NO failure noise
 *     AssertionError: expected 'learn-flush: 0/3 fed (ruflo hooks fai…' to match /fed 3\/3/
 *
 * That `expected '' to match /FAILED/` is #105's second half in one line: three feed calls failed
 * and the process emitted ZERO bytes about it. Its stub sits AT ~/.npm-global/bin/ruflo on purpose,
 * so the old code resolved the binary perfectly well and the ONLY defect it can go red on is the
 * swallowed error — otherwise it would fail for the path bug and prove nothing about the catch.
 *
 * Every case is measured at the PROCESS boundary with a real HOME on disk, because the defect is a
 * filesystem-layout assumption and an in-process stub of `os.homedir()` cannot express it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const DISTILL = path.join(REPO, 'scripts', 'distill-project.mjs');
const LEARN_FLUSH = path.join(REPO, 'plugin', 'scripts', 'learn-flush.mjs');

// The stubs below are `#!/bin/sh` files invoked by PATH lookup. Windows has no shebang execution,
// and the resolver's .cmd branch is a different code path from the one #99/#105 are about.
const isWindows = process.platform === 'win32';

let tmp;      // a throwaway project cwd
let tmpHome;  // an isolated HOME — crucially, one with NO .npm-global at all
let binDir;   // a directory on PATH, standing in for /opt/homebrew/bin or an nvm shim dir

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-bin-')));
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruflo-bin-home-')));
  binDir = path.join(tmp, 'opt-bin');
  fs.mkdirSync(binDir, { recursive: true });
});
afterEach(() => {
  for (const d of [tmp, tmpHome]) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }
});

/** Put an executable `ruflo` at `dir`, and return its path. */
function stubRuflo(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'ruflo');
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

/**
 * A child env with a HOME that has no `.npm-global`, and `binDir` FIRST on PATH so the stub wins
 * over any real ruflo on the developer's machine. RUFLO_BIN is deliberately NOT set: it is the
 * escape hatch the old code already had, so a test that used it could not go red.
 */
const env = (extra = {}) => ({
  ...process.env,
  HOME: tmpHome,
  // USERPROFILE as well as HOME (25cda46's class, measured here). resolveRuflo() defaults `home` to
  // os.homedir(), which reads USERPROFILE on Windows and ignores HOME entirely — so in-process cases
  // that pass `home:` explicitly are fine, but every case that crosses the PROCESS boundary was
  // pointing the resolver at the REAL user profile, which is exactly the ~/.npm-global this fixture
  // exists to guarantee is absent. MEASURED under Windows homedir semantics before this line:
  // 2 failed | 11 passed, both #105 learn-flush cases red.
  USERPROFILE: tmpHome,
  PATH: binDir + path.delimiter + (process.env.PATH || ''),
  RUFLO_BIN: undefined,
  ...extra,
});

/**
 * The same env, but with a PATH that contains ONLY `binDir` — for the cases where ruflo must be
 * genuinely absent. Inheriting the developer's PATH is not good enough: it carries the real
 * ~/.npm-global/bin, and the resolver would (correctly) find the machine's own ruflo and the case
 * would prove nothing. Node is spawned by absolute path, and both scripts spawn nothing but ruflo.
 */
const envWithNoRuflo = (extra = {}) => env({ PATH: binDir, ...extra });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The resolver itself.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('resolveRuflo — one resolver, four ordered answers', () => {
  it('RUFLO_BIN is AUTHORITATIVE, returned as given even when it does not exist', () => {
    // No fallback: an override that quietly resolves to a DIFFERENT ruflo is not an override, and
    // the caller has to be able to name the exact path the user asked for back to them.
    stubRuflo(binDir, '#!/bin/sh\nexit 0\n');
    const got = resolveRuflo({ env: { RUFLO_BIN: '/nonexistent/ruflo', PATH: binDir }, home: tmpHome });
    expect(got).toBe('/nonexistent/ruflo');
  });

  it('prefers ~/.npm-global/bin/ruflo over PATH — Rule 21\'s ONE global binary, not PATH ordering', () => {
    const preferred = stubRuflo(path.join(tmpHome, '.npm-global', 'bin'), '#!/bin/sh\nexit 0\n');
    stubRuflo(binDir, '#!/bin/sh\nexit 0\n');
    expect(resolveRuflo({ env: { PATH: binDir }, home: tmpHome })).toBe(preferred);
  });

  it('#99/#105: finds ruflo on PATH when ~/.npm-global does not exist at all', () => {
    const onPath = stubRuflo(binDir, '#!/bin/sh\nexit 0\n');
    expect(fs.existsSync(path.join(tmpHome, '.npm-global')), 'the fixture must model a non-npm-global prefix').toBe(false);
    expect(resolveRuflo({ env: { PATH: binDir }, home: tmpHome })).toBe(onPath);
  });

  it('returns null when ruflo is genuinely absent — never a guessed path the user gets blamed for', () => {
    expect(resolveRuflo({ env: { PATH: binDir }, home: tmpHome })).toBe(null);
  });

  it('skips unreadable and empty PATH entries instead of throwing', () => {
    const onPath = stubRuflo(binDir, '#!/bin/sh\nexit 0\n');
    const messy = ['', '/nonexistent/dir', binDir].join(path.delimiter);
    expect(resolveRuflo({ env: { PATH: messy }, home: tmpHome })).toBe(onPath);
  });

  it('does not mistake a DIRECTORY named ruflo for the binary', () => {
    fs.mkdirSync(path.join(binDir, 'ruflo'), { recursive: true });
    expect(resolveRuflo({ env: { PATH: binDir }, home: tmpHome })).toBe(null);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// #99 — scripts/distill-project.mjs
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(isWindows)('#99 · distill-project on a non-npm-global prefix', () => {
  it('runs when ruflo is on PATH but not under ~/.npm-global', () => {
    stubRuflo(binDir, '#!/bin/sh\n'
      + 'case "$2" in\n'
      + '  distill) echo "reasoning_patterns | 10"; echo "episodes | 5"; exit 0;;\n'
      + 'esac\nexit 0\n');
    fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.swarm', 'memory.db'), 'x');

    const r = spawnSync(process.execPath, [DISTILL, '--project', tmp, '--dry-run'],
      { encoding: 'utf8', timeout: 30_000, env: env() });

    // MAGNITUDE, not direction: exit 0 AND the baseline it could only have read by running the
    // real binary. "Did not say 'not found'" alone would also be satisfied by a script that died
    // somewhere else.
    expect(r.stderr).not.toMatch(/ruflo is not at/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/before\s*:\s*10 patterns, 5 episodes/);
  });

  it('when ruflo is nowhere, it names BOTH places it looked', () => {
    fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.swarm', 'memory.db'), 'x');

    const r = spawnSync(process.execPath, [DISTILL, '--project', tmp, '--dry-run'],
      { encoding: 'utf8', timeout: 30_000, env: envWithNoRuflo() });

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\.npm-global/);
    expect(r.stderr).toMatch(/PATH/);
    expect(r.stderr).toMatch(/npm i -g ruflo@latest/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// #105 — plugin/scripts/learn-flush.mjs
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(isWindows)('#105 · learn-flush on a non-npm-global prefix, and its swallowed errors', () => {
  /** A queue of `n` DISTINCT captures — distinct because learn-flush dedupes before it feeds. */
  function seedQueue(n) {
    const q = path.join(tmp, 'queue.jsonl');
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(JSON.stringify({ tool: 'Bash', action: `verb${i}` }));
    fs.writeFileSync(q, lines.join('\n') + '\n');
    return q;
  }

  const flush = (q, extraEnv = {}) => spawnSync(process.execPath, [LEARN_FLUSH, '--sync'], {
    cwd: tmp,
    input: JSON.stringify({ session_id: 'ruflo-bin-sess', hook_event_name: 'SessionEnd' }),
    encoding: 'utf8',
    timeout: 60_000,
    env: env({ LEARN_QUEUE: q, RUVNET_LEARNING_SCOPE: 'project', ...extraEnv }),
  });

  it('feeds the learner when ruflo is on PATH but not under ~/.npm-global', () => {
    stubRuflo(binDir, '#!/bin/sh\nexit 0\n');
    const q = seedQueue(3);

    const r = flush(q);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/fed 3\/3/);
    // DERIVED, not asserted: the queue is only destroyed when its contents were actually fed.
    expect(fs.existsSync(q), 'a fully fed queue must be removed').toBe(false);
  });

  it('a FAILING feed is OBSERVABLE — the error reaches stderr instead of `catch {}`', () => {
    // The stub goes AT ~/.npm-global/bin/ruflo on purpose: the old code resolved that path
    // perfectly well, so the only defect this case can go red on is the swallowed error.
    stubRuflo(path.join(tmpHome, '.npm-global', 'bin'), '#!/bin/sh\necho "boom: learner refused" >&2\nexit 7\n');
    const q = seedQueue(3);

    const r = flush(q);

    expect(r.stderr).toMatch(/learn-flush:.*FAILED/);
    expect(r.stderr).toMatch(/3\/3 feed call\(s\) FAILED/);
    expect(r.stderr).toMatch(/queue is KEPT for retry/);
  });

  it('…and still exits 0 with the queue intact — observable, but never crashes SessionEnd', () => {
    stubRuflo(path.join(tmpHome, '.npm-global', 'bin'), '#!/bin/sh\nexit 7\n');
    const q = seedQueue(3);

    const r = flush(q);

    expect(r.status, 'a failing optional learner must not break session end').toBe(0);
    expect(fs.readFileSync(q, 'utf8').split('\n').filter(Boolean).length, 'nothing fed ⇒ nothing discarded').toBe(3);
  });

  it('reports ONCE, bounded, when ruflo is nowhere at all — not eight silent ENOENTs', () => {
    const q = seedQueue(3);

    const r = flush(q, { PATH: binDir });

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/learn-flush: 0\/3 fed/);
    expect(r.stderr).toMatch(/\.npm-global/);
    expect(r.stderr).toMatch(/PATH/);
    // Bounded: one line about the failure, not one per action.
    const lines = r.stderr.split('\n').filter((l) => l.startsWith('learn-flush:'));
    expect(lines.length).toBe(1);
    expect(fs.readFileSync(q, 'utf8').split('\n').filter(Boolean).length).toBe(3);
  });

  it('TEETH: a healthy learner produces NO failure noise — the report is not always-on', () => {
    stubRuflo(binDir, '#!/bin/sh\nexit 0\n');
    const q = seedQueue(3);

    const r = flush(q);

    expect(r.stderr).not.toMatch(/FAILED/);
    expect(r.stdout).toMatch(/fed 3\/3/);
  });
});
