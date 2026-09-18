#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRvfGenerations, sha256File } from './rvf-generation.mjs';
import { canonicalJson, coverageGenerationFor, digest, validateGistAggregateReceipt, isIngestibleDisposition, forkDeltaIdentityFor, forkDeltaMatches } from './coverage-integrity.mjs';
import { repositoryNames } from '../kb/card-lane.mjs';
import { rootNeverMaterialized, storeRoot } from '../kb/store-root.mjs';

export { canonicalJson, digest } from './coverage-integrity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// SOURCE POLICY VERSION — sealed into every coverage as `policy.policyVersion` so a recorded
// measurement produced under an older eligibility policy is DETECTABLE (main --check names the gap)
// rather than silently compared row-for-row against a generator that classifies differently.
//   1 — forks and archives INELIGIBLE by flag; anonymous gist fallback capped at 10 pages;
//       no-corpus exclusions active on a pushedAt match alone.
//   2 — ADR-086 Step 12 (2026-09-13). Archives eligible unconditionally. Forks dispositioned every run
//       by the compare API pinned to both observed heads: ahead_by>0 → `fork:original-content`
//       (ingestible, delta-only), ahead_by=0 → `fork:no-original-content` (recorded with the upstream
//       identity). Gist fallback paginates to an empty page under a throwing ceiling. An active
//       exclusion must carry source-file evidence bound to the observed head.
export const SOURCE_POLICY_VERSION = 2;

export { isIngestibleDisposition } from './coverage-integrity.mjs';

const REPO_QUERY = `query($login:String!,$cursor:String){
  user(login:$login){
    publicRepositories:repositories(privacy:PUBLIC){totalCount}
    repositories(first:100,after:$cursor,privacy:PUBLIC,ownerAffiliations:OWNER,orderBy:{field:NAME,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{databaseId name url description homepageUrl isFork isArchived isDisabled diskUsage updatedAt pushedAt
        defaultBranchRef{name target{... on Commit{oid committedDate}}}
        parent{nameWithOwner isPrivate defaultBranchRef{name target{... on Commit{oid}}}}}
    }
  }
}`;

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

// A fork's disposition depends on how many commits it carries that its upstream does not. The
// compare is pinned to the two heads THIS observation recorded (never to branch names, which move),
// and is run against the upstream repository in GitHub's documented cross-fork form
// `BASE...FORK_OWNER:HEAD` (verified live 2026-09-13: ahead_by/behind_by/status/merge_base_commit).
// Any failure here — 403, 404, an upstream GitHub cannot name — is required content that is
// inaccessible, and it fails the observation rather than skipping the fork.
function observeForkDelta(owner, node, gh) {
  const forkHeadSha = node.defaultBranchRef?.target?.oid;
  const upstream = node.parent?.nameWithOwner;
  if (!upstream) throw new Error(`fork ${node.name} has no upstream parent GitHub can name — its original-content delta cannot be established`);
  const upstreamHeadSha = node.parent.defaultBranchRef?.target?.oid;
  if (!upstreamHeadSha) throw new Error(`fork ${node.name}: upstream ${upstream} has no default-branch head to compare against`);
  let compare;
  try {
    compare = JSON.parse(gh(['api', `repos/${upstream}/compare/${upstreamHeadSha}...${owner}:${forkHeadSha}`]));
  } catch (error) {
    throw new Error(`fork ${node.name}: compare against upstream ${upstream} failed — ${error.message}`);
  }
  if (!Number.isInteger(compare?.ahead_by) || !Number.isInteger(compare?.behind_by)) {
    throw new Error(`fork ${node.name}: compare against upstream ${upstream} returned no ahead_by/behind_by`);
  }
  return {
    upstream, upstreamDefaultBranch: node.parent.defaultBranchRef.name, upstreamHeadSha, forkHeadSha,
    mergeBaseSha: compare.merge_base_commit?.sha || null,
    aheadBy: compare.ahead_by, behindBy: compare.behind_by, status: compare.status || null,
  };
}

export function observeRepositories(owner, { gh = runGh } = {}) {
  const rows = [];
  const pages = [];
  let cursor = '';
  do {
    const raw = gh(['api', 'graphql', '-f', `query=${REPO_QUERY}`, '-F', `login=${owner}`,
      ...(cursor ? ['-F', `cursor=${cursor}`] : [])]);
    const body = JSON.parse(raw);
    const connection = body?.data?.user?.repositories;
    if (!connection) throw new Error('GitHub repository enumeration returned no repository connection');
    pages.push({ cursor: cursor || null, responseDigest: digest(body), count: connection.nodes.length,
      endCursor: connection.pageInfo.endCursor, hasNextPage: connection.pageInfo.hasNextPage });
    rows.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : '';
  } while (cursor);
  const expected = rows.length ? Number(JSON.parse(gh(['api', `users/${owner}`])).public_repos) : 0;
  if (rows.length !== expected) throw new Error(`repository enumeration incomplete: ${rows.length}/${expected}`);
  // A fork with no head has nothing to compare; classifyRepository records it as `empty`.
  const withDeltas = rows.map((node) => (node?.isFork && node.defaultBranchRef?.target?.oid
    ? { ...node, forkDelta: observeForkDelta(owner, node, gh) } : node));
  return { rows: withDeltas, expected, pages };
}

export function observeExternalRepositories(sources, { gh = runGh } = {}) {
  const rows = [];
  const pages = [];
  for (const source of sources) {
    if (!source?.store || !/^[^/]+\/[^/]+$/.test(source?.repository || '')) {
      throw new Error('external source requires a store and owner/repository');
    }
    const repo = JSON.parse(gh(['api', `repos/${source.repository}`]));
    const commit = repo.default_branch
      ? JSON.parse(gh(['api', `repos/${source.repository}/commits/${repo.default_branch}`]))
      : null;
    const row = {
      databaseId: repo.id, name: repo.name, fullName: repo.full_name, storeName: source.store,
      url: repo.html_url, description: repo.description || null, homepageUrl: repo.homepage || null,
      isFork: false, upstreamIsFork: repo.fork,
      isArchived: repo.archived, isDisabled: repo.disabled,
      diskUsage: repo.size, updatedAt: repo.updated_at, pushedAt: repo.pushed_at,
      defaultBranchRef: commit ? { name: repo.default_branch, target: {
        oid: commit.sha, committedDate: commit.commit?.committer?.date || commit.commit?.author?.date || null,
      } } : null,
    };
    rows.push(row);
    pages.push({ repository: source.repository, responseDigest: digest({ repo, commit }), count: 1, terminal: true });
  }
  return { rows, expected: rows.length, pages };
}

export function observeSourceUniverse({
  owner = 'ruvnet',
  externalSources = [],
  gh = runGh,
  observedAt = new Date().toISOString(),
} = {}) {
  const primary = observeRepositories(owner, { gh });
  const external = observeExternalRepositories(externalSources, { gh });
  const repositoryRows = canonicalRepositoryRows([...primary.rows, ...external.rows]);
  const repositories = sourceSetObservation(repositoryRows, primary.expected + external.expected);
  const repositoryKeys = new Set();
  const storeKeys = new Set();
  for (const repo of repositories.rows) {
    const repositoryKey = String(repo.fullName || `${owner}/${repo.name}`).toLowerCase();
    const storeKey = storeName(repo.storeName || repo.name);
    if (repositoryKeys.has(repositoryKey)) throw new Error(`source observation has duplicate repository: ${repositoryKey}`);
    if (storeKeys.has(storeKey)) throw new Error(`source observation has colliding store name: ${storeKey}`);
    repositoryKeys.add(repositoryKey);
    storeKeys.add(storeKey);
  }
  const observedGists = observeGists(owner, { gh });
  const gists = sourceSetObservation(canonicalGistRows(observedGists.rows), observedGists.expected);
  return canonicalSourceObservation({
    schemaVersion: 1,
    kind: 'ruvnet-brain-source-observation',
    owner,
    observedAt,
    repositories,
    gists,
  });
}

export function sourceObservationDigest(observation) {
  const stable = canonicalSourceObservation(observation, { seal: false });
  return digest({ schemaVersion: stable.schemaVersion, kind: stable.kind,
    owner: stable.owner, repositories: stable.repositories, gists: stable.gists });
}

function sourceSetObservation(rows, expected) {
  return { rows, expected, pages: [{ index: 1, responseDigest: digest(rows), count: rows.length, terminal: true }] };
}

export function canonicalRepositoryRows(rows = []) {
  return rows.map((repo) => ({
    databaseId: repo?.databaseId,
    name: repo?.name,
    ...(repo?.fullName === undefined ? {} : { fullName: repo.fullName }),
    ...(repo?.storeName === undefined ? {} : { storeName: repo.storeName }),
    url: repo?.url,
    description: repo?.description ?? null,
    homepageUrl: repo?.homepageUrl ?? null,
    isFork: repo?.isFork === true,
    ...(repo?.upstreamIsFork === undefined ? {} : { upstreamIsFork: repo.upstreamIsFork === true }),
    // Sealed into the source identity: the delta baseline (both heads, ahead/behind) IS what was observed.
    ...(repo?.forkDelta === undefined ? {} : { forkDelta: {
      upstream: repo.forkDelta.upstream, upstreamDefaultBranch: repo.forkDelta.upstreamDefaultBranch ?? null,
      upstreamHeadSha: repo.forkDelta.upstreamHeadSha, forkHeadSha: repo.forkDelta.forkHeadSha,
      mergeBaseSha: repo.forkDelta.mergeBaseSha ?? null,
      aheadBy: repo.forkDelta.aheadBy, behindBy: repo.forkDelta.behindBy, status: repo.forkDelta.status ?? null,
    } }),
    isArchived: repo?.isArchived === true,
    isDisabled: repo?.isDisabled === true,
    diskUsage: repo?.diskUsage,
    updatedAt: repo?.updatedAt ?? null,
    pushedAt: repo?.pushedAt ?? null,
    defaultBranchRef: repo?.defaultBranchRef ? {
      name: repo.defaultBranchRef.name,
      target: repo.defaultBranchRef.target ? {
        oid: repo.defaultBranchRef.target.oid,
        committedDate: repo.defaultBranchRef.target.committedDate ?? null,
      } : null,
    } : null,
  })).sort((a, b) => {
    const identity = (row) => String(row.fullName || row.name || '').toLowerCase();
    return identity(a).localeCompare(identity(b))
      || String(a.storeName || '').toLowerCase().localeCompare(String(b.storeName || '').toLowerCase())
      || Number(a.databaseId || 0) - Number(b.databaseId || 0);
  });
}

export function canonicalGistRows(rows = []) {
  return rows.map((gist) => ({
    id: gist?.id,
    updated_at: gist?.updated_at ?? null,
    html_url: gist?.html_url,
    files: Object.fromEntries(Object.entries(gist?.files || {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, file]) => [key, {
        filename: file?.filename,
        raw_url: file?.raw_url,
        size: file?.size,
        type: file?.type,
        language: file?.language ?? null,
      }])),
  })).sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
}

export function canonicalSourceObservation(observation, { seal = true } = {}) {
  const repositories = sourceSetObservation(canonicalRepositoryRows(observation?.repositories?.rows),
    observation?.repositories?.expected);
  const gists = sourceSetObservation(canonicalGistRows(observation?.gists?.rows), observation?.gists?.expected);
  const stable = {
    schemaVersion: observation?.schemaVersion,
    kind: observation?.kind,
    owner: observation?.owner,
    observedAt: observation?.observedAt,
    repositories,
    gists,
  };
  if (!seal) return stable;
  return { ...stable, observationSha256: sourceObservationDigest(stable) };
}

export function gistVersion(gist) {
  const versions = Object.values(gist.files || {}).flatMap((file) => {
    const match = String(file.raw_url || '').match(/\/raw\/([0-9a-f]{7,64})\//i);
    return match ? [match[1]] : [];
  });
  return versions.length && new Set(versions).size === 1 ? versions[0] : null;
}

// Test seam: same injection pattern as `gh = runGh` above, so the fallback's failure path is
// exercisable with a fake HTTP layer instead of the live API or even real loopback networking.
// Reads the API base fresh per call (not frozen at module load) for the same reason.
function runCurl(url) {
  const result = spawnSync('curl', ['-sS', '--max-time', '30', '-H', 'accept: application/vnd.github+json',
    '-H', 'user-agent: ruvnet-brain-source-coverage', url],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 35_000 });
  if (result.status !== 0) throw new Error(`unauthenticated gists list failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

// Actions' GITHUB_TOKEN is a GitHub App token, and the gists list API is closed to those
// ("Resource not accessible by integration", HTTP 403 — confirmed live 2026-09-13, corpus-seed.yml's
// first-ever run). Public gists need no auth, so fall back to curl against the plain API on that
// specific failure, mirroring ingest-gists.mjs's already-working listGists/listGistsPublic split
// (kept synchronous here, matching this module's existing gh-injection style, rather than
// threading async through observeSourceUniverse/buildCoverage's whole synchronous call chain).
//
// ADR-086 Step 12 (A1): the former `page <= 10` bound was NOT a silent-omission bug — observeGists
// throws on rows.length !== public_gists, so beyond 1000 gists the run failed closed — but it was a
// ceiling the account could grow into. Pagination now runs to the ACTUAL end: the only terminator is
// an EMPTY page (a short page followed by more must not stop early), under a hard ceiling that
// THROWS rather than truncating. The rows.length === public_gists check below remains the one and
// only completeness proof; nothing here adds a second invariant.
const GIST_PAGE_CEILING = 100; // 10,000 gists at per_page=100

function listGistsUnauthenticated(owner, curl) {
  const apiBase = process.env.RUVNET_GISTS_API || 'https://api.github.com';
  const pages = [];
  for (let page = 1; ; page++) {
    if (page > GIST_PAGE_CEILING) {
      throw new Error(`unauthenticated gists list exceeded ${GIST_PAGE_CEILING} pages without reaching an empty page`);
    }
    const parsed = JSON.parse(curl(`${apiBase}/users/${owner}/gists?per_page=100&page=${page}`));
    if (parsed?.message) throw new Error(`unauthenticated gists list failed: ${parsed.message}`);
    if (!Array.isArray(parsed)) throw new Error('unauthenticated gists list returned an unexpected shape');
    pages.push(parsed); // the empty terminal page is kept: it is the receipt that the end was reached
    if (parsed.length === 0) break;
  }
  return pages;
}

export function observeGists(owner, { gh = runGh, curl = runCurl } = {}) {
  let pages;
  try {
    const raw = gh(['api', `users/${owner}/gists?per_page=100`, '--paginate', '--slurp']);
    const parsed = JSON.parse(raw);
    pages = Array.isArray(parsed[0]) ? parsed : [parsed];
  } catch (error) {
    if (!/resource not accessible by integration|HTTP 403/i.test(String(error.message))) throw error;
    pages = listGistsUnauthenticated(owner, curl);
  }
  const rows = pages.flat().filter((gist) => gist?.id);
  // Identity, not completeness (A1 forbids a second completeness invariant): a gist listed twice is
  // collection-time source movement shifting pages under the cursor, and the same id could then mask
  // a missed one inside an equal count. Mirrors the duplicate-repository check in observeSourceUniverse.
  const ids = rows.map((gist) => String(gist.id));
  if (new Set(ids).size !== ids.length) throw new Error('gist enumeration returned duplicate gist identities (collection-time source movement)');
  const expected = Number(JSON.parse(gh(['api', `users/${owner}`])).public_gists);
  if (rows.length !== expected) throw new Error(`gist enumeration incomplete: ${rows.length}/${expected}`);
  return {
    rows,
    expected,
    pages: pages.map((page, index) => ({ index: index + 1, responseDigest: digest(page), count: page.length,
      terminal: index === pages.length - 1 })),
  };
}

function storeName(name) { return String(name).toLowerCase(); }

// A no-corpus exclusion is admissible only with INDEPENDENT source-file evidence bound to the exact
// revision it excludes: the file inventory actually read from the repository tree at the observed
// head. "0 chunks produced" is an extraction outcome, not proof of an empty source (Dual, Step 12).
// A record that matches pushedAt but carries no such evidence is a malformed policy entry, and it
// throws — it must never quietly remove a source from the collected set.
function assertExclusionEvidence(repo, exclusion, upstreamSha) {
  const evidence = exclusion?.evidence;
  const sha = String(evidence?.headSha || '');
  if (!evidence || typeof evidence !== 'object' || !Array.isArray(evidence.files) || typeof evidence.inspectedAt !== 'string'
      || typeof evidence.method !== 'string') {
    throw new Error(`no-corpus exclusion for ${repo.name} is active but carries no source-file evidence ` +
      '(zero extracted chunks is not proof of an empty source)');
  }
  if (!/^[0-9a-f]{40}$/i.test(sha) || sha.toLowerCase() !== String(upstreamSha || '').toLowerCase()) {
    throw new Error(`no-corpus exclusion for ${repo.name}: evidence headSha ${sha || '(none)'} is not the observed head ${upstreamSha}`);
  }
}

export function classifyRepository(repo, evidence, exclusion = null) {
  const upstreamSha = repo.defaultBranchRef?.target?.oid || null;
  const activeExclusion = Boolean(exclusion && String(exclusion.pushedAt || '') !== ''
    && String(exclusion.pushedAt) === String(repo.pushedAt || ''));
  if (activeExclusion) assertExclusionEvidence(repo, exclusion, upstreamSha);
  if (repo.isFork && repo.defaultBranchRef && !repo.forkDelta) {
    throw new Error(`fork ${repo.name} was observed without a fork delta — the observation predates policy ${SOURCE_POLICY_VERSION} or skipped the compare`);
  }
  // Policy 2: archives are eligible unconditionally (no `archived` branch); forks are dispositioned
  // by their delta. Order: an explicit exclusion wins, then GitHub-side unavailability, then emptiness
  // (a fork with no head has nothing to compare), then the fork delta, then eligible.
  const disposition = activeExclusion ? 'excluded-no-corpus'
    : repo.isDisabled ? 'disabled'
      : !repo.defaultBranchRef ? 'empty'
        : repo.isFork ? (repo.forkDelta.aheadBy > 0 ? 'fork:original-content' : 'fork:no-original-content')
          : 'eligible';
  const reasons = [];
  let status = 'CURRENT';
  if (!isIngestibleDisposition(disposition)) {
    status = 'INELIGIBLE';
    if (disposition === 'excluded-no-corpus' && exclusion?.reason) reasons.push(exclusion.reason);
    else if (disposition === 'disabled') reasons.push('repository is disabled by GitHub');
    else if (disposition === 'empty') reasons.push('repository has no default branch — no commits to collect');
    else if (disposition === 'fork:no-original-content') {
      reasons.push(`fork of ${repo.forkDelta.upstream}: 0 commits ahead of upstream ${repo.forkDelta.upstreamHeadSha.slice(0, 12)} — contains no original content`);
    }
  }
  else if (!evidence.rvfPresent) { status = 'MISSING'; reasons.push('canonical RVF is absent'); }
  else if (!evidence.receipt?.sourceCommit) { status = 'UNVERIFIED'; reasons.push('RVF receipt has no sourceCommit'); }
  else if (evidence.receipt.sourceCommit !== upstreamSha) { status = 'STALE'; reasons.push('receipt sourceCommit differs from upstream HEAD'); }
  else if (!evidence.bytesVerified) { status = 'FAILED'; reasons.push('RVF bytes do not match receipt'); }
  else if (!evidence.passagesPresent) { status = 'FAILED'; reasons.push('passage inventory is absent'); }
  if (status === 'CURRENT' && disposition === 'fork:original-content') {
    const expected = forkDeltaIdentityFor({ url: repo.url, forkDelta: repo.forkDelta, upstream: { sha: upstreamSha } });
    if (!forkDeltaMatches(evidence.receipt, expected)) {
      status = 'UNVERIFIED'; reasons.push('delta-only receipt does not bind the observed fork and upstream baseline');
    } else if (!evidence.forkBytesVerified) {
      status = 'FAILED'; reasons.push('fork inventory or passages do not match the delta receipt');
    }
  }
  return {
    key: repo.fullName ? `repo:${repo.fullName.toLowerCase()}` : `repo:${repo.databaseId}`,
    kind: 'repository',
    name: repo.name,
    url: repo.url,
    routing: { description: repo.description || null, homepageUrl: repo.homepageUrl || null,
      capabilityCardPresent: evidence.cardPresent === true },
    disposition,
    archived: repo.isArchived === true,
    ...(repo.forkDelta ? { forkDelta: { ...repo.forkDelta } } : {}),
    upstream: { sha: upstreamSha, committedAt: repo.defaultBranchRef?.target?.committedDate || null,
      pushedAt: repo.pushedAt, updatedAt: repo.updatedAt },
    artifact: { ...(evidence.receipt?.sourceMode ? { sourceMode: evidence.receipt.sourceMode, forkDelta: evidence.receipt.forkDelta } : {}), store: storeName(repo.storeName || repo.name), sourceCommit: evidence.receipt?.sourceCommit || null,
      ingestedAt: evidence.receipt?.builtUtc || null, rvfSha256: evidence.receipt?.sha256 || null,
      bytesVerified: evidence.bytesVerified, passagesPresent: evidence.passagesPresent,
      cardPresent: evidence.cardPresent },
    status,
    reasons,
  };
}

export function classifyGist(gist, evidence) {
  const source = evidence.sources?.gists?.[gist.id] || null;
  const ingestedAt = source?.ingestedAt || null;
  // The list API does not expose gist history.version. A just-fetched individual source receipt is
  // still the authoritative version when the live list's updated_at is unchanged; otherwise the
  // list proves drift and the row is stale until the individual gist is refreshed.
  //
  // 2026-09-13 (Step 4, rule 2): a flat timestamp cache (`.ruv-gists.cache.json` -- "we last saw
  // this updated_at at some point") is NEVER consulted here anymore. It used to OR into
  // `currentByDate`, so a gist could be classified CURRENT purely because a bare cache file claimed
  // a date matched -- with no binding whatsoever to the gist's actual captured/rendered content.
  // Currency is now provable ONLY from the real, already-validated per-gist source receipt (Step 2's
  // schema-3 `ruv-gists.sources.json`): its own `updatedAt` field must equal the live list's.
  const version = source?.updatedAt === gist.updated_at ? source.versionSha : gistVersion(gist);
  const currentByDate = source?.updatedAt === gist.updated_at;
  let status = 'CURRENT';
  const reasons = [];
  if (!evidence.rvfPresent) { status = 'MISSING'; reasons.push('ruv-gists RVF is absent'); }
  else if (!evidence.receipt || !source || !version) { status = 'UNVERIFIED'; reasons.push('per-gist source receipt is absent'); }
  else if (!evidence.bytesVerified) { status = 'FAILED'; reasons.push('ruv-gists RVF bytes do not match the generation receipt'); }
  else if (!evidence.passagesBound) { status = 'FAILED'; reasons.push('gist passages do not match the source receipt'); }
  else if (!source.complete) { status = 'FAILED'; reasons.push('per-gist source receipt is incomplete'); }
  else if (source.versionSha !== version || !currentByDate) { status = 'STALE'; reasons.push('ingested gist identity differs from upstream'); }
  const filenames = Object.values(gist.files || {}).map((file) => file?.filename).filter(Boolean).sort();
  return {
    key: `gist:${gist.id}`,
    kind: 'gist',
    name: Object.values(gist.files || {})[0]?.filename || gist.id,
    url: gist.html_url,
    disposition: 'eligible',
    upstream: { sha: version, updatedAt: gist.updated_at, fileCount: filenames.length, files: filenames },
    artifact: { store: 'ruv-gists', sourceCommit: source?.versionSha || null, ingestedAt: source?.ingestedAt || ingestedAt,
      contentDigest: source?.contentDigest || null, fileCount: source?.files?.length || null,
      rvfSha256: evidence.receipt?.sha256 || null, bytesVerified: evidence.bytesVerified },
    status,
    reasons,
  };
}

// ALIAS-AWARE, BECAUSE THE ROUTER IS. `cardStores` holds card HEADINGS; a store reachable only
// under an alias (e.g. `metaharness` via its `## agent-harness-generator` card) has no heading of
// its own, so a direct `cardStores.has(store)` reports it card-absent even though the router finds
// it. `kb/store-root.mjs`'s `darkStores()` and `scripts/brain-score.mjs`'s `readCoverage()` were
// already fixed for this exact conflation (ADR-058; metaharness is the standing example in both);
// this sibling computation, which feeds the committed `data/source-coverage.json` and
// `docs/RUVNET-COVERAGE.md` (ADR-069), never received it. `repositoryNames` is the router's own
// resolver (kb/card-lane.mjs), imported rather than reimplemented.
export function artifactEvidence(kbDir, ledger, cardStores, name) {
  const store = storeName(name);
  const receipt = Object.entries(ledger.stores).find(([key]) => key.toLowerCase() === store)?.[1] || null;
  const rvfFile = receipt?.file || `${store}.big.rvf`;
  const rvfPath = path.join(kbDir, rvfFile);
  const rvfPresent = fs.existsSync(rvfPath) && fs.lstatSync(rvfPath).isFile();
  return {
    receipt,
    rvfPresent,
    bytesVerified: Boolean(rvfPresent && receipt?.sha256 && sha256File(rvfPath) === receipt.sha256),
    passagesPresent: fs.existsSync(path.join(kbDir, `${store}.passages.jsonl`))
      && fs.statSync(path.join(kbDir, `${store}.passages.jsonl`)).size > 0,
    forkBytesVerified: ['passages', 'inventory'].every(kind => {
      const file = path.join(kbDir, `${store}${kind === 'passages' ? '.passages.jsonl' : '.fork-delta.inventory.json'}`);
      return fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()
        && receipt?.forkDelta?.[`${kind}Sha256`] === sha256File(file);
    }),
    cardPresent: repositoryNames(store, kbDir).some((alias) => cardStores.has(storeName(alias))),
  };
}

export function renderMarkdown(coverage) {
  const counts = coverage.totals.byStatus;
  const lines = [
    '# RuvNet Brain source coverage', '',
    `Generated: ${coverage.observedAt}  `,
    `Coverage generation: \`${coverage.coverageGeneration}\`  `,
    `Source policy version: ${coverage.policy?.policyVersion ?? 1}  `,
    `Repositories: ${coverage.totals.repositories} · Gists: ${coverage.totals.gists} · ` +
      Object.entries(counts).sort().map(([state, count]) => `${state} ${count}`).join(' · '), '',
    '> `CURRENT` is artifact-bound. Clone state and timestamps alone never establish freshness.', '',
    '## Repositories', '',
    '| Repository | Upstream updated | Upstream SHA | Ingested | Ingested SHA | State | Reason |',
    '|---|---:|---|---:|---|---|---|',
  ];
  for (const row of coverage.rows.filter((entry) => entry.kind === 'repository')) {
    const marker = row.archived ? ' _(archived)_' : '';
    lines.push(`| [${row.name}](${row.url})${marker} | ${row.upstream.committedAt || row.upstream.updatedAt || '—'} | ${row.upstream.sha || '—'} | ${row.artifact.ingestedAt || '—'} | ${row.artifact.sourceCommit || '—'} | ${row.status} | ${row.reasons.join('; ') || row.disposition} |`);
  }
  lines.push('', '## Public gists', '',
    '| Gist | Upstream updated | Version SHA | Ingested update | State | Reason |',
    '|---|---:|---|---:|---|---|');
  for (const row of coverage.rows.filter((entry) => entry.kind === 'gist')) {
    lines.push(`| [${row.name}](${row.url}) | ${row.upstream.updatedAt || '—'} | ${row.upstream.sha || '—'} | ${row.artifact.ingestedAt || '—'} | ${row.status} | ${row.reasons.join('; ') || '—'} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function sealCoverage({ owner, repositories, gists, rows, generatorSourceSha, snapshotRoot, observedAt,
  sourceObservationSha256 = null,
  policyDispositionDigests = [], exemptionDigests = [] }) {
  const enumerationReceipt = {
    schemaVersion: 1, owner, observedAt, requestParameters: { repositoryPageSize: 100, gistPageSize: 100 },
    repositories: { expected: repositories.expected, pages: repositories.pages },
    gists: { expected: gists.expected, pages: gists.pages },
    duplicateKeys: rows.length - new Set(rows.map((row) => row.key)).size,
    terminal: true,
  };
  const orderedRows = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  const byStatus = Object.fromEntries([...new Set(orderedRows.map((row) => row.status))].sort()
    .map((status) => [status, orderedRows.filter((row) => row.status === status).length]));
  return { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', owner, observedAt, generatorSourceSha,
    sourceObservationSha256, snapshotRoot,
    policy: { policyVersion: SOURCE_POLICY_VERSION, policyDispositionDigests, exemptionDigests },
    coverageGeneration: coverageGenerationFor({ generatorSourceSha, snapshotRoot, sourceObservationSha256, rows: orderedRows,
      enumerationReceipt, policyDispositionDigests, exemptionDigests }), enumerationReceipt, rows: orderedRows,
    totals: { repositories: repositories.expected, gists: gists.expected, rows: orderedRows.length, byStatus } };
}

// IDENTITY ACCOUNTING between a recorded coverage and a fresh one. Row keys are the stable identity
// (`repo:<databaseId>` for the owner's repositories — a rename keeps the key and changes the name;
// `repo:<owner/name>` for configured external sources, where a rename reads as remove + add; `gist:<id>`).
// This is how "zero unexplained omissions" is made checkable: every repository or gist that left the
// set since the recorded measurement is NAMED, never silently absent from a diff.
export function diffCoverageIdentities(recorded, current) {
  const index = (coverage, kind) => new Map((coverage?.rows || []).filter((row) => row.kind === kind)
    .map((row) => [row.key, row.name]));
  const identity = ([key, name]) => ({ key, name });
  const account = (kind, withRenames) => {
    const before = index(recorded, kind);
    const after = index(current, kind);
    const result = {
      added: [...after].filter(([key]) => !before.has(key)).map(identity),
      removed: [...before].filter(([key]) => !after.has(key)).map(identity),
    };
    if (withRenames) {
      result.renamed = [...after].filter(([key, name]) => before.has(key) && before.get(key) !== name)
        .map(([key, to]) => ({ key, from: before.get(key), to }));
    }
    return result;
  };
  return { repositories: account('repository', true), gists: account('gist', false) };
}

// What `--check` prints when the recorded projection differs from the live observation: the named
// identity differences and the policy-version gap. A recorded coverage produced under an older
// SOURCE_POLICY_VERSION is stale BY CONSTRUCTION — its rows were classified by different rules — and
// that must be said out loud, not left as an unexplained byte mismatch.
export function explainCoverageDrift(recorded, current) {
  const diff = diffCoverageIdentities(recorded, current);
  const list = (rows) => (rows.length ? ` (${rows.map((row) => `${row.key} ${row.name}`).join(', ')})` : '');
  const recordedPolicy = recorded?.policy?.policyVersion ?? 1;
  const currentPolicy = current?.policy?.policyVersion ?? SOURCE_POLICY_VERSION;
  const recordedRows = new Map((recorded?.rows || []).map((row) => [row.key, canonicalJson(row)]));
  const changed = (current?.rows || []).filter((row) => recordedRows.has(row.key) && recordedRows.get(row.key) !== canonicalJson(row));
  const lines = [
    `recorded ${recorded?.observedAt || '(unknown)'} vs live ${current?.observedAt || '(unknown)'}`,
    `rows changed in content: ${changed.length}${changed.length ? ` (first: ${changed.slice(0, 5).map((row) => row.key).join(', ')})` : ''}`,
    `repositories: +${diff.repositories.added.length} added${list(diff.repositories.added)}, ` +
      `-${diff.repositories.removed.length} removed${list(diff.repositories.removed)}, ` +
      `${diff.repositories.renamed.length} renamed${diff.repositories.renamed.length
        ? ` (${diff.repositories.renamed.map((row) => `${row.key} ${row.from} -> ${row.to}`).join(', ')})` : ''}`,
    `gists: +${diff.gists.added.length} added, -${diff.gists.removed.length} removed${list(diff.gists.removed)}`,
  ];
  if (recordedPolicy !== currentPolicy) {
    lines.push(`recorded policyVersion ${recordedPolicy} != current policyVersion ${currentPolicy}: the recorded ` +
      'measurement was classified under an older eligibility policy and is stale by construction; the next pipeline ' +
      'run will produce the new shape (archives eligible, forks dispositioned by compare, exclusions evidence-bound)');
  }
  return lines;
}

// The measured directory defaults to THE store root (kb/store-root.mjs) — the one every reader,
// writer and installer resolves — never `<repo>/kb`, which store-root.mjs declares a build workspace
// and "never a second brain". Measured 2026-09-11: three commits projected a dirty workspace as the
// brain (476 of 719 rows FAILED) while the canonical root matched every receipt. Policy files stay
// where they are source-controlled (`<repo>/kb`) unless the caller names both directories, as the
// release path does with `--assets`.
export function buildCoverage({ owner = 'ruvnet', env = process.env, home = os.homedir(), kbDir = null, policyDir = null,
  observation = null, gh = runGh, now = () => new Date().toISOString() } = {}) {
  policyDir ??= kbDir ?? path.join(ROOT, 'kb');
  kbDir ??= storeRoot(env, home);
  if (rootNeverMaterialized(kbDir)) {
    throw new Error(`store root ${kbDir} does not exist — set RUVNET_BRAIN_KB or pass --assets <dir>; ` +
      'the build workspace <repo>/kb is never measured by default');
  }
  const externalPath = path.join(policyDir, 'external-sources.json');
  const externalPolicy = fs.existsSync(externalPath) ? JSON.parse(fs.readFileSync(externalPath, 'utf8')) : { sources: [] };
  if (!Array.isArray(externalPolicy.sources)) throw new Error('external-sources.json has no sources array');
  const suppliedObservation = observation || observeSourceUniverse({
    owner, externalSources: externalPolicy.sources, gh, observedAt: now(),
  });
  if (suppliedObservation?.kind !== 'ruvnet-brain-source-observation'
      || suppliedObservation.owner !== owner
      || suppliedObservation.observationSha256 !== sourceObservationDigest(suppliedObservation)) {
    throw new Error('source observation identity is missing or invalid');
  }
  const sourceObservation = canonicalSourceObservation(suppliedObservation);
  const repositories = sourceObservation.repositories;
  const gists = sourceObservation.gists;
  const ledger = readRvfGenerations(kbDir);
  const cards = fs.readFileSync(path.join(kbDir, 'capability-cards.md'), 'utf8');
  const cardStores = new Set([...cards.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => storeName(match[1])));
  const gistSourcesPath = path.join(kbDir, 'ruv-gists.sources.json');
  const gistSources = fs.existsSync(gistSourcesPath) ? JSON.parse(fs.readFileSync(gistSourcesPath, 'utf8')) : null;
  const exclusionsPath = path.join(policyDir, 'no-corpus-repos.json');
  const exclusions = fs.existsSync(exclusionsPath) ? JSON.parse(fs.readFileSync(exclusionsPath, 'utf8')) : {};
  const rows = repositories.rows.map((repo) => {
    const store = storeName(repo.storeName || repo.name);
    return classifyRepository(repo, artifactEvidence(kbDir, ledger, cardStores, store), exclusions[store] || null);
  });
  const gistEvidence = { ...artifactEvidence(kbDir, ledger, cardStores, 'ruv-gists'), sources: gistSources };
  try {
    validateGistAggregateReceipt({ receipt: gistSources,
      passagesFile: path.join(kbDir, 'ruv-gists.passages.jsonl'),
      expectedIds: gists.rows.map(({ id }) => id),
      sourceObservationSha256: sourceObservation.observationSha256 });
    gistEvidence.passagesBound = true;
  } catch {
    gistEvidence.passagesBound = false;
  }
  rows.push(...gists.rows.map((gist) => classifyGist(gist, gistEvidence)));
  const generatorSourceSha = sha256File(fileURLToPath(import.meta.url));
  const snapshotRoot = digest({ stores: ledger.stores, files: rows.filter((row) => row.kind === 'repository')
    .map((row) => ({ store: row.artifact.store, sha256: row.artifact.rvfSha256 })) });
  return sealCoverage({ owner, repositories, gists, rows, generatorSourceSha, snapshotRoot,
    observedAt: sourceObservation.observedAt, sourceObservationSha256: sourceObservation.observationSha256,
    policyDispositionDigests: fs.existsSync(externalPath) ? [sha256File(externalPath)] : [],
    exemptionDigests: fs.existsSync(exclusionsPath) ? [sha256File(exclusionsPath)] : [] });
}

export async function main(argv = process.argv.slice(2)) {
  const ownerIndex = argv.indexOf('--owner');
  const owner = ownerIndex >= 0 ? argv[ownerIndex + 1] : 'ruvnet';
  const assetsIndex = argv.indexOf('--assets');
  // `--assets <dir>` names a release candidate: measure it and take policy from it, exactly as before.
  // Otherwise measure the installed brain and take policy from the repository.
  const kbDir = assetsIndex >= 0 ? path.resolve(argv[assetsIndex + 1]) : storeRoot();
  const policyDir = assetsIndex >= 0 ? kbDir : path.join(ROOT, 'kb');
  const jsonPath = path.join(ROOT, 'data', 'source-coverage.json');
  const markdownPath = path.join(ROOT, 'docs', 'RUVNET-COVERAGE.md');
  const recorded = argv.includes('--check') && fs.existsSync(jsonPath)
    ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
  console.error(`measuring ${kbDir} (policy from ${policyDir})`);
  const coverage = buildCoverage({ owner, kbDir, policyDir,
    now: recorded?.observedAt ? () => recorded.observedAt : () => new Date().toISOString() });
  const json = `${JSON.stringify(coverage, null, 2)}\n`;
  const markdown = renderMarkdown(coverage);
  if (argv.includes('--check')) {
    const matches = fs.existsSync(jsonPath) && fs.readFileSync(jsonPath, 'utf8') === json &&
      fs.existsSync(markdownPath) && fs.readFileSync(markdownPath, 'utf8') === markdown;
    const blockers = coverage.rows.filter((row) => isIngestibleDisposition(row.disposition) && row.status !== 'CURRENT');
    if (!matches) {
      console.error('source coverage projections differ from live observation');
      for (const line of explainCoverageDrift(recorded, coverage)) console.error(`  ${line}`);
    }
    if (argv.includes('--strict') && blockers.length) console.error(`strict coverage: ${blockers.length} eligible row(s) are not CURRENT`);
    return matches && (!argv.includes('--strict') || blockers.length === 0) ? 0 : 1;
  }
  fs.writeFileSync(jsonPath, json);
  fs.writeFileSync(markdownPath, markdown);
  console.log(`wrote ${path.relative(ROOT, markdownPath)} (${coverage.rows.length} rows, ${coverage.coverageGeneration})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
