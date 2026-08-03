import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
const transaction = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction.mjs'), 'utf8');
const provider = fs.readFileSync(path.join(ROOT, 'scripts/release-transaction-provider.mjs'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/protected-release.yml'), 'utf8');
const producer = fs.readFileSync(path.join(ROOT, 'scripts/publication-receipt.mjs'), 'utf8');

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
    expect(provider).toContain("command('npm', ['publish', packagePath, '--tag', `candidate-v${identity.version}`])");
    expect(provider).toContain("command('gh', ['release', 'upload', draft.tag, file, '--repo', REPO])");
  });

  it('generates and validates publication evidence before remote convergence', () => {
    expect(position(provider, "'scripts/publication-receipt.mjs'"))
      .toBeLessThan(position(provider, "'scripts/release-proof.mjs'"));
    expect(position(transaction, 'adapter.finalize'))
      .toBeLessThan(transaction.lastIndexOf("append('channels-converged'"));
    expect(provider).not.toContain("'scripts/verify-channels.mjs'");
    expect(producer).toContain('githubBundleDigest');
    expect(position(transaction, "append('channels-converged'"))
      .toBeLessThan(position(release, '✓✓✓ SHIPPED'));
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
    expect(producer).toContain("for (const mode of ['claudeOnly', 'codexOnly', 'dual'])");
    expect(producer).toContain("[installer, '--doctor', '--hooks']");
  });

  it('MUTANT: checkout publication cannot replace the sealed artifact command', () => {
    expect(provider).not.toContain("command('npm', ['publish', '--tag', 'latest'])");
  });

  it.each([
    ['MUTANT: omit publication producer', /publication-receipt\.mjs/g],
    ['MUTANT: omit sealed artifact', /assets\.packagePath/g],
  ])('%s', (_name, guard) => {
    expect(provider.replace(guard, '')).not.toMatch(guard);
    expect(provider).toMatch(guard);
  });
});
