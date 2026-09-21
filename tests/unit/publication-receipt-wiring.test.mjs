import { describe, expect, it } from 'vitest';
import { HOST_MODES, RECEIPT_MODE_NAMES } from '../../scripts/host-install-matrix.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
const transaction = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction.mjs'), 'utf8');
const provider = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction-provider.mjs'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/protected-release.yml'), 'utf8');
const producer = fs.readFileSync(path.join(ROOT, 'scripts/publication-receipt.mjs'), 'utf8');
const hostMatrix = fs.readFileSync(path.join(ROOT, 'scripts/host-install-matrix.mjs'), 'utf8');
const publicLane = fs.readFileSync(path.join(ROOT, 'scripts/public-verification-lane.mjs'), 'utf8');
const finalizer = fs.readFileSync(path.join(ROOT, 'scripts/public-verification-finalizer.mjs'), 'utf8');

const position = (source, needle) => {
  const index = source.indexOf(needle);
  expect(index, `missing ${needle}`).toBeGreaterThan(-1);
  return index;
};

describe('publication receipt wiring', () => {
  it('passes the exact sealed candidate tarball into one provider', () => {
    expect(release).toContain("sealedPackageArtifact = path.resolve(ROOT, protectedCandidate.artifact.path)");
    expect(release).toContain("packagePath: byRole.get('npm')");
    expect(release).toContain('candidate receipt package and payload package bytes differ');
    // Pins the ONE publish call: explicit candidate tag, and (since 4.3.26) stderr surfaced with a
    // registry-sized timeout — 4.3.25's first run published successfully and left no diagnostic.
    expect(provider).toContain("command('npm', ['publish', packagePath, '--tag', `candidate-v${identity.version}`], PUBLISH_COMMAND_OPTIONS)");
    expect(provider).toContain("const PUBLISH_COMMAND_OPTIONS = Object.freeze({ stdio: ['ignore', 'pipe', 'inherit'], timeout: 600_000 })");
    expect(provider).toContain("command('gh', ['release', 'upload', draft.tag, file, '--repo', REPO])");
  });

  it('keeps channel convergence nonterminal and moves public proof into the protected finalizer path', () => {
    expect(transaction).not.toContain('adapter.finalize');
    expect(transaction).toContain("return append('channels-converged', { verdict: 'PUBLISHED_NOT_VERIFIED'");
    expect(provider).not.toContain("'scripts/verify-channels.mjs'");
    expect(producer).toContain('githubBundleDigest');
    expect(publicLane).toContain('generatePublicationReceipt');
    expect(finalizer).toContain('finalizeReleaseTransaction');
    expect(transaction, 'the transaction must be able to reach convergence')
      .toContain("append('channels-converged'");
    expect(position(release, 'await runReleaseTransaction'), 'the nonterminal banner must follow channel convergence')
      .toBeGreaterThan(-1);
    expect(position(transaction, "append('channels-converged'"))
      .toBeGreaterThan(-1);
    expect(release).toContain('if (PUBLISH)');
  });

  it('does not let unrelated private draft assets break the public transaction scan', () => {
    expect(provider).toContain('if (release.draft && release.tag_name !== identity.tag) continue;');
    expect(provider).toContain('Published');
    expect(provider).toContain('releases remain fully receipt-gated');
  });

  it('provisions virgin host CLIs before the protected publisher and gives the producer read-only GitHub access', () => {
    const hostTools = position(workflow, 'npm install --global --prefix "$RUNNER_TEMP/host-clis"');
    const publisher = position(workflow, 'node scripts/release.mjs --publish');
    expect(hostTools).toBeLessThan(publisher);
    expect(workflow).toContain('@anthropic-ai/claude-code@latest');
    expect(workflow).toContain('@openai/codex@latest');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}');
  });

  it('binds all three isolated public host modes to the sealed package and clean doctor', () => {
    expect(producer.match(/assertInstalledPayload\(sealedPlugin, path\.dirname\(path\.dirname\(manifest\)\)\)/g)).toHaveLength(2);
    // Was: an exact source-string match on the mode list. That is the defect class GPT-5.6-Sol
    // flagged here — a wiring test that pins TEXT passes on broken behaviour and fails on
    // improved code, which is exactly what it did when the loop started deriving its modes from
    // HOST_MODES. Assert the PROPERTY instead: the producer covers every host shape the matrix
    // defines, whatever the loop looks like, and adding a fourth shape cannot silently skip it.
    for (const mode of HOST_MODES) {
      expect(producer, `the producer must cover the ${mode} host`).toContain(RECEIPT_MODE_NAMES[mode]);
    }
    expect(producer, 'the mode list must be derived, not restated').toContain('HOST_MODES');
    expect(producer).toContain("[installer, '--doctor', '--hooks']");
    expect(producer).toContain('stageVerifiedBundle({ bundlePath, bundleSha256, packageRoot })');
    expect(position(producer, 'runMeasuredHostSearches(hostResults, searchInstalledHost, {'))
      .toBeLessThan(position(producer, "await commandAsync(process.execPath, [installer, '--doctor', '--hooks']"));
  });

  it('keeps only one installed search worker active through host verification', () => {
    expect(producer).toContain('runMeasuredHostSearches(hostResults, searchInstalledHost, {');
    expect(producer).toContain('warmup: async ({ mode, context }) =>');
    expect(producer).toContain('after: async ({ mode }) =>');
    expect(producer).toContain('if (mode !== \'dual\')');
    expect(producer).toContain('only one model-backed MCP worker can consume resources at a time');
  });

  it('bounds the install smoke to one source-cited result from the Brain self store', () => {
    expect(hostMatrix).toContain("export const SELF_STORE_PROOF_QUERY = 'repo:ruvnet-brain What is the RuvNet Brain release evidence workflow?'");
    expect(hostMatrix).toContain('export const SELF_STORE_PROOF_K = 1');
    expect(producer).toContain('SELF_STORE_PROOF_QUERY');
    expect(producer).toContain('SELF_STORE_PROOF_K');
    expect(producer).toContain('/repo\\s*=\\s*ruvnet-brain/i.test(result.stdout)');
    expect(producer).toContain('installed Brain ${phase} failed for ${mode} after ${timeoutMs}ms');
  });

  it('does not downgrade the accepted dual-host native nightly proof', () => {
    expect(producer).not.toContain('publicNativeNightly: false');
    expect(publicLane).toContain("if (mode === 'dual')");
  });

  it('MUTANT: checkout publication cannot replace the sealed artifact command', () => {
    expect(provider).not.toContain("command('npm', ['publish', '--tag', 'latest'])");
  });

  it.each([
    ['MUTANT: omit publication producer', publicLane, /generatePublicationReceipt/g],
    ['MUTANT: omit sealed artifact', provider, /assets\.packagePath/g],
  ])('%s', (_name, source, guard) => {
    expect(source.replace(guard, '')).not.toMatch(guard);
    expect(source).toMatch(guard);
  });
});
