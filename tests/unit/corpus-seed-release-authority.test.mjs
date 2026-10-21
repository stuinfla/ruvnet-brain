import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCorpusReceipt } from '../../scripts/corpus-candidate.mjs';
import { verifyCoverageSidecar } from '../../scripts/corpus-coverage-sidecar.mjs';
import {
  fixtureReleaseRoot, ineligibleRepositoryRow, retireInRecallReport, sealedCorpusBundle, sha256, writeAccuracyReport, writeCoverageFor,
} from '../helpers/corpus-seed-fixture.mjs';
import { loadFixture } from '../../scripts/oracle/repo-recall.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirs = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

// Every case starts from a GENUINE sealed bundle and the receipt actually derived from its bytes,
// then mutates exactly one thing. Until 2026-09-13 this fixture was a text file named
// ruvnet-brain.zip plus a hand-written receipt whose outer sha256 happened to match; that stopped
// being possible when runProtectedCorpusSeed took over the deep verifyCorpusReceipt re-derivation
// from the deleted scripts/corpus-seed-publish.mjs (ADR-085) — the publisher now re-extracts the
// archive and rebuilds the candidate from it, so only a real bundle can reach `gh`.
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-authority-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'gh-calls.jsonl');
  const gh = path.join(bin, 'gh-fixture.mjs');
  fs.writeFileSync(gh, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'release' && args[1] === 'view') {
  if (process.env.GH_VIEW_MODE === 'exists') process.exit(0);
  console.error(process.env.GH_VIEW_MODE === 'ambiguous' ? 'network timeout' : 'release not found');
  process.exit(1);
}
process.exit(0);
`);
  fs.chmodSync(gh, 0o755);

  // Step 15: the publication gate hashes the retrieval-accuracy oracle committed in release.mjs's
  // OWN root, so the publisher is spawned from a fixture root that symlinks the real scripts/kb/
  // plugin/keys/.git and owns only `data/` — a committed oracle without touching the checkout.
  const releaseRoot = fixtureReleaseRoot(path.join(dir, 'root'));
  const { bundle } = await sealedCorpusBundle(dir, { accuracy: null }); // <dir>/ruvnet-brain.zip
  writeAccuracyReport(bundle, { oracleSha256: releaseRoot.oracleSha256, generatorSha256: releaseRoot.generatorSha256 });
  const receiptFile = path.join(dir, 'corpus-receipt.json');
  const receipt = await createCorpusReceipt({
    bundleFile: bundle,
    receiptFile,
    builderSourceSha: HEAD,
    createdAt: '2026-08-21T12:34:56.000Z',
  });
  const digest = receipt.archive.sha256;
  const tag = `corpus-sha256-${digest}`;
  const coverageFile = path.join(dir, 'source-coverage.json');
  await writeCoverageFor(receipt, coverageFile);
  const args = [
    '--corpus-seed', '--corpus-tag', tag,
    '--corpus-bundle', bundle,
    '--corpus-receipt', receiptFile,
    '--corpus-coverage', coverageFile,
    '--target', HEAD,
    '--repo', 'stuinfla/ruvnet-brain',
  ];
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GH_CALL_LOG: log,
    GH_VIEW_MODE: 'missing',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: 'protected-release',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_SHA: HEAD,
    GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain',
    GH_TOKEN: 'fixture-token',
    RUVNET_GH_COMMAND: process.execPath,
    RUVNET_GH_SCRIPT: path.join(bin, 'gh-fixture.mjs'),
  };
  return { dir, bundle, digest, receipt, receiptFile, tag, args, env, log, releaseRoot, coverageFile };
}

function run(f, { args = f.args, env = f.env } = {}) {
  return spawnSync(process.execPath, [...f.releaseRoot.nodeArgs, f.releaseRoot.release, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function replaceArg(args, name, value) {
  const copy = [...args];
  copy[copy.indexOf(name) + 1] = value;
  return copy;
}

function writeReceipt(f) {
  fs.writeFileSync(f.receiptFile, JSON.stringify(f.receipt));
}

describe('protected corpus-seed release authority', () => {
  it.each([
    ['outside GitHub Actions', (f) => { delete f.env.GITHUB_ACTIONS; }],
    ['wrong workflow', (f) => { f.env.GITHUB_WORKFLOW = 'ci'; }],
    ['wrong repository', (f) => { f.env.GITHUB_REPOSITORY = 'attacker/fork'; }],
    ['non-dispatch event', (f) => { f.env.GITHUB_EVENT_NAME = 'push'; }],
    ['unprotected ref', (f) => { f.env.GITHUB_REF_PROTECTED = 'false'; }],
  ])('refuses %s before invoking gh', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/protected-release GitHub workflow/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each([
    ['target differs from HEAD', (f) => { f.args = replaceArg(f.args, '--target', 'f'.repeat(40)); }],
    ['target is not a 40-hex SHA (format checked first)', (f) => { f.args = replaceArg(f.args, '--target', '--upload-pack=touch'); }],
    ['receipt source differs from target', (f) => { f.receipt.builderSourceSha = 'f'.repeat(40); writeReceipt(f); }],
    ['GITHUB_SHA is not a commit at all', (f) => { f.env.GITHUB_SHA = '--upload-pack=touch'; }],
  ])('refuses when %s', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/target must exactly equal HEAD and the corpus receipt builderSourceSha \(and GITHUB_SHA must be a commit\)/);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  // DECOUPLED FROM main HEAD (2026-09-29 nightly redesign). The corpus is built at the approved
  // runtime's source, which is on main's history but usually behind main HEAD. The rule is ANCESTRY
  // of this run's GITHUB_SHA -- never equality with it (which stood the nightly down whenever main was
  // ahead of the newest verified release). What the equality rule protected against (promoting an
  // OLDER runtime over a newer live code release) is enforced for customer promotion by the
  // publish-time re-resolve of --approved-tag (tests/unit/corpus-customer-promotion.test.mjs).
  it.each([
    ['an unknown commit', () => 'f'.repeat(40)],
    ['an OLDER commit (the target is off, or ahead of, protected main\'s history)',
      () => execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: ROOT, encoding: 'utf8' }).trim()],
  ])('refuses when GITHUB_SHA is %s, before invoking gh', async (_name, sha) => {
    const f = await fixture();
    f.env.GITHUB_SHA = sha();
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is not an ancestor of this run's GITHUB_SHA/);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it('ACCEPTS a target that is an ancestor of a newer main GITHUB_SHA (the approved runtime behind main)', async () => {
    const f = await fixture();
    // A real commit whose parent is HEAD, created as a dangling object (no ref, no working-tree change).
    f.env.GITHUB_SHA = execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost',
      'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'fixture: a newer main commit'], { cwd: ROOT, encoding: 'utf8' }).trim();
    expect(f.env.GITHUB_SHA).not.toBe(HEAD);
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.map((call) => `${call[0]} ${call[1]}`)).toEqual(['release view', 'release create']);
    expect(calls[1][calls[1].indexOf('--target') + 1]).toBe(HEAD);
  });

  it('requires a full lowercase digest tag bound to the receipt and bundle bytes', async () => {
    for (const tag of ['corpus-sha256-short', `v${'a'.repeat(64)}`, `corpus-sha256-${'A'.repeat(64)}`]) {
      const f = await fixture();
      const result = run(f, { args: replaceArg(f.args, '--corpus-tag', tag) });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/corpus tag/i);
    }
    const f = await fixture();
    fs.appendFileSync(f.bundle, 'tampered');
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/archive.*receipt/i);
  });

  it.each([
    ['relative bundle', (f) => { f.args = replaceArg(f.args, '--corpus-bundle', path.basename(f.bundle)); }],
    ['relative receipt', (f) => { f.args = replaceArg(f.args, '--corpus-receipt', path.basename(f.receiptFile)); }],
    ['bundle directory', (f) => { f.args = replaceArg(f.args, '--corpus-bundle', f.dir); }],
    ['receipt directory', (f) => { f.args = replaceArg(f.args, '--corpus-receipt', f.dir); }],
  ])('refuses %s', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/absolute regular file/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each([
    ['receipt kind', (f) => { f.receipt.kind = 'forged'; }],
    ['schema downgrade', (f) => { f.receipt.schemaVersion = 1; }],
    ['failure arrays', (f) => { f.receipt.missingSidecars = ['alpha.meta.json']; }],
    ['store count', (f) => { f.receipt.storeCount = 2; }],
    ['generation ledger binding', (f) => { f.receipt.generationLedger.sha256 = 'nope'; }],
    ['archive name', (f) => { f.receipt.archive.file = 'other.zip'; }],
    ['generator binding', (f) => { f.receipt.generator.corpusCandidateSha256 = 'e'.repeat(64); }],
    ['store provenance', (f) => { f.receipt.stores[0].sourceCommit = ''; }],
    ['store kind', (f) => { f.receipt.stores[0].kind = 'not-a-kind'; }],
    ['private exclusion list', (f) => { f.receipt.excludedPrivateStores = 'secret'; }],
  ])('refuses invalid %s binding', async (_name, mutate) => {
    const f = await fixture();
    mutate(f);
    writeReceipt(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/corpus receipt/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it('refuses a receipt whose per-store digests were forged after sealing — the outer archive digest alone is not proof', async () => {
    // The check scripts/corpus-seed-publish.mjs used to run before delegating to release.mjs, moved
    // into runProtectedCorpusSeed on 2026-09-13 (ADR-085). The bundle is untouched, so its sha256
    // and byte length still match both the receipt and the tag, every field is well-formed, and
    // the generator/target bindings hold — only one store file's DECLARED digest is forged. No
    // shape or identity check above can see that; only re-deriving the candidate from the
    // archive's own bytes can, and it must happen before gh is ever invoked.
    const f = await fixture();
    f.receipt.stores[0].files[0].sha256 = 'f'.repeat(64);
    writeReceipt(f);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not verify against the sealed archive[\s\S]*does not match the exact corpus archive contents/i);
    expect(fs.existsSync(f.log)).toBe(false);
  });

  it.each([
    // An existing tag is an answer: asked once. A "network timeout" is weather: the absence proof is retried,
    // bounded (3 tries, scripts/transient-gh.mjs), and STILL fails closed when the answer never comes.
    ['existing tag', 'exists', /already exists.*refusing to overwrite/i, 1],
    ['ambiguous lookup', 'ambiguous', /cannot prove.*absent/i, 3],
  ])('fails closed for %s', async (_name, mode, message, views) => {
    const f = await fixture();
    f.env.GH_VIEW_MODE = mode;
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toHaveLength(views);
    for (const call of calls) expect(call).toEqual(['release', 'view', f.tag, '--json', 'tagName', '--repo', 'stuinfla/ruvnet-brain']);
  });

  it('creates one non-latest non-draft prerelease containing exactly the bound bundle and receipt', async () => {
    const f = await fixture();
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['release', 'view', f.tag, '--json', 'tagName', '--repo', 'stuinfla/ruvnet-brain']);
    expect(calls[1]).toEqual([
      'release', 'create', f.tag,
      '--prerelease', '--latest=false',
      '--target', HEAD,
      '--repo', 'stuinfla/ruvnet-brain',
      '--title', `Immutable corpus seed ${f.digest.slice(0, 16)}`,
      '--notes', expect.stringContaining(`Archive SHA-256: ${f.digest}`),
      f.bundle, f.receiptFile, `${f.bundle}.accuracy.json`, `${f.bundle}.recall.json`,
      // ADR-0091 D6.2: the generation's sealed coverage and its sidecar ride with every corpus release.
      expect.stringMatching(/[\\/]CORPUS-COVERAGE\.json$/), expect.stringMatching(/[\\/]coverage-receipt\.json$/),
    ]);
    expect(calls[1]).not.toContain('--draft');
    expect(calls[1]).not.toContain('--clobber');
  });
});

// ADR-0091 D6.2: the corpus publisher is the one place that can SEE a generation's coverage, so it
// binds it to the archive and publishes it beside the archive. A bounded degraded generation is staged
// like any other (2026-10-17: the D10 constant gate is gone; the customer canary is the acceptance proof).
describe('corpus generation coverage sidecar (ADR-0091 D6.2)', () => {
  const ghCalls = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

  it('publishes CORPUS-COVERAGE.json (exact sealed bytes) and a coverage-receipt.json a later reader can verify', async () => {
    const f = await fixture();
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const create = ghCalls(f).find((args) => args[1] === 'create');
    const coverageAsset = create.find((arg) => String(arg).endsWith('/CORPUS-COVERAGE.json'));
    const receiptAsset = create.find((arg) => String(arg).endsWith('/coverage-receipt.json'));
    expect(fs.readFileSync(coverageAsset)).toEqual(fs.readFileSync(f.coverageFile));
    const sidecar = JSON.parse(fs.readFileSync(receiptAsset, 'utf8'));
    expect(sidecar).toMatchObject({ schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage-receipt', generationTag: f.tag,
      archiveSha256: f.digest, coverageFile: 'CORPUS-COVERAGE.json', degraded: { carried: [], missing: [] } });
    // The shape D10's publisher-side check and D6's resolver read.
    const verified = verifyCoverageSidecar({ sidecar, coverageBytes: fs.readFileSync(coverageAsset), generationTag: f.tag,
      archiveSha256: f.digest, archiveBytes: f.receipt.archive.bytes });
    expect(verified.degraded).toEqual({ carried: [], missing: [] });
  });

  it('STAGES a degraded generation (a carried store), says so, and its published sidecar names the carried store', async () => {
    const f = await fixture();
    await writeCoverageFor(f.receipt, f.coverageFile, { carried: true });
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/degraded generation staged: 1 carried \(alpha\), 0 missing \(none\)/);
    const create = ghCalls(f).find((args) => args[1] === 'create');
    expect(create).toBeDefined();
    const receiptAsset = create.find((arg) => String(arg).endsWith('/coverage-receipt.json'));
    expect(JSON.parse(fs.readFileSync(receiptAsset, 'utf8')).degraded).toMatchObject({ carried: ['alpha'], missing: [] });
  });

  it('REFUSES coverage that was measured against other bytes than this archive, before any network call', async () => {
    const f = await fixture();
    await writeCoverageFor(f.receipt, f.coverageFile, { rvfSha256: '2'.repeat(64) });
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/sealed coverage does not bind this archive .*different alpha RVF bytes/);
    expect(ghCalls(f)).toEqual([]);
  });

  it('REFUSES to publish a generation without its coverage', async () => {
    const f = await fixture();
    const at = f.args.indexOf('--corpus-coverage');
    const result = run(f, { args: [...f.args.slice(0, at), ...f.args.slice(at + 2)] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/coverage must be an absolute regular file/);
    expect(ghCalls(f)).toEqual([]);
  });
});

// ADR-0091 D7.3: readers verify a claimed retirement, never trust it. The fixture's coverage is a complete
// one-row enumeration (alpha), so every frozen fixture repository other than alpha has NO row -- a
// genuine retirement -- unless a row is added for it, which makes the same claim false.
describe('a claimed repo-recall retirement is recomputed from coverage by the publisher (ADR-0091 D7.3)', () => {
  const ghCalls = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const RETIRED = loadFixture().questions[0].store;
  const reseal = async (f, coverageFile) => {
    f.receipt = await createCorpusReceipt({ bundleFile: f.bundle, receiptFile: f.receiptFile, builderSourceSha: HEAD,
      createdAt: '2026-08-21T12:34:56.000Z', coverageFile });
  };

  it('GREEN: a retirement the generation\'s own coverage proves seals (corpus-candidate) and publishes (release.mjs)', async () => {
    const f = await fixture();
    retireInRecallReport(`${f.bundle}.recall.json`, [RETIRED], f.coverageFile);
    await reseal(f, f.coverageFile);
    expect(f.receipt.recallSummary.questions).toBe(loadFixture().questions.length - 1);
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(ghCalls(f).some((args) => args[1] === 'create')).toBe(true);
  });

  it('RED: corpus-candidate rejects a claimed retirement when it is given no coverage to verify it against', async () => {
    const f = await fixture();
    retireInRecallReport(`${f.bundle}.recall.json`, [RETIRED], f.coverageFile);
    await expect(reseal(f, null)).rejects.toThrow(/claims retired question\(s\) but no coverage was supplied/);
  });

  it('RED: a FALSE retirement (the repository has a coverage row) is rejected by corpus-candidate AND by release.mjs, before any network call', async () => {
    const f = await fixture();
    // The repository exists in the observation (an ineligible row), so it is not retired -- claiming it is
    // exactly how a report would hide a question it could not answer.
    await writeCoverageFor(f.receipt, f.coverageFile, { extraRows: [ineligibleRepositoryRow(RETIRED)] });
    const recallFile = `${f.bundle}.recall.json`;
    retireInRecallReport(recallFile, [RETIRED], f.coverageFile);
    const lie = new RegExp(`claims \\[${RETIRED.toLowerCase()}\\] retired, but the coverage it names does not retire them`);
    await expect(reseal(f, f.coverageFile)).rejects.toThrow(lie);
    // release.mjs reads the report itself, not only through corpus-candidate: bind the forged report into
    // the receipt so the publisher's OWN reader is the one that has to catch it.
    f.receipt.recallReport = { file: path.basename(recallFile), sha256: sha256(recallFile), bytes: fs.statSync(recallFile).size };
    writeReceipt(f);
    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/retrieval does not qualify this corpus for publication/);
    expect(result.stderr).toMatch(lie);
    expect(ghCalls(f)).toEqual([]);
  });
});
