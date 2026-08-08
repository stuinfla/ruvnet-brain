import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * ISSUE #126 — a spine that is already AHEAD of the requested version has nothing to do, and that
 * is success, not failure.
 *
 * Symptom: the Console header offered "⟳ update available — click to update", the click copied
 * `npx ruvnet-brain --update`, the command exited 0, and the header never moved. Forever. A remedy
 * that runs clean and changes nothing is worse than no remedy — it burns the single action the user
 * was given, and there is nothing in the output to suggest trying anything else.
 *
 * Cause: after a release the plugin is bumped to the next `-dev` generation, so the ACTIVE spine is
 * routinely ahead of the published version the updater asks for. No staged payload matched that
 * older request, update-apply returned 1, host synchronization reported "incomplete", and the
 * Console runtime refresh — which happens inside that same sync — was rolled back.
 *
 * WHAT THIS TEST ALSO GUARDS, and why it exists as its own file: my first fix for #126 loosened the
 * PAYLOAD SELECTOR to "newest >= expected", which re-broke issue #64 —
 * tests/qe/release/issue-64-host-convergence.test.mjs requires that the updater never applies "a
 * different newer payload in another host cache", because the caches are per-host and grabbing a
 * newer payload from .codex to satisfy a .claude request installs something nobody asked for. That
 * requirement is correct and must stay. The fix therefore lives one layer up: selection stays EXACT,
 * and being already-ahead short-circuits before selection matters.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ENGINE = path.join(ROOT, 'plugin', 'scripts', 'update-apply.mjs');
const temps = [];
afterAll(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A home whose ACTIVE spine is at `activeVersion`, with no staged payload of any kind. */
const homeWithActive = (activeVersion) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-ahead-'));
  temps.push(home);
  fs.mkdirSync(path.join(home, '.cache', 'ruvnet-brain'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cache', 'ruvnet-brain', 'active.json'), JSON.stringify({ version: activeVersion }));
  return home;
};

const run = (home, expected) => spawnSync(process.execPath, [ENGINE, '--auto', '--expected-version', expected], {
  env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') },
  encoding: 'utf8',
  timeout: 60_000,
});

describe('issue #126 — already-ahead is converged, not a failed sync', () => {
  it('exits 0 and says so when the active spine is ahead of the requested version', () => {
    // SYNTHETIC versions, per the convention repo-count.test.mjs records: a test that spells the
    // REAL current version trips sync-version's stray-literal scanner the moment the product reaches
    // it, and then fails for a reason unrelated to what it tests. (It did exactly that on first
    // write.) The shape — a -dev generation ahead of a published one — is what matters.
    const r = run(homeWithActive('9.9.9-dev'), '9.9.8'); // sync-version-ignore: the -dev suffix IS the fixture — this defect only exists for prerelease strings
    expect(r.status, 'nothing to apply because you are past it is SUCCESS').toBe(0);
    expect(`${r.stdout}`, 'and it must say which version it is on, not just go quiet')
      .toMatch(/already on 9\.9\.9-dev, at or above requested 9\.9\.8/);
  }, 70_000);

  it('TEETH: a spine genuinely BEHIND still fails closed', () => {
    // Without this, "return 0 when no payload matched" would satisfy the headline and silently
    // retire the guard that makes an incomplete update visible at all.
    const r = run(homeWithActive('9.9.1-dev'), '9.9.8'); // sync-version-ignore: same reason — a behind -dev spine is the case under test
    expect(r.status, 'behind, with nothing staged, is a real failure').toBe(1);
    expect(`${r.stderr}`).toMatch(/no staged host payload exactly matches/);
  }, 70_000);

  it('TEETH: an equal version is also converged', () => {
    const r = run(homeWithActive('9.9.8'), '9.9.8');
    expect(r.status).toBe(0);
  }, 70_000);

  it('the PAYLOAD SELECTOR stays exact — issue #64 must not regress', () => {
    // Asserted against the source, because the behavioural proof lives in
    // tests/qe/release/issue-64-host-convergence.test.mjs and this file must fail loudly if someone
    // "fixes" #126 again by loosening selection instead of short-circuiting convergence.
    const source = fs.readFileSync(ENGINE, 'utf8');
    expect(source, 'staged-payload selection must remain an exact version match (#64)')
      .toContain('payloadVersion === expectedVersion');
  });
});
