#!/usr/bin/env node
// scripts/corpus-watchdog.mjs — is the customer corpus ACTUALLY being refreshed every night?
//
// THE FAILURE THIS EXISTS TO END (2026-09-28/29, measured on live run history). The nightly
// dispatcher `corpus-nightly-dispatch.yml` stood down in ~13 seconds and finished GREEN, night after
// night, because repository variable CORPUS_NIGHTLY was unset. A green run is not a refreshed corpus:
// nothing was dispatched, nothing was published, and ntfy-alerts only pages on red. Before that, nine
// corpus-mode protected-release failures in a row never paged at all (a GITHUB_TOKEN dispatch cannot
// fire workflow_run). Silence was read as health — the exact failure config/scheduled-jobs.json names:
// ABSENCE OF EVIDENCE IS FAILURE.
//
// So this watchdog does not ask "did a workflow go green?". It asks for EVIDENCE OF AN OUTCOME:
//   RED      (a) no night ended `published` or `no-change` in the last 48h (catches silent stand-downs)
//            (b) the newest corpus run of the last 24h failed (or was cancelled / timed out)
//            (c) the newest vX.Y.Z code release has no VERIFIED public-verification aggregate 24h after
//                publish, or carries one that does not verify (the nightly cannot arm without it)
//            (d) any store has been deferred (carried STALE or MISSING) for more than 7 days
//            (e) the generation customers actually receive (releases/latest) is older than 36h —
//                the server-side half of "nobody's Brain is ever more than 48h old"
//            (f) the most recent customer canary refused its candidate (canary-rejected): a night
//                that built and staged a corpus no clean customer install could apply
//   WARNING  a superseded or degraded night, a stand-down tonight, an unknown outcome, a long run
//   GREEN    none of the above
//
// Exit code is the contract (same as scripts/github-health-watch.mjs): 0 = GREEN or WARNING,
// 1 = RED or the evidence could not be gathered. corpus-watchdog.yml runs on a genuine `schedule:`,
// so its red conclusion fires ntfy-alerts.yml's workflow_run listener — no secret needed here.
//
// READ-ONLY. Every gh call below is a list/view/download. It never dispatches, edits, or publishes.
// Every `--json` field used is one gh 2.101.0 lists for that subcommand (the redesign that created
// this file exists because release.mjs asked `gh release view` for `isLatest`, which only
// `gh release list` has); tests/unit/corpus-watchdog.test.mjs pins the lists.
//
//   node scripts/corpus-watchdog.mjs [--repo owner/name] [--json] [--now ISO]

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODE_TAG_PATTERN, isCorpusReleaseTag } from './release-channel-kind.mjs';
import { AGGREGATE_ASSET, SIGNING_PUBLIC_KEY_FILE } from './approved-runtime.mjs';
import { COVERAGE_ASSET, COVERAGE_RECEIPT_ASSET, verifyCoverageSidecar } from './corpus-coverage-sidecar.mjs';
import { parseCorpusGeneration } from './corpus-promotion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RED = 'RED';
export const WARNING = 'WARNING';
export const GREEN = 'GREEN';
export const INFO = 'INFO';
const HOUR = 3_600_000;
export const FRESHNESS_WINDOW_MS = 48 * HOUR;
export const TONIGHT_WINDOW_MS = 24 * HOUR;
export const AGGREGATE_GRACE_MS = 24 * HOUR;
export const DEFERRAL_LIMIT_MS = 7 * 24 * HOUR;
export const LONG_RUN_MS = 8 * HOUR;
/** A customer Brain must never be >48h old; the promoted generation pages at 36h so a same-day fix lands first. */
export const PROMOTED_AGE_LIMIT_MS = 36 * HOUR;
/** protected-release.yml's run-name for a corpus run: `protected-release corpus <dispatch id>`. */
export const CORPUS_RUN_TITLE = /^protected-release corpus (\S+)$/;
/** The dispatch id corpus-nightly-dispatch.yml passes: `corpus-<its run id>-<its attempt>`. */
const DISPATCH_ID = /^corpus-(\d+)-(\d+)$/;
/** Terminal outcomes a corpus-release-outcome.json may declare in an `outcome` field (design D2). */
const DECLARED_OUTCOMES = new Set(['published', 'no-change', 'superseded', 'degraded', 'canary-rejected', 'failed']);
const GOOD_NIGHT = new Set(['published', 'no-change']);

const ms = (iso) => {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? t : null;
};
const hours = (delta) => `${(delta / HOUR).toFixed(1)}h`;

/**
 * What ONE protected-release corpus run proved. Preference order: an explicit `outcome` in the run's
 * corpus-release-outcome.json, then that record's per-job results, then the run's own job list.
 * A non-success run conclusion is `failed` unless the record says otherwise (a typed superseded exit
 * is a warning, not red). A success that shows neither a publish nor a no-change round is `unknown`
 * — never counted as a good night.
 */
export function classifyCorpusRun(run) {
  if (run?.status !== 'completed') return 'in-progress';
  const declared = String(run.outcomeRecord?.outcome ?? '').replace('no_change', 'no-change');
  if (DECLARED_OUTCOMES.has(declared)) return declared;
  const recorded = run.outcomeRecord?.jobs;
  const byName = new Map((run.jobs || []).map((job) => [job.name, job.conclusion]));
  // The customer canary refusing its candidate is its own outcome: red, and nothing reached customers.
  if ((recorded?.canary ?? byName.get('customer-canary')) === 'failure') return 'canary-rejected';
  if (run.conclusion !== 'success') return 'failed';
  const noChange = recorded?.no_change ?? byName.get('corpus-no-change-round');
  // Since the customer canary, `published` means PROMOTED: the promote job, not the (staging) publisher.
  // Runs recorded before the canary existed carry no promote job; their publisher moved latest itself.
  const publish = recorded
    ? (Object.hasOwn(recorded, 'promote') ? recorded.promote : recorded.publish)
    : (byName.has('promote-canaried-corpus') ? byName.get('promote-canaried-corpus') : byName.get('protected-corpus-publisher'));
  if (noChange === 'success') return 'no-change';
  if (publish === 'success') return 'published';
  return 'unknown';
}

/**
 * How long each store in the NEWEST generation has been deferred: walk generations newest-first while
 * the store stays carried/missing; it has been deferred since the oldest generation in that unbroken
 * run. A generation whose coverage is unknown (published before the D6.2 sidecar, or not fetched)
 * ends the walk with `lowerBound: true` — the true deferral is at least that long.
 * `generations`: [{ tag, publishedAt, degraded: { carried, missing } | null }], newest first.
 */
export function deferralSince(generations) {
  const [newest, ...older] = generations || [];
  if (!newest?.degraded) return [];
  const stores = [...new Set([...(newest.degraded.carried || []), ...(newest.degraded.missing || [])])].sort();
  return stores.map((store) => {
    let since = newest.publishedAt;
    let lowerBound = true; // until a generation proves the store was NOT deferred, history ran out first
    for (const generation of older) {
      if (!generation.degraded) break;
      if (![...(generation.degraded.carried || []), ...(generation.degraded.missing || [])].includes(store)) { lowerBound = false; break; }
      since = generation.publishedAt;
    }
    return { store, since, lowerBound };
  });
}

/**
 * The pure verdict. `input`:
 *   corpusReleases  [{ tag, publishedAt }]                           PROMOTED (non-draft, non-prerelease) corpus-sha256-* releases
 *   latestRelease   { tag, publishedAt, generation } | null           what releases/latest serves customers right now
 *   corpusRuns      [{ id, title, status, conclusion, createdAt, updatedAt, outcome }]  protected-release corpus runs
 *   dispatcherRuns  [{ id, attempt, status, conclusion, createdAt }]  corpus-nightly-dispatch runs
 *   codeRelease     { tag, publishedAt, aggregate: { state: verified|missing|invalid, reason } } | null
 *   deferral        { observable, reason, newestTag, degraded: {carried, missing}, stores: [{store, since, lowerBound}] }
 */
export function judgeCorpusHealth(input, now) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(at)) throw new Error('judgeCorpusHealth needs a valid `now`');
  const findings = [];
  const add = (level, check, detail) => findings.push({ level, check, detail });
  const age = (iso) => { const t = ms(iso); return t === null || t > at ? null : at - t; };
  const runs = (input?.corpusRuns || []).map((run) => ({ ...run, outcome: run.outcome ?? classifyCorpusRun(run) }));
  const dispatchers = input?.dispatcherRuns || [];

  // Dispatcher runs that finished without creating a corpus run: stand-downs (the silent failure).
  const dispatchedIds = new Set(runs.map((run) => CORPUS_RUN_TITLE.exec(String(run.title || ''))?.[1]).filter(Boolean));
  const standDowns = dispatchers.filter((d) => d.status === 'completed' && d.conclusion === 'success'
    && !dispatchedIds.has(`corpus-${d.id}-${d.attempt ?? 1}`));

  // (a) a good night inside the freshness window. Inclusive: exactly 48h old still counts.
  const evidence = [
    ...(input?.corpusReleases || []).map((release) => ({ kind: 'published', at: release.publishedAt, ref: release.tag })),
    ...runs.filter((run) => GOOD_NIGHT.has(run.outcome)).map((run) => ({ kind: run.outcome, at: run.updatedAt, ref: `run ${run.id}` })),
  ].filter((item) => age(item.at) !== null).sort((a, b) => ms(b.at) - ms(a.at));
  const lastGoodNight = evidence[0] || null;
  if (!lastGoodNight || age(lastGoodNight.at) > FRESHNESS_WINDOW_MS) {
    const recentStandDowns = standDowns.filter((d) => (age(d.createdAt) ?? Infinity) <= FRESHNESS_WINDOW_MS).length;
    add(RED, 'freshness', `no night ended published or no-change in the last 48h `
      + `(last: ${lastGoodNight ? `${lastGoodNight.kind} ${lastGoodNight.ref} ${hours(age(lastGoodNight.at))} ago` : 'never observed'}; `
      + `${recentStandDowns} dispatcher stand-down(s) in the window — a green dispatcher that dispatched nothing is not a refreshed corpus)`);
  } else {
    add(GREEN, 'freshness', `${lastGoodNight.kind} ${lastGoodNight.ref} ${hours(age(lastGoodNight.at))} ago`);
  }

  // (b) tonight: the newest corpus run created in the last 24h.
  const tonight = runs.filter((run) => (age(run.createdAt) ?? Infinity) <= TONIGHT_WINDOW_MS)
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
  const lastDispatcher = dispatchers.filter((d) => (age(d.createdAt) ?? Infinity) <= TONIGHT_WINDOW_MS)
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
  if (tonight) {
    const ref = `corpus run ${tonight.id} (${tonight.title})`;
    if (tonight.outcome === 'failed') add(RED, 'tonight', `${ref} failed (conclusion ${tonight.conclusion})`);
    else if (tonight.outcome === 'canary-rejected') add(RED, 'tonight', `${ref}: the customer canary refused the candidate; it stays an unpromoted prerelease`);
    else if (tonight.outcome === 'superseded') add(WARNING, 'tonight', `${ref} was superseded by a newer code release before publish`);
    else if (tonight.outcome === 'degraded') add(WARNING, 'tonight', `${ref} published a degraded generation`);
    else if (tonight.outcome === 'unknown') add(WARNING, 'tonight', `${ref} succeeded but shows neither a publish nor a no-change round`);
    else if (tonight.outcome === 'in-progress') {
      add((age(tonight.createdAt) ?? 0) > LONG_RUN_MS ? WARNING : INFO, 'tonight', `${ref} still running after ${hours(age(tonight.createdAt) ?? 0)}`);
    } else add(GREEN, 'tonight', `${ref} ended ${tonight.outcome}`);
  } else if (!lastDispatcher) {
    add(WARNING, 'tonight', 'no corpus-nightly-dispatch run in the last 24h (schedule dropped or disabled?)');
  } else if (lastDispatcher.status === 'completed' && lastDispatcher.conclusion !== 'success') {
    add(RED, 'tonight', `corpus-nightly-dispatch run ${lastDispatcher.id} concluded ${lastDispatcher.conclusion}`);
  } else if (standDowns.includes(lastDispatcher)) {
    add(WARNING, 'tonight', `corpus-nightly-dispatch run ${lastDispatcher.id} stood down: nothing was dispatched `
      + '(CORPUS_NIGHTLY off, or no install-verified runtime yet)');
  } else {
    add(GREEN, 'tonight', `corpus-nightly-dispatch run ${lastDispatcher.id} is ${lastDispatcher.status}`);
  }

  // (c) the newest code release must reach a verified aggregate within 24h of publish.
  const code = input?.codeRelease;
  if (!code) add(RED, 'code-aggregate', 'no published vX.Y.Z code release was found');
  else if (code.aggregate?.state === 'verified') add(GREEN, 'code-aggregate', `${code.tag} carries a verified PASS aggregate`);
  else if (code.aggregate?.state === 'invalid') add(RED, 'code-aggregate', `${code.tag} carries an aggregate that does not verify `
    + `under this checkout's verifier (the one approved-runtime --resolve runs, so the nightly will refuse it too): ${code.aggregate.reason}`);
  else {
    const since = age(code.publishedAt);
    if (since === null || since >= AGGREGATE_GRACE_MS) {
      add(RED, 'code-aggregate', `${code.tag} was published ${since === null ? 'at an unknown time' : `${hours(since)} ago`} `
        + 'and still has no public-verification aggregate — the nightly cannot arm');
    } else add(INFO, 'code-aggregate', `${code.tag} is ${hours(since)} old; aggregate pending (grace 24h)`);
  }

  // (d) deferred stores. Only observable from a generation that carries the D6.2 coverage sidecar.
  const deferral = input?.deferral;
  if (!deferral?.observable) {
    add(INFO, 'deferral', `not observable: ${deferral?.reason || 'no coverage evidence gathered'}`);
  } else {
    const overdue = (deferral.stores || []).filter((row) => (age(row.since) ?? 0) > DEFERRAL_LIMIT_MS);
    if (overdue.length) {
      add(RED, 'deferral', `${overdue.length} store(s) deferred more than 7 days: ${overdue.slice(0, 10)
        .map((row) => `${row.store} (${row.lowerBound ? '≥' : ''}${hours(age(row.since))})`).join(', ')}`);
    } else add(GREEN, 'deferral', `${(deferral.stores || []).length} deferred store(s), none older than 7 days`);
    const degraded = [...(deferral.degraded?.carried || []), ...(deferral.degraded?.missing || [])];
    if (degraded.length) add(WARNING, 'degraded', `${deferral.newestTag} is degraded: ${deferral.degraded.carried.length} carried, ${deferral.degraded.missing.length} missing`);
  }

  // (e) the generation customers receive. Its own generation stamp when it carries one (the corpus
  // build time), else its publish time. Missing or unreadable is RED: absence of evidence is failure.
  const latest = input?.latestRelease;
  const latestAge = latest ? age(latest.generation || latest.publishedAt) : null;
  if (latestAge === null) {
    add(RED, 'promoted-age', `releases/latest could not be dated (${latest ? latest.tag : 'no latest release observed'})`);
  } else if (latestAge > PROMOTED_AGE_LIMIT_MS) {
    add(RED, 'promoted-age', `customers receive ${latest.tag}, ${hours(latestAge)} old (limit 36h; a customer Brain must never pass 48h)`);
  } else add(GREEN, 'promoted-age', `customers receive ${latest.tag}, ${hours(latestAge)} old`);

  // (f) the most recent customer canary verdict among the observed runs.
  const lastCanary = runs.filter((run) => run.outcome === 'published' || run.outcome === 'canary-rejected')
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
  if (!lastCanary) add(INFO, 'canary', 'no customer canary verdict among the observed corpus runs');
  else if (lastCanary.outcome === 'canary-rejected') {
    add(RED, 'canary', `the last customer canary (run ${lastCanary.id}) refused its candidate: a clean install could not apply it`);
  } else add(GREEN, 'canary', `the last customer canary (run ${lastCanary.id}) applied its candidate and it was promoted`);

  const verdict = findings.some((f) => f.level === RED) ? RED : findings.some((f) => f.level === WARNING) ? WARNING : GREEN;
  return { verdict, findings, lastGoodNight };
}

// ── Gathering (read-only gh). Everything above is pure; everything below talks to GitHub. ──────────

function defaultGh(args) {
  const result = spawnSync(process.env.RUVNET_GH_COMMAND || 'gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${String(result.error?.message || result.stderr || `exit ${result.status}`).trim().slice(0, 300)}`);
  }
  return result.stdout;
}

const semver = (tag) => CODE_TAG_PATTERN.test(tag) ? tag.slice(1).split('.').map(Number) : null;
/** Same selection as scripts/approved-runtime.mjs --resolve: newest by semver, no drafts, no prereleases. */
function newestCodeRelease(rows) {
  return rows.filter((row) => !row.isDraft && !row.isPrerelease && semver(row.tagName))
    .sort((a, b) => { const x = semver(a.tagName); const y = semver(b.tagName); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; })[0] || null;
}

function assetNames(gh, repo, tag) {
  return new Set((JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'assets'])).assets || []).map((asset) => asset.name));
}
function download(gh, repo, tag, name, dir) {
  gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir, '--clobber']);
  return fs.readFileSync(path.join(dir, name));
}

async function aggregateState({ gh, repo, tag, root, scratch }) {
  if (!assetNames(gh, repo, tag).has(AGGREGATE_ASSET)) return { state: 'missing' };
  try {
    const aggregate = JSON.parse(download(gh, repo, tag, AGGREGATE_ASSET, scratch).toString('utf8'));
    const { verifyPublicVerificationAggregate } = await import('./public-verification-aggregate.mjs');
    verifyPublicVerificationAggregate(aggregate, crypto.createPublicKey(fs.readFileSync(path.join(root, SIGNING_PUBLIC_KEY_FILE), 'utf8')));
    if (aggregate.identity?.tag !== tag) throw new Error(`aggregate describes ${aggregate.identity?.tag}, not ${tag}`);
    return { state: 'verified' };
  } catch (error) {
    return { state: 'invalid', reason: error.message.slice(0, 200) };
  }
}

function generationCoverage({ gh, repo, tag, scratch }) {
  const names = assetNames(gh, repo, tag);
  if (!names.has(COVERAGE_ASSET) || !names.has(COVERAGE_RECEIPT_ASSET)) return null;
  const dir = fs.mkdtempSync(path.join(scratch, 'coverage-'));
  const { degraded } = verifyCoverageSidecar({
    sidecar: JSON.parse(download(gh, repo, tag, COVERAGE_RECEIPT_ASSET, dir).toString('utf8')),
    coverageBytes: download(gh, repo, tag, COVERAGE_ASSET, dir),
    generationTag: tag,
    archiveSha256: tag.slice('corpus-sha256-'.length),
  });
  return degraded;
}

function corpusRunEvidence({ gh, repo, run, scratch }) {
  if (run.status !== 'completed') return {};
  const dir = fs.mkdtempSync(path.join(scratch, 'outcome-'));
  try {
    gh(['run', 'download', String(run.databaseId), '--repo', repo, '--name', `corpus-release-outcome-${run.databaseId}-${run.attempt ?? 1}`, '--dir', dir]);
    return { outcomeRecord: JSON.parse(fs.readFileSync(path.join(dir, 'corpus-release-outcome.json'), 'utf8')) };
  } catch {
    // Runs that never reached corpus-terminal-outcome have no record; their job list still says what happened.
    return { jobs: JSON.parse(gh(['run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs'])).jobs || [] };
  }
}

export async function gatherCorpusHealthInput({ repo, now, gh = defaultGh, root = ROOT, scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-watchdog-')) }) {
  const at = now.getTime();
  const recent = (iso) => (ms(iso) ?? 0) >= at - 3 * 24 * HOUR;
  const dispatcherRuns = JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', 'corpus-nightly-dispatch.yml', '--limit', '30',
    '--json', 'databaseId,attempt,event,status,conclusion,createdAt,updatedAt']))
    .map((run) => ({ id: run.databaseId, attempt: run.attempt, event: run.event, status: run.status, conclusion: run.conclusion, createdAt: run.createdAt }));
  const corpusRuns = JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', 'protected-release.yml', '--limit', '60',
    '--json', 'databaseId,attempt,displayTitle,status,conclusion,createdAt,updatedAt']))
    .filter((run) => CORPUS_RUN_TITLE.test(String(run.displayTitle || '')) && recent(run.createdAt))
    .map((run) => ({ id: run.databaseId, title: run.displayTitle, status: run.status, conclusion: run.conclusion,
      createdAt: run.createdAt, updatedAt: run.updatedAt, ...corpusRunEvidence({ gh, repo, run, scratch }) }));
  const releases = JSON.parse(gh(['release', 'list', '--repo', repo, '--limit', '100', '--json', 'tagName,publishedAt,isDraft,isPrerelease']));
  // PROMOTED only: a staged candidate (and a bootstrap seed) is a prerelease no customer receives.
  const corpusReleases = releases.filter((row) => !row.isDraft && !row.isPrerelease && isCorpusReleaseTag(row.tagName))
    .map((row) => ({ tag: row.tagName, publishedAt: row.publishedAt }))
    .sort((a, b) => (ms(b.publishedAt) ?? 0) - (ms(a.publishedAt) ?? 0));
  const newestCode = newestCodeRelease(releases);
  const codeRelease = newestCode && { tag: newestCode.tagName, publishedAt: newestCode.publishedAt,
    aggregate: await aggregateState({ gh, repo, tag: newestCode.tagName, root, scratch }) };

  // Deferral: newest generation's verified coverage, then older ones only while it can still matter.
  let deferral = { observable: false, reason: 'no corpus release is published' };
  if (corpusReleases.length) {
    const generations = [];
    for (const release of corpusReleases.slice(0, 15)) {
      const degraded = generationCoverage({ gh, repo, tag: release.tag, scratch });
      generations.push({ ...release, degraded });
      const pending = generations[0].degraded && [...generations[0].degraded.carried, ...generations[0].degraded.missing];
      if (!degraded || !pending?.length || (ms(release.publishedAt) ?? 0) < at - DEFERRAL_LIMIT_MS - 24 * HOUR) break;
    }
    deferral = generations[0].degraded
      ? { observable: true, newestTag: generations[0].tag, degraded: generations[0].degraded, stores: deferralSince(generations) }
      // Generations published before ADR-0091 D6.2 carry no CORPUS-COVERAGE.json / coverage-receipt.json,
      // so which stores were carried, and since when, is simply not recorded anywhere a reader can verify.
      : { observable: false, reason: `${generations[0].tag} predates the D6.2 coverage sidecar (${COVERAGE_ASSET} + ${COVERAGE_RECEIPT_ASSET})` };
  }
  let latestRelease = null;
  try {
    const latest = JSON.parse(gh(['api', `repos/${repo}/releases/latest`]));
    latestRelease = { tag: latest.tag_name, publishedAt: latest.published_at, generation: parseCorpusGeneration(latest.body)?.value || null };
  } catch { latestRelease = null; } // judged RED as "could not be dated"
  return { corpusReleases, corpusRuns, dispatcherRuns, codeRelease, deferral, latestRelease };
}

export function renderReport(result, now) {
  const lines = [`corpus-watchdog ${result.verdict} at ${now.toISOString()}`];
  for (const f of result.findings) lines.push(`  [${f.level}] ${f.check}: ${f.detail}`);
  return `${lines.join('\n')}\n`;
}

async function main(argv = process.argv.slice(2)) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = opt('--repo') || process.env.GITHUB_REPOSITORY || 'stuinfla/ruvnet-brain';
  const now = opt('--now') ? new Date(opt('--now')) : new Date();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !Number.isFinite(now.getTime())) {
    process.stderr.write('usage: corpus-watchdog.mjs [--repo owner/name] [--json] [--now ISO]\n');
    return 2;
  }
  let result;
  try {
    result = judgeCorpusHealth(await gatherCorpusHealthInput({ repo, now }), now);
  } catch (error) {
    // Could not observe = could not prove health. Absence of evidence is failure.
    process.stderr.write(`corpus-watchdog RED: evidence could not be gathered: ${error.message}\n`);
    return 1;
  }
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result, now));
  return result.verdict === RED ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}
