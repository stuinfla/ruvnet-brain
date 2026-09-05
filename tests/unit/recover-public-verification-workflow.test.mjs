import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(import.meta.dirname,
  '../../.github/workflows/recover-public-verification.yml'), 'utf8');
const position = (needle) => {
  const index = source.indexOf(needle);
  expect(index, `missing ${needle}`).toBeGreaterThan(-1);
  return index;
};

describe('post-publication recovery rail', () => {
  it('cannot republish and binds recovery to one prior run and exact artifact', () => {
    expect(source).toContain('repository_dispatch:');
    expect(source).toContain('artifact-ids: ${{ needs.authorize.outputs.artifact_id }}');
    expect(source).toContain('run-id: ${{ needs.authorize.outputs.publication_run_id }}');
    expect(source).toContain('.workflow_run.id == $run');
    expect(source).not.toContain('release.mjs --publish');
    expect(source).not.toContain('npm publish');
  });

  it('validates the complete signed chain before exposing recovered evidence', () => {
    expect(position('validateReceiptChain(receipts, identity, publicKey)'))
      .toBeLessThan(position("materializeExactJson('release-evidence/release-identity.json'"));
    expect(source).toContain("terminal.state !== 'channels-converged'");
    expect(source).toContain("terminal.observation?.verdict !== 'PUBLISHED_NOT_VERIFIED'");
    expect(source).toContain('terminal.sequence !== 13');
    expect(source).toContain('const materializeExactJson = (file, value) =>');
    expect(source).toContain('canonicalJson(read(file)) !== canonicalJson(value)');
    expect(source).not.toContain("fs.writeFileSync('release-evidence/release-identity.json'");
  });

  it('runs exactly three OS lanes against the released source and then finalizes', () => {
    expect(source).toContain('path: release-evidence/');
    expect(source).toContain('payload-manifest.json');
    for (const lane of [
      'ubuntu-latest, os_name: linux',
      'macos-latest, os_name: macos',
      'windows-latest, os_name: windows',
    ]) expect(source).toContain(lane);
    expect(position('node scripts/public-verification-lane.mjs'))
      .toBeLessThan(position('node scripts/public-verification-aggregate.mjs'));
    expect(position('node scripts/public-verification-aggregate.mjs'))
      .toBeLessThan(position('node scripts/public-verification-finalizer.mjs'));
    expect(source.match(/environment: Production – ruvnet-brain/g)).toHaveLength(1);
    expect(source.match(/RUVNET_SIGNING_KEY:/g)).toHaveLength(1);
    expect(source).toContain('host_cli_prefix="$RUNNER_TEMP/ruvnet-host-clis"');
    expect(source).toContain('npm install --prefix "$host_cli_prefix"');
    expect(source).toContain('cygpath -w "$host_cli_prefix/node_modules/.bin"');
    expect(source).not.toContain('cygpath -w "$PWD/node_modules/.bin"');
    expect(source).toContain('RUVNET_CLAUDE_MARKETPLACE_SOURCE: ${{ github.workspace }}');
    expect(source).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(source).toContain('if-no-files-found: warn');
  });
});
