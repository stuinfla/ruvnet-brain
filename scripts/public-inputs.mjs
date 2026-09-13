#!/usr/bin/env node
// public-inputs.mjs — the ONE canonical public-prose selection pipeline (Step 3 of the
// corpus-seed/release pipeline consolidation, 2026-09-13).
//
// Before this, "what prose ships to end users" was decided independently in at least three places
// with three different filters: scripts/build-concepts.mjs (its own chunker/fence),
// scripts/corpus-aggregates.mjs's buildConceptAggregate (a second, different transformation that
// ALSO re-derived the private fence from PRIVATE-STORES.json/l2-topics.*.json), and
// scripts/build-bundle.mjs (a THIRD independent card filter plus wholesale, unfenced-by-itself
// copies of kb/l2 and kb/repo-aliases.json straight from the checkout). Two more bugs rode along
// for free: scripts/corpus-reconcile.mjs's syncCorpusInputs OVERLAID primers/l2-topics files onto
// whatever a prior round had left behind (a deleted seed input never disappeared), and
// build-bundle.mjs shipped a circular, self-referencing concepts.sources.json whenever the real one
// was absent (its only declared "input" was its own packaged output).
//
// materializePublicInputs is now the single place that decides what public prose exists. It builds
// a FRESH tree every call (positive selection — nothing is retained just because it was there last
// time), reuses scripts/private-fence.mjs's already-tested fence decisions directly (never
// reimplements them), and returns a PUBLIC selection receipt that proves what was excluded — by
// digest only, never by content — plus a resolved topic-ownership map every derived-store builder
// can trust instead of re-deriving.
//
// Two policies, kept deliberately separate (rule 5 of the Step 3 spec): this file decides PUBLIC
// PROSE eligibility (what text ships). scripts/source-coverage.mjs / scripts/corpus-reconcile.mjs's
// planReconciliation decide CODE-INGESTION eligibility (which repos/gists enter the corpus at all).
// Neither derives the other.
//
// SAFE TO CALL WITH outDir POINTING AT builderRoot's OWN kb/ (a plain local `node
// scripts/build-concepts.mjs` or `node scripts/build-bundle.mjs` run with no --assets uses exactly
// this). Every selected file is copied into a fresh STAGE directory first; nothing under `outDir` is
// removed until the entire stage is built and sealed, so a self-materializing call reads its full
// source before it ever deletes anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, fileIdentity } from './coverage-integrity.mjs';
import { isPrivate, loadPrivateFence, loadPrivateSlugs, shouldFenceL2 } from './private-fence.mjs';
import { promoteArtifactSet } from '../kb/incremental-refresh.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX40 = /^[a-f0-9]{40}$/;

/** Digest+size of an excluded file, WITHOUT its content -- the private-exclusion evidence never
 * carries the bytes it proves were excluded. */
function excludedIdentity(file) {
  const { sha256, bytes } = fileIdentity(file);
  return { sha256, bytes };
}

// Legacy slug ownership that predates per-repo l2-topics.<repo>.json files. Treated exactly like an
// explicit claim by "ruflo" made before anyone else's -- a later repo declaring the SAME slug is
// still a genuine ownership conflict, not a silent override.
const SEED_OWNERSHIP = [
  ['guidance-mechanism', 'ruflo'],
  ['memory-end-to-end', 'ruflo'],
  ['adr-coverage', 'ruflo'],
];

function readTopics(kbDir, repo) {
  const file = path.join(kbDir, `l2-topics.${repo}.json`);
  if (!fs.existsSync(file)) return null;
  let topics;
  try {
    topics = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`materializePublicInputs: ${repo} topics file is corrupt (${error.message})`);
  }
  if (!Array.isArray(topics)) throw new Error(`materializePublicInputs: ${repo} topics file is malformed (expected an array)`);
  return { file, topics };
}

/**
 * Resolve slug -> owning-repo across every repo's topics file, and FAIL on any slug two different
 * repos both claim (rule 4). Runs over EVERY discovered repo, public and private alike, because an
 * ambiguous claim between a public and a private repo is exactly the kind of attribution bug the
 * fence depends on getting right -- it must not be silently resolved by iteration order.
 */
export function resolveTopicOwnership(kbDir, repos) {
  const ownership = new Map(SEED_OWNERSHIP);
  for (const repo of [...repos].sort()) {
    const loaded = readTopics(kbDir, repo);
    if (!loaded) continue;
    for (const topic of loaded.topics) {
      const slug = topic?.slug;
      if (!slug) continue;
      const owner = ownership.get(slug);
      if (owner !== undefined && owner !== repo) {
        throw new Error(
          `materializePublicInputs: conflicting topic ownership -- slug "${slug}" is claimed by both `
          + `"${owner}" and "${repo}"`,
        );
      }
      ownership.set(slug, repo);
    }
  }
  return ownership;
}

function sealSelectionReceipt({ builderSha, generatedAt, included, excluded, ownership }) {
  const payload = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-public-input-selection-receipt',
    builderSha: builderSha || null,
    generatedAt,
    included: {
      primers: [...included.primers].sort(),
      topics: [...included.topics].sort(),
      l2: [...included.l2].sort(),
      cards: [...included.cards].sort(),
      aliases: included.aliases === true,
    },
    excluded: {
      primers: [...excluded.primers].sort((a, b) => a.repo.localeCompare(b.repo)),
      topics: [...excluded.topics].sort((a, b) => a.repo.localeCompare(b.repo)),
      l2: [...excluded.l2].sort((a, b) => a.slug.localeCompare(b.slug)),
      cards: [...excluded.cards].sort((a, b) => a.repo.localeCompare(b.repo)),
    },
    ownership: Object.fromEntries([...ownership.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  return { ...payload, receiptSha256: digest(payload) };
}

/**
 * materializePublicInputs({ builderRoot, policy, outDir, builderSha, now }) -> PublicInputSet
 *
 * Builds a FRESH public-prose tree under `outDir`: capability-cards.md (card-filtered exactly
 * once, here), repo-aliases.json, every non-private `<repo>-primer.md`, every non-private
 * `l2-topics.<repo>.json`, and kb/l2/*.md minus anything shouldFenceL2 excludes -- using
 * scripts/private-fence.mjs's own loadPrivateFence/loadPrivateSlugs/isPrivate/shouldFenceL2
 * directly, never a re-derived copy of that logic.
 *
 * `policy.allowNoFence` is the same documented ALLOW_NO_PRIVATE_FENCE escape hatch private-fence.mjs
 * already defines -- passed straight through.
 */
export function materializePublicInputs({ builderRoot = DEFAULT_ROOT, policy = {}, outDir,
  builderSha = null, now = () => new Date().toISOString() } = {}) {
  const kb = path.join(path.resolve(builderRoot), 'kb');
  const out = path.resolve(outDir || '');
  if (!fs.existsSync(kb) || !fs.statSync(kb).isDirectory()) {
    throw new Error(`materializePublicInputs: builder kb directory is missing (${kb})`);
  }
  if (builderSha !== null && !HEX40.test(String(builderSha))) {
    throw new Error('materializePublicInputs: builderSha must be an exact 40-character commit sha, or null');
  }

  const fence = loadPrivateFence(kb, { allowNoFence: policy.allowNoFence === true });
  if (!fence.ok) throw new Error(`materializePublicInputs: ${fence.reason}`);
  const privateSet = fence.privateSet;
  const slugFence = loadPrivateSlugs(kb, privateSet);
  if (!slugFence.ok) throw new Error(`materializePublicInputs: ${slugFence.reason}`);
  const privateSlugs = slugFence.slugs;

  const allRepos = fs.readdirSync(kb).filter((f) => f.endsWith('-primer.md'))
    .map((f) => f.slice(0, -'-primer.md'.length)).sort();
  const ownership = resolveTopicOwnership(kb, allRepos);

  fs.mkdirSync(out, { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(out), '.public-inputs-'));
  const included = { primers: [], topics: [], l2: [], cards: [], aliases: false };
  const excluded = { primers: [], topics: [], l2: [], cards: [] };
  try {
    for (const repo of allRepos) {
      const src = path.join(kb, `${repo}-primer.md`);
      if (isPrivate(privateSet, repo)) {
        excluded.primers.push({ repo, ...excludedIdentity(src) });
        continue;
      }
      fs.copyFileSync(src, path.join(stage, `${repo}-primer.md`));
      included.primers.push(repo);
    }

    for (const repo of allRepos) {
      const file = path.join(kb, `l2-topics.${repo}.json`);
      if (!fs.existsSync(file)) continue;
      if (isPrivate(privateSet, repo)) {
        excluded.topics.push({ repo, ...excludedIdentity(file) });
        continue;
      }
      fs.copyFileSync(file, path.join(stage, `l2-topics.${repo}.json`));
      included.topics.push(repo);
    }

    fs.mkdirSync(path.join(stage, 'l2'), { recursive: true });
    const l2Src = path.join(kb, 'l2');
    if (fs.existsSync(l2Src)) {
      for (const name of fs.readdirSync(l2Src).filter((f) => f.endsWith('.md')).sort()) {
        const slug = name.slice(0, -3);
        const repo = ownership.get(slug) || 'ruvnet';
        const src = path.join(l2Src, name);
        if (shouldFenceL2({ repo, slug }, privateSet, privateSlugs)) {
          excluded.l2.push({ slug, repo, ...excludedIdentity(src) });
          continue;
        }
        fs.copyFileSync(src, path.join(stage, 'l2', name));
        included.l2.push(slug);
      }
    }

    const cardsSrc = path.join(kb, 'capability-cards.md');
    if (fs.existsSync(cardsSrc)) {
      const raw = fs.readFileSync(cardsSrc, 'utf8');
      const parts = raw.split(/^##\s+/m);
      const kept = [];
      for (const section of parts.slice(1)) {
        const newline = section.indexOf('\n');
        const repo = newline < 0 ? '' : section.slice(0, newline).trim();
        const rendered = `## ${section}`;
        if (repo && isPrivate(privateSet, repo)) {
          excluded.cards.push({ repo, sha256: digest(rendered), bytes: Buffer.byteLength(rendered, 'utf8') });
          continue;
        }
        if (repo) included.cards.push(repo);
        kept.push(rendered);
      }
      fs.writeFileSync(path.join(stage, 'capability-cards.md'), parts[0] + kept.join(''));
    }

    const aliasesSrc = path.join(kb, 'repo-aliases.json');
    if (fs.existsSync(aliasesSrc)) {
      fs.copyFileSync(aliasesSrc, path.join(stage, 'repo-aliases.json'));
      included.aliases = true;
    }

    const selectionReceipt = sealSelectionReceipt({ builderSha, generatedAt: now(), included, excluded, ownership });
    fs.writeFileSync(path.join(stage, 'PUBLIC-INPUT-SELECTION.json'), `${JSON.stringify(selectionReceipt, null, 2)}\n`);

    // Positive selection (rule 3): remove every previously-managed entry that this round did NOT
    // reproduce -- a primer/topics file whose source disappeared or went private simply never lands
    // in `stage`, and is removed here rather than left behind by an overlay. `stage` is fully built
    // (every file read from `kb` already) before anything under `out` is touched.
    const stageEntries = new Set(fs.readdirSync(stage));
    const managedPattern = /^.+-primer\.md$/;
    const topicsPattern = /^l2-topics\..+\.json$/;
    const staticManaged = ['l2', 'capability-cards.md', 'repo-aliases.json', 'PUBLIC-INPUT-SELECTION.json'];
    const stale = fs.existsSync(out)
      ? fs.readdirSync(out).filter((name) => (managedPattern.test(name) || topicsPattern.test(name)
        || staticManaged.includes(name)) && !stageEntries.has(name))
      : [];
    for (const name of stale) fs.rmSync(path.join(out, name), { recursive: true, force: true });
    promoteArtifactSet({ liveDir: out, candidateDir: stage, files: [...stageEntries] });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  const files = [];
  for (const repo of included.primers) files.push({ name: `${repo}-primer.md`, ...fileIdentity(path.join(out, `${repo}-primer.md`)) });
  for (const repo of included.topics) files.push({ name: `l2-topics.${repo}.json`, ...fileIdentity(path.join(out, `l2-topics.${repo}.json`)) });
  if (fs.existsSync(path.join(out, 'capability-cards.md'))) files.push({ name: 'capability-cards.md', ...fileIdentity(path.join(out, 'capability-cards.md')) });
  if (included.aliases) files.push({ name: 'repo-aliases.json', ...fileIdentity(path.join(out, 'repo-aliases.json')) });

  return {
    kind: 'public-input-set',
    dir: out,
    publicRepos: allRepos.filter((repo) => !isPrivate(privateSet, repo)),
    ownership: Object.fromEntries(ownership),
    included,
    excluded,
    files,
    selectionReceipt: JSON.parse(fs.readFileSync(path.join(out, 'PUBLIC-INPUT-SELECTION.json'), 'utf8')),
  };
}
