import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCorpusReceipt } from '../../scripts/corpus-candidate.mjs';
import {
  evaluateCorpusPromotion, evaluateCanaryVerdict, parseCorpusGeneration, CORPUS_GENERATION_FIELD, CANARY_VERDICT_KIND, REQUIRED_CANARY_CHECKS,
} from '../../scripts/corpus-promotion.mjs';
import { fixtureReleaseRoot, sealedCorpusBundle, writeAccuracyReport, writeCoverageFor } from '../helpers/corpus-seed-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SIGN = path.join(ROOT, 'scripts/sign-bundle.mjs');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const REPO = 'stuinfla/ruvnet-brain';
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

// ADR-086 Step 15: the detached retrieval-accuracy report is now a published corpus asset, because a
// downloaded archive that cannot be reverified against the identity it was measured under is not a
// deliverable artifact. The 2026-09-15 amendment adds the repo-recall report beside it — that one is
// the measurement that actually qualified the release, so it ships for the same reason.
const ASSET_NAMES = ['ruvnet-brain.zip', 'ruvnet-brain.zip.sig', 'ruvnet-brain.zip.sha256', 'corpus-receipt.json',
  'ruvnet-brain.zip.accuracy.json', 'ruvnet-brain.zip.recall.json', 'CORPUS-COVERAGE.json', 'coverage-receipt.json'];
const uploaded = (names = ASSET_NAMES) => names.map((name) => ({ name, size: 10, state: 'uploaded' }));

// The real gh surface the promote path touches, driven by a JSON config so each case mutates exactly
// one fact. Every invocation is logged, so "refused BEFORE the network" is a checkable claim.
//
// STRICT (2026-09-29). The previous fake answered any --json field it was asked for, so it happily
// returned `isLatest` from `gh release view` -- a field the real CLI rejects -- and the publisher's
// final confirmation was never exercised against reality. This fake refuses every field that is not
// in the field lists captured from the real CLI (tests/fixtures/gh-json-fields.json), exactly as
// gh 2.101.0 does, and refuses any invocation it does not model.
const GH_FIXTURE = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n');
const cfg = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE_CONFIG, 'utf8'));
const known = JSON.parse(fs.readFileSync(process.env.GH_JSON_FIELDS, 'utf8'));
const jsonAt = args.indexOf('--json');
const fields = jsonAt >= 0 ? args[jsonAt + 1] : null;
if (args[0] === 'release' && fields !== null) {
  const allowed = known['release ' + args[1]] || [];
  const unknown = fields.split(',').filter((field) => !allowed.includes(field));
  if (unknown.length) { console.error('Unknown JSON field: "' + unknown[0] + '"'); process.exit(1); }
}
if (args[0] === 'release' && args[1] === 'list') { process.stdout.write(JSON.stringify(cfg.codeReleases)); process.exit(0); }
if (args[0] === 'release' && args[1] === 'view') {
  const tagged = args[2] && !args[2].startsWith('--');
  if (!tagged) {
    if (cfg.latestError) { console.error(cfg.latestError); process.exit(1); }
    if (!cfg.latest) { console.error('release not found'); process.exit(1); }
    process.stdout.write(JSON.stringify(cfg.latest)); process.exit(0);
  }
  if (fields === 'tagName') {
    if (cfg.tagExists) process.exit(0);
    console.error('release not found'); process.exit(1);
  }
  if (fields === 'isDraft,assets') { process.stdout.write(JSON.stringify(cfg.draftView)); process.exit(0); }
  if (fields === 'tagName,isDraft,isPrerelease,assets,body') { process.stdout.write(JSON.stringify(cfg.stagedView)); process.exit(0); }
  process.stdout.write(JSON.stringify(cfg.finalView)); process.exit(0);
}
if (args[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/commits\\/v[0-9.]+$/.test(args[1] || '')) {
  process.stdout.write(JSON.stringify({ sha: cfg.approvedSha })); process.exit(0);
}
if (args[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/releases\\/latest$/.test(args[1] || '')) {
  process.stdout.write(JSON.stringify(cfg.latestAfter)); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'create') { if (cfg.createFails) { console.error('create blew up'); process.exit(1); } process.exit(0); }
if (args[0] === 'release' && args[1] === 'edit') { if (cfg.editFails) { console.error('edit blew up'); process.exit(1); } process.exit(0); }
console.error('unmodelled gh invocation: ' + args.join(' ')); process.exit(2);
`;

// The approved runtime this corpus was built at: the fixture archive's own ARCHIVE-MANIFEST releaseTag.
const APPROVED_TAG = 'v9.9.9'; // sync-version-ignore: the non-product fixture runtime in tests/helpers/corpus-seed-fixture.mjs
const codeRelease = (tagName) => ({ tagName, isDraft: false, isPrerelease: false });

async function fixture({ sign = true, signWithAttackerKey = false, config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-promote-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh-fixture.mjs');
  fs.writeFileSync(gh, GH_FIXTURE);
  fs.chmodSync(gh, 0o755);
  const log = path.join(dir, 'gh-calls.jsonl');

  // Ephemeral trust root — scripts/verify-bundle.mjs exposes RUVNET_SIGNING_PUB for exactly this,
  // because signing needs the private key and CI must never hold the real one.
  const trusted = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const pubPath = path.join(dir, 'trusted.pub.pem');
  fs.writeFileSync(pubPath, trusted.publicKey.export({ type: 'spki', format: 'pem' }));

  // Step 15: release.mjs's publication gate hashes the retrieval-accuracy oracle committed in ITS
  // OWN root, so the publisher is spawned from a fixture root that symlinks the real scripts/kb/
  // plugin/keys/.git and owns only `data/`. That supplies a committed oracle without ever writing
  // into the tracked checkout.
  const releaseRoot = fixtureReleaseRoot(path.join(dir, 'root'));
  const { bundle } = await sealedCorpusBundle(dir, { accuracy: null });
  writeAccuracyReport(bundle, { oracleSha256: releaseRoot.oracleSha256, generatorSha256: releaseRoot.generatorSha256 });
  const receiptFile = path.join(dir, 'corpus-receipt.json');
  const receipt = await createCorpusReceipt({
    bundleFile: bundle, receiptFile, builderSourceSha: HEAD, createdAt: '2026-09-13T12:00:00.000Z',
  });
  if (sign) {
    // The REAL producer, not a hand-rolled signature.
    execFileSync(process.execPath, [SIGN, '--bundle', bundle], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        RUVNET_SIGNING_KEY: (signWithAttackerKey ? attacker : trusted).privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
    });
  }

  const digest = receipt.archive.sha256;
  const tag = `corpus-sha256-${digest}`;
  const coverageFile = path.join(dir, 'source-coverage.json');
  await writeCoverageFor(receipt, coverageFile);
  const configFile = path.join(dir, 'gh-config.json');
  const resolved = {
    tagExists: false,
    latest: null,
    codeReleases: [codeRelease(APPROVED_TAG), codeRelease('v9.9.8'), { tagName: 'v9.10.0-rc', isDraft: false, isPrerelease: true }], // sync-version-ignore: fixture code releases
    approvedSha: HEAD,
    draftView: { isDraft: true, assets: uploaded() },
    // STAGED, never latest: the customer canary decides whether it is ever promoted.
    finalView: { tagName: tag, isDraft: false, isPrerelease: true, assets: uploaded() },
    latestAfter: { tag_name: `corpus-sha256-${'e'.repeat(64)}` },
    ...config,
  };
  fs.writeFileSync(configFile, JSON.stringify(resolved));

  return {
    dir, bundle, receiptFile, receipt, digest, tag, configFile, coverageFile, log, resolved, releaseRoot,
    write: (patch) => fs.writeFileSync(configFile, JSON.stringify({ ...resolved, ...patch })),
    args: [
      '--corpus-seed', '--stage-candidate', '--corpus-tag', tag,
      '--corpus-bundle', bundle, '--corpus-receipt', receiptFile, '--corpus-coverage', coverageFile,
      '--target', HEAD, '--repo', REPO, '--approved-tag', APPROVED_TAG,
    ],
    env: {
      ...process.env,
      // NOT a PATH stub. `gh` really lives at /opt/homebrew/bin on this machine, and
      // tests/integration/nightly-gists-error-paths.test.mjs records what that costs: a PATH-prepend
      // stub "would still find the real gh and silently test nothing". Interception here uses the
      // explicit seam release.mjs provides (RUVNET_GH_COMMAND / RUVNET_GH_SCRIPT), and PATH stays
      // untouched because release.mjs genuinely needs it to find `git`.
      PATH: process.env.PATH,
      GH_CALL_LOG: log,
      GH_FIXTURE_CONFIG: configFile,
      GH_JSON_FIELDS: path.join(ROOT, 'tests/fixtures/gh-json-fields.json'),
      RUVNET_SIGNING_PUB: pubPath,
      GITHUB_ACTIONS: 'true',
      GITHUB_WORKFLOW: 'protected-release',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_PROTECTED: 'true',
      GITHUB_SHA: HEAD,
      GITHUB_REPOSITORY: REPO,
      GH_TOKEN: 'fixture-token',
      RUVNET_GH_COMMAND: process.execPath,
      RUVNET_GH_SCRIPT: gh,
    },
  };
}

const run = (f, args = f.args) => spawnSync(process.execPath, [...f.releaseRoot.nodeArgs, f.releaseRoot.release, ...args], {
  cwd: ROOT, env: f.env, encoding: 'utf8', timeout: 60_000,
});
const calls = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

describe('customer corpus promotion (ADR-086 C4 resolution S1)', () => {
  it('the gh interception seam is actually live — every "no network" claim below depends on it', async () => {
    // A test that asserts `calls(f)` is empty proves nothing if the shim was never wired: an
    // un-intercepted run would ALSO write no log. This proves the seam intercepts before any of
    // those assertions are allowed to mean anything.
    const f = await fixture();
    expect(f.env.RUVNET_GH_COMMAND).toBe(process.execPath);
    expect(fs.existsSync(f.env.RUVNET_GH_SCRIPT)).toBe(true);
    expect(fs.existsSync(f.log)).toBe(false);
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const observed = calls(f);
    expect(observed.length).toBeGreaterThan(0);
    // And the interceptor — not the real gh — is what answered: only the fixture writes this log,
    // and only the fixture returns the exact draft/promoted views this run required to succeed.
    expect(observed[0]).toEqual(['release', 'list', '--repo', REPO, '--limit', '200', '--json', 'tagName,isDraft,isPrerelease']);
  });

  it('GREEN: publishes a complete draft, proves every asset landed, then STAGES it as a public non-latest prerelease', async () => {
    const f = await fixture();
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const sequence = calls(f);
    expect(sequence.map((call) => `${call[0]} ${call[1]}`)).toEqual([
      'release list',   // publish-time re-resolve: is the approved runtime still the newest code release
      `api repos/${REPO}/commits/${APPROVED_TAG}`, // and is the target its source commit
      'release view',   // this tag must not already exist
      'release view',   // what is releases/latest right now
      'release create', // draft, with every asset
      'release view',   // are all assets actually uploaded
      'release edit',   // stage: public prerelease, never latest
      'release view',   // and prove the staged state
      `api repos/${REPO}/releases/latest`, // releases/latest is NOT this tag (isLatest is not a view field)
    ]);
    expect(sequence[7]).toEqual(['release', 'view', f.tag, '--json', 'tagName,isDraft,isPrerelease,assets', '--repo', REPO]);

    const create = sequence[4];
    // S1, verbatim: "Remove both --prerelease and --latest=false for customer corpus releases".
    expect(create).not.toContain('--prerelease');
    expect(create).not.toContain('--latest=false');
    // ASSETS COMPLETE BEFORE PROMOTION: created as a draft, which releases/latest cannot resolve to.
    expect(create).toContain('--draft');
    expect(create.slice(-8)).toEqual([f.bundle, `${f.bundle}.sig`, `${f.bundle}.sha256`, f.receiptFile,
      `${f.bundle}.accuracy.json`, `${f.bundle}.recall.json`,
      expect.stringMatching(/[\\/]CORPUS-COVERAGE\.json$/), expect.stringMatching(/[\\/]coverage-receipt\.json$/)]);
    expect(create[create.indexOf('--notes') + 1]).toContain(`${CORPUS_GENERATION_FIELD} 2026-09-13T12:00:00.000Z`);

    expect(sequence[6]).toEqual(['release', 'edit', f.tag, '--repo', REPO, '--draft=false', '--prerelease', '--latest=false']);
    // THE PRODUCER CANNOT DECLARE SUCCESS: nothing in the staging run ever claims latest.
    expect(sequence.flat()).not.toContain('--latest');
    expect(JSON.parse(result.stdout)).toMatchObject({ staged: true, promoted: false });
  });

  it('RED: the removed one-shot --promote-latest is refused before anything is read or written', async () => {
    const f = await fixture();
    const result = run(f, f.args.map((arg) => (arg === '--stage-candidate' ? '--promote-latest' : arg)));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--promote-latest was removed: stage with --stage-candidate, then promote with --promote-staged/);
    expect(calls(f)).toEqual([]);
  });

  it.each([
    ['the detached signature', '.sig'],
    ['the sha256 sidecar', '.sha256'],
  ])('RED: refuses before touching the network when %s is missing', async (_name, extension) => {
    const f = await fixture();
    fs.rmSync(`${f.bundle}${extension}`);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/customer corpus promotion requires a .* beside the archive/);
    expect(result.stderr).toMatch(/updater fails closed without it/);
    expect(calls(f)).toEqual([]);
  });

  it('RED: refuses a signature that does not verify against the shipped trust root', async () => {
    const f = await fixture({ signWithAttackerKey: true });
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/detached signature does not verify against the shipped trust root/);
    expect(calls(f)).toEqual([]);
  });

  it('RED: refuses when the archive was altered after signing', async () => {
    const f = await fixture();
    fs.appendFileSync(f.bundle, 'tampered-after-signing');
    const result = run(f);
    expect(result.status).toBe(1);
    // The outer digest check fires first; either way nothing reaches gh.
    expect(result.stderr).toMatch(/archive.*receipt|signature/i);
    expect(calls(f)).toEqual([]);
  });

  it.each([
    ['a newer corpus generation already on latest', {
      latest: { tagName: `corpus-sha256-${'a'.repeat(64)}`, body: `${CORPUS_GENERATION_FIELD} 2026-09-14T00:00:00.000Z` },
    }, /refusing to move customers backward/],
    ['an identical corpus generation already on latest', {
      latest: { tagName: `corpus-sha256-${'a'.repeat(64)}`, body: `${CORPUS_GENERATION_FIELD} 2026-09-13T12:00:00.000Z` },
    }, /refusing to move customers backward/],
    ['a corpus release on latest with no readable ordering key', {
      latest: { tagName: `corpus-sha256-${'a'.repeat(64)}`, body: 'Some release notes.' },
    }, /no readable .* ordering key/],
    ['an unreadable latest lookup', { latestError: 'gateway timeout' },
      /cannot determine the current latest release/],
  ])('RED (stale or concurrent): refuses promotion over %s', async (_name, patch, message) => {
    const f = await fixture();
    f.write(patch);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    // It looked, then stopped. No release was created.
    expect(calls(f).some((call) => call[1] === 'create')).toBe(false);
  });

  it('RED: refuses to re-promote the tag that is already latest', async () => {
    const f = await fixture();
    f.write({ latest: { tagName: f.tag, body: `${CORPUS_GENERATION_FIELD} 2026-09-13T12:00:00.000Z` } });
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is already the published latest release/);
  });

  it('GREEN: a code release on latest does not block a corpus generation', async () => {
    const f = await fixture();
    f.write({ latest: { tagName: 'v4.3.25', body: 'Product release.' } }); // sync-version-ignore: fixture code release tag
    expect(run(f).status).toBe(0);
  });

  it.each([
    ['one asset still missing', { draftView: { isDraft: true, assets: uploaded(ASSET_NAMES.slice(0, 3)) } }],
    ['an asset still uploading', {
      draftView: { isDraft: true, assets: [...uploaded(ASSET_NAMES.slice(0, 3)), { name: 'corpus-receipt.json', size: 10, state: 'uploading' }] },
    }],
    ['a zero-byte asset', {
      draftView: { isDraft: true, assets: [...uploaded(ASSET_NAMES.slice(0, 3)), { name: 'corpus-receipt.json', size: 0, state: 'uploaded' }] },
    }],
    ['a release that is somehow not a draft', { draftView: { isDraft: false, assets: uploaded() } }],
  ])('RED (incomplete before promotion): refuses to promote with %s', async (_name, patch) => {
    const f = await fixture();
    f.write(patch);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to stage an incomplete corpus release/);
    // Never made public: a customer install must not see a release missing its archive.
    expect(calls(f).some((call) => call[1] === 'edit')).toBe(false);
  });

  it.each([
    ['still a draft', { finalView: { isDraft: true, isPrerelease: true, assets: uploaded() } }],
    ['already latest (a customer would receive an un-canaried corpus)', { latestAfter: 'SELF' }],
    ['not a prerelease', { finalView: { isDraft: false, isPrerelease: false, assets: uploaded() } }],
    ['missing an asset after staging', { finalView: { isDraft: false, isPrerelease: true, assets: uploaded(ASSET_NAMES.slice(0, 2)) } }],
  ])('RED: refuses to report success when the staged release is %s', async (_name, patch) => {
    const f = await fixture();
    const finalView = { tagName: f.tag, isDraft: false, isPrerelease: true, assets: uploaded(), ...patch.finalView };
    f.write({ ...patch, ...(patch.latestAfter === 'SELF' ? { latestAfter: { tag_name: f.tag } } : {}), finalView });
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/did not reach a complete, public, non-latest prerelease state/);
  });

  it('SUPERSEDED: a newer code release published after the build -> exit 4, typed outcome, nothing created', async () => {
    const f = await fixture();
    f.write({ codeReleases: [codeRelease('v9.9.10'), codeRelease(APPROVED_TAG)] }); // sync-version-ignore: fixture code release
    const result = run(f);
    expect(result.status, result.stderr).toBe(4);
    expect(JSON.parse(result.stdout.trim().split('\n').pop())).toMatchObject({ ok: false, outcome: 'superseded' });
    expect(result.stderr).toMatch(/superseded: code release v9\.9\.10 was published after this corpus was built at v9\.9\.9/);
    // It looked at the release list and nothing else: no create, no edit, not even a tag probe.
    expect(calls(f).map((call) => `${call[0]} ${call[1]}`)).toEqual(['release list']);
  });

  it.each([
    ['the approved tag is not the newest code release in the other direction', { codeReleases: [codeRelease('v9.9.8')] }, /newer than every published code release/],
    ['no code release is listed at all', { codeReleases: [] }, /no published code release is listed/],
    ['the target is not the approved release commit', { approvedSha: 'b'.repeat(40) }, /is not the source of the approved runtime v9\.9\.9/],
  ])('RED: refuses (exit 1, never created) when %s', async (_name, patch, message) => {
    const f = await fixture();
    f.write(patch);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(calls(f).some((call) => call[1] === 'create')).toBe(false);
  });

  it('RED: a customer promotion without --approved-tag, or naming a runtime the archive does not ship, never reaches gh', async () => {
    const f = await fixture();
    const without = f.args.slice(0, -2);
    expect(f.args.slice(-2)).toEqual(['--approved-tag', APPROVED_TAG]);
    const missing = run(f, without);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/customer promotion requires --approved-tag vX\.Y\.Z/);
    const foreign = run(f, [...without, '--approved-tag', 'v9.9.10']); // sync-version-ignore: fixture code release
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toMatch(/the archive ships runtime v9\.9\.9, not the approved runtime v9\.9\.10/);
    expect(calls(f)).toEqual([]);
  });

  it('RED: the target must be an ancestor of this run\'s GITHUB_SHA (decoupled from, never ahead of, main)', async () => {
    const f = await fixture();
    const parent = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const result = spawnSync(process.execPath, [...f.releaseRoot.nodeArgs, f.releaseRoot.release, ...f.args], {
      cwd: ROOT, env: { ...f.env, GITHUB_SHA: parent }, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/is not an ancestor of this run's GITHUB_SHA/);
    expect(calls(f)).toEqual([]);
  });

  it('RED: bootstrap mode is unchanged — no signature required, no latest promotion', async () => {
    const f = await fixture({ sign: false });
    const bootstrapArgs = f.args.filter((arg) => arg !== '--stage-candidate');
    const result = run(f, bootstrapArgs);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const sequence = calls(f);
    expect(sequence).toHaveLength(2);
    expect(sequence[1]).toContain('--prerelease');
    expect(sequence[1]).toContain('--latest=false');
    expect(JSON.parse(result.stdout).promoted).toBe(false);
  });

  it('RED (capability boundary): corpus routing can never enter product publication', async () => {
    const f = await fixture();
    const result = run(f, [...f.args, '--publish']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--corpus-seed cannot be combined with --publish/);
    expect(calls(f)).toEqual([]);
  });
});


// ── PROMOTION: the only path to releases/latest, and it needs the consumer's consent ──────────────
const RUN_ID = '4242';
const RUN_ATTEMPT = '1';
const digestAssets = (digest) => ASSET_NAMES.map((name) => ({ name, size: 10, state: 'uploaded',
  digest: `sha256:${name === 'ruvnet-brain.zip' ? digest : crypto.createHash('sha256').update(name).digest('hex')}` }));
const passVerdict = (f, over = {}) => ({
  schemaVersion: 1, kind: CANARY_VERDICT_KIND, verdict: 'PASS', repo: REPO, tag: f.tag, archiveSha256: f.digest,
  approvedVersion: APPROVED_TAG.slice(1), runId: RUN_ID, runAttempt: RUN_ATTEMPT, checkedAt: '2026-09-13T13:00:00.000Z',
  assets: digestAssets(f.digest).map(({ name, size, digest }) => ({ name, size, digest })),
  checks: REQUIRED_CANARY_CHECKS.map((name) => ({ name, ok: true, detail: 'fixture' })),
  ...over,
});

async function promotionFixture({ verdict = (f) => passVerdict(f), config = {} } = {}) {
  const f = await fixture();
  const verdictFile = path.join(f.dir, 'corpus-canary-verdict.json');
  const body = `RuvNet Brain corpus generation.\n${CORPUS_GENERATION_FIELD} 2026-09-13T12:00:00.000Z\n`;
  f.write({
    stagedView: { tagName: f.tag, isDraft: false, isPrerelease: true, assets: digestAssets(f.digest), body },
    finalView: { tagName: f.tag, isDraft: false, isPrerelease: false, assets: digestAssets(f.digest) },
    latestAfter: { tag_name: f.tag },
    ...config,
  });
  if (verdict) fs.writeFileSync(verdictFile, JSON.stringify(verdict(f)));
  return {
    ...f,
    verdictFile,
    promoteArgs: ['--corpus-seed', '--promote-staged', '--corpus-tag', f.tag, '--canary-verdict', verdictFile,
      '--target', HEAD, '--repo', REPO, '--approved-tag', APPROVED_TAG],
    env: { ...f.env, GITHUB_RUN_ID: RUN_ID, GITHUB_RUN_ATTEMPT: RUN_ATTEMPT },
  };
}
const promote = (f) => run(f, f.promoteArgs);

describe('customer corpus promotion requires the customer canary (the consumer must accept first)', () => {
  it('GREEN: a PASS verdict for this run over the exact staged assets promotes the prerelease to latest', async () => {
    const f = await promotionFixture();
    const result = promote(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const sequence = calls(f);
    expect(sequence.map((call) => `${call[0]} ${call[1]}`)).toEqual([
      'release list', `api repos/${REPO}/commits/${APPROVED_TAG}`, // still the newest code release, still its source
      'release view', // the staged prerelease, with the asset digests the verdict must match
      'release view', // what is latest now (ordering)
      'release edit', // promote
      'release view', `api repos/${REPO}/releases/latest`, // prove latest IS this tag
    ]);
    expect(sequence[4]).toEqual(['release', 'edit', f.tag, '--repo', REPO, '--prerelease=false', '--latest']);
    expect(JSON.parse(result.stdout)).toMatchObject({ promoted: true, tag: f.tag });
  });

  it.each([
    ['the canary FAILED (e.g. unsigned: the updater exited 4)', (f) => passVerdict(f, { verdict: 'FAIL',
      checks: REQUIRED_CANARY_CHECKS.map((name) => ({ name, ok: name !== 'signature-verified', detail: 'SIGNATURE VERIFICATION FAILED' })) })],
    ['there is no verdict at all', null],
  ])('RED before the network: %s', async (_name, verdict) => {
    const f = await promotionFixture({ verdict });
    const result = promote(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no customer consent/);
    expect(calls(f)).toEqual([]);
  });

  it.each([
    ['a verdict from another run', (f) => passVerdict(f, { runId: '999' }), /belongs to run 999\/1, not this run 4242\/1/],
    ['a verdict for another candidate', (f) => passVerdict(f, { tag: `corpus-sha256-${'f'.repeat(64)}` }), /the verdict is for corpus-sha256-f+/],
    ['a PASS that omits a required check (coverage never judged)', (f) => passVerdict(f, {
      checks: REQUIRED_CANARY_CHECKS.filter((name) => name !== 'staged-coverage').map((name) => ({ name, ok: true, detail: 'x' })) }), /required check staged-coverage is absent/],
    ['a PASS whose node_modules check failed', (f) => passVerdict(f, {
      checks: REQUIRED_CANARY_CHECKS.map((name) => ({ name, ok: name !== 'node-modules', detail: 'dropped by the update: @xenova/transformers' })) }), /required check node-modules failed/],
    ['a canary that installed another runtime', (f) => passVerdict(f, { approvedVersion: '9.9.8' }), /the canary installed 9\.9\.8, not v9\.9\.9/],
    ['assets swapped after the canary downloaded them', (f) => passVerdict(f, {
      assets: digestAssets(f.digest).map(({ name, size, digest }) => ({ name, size, digest: name === 'ruvnet-brain.zip.sig' ? `sha256:${'0'.repeat(64)}` : digest })) }),
    /not byte-for-byte the ones the canary downloaded/],
  ])('RED (never promoted): %s', async (_name, verdict, message) => {
    const f = await promotionFixture({ verdict });
    const result = promote(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(calls(f).some((call) => call[1] === 'edit')).toBe(false);
  });

  it.each([
    ['no longer a prerelease', (f) => ({ stagedView: { tagName: f.tag, isDraft: false, isPrerelease: false, assets: digestAssets(f.digest), body: `${CORPUS_GENERATION_FIELD} 2026-09-13T12:00:00.000Z` } }),
      /is not a staged \(public, non-draft\) prerelease/],
    ['a newer generation reached latest meanwhile', () => ({ latest: { tagName: `corpus-sha256-${'a'.repeat(64)}`, body: `${CORPUS_GENERATION_FIELD} 2026-09-14T00:00:00.000Z` } }),
      /refusing to move customers backward/],
  ])('RED (re-proved at promotion time): the staged release is %s', async (_name, patch, message) => {
    const f = await promotionFixture();
    f.write({ ...JSON.parse(fs.readFileSync(f.configFile, 'utf8')), ...patch(f) });
    const result = promote(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(calls(f).some((call) => call[1] === 'edit')).toBe(false);
  });

  it('SUPERSEDED at promotion: a code release that landed during the canary -> exit 4, nothing promoted', async () => {
    const f = await promotionFixture();
    f.write({ ...JSON.parse(fs.readFileSync(f.configFile, 'utf8')), codeReleases: [codeRelease('v9.9.10'), codeRelease(APPROVED_TAG)] }); // sync-version-ignore: fixture code release
    const result = promote(f);
    expect(result.status).toBe(4);
    expect(calls(f).map((call) => `${call[0]} ${call[1]}`)).toEqual(['release list']);
  });

  it('RED: the promoted release must end as latest, non-prerelease, with the same assets', async () => {
    const f = await promotionFixture({ config: { latestAfter: { tag_name: `corpus-sha256-${'d'.repeat(64)}` } } });
    const result = promote(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/did not reach a complete, non-draft, non-prerelease latest state/);
  });
});

describe('evaluateCanaryVerdict (pure)', () => {
  const tag = `corpus-sha256-${'c'.repeat(64)}`;
  const assets = [{ name: 'ruvnet-brain.zip', digest: `sha256:${'c'.repeat(64)}` }, { name: 'ruvnet-brain.zip.sig', digest: `sha256:${'1'.repeat(64)}` }];
  const base = { schemaVersion: 1, kind: CANARY_VERDICT_KIND, verdict: 'PASS', tag, archiveSha256: 'c'.repeat(64), approvedVersion: '9.9.9',
    runId: '7', runAttempt: '2', assets, checks: REQUIRED_CANARY_CHECKS.map((name) => ({ name, ok: true })) };
  const judge = (verdict, over = {}) => evaluateCanaryVerdict({ verdict, tag, runId: '7', runAttempt: '2', approvedTag: 'v9.9.9', releaseAssets: assets, ...over });
  it('allows exactly a complete PASS for this run over these assets', () => {
    expect(judge(base).allowed).toBe(true);
  });
  it.each([
    ['a re-run attempt reusing an older attempt\'s verdict', {}, { runAttempt: '3' }],
    ['a missing run identity on the promoting side', {}, { runId: undefined }],
    ['an asset without a digest', { assets: [{ name: 'ruvnet-brain.zip', digest: null }] }, { releaseAssets: [{ name: 'ruvnet-brain.zip', digest: null }] }],
    ['an extra asset on the release', {}, { releaseAssets: [...assets, { name: 'extra.bin', digest: `sha256:${'2'.repeat(64)}` }] }],
    ['a different kind', { kind: 'something-else' }, {}],
    ['a verdict whose archive digest is not the tag digest', { archiveSha256: 'd'.repeat(64) }, {}],
  ])('refuses %s', (_name, verdictPatch, over) => {
    expect(judge({ ...base, ...verdictPatch }, over).allowed).toBe(false);
  });
});

describe('corpus generation ordering key', () => {
  it('reads the published ordering key and ignores everything else in the notes', () => {
    expect(parseCorpusGeneration(`Header\n${CORPUS_GENERATION_FIELD} 2026-09-13T12:00:00.000Z\nArchive SHA-256: abc`))
      .toEqual({ value: '2026-09-13T12:00:00.000Z', epoch: Date.parse('2026-09-13T12:00:00.000Z') });
    expect(parseCorpusGeneration('no key here')).toBeNull();
    expect(parseCorpusGeneration(`${CORPUS_GENERATION_FIELD} not-a-date`)).toBeNull();
  });

  it.each([
    ['no latest at all', null, '2026-09-13T00:00:00Z', true],
    ['an older corpus generation', { tagName: `corpus-sha256-${'b'.repeat(64)}`, body: `${CORPUS_GENERATION_FIELD} 2026-09-12T00:00:00Z` }, '2026-09-13T00:00:00Z', true],
    ['a newer corpus generation', { tagName: `corpus-sha256-${'b'.repeat(64)}`, body: `${CORPUS_GENERATION_FIELD} 2026-09-14T00:00:00Z` }, '2026-09-13T00:00:00Z', false],
    ['an equal corpus generation', { tagName: `corpus-sha256-${'b'.repeat(64)}`, body: `${CORPUS_GENERATION_FIELD} 2026-09-13T00:00:00Z` }, '2026-09-13T00:00:00Z', false],
    ['a code release', { tagName: 'v4.3.25', body: '' }, '2026-09-13T00:00:00Z', true], // sync-version-ignore: fixture code release tag
    ['an unreadable candidate generation', null, 'not-a-date', true],
  ])('decides promotion over %s', (_name, currentLatest, generation, allowed) => {
    expect(evaluateCorpusPromotion({ tag: `corpus-sha256-${'c'.repeat(64)}`, generation, currentLatest }).allowed).toBe(allowed);
  });
});
