/**
 * scripts/updater-manifest.mjs — every shipped repository store gets a complete, honestly-provenanced
 * updater entry in SOURCE.json.
 *
 * WHY (measured 2026-09-15). A full local build reached bundle assembly and was refused:
 * "2bottalk: sealed corpus SOURCE.json carries no updater entry for this repository store". The corpus
 * carried 194 repository stores; SOURCE.json carried entries for 94, and of those, 90 were exactly the
 * stores refreshed that run. Zero of the 100 missing had been refreshed. The worker path is correct —
 * corpus-reconcile's validateWorkerOutput requires an entry for each store a worker builds — so the gap
 * is purely INHERITANCE from the pinned bootstrap seed, whose own SOURCE.json never covered them.
 * build-bundle refuses rather than ship a store with no self-update configuration, which is right.
 *
 * THE RULE (Dual, decision A, verifier APPROVE_WITH_REQUIRED_IMPLEMENTATION_CONDITIONS): backfill
 * deterministically from the corpus's OWN authenticated records, and never let a migration masquerade
 * as a build.
 *   - `builtUtc` is the ORIGINAL artifact build time from the ledger. Never the migration time.
 *   - `builder` and `sourceDescribe` are preserved when evidenced and otherwise explicitly null.
 *     A fallback that fabricated "rvf-kb-forge" or reconstructed a git describe string is forbidden.
 *   - `contentOrigin` (inherited | built-this-generation) and `metadataOrigin` (worker-produced |
 *     inherited-existing | backfilled-from-seed-ledger) are recorded SEPARATELY for every store,
 *     because metadata written now does not make the content new.
 *   - Pinned is not automatically authenticated and unrefreshed is not automatically byte-identical:
 *     an entry is only synthesized after the artifact on disk matches the ledger's digest and size.
 *     A store that fails that check is reported, never quietly backfilled — it needs a real rebuild.
 *   - Only REPOSITORY stores require an entry; aggregates and derived stores are classified out, using
 *     the same rule build-bundle applies.
 *   - `updateManaged: false` is preserved exactly: a store deliberately excluded from self-update stays
 *     excluded.
 * Deterministic and idempotent: keys are sorted and a second run over its own output changes nothing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UPDATER_MANIFEST_VERSION = 'updater-manifest-normalization/1';
export const GIST_AGGREGATE_STORE = 'ruv-gists';
const SAFE_STORE = /^[a-z0-9][a-z0-9._-]*$/i;

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Same classification build-bundle uses: the gist aggregate, the derived registry, else a repository. */
export function classifyStore(store, derivedStores) {
  const folded = String(store).toLowerCase();
  if (folded === GIST_AGGREGATE_STORE) return 'gist-aggregate';
  return derivedStores.has(folded) ? 'derived' : 'repository';
}

export function derivedStoreSet(assetsDir) {
  const file = path.join(assetsDir, 'public-store-classes.json');
  if (!fs.existsSync(file)) return new Set();
  const classes = readJson(file);
  return new Set((classes?.derived || []).map((entry) => String(entry?.store || entry || '').toLowerCase()).filter(Boolean));
}

/**
 * Normalize SOURCE.json in place. Returns a summary; it never throws for a missing entry — the caller
 * decides, because a store whose artifact cannot be verified needs a rebuild rather than a synthesized row.
 */
export function normalizeUpdaterManifest({ assetsDir, coverage, refreshedStores = [], seedIdentity = null }) {
  const assets = path.resolve(assetsDir || '');
  const sourceFile = path.join(assets, 'SOURCE.json');
  const ledgerFile = path.join(assets, 'RVF-GENERATIONS.json');
  if (!fs.existsSync(ledgerFile)) throw new Error(`updater normalization needs the generation ledger (${ledgerFile})`);
  const source = fs.existsSync(sourceFile) ? readJson(sourceFile) : { builder: 'rvf-kb-forge', stores: {} };
  if (!source.stores || typeof source.stores !== 'object' || Array.isArray(source.stores)) {
    throw new Error('SOURCE.json is malformed (expected an object with a stores object)');
  }
  const ledger = readJson(ledgerFile);
  const ledgerSha256 = sha256File(ledgerFile);
  const derived = derivedStoreSet(assets);
  const refreshed = new Set(refreshedStores.map((s) => String(s).toLowerCase()));
  const urlByStore = new Map();
  for (const row of coverage?.rows || []) {
    const store = String(row?.artifact?.store || '').toLowerCase();
    if (store && row?.url && !urlByStore.has(store)) urlByStore.set(store, row.url);
  }

  const stores = fs.readdirSync(assets).filter((f) => f.endsWith('.big.rvf')).map((f) => f.slice(0, -'.big.rvf'.length)).sort();
  const normalized = {};
  const backfilled = [];
  const unverified = [];
  const classification = { repository: 0, 'gist-aggregate': 0, derived: 0 };

  for (const store of stores) {
    const kind = classifyStore(store, derived);
    classification[kind] += 1;
    const existing = source.stores[store] ?? source.stores[Object.keys(source.stores).find((k) => k.toLowerCase() === store.toLowerCase()) ?? ''];
    const contentOrigin = refreshed.has(store.toLowerCase()) ? 'built-this-generation' : 'inherited';
    if (existing && typeof existing === 'object') {
      // An entry that was BACKFILLED keeps that provenance forever: re-running normalization must not
      // quietly relabel synthesized metadata as though the seed had shipped it. Only an entry with no
      // recorded metadataOrigin gets one derived, which is also what makes this idempotent.
      const metadataOrigin = typeof existing.metadataOrigin === 'string' && existing.metadataOrigin
        ? existing.metadataOrigin
        : (contentOrigin === 'built-this-generation' ? 'worker-produced' : 'inherited-existing');
      normalized[store] = sortKeys({ ...existing, contentOrigin, metadataOrigin });
      continue;
    }
    if (kind !== 'repository') continue; // only repository stores require an updater entry
    if (!SAFE_STORE.test(store)) { unverified.push({ store, reason: 'unsafe store name' }); continue; }

    // Pinned is not authenticated, and unrefreshed is not byte-identical: verify before synthesizing.
    const generation = ledger?.stores?.[store]
      ?? Object.entries(ledger?.stores || {}).find(([k]) => k.toLowerCase() === store.toLowerCase())?.[1];
    if (!generation) { unverified.push({ store, reason: 'no generation record in the corpus ledger' }); continue; }
    const rvf = path.join(assets, `${store}.big.rvf`);
    const bytes = fs.statSync(rvf).size;
    const digest = sha256File(rvf);
    if (generation.sha256 !== digest || generation.bytes !== bytes) {
      unverified.push({ store, reason: 'artifact on disk does not match its ledger digest or size' });
      continue;
    }
    const url = urlByStore.get(store.toLowerCase()) ?? null;
    if (!url) { unverified.push({ store, reason: 'no coverage row supplies an upstream repository URL' }); continue; }

    normalized[store] = sortKeys({
      kbName: store,
      sourceRepo: url,
      sourceCommit: generation.sourceCommit ?? null,
      // Preserved, never reconstructed. An absent historical value is stated as unknown.
      sourceDescribe: generation.sourceDescribe ?? null,
      builtUtc: generation.builtUtc ?? null,
      builder: generation.builder ?? null,
      // Per-store nulls are correct while the TOP-LEVEL discovery contract supplies the endpoint.
      canonicalManifestUrl: null,
      canonicalBundleUrl: null,
      selfUpdate: `node forge-update.mjs ${store}`,
      contentOrigin: 'inherited',
      metadataOrigin: 'backfilled-from-seed-ledger',
      inheritanceEvidence: sortKeys({
        ledgerSha256,
        artifactSha256: digest,
        artifactBytes: bytes,
        sourceCommit: generation.sourceCommit ?? null,
        builtUtc: generation.builtUtc ?? null,
        seedTag: seedIdentity?.tag ?? null,
        seedSha256: seedIdentity?.sha256 ?? null,
      }),
      migrationIdentity: UPDATER_MANIFEST_VERSION,
    });
    backfilled.push(store);
  }

  const out = { ...source, stores: sortKeys(normalized) };
  fs.writeFileSync(sourceFile, `${JSON.stringify(out, null, 2)}\n`);
  const required = stores.filter((s) => classifyStore(s, derived) === 'repository');
  const missing = required.filter((s) => !normalized[s]);
  return {
    version: UPDATER_MANIFEST_VERSION,
    classification,
    requiredRepositoryStores: required.length,
    entries: Object.keys(normalized).length,
    backfilled,
    unverified,
    missing,
  };
}

function sortKeys(value) {
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
}
