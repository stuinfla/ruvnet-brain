import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createPayloadManifest, payloadIdFor } from '../../scripts/release-payload.mjs';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const qe = fs.readFileSync(path.join(ROOT, 'scripts/qe/agentic-qe-4.3.mjs'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release-candidate-preflight.yml'), 'utf8');
const earlyPublic = fs.readFileSync(path.join(ROOT, '.github/workflows/early-public.yml'), 'utf8');

describe('early public artifact QE', () => {
  it('retains unique Codex cases everywhere and omits only already-run Linux release QE suites', () => {
    const selector = qe.slice(qe.indexOf("  'early-public': [") + "  'early-public': ".length,
      qe.indexOf('  check: [')).trim().replace(/,$/, '');
    const codex = 'tests/unit/npm-tarball-codex.test.mjs';
    const crossPlatform = ['tests/qe/release/packed-clean-install.test.mjs',
      'tests/qe/release/issue-64-host-convergence.test.mjs', codex];
    for (const platform of ['linux', 'darwin', 'win32']) {
      const steps = vm.runInNewContext(selector, { process: { platform }, vitest: files => files });
      expect(Array.from(steps[0])).toEqual(platform === 'linux' ? [codex] : crossPlatform);
    }
    const releaseConfig = fs.readFileSync(path.join(ROOT, 'tests/qe/release/vitest.config.mjs'), 'utf8');
    expect(releaseConfig).toContain("include: ['tests/qe/release/**/*.test.mjs']");
  });

  it('restores and verifies the same-run sealed package before selecting it', () => {
    expect(earlyPublic).toContain('name: release-evidence-${{ inputs.candidate_sha }}');
    const script = earlyPublic.split("node --input-type=module <<'NODE'\n")[1].split('          NODE')[0]
      .split('\n').map(line => line.slice(10)).join('\n');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'early-public-payload-'));
    try {
      const evidence = path.join(temp, 'release-evidence');
      fs.mkdirSync(evidence);
      fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(temp, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
      const artifact = path.join(evidence, 'candidate.tgz');
      fs.writeFileSync(artifact, 'sealed package bytes');
      const manifest = createPayloadManifest({ candidateSha: 'a'.repeat(40), producer: { runId: '42' },
        members: [{ name: 'candidate.tgz', role: 'npm', file: artifact }] });
      const manifestFile = path.join(evidence, 'payload-manifest.json');
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      fs.writeFileSync(path.join(evidence, 'npm-pack.json'), JSON.stringify([{ filename: 'candidate.tgz' }]));
      const envFile = path.join(temp, 'github-env');
      const run = extra => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: temp, env: { ...process.env, CANDIDATE_SHA: manifest.candidateSha, GITHUB_RUN_ID: '42',
          GITHUB_ENV: envFile, ...extra }, stdio: 'pipe',
      });
      run();
      expect(fs.readFileSync(envFile, 'utf8')).toContain(`RUVNET_SEALED_PACKAGE=${fs.realpathSync(artifact)}\n`);
      expect(fs.readFileSync(envFile, 'utf8')).toContain(`RUVNET_SEALED_PAYLOAD_ID=${payloadIdFor(manifest)}\n`);
      // Execute the existing receipt consumer too: identity fields must be enforcing, not decorative.
      const check = workflow.split("node --input-type=module <<'NODE'\n")[1].split('          NODE')[0]
        .split('\n').map(line => line.slice(10)).join('\n');
      const receipts = path.join(temp, 'lane-evidence/early-public');
      for (const platform of ['linux', 'darwin', 'win32']) {
        fs.mkdirSync(path.join(receipts, platform), { recursive: true });
        fs.writeFileSync(path.join(receipts, platform, 'early-public.json'), JSON.stringify({
          schema: 'ruvnet-brain.agentic-qe.receipt', contract: 'agentic-qe-4.3', lane: 'early-public',
          status: 'PASS', sha: manifest.candidateSha, runId: '42', host: `${platform}-x64`, payloadId: payloadIdFor(manifest),
          artifactSha256: manifest.members[0].sha256, steps: [{ status: 'PASS', tests: { total: 1, skipped: 0 } }],
        }));
      }
      const consume = () => execFileSync(process.execPath, ['--input-type=module', '-e', check], {
        cwd: temp, env: { ...process.env, CANDIDATE_SHA: manifest.candidateSha, GITHUB_RUN_ID: '42' }, stdio: 'pipe',
      });
      consume();
      const receiptFile = path.join(receipts, 'linux', 'early-public.json');
      const receipt = JSON.parse(fs.readFileSync(receiptFile));
      for (const field of ['payloadId', 'artifactSha256', 'runId']) {
        fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, [field]: 'wrong' }));
        expect(() => consume()).toThrow();
      }
      fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, host: 'darwin-x64' }));
      expect(() => consume()).toThrow();
      expect(() => run({ CANDIDATE_SHA: 'b'.repeat(40) })).toThrow();
      expect(() => run({ GITHUB_RUN_ID: '43' })).toThrow();
      fs.writeFileSync(path.join(evidence, 'npm-pack.json'), JSON.stringify([{ filename: 'other.tgz' }]));
      expect(() => run()).toThrow();
      fs.writeFileSync(path.join(evidence, 'npm-pack.json'), JSON.stringify([{ filename: 'candidate.tgz' }]));
      fs.writeFileSync(artifact, 'changed package bytes');
      expect(() => run()).toThrow();
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    expect(workflow).toContain('receipt.payloadId !== payloadIdFor(manifest)');
    expect(workflow).toContain('receipt.artifactSha256 !== npm[0].sha256');
  });

  it('is a required three-OS candidate gate and stays before publication', () => {
    for (const os of ['linux', 'macos', 'windows']) {
      expect(workflow).toContain(`early-public-${os}:`);
      expect(workflow).toContain(`os_name: ${os}`);
    }
    expect(earlyPublic).toContain('node scripts/qe/agentic-qe-4.3.mjs --lane early-public');
    const aggregate = workflow.indexOf('node scripts/prepublication-evidence.mjs');
    const early = workflow.indexOf('early-public-linux:');
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(aggregate);
    // macos-candidate-search (exact-candidate macOS host qualification, 1f1913d1) joined this gate
    // after this assertion was first written; the aggregate now waits on it too.
    for (const lane of ['ci', 'integration', 'ux']) {
      expect(workflow).toContain(`\n  ${lane}:\n    needs: candidate-preflight\n`);
    }
    expect(workflow).toContain('needs: [candidate-preflight, ci, integration, ux, stranger, early-public-linux, early-public-macos, early-public-windows, macos-candidate-search]');
  });
});


it('executes sealed archive metadata reads without GNU-tar remote drive-letter arguments', () => {
  const sealed = 'D:\\a\\ruvnet-brain\\release-evidence\\candidate.tgz';
  const calls = ['tests/qe/release/packed-clean-install.test.mjs', 'tests/unit/npm-tarball-codex.test.mjs'].flatMap(file =>
    fs.readFileSync(path.join(ROOT, file), 'utf8').match(/execFileSync\('tar',\s*\[\s*'-(?:xOf|tzf)'[\s\S]*?\{[^}]+\}\)/g) || []);
  expect(calls).toHaveLength(3);
  for (const expression of calls) {
    const invoked = [];
    const execFileSync = (binary, args, options) => {
      // GNU tar's actual failure seam: a colon-bearing archive is interpreted as a remote host.
      if (args[1].includes(':')) throw new Error('GNU tar remote archive interpretation');
      invoked.push({ binary, archive: args[1], cwd: options.cwd });
      return 'sealed metadata';
    };
    vm.runInNewContext(expression, { sealed, path: path.win32, execFileSync });
    expect(invoked).toEqual([{ binary: 'tar', archive: 'candidate.tgz', cwd: path.win32.dirname(sealed) }]);
    expect(() => vm.runInNewContext(expression.replace('path.basename(sealed)', 'sealed'),
      { sealed, path: path.win32, execFileSync })).toThrow('remote archive');
  }
});
