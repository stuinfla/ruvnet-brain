#!/usr/bin/env node
// Produce the explicit maintenance-release seal used when the owner chooses to publish a
// stabilization build before the separate >=95 promotion program is complete. This receipt never
// claims 95 and cannot satisfy the strict candidate schema by accident.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateStabilizationCandidateReceipt } from './release-proof.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const EXCEPTIONS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'audit-exceptions.json');
const DAY = 86_400_000;
export const MAX_EXCEPTION_DAYS = 14;
const GHSA = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/;

/**
 * OWNER-APPROVED AUDIT EXCEPTIONS (2026-11-17). An exception names ONE advisory; it applies only while it is
 * unexpired and no longer than 14 days after approval, and only to a finding whose every root advisory it
 * names. Anything else, every other high/critical, an expired or malformed entry, still blocks.
 */
export function activeExceptions(config, now = Date.now()) {
  const active = [];
  for (const e of config?.exceptions || []) {
    const approved = Date.parse(e?.approvedAt || ''), expires = Date.parse(e?.expires || '');
    if (!GHSA.test(String(e?.advisory || '')) || !e.reason || !Number.isFinite(approved) || !Number.isFinite(expires)) {
      throw new Error(`audit exception is malformed: ${JSON.stringify(e).slice(0, 200)}`);
    }
    if (expires - approved > MAX_EXCEPTION_DAYS * DAY) throw new Error(`audit exception ${e.advisory} runs past ${MAX_EXCEPTION_DAYS} days from its approval`);
    if (now < expires) active.push(e);
  }
  return active;
}

/** The root advisories behind one npm-audit finding (its own, and those of the packages it is vulnerable via),
 *  as advisory -> severity. */
function rootAdvisories(vulns, name, seen = new Set()) {
  const out = new Map();
  if (seen.has(name)) return out;
  seen.add(name);
  for (const via of vulns?.[name]?.via || []) {
    if (typeof via === 'string') for (const [a, sev] of rootAdvisories(vulns, via, seen)) out.set(a, sev);
    else out.set(GHSA.exec(String(via?.url || ''))?.[0] || `unidentified:${via?.source ?? via?.title ?? 'advisory'}`, String(via?.severity || 'high'));
  }
  return out;
}

/** High/critical counts after active exceptions; and which findings each exception covered. */
export function effectiveAudit(audit, exceptions) {
  const raw = audit?.metadata?.vulnerabilities || {};
  const vulns = audit?.vulnerabilities || {};
  const excepted = new Set(exceptions.map((e) => e.advisory));
  const counts = { critical: Number(raw.critical), high: Number(raw.high) };
  const covered = new Map(exceptions.map((e) => [e.advisory, []]));
  for (const [name, v] of Object.entries(vulns)) {
    if (!['high', 'critical'].includes(v?.severity)) continue;
    // Only the high/critical roots make a finding high; a moderate advisory riding along does not block here.
    const roots = [...rootAdvisories(vulns, name)].filter(([, sev]) => ['high', 'critical'].includes(sev)).map(([a]) => a);
    if (roots.length && roots.every((a) => excepted.has(a))) {
      counts[v.severity] -= 1;
      for (const a of roots) covered.get(a).push(name);
    }
  }
  return { counts, applied: exceptions.map((e) => ({ advisory: e.advisory, expires: e.expires, approvedBy: e.approvedBy,
    reason: e.reason, covered: covered.get(e.advisory) })).filter((e) => e.covered.length) };
}
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

export function createStabilizationReceipt({ root, artifactPath, qe, audit, exceptions = null, now = Date.now() }) {
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
  const config = exceptions ?? (fs.existsSync(EXCEPTIONS_FILE) ? readJson(EXCEPTIONS_FILE) : { exceptions: [] });
  const audited = effectiveAudit(audit, activeExceptions(config, now));
  const receipt = {
    schemaVersion: 1,
    phase: 'stabilization-candidate',
    mode: 'stabilization',
    reason: `Owner-authorized ${manifest.version} stabilization release; >=95 promotion remains open work`,
    targetScore: 95,
    scoreClaimed: false,
    sha,
    tree: git('rev-parse', 'HEAD^{tree}'),
    // NAME WHAT IS DIRTY, or the failure is unactionable. `release-qe` has failed on EVERY main run
    // with a bare `INVALID_LINEAGE`, which says a clean tree is required and not one word about what
    // made it unclean — so the release chain has been blocked with no way to see why from the log.
    // The receipt now carries the offending paths; the seal is unchanged, only its evidence is.
    dirty: Boolean(git('status', '--porcelain')),
    dirtyPaths: String(git('status', '--porcelain') || '').split('\n').filter(Boolean).slice(0, 40),
    version: manifest.version,
    tag: `v${manifest.version}`,
    sourceVersions: { package: manifest.version, claudePlugin: claude.version, codexPlugin: codex.version },
    artifact: {
      path: `release-evidence/${path.basename(artifactPath)}`,
      sha256: digest,
      sourceSha: sha,
      version: packedVersion(artifactPath),
    },
    // critical/high are what blocks: the audit's counts less only findings an active owner-approved exception
    // fully covers. The raw counts and every applied exception stay on the receipt.
    security: {
      status: audited.counts.critical === 0 && audited.counts.high === 0 ? 'PASS' : 'FAIL',
      critical: audited.counts.critical,
      high: audited.counts.high,
      audited: { critical: Number(vulnerabilities.critical || 0), high: Number(vulnerabilities.high || 0) },
      exceptions: audited.applied,
    },
    qe: { status: total > 0 && failed === 0 && skipped === 0 ? 'PASS' : 'FAIL', total, passed, failed, skipped },
    limitations: [
      'No >=95 score claimed',
      'Strict promotion receipt remains unsatisfied',
      'Clean-host and installed-Brain acceptance are required after publication',
    ],
  };
  const result = evaluateStabilizationCandidateReceipt(receipt);
  if (result.verdict !== 'PASS') {
    const detail = receipt.dirty && receipt.dirtyPaths?.length
      ? `\n  working tree is dirty (${receipt.dirtyPaths.length} path(s)):\n    ${receipt.dirtyPaths.join('\n    ')}`
      : '';
    throw new Error(`stabilization seal failed: ${result.failures.map(({ code }) => code).join(',')}${detail}`);
  }
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

if (isDirectInvocation(import.meta.url)) process.exitCode = main();
