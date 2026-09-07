#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRvfGenerations, sha256File } from './rvf-generation.mjs';
import { canonicalJson, coverageGenerationFor, digest, validateGistAggregateReceipt } from './coverage-integrity.mjs';
import { repositoryNames } from '../kb/card-lane.mjs';

export { canonicalJson, digest } from './coverage-integrity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_QUERY = `query($login:String!,$cursor:String){
  user(login:$login){
    publicRepositories:repositories(privacy:PUBLIC){totalCount}
    repositories(first:100,after:$cursor,privacy:PUBLIC,ownerAffiliations:OWNER,orderBy:{field:NAME,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{databaseId name url description homepageUrl isFork isArchived isDisabled diskUsage updatedAt pushedAt
        defaultBranchRef{name target{... on Commit{oid committedDate}}}}
    }
  }
}`;

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  return result.stdout;
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
  return { rows, expected, pages };
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

export function observeGists(owner, { gh = runGh } = {}) {
  const raw = gh(['api', `users/${owner}/gists?per_page=100`, '--paginate', '--slurp']);
  const parsed = JSON.parse(raw);
  const pages = Array.isArray(parsed[0]) ? parsed : [parsed];
  const rows = pages.flat().filter((gist) => gist?.id);
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

export function classifyRepository(repo, evidence, exclusion = null) {
  const activeExclusion = exclusion && String(exclusion.pushedAt || '') !== ''
    && String(exclusion.pushedAt) === String(repo.pushedAt || '');
  const disposition = activeExclusion ? 'excluded-no-corpus' : repo.isFork ? 'fork' : repo.isArchived ? 'archived' :
    repo.isDisabled ? 'disabled' : !repo.defaultBranchRef ? 'empty' : 'eligible';
  const upstreamSha = repo.defaultBranchRef?.target?.oid || null;
  const reasons = [];
  let status = 'CURRENT';
  if (disposition !== 'eligible') {
    status = 'INELIGIBLE';
    if (activeExclusion && exclusion?.reason) reasons.push(exclusion.reason);
  }
  else if (!evidence.rvfPresent) { status = 'MISSING'; reasons.push('canonical RVF is absent'); }
  else if (!evidence.receipt?.sourceCommit) { status = 'UNVERIFIED'; reasons.push('RVF receipt has no sourceCommit'); }
  else if (evidence.receipt.sourceCommit !== upstreamSha) { status = 'STALE'; reasons.push('receipt sourceCommit differs from upstream HEAD'); }
  else if (!evidence.bytesVerified) { status = 'FAILED'; reasons.push('RVF bytes do not match receipt'); }
  else if (!evidence.passagesPresent) { status = 'FAILED'; reasons.push('passage inventory is absent'); }
  return {
    key: repo.fullName ? `repo:${repo.fullName.toLowerCase()}` : `repo:${repo.databaseId}`,
    kind: 'repository',
    name: repo.name,
    url: repo.url,
    routing: { description: repo.description || null, homepageUrl: repo.homepageUrl || null,
      capabilityCardPresent: evidence.cardPresent === true },
    disposition,
    upstream: { sha: upstreamSha, committedAt: repo.defaultBranchRef?.target?.committedDate || null,
      pushedAt: repo.pushedAt, updatedAt: repo.updatedAt },
    artifact: { store: storeName(repo.storeName || repo.name), sourceCommit: evidence.receipt?.sourceCommit || null,
      ingestedAt: evidence.receipt?.builtUtc || null, rvfSha256: evidence.receipt?.sha256 || null,
      bytesVerified: evidence.bytesVerified, passagesPresent: evidence.passagesPresent,
      cardPresent: evidence.cardPresent },
    status,
    reasons,
  };
}

export function classifyGist(gist, evidence) {
  const source = evidence.sources?.gists?.[gist.id] || null;
  const ingestedAt = source?.ingestedAt || evidence.cache?.[gist.id] || null;
  // The list API does not expose gist history.version. A just-fetched individual source receipt is
  // still the authoritative version when the live list's updated_at is unchanged; otherwise the
  // list proves drift and the row is stale until the individual gist is refreshed.
  const version = source?.updatedAt === gist.updated_at ? source.versionSha : gistVersion(gist);
  const currentByDate = source?.updatedAt === gist.updated_at || evidence.cache?.[gist.id] === gist.updated_at;
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
    cardPresent: repositoryNames(store, kbDir).some((alias) => cardStores.has(storeName(alias))),
  };
}

export function renderMarkdown(coverage) {
  const counts = coverage.totals.byStatus;
  const lines = [
    '# RuvNet Brain source coverage', '',
    `Generated: ${coverage.observedAt}  `,
    `Coverage generation: \`${coverage.coverageGeneration}\`  `,
    `Repositories: ${coverage.totals.repositories} · Gists: ${coverage.totals.gists} · ` +
      Object.entries(counts).sort().map(([state, count]) => `${state} ${count}`).join(' · '), '',
    '> `CURRENT` is artifact-bound. Clone state and timestamps alone never establish freshness.', '',
    '## Repositories', '',
    '| Repository | Upstream updated | Upstream SHA | Ingested | Ingested SHA | State | Reason |',
    '|---|---:|---|---:|---|---|---|',
  ];
  for (const row of coverage.rows.filter((entry) => entry.kind === 'repository')) {
    lines.push(`| [${row.name}](${row.url}) | ${row.upstream.committedAt || row.upstream.updatedAt || '—'} | ${row.upstream.sha || '—'} | ${row.artifact.ingestedAt || '—'} | ${row.artifact.sourceCommit || '—'} | ${row.status} | ${row.reasons.join('; ') || row.disposition} |`);
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
    policy: { policyDispositionDigests, exemptionDigests },
    coverageGeneration: coverageGenerationFor({ generatorSourceSha, snapshotRoot, sourceObservationSha256, rows: orderedRows,
      enumerationReceipt, policyDispositionDigests, exemptionDigests }), enumerationReceipt, rows: orderedRows,
    totals: { repositories: repositories.expected, gists: gists.expected, rows: orderedRows.length, byStatus } };
}

export function buildCoverage({ owner = 'ruvnet', kbDir = path.join(ROOT, 'kb'), policyDir = kbDir,
  observation = null, gh = runGh, now = () => new Date().toISOString() } = {}) {
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
  const gistCachePath = path.join(kbDir, '.ruv-gists.cache.json');
  const gistCache = fs.existsSync(gistCachePath) ? JSON.parse(fs.readFileSync(gistCachePath, 'utf8')) : {};
  const gistSourcesPath = path.join(kbDir, 'ruv-gists.sources.json');
  const gistSources = fs.existsSync(gistSourcesPath) ? JSON.parse(fs.readFileSync(gistSourcesPath, 'utf8')) : null;
  const exclusionsPath = path.join(policyDir, 'no-corpus-repos.json');
  const exclusions = fs.existsSync(exclusionsPath) ? JSON.parse(fs.readFileSync(exclusionsPath, 'utf8')) : {};
  const rows = repositories.rows.map((repo) => {
    const store = storeName(repo.storeName || repo.name);
    return classifyRepository(repo, artifactEvidence(kbDir, ledger, cardStores, store), exclusions[store] || null);
  });
  const gistEvidence = { ...artifactEvidence(kbDir, ledger, cardStores, 'ruv-gists'), cache: gistCache, sources: gistSources };
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
  const kbDir = path.resolve(assetsIndex >= 0 ? argv[assetsIndex + 1] : path.join(ROOT, 'kb'));
  const jsonPath = path.join(ROOT, 'data', 'source-coverage.json');
  const markdownPath = path.join(ROOT, 'docs', 'RUVNET-COVERAGE.md');
  const recorded = argv.includes('--check') && fs.existsSync(jsonPath)
    ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
  const coverage = buildCoverage({ owner, kbDir,
    now: recorded?.observedAt ? () => recorded.observedAt : () => new Date().toISOString() });
  const json = `${JSON.stringify(coverage, null, 2)}\n`;
  const markdown = renderMarkdown(coverage);
  if (argv.includes('--check')) {
    const matches = fs.existsSync(jsonPath) && fs.readFileSync(jsonPath, 'utf8') === json &&
      fs.existsSync(markdownPath) && fs.readFileSync(markdownPath, 'utf8') === markdown;
    const blockers = coverage.rows.filter((row) => row.disposition === 'eligible' && row.status !== 'CURRENT');
    if (!matches) console.error('source coverage projections differ from live observation');
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
