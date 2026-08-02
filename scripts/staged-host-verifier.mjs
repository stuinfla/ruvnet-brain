import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export function classifyDoctorResult(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (!result.error && result.status === 0) return { accepted: true, status: 'PASS', output };
  const pendingReview = result.status === 1
    && /Codex installed the Brain, but \d+ lifecycle hooks await review/i.test(output)
    && /Grounding PROVEN/i.test(output)
    && !/reader MISSING|search_ruvnet MISSING|host convergence incomplete|receipt is invalid/i.test(output);
  return { accepted: pendingReview, status: pendingReview ? 'PENDING_REVIEW' : 'FAIL', output };
}

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

const fixturePath = (mode, temp) => {
  const bin = path.join(temp, `bin-${mode}`);
  fs.mkdirSync(bin);
  const hosts = mode === 'claude' ? ['claude'] : mode === 'codex' ? ['codex'] : ['claude', 'codex'];
  const desired = ['node', 'npm', ...hosts];
  for (const name of desired) {
    const target = locate(name);
    if (!target) throw new Error(`${name} CLI unavailable for ${mode} host fixture`);
    fs.symlinkSync(target, path.join(bin, name));
  }
  return `${bin}:/usr/bin:/bin`;
};

export function stagedHostVerifier({ assets, identity }) {
  return {
    async verify({ source, assets: observedAssets = assets }) {
      const prepared = preparePackage(observedAssets);
      const results = {};
      try {
        for (const mode of ['claude', 'codex', 'dual']) {
          const home = path.join(prepared.temp, `home-${mode}`);
          const brainHome = path.join(home, '.cache', 'ruvnet-brain');
          fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
          if (mode !== 'claude') fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
          const env = {
            ...process.env,
            HOME: home,
            CODEX_HOME: path.join(home, '.codex'),
            RUVNET_BRAIN_HOME: brainHome,
            RUVNET_BRAIN_KB: path.join(brainHome, 'kb'),
            RUVNET_CLAUDE_MARKETPLACE_SOURCE: prepared.packageRoot,
            CI: 'true',
            PATH: fixturePath(mode, prepared.temp),
          };
          const installer = path.join(prepared.packageRoot, 'bin', 'install.mjs');
          run(process.execPath, [installer, '--local', '--yes', '--force', '--no-nightly-prompt',
            '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck'], {
            cwd: prepared.packageRoot, env, timeout: 1_200_000,
          });
          const doctor = spawnSync(process.execPath, [installer, '--doctor'], {
            cwd: prepared.packageRoot, env, timeout: 180_000,
          });
          const classified = classifyDoctorResult(doctor);
          if (!classified.accepted) {
            throw new Error(`doctor failed for ${mode}: ${classified.output.slice(-5000) || doctor.error?.message}`);
          }
          results[mode] = {
            status: classified.status,
            doctorExit: doctor.status,
            version: identity.version,
          };
        }
        return { verdict: 'PASS', source, artifactSha256: sha256(observedAssets.packagePath), fixtures: results };
      } catch (error) {
        return { verdict: 'FAIL', error: error.message, fixtures: results };
      } finally {
        fs.rmSync(prepared.temp, { recursive: true, force: true });
      }
    },
  };
}
