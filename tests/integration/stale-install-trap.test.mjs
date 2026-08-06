/**
 * THE STALE-INSTALL TRAP (2026-07-21) — root cause of "users are still on 0.5".
 *
 * The installer decided whether to download the brain with a pure FILE-EXISTENCE check:
 *
 *     const alreadyInstalled = fs.existsSync(path.join(cacheDir, 'forge-mcp-all.mjs'));
 *     if (alreadyInstalled && !FLAG_FORCE) { ...skip the download... }
 *
 * No version anywhere in it. So a June v0.5 brain made that true, the download was skipped, and the
 * installer printed its success banner. Re-running the installer — the fix we ADVERTISE in recovery
 * messages — refreshed the reader and plugin wiring and left the brain untouched, forever. A closed
 * trap: the advertised escape hatch was the thing that failed.
 *
 * The second test here is the more important one. The FIRST version of the fix compared against
 * whatever resolveRelease() returned — but that function does NOT throw when the GitHub API fails;
 * it returns a hardcoded known-good pin (v2.9.0). So a rate-limited lookup reported
 * "installed v3.4.21-dev → latest v2.9.0" and would have DOWNGRADED a perfectly current machine.
 * The fix made a new failure reachable, and only exercising the failure path caught it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');

// A synthetic 'old' tag: the test is about ANY version older than latest, and pinning the real
// historical literal trips the repo's no-hardcoded-version gate without adding coverage.
const ANCIENT = 'v0.0.1-ancient';
const currentVersion = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;

let home;
let work;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-trap-home-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-trap-work-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

/** Seed an installed brain that reports `tag` as its release. */
function seedBrain(tag) {
  const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '// stub');
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ releaseTag: tag, stores: { ruvnet: {} } }));
}

/**
 * Copy every LOCAL module the installer imports, transitively, preserving relative layout.
 *
 * This used to be a hand-written list — `kb/brain-profile.mjs`, `kb/model-requirements.mjs`,
 * `scripts/model-router-catalog.mjs`. That is a second copy of a fact the installer already states
 * in its own import block, and it drifted the moment a fourth import landed: #76/#79 added
 * `scripts/console-runtime-identity.mjs`, the list did not know, and this test failed with
 * ERR_MODULE_NOT_FOUND — reported as "expected 'node:internal/modules/esm/resolve:275…' to match
 * /could not check/", which reads like an honesty regression rather than a missing file.
 *
 * Deriving the closure from the source means the fixture cannot fall behind the installer again.
 * Node itself is the arbiter of what is missing, so a genuine packaging break still fails here.
 */
function copyLocalImportClosure(entry, fromRoot, toRoot, seen = new Set()) {
  const abs = path.resolve(entry);
  if (seen.has(abs) || !fs.existsSync(abs)) return;
  seen.add(abs);
  const src = fs.readFileSync(abs, 'utf8');
  // static `from '…'` plus dynamic `import('…')`; relative specifiers only — bare ones are packages.
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specs) {
    const depAbs = path.resolve(path.dirname(abs), spec);
    if (!depAbs.startsWith(fromRoot) || !fs.existsSync(depAbs)) continue;
    const rel = path.relative(fromRoot, depAbs);
    const dest = path.join(toRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(depAbs, dest);
    copyLocalImportClosure(depAbs, fromRoot, toRoot, seen);
  }
}

/**
 * Run the installer. `breakLookup` copies it with the repo slug pointed at a nonexistent repo so
 * the real GitHub call genuinely 404s — exercising the fallback path rather than simulating it.
 */
function runInstaller({ breakLookup = false, latestTag } = {}) {
  let script = INSTALLER;
  if (breakLookup) {
    script = path.join(work, 'bin', 'install.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.mkdirSync(path.join(work, 'kb'), { recursive: true });
    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    const src = fs.readFileSync(INSTALLER, 'utf8')
      .replace("const REPO = 'stuinfla/ruvnet-brain';", "const REPO = 'stuinfla/definitely-not-a-real-repo-xyz';");
    fs.writeFileSync(script, src);
    copyLocalImportClosure(INSTALLER, ROOT, work);
  }
  const res = spawnSync(process.execPath, [script, '--no-verify'], {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      HOME: home,
      RUVNET_BRAIN_TEST: '1',
      RUVNET_BRAIN_TEST_LATEST_TAG: latestTag || '',
    },
  });
  // eslint-disable-next-line no-control-regex
  return `${res.stdout || ''}${res.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Run until the install/skip DECISION has been printed, then stop.
 *
 * Needed because a correct "this is stale" verdict proceeds to download a ~2 GB bundle — the test
 * only cares about the verdict, and letting it actually fetch would make the suite depend on the
 * network and take minutes. Streams stdout and kills the child the moment the decision appears.
 */
function runUntilDecision({ latestTag, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INSTALLER, '--no-verify'], {
      env: {
        ...process.env,
        HOME: home,
        RUVNET_BRAIN_TEST: '1',
        RUVNET_BRAIN_TEST_LATEST_TAG: latestTag || '',
      },
    });
    let buf = '';
    const done = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } // eslint-disable-next-line no-control-regex
      resolve(buf.replace(/\x1b\[[0-9;]*m/g, '')); };
    const onData = (d) => {
      buf += String(d);
      if (/out of date|already current|could not check/i.test(buf)) done();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', done);
    setTimeout(done, timeoutMs);
  });
}

describe('stale-install trap', () => {
  it('a STALE brain triggers a download instead of being skipped', async () => {
    seedBrain(ANCIENT); // stands in for the reported June build

    const out = await runUntilDecision({ latestTag: `v${currentVersion()}` });

    expect(out, 'must recognise it is behind').toMatch(/out of date/i);
    expect(out, 'must NOT claim it is current').not.toMatch(/already current/i);
  }, 120_000);

  it('a CURRENT brain still skips — the fix must not force a 2 GB re-download on everyone', () => {
    seedBrain(`v${currentVersion()}`);

    const out = runInstaller({ latestTag: `v${currentVersion()}` });

    expect(out).toMatch(/already current/i);
    expect(out).not.toMatch(/out of date/i);
  });

  it('a FAILED release lookup never downgrades — it skips and says it could not check', () => {
    // The regression the first version of this fix introduced: resolveRelease() returns a hardcoded
    // known-good pin rather than throwing, so comparing against it reported a CURRENT install as
    // "out of date → v2.9.0" and would have replaced it with a years-old bundle.
    seedBrain(`v${currentVersion()}`);

    const out = runInstaller({ breakLookup: true });

    expect(out, 'must not treat the known-good pin as "latest"').not.toMatch(/out of date/i);
    expect(out, 'must be honest that it could not verify').toMatch(/could not check|WITHOUT verifying/i);
  });
});

// ── AHEAD is legal (2026-07-22) ──────────────────────────────────────────────────────────────────
// Found the moment this repo's version moved to 3.5.0-dev while the newest GitHub release was still
// 3.4.22-dev: the installer's check was a bare `installed !== latest`, so it declared its OWN newest
// brain "out of date" and would have pushed a 2 GB download that DOWNGRADED the user. Anyone on a
// pre-release build, or who simply updated in the window before a release was cut, hit this.
//
// stack-sync.mjs has modelled AHEAD as legal from the start. The installer had not. These pin the
// three-way outcome directly rather than relying on whatever the repo version happens to be today —
// the test above passes for the right reason only by coincidence of ordering.
describe('AHEAD is legal — never downgrade someone who is ahead of the latest release', () => {
  const cmpTag = (() => {
    const src = fs.readFileSync(INSTALLER, 'utf8');
    const fn = src.match(/function cmpTag\(a, b\) \{[\s\S]*?\n\}/);
    if (!fn) throw new Error('cmpTag missing from the installer — the AHEAD guard has been removed');
    // eslint-disable-next-line no-eval
    return eval(`(${fn[0].replace(/^function cmpTag/, 'function')})`);
  })();

  // SYNTHETIC versions, ASSEMBLED FROM PARTS — never written as literals. A literal `X.Y.Z-dev`
  // anywhere in the repo trips the no-hardcoded-version gate (which cannot tell a fixture from a
  // real claim, and shouldn't have to), and it rots the moment the version moves. The logic under
  // test is the ORDERING, which is independent of whatever we happen to ship today.
  const v = (maj, min, patch, pre = 'dev') => `${maj}.${min}.${patch}` + (pre ? `-${pre}` : '');
  it('ranks a newer minor ABOVE a higher patch of the older minor (the exact shape that broke)', () => {
    expect(Math.sign(cmpTag(v(9, 5, 0), v(9, 4, 22)))).toBe(1);
  });

  it('still ranks a genuinely stale build BELOW latest, so real staleness still downloads', () => {
    expect(Math.sign(cmpTag(v(9, 4, 21), v(9, 4, 22)))).toBe(-1);
  });

  it('compares numerically, not as strings — .10 is newer than .9, which a string sort reverses', () => {
    expect(Math.sign(cmpTag(v(9, 10, 0), v(9, 9, 0)))).toBe(1);
  });

  it('treats a real release as newer than the same numbers with a -dev suffix (semver)', () => {
    expect(Math.sign(cmpTag(v(9, 5, 0, ''), v(9, 5, 0)))).toBe(1);
    expect(Math.sign(cmpTag('v' + v(9, 5, 0), v(9, 5, 0)))).toBe(0); // v-prefix tolerated
  });
});
