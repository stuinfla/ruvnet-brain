#!/usr/bin/env node
// scripts/release.mjs — the DEFINITION OF DONE. The only path to the word "shipped."
//
// WHY (2026-07-17, Stuart): "You should be able to take the applied knowledge and build it into a set
// of criteria that you always use, not a bunch of suggestions you choose to ignore." Every failure
// this session was an ASSUMPTION that survived because the check was a suggestion, not a gate. This
// script turns the checklist into a gate: it runs the criteria in order, STOPS on the first failure,
// and only prints "SHIPPED" when every channel a user touches is proven current and working. There is
// no "I think it's fine" — there is pass or fail.
//
// It is idempotent and safe to re-run. Each step verifies the REAL artifact (registry, live URL, the
// actual command), never the repo state. Repo state != user experience (the whole lesson).
//
// Usage:
//   node scripts/release.mjs --check          # run every gate READ-ONLY (no publish) — the pre-flight
//   node scripts/release.mjs --publish        # sync version, npm publish, then run every gate
//   node scripts/release.mjs                   # same as --check
//
// The gates, in order (fail fast):
//   A. version single-source-of-truth agrees (sync-version --check)
//   B. full test suite green (npm test — the 60/60)
//   C. narrative + unit gates (vitest) incl. the tag/entity-aware "What's new" check
//   C+. [--publish only] push to origin/main — ONLY now that A–C are green (a red tree can't reach GitHub)
//   D. [--publish only] build + sign bundle, create/update the exact-SHA GitHub Release,
//      then npm publish + force `latest` to the shipping version
//   E. verify-channels — the LIVE walk of npm / self-update manifest / release bundle+sig / explainer / git

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateProtectedPublishInvocation } from './protected-release-invocation.mjs';
import { runReleaseTransaction } from './release-transaction.mjs';
import { liveReleaseProvider } from './release-transaction-provider.mjs';
import { stagedHostVerifier } from './staged-host-verifier.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLISH = process.argv.includes('--publish');
let protectedCandidate = null;
let sealedPackageArtifact = null;
let publicationReceiptPath = null;
let protectedReleaseMode = 'strict';
const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };
const V = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')).version;

function step(n, label) { process.stdout.write(`\n${c.b('▸ ' + n)} ${label}\n`); }
function runOrDie(label, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.error || r.status !== 0) {
    console.error(`\n${c.r('✗ GATE FAILED: ' + label)} ${c.dim('(' + cmd + ' ' + args.join(' ') + ' → ' + (r.error ? r.error.message : 'exit ' + r.status) + ')')}`);
    console.error(`${c.r('  NOT shipped. Fix this, then re-run. No assumptions past a red gate.')}\n`);
    process.exit(1);
  }
}

console.log(`\n${c.b('RuvNet Brain — release / definition-of-done')} ${c.dim('· ' + (PUBLISH ? 'PUBLISH' : 'check-only') + ' · shipping ' + V())}\n`);

// The local CLI remains useful as a read-only preflight, but publication authority lives only in
// the reviewer-protected workflow. Validate the exact candidate receipt and artifact bytes before
// any command capable of pushing, tagging, releasing, or publishing can run.
if (PUBLISH) {
  const protectedInvocation = validateProtectedPublishInvocation({ root: ROOT });
  if (protectedInvocation.verdict !== 'PASS') {
    console.error(`\n${c.r('✗ PROTECTED RELEASE GATE FAILED')}`);
    for (const failure of protectedInvocation.failures) console.error(`  ${failure}`);
    console.error(`${c.r('  NOT shipped. Run the protected-release workflow with exact candidate evidence.')}\n`);
    process.exit(1);
  }
  protectedReleaseMode = protectedInvocation.mode;
  protectedCandidate = JSON.parse(fs.readFileSync(path.resolve(ROOT, process.env.RUVNET_CANDIDATE_RECEIPT), 'utf8'));
  sealedPackageArtifact = path.resolve(ROOT, protectedCandidate.artifact.path);
  publicationReceiptPath = path.resolve(ROOT, process.env.RUVNET_PUBLICATION_RECEIPT || '.missing-publication-receipt');
  const evidenceRoot = path.join(ROOT, 'release-evidence');
  if (!publicationReceiptPath.startsWith(`${evidenceRoot}${path.sep}`) || fs.existsSync(publicationReceiptPath)) {
    console.error(`\n${c.r('✗ PROTECTED RELEASE GATE FAILED')}\n  publication receipt output must be a new file inside release-evidence\n`);
    process.exit(1);
  }
}

// A verdict is only about the exact committed candidate. Check-only used to permit a dirty tree
// while publish checked cleanliness much later, so preflight could certify bytes that would never
// ship. Both modes now bind to the same committed tree before any expensive gate runs.
const initialDirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
if (initialDirty) {
  console.error(`\n${c.r('✗ GATE FAILED: working tree not clean')} ${c.dim('— preflight and publish both certify committed bytes only.')}`);
  console.error(initialDirty.split('\n').slice(0, 10).map((l) => '    ' + l).join('\n'));
  process.exit(1);
}

// A. version single source of truth
step('A', 'version single-source-of-truth agrees across every surface');
runOrDie('version sync', process.execPath, ['scripts/sync-version.mjs', '--check']);
runOrDie('one protected publisher', process.execPath, ['scripts/release-authority.mjs']);

// WIRED-CHECK — refuses to ship a module with zero callers.
//
// Added 2026-07-22 after this project shipped built-tested-unwired code SEVEN times in one session
// (capability-registry, capability-audit, lesson-gate's five triggers, anticipate.sh,
// advocacy-outcomes, lesson-promote's demotion, continuation-gate's global path). Every one had
// passing tests, because a test imports the module directly — the one caller that proves nothing
// about whether the product uses it. Every one was found by a human running grep, hours later.
//
// Seven repetitions of one mistake is not a discipline problem; discipline is what failed. So it
// becomes a gate, on the ship path, where this repo's gates run 8/8 against prose's 0/6.
runOrDie('wired (no orphan modules)', process.execPath, ['scripts/wired-check.mjs', '--check']);

// THE NORTH-STAR PROMOTION VECTOR — strict/check-only releases may not average one broken or
// unknown invariant into a pass. The separately authorized stabilization class makes no 95 claim;
// it retains every safety, test, artifact, publication, and post-publication gate below while the
// promotion program remains open. Derive this only from the already-validated sealed receipt, never
// from a free-standing environment toggle.
if (protectedReleaseMode === 'strict') {
  runOrDie('release vector (all critical invariants PASS)', process.execPath, ['scripts/release-vector.mjs']);

  // The Top-100 corpus spans naive through expert prompts and grades semantic clauses, citations,
  // abstention, and latency. A manual-only benchmark is a report; a strict release-path benchmark
  // is a guarantee. The benchmark itself fails closed unless all 100 canonical questions run.
  runOrDie('Top-100 source-grounded recall contract', process.execPath, ['scripts/top100-benchmark.mjs', '--no-write']);
} else {
  console.log(c.y('  strict >=95 promotion gates: NOT CLAIMED (sealed stabilization; scoreClaimed:false)'));
}

// A2. Stable Spine restart classifier (ADR-023, red-team finding 18): diff the boot-frozen SHELL
// (hooks.json, hook-shim, MCP server, .mcp.json, skills/, commands/) against the previous release
// tag and SAY OUT LOUD whether this release needs a restart. The classification is computed, never
// remembered — the same shellDiff logic runs client-side in update-apply.mjs at every flip, so the
// user-facing nag stays honest even if this print is ignored. Informational at ship time; the
// releasing human sees exactly which shell files changed.
step('A2', 'Stable Spine — does this release change the boot-frozen shell? (requiresRestart classifier)');
{
  const { execFileSync } = await import('node:child_process');
  const SHELL = ['plugin/hooks/hooks.json', 'plugin/scripts/hook-shim.mjs', 'plugin/mcp/server.mjs', 'plugin/.mcp.json', 'plugin/skills', 'plugin/commands'];
  let prevTag = '';
  try { prevTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8' }).trim(); } catch { /* no tags yet */ }
  if (!prevTag) {
    console.log(c.dim('  no previous release tag — classifier has no baseline (first spine release: requiresRestart=true by definition)'));
  } else {
    let changed = [];
    try {
      const out = execFileSync('git', ['diff', '--name-only', `${prevTag}..HEAD`, '--', ...SHELL], { encoding: 'utf8' }).trim();
      changed = out ? out.split('\n') : [];
    } catch { /* diff failure = unknown; say so, never guess green */ changed = ['(diff failed — treat as changed)']; }
    if (changed.length) {
      console.log(`  ${c.y('requiresRestart: TRUE')} — shell changed vs ${prevTag}:`);
      for (const f of changed) console.log(`    · ${f}`);
      console.log(c.dim('  users get ONE honest restart notice (session-start reads active.json.shellChanged); everything else is live.'));
    } else {
      console.log(`  ${c.g('requiresRestart: false')} — no shell change vs ${prevTag}; this release goes fully live with zero restarts.`);
    }
  }
}

// B. the full brain test suite (the 60/60)
step('B', 'full test suite (npm test)');
runOrDie('npm test', 'npm', ['test']);

// C. unit gates — narrative-version (tag/entity aware), claims, etc.
step('C', 'unit gates (vitest) — narrative version, claims, guards');
runOrDie('vitest unit', 'npx', ['vitest', 'run', 'tests/unit']);

// C+. PUSH — only now that A–C are green (publish only). Pushing AFTER the local gates is the fix
// for the drift that bit on 2026-07-18: a commit was pushed FIRST, then release.mjs's gate B caught a
// failing plugin-battery test, leaving GitHub at 3.4.10-dev while npm sat at 3.4.9-dev — the exact
// "pushed but didn't finish" split. The pre-push git hook only checks version/manifest (fast, always),
// so tests must gate the push HERE. A red tree can no longer reach origin ahead of npm.
if (PUBLISH) {
  // C++. REMOTE CI IS A SHIP GATE (ADR-053 §5). Between 2026-07-21 and 07-26 the `ci` workflow was
  // red for ~70 consecutive runs — six releases shipped right past it, because nothing on the ship
  // path ever ASKED the remote verdict. Local gates prove this machine; only CI proves ubuntu and
  // windows. So the latest COMPLETED run on origin/main must be green before we add commits on top
  // and publish. (The current commit's own run starts after the push — this gate is "never build on
  // a known-broken main", not "wait for my own run".) Escape hatch for a genuine hotfix:
  // --ci-override "<reason>" — printed into the release log, never silent.
  step('C++', 'remote CI on origin/main is green (the ubuntu+windows verdict this machine cannot produce)');
  {
    const { fetchLatestCiVerdict, assessCiGate } = await import('./ci-verdict.mjs');
    const OVERRIDE_IX = process.argv.indexOf('--ci-override');
    const overrideReason = OVERRIDE_IX >= 0 ? (process.argv[OVERRIDE_IX + 1] || '(no reason given)') : null;
    const { verdict, sha } = await fetchLatestCiVerdict();
    const gate = assessCiGate(verdict, overrideReason);
    if (gate === 'ship') {
      console.log(c.dim(`  latest completed ci run on origin/main: success (${sha})`));
    } else if (gate === 'override') {
      console.log(`  ${c.y('! CI gate OVERRIDDEN')} — verdict was ${verdict ?? 'unknown'} (${sha || 'no run found'}); reason: ${overrideReason}`);
    } else {
      console.error(`\n${c.r('✗ GATE FAILED: remote CI on origin/main is ' + (verdict ?? 'unknown'))} ${c.dim('(' + (sha || 'no completed run found') + ')')}`);
      console.error(`${c.r('  A red or unknown main does not get shipped on top of. Fix CI first (gh run list --workflow ci.yml),')}`);
      console.error(`${c.r('  or for a genuine hotfix: --ci-override "<reason>" (the reason is printed into the release log).')}\n`);
      process.exit(1);
    }
  }

  step('C+', 'push to origin/main — safe now that A–C passed');
  let ahead = '0';
  try { ahead = execFileSync('git', ['-C', ROOT, 'rev-list', '--count', 'origin/main..HEAD'], { encoding: 'utf8' }).trim(); } catch { /* origin/main ref missing — push will resolve */ ahead = '?'; }
  if (ahead === '0') console.log(c.dim('  nothing to push — HEAD already on origin/main'));
  else runOrDie('git push', 'git', ['-C', ROOT, 'push', 'origin', 'main']);
}

// D. One remotely durable, staged release transaction (ADR-062 / DDD-0015). GitHub remains a draft
// and npm remains on a non-default candidate tag until exact bytes and all host fixtures pass.
if (PUBLISH) {
  const v = V();
  const tag = `v${v}`;
  const zip = path.join(ROOT, 'dist', 'ruvnet-brain.zip');
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const buildArgs = ['scripts/build-bundle.mjs', '--version', tag];
  if (process.env.RUVNET_RELEASE_ASSETS) buildArgs.push('--assets', process.env.RUVNET_RELEASE_ASSETS);
  step('D', 'prepare, stage, promote, and reconcile one signed remote transaction');
  runOrDie('build release bundle', process.execPath, buildArgs);
  runOrDie('sign release bundle', process.execPath, ['scripts/sign-bundle.mjs', '--bundle', zip]);
  const assets = {
    bundlePath: zip,
    bundleSignaturePath: `${zip}.sig`,
    bundleDigestPath: `${zip}.sha256`,
    packagePath: sealedPackageArtifact,
  };
  for (const asset of Object.values(assets)) {
    if (!fs.existsSync(asset)) {
      console.error(`\n${c.r('✗ GATE FAILED: signed release asset missing')} ${c.dim(asset)}`);
      process.exit(1);
    }
  }
  const bundleSha256 = fs.readFileSync(`${zip}.sha256`, 'utf8').trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(bundleSha256)) {
    console.error(`\n${c.r('✗ GATE FAILED: release digest is not a SHA-256 value')}`);
    process.exit(1);
  }

  const packageIntegrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(sealedPackageArtifact)).digest('base64')}`;
  const identity = {
    repository: 'stuinfla/ruvnet-brain', package: 'ruvnet-brain', version: v, tag,
    candidateSha: head, packageIntegrity, bundleSha256,
  };
  const privatePem = process.env.RUVNET_SIGNING_KEY;
  if (!privatePem) throw new Error('RUVNET_SIGNING_KEY is required for signed transaction receipts');
  const finalReceipt = await runReleaseTransaction({
    identity, assets, adapter: liveReleaseProvider({
      root: ROOT,
      candidateReceipt: process.env.RUVNET_CANDIDATE_RECEIPT,
      publicationReceipt: process.env.RUVNET_PUBLICATION_RECEIPT,
    }),
    privateKey: crypto.createPrivateKey(privatePem),
    publicKey: crypto.createPublicKey(fs.readFileSync(path.join(ROOT, 'keys/ruvnet-brain-signing.pub.pem'), 'utf8')),
    hostVerifier: stagedHostVerifier({ assets, identity }),
  });
  if (finalReceipt.state !== 'channels-converged') throw new Error(`release transaction stopped at ${finalReceipt.state}`);
} else {
  step('D', 'remote staged release transaction — SKIPPED (check-only; pass --publish to publish)');
}

// D+. THE DEPLOY-SURFACE SWEEP (owner standing order, 2026-07-27): "ALWAYS check GitHub CLI and
// Vercel CLI for gotchas with anything you're pushing. This needs to be part of the protocol you use
// whenever you deploy. I don't want to have to tell you this again."
//
// Gate C++ already asks whether CI passed. That is one surface. This asks the two CLIs what the
// PLATFORMS think — failing workflows other than our own ci, security advisories, and whether the
// production deployment that serves the explainer is actually Ready. Each is a question a human
// would otherwise have to remember to ask, which is the definition of a check that eventually
// doesn't happen.
//
// ADVISORY BY DESIGN, LOUD BY CONTRACT: this prints findings and does not exit non-zero, because a
// GitHub-side hiccup must not wedge a correct release — EXCEPT where it overlaps a hard gate that
// already exists (C++ for ci, E for the live explainer). Anything it finds is printed in full so it
// cannot be a diagnostic nobody reads.
step('D+', 'deploy-surface sweep — what GitHub and Vercel think about what we are pushing');
{
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 45000 }); } catch { return null; } };

  // 1. Failing workflow runs that are NOT our ci (ci is gate C++'s job). issue-watch exits 1 BY
  //    DESIGN on an SLA breach, so it is reported as an SLA signal, never as a broken pipeline —
  //    conflating the two is how a permanently-red workflow trains everyone to ignore red.
  const runs = sh('gh', ['run','list','--repo','stuinfla/ruvnet-brain','--limit','15','--json','name,conclusion,headBranch']);
  if (runs) {
    let bad = [];
    try { bad = JSON.parse(runs).filter((r) => r.conclusion && r.conclusion !== 'success' && r.name !== 'ci'); } catch { /* unparseable — reported below */ }
    const sla = bad.filter((r) => r.name === 'issue-watch');
    const real = bad.filter((r) => r.name !== 'issue-watch');
    if (sla.length) console.log(`  ${c.y('! issue-watch red x' + sla.length)} ${c.dim('— by design: an open issue is past its 4h SLA. Answer the issue, do not fix the workflow.')}`);
    if (real.length) console.log(`  ${c.y('! non-ci workflows failing:')} ${real.map((r) => r.name).join(', ')}`);
    if (!sla.length && !real.length) console.log(c.dim('  no failing workflows outside ci'));
  } else console.log(c.dim('  gh unavailable — workflow sweep SKIPPED (not a pass)'));

  // 2. Security advisories against what we ship.
  const dep = sh('gh', ['api','repos/stuinfla/ruvnet-brain/dependabot/alerts','--jq','[.[]|select(.state=="open")]|length']);
  if (dep !== null) {
    const n = parseInt(dep.trim(), 10);
    console.log(n > 0 ? `  ${c.r('! ' + n + ' open dependabot alert(s)')}` : c.dim('  0 open dependabot alerts'));
  } else console.log(c.dim('  dependabot query unavailable — SKIPPED (not a pass)'));

  // 3. Vercel: the explainer is a shipped surface; a Ready production deployment is the precondition
  //    for gate E's live check meaning anything.
  const vc = sh('vercel', ['ls','--yes']);
  if (vc) {
    const prod = vc.split('\n').find((l) => l.includes('Production'));
    const ready = prod && /●\s*Ready/.test(prod);
    console.log(ready ? c.dim('  vercel: latest production deployment Ready') : `  ${c.y('! vercel: latest production deployment is NOT Ready')} ${c.dim((prod||'').trim().slice(0,90))}`);
  } else console.log(c.dim('  vercel CLI unavailable/not logged in — SKIPPED (not a pass)'));
}

// E. the live channel walk — THE gate that would have caught the stale-2.9.1 + 404
step('E', 'verify-channels — the live walk of every user path');
runOrDie('verify-channels', process.execPath, ['scripts/verify-channels.mjs']);

if (PUBLISH) {
  console.log(`\n${c.g(c.b('✓✓✓ SHIPPED'))} — every gate passed and every live channel is current. ${c.dim('A user on any path (npm, npx, explainer, --update) gets the working, current build.')}\n`);
} else {
  console.log(`\n${c.g(c.b('✓✓✓ PREFLIGHT PASS — NOT PUBLISHED'))} — the committed candidate passed every check-only gate.\n`);
}
