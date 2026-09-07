import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// Historical source-shape checks only. Never release qualification or runtime proof.

{

const ROOT = path.resolve(import.meta.dirname, '../..');
const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
const transaction = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction.mjs'), 'utf8');
const provider = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction-provider.mjs'), 'utf8');
const bundle = fs.readFileSync(path.join(ROOT, 'scripts/build-bundle.mjs'), 'utf8');
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const protectedWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/protected-release.yml'), 'utf8');
const publicLane = fs.readFileSync(path.join(ROOT, 'scripts/public-verification-lane.mjs'), 'utf8');

const position = (source, needle) => {
  const found = source.indexOf(needle);
  expect(found, `missing release operation: ${needle}`).toBeGreaterThanOrEqual(0);
  return found;
};

describe('release publication is one remote durable staged transaction', () => {
  it('binds signed append-only receipts to exact candidate and artifact identity', () => {
    expect(transaction).toContain('transactionIdFor');
    expect(transaction).toContain('candidateSha: identity.candidateSha');
    expect(transaction).toContain('packageIntegrity: identity.packageIntegrity');
    expect(transaction).toContain('bundleSha256: identity.bundleSha256');
    expect(transaction).toContain('crypto.sign');
    expect(transaction).toContain('previousReceiptDigest');
    expect(provider).toContain("command('gh', ['release', 'upload', anchor.tag, file, '--repo', REPO])");
    expect(provider).toContain('refusing to replace staged asset with different bytes');
    expect(provider).not.toContain("'--clobber'");
    expect(provider).toContain('fetch(metadata.dist.tarball');
    expect(provider).not.toContain("command('npm', ['pack'");
    expect(provider).toContain('staged npm package integrity mismatch');
  });

  it('creates a remote draft before the first externally visible candidate mutation', () => {
    expect(position(transaction, "append('remote-prepared'"))
      .toBeLessThan(position(transaction, "transition('npm-stage-intent'"));
    expect(position(transaction, "transition('npm-stage-intent'"))
      .toBeLessThan(position(transaction, 'adapter.stageNpm'));
    expect(provider).toContain("'-F', 'draft=true'");
  });

  it('stages npm and GitHub non-latest before changing either default', () => {
    const operations = [
      'adapter.stageNpm',
      'adapter.publishDraftNonLatest',
      'adapter.promoteNpm',
      'adapter.makeGithubLatest',
    ].map((needle) => position(transaction, needle));
    operations.push(transaction.lastIndexOf("append('channels-converged'"));
    expect(operations).toEqual([...operations].sort((a, b) => a - b));
    expect(provider).toContain("'make_latest=false'");
    expect(provider).toContain("'make_latest=true'");
  });

  it('requires bundle, signature, digest, and sealed package as one staged asset set', () => {
    expect(release).toContain('const assets = {');
    expect(release).toContain("bundleSignaturePath: path.join(payloadRoot, 'ruvnet-brain.zip.sig')");
    expect(release).toContain("bundleDigestPath: path.join(payloadRoot, 'ruvnet-brain.zip.sha256')");
    expect(release).toContain("packagePath: byRole.get('npm')");
    expect(release).toContain('signed release asset missing');
    expect(provider).toContain('assets.packagePath');
  });

  it('builds once in candidate CI, signs once in the protected seal job, and never rebuilds in the publisher', () => {
    expect(bundle).toContain('fs.rmSync(ZIP, { force: true })');
    expect(bundle).toContain("await import('../kb/zip-extract.mjs')");
    expect(bundle).toContain('const packagedAudit = await auditRvfIndexes(packagedRvfs)');
    expect(ci).toContain('node scripts/build-bundle.mjs');
    expect(protectedWorkflow).toContain("name: Sign this run's exact payload once");
    expect(protectedWorkflow).toContain('node scripts/sign-bundle.mjs');
    expect(release).not.toContain("runOrDie('build release bundle'");
    expect(release).not.toContain("runOrDie('sign release bundle'");
  });

  it('fails closed on competing transactions and duplicate drafts', () => {
    expect(transaction).toContain('pending release ${competing[0].transactionId} blocks');
    expect(transaction).toContain('duplicate matching drafts require reconciliation');
    expect(transaction).toContain('release receipt sequence gap or replay');
    expect(transaction).toContain('release receipt chain conflict');
  });

  it('uses guarded compensation and preserves an explicit human-only abort terminal', () => {
    expect(transaction).toContain("snapshot.npm?.latestVersion !== prior?.npmLatest");
    expect(provider).toContain('refusing compensation: npm latest is');
    expect(transaction).toContain("if (!authorized) throw new Error('release abort requires explicit human authorization')");
  });

  it('stops publication at channel convergence and defers public evidence to the protected matrix', () => {
    expect(transaction).not.toContain('adapter.finalize');
    expect(provider).not.toContain("'scripts/verify-channels.mjs'");
    expect(provider).not.toContain("'scripts/published-surface-probe.mjs', '--json'");
    expect(provider).not.toContain('publication.postPublicationChecks');
    expect(publicLane).toContain('generatePublicationReceipt');
    expect(protectedWorkflow).toContain('needs: [verified-candidate, publish]');
    expect(position(protectedWorkflow, 'node scripts/release.mjs --publish'))
      .toBeLessThan(position(protectedWorkflow, 'node scripts/public-verification-lane.mjs'));
    expect(position(protectedWorkflow, 'node scripts/public-verification-lane.mjs'))
      .toBeLessThan(position(protectedWorkflow, 'node scripts/public-verification-finalizer.mjs'));
  });
});

}

{

const ROOT = path.resolve(import.meta.dirname, '../..');
const SERVER = fs.readFileSync(path.join(ROOT, 'scripts/onboarding-console.mjs'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'console/app.js'), 'utf8');

describe('console control completeness', () => {
  it('renders only config choices with a proven consumer', () => {
    expect(SERVER).toContain('const CONFIG_CONTROL_SUPPORT = Object.freeze({});');
    for (const key of ['openrouterKey', 'nightly', 'routing', 'qeFleet']) {
      expect(SERVER).toMatch(new RegExp(`\\b${key}:`));
    }
    expect(SERVER).toContain('saveOpenRouterCredential(requestedSecret');
    expect(SERVER).toContain('applyNightlyChoice(requestedNightly)');
    expect(SERVER).toContain('detectProvider(cat, { provider: cfgNow.provider })');
  });

  it('surfaces every canonical user setting through a live control', () => {
    for (const live of [
      'brainEnabled', 'brainProfile', 'learningScope', 'advocacy', 'autoApply',
      'newProjectDefaults',
    ]) {
      expect(SERVER).toContain(`'${live}'`);
    }
    expect(SERVER).toContain('const LIVE_USER_SETTING_KEYS = Object.freeze(');
    expect(SERVER).toContain('const autoApplyOn = loadSettings().values.autoApply === true');
  });

  it('keeps all four working choice paths connected to their real consumers', () => {
    expect(SERVER).toContain('saveBrainPower(body.values || {})');
    expect(SERVER).toContain('saveBrainProfile(body.values || {})');
    expect(SERVER).toContain('saveAdvocacy(body.values || {})');
    expect(SERVER).toContain('detectProvider(cat, { provider: cfgNow.provider })');
  });

  it('surfaces platform-unavailable choices without fake controls', () => {
    expect(APP).toContain('Unavailable on this machine');
    expect(APP).toContain('runtime is not supported or reachable on this machine');
    expect(APP).toContain('settings-unavailable-list');
    expect(APP).toContain('unavailable here');
  });

  it('offers one consent-gated Fix all path with per-item revalidation and undo', () => {
    expect(APP).toContain('Fix all (');
    expect(APP).toContain('Yes, fix all verified items');
    expect(APP).toContain('Unsupported settings and secrets are never included');
    expect(APP).toContain("postJSON('/api/apply', { ids: recs.map((rec) => rec.id), preStateHash })");
    expect(APP).toContain("postJSON('/api/undo', { undoToken: result.undoToken })");
    expect(SERVER).toContain('const { ids: validNow } = currentValidIds(id);');
    expect(SERVER).toContain("onlyId.startsWith('reconcile:')");
  });
});

}

{
const ROOT = path.resolve(import.meta.dirname, '../..');
const SESSION = path.join(ROOT, 'plugin/scripts/session-start-core.mjs');
describe('retired hook and source-shape release diagnostics', () => {
  it('emits host-aware restart guidance and preserves Codex hook trust review', () => {
    const source = fs.readFileSync(SESSION, 'utf8');
    expect(source).toContain("env.RUVNET_HOOK_HOST || 'claude'");
    expect(source).toContain('already installed and verified for Codex');
    expect(source).toContain('restart Codex');
    expect(source).toContain('run /hooks and trust only ruvnet-brain@ruvnet-brain');
    expect(source).toContain('already installed and verified for Claude Code');
    expect(source).toContain('claude --continue');
    expect(source).toContain('host-convergence.json');
    expect(source).toContain('do not restart for this update yet');
  });

  it('does not launch the update heartbeat in the same SessionStart that seeds the Stable Spine', () => {
    const source = fs.readFileSync(SESSION, 'utf8');
    expect(source).toContain('let seedDispatched = false');
    expect(source).toContain('seedDispatched = dispatchDetached');
    expect(source).toContain('first-session-worker.mjs');
    expect(source).toMatch(/if\s*\(seedDispatched\s*\|\|/);
  });

  it('the installer binds host sync and Spine activation to one exact package version', () => {
    const source = fs.readFileSync(path.join(ROOT, 'bin/install.mjs'), 'utf8');
    expect(source).toContain('wirePlugin({ expectedVersion: PACKAGE_VERSION, requireManaged: true })');
    expect(source).toContain("'--auto', '--expected-version', PACKAGE_VERSION");
    expect(source).toContain('if (results.claude.host && !results.claude.wired)');
    expect(source).toContain("['plugin', 'update', 'ruvnet-brain@ruvnet-brain', '--scope', 'user']");
    expect(source).toContain("['plugin', 'marketplace', 'update', 'ruvnet-brain']");
    expect(source).toContain('host-convergence.json');
    expect(fs.readFileSync(path.join(ROOT, 'plugin/scripts/host-update.mjs'), 'utf8')).toContain("'--host-sync-only'");
  });
});
}
