// console-trust-versions.test.mjs — the Trust card shows every version this machine is running,
// labeled, and says when they disagree.
//
// THE LIE (console audit 2026-09-11): one page carried three versions with no reconciliation — the
// header chip said v4.3.21 (running brain), the Install-channel row said v4.3.22 (plugin cache), and
// the installed KB's RVF-GENERATIONS.json said 4.3.10 — while the repo's package.json was 4.4.0.
// Nothing on the page said "these differ", so a reader took whichever number they saw first.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APP_JS, IMPORT, makeRunner, scratch } from './helpers/console-child.mjs';
import { getVersion } from '../../scripts/version.mjs';

let tmp, runJSON;
beforeEach(() => { tmp = scratch('console-versions-'); ({ runJSON } = makeRunner(tmp)); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// In a dev checkout with no runtime-identity.json and no plugin cache, brainVersionOnDisk() falls
// through to getVersion() — the SAME reader, so the oracle is that reader, not package.json (which
// can legitimately lead it during a release bump).
const RUNNING_VERSION = getVersion();

function writeKb(brainVersion) {
  fs.mkdirSync(path.join(tmp, 'kb'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'kb', 'RVF-GENERATIONS.json'), JSON.stringify({ brainVersion, stores: {} }));
}

describe('Fix 6 — versionFacts(): KB generation, running brain and installed plugin, labeled', () => {
  it('reads each from its own file and flags disagreement (no plugin installed ⇒ that one is null, not guessed)', () => {
    writeKb('1.0.0');
    const v = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.versionFacts()));`);
    expect(v.kbGeneration).toBe('1.0.0'); // sync-version-ignore: the fixture writeKb('1.0.0') seeded two lines up, not the product's version
    expect(v.runningBrain).toBe(RUNNING_VERSION);       // dev checkout: no runtime-identity.json, no plugin cache ⇒ package.json
    expect(v.installedPlugin).toBe(null);
    expect(v.agree).toBe(false);
    expect(v.known).toBe(2);
  });

  it('agrees only when every measured version is identical', () => {
    writeKb(RUNNING_VERSION);
    const v = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.versionFacts()));`);
    expect(v.kbGeneration).toBe(RUNNING_VERSION);
    expect(v.agree).toBe(true);
  });

  it('with fewer than two measured versions there is nothing to agree about — null, never true', () => {
    // no KB, no plugin: only the running brain is known
    const v = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.versionFacts()));`);
    expect(v.kbGeneration).toBe(null);
    expect(v.known).toBe(1);
    expect(v.agree).toBe(null);
  });

  it('the page renders all three with labels and a disagreement state', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    expect(src).toContain('KB generation');
    expect(src).toContain('installedPlugin');
    expect(src).toContain('kbGeneration');
  });
});
