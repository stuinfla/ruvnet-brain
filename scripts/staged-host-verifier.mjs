import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHostMatrix } from './host-install-matrix.mjs';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const locate = (name) => {
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { return null; }
};

const run = (name, args, options) => {
  const result = spawnSync(name, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message);
    throw new Error(`${path.basename(name)} ${args.join(' ')} failed: ${detail.slice(-5000)}`);
  }
  return result;
};

// The doctor verdict has ONE rule, in host-install-matrix.mjs. This name is kept because
// tests/unit/staged-host-verifier.test.mjs pins it, but it is now an alias, not a second copy.
export { classifyDoctor as classifyDoctorResult } from './host-install-matrix.mjs';

const preparePackage = ({ packagePath, bundlePath }) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-staged-host-'));
  run('tar', ['-xzf', packagePath, '-C', temp]);
  const packageRoot = path.join(temp, 'package');
  const bundleRoot = path.join(packageRoot, 'dist', 'ruvnet-brain');
  fs.mkdirSync(bundleRoot, { recursive: true });
  run('unzip', ['-q', bundlePath, '-d', bundleRoot]);
  const nested = path.join(bundleRoot, 'ruvnet-brain');
  if (fs.existsSync(nested)) {
    for (const name of fs.readdirSync(nested)) fs.renameSync(path.join(nested, name), path.join(bundleRoot, name));
    fs.rmdirSync(nested);
  }
  return { temp, packageRoot };
};

export function stagedHostVerifier({ assets, identity }) {
  return {
    async verify({ source, assets: observedAssets = assets }) {
      const prepared = preparePackage(observedAssets);
      try {
        // The loop, the mode names, the env and the doctor verdict all live in
        // scripts/host-install-matrix.mjs, shared with the published-side check in
        // publication-receipt.mjs. This file used to carry its own copy, which had drifted to
        // different mode names (claude/codex/dual vs claudeOnly/codexOnly/dual) and a different
        // install shape than the one that runs after publication — so the two halves of a release
        // were judging different things and could not be compared. Only the STAGED-vs-PUBLISHED
        // difference is real, and it is now a named variant rather than a second implementation.
        const matrix = runHostMatrix({
          packageRoot: prepared.packageRoot,
          version: identity.version,
          variant: 'staged',
          locate,
          temp: prepared.temp,
        });
        if (matrix.verdict !== 'PASS') {
          return { verdict: 'FAIL', source, error: matrix.error, fixtures: matrix.fixtures };
        }
        return {
          verdict: 'PASS',
          source,
          artifactSha256: sha256(observedAssets.packagePath),
          fixtures: matrix.fixtures,
        };
      } catch (error) {
        return { verdict: 'FAIL', source, error: error.message, fixtures: {} };
      } finally {
        fs.rmSync(prepared.temp, { recursive: true, force: true });
      }
    },
  };
}
