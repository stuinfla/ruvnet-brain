import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const release = fs.readFileSync(path.join(ROOT, 'scripts/release.mjs'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/protected-release.yml'), 'utf8');
const producer = fs.readFileSync(path.join(ROOT, 'scripts/publication-receipt.mjs'), 'utf8');

const position = (source, needle) => {
  const index = source.indexOf(needle);
  expect(index, `missing ${needle}`).toBeGreaterThan(-1);
  return index;
};

describe('publication receipt wiring', () => {
  it('publishes the exact sealed candidate tarball to npm and GitHub', () => {
    expect(release).toContain("sealedPackageArtifact = path.resolve(ROOT, protectedCandidate.artifact.path)");
    expect(release).toContain('const assets = [zip, `${zip}.sig`, `${zip}.sha256`, sealedPackageArtifact]');
    expect(release).toContain("runOrDie('npm publish', 'npm', ['publish', sealedPackageArtifact, '--tag', 'latest'])");
  });

  it('generates and validates publication evidence before SHIPPED or channel convergence', () => {
    const producer = position(release, "runOrDie('publication receipt'");
    expect(producer).toBeGreaterThan(position(release, "runOrDie('verify-channels'"));
    expect(producer).toBeLessThan(position(release, "recordReleaseTransaction('channels-converged'"));
    expect(producer).toBeLessThan(position(release, '✓✓✓ SHIPPED'));
    expect(release).toContain("'scripts/publication-receipt.mjs', '--candidate'");
  });

  it('provisions virgin host CLIs before the protected publisher and gives the producer read-only GitHub access', () => {
    const hostTools = position(workflow, 'npm install --global --prefix "$RUNNER_TEMP/host-clis"');
    const publisher = position(workflow, 'node scripts/release.mjs --publish');
    expect(hostTools).toBeLessThan(publisher);
    expect(workflow).toContain('@anthropic-ai/claude-code@latest');
    expect(workflow).toContain('@openai/codex@latest');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}');
  });

  it('binds both installed plugin payloads to the sealed public package bytes', () => {
    expect(producer).toContain('assertInstalledPayload(sealedPlugin, path.dirname(path.dirname(claudeManifest)))');
    expect(producer).toContain('assertInstalledPayload(sealedPlugin, path.dirname(path.dirname(codexManifest)))');
  });

  it('MUTANT: checkout publication cannot replace the sealed artifact command', () => {
    expect(release).not.toContain("runOrDie('npm publish', 'npm', ['publish', '--tag', 'latest'])");
  });

  it.each([
    ['MUTANT: omit publication producer', /runOrDie\('publication receipt'/g],
    ['MUTANT: omit sealed artifact from release assets', /, sealedPackageArtifact/g],
  ])('%s', (_name, guard) => {
    expect(release.replace(guard, '')).not.toMatch(guard);
    expect(release).toMatch(guard);
  });
});
