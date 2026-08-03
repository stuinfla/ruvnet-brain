#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stagedHostVerifier } from './staged-host-verifier.mjs';
import { payloadIdFor } from './release-payload.mjs';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const manifestPath = path.resolve(arg('--manifest'));
const packagePath = path.resolve(arg('--package'));
const bundlePath = path.resolve(arg('--bundle'));
const out = path.resolve(arg('--out'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const payloadId = payloadIdFor(manifest);
const identity = { version: manifest.version, candidateSha: manifest.candidateSha, payloadId };
const result = await stagedHostVerifier({ assets: { packagePath, bundlePath }, identity })
  .verify({ source: 'candidate', assets: { packagePath, bundlePath } });
if (result.verdict !== 'PASS') throw new Error(`candidate host matrix failed: ${result.error || 'unknown'}`);

const modeNames = { claude: 'claude-only', codex: 'codex-only', dual: 'dual-host' };
const leaves = Object.entries(modeNames).map(([mode, name]) => {
  const fixture = result.fixtures?.[mode];
  if (fixture?.status !== 'PASS' || fixture?.doctorExit !== 0) throw new Error(`${name} did not produce a clean doctor receipt`);
  return {
    name,
    sha: manifest.candidateSha,
    payloadId,
    status: fixture.status === 'PASS' ? 'completed' : 'failed',
    conclusion: 'success',
    verdict: 'PASS',
    source: 'candidate-host-evidence',
    mode,
    doctorExit: fixture.doctorExit,
    artifactSha256: sha256(packagePath),
  };
});
fs.writeFileSync(out, `${JSON.stringify({
  schemaVersion: 1,
  sha: manifest.candidateSha,
  payloadId,
  artifactSha256: sha256(packagePath),
  leaves,
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ verdict: 'PASS', payloadId, leaves: leaves.map(({ name }) => name) }));
