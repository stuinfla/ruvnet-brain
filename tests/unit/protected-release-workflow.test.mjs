import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const workflow = () => read('.github/workflows/protected-release.yml');

function dispatchInputNames(source) {
  const block = source.match(/workflow_dispatch:\s*\n\s{4}inputs:\s*\n([\s\S]*?)(?=\n\s{2}[a-zA-Z_-]+:|\npermissions:)/)?.[1] || '';
  return [...block.matchAll(/^\s{6}([a-zA-Z0-9_-]+):\s*$/gm)].map(([, name]) => name);
}

describe('protected release rail', () => {
  it('is the sole human release dispatch and accepts source identity only', () => {
    const releaseWorkflows = [
      'protected-release.yml',
      'release-cycle.yml',
      'release-aggregate.yml',
      'product-integrity-review.yml',
      'ci.yml',
      'integration-linux.yml',
      'ux-qe.yml',
      'stranger-matrix.yml',
    ];
    const dispatchers = releaseWorkflows
      .filter((file) => fs.existsSync(path.join(ROOT, '.github/workflows', file)))
      .filter((file) => /\n\s{2}workflow_dispatch:/.test(read(`.github/workflows/${file}`)));
    expect(dispatchers).toEqual(['protected-release.yml']);
    expect(dispatchInputNames(workflow())).toEqual(['candidate_sha', 'version']);
  });

  it('runs every expensive lane once in the exact-SHA preflight before publication', () => {
    const source = read('.github/workflows/release-candidate-preflight.yml');
    for (const file of ['ci.yml', 'integration-linux.yml', 'ux-qe.yml', 'stranger-matrix.yml']) {
      expect(read(`.github/workflows/${file}`), `${file} must be reusable`).toMatch(/\n\s{2}workflow_call:/);
      expect(source, `${file} must be called by release-candidate-preflight`).toContain(`uses: ./.github/workflows/${file}`);
      expect(workflow(), `${file} must not rerun during publication`).not.toContain(`uses: ./.github/workflows/${file}`);
    }
  });

  it('derives artifact identity from produced bytes instead of accepting a human digest', () => {
    const source = workflow();
    expect(dispatchInputNames(source)).not.toContain('artifact_sha256');
    expect(source).toContain("crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')");
    expect(source).toContain('artifact_sha256=${digest}');
  });

  it('binds the dispatch to a clean current-main candidate and governed blockers', () => {
    const source = workflow();
    expect(source).toContain('test "$(git rev-parse origin/main)" = "$EXPECTED_SHA"');
    expect(source).toContain('test -z "$(git status --porcelain)"');
    expect(source).toContain('issues: read');
    expect(source).toContain('--state open --label release-blocker');
    expect(source).toContain('test "$blockers" -eq 0');
  });

  it('has no prior-run lookup, polling, or caller-supplied run identity', () => {
    const source = workflow();
    expect(source).not.toMatch(/\bgh run (?:list|view|watch)\b/);
    expect(source).not.toMatch(/^\s+run-id:/m);
    expect(source).not.toMatch(/(?:release_qe|aggregate|review)_run_id/);
  });

  it('invokes the sole publisher once while keeping environment-scoped signing secrets', () => {
    const source = workflow();
    expect(source).toContain('group: ruvnet-brain-release');
    expect(source).toContain('cancel-in-progress: false');
    expect(source.match(/environment: Production – ruvnet-brain/g)).toHaveLength(3);
    expect(source.match(/node scripts\/release\.mjs --publish/g)).toHaveLength(1);
    expect(source).toContain('RUVNET_RELEASE_MODE: stabilization');
    expect(source).not.toContain('continue-on-error: true');
  });

  it('stops channel publication at signed PUBLISHED_NOT_VERIFIED before public install proof', () => {
    const source = workflow();
    expect(source).toContain('RUVNET_RELEASE_IDENTITY: release-evidence/release-identity.json');
    expect(source).toContain('RUVNET_CHANNEL_RECEIPT: release-evidence/channels-converged-receipt.json');
    expect(source).toContain("receipt.state !== 'channels-converged'");
    expect(source).toContain("receipt.observation?.verdict !== 'PUBLISHED_NOT_VERIFIED'");
  });

  it('completes the public three-OS by three-loader proof before install-verified', () => {
    const source = workflow();
    for (const lane of [
      'ubuntu-latest, os_name: linux',
      'macos-latest, os_name: macos',
      'windows-latest, os_name: windows',
    ]) expect(source).toContain(lane);
    expect(read('scripts/public-verification-lane.mjs')).toContain('for (const mode of PUBLIC_VERIFICATION_MODES)');
    const lane = source.indexOf('node scripts/public-verification-lane.mjs');
    const aggregate = source.indexOf('node scripts/public-verification-aggregate.mjs', lane);
    const finalize = source.indexOf('node scripts/public-verification-finalizer.mjs', aggregate);
    const terminal = source.indexOf('--out release-evidence/install-verified-receipt.json', finalize);
    expect(lane).toBeGreaterThan(-1);
    expect(source.indexOf('if: always()', lane)).toBeGreaterThan(lane);
    expect(source.indexOf('if-no-files-found: warn', lane)).toBeGreaterThan(lane);
    expect(source).toContain('host_cli_prefix="$RUNNER_TEMP/ruvnet-host-clis"');
    expect(source).toContain('npm install --prefix "$host_cli_prefix"');
    expect(source).toContain('cygpath -w "$host_cli_prefix/node_modules/.bin"');
    expect(source).not.toContain('cygpath -w "$PWD/node_modules/.bin"');
    expect(source).toContain('RUVNET_CLAUDE_MARKETPLACE_SOURCE: ${{ github.workspace }}');
    expect(aggregate).toBeGreaterThan(lane);
    expect(finalize).toBeGreaterThan(aggregate);
    expect(terminal).toBeGreaterThan(finalize);
  });

  it('derives baseline and candidate retrieval inputs before sealing the payload', () => {
    const source = read('.github/workflows/ci.yml');
    expect(source.match(/node scripts\/public-verification-inputs\.mjs/g)?.length || 0).toBeGreaterThanOrEqual(2);
    expect(source.indexOf('Build the immutable knowledge bundle exactly once'))
      .toBeLessThan(source.indexOf('node scripts/public-verification-inputs.mjs'));
    expect(source.indexOf('node scripts/public-verification-inputs.mjs'))
      .toBeLessThan(source.indexOf('Persist the canonical candidate payload manifest'));
    for (const argument of [
      '--baseline-bundle "$RUVNET_SEED_BUNDLE"',
      '--candidate-bundle "$RUNNER_TEMP/release-evidence/ruvnet-brain.zip"',
      '--candidate-package "$RUVNET_SEALED_PACKAGE"',
      '--oracle data/retrieval-query-evidence.json',
      '--observed-baseline',
    ]) expect(source).toContain(argument);
  });

  it('selects a real RVF rather than macOS ZIP metadata', () => {
    const source = read('.github/workflows/ci.yml');
    expect(source).toContain("-type f -name '*.big.rvf'");
    expect(source).toContain("! -path '*/__MACOSX/*' ! -name '._*'");
    expect(source).toContain("LC_ALL=C sort -u");
    expect(source).toContain('node scripts/rvf-index-audit.mjs --dir "${asset_dirs[0]}"');
  });
});
