// Release path for the unattended issue autofix (ADR-107, batch A3): S6 release branch, census stamp,
// the mechanical ADR-0103 review row, local gates, and (in issue-autofix-release-ship.mjs) S7-S12.
// Follows CONTRIBUTING.md "Releasing code (step by step)". Every external command goes through ctx.exec.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AutofixAbort, nextPatchVersion, judgeGovernedVersionOnly } from './issue-autofix-policy.mjs';
import { evaluateDoc } from '../plugin/scripts/doc-currency.mjs';
import { GOVERNING_ADR, evaluateArchitectureReview } from './architecture-review-lock.mjs';
import {
  MIN, VERSION_RE, SHA_RE, tail, run, must, git, mustGit, mustGitAs, gitAs, ghJson, ghBin, assertCleanText,
  assertVersion, assertIssue, worktreesDir, holdFilePath, nextCorpusDispatch, parseUnifiedDiff,
  queryNpmLatest, queryReleasesLatest, resolveRuntime,
} from './issue-autofix-release-util.mjs';

export { shipRelease, verifyTerminal } from './issue-autofix-release-ship.mjs';
export { parseUnifiedDiff } from './issue-autofix-release-util.mjs';

// release:prepush (CONTRIBUTING "before the first push", 4.7.23) runs first: it catches a stale census against the
// newest corpus generation, a stale ADR-0103 digest, stray artifacts and anchored text tests in seconds.
export const LOCAL_GATES = Object.freeze([
  ['release-prepush', 'npm', ['run', 'release:prepush', '--', '--receipt', '<RUN>/prepush-<TS>.json']],
  ['release-qualify-source', 'npm', ['run', 'release:qualify', '--', '--suite', 'source', '--report', '<RUN>/source-<TS>.json']],
  ['release-qualify-integration', 'npm', ['run', 'release:qualify', '--', '--suite', 'integration', '--report', '<RUN>/integration-<TS>.json']],
  ['npm-test', 'npm', ['test']],
  ['single-source', 'npm', ['run', 'single-source:check']],
  ['release-syntax', 'node', ['--check', 'scripts/release.mjs']],
  ['version-check', 'npm', ['run', 'version:check']],
  ['release-authority', 'npm', ['run', 'release:authority']],
  ['architecture-review-lock', 'node', ['scripts/architecture-review-lock.mjs']],
  ['doc-currency', 'npm', ['run', 'doc:currency']],
]);
const GATED_WORKFLOWS = ['protected-release.yml', 'release-candidate-preflight.yml', 'corpus-nightly-dispatch.yml'];
const GATE_TIMEOUT_MS = { 'release-qualify-integration': 120 * MIN, 'release-qualify-source': 60 * MIN, 'npm-test': 60 * MIN };
const MANIFEST = 'plugin/.claude-plugin/plugin.json';

async function mainVersion(ctx, stage) {
  const r = await mustGit(ctx, stage, 'main-moved', ctx.clone, ['show', `origin/main:${MANIFEST}`]);
  try { return JSON.parse(r.stdout).version; } catch { throw new AutofixAbort(stage, 'main-moved', 'origin/main manifest unreadable'); }
}

export async function gatherWindowFacts(ctx) {
  const facts = { openReleaseBlockers: [], activeRuns: [], remoteReleaseBranches: [], openReleasePrs: [], holdFile: false,
    mainVersion: '', mainSha: '', npmLatest: null, releasesLatestTag: null, mainVersionInstallVerified: false,
    nextCorpusDispatchAt: nextCorpusDispatch(ctx.now()) };
  const issues = await ghJson(ctx, ['issue', 'list', '--repo', ctx.repo, '--state', 'open', '--label', 'release-blocker', '--json', 'number', '--limit', '100']);
  if (!issues.ok) throw new AutofixAbort('S0', 'window-closed', 'cannot list release-blocker issues');
  facts.openReleaseBlockers = issues.value.map((i) => i.number);
  for (const wf of GATED_WORKFLOWS) {
    for (const status of ['queued', 'in_progress']) {
      const j = await ghJson(ctx, ['run', 'list', '--repo', ctx.repo, '--workflow', wf, '--status', status, '--json', 'databaseId,status', '--limit', '20']);
      if (!j.ok) throw new AutofixAbort('S0', 'window-closed', `cannot list ${status} runs of ${wf}`);
      for (const x of j.value) facts.activeRuns.push({ workflow: wf, status: x.status || status, id: x.databaseId });
    }
  }
  await mustGit(ctx, 'S0', 'window-closed', ctx.clone, ['fetch', 'origin', 'main']);
  const heads = await mustGit(ctx, 'S0', 'window-closed', ctx.clone, ['ls-remote', '--heads', 'origin', 'refs/heads/release/*']);
  for (const line of heads.stdout.split('\n').filter(Boolean)) {
    const name = line.split(/\s+/)[1]?.replace(/^refs\/heads\//, '') || '';
    // release/4.5.15-stop is a 4.5.15 work branch: its leading version decides whether it is ahead of main.
    const m = name.replace(/^release\//, '').match(/^(\d+\.\d+\.\d+)(?:[-_.+][\w.-]*)?$/);
    facts.remoteReleaseBranches.push({ name, version: m ? m[1] : '' });
  }
  const prs = await ghJson(ctx, ['pr', 'list', '--repo', ctx.repo, '--state', 'open', '--json', 'number,headRefName', '--limit', '100']);
  if (!prs.ok) throw new AutofixAbort('S0', 'window-closed', 'cannot list open pull requests');
  const releasePrs = prs.value.filter((p) => String(p.headRefName).startsWith('release/'));
  facts.openReleasePrs = releasePrs.map((p) => p.number);
  facts.openReleasePrHeads = Object.fromEntries(releasePrs.map((p) => [p.number, p.headRefName]));
  facts.holdFile = fs.existsSync(holdFilePath(ctx));
  facts.mainVersion = await mainVersion(ctx, 'S0');
  facts.mainSha = (await mustGit(ctx, 'S0', 'window-closed', ctx.clone, ['rev-parse', 'origin/main'])).stdout.trim();
  facts.npmLatest = await queryNpmLatest(ctx);
  facts.releasesLatestTag = await queryReleasesLatest(ctx);
  facts.mainVersionInstallVerified = await resolveRuntime(ctx, facts.mainVersion, path.join(ctx.runDir || '.', `window-runtime-${facts.mainVersion}.json`));
  return facts;
}

// The message names only the issue number: a stranger's title never enters git history (no @mentions, links or
// injection text in commits that ship), and no closing keyword can auto-close anything.
export async function commitFix(ctx, { wt, issueNumber }) {
  assertIssue('S6', issueNumber);
  const subject = `autofix: issue ${issueNumber}`;
  const body = `Refs issue ${issueNumber} (ADR-107 autofix).`;
  assertCleanText('S6', `${subject}\n${body}`);
  await mustGit(ctx, 'S6', 'diff-policy', wt, ['add', '-A']);
  const staged = await git(ctx, wt, ['diff', '--cached', '--quiet']);
  if (staged.status === 0) throw new AutofixAbort('S6', 'diff-policy', 'nothing to commit in the fix worktree');
  await mustGitAs(ctx, 'S6', 'diff-policy', wt, ['commit', '-m', subject, '-m', body]);
  const fixSha = (await mustGit(ctx, 'S6', 'diff-policy', wt, ['rev-parse', 'HEAD'])).stdout.trim();
  return { fixSha };
}

/**
 * S6: one release branch for the night. Version commit first, then every ready fix cherry-picked in issue order; a fix
 * that does not apply cleanly on top of the others is dropped (and reported), never hand-merged. Returns the version
 * commit (fixBase) and the last fix commit (fixHead) so the batch gate can scan exactly the model-written code.
 */
export async function prepareReleaseBranch(ctx, { version, fixes }) {
  assertVersion('S6', version);
  if (!Array.isArray(fixes) || !fixes.length) throw new AutofixAbort('S6', 'diff-policy', 'no fixes to release');
  for (const f of fixes) {
    assertIssue('S6', f.issueNumber);
    if (!SHA_RE.test(String(f.fixSha))) throw new AutofixAbort('S6', 'diff-policy', `not a commit sha: ${f.fixSha}`);
  }
  const branch = `release/${version}`;
  await mustGit(ctx, 'S6', 'main-moved', ctx.clone, ['fetch', 'origin', 'main']);
  const current = await mainVersion(ctx, 'S6');
  if (nextPatchVersion(current) !== version) {
    throw new AutofixAbort('S6', 'main-moved', `origin/main is ${current}; the next patch is ${nextPatchVersion(current)}, not ${version}`);
  }
  const remote = await git(ctx, ctx.clone, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (remote.status !== 0) throw new AutofixAbort('S6', 'branch-exists', `cannot tell whether ${branch} exists on the remote`);
  if (remote.stdout.trim()) throw new AutofixAbort('S6', 'branch-exists', `${branch} already exists on the remote`);
  const local = await git(ctx, ctx.clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (local.status === 0) throw new AutofixAbort('S6', 'branch-exists', `${branch} already exists locally`);

  const rwt = path.join(worktreesDir(ctx), `release-${version}`);
  fs.mkdirSync(path.dirname(rwt), { recursive: true });
  await mustGit(ctx, 'S6', 'branch-exists', ctx.clone, ['worktree', 'add', '-b', branch, rwt, 'origin/main']);
  await must(ctx, 'S6', 'gate-failed', 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: rwt });
  await must(ctx, 'S6', 'gate-failed', 'npm', ['run', 'version:set', '--', version], { cwd: rwt });
  await must(ctx, 'S6', 'gate-failed', 'npm', ['run', 'convergence:write'], { cwd: rwt });
  const issues = fixes.map((f) => f.issueNumber);
  const msg = `chore(release): ${version} (autofix, issues ${issues.join(', ')})`;
  assertCleanText('S6', msg);
  await mustGit(ctx, 'S6', 'gate-failed', rwt, ['add', '-A']);
  await mustGitAs(ctx, 'S6', 'gate-failed', rwt, ['commit', '-m', msg]);
  const fixBase = (await mustGit(ctx, 'S6', 'gate-failed', rwt, ['rev-parse', 'HEAD'])).stdout.trim();
  const applied = []; const dropped = [];
  for (const f of fixes) {
    const pick = await gitAs(ctx, rwt, ['cherry-pick', f.fixSha]);
    if (pick.status === 0) { applied.push(f.issueNumber); continue; }
    await git(ctx, rwt, ['cherry-pick', '--abort']);
    dropped.push({ issueNumber: f.issueNumber, reason: `does not apply on top of the other fixes: ${tail(pick.stderr, 200)}` });
  }
  if (!applied.length) throw new AutofixAbort('S6', 'gate-failed', 'no fix applied cleanly to the release branch');
  const fixHead = (await mustGit(ctx, 'S6', 'gate-failed', rwt, ['rev-parse', 'HEAD'])).stdout.trim();
  const log = await mustGit(ctx, 'S6', 'gate-failed', rwt, ['rev-list', '--reverse', 'origin/main..HEAD']);
  return { branch, rwt, fixBase, fixHead, applied, dropped, commits: log.stdout.split('\n').filter(Boolean) };
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function findAssetDirs(root) {
  const dirs = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '__MACOSX') walk(p); }
      else if (e.name.endsWith('.big.rvf') && !e.name.startsWith('._')) dirs.add(d);
    }
  };
  walk(root);
  return [...dirs];
}

/** Census stamp, assembled exactly as ci.yml release-qe does (CONTRIBUTING rule 1). */
export async function stampCensus(ctx, { rwt }) {
  const work = path.join(ctx.runDir || path.dirname(rwt), `census-${ctx.now()}`);
  const evidence = path.join(work, 'release-evidence');
  const seedDir = path.join(work, 'release-seed');
  const extracted = path.join(seedDir, 'extracted');
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(extracted, { recursive: true });
  const descriptor = path.join(evidence, 'corpus-seed.json');
  const opts = { cwd: rwt, timeoutMs: 30 * MIN };
  await must(ctx, 'S6', 'gate-failed', 'node', ['scripts/corpus-next-seed.mjs', '--repo', ctx.repo, '--require-coverage', '--out', descriptor], opts);
  const d = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  const patterns = ['--pattern', d.asset];
  const cov = d.origin === 'published-generation';
  if (cov) patterns.push('--pattern', 'CORPUS-COVERAGE.json', '--pattern', 'coverage-receipt.json', '--pattern', `${d.asset}.recall.json`);
  await must(ctx, 'S6', 'gate-failed', ghBin(ctx), ['release', 'download', d.tag, '--repo', ctx.repo, ...patterns, '--dir', seedDir], opts);
  const seed = path.join(seedDir, d.asset);
  if (sha256File(seed) !== d.sha256 || fs.statSync(seed).size !== Number(d.bytes)) {
    throw new AutofixAbort('S6', 'gate-failed', 'the downloaded corpus seed does not match its descriptor');
  }
  await must(ctx, 'S6', 'gate-failed', 'unzip', ['-q', seed, '-d', extracted], opts);
  const assetDirs = findAssetDirs(extracted);
  if (assetDirs.length !== 1) throw new AutofixAbort('S6', 'gate-failed', `expected one asset directory in the seed, found ${assetDirs.length}`);
  const covArgs = cov ? ['--coverage', path.join(seedDir, 'CORPUS-COVERAGE.json'), '--coverage-receipt', path.join(seedDir, 'coverage-receipt.json')] : [];
  await must(ctx, 'S6', 'gate-failed', 'node', ['scripts/code-release-corpus.mjs', 'assemble', '--descriptor', descriptor, '--seed-bundle', seed,
    '--assets', assetDirs[0], '--evidence-dir', evidence, ...covArgs], opts);
  await must(ctx, 'S6', 'gate-failed', 'node', ['scripts/sync-census.mjs'],
    { ...opts, env: { ...process.env, RUVNET_BRAIN_KB: path.join(rwt, 'dist', 'ruvnet-brain') } });
  const changed = (await mustGit(ctx, 'S6', 'gate-failed', rwt, ['diff', '--name-only'])).stdout.split('\n').filter(Boolean);
  if (!changed.length) return { changed: false, files: [] };
  const version = JSON.parse(fs.readFileSync(path.join(rwt, MANIFEST), 'utf8')).version;
  await mustGit(ctx, 'S6', 'gate-failed', rwt, ['add', '--', ...changed]);
  await mustGitAs(ctx, 'S6', 'gate-failed', rwt, ['commit', '-m', `chore(release): stamp the census for ${version} (autofix)`]);
  return { changed: true, files: changed };
}

function writeReview(rwt, { digest, version, issues, date, contractTouched, anchor }) {
  const file = path.join(rwt, GOVERNING_ADR);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const fmEnd = lines.indexOf('---', 1);
  const fi = lines.findIndex((l, i) => i > 0 && i < fmEnd && l.startsWith('reviewed_digest:'));
  if (fi >= 0) lines[fi] = `reviewed_digest: ${digest}`;
  else lines.splice(fmEnd, 0, `reviewed_digest: ${digest}`);
  const ui = lines.findIndex((l, i) => i > 0 && i < fmEnd + 1 && l.startsWith('updated:'));
  if (ui >= 0) lines[ui] = `updated: ${date}`;
  const extra = contractTouched ? ' and append-only inventory lines in `scripts/release-qualification-contract.mjs`' : '';
  const row = `| ${date} | Review \`${digest}\` (${version}, autofix issues ${issues.join(', ')}, mechanical): the only governed bytes that moved since origin/main are the version fields of \`package.json\` and \`package-lock.json\`${extra}, proven by a diff of origin/main against this branch before the row was written; no routing behavior is added. | Written by scripts/issue-autofix-release.mjs under ADR-107 (the digest covers the governed path \`${anchor}\`); a mechanical stamp, not a person reading the code. |`;
  const h = lines.findIndex((l) => /^##\s+currency log\b/i.test(l));
  if (h < 0) throw new AutofixAbort('S6', 'governed-change-not-mechanical', 'ADR-0103 has no Currency log section');
  let at = lines.findIndex((l, i) => i > h && /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l));
  if (at < 0) at = h + 1;
  lines.splice(at, 0, row);
  fs.writeFileSync(file, lines.join('\n'));
}

/** Mechanical ADR-0103 review row; refuses (governed-change-not-mechanical) unless the governed diff is version lines only. */
export async function stamp0103Review(ctx, { rwt, version, issues, date }) {
  if (!Array.isArray(issues) || !issues.length) throw new AutofixAbort('S6', 'governed-change-not-mechanical', 'no issues named');
  for (const n of issues) assertIssue('S6', n);
  const evaluate = ctx.evaluateDoc || evaluateDoc;
  const doc = evaluate(rwt, GOVERNING_ADR, { checkWiring: false });
  const governed = new Set((doc.governed || []).filter((g) => g.resolved).map((g) => g.path));
  const diff = await mustGit(ctx, 'S6', 'governed-change-not-mechanical', rwt, ['diff', '-U0', '--no-color', '--no-ext-diff', 'origin/main', 'HEAD']);
  const touched = parseUnifiedDiff(diff.stdout).filter((f) => governed.has(f.path));
  const verdict = judgeGovernedVersionOnly(touched);
  if (!verdict.mechanical) {
    throw new AutofixAbort('S6', 'governed-change-not-mechanical', verdict.reason || 'governed bytes changed beyond version lines');
  }
  if (doc.review?.current === true) return { digest: doc.review.computed, rowAdded: false };
  const digest = doc.review?.computed;
  if (!digest) throw new AutofixAbort('S6', 'governed-change-not-mechanical', 'no review digest can be computed for ADR-0103');
  // doc-currency only counts a path referent that has a directory part, so anchor the row on a governed path that does.
  const anchor = ['scripts/release-qualification-contract.mjs', ...governed].find((p) => p.includes('/') && governed.has(p));
  if (!anchor) throw new AutofixAbort('S6', 'gate-failed', 'ADR-0103 governs no path with a directory part to anchor the review row on');
  writeReview(rwt, { digest, version, issues, date, anchor, contractTouched: touched.some((f) => f.path === 'scripts/release-qualification-contract.mjs') });
  const after = (ctx.evaluateReview || evaluateArchitectureReview)(rwt);
  if (!after.pass) throw new AutofixAbort('S6', 'gate-failed', `ADR-0103 review is still not current after the row: ${JSON.stringify(after.findings).slice(0, 1500)}`);
  await mustGit(ctx, 'S6', 'gate-failed', rwt, ['add', '--', GOVERNING_ADR]);
  await mustGitAs(ctx, 'S6', 'gate-failed', rwt, ['commit', '-m', `chore(release): ADR-0103 mechanical review row for ${version}`]);
  return { digest, rowAdded: true };
}

const blocksOf = (stdout) => {
  try { return new Set(JSON.parse(stdout).docs.flatMap((d) => (d.findings || []).filter((f) => f.level === 'block').map((f) => `${d.file}:${f.code}`))); }
  catch { return null; }
};
/** doc:currency passes when the candidate adds no BLOCK that origin/main did not already have. */
async function noNewDocBlocks(ctx, rwt) {
  const mine = blocksOf((await run(ctx, 'node', ['scripts/doc-currency.mjs', '--json'], { cwd: rwt })).stdout);
  const basePath = `${rwt}-base`;
  await mustGit(ctx, 'S6', 'gate-failed', ctx.clone, ['worktree', 'add', '--detach', basePath, 'origin/main']);
  const base = blocksOf((await run(ctx, 'node', ['scripts/doc-currency.mjs', '--json'], { cwd: basePath })).stdout);
  if (!mine || !base) return false;
  return [...mine].every((k) => base.has(k));
}

export async function runLocalGates(ctx, { rwt }) {
  const ts = String(ctx.now());
  const gates = [];
  for (const [name, cmd, tmpl] of LOCAL_GATES) {
    await ctx.checkpoint(`gate:${name}`);
    const args = tmpl.map((a) => a.replace('<RUN>', ctx.runDir || rwt).replace('<TS>', ts));
    const started = ctx.now();
    let exitCode; let output;
    if (ctx.gates?.[name]) {
      ({ exitCode, output } = await ctx.gates[name](rwt));
    } else {
      const r = await run(ctx, cmd, args, { cwd: rwt, timeoutMs: GATE_TIMEOUT_MS[name] || 30 * MIN });
      exitCode = r.timedOut ? 124 : r.status;
      output = `${r.stdout || ''}${r.stderr || ''}`;
      if (exitCode !== 0 && name === 'doc-currency' && await noNewDocBlocks(ctx, rwt)) exitCode = 0;
    }
    gates.push({ name, exitCode, durationMs: ctx.now() - started, outputTail: tail(output) });
    if (exitCode !== 0) return { ok: false, gates };
  }
  return { ok: true, gates };
}
