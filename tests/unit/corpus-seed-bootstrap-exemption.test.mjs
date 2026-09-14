// tests/unit/corpus-seed-bootstrap-exemption.test.mjs
//
// Pins the seed-download gate in .github/workflows/corpus-seed.yml against a BOOTSTRAP DEADLOCK
// and against the fail-open loophole that the first fix for it introduced.
//
// THE DEADLOCK (measured 2026-09-14). ADR-086 step 15 made the detached retrieval-accuracy report a
// required seed asset unconditionally. The only producer of such a report is corpus-seed.yml itself,
// and the configured bootstrap seed predates the contract: `gh release view v4.2.1-dev` lists
// exactly two assets, ruvnet-brain.zip and ruvnet-brain.zip.sha256. So the gate could not be
// satisfied by any seed that existed, and the workflow died at the DOWNLOAD step — before it ever
// reached the per-gist fetch that needs RUVNET_GISTS_TOKEN. The token was not even the first
// blocker; this was.
//
// THE LOOPHOLE. The obvious fix — "require the report only when SEED_TAG = corpus-sha256-$SHA" — is
// fail-OPEN: a seed mis-tagged corpus-sha256-<wrong> does not match, so it lands in the exempt
// branch and skips the very gate it is supposed to be bound by. Caught by exercising the guard
// rather than reading it. A tag that CLAIMS the digest form must now match its own digest or the
// run dies; only a tag making no such claim is treated as the pre-contract bootstrap seed.
//
// The assertion EXECUTES the guard extracted from the workflow source. Pattern-matching the YAML
// would pass against a guard that reads correctly and branches wrongly — which is exactly the bug
// this file exists to catch.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'corpus-seed.yml');

// The configured bootstrap seed, read from the tracked pointer so this test tracks reality rather
// than a copy of it that can drift.
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corpus-seed.json'), 'utf8'));

/** Pull the guard out of the workflow and strip the YAML block-scalar indentation. */
function extractGuard() {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  const match = source.match(/^(\s*)case "\$SEED_TAG" in$[\s\S]*?^\1esac$/m);
  if (!match) throw new Error('the SEED_TAG guard is gone from corpus-seed.yml — the deadlock fix was removed');
  const indent = match[1];
  return match[0]
    .split('\n')
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

/** Run the guard with one seed identity and report the branch it chose. */
function runGuard({ tag, sha256 }) {
  const guard = extractGuard();
  const r = spawnSync('bash', ['-c', `${guard}\necho "RESULT=$SEED_IS_DIGEST_DERIVED"`], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, SEED_TAG: tag, SEED_SHA256: sha256 },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const chosen = (out.match(/RESULT=(\d*)/) || [])[1];
  return { status: r.status, requiresReport: chosen === '1', out };
}

describe('corpus-seed.yml seed-download accuracy-report gate', () => {
  it('exempts the pre-contract pinned bootstrap seed, which can never carry an accuracy report', () => {
    // The real configured seed. Before the fix this path demanded ruvnet-brain.zip.accuracy.json,
    // which v4.2.1-dev does not and cannot have, so the whole pipeline was unreachable.
    const r = runGuard({ tag: seed.tag, sha256: seed.sha256 });
    expect(r.status, `guard failed for the configured bootstrap seed:\n${r.out}`).toBe(0);
    expect(
      r.requiresReport,
      `the configured bootstrap seed ${seed.tag} must be exempt — it ships only .zip and .sha256, ` +
        'and the only producer of an accuracy report is the workflow this gate is blocking',
    ).toBe(false);
  });

  it('REQUIRES the report for a seed this pipeline published under the digest-derived tag', () => {
    // Fail-closed for every seed the pipeline will ever produce. The moment step 10 publishes a real
    // corpus-sha256-<sha> seed, the report is mandatory again.
    const r = runGuard({ tag: `corpus-sha256-${seed.sha256}`, sha256: seed.sha256 });
    expect(r.status, `guard failed for a well-formed digest-derived seed:\n${r.out}`).toBe(0);
    expect(
      r.requiresReport,
      'a pipeline-published seed carries a retrieval-accuracy report and MUST be gated on it, or C3 ' +
        'silently stops being enforced across seed generations',
    ).toBe(true);
  });

  it('HARD FAILS a seed whose tag claims the digest form but does not match its digest', () => {
    // The fail-open hole. Without this branch, corpus-sha256-<wrong> is "not the digest tag", so it
    // is treated as an exempt bootstrap seed and escapes the accuracy gate entirely.
    const r = runGuard({ tag: 'corpus-sha256-deadbeef', sha256: seed.sha256 });
    expect(
      r.status,
      'a mis-tagged seed must abort the run, never fall through to the bootstrap exemption',
    ).not.toBe(0);
    expect(r.out).toMatch(/claims the digest-derived form but does not match/);
  });

  it('keeps the exemption narrow: it is keyed on the tag, not on the report being absent', () => {
    // A guard that exempted "any seed with no accuracy.json asset" would be self-defeating — every
    // seed could opt out by omitting the file. Any other pinned tag is still exempt (it is
    // pre-contract by construction), but nothing about the ASSETS decides that.
    const r = runGuard({ tag: 'v9.9.9-dev', sha256: seed.sha256 });
    expect(r.status).toBe(0);
    expect(r.requiresReport).toBe(false);
    const source = fs.readFileSync(WORKFLOW, 'utf8');
    expect(
      source.includes('readAccuracyReport'),
      'the seed accuracy verification itself must still exist — the fix narrows WHEN it runs, it ' +
        'does not delete it',
    ).toBe(true);
  });
});

// THE SCHEMA CONFLATION one step EARLIER (measured 2026-09-14, raised by Dual, verified against both
// files). The "Bind this round to one exact seed identity" step validated data/corpus-seed.json with
// s.schemaVersion!==3, while scripts/corpus-next-seed.mjs validateBootstrapSeed() requires 1. Schema 3
// is the seed RECEIPT's schema, not the DESCRIPTOR's. The same file could never satisfy both, so every
// dispatch died on that line before the download — which also made the accuracy-report deadlock above
// unreachable. These tests EXECUTE the guard's own node snippet, and require it to agree with the
// descriptor's canonical validator, so the two can never drift apart silently again.
describe('corpus-seed.yml seed-descriptor bind guard', () => {
  const extractDescriptorGuard = () => {
    const source = fs.readFileSync(WORKFLOW, 'utf8');
    const match = source.match(/node -e "(const s=require\('\.\/data\/corpus-seed\.json'\);[^"]*)"/);
    if (!match) throw new Error('the seed-descriptor bind guard is gone from corpus-seed.yml');
    return match[1];
  };
  const runSnippet = (snippet, cwd) => spawnSync(process.execPath, ['-e', snippet], { cwd, encoding: 'utf8', timeout: 20000 });

  it('accepts the committed descriptor — the one every dispatch actually binds', () => {
    const r = runSnippet(extractDescriptorGuard(), ROOT);
    expect(r.status, `the bind guard rejects data/corpus-seed.json, so every dispatch dies before download:\n${r.stderr}`).toBe(0);
  });

  it('agrees with validateBootstrapSeed(), the descriptor\'s canonical validator', async () => {
    const { validateBootstrapSeed } = await import('../../scripts/corpus-next-seed.mjs');
    expect(validateBootstrapSeed(seed), 'the canonical validator must accept the committed descriptor').toEqual([]);
    expect(runSnippet(extractDescriptorGuard(), ROOT).status).toBe(0);
  });

  it('still refuses a descriptor at the wrong schema, so the guard did not become a no-op', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rvb-descriptor-'));
    try {
      fs.mkdirSync(path.join(dir, 'data'));
      fs.writeFileSync(path.join(dir, 'data', 'corpus-seed.json'), JSON.stringify({ ...seed, schemaVersion: 3 }));
      expect(runSnippet(extractDescriptorGuard(), dir).status, 'a schema-3 DESCRIPTOR is not a valid descriptor').not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FAILS against the old conflated guard — proves this file catches the regression', () => {
    const regressed = extractDescriptorGuard().replace('s.schemaVersion!==1', 's.schemaVersion!==3');
    expect(regressed, 'mutation did not apply — the guard text changed shape').not.toBe(extractDescriptorGuard());
    expect(runSnippet(regressed, ROOT).status, 'the old !==3 guard must reject the committed descriptor').not.toBe(0);
  });
});
