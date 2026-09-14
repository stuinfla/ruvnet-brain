import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCorpusReceipt } from '../../scripts/corpus-candidate.mjs';
import { evaluateCorpusPromotion, parseCorpusGeneration, CORPUS_GENERATION_FIELD } from '../../scripts/corpus-promotion.mjs';
import { sealedCorpusBundle } from '../helpers/corpus-seed-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RELEASE = path.join(ROOT, 'scripts/release.mjs');
const SIGN = path.join(ROOT, 'scripts/sign-bundle.mjs');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const REPO = 'stuinfla/ruvnet-brain';
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

const ASSET_NAMES = ['ruvnet-brain.zip', 'ruvnet-brain.zip.sig', 'ruvnet-brain.zip.sha256', 'corpus-receipt.json'];
const uploaded = (names = ASSET_NAMES) => names.map((name) => ({ name, size: 10, state: 'uploaded' }));

// The real gh surface the promote path touches, driven by a JSON config so each case mutates exactly
// one fact. Every invocation is logged, so "refused BEFORE the network" is a checkable claim.
const GH_FIXTURE = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n');
const cfg = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE_CONFIG, 'utf8'));
const jsonAt = args.indexOf('--json');
const fields = jsonAt >= 0 ? args[jsonAt + 1] : null;
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
  process.stdout.write(JSON.stringify(cfg.finalView)); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'create' && cfg.createFails) { console.error('create blew up'); process.exit(1); }
if (args[0] === 'release' && args[1] === 'edit' && cfg.editFails) { console.error('edit blew up'); process.exit(1); }
process.exit(0);
`;

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

  const { bundle } = await sealedCorpusBundle(dir);
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
  const configFile = path.join(dir, 'gh-config.json');
  const resolved = {
    tagExists: false,
    latest: null,
    draftView: { isDraft: true, assets: uploaded() },
    finalView: { tagName: tag, isDraft: false, isLatest: true, isPrerelease: false, assets: uploaded() },
    ...config,
  };
  fs.writeFileSync(configFile, JSON.stringify(resolved));

  return {
    dir, bundle, receiptFile, receipt, digest, tag, configFile, log, resolved,
    write: (patch) => fs.writeFileSync(configFile, JSON.stringify({ ...resolved, ...patch })),
    args: [
      '--corpus-seed', '--promote-latest', '--corpus-tag', tag,
      '--corpus-bundle', bundle, '--corpus-receipt', receiptFile,
      '--target', HEAD, '--repo', REPO,
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

const run = (f, args = f.args) => spawnSync(process.execPath, [RELEASE, ...args], {
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
    expect(observed[0]).toEqual(['release', 'view', f.tag, '--json', 'tagName', '--repo', REPO]);
  });

  it('GREEN: publishes a complete draft, proves every asset landed, then promotes it to latest', async () => {
    const f = await fixture();
    const result = run(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const sequence = calls(f);
    expect(sequence.map((call) => `${call[0]} ${call[1]}`)).toEqual([
      'release view',   // this tag must not already exist
      'release view',   // what is releases/latest right now
      'release create', // draft, with every asset
      'release view',   // are all four assets actually uploaded
      'release edit',   // promote
      'release view',   // and prove the promoted state
    ]);

    const create = sequence[2];
    // S1, verbatim: "Remove both --prerelease and --latest=false for customer corpus releases".
    expect(create).not.toContain('--prerelease');
    expect(create).not.toContain('--latest=false');
    // ASSETS COMPLETE BEFORE PROMOTION: created as a draft, which releases/latest cannot resolve to.
    expect(create).toContain('--draft');
    expect(create.slice(-4)).toEqual([f.bundle, `${f.bundle}.sig`, `${f.bundle}.sha256`, f.receiptFile]);
    expect(create[create.indexOf('--notes') + 1]).toContain(`${CORPUS_GENERATION_FIELD} 2026-09-13T12:00:00.000Z`);

    expect(sequence[4]).toEqual(['release', 'edit', f.tag, '--repo', REPO, '--draft=false', '--latest', '--prerelease=false']);
    expect(JSON.parse(result.stdout).promoted).toBe(true);
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
    expect(result.stderr).toMatch(/refusing to promote an incomplete corpus release/);
    // Never promoted: releases/latest must not resolve to a release missing its archive.
    expect(calls(f).some((call) => call[1] === 'edit')).toBe(false);
  });

  it.each([
    ['still a draft', { finalView: { isDraft: true, isLatest: true, isPrerelease: false, assets: uploaded() } }],
    ['not latest', { finalView: { tagName: 'x', isDraft: false, isLatest: false, isPrerelease: false, assets: uploaded() } }],
    ['still a prerelease', { finalView: { isDraft: false, isLatest: true, isPrerelease: true, assets: uploaded() } }],
    ['missing an asset after promotion', { finalView: { isDraft: false, isLatest: true, isPrerelease: false, assets: uploaded(ASSET_NAMES.slice(0, 2)) } }],
  ])('RED: refuses to report success when the promoted release is %s', async (_name, patch) => {
    const f = await fixture();
    f.write({ ...patch, finalView: { tagName: f.tag, ...patch.finalView } });
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/did not reach a complete, non-draft, non-prerelease latest state/);
  });

  it('RED: bootstrap mode is unchanged — no signature required, no latest promotion', async () => {
    const f = await fixture({ sign: false });
    const bootstrapArgs = f.args.filter((arg) => arg !== '--promote-latest');
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
