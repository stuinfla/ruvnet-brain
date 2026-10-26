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
// THE FIRST LINE IS THE NIGHT'S VERDICT (2026-10-20, summarizeNight): what the night did -- published,
// no-change, degraded with the stores named, failed with the stage named, superseded, canary-rejected, still
// running, stood down -- in Eastern time, result first, so the owner never learns of a break from a page.
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
import { retryTransientResult } from './transient-gh.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

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
  else if (code.aggregate?.state === 'verified') {
    add(GREEN, 'code-aggregate', `${code.tag} carries a verified PASS aggregate`);
    // (c2) THE CORPUS FRESH INSTALLS RECEIVE. A code release ships a corpus too, and its signed aggregate
    // records how many eligible stores the three install lanes found CURRENT. The aggregate VERIFIES only when
    // eligibleCurrent === eligibleTotal (scripts/public-verification-aggregate.mjs), so a verified code release
    // never ships a carried or missing store; this line says so with the measured counts rather than leaving
    // it implied. Counts that are absent (the verifier does not require their presence) are reported, not
    // read as "all current".
    const shipped = code.aggregate.coverage;
    if (!shipped || !Number.isSafeInteger(shipped.eligibleTotal) || !Number.isSafeInteger(shipped.eligibleCurrent)) {
      add(WARNING, 'code-corpus', `${code.tag}: the aggregate records no eligible/CURRENT store counts; what fresh installs receive is unmeasured`);
    } else {
      add(GREEN, 'code-corpus', `${code.tag} ships ${shipped.eligibleCurrent}/${shipped.eligibleTotal} eligible stores CURRENT`);
    }
  }
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
    if (degraded.length) {
      add(WARNING, 'degraded', `${deferral.newestTag} is degraded: ${deferral.degraded.carried.length} carried `
        + `(${deferral.degraded.carried.join(', ') || 'none'}), ${deferral.degraded.missing.length} missing (${deferral.degraded.missing.join(', ') || 'none'})`);
    }
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
  // A transient gh failure is retried, bounded (scripts/transient-gh.mjs); the judge must not page RED on weather.
  const result = retryTransientResult(() => spawnSync(process.env.RUVNET_GH_COMMAND || 'gh', args,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 }));
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
    // The corpus a CODE release ships, as its three install lanes measured it: the signed aggregate carries
    // the eligible/CURRENT counts and the coverage generation of the installed COVERAGE.json. The code
    // release publishes no coverage sidecar of its own (verified 2026-10-17: v4.7.10 assets), so this is
    // the one small, signed place that says what fresh installs receive.
    return { state: 'verified', coverage: { eligibleTotal: aggregate.coverage?.eligibleTotal ?? null,
      eligibleCurrent: aggregate.coverage?.eligibleCurrent ?? null, coverageGeneration: aggregate.identity?.coverageGeneration ?? null } };
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

/**
 * The protected-release corpus runs created since `since` (ms), each with its outcome evidence. Shared with the
 * dispatcher's retry slot (scripts/corpus-dispatch-decision.mjs --retry-slot), so both read one definition of
 * "tonight's runs" and one classifier.
 */
export function gatherCorpusRuns({ repo, since, gh = defaultGh, scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-watchdog-')) }) {
  return JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', 'protected-release.yml', '--limit', '60',
    '--json', 'databaseId,attempt,displayTitle,status,conclusion,createdAt,updatedAt']))
    .filter((run) => CORPUS_RUN_TITLE.test(String(run.displayTitle || '')) && (ms(run.createdAt) ?? 0) >= since)
    .map((run) => ({ id: run.databaseId, title: run.displayTitle, status: run.status, conclusion: run.conclusion,
      createdAt: run.createdAt, updatedAt: run.updatedAt, ...corpusRunEvidence({ gh, repo, run, scratch }) }));
}

export async function gatherCorpusHealthInput({ repo, now, gh = defaultGh, root = ROOT, scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-watchdog-')) }) {
  const at = now.getTime();
  const dispatcherRuns = JSON.parse(gh(['run', 'list', '--repo', repo, '--workflow', 'corpus-nightly-dispatch.yml', '--limit', '30',
    '--json', 'databaseId,attempt,event,status,conclusion,createdAt,updatedAt']))
    .map((run) => ({ id: run.databaseId, attempt: run.attempt, event: run.event, status: run.status, conclusion: run.conclusion, createdAt: run.createdAt }));
  const corpusRuns = gatherCorpusRuns({ repo, since: at - 3 * 24 * HOUR, gh, scratch });
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

/** A time the owner reads: local Eastern, 12-hour, named zone -- never UTC or "Z". */
export function formatEastern(when) {
  const t = when instanceof Date ? when.getTime() : ms(when);
  if (t === null || !Number.isFinite(t)) return 'an unknown time';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(t)).map((part) => [part.type, part.value]));
  return `${parts.hour}:${parts.minute} ${parts.dayPeriod.toLowerCase().replace(/^(a|p)m$/, '$1.m.')} ET ${parts.month} ${parts.day}`;
}

/** The job the night died in, named as the owner knows the stage, from the terminal outcome record or the job list. */
const STAGE_NAMES = { identity: 'authorize (corpus-identity)', prepare: 'prepare/seal (seal-exact-corpus-candidate)',
  authorize: 'authenticate (corpus-authorize)', publish: 'publisher (corpus-publish)', canary: 'customer canary', promote: 'promote' };
const JOB_NAMES = { 'authorize-corpus-generation': 'identity', 'seal-exact-corpus-candidate': 'prepare', 'authenticate-corpus-preparation-provenance': 'authorize',
  'protected-corpus-publisher': 'publish', 'customer-canary': 'canary', 'promote-canaried-corpus': 'promote' };
export function failedStage(run) {
  const recorded = Object.entries(run?.outcomeRecord?.jobs || {}).find(([, result]) => result === 'failure')?.[0];
  const listed = (run?.jobs || []).find((job) => job.conclusion === 'failure' && JOB_NAMES[job.name]);
  const stage = recorded || (listed ? JOB_NAMES[listed.name] : null);
  return stage ? STAGE_NAMES[stage] || stage : `an unnamed job (conclusion ${run?.conclusion || 'unknown'})`;
}

/** A night's scheduled dispatches (the 07:36Z run and its retry slot) sit within this span; a day earlier is last night. */
const NIGHT_SPAN_MS = 12 * HOUR;
/**
 * How many protected-release corpus runs belong to THIS night. Measured 2026-10-22: a manual workflow_dispatch proving
 * run at 10:36Z Oct 21 and a stood-down retry slot at 11:25Z Oct 21 made ONE scheduled night read "attempt 2; 1 retried".
 * The night is anchored on the newest `schedule` dispatcher that dispatched a run, plus scheduled dispatchers within
 * NIGHT_SPAN_MS before it; a run counts only from that start and never when its dispatcher was a manual
 * workflow_dispatch. A stood-down retry slot created no run, so it never counts. `runs` is newest-first, in window.
 */
export function nightAttempts(runs, dispatchers) {
  const dispatchKey = (d) => `corpus-${d.id}-${d.attempt ?? 1}`;
  const runKey = (run) => CORPUS_RUN_TITLE.exec(String(run.title || ''))?.[1];
  const byKey = new Map(dispatchers.map((d) => [dispatchKey(d), d]));
  const manual = (run) => byKey.get(runKey(run))?.event === 'workflow_dispatch';
  const [newest] = runs;
  if (manual(newest)) return ' (1 attempt; manual dispatch)';
  const scheduled = dispatchers.filter((d) => !d.event || d.event === 'schedule'); // an undated event is read as the schedule
  const anchor = scheduled.find((d) => runs.some((run) => runKey(run) === dispatchKey(d)));
  const nightStart = anchor
    ? Math.min(...scheduled.filter((d) => ms(d.createdAt) <= ms(anchor.createdAt) && ms(anchor.createdAt) - ms(d.createdAt) <= NIGHT_SPAN_MS).map((d) => ms(d.createdAt)))
    : ms(newest.createdAt);
  const count = runs.filter((run) => ms(run.createdAt) >= nightStart && !manual(run)).length || 1;
  return count > 1 ? ` (attempt ${count} of the night; ${count - 1} retried)` : ' (1 attempt)';
}

/**
 * THE ONE LINE the owner reads first: what the night did, result first, in Eastern time. `input` is
 * gatherCorpusHealthInput's; the night is the newest corpus run of the last 24h and every retry of it.
 * Never learned from a page: the watchdog writes this before ntfy ever fires.
 */
export function summarizeNight(input, now) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const inWindow = (iso) => { const t = ms(iso); return t !== null && t <= at && at - t <= TONIGHT_WINDOW_MS; };
  const runs = (input?.corpusRuns || []).filter((run) => inWindow(run.createdAt))
    .map((run) => ({ ...run, outcome: run.outcome ?? classifyCorpusRun(run) })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const dispatchers = (input?.dispatcherRuns || []).filter((d) => inWindow(d.createdAt)).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const [dispatcher] = dispatchers;
  const latest = input?.latestRelease;
  const attempts = runs.length ? nightAttempts(runs, dispatchers) : '';
  const keep = latest ? `customers keep ${latest.tag} (${hours(Math.max(0, at - (ms(latest.generation || latest.publishedAt) ?? at)))} old)` : 'no promoted generation is observed';
  if (!runs.length) {
    if (!dispatcher) return { outcome: 'no-run', line: `night: no corpus run in the last 24h (no dispatcher run either); ${keep}` };
    if (dispatcher.status !== 'completed') return { outcome: 'dispatching', line: `night: dispatcher run ${dispatcher.id} is ${dispatcher.status} (started ${formatEastern(dispatcher.createdAt)})` };
    if (dispatcher.conclusion !== 'success') return { outcome: 'dispatcher-failed', line: `night: dispatcher run ${dispatcher.id} concluded ${dispatcher.conclusion} at ${formatEastern(dispatcher.createdAt)}, nothing was dispatched; ${keep}` };
    return { outcome: 'stood-down', line: `night: stood down at ${formatEastern(dispatcher.createdAt)} (CORPUS_NIGHTLY off, or no install-verified runtime); ${keep}` };
  }
  const [run] = runs;
  const when = formatEastern(run.updatedAt || run.createdAt);
  const degraded = input?.deferral?.observable && input.deferral.degraded && latest && input.deferral.newestTag === latest.tag
    && (input.deferral.degraded.carried.length || input.deferral.degraded.missing.length) ? input.deferral.degraded : null;
  switch (run.outcome) {
    case 'published': {
      const tag = latest && (ms(latest.publishedAt) ?? 0) >= (ms(run.createdAt) ?? 0) ? latest.tag : 'a new generation';
      if (degraded) {
        return { outcome: 'degraded', line: `night: degraded -- published ${tag} at ${when}${attempts} with ${degraded.carried.length} carried `
          + `(${degraded.carried.join(', ') || 'none'}) and ${degraded.missing.length} missing (${degraded.missing.join(', ') || 'none'}), each named in CORPUS-COVERAGE.json` };
      }
      return { outcome: 'published', line: `night: published ${tag} at ${when}${attempts}` };
    }
    case 'no-change': return { outcome: 'no-change', line: `night: no-change at ${when}${attempts} -- every knowledge input equals the promoted generation; ${keep}` };
    case 'superseded': return { outcome: 'superseded', line: `night: superseded at ${when} -- a newer code release landed; the next night builds at it; ${keep}` };
    case 'canary-rejected': return { outcome: 'canary-rejected', line: `night: canary-rejected at ${when}${attempts} -- a clean customer install could not apply the candidate (GLOBAL: not retried); ${keep}` };
    case 'in-progress': return { outcome: 'in-progress', line: `night: run ${run.id} still in progress, started ${formatEastern(run.createdAt)}${attempts}` };
    case 'failed': return { outcome: 'failed', line: `night: failed in ${failedStage(run)} at ${when}${attempts}; ${keep}` };
    default: return { outcome: 'unknown', line: `night: run ${run.id} succeeded at ${when} but reached no outcome${attempts}; ${keep}` };
  }
}

export function renderReport(result, now) {
  const lines = [`corpus-watchdog ${result.verdict} -- ${result.night?.line || `judged ${formatEastern(now)}`}`,
    `  judged ${formatEastern(now)} (${now.toISOString()})`];
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
    const input = await gatherCorpusHealthInput({ repo, now });
    result = { ...judgeCorpusHealth(input, now), night: summarizeNight(input, now) };
  } catch (error) {
    // Could not observe = could not prove health. Absence of evidence is failure.
    process.stderr.write(`corpus-watchdog RED: evidence could not be gathered: ${error.message}\n`);
    return 1;
  }
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result, now));
  return result.verdict === RED ? 1 : 0;
}

if (isDirectInvocation(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
