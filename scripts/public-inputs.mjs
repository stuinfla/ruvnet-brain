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
import { isCapabilityOnly } from '../kb/capability-only.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX40 = /^[a-f0-9]{40}$/;

// The sealed selection receipt's filename -- exported so a caller can detect "did reconciliation
// already seal a public-input tree here?" WITHOUT re-deriving one to find out. This is exactly the
// signal build-bundle.mjs uses to decide between trusting an already-reconciled ASSETS directory
// byte-for-byte and materializing fresh in the genuine local/standalone case.
export const SELECTION_FILE = 'PUBLIC-INPUT-SELECTION.json';
export const SELECTION_RECEIPT_KIND = 'ruvnet-brain-public-input-selection-receipt';
// Schema 2 (Step 5 remediation, 2026-09-13): the receipt binds every included file's BYTES
// (`files[]` = relative path + sha256 + size), not just its NAME. Schema 1 sealed names only, so a
// consumer could verify that "alpha-primer.md" was selected while shipping any bytes at all under
// that name -- exactly the "checks exists, then trusts blindly" trap Dual's review named.
export const SELECTION_RECEIPT_SCHEMA = 2;

/** Digest+size of an excluded file, WITHOUT its content -- the private-exclusion evidence never
 * carries the bytes it proves were excluded. */
function excludedIdentity(file) {
  const { sha256, bytes } = fileIdentity(file);
  return { sha256, bytes };
}

// The ONE definition of "a managed public-prose entry" -- shared by the producer's positive-selection
// cleanup below and by validateSelectionReceipt's leak check, so the two can never disagree about
// which files this selection owns. Directory-level: `l2/` is owned wholesale.
const MANAGED_PRIMER = /^.+-primer\.md$/;
const MANAGED_TOPICS = /^l2-topics\..+\.json$/;
const MANAGED_STATIC = ['capability-cards.md', 'repo-aliases.json'];
const isManagedTopLevel = (name) => MANAGED_PRIMER.test(name) || MANAGED_TOPICS.test(name)
  || MANAGED_STATIC.includes(name) || name === 'l2' || name === SELECTION_FILE;

/** Every managed public-prose FILE currently on disk under `dir`, as relative POSIX paths (the
 * receipt itself excluded). `l2/` is walked recursively: anything under it is owned by this
 * selection, so a stray subdirectory there is a leak, not an exemption. */
export function managedPublicProseFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === SELECTION_FILE) continue;
    if (entry.name === 'l2') {
      const walk = (abs, rel) => {
        for (const child of fs.readdirSync(abs, { withFileTypes: true })) {
          const childRel = `${rel}/${child.name}`;
          if (child.isDirectory()) walk(path.join(abs, child.name), childRel);
          else out.push(childRel);
        }
      };
      if (entry.isDirectory()) walk(path.join(dir, 'l2'), 'l2');
      else out.push('l2');
      continue;
    }
    if (isManagedTopLevel(entry.name)) out.push(entry.name);
  }
  return out.sort();
}

/** Relative-path identity rows for every regular file under `dir` except the receipt itself. */
function sealedFileRows(dir) {
  const rows = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (childRel === SELECTION_FILE) continue;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), childRel);
      else {
        const { sha256, bytes } = fileIdentity(path.join(abs, entry.name));
        rows.push({ path: childRel, sha256, bytes });
      }
    }
  };
  walk(dir, '');
  return rows;
}

/**
 * validateSelectionReceipt({ receipt, dir }) -> receipt
 *
 * The fail-closed READER for SELECTION_FILE, owned by the same module that writes it (the same
 * producer-owns-validator discipline gist-receipts.mjs uses). Every consumer that wants to trust a
 * sealed public-input tree calls this instead of checking that the file merely exists:
 *   - kind / schemaVersion are exactly this module's;
 *   - receiptSha256 is recomputed from the receipt's own content and must match;
 *   - every sealed file exists under `dir` as a regular file with the exact sha256 and byte count;
 *   - every `included` name is backed by a sealed file, and every sealed file is named by `included`;
 *   - no managed public-prose file exists on disk that the receipt does not seal (an extra managed
 *     file is a LEAK -- unfenced prose riding along under a "sealed" label).
 */
export function validateSelectionReceipt({ receipt, dir } = {}) {
  const root = path.resolve(dir || '');
  const fail = (message) => { throw new Error(`public-input selection receipt: ${message}`); };
  if (!receipt || typeof receipt !== 'object') fail('missing or not an object');
  if (receipt.kind !== SELECTION_RECEIPT_KIND) fail(`kind is ${JSON.stringify(receipt.kind)}, expected ${SELECTION_RECEIPT_KIND}`);
  if (receipt.schemaVersion !== SELECTION_RECEIPT_SCHEMA) fail(`schemaVersion is ${JSON.stringify(receipt.schemaVersion)}, expected ${SELECTION_RECEIPT_SCHEMA}`);
  const { receiptSha256, ...payload } = receipt;
  if (typeof receiptSha256 !== 'string' || receiptSha256 !== digest(payload)) fail('receiptSha256 does not match the receipt content');
  const included = receipt.included;
  if (!included || !Array.isArray(receipt.files) || !Array.isArray(included.primers) || !Array.isArray(included.topics)
    || !Array.isArray(included.l2) || !Array.isArray(included.cards) || typeof included.aliases !== 'boolean') {
    fail('included/files sections are malformed');
  }
  const sealed = new Map();
  // FILESYSTEM CONTAINMENT (P2, Dual 2026-09-14): the previous check "validates slash-separated
  // traversal and the final file only. It does not reject backslash traversal on Windows or symlink
  // ancestors." Both are closed here: `\` is rejected outright as a path separator on any host, and
  // every row's resolved PARENT must still be inside the real root, so a symlinked directory
  // component cannot carry the read outside the sealed tree even though the final entry is a
  // regular, non-symlink file.
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch { fail(`sealed directory ${root} does not exist`); }
  const containedIn = (target) => target === rootReal || target.startsWith(rootReal + path.sep);
  for (const row of receipt.files) {
    if (typeof row?.path !== 'string' || !row.path || path.isAbsolute(row.path) || row.path.includes('\\')
      || row.path.split('/').some((segment) => segment === '..' || segment === '' || segment === '.')
      || !/^[a-f0-9]{64}$/.test(String(row.sha256 || '')) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      fail(`sealed file row is malformed (${JSON.stringify(row?.path)})`);
    }
    if (sealed.has(row.path)) fail(`sealed file ${row.path} is listed twice`);
    sealed.set(row.path, row);
    const abs = path.join(root, row.path);
    if (!fs.existsSync(abs)) fail(`sealed file ${row.path} is missing from ${root}`);
    let parentReal;
    try { parentReal = fs.realpathSync(path.dirname(abs)); } catch { fail(`sealed file ${row.path} has no resolvable parent directory`); }
    if (!containedIn(parentReal)) fail(`sealed file ${row.path} resolves outside the sealed directory (${parentReal})`);
    const stat = fs.lstatSync(abs);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`sealed file ${row.path} is not a regular file`);
    const { sha256, bytes } = fileIdentity(abs);
    if (sha256 !== row.sha256 || bytes !== row.bytes) fail(`sealed file ${row.path} bytes differ from the receipt`);
  }
  const expected = new Set([
    ...included.primers.map((repo) => `${repo}-primer.md`),
    ...included.topics.map((repo) => `l2-topics.${repo}.json`),
    ...included.l2.map((slug) => `l2/${slug}.md`),
    ...(included.cards.length ? ['capability-cards.md'] : []),
    ...(included.aliases ? ['repo-aliases.json'] : []),
  ]);
  for (const name of expected) if (!sealed.has(name)) fail(`included name ${name} has no sealed file row`);
  // capability-cards.md may legitimately be sealed with zero card sections (header-only file);
  // every OTHER sealed file must be accounted for by an included name.
  for (const name of sealed.keys()) {
    if (!expected.has(name) && name !== 'capability-cards.md') fail(`sealed file ${name} is not named by any included entry`);
  }
  const extras = managedPublicProseFiles(root).filter((name) => !sealed.has(name));
  if (extras.length) fail(`managed public-prose file(s) on disk are not sealed by the receipt (unfenced leak): ${extras.join(', ')}`);
  return receipt;
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

function sealSelectionReceipt({ builderSha, generatedAt, included, excluded, ownership, files }) {
  const payload = {
    schemaVersion: SELECTION_RECEIPT_SCHEMA,
    kind: SELECTION_RECEIPT_KIND,
    builderSha: builderSha || null,
    generatedAt,
    // Byte binding (schema 2): every file this selection actually wrote, by relative path.
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
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
      if (isPrivate(privateSet, repo) || isCapabilityOnly(repo)) {
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

    // Seal the BYTES actually staged (schema 2), never a claim about them: identities are read back
    // from the stage directory after every file has been written.
    const selectionReceipt = sealSelectionReceipt({
      builderSha, generatedAt: now(), included, excluded, ownership, files: sealedFileRows(stage),
    });
    fs.writeFileSync(path.join(stage, SELECTION_FILE), `${JSON.stringify(selectionReceipt, null, 2)}\n`);

    // Positive selection (rule 3): remove every previously-managed entry that this round did NOT
    // reproduce -- a primer/topics file whose source disappeared or went private simply never lands
    // in `stage`, and is removed here rather than left behind by an overlay. `stage` is fully built
    // (every file read from `kb` already) before anything under `out` is touched. "Managed" is the
    // SAME predicate validateSelectionReceipt uses for its leak check (isManagedTopLevel).
    const stageEntries = new Set(fs.readdirSync(stage));
    const stale = fs.existsSync(out)
      ? fs.readdirSync(out).filter((name) => isManagedTopLevel(name) && !stageEntries.has(name))
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

  // The producer READS BACK its own output through the same fail-closed validator every consumer
  // uses (P2, Dual 2026-09-14: "scripts/public-inputs.mjs:385 reads its output without calling
  // validateSelectionReceipt"). The stage is built, promoted, and only then proven — so a promotion
  // that landed different bytes, dropped a file, or left an unsealed managed file behind is caught
  // HERE, by the producer, instead of becoming a consumer's problem one call later.
  const promotedReceipt = validateSelectionReceipt({
    receipt: JSON.parse(fs.readFileSync(path.join(out, SELECTION_FILE), 'utf8')), dir: out,
  });

  return {
    kind: 'public-input-set',
    dir: out,
    publicRepos: allRepos.filter((repo) => !isPrivate(privateSet, repo)),
    ownership: Object.fromEntries(ownership),
    included,
    excluded,
    files,
    selectionReceipt: promotedReceipt,
  };
}
