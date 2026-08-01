#!/usr/bin/env node
// Produce the explicit maintenance-release seal used when the owner chooses to publish a
// stabilization build before the separate >=95 promotion program is complete. This receipt never
// claims 95 and cannot satisfy the strict candidate schema by accident.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { evaluateStabilizationCandidateReceipt } from './release-proof.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function packedVersion(artifact) {
  const result = spawnSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot read packed package.json: ${String(result.stderr || '').trim()}`);
  return JSON.parse(result.stdout).version;
}

export function createStabilizationReceipt({ root, artifactPath, qe, audit }) {
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
    return result.stdout.trim();
  };
  const manifest = readJson(path.join(root, 'package.json'));
  const claude = readJson(path.join(root, 'plugin/.claude-plugin/plugin.json'));
  const codex = readJson(path.join(root, 'plugin/.codex-plugin/plugin.json'));
  const sha = git('rev-parse', 'HEAD');
  const digest = sha256(artifactPath);
  const total = Number(qe?.numTotalTests ?? qe?.testResults?.reduce((sum, file) => sum + (file.assertionResults?.length || 0), 0) ?? 0);
  const failed = Number(qe?.numFailedTests ?? 0);
  const skipped = Number(qe?.numPendingTests ?? 0);
  const passed = Number(qe?.numPassedTests ?? Math.max(0, total - failed - skipped));
  const vulnerabilities = audit?.metadata?.vulnerabilities;
  if (!vulnerabilities || !Number.isFinite(Number(vulnerabilities.critical))
    || !Number.isFinite(Number(vulnerabilities.high))) {
    throw new Error('dependency audit evidence is missing critical/high counts');
  }
  const receipt = {
    schemaVersion: 1,
    phase: 'stabilization-candidate',
    mode: 'stabilization',
    reason: 'Owner-authorized 4.0.4 stabilization release; >=95 promotion remains open work',
    targetScore: 95,
    scoreClaimed: false,
    sha,
    tree: git('rev-parse', 'HEAD^{tree}'),
    dirty: Boolean(git('status', '--porcelain')),
    version: manifest.version,
    tag: `v${manifest.version}`,
    sourceVersions: { package: manifest.version, claudePlugin: claude.version, codexPlugin: codex.version },
    artifact: {
      path: `release-evidence/${path.basename(artifactPath)}`,
      sha256: digest,
      sourceSha: sha,
      version: packedVersion(artifactPath),
    },
    security: {
      status: Number(vulnerabilities.critical || 0) === 0 && Number(vulnerabilities.high || 0) === 0 ? 'PASS' : 'FAIL',
      critical: Number(vulnerabilities.critical || 0),
      high: Number(vulnerabilities.high || 0),
    },
    qe: { status: total > 0 && failed === 0 && skipped === 0 ? 'PASS' : 'FAIL', total, passed, failed, skipped },
    limitations: [
      'No >=95 score claimed',
      'Strict promotion receipt remains unsatisfied',
      'Clean-host and installed-Brain acceptance are required after publication',
    ],
  };
  const result = evaluateStabilizationCandidateReceipt(receipt);
  if (result.verdict !== 'PASS') throw new Error(`stabilization seal failed: ${result.failures.map(({ code }) => code).join(',')}`);
  return receipt;
}

export function main(args = process.argv.slice(2)) {
  try {
    const rootArg = argument(args, '--root');
    const artifactArg = argument(args, '--artifact');
    const outArg = argument(args, '--out');
    if (!artifactArg || !outArg) throw new Error('--artifact and --out are required');
    const root = path.resolve(rootArg || process.cwd());
    const artifactPath = path.resolve(artifactArg);
    const outPath = path.resolve(outArg);
    if (fs.existsSync(outPath)) throw new Error(`refusing to overwrite existing receipt: ${outPath}`);
    const receipt = createStabilizationReceipt({
      root,
      artifactPath,
      qe: readJson(argument(args, '--qe')),
      audit: readJson(argument(args, '--audit')),
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ verdict: 'PASS', sha: receipt.sha, artifactSha256: receipt.artifact.sha256, version: receipt.version }));
    return 0;
  } catch (error) {
    console.error(`stabilization-receipt: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
