#!/usr/bin/env node
// scripts/corpus-dispatch-decision.mjs — the ONE decision the nightly corpus dispatcher makes.
//
// WHY A MODULE (2026-09-29 nightly redesign). The decision used to live as bash in
// corpus-nightly-dispatch.yml and compared the approved runtime against main HEAD: whenever main
// carried a commit newer than the newest install-verified release -- which under "every main commit
// is a release" is exactly the window between a code release landing and its verification finishing,
// and forever if that verification failed -- the nightly stood down, silently. The corpus is built at
// the APPROVED runtime's own source, so main HEAD is irrelevant to it and is no longer consulted.
//
// decide() is pure and returns one of three verdicts:
//   arm         dispatch protected-release mode=corpus at the approved release's sourceSha
//   stand-down  a correct, quiet non-event (kill switch off, newest release not yet verified, or an
//               approved runtime older than the first release whose pipeline understands this workflow)
//   fail        evidence is present but does not hold -- loud, never a silent skip
//
// minPipelineVersion: the dispatched workflow text is always main's, but the scripts it runs come from
// the approved release's checkout. A runtime older than MIN_PIPELINE_VERSION does not know the flags
// the new workflow passes (--approved-tag, --no-change-out, --stage-candidate, --promote-staged), so the nightly stands down rather than
// let new workflow text drive old scripts.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIN_PIPELINE_VERSION = '4.3.38'; // sync-version-ignore: a fixed pipeline floor, not the current version
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const HEX40 = /^[0-9a-f]{40}$/;
const CODE_TAG = /^v\d+\.\d+\.\d+$/;
// scripts/approved-runtime.mjs names the release it refused: "code release vX.Y.Z (the newest) carries ...".
const REFUSED_NEWEST = /code release (v\d+\.\d+\.\d+) \(the newest\)/;

/** -1 / 0 / 1; throws on anything that is not plain x.y.z. */
export function compareVersions(left, right) {
  const a = SEMVER.exec(String(left || ''));
  const b = SEMVER.exec(String(right || ''));
  if (!a || !b) throw new Error(`cannot compare versions ${JSON.stringify(left)} and ${JSON.stringify(right)}`);
  for (let i = 1; i <= 3; i += 1) {
    const delta = Number(a[i]) - Number(b[i]);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

/** The owner's kill switch: CORPUS_NIGHTLY reading `off` (any case, surrounding space ignored). */
export function killSwitchOff(nightlyVar) {
  return String(nightlyVar ?? '').trim().toLowerCase() === 'off';
}

/**
 * @param nightlyVar   repository variable CORPUS_NIGHTLY (armed unless it reads `off`, any case; the newest
 *                     install-verified code release is the consent — no person approves it)
 * @param resolution   { status: 'resolved', release: {tag, version, sourceSha} }
 *                   | { status: 'not-yet-verified' } | { status: 'invalid', reason }
 */
export function decide({ nightlyVar, resolution, minPipelineVersion = MIN_PIPELINE_VERSION } = {}) {
  if (killSwitchOff(nightlyVar)) {
    return { verdict: 'stand-down', reason: 'repository variable CORPUS_NIGHTLY is off (the owner kill switch)' };
  }
  if (resolution?.status === 'not-yet-verified') {
    return { verdict: 'stand-down', reason: 'the newest code release has not reached install-verified yet (no aggregate)' };
  }
  if (resolution?.status === 'invalid' && CODE_TAG.test(String(resolution.tag || ''))
    && compareVersions(resolution.tag.slice(1), minPipelineVersion) < 0) {
    // VERSION SKEW, not tampering (found 2026-09-29): this checkout's verifier is a newer generation
    // than the newest release's aggregate (e.g. D7's retired-fixture denominator), so it cannot judge
    // it. A runtime below the floor would stand down even if it verified, so standing down loses
    // nothing -- and an aggregate that claims a runtime AT or above the floor still fails loud below.
    return { verdict: 'stand-down', reason: `the newest code release ${resolution.tag} predates ${minPipelineVersion}; `
      + `its install evidence is not judged by this pipeline (${resolution.reason || 'unverifiable here'})` };
  }
  if (resolution?.status !== 'resolved') {
    return { verdict: 'fail', reason: `the newest code release carries install-verification evidence that does not hold: ${resolution?.reason || 'unknown resolution'}` };
  }
  const { tag, version, sourceSha } = resolution.release || {};
  if (!SEMVER.test(String(version || '')) || tag !== `v${version}` || !HEX40.test(String(sourceSha || ''))) {
    return { verdict: 'fail', reason: `resolved release identity is malformed (${JSON.stringify(resolution.release || null)})` };
  }
  if (compareVersions(version, minPipelineVersion) < 0) {
    return { verdict: 'stand-down', reason: `approved runtime ${tag} predates ${minPipelineVersion}, the first release whose pipeline this workflow can drive` };
  }
  return { verdict: 'arm', reason: `building the corpus at approved runtime ${tag} @ ${sourceSha}`, tag, version, sourceSha };
}

/** approved-runtime.mjs --resolve's exit status + stdout (+ stderr, naming a refused release) -> a resolution. */
export function resolutionFrom({ status, stdout, stderr = '' }) {
  if (String(status) === '3') return { status: 'not-yet-verified' };
  if (String(status) !== '0') {
    const tag = REFUSED_NEWEST.exec(String(stderr))?.[1] ?? null;
    const detail = String(stderr).split(': ').slice(-1)[0].trim().slice(0, 300);
    return { status: 'invalid', tag, reason: `approved-runtime.mjs --resolve exited ${status}${detail ? ` (${detail})` : ''}` };
  }
  try {
    const release = JSON.parse(String(stdout || ''));
    return { status: 'resolved', release };
  } catch (error) {
    return { status: 'invalid', reason: `approved-runtime.mjs --resolve printed no release (${error.message})` };
  }
}

const arg = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

/**
 * CLI: --nightly <value> --resolve-status <n|skipped> --release <file> [--resolve-stderr <file>]
 *      --github-output <file>. Exit 1 only on `fail`.
 *      --is-off <value>  prints true|false (lets the workflow skip the ~555 MB resolve when the switch is off)
 */
export function main(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  if (argv.includes('--is-off')) {
    stdout.write(`${killSwitchOff(arg(argv, '--is-off'))}\n`);
    return 0;
  }
  const nightlyVar = arg(argv, '--nightly') ?? '';
  const status = arg(argv, '--resolve-status');
  const releaseFile = arg(argv, '--release');
  const stderrFile = arg(argv, '--resolve-stderr');
  const githubOutput = arg(argv, '--github-output');
  const resolution = status === 'skipped' ? null
    : resolutionFrom({ status,
      stdout: releaseFile && fs.existsSync(releaseFile) ? fs.readFileSync(releaseFile, 'utf8') : '',
      stderr: stderrFile && fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '' });
  const decision = decide({ nightlyVar, resolution });
  const lines = decision.verdict === 'arm'
    ? ['armed=true', `approved_sha=${decision.sourceSha}`, `approved_version=${decision.version}`, `approved_tag=${decision.tag}`]
    : ['armed=false'];
  lines.push(`verdict=${decision.verdict}`);
  if (githubOutput) fs.appendFileSync(path.resolve(githubOutput), `${lines.join('\n')}\n`);
  const annotation = decision.verdict === 'fail' ? '::error::' : '::notice::';
  stdout.write(`${annotation}corpus-nightly-dispatch ${decision.verdict}: ${decision.reason}\n`);
  return decision.verdict === 'fail' ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
