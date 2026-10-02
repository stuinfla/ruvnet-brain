#!/usr/bin/env node
/**
 * package-cards.mjs — PACKAGE-LEVEL capability cards, derived mechanically from the knowledge base's
 * own package manifests (ADR-0093, status Proposed).
 *
 * WHY. kb/capability-cards.md has one card per REPOSITORY. A repository like ruvector publishes ~70
 * npm packages and ~100 crates, so a repo card can say "vector database" and never say "typed
 * decisions over embeddings" (@ruvector/typesafe) or "BM25 + ANN + reciprocal rank fusion"
 * (ruvector-hybrid). The owner had to name @ruvector/typesafe himself on 2026-09-30; the Brain held
 * its package.json the whole time. These cards make that knowledge reachable by DESCRIBED need.
 *
 * THE GROUNDING LINE (same line scripts/card-from-source.mjs draws). Every word on a card is copied
 * from a manifest passage the corpus already ingested: the `npm package:` or `Rust crate / manifest:`
 * document of a PUBLIC store. Nothing is inferred from a package name. Each card carries the source
 * path (`<store>/<path>`) and the sha256 of the passage text, so a recommendation can be cited and a
 * stale card detected.
 *
 * WHAT IS LEFT OUT, AND WHY:
 *   - private stores (kb/PRIVATE-STORES.json) and any store with no public `## <store>` card — the
 *     snapshot is checked into a public repository and ships to strangers.
 *   - examples/tests/fixtures/templates/benchmarks/vendored skill copies — a recommendation must name
 *     something a user installs, not a demo inside someone's repo.
 *   - per-platform native binaries (`-darwin-arm64`, `-linux-x64-gnu`, …) — the parent package
 *     installs the right one itself.
 *   - manifests with no description — nothing grounded to match on, so honestly absent.
 *
 * FAMILIES. `@ruvector/gnn`, `@ruvector/gnn-wasm`, `ruvector-gnn-node` and the `ruvector-gnn` crate are
 * one capability shipped four ways. Ranking them separately would make every GNN prompt a four-way
 * tie the margin rule must refuse, so they collapse to ONE card (the npm package preferred) with the
 * siblings listed as `variants`.
 *
 *   node scripts/package-cards.mjs                       # report (no write)
 *   node scripts/package-cards.mjs --write               # write plugin/scripts/package-cards.json
 *   node scripts/package-cards.mjs --kb <dir> --out <f>  # explicit KB and output (nightly bundle step)
 *   node scripts/package-cards.mjs --check               # exit 1 if the committed snapshot drifted
 *   node scripts/package-cards.mjs --write --embed       # also (re)build package-cards.rvf beside it
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SCHEMA = 'ruvnet-brain.package-cards/1';
export const DEFAULT_OUT = path.join(ROOT, 'plugin', 'scripts', 'package-cards.json');

const MANIFEST_HEAD = /^(npm package|Rust crate \/ manifest): (\S+)/;
const MIN_DESCRIPTION = 25;

/** Parse one manifest passage. Returns null for anything that is not a usable manifest. */
export function parseManifestPassage(text, passagePath) {
  const s = String(text || '');
  const head = s.match(MANIFEST_HEAD);
  if (!head) return null;
  const kind = head[1] === 'npm package' ? 'npm' : 'crate';
  const name = head[2].trim();
  // An npm manifest with no "name" is rendered with its PATH as the name — not a package.
  if (!name || name.includes('/package.json') || name.endsWith('.toml')) return null;
  const line = (label) => (s.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'))?.[1] || '').trim();
  const description = line('Description');
  const version = line('Version') || null;
  const keywords = line('Keywords').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const p = String(passagePath || line('Path') || '');
  return { kind, name, version, description, keywords, path: p };
}

const EXCLUDED_SEGMENTS = new Set([
  'example', 'examples', 'test', 'tests', '__tests__', 'fixture', 'fixtures', 'template', 'templates',
  'demo', 'demos', 'bench', 'benches', 'benchmark', 'benchmarks', 'node_modules', 'platforms', 'npm-platforms',
  '.agents', '.claude', '.github', 'docs', 'archive', 'legacy', 'deprecated', 'scratch', 'tmp', 'vendor',
  'snapshots', 'e2e', 'sample', 'samples', 'playground', 'tutorials', 'tutorial',
]);

/** A path a user would install from, not a demo, test, or vendored copy. */
export function isShippablePath(p) {
  const segs = String(p || '').toLowerCase().split('/');
  return !segs.some((seg) => EXCLUDED_SEGMENTS.has(seg));
}

const PLATFORM = /-(darwin|linux|win32|windows|android|freebsd|macos)(-|$)|-(x64|x86_64|arm64|aarch64|ia32|armv7)(-(gnu|musl|msvc|gnueabihf))?$/;
/** Per-platform native binary packages — the parent package selects one on install. */
export function isPlatformBinary(name) {
  return PLATFORM.test(String(name || '').toLowerCase());
}

const NAME_NOISE = /(?:-(?:test|tests|example|examples|demo|bench|fixture|integration-test|e2e|playground))$/;

/** One capability shipped several ways shares a family key. */
export function familyKey(name) {
  let base = String(name || '').toLowerCase();
  base = base.replace(/^@[^/]+\//, '');
  base = base.replace(/^ruvector-/, '');
  let prev;
  do {
    prev = base;
    base = base.replace(/-(wasm|node|ffi|napi|native|core|js|types|bindings|sys|cli)$/, '');
  } while (base !== prev && base.includes('-'));
  return base;
}

// ── PRODUCTS (ADR-093 rev 3): packages that are ONE product, derived from repo + manifest facts ──────
// A recommendation that names `aidefence-core` (midstream's Rust crate) and a label that says
// `@claude-flow/aidefence` (ruflo's npm package) are the same advice. The relation is derived, never
// typed: three rules over facts the manifests already carry.
//   R1 FLAGSHIP — a package whose unscoped name, or whose family key, equals its repo's name, or whose
//      manifest sits at the repo root, IS that repo's product (`ruflo` and root `claude-flow` → ruflo).
//   R2 SCOPE CLI/CORE — `@<scope>/cli|core|main|sdk` is the product of the unscoped package `<scope>`
//      when one exists (`@claude-flow/cli` → `claude-flow` → ruflo's product).
//   R3 SHARED KEY — packages in different repos are one product when their family key is a FLAGSHIP
//      product's key, or is itself a product the corpus names (a `## <name>` heading in the public
//      capability-cards.md): `aidefence-core` + `@claude-flow/aidefence` → aidefence. A key that is only
//      a common word (`deployment`, `ledger`, `witness`) stays local to its repo.
// The CANONICAL install names the product in a hint: npm over crate, the repo-named package, then no
// -core/-wasm-style suffix, then the shortest id.
const GENERIC_KEYS = new Set(`
  core cli server client types utils common shared config sdk api index search memory graph cache
  node wasm runtime backend frontend agent agents swarm flow store queue worker workers proxy bridge
  monitor dashboard plugin plugins cluster router solver main app web ui test tests demo example
`.trim().split(/\s+/));

const isRootManifest = (c) => /^(package\.json|Cargo\.toml)$/i.test(c.source.split('/').slice(1).join('/'))
  || c.source.split('/').slice(1).join('/').toLowerCase() === `${c.store}/package.json`;
const unscoped = (id) => String(id).replace(/^@[^/]+\//, '').toLowerCase();

export function deriveProducts(cards, { productNames = new Set() } = {}) {
  const byId = new Map(cards.map((c) => [c.id.toLowerCase(), c]));
  const product = new Map();
  const flagship = (c) => unscoped(c.id) === c.store || familyKey(c.id) === c.store || isRootManifest(c);
  for (const c of cards) if (flagship(c)) product.set(c.id, `repo:${c.store}`);
  for (const c of cards) {
    if (product.has(c.id)) continue;
    const m = c.id.toLowerCase().match(/^@([^/]+)\/(cli|core|main|sdk)$/);
    const owner = m && byId.get(m[1]);
    if (owner) product.set(c.id, product.get(owner.id) || `pkg:${owner.id.toLowerCase()}`);
  }
  // R3: a distinctive key shared across repos; joins a flagship that carries the same key.
  const keyProduct = new Map();
  for (const c of cards) {
    const k = familyKey(c.id);
    if (product.has(c.id) && k.length >= 5 && !GENERIC_KEYS.has(k)) keyProduct.set(k, product.get(c.id));
  }
  for (const c of cards) {
    if (product.has(c.id)) continue;
    const k = familyKey(c.id);
    const distinctive = k.length >= 5 && !GENERIC_KEYS.has(k);
    product.set(c.id, keyProduct.get(distinctive ? k : '') || (distinctive && productNames.has(k) ? `key:${k}` : `key:${c.store}:${k}`));
  }
  const members = new Map();
  for (const c of cards) {
    const p = product.get(c.id);
    if (!members.has(p)) members.set(p, []);
    members.get(p).push(c);
  }
  const rank = (c) => [c.kind === 'npm' ? 0 : 1, unscoped(c.id) === c.store ? 0 : 1,
    /-(core|wasm|node|ffi|napi|native|sys|types|bindings|cli)$/.test(c.id) ? 1 : 0, c.id.length];
  const cmp = (a, b) => { const x = rank(a); const y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.id < b.id ? -1 : 1; };
  const canonical = new Map([...members].map(([p, list]) => [p, [...list].sort(cmp)[0].id]));
  return cards.map((c) => ({ ...c, product: product.get(c.id), canonical: canonical.get(product.get(c.id)) }));
}

/** Lower is better: the variant a recommendation should name when a family has several. */
function preference(card) {
  const n = card.name.toLowerCase();
  let rank = card.kind === 'npm' ? 0 : 10;
  if (/-(wasm|node|ffi|napi|native|core|types|bindings|sys|cli)$/.test(n)) rank += 3;
  if (!n.startsWith('@')) rank += 1;
  return rank * 1000 + n.length;
}

/** Public store allowlist: a `## <store>` heading in the public capability-cards.md, minus private. */
export function publicStoresFrom(cardsMd, privateStores = []) {
  const priv = new Set(privateStores.map((s) => String(s).toLowerCase()));
  const out = new Set();
  for (const m of String(cardsMd || '').matchAll(/^##\s+(.+)$/gm)) {
    const name = m[1].trim().toLowerCase();
    if (!priv.has(name)) out.add(name);
  }
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Build the card set from an iterable of { store, text, path } manifest passages. Pure — the CLI
 * below does the file IO, the tests drive this directly.
 */
export function buildCards(passages, { publicStores, owners = {} } = {}) {
  const byName = new Map();
  for (const row of passages) {
    const store = String(row.store || '').toLowerCase();
    if (publicStores && !publicStores.has(store)) continue;
    const m = parseManifestPassage(row.text, row.path);
    if (!m) continue;
    if (m.description.length < MIN_DESCRIPTION) continue;
    if (!isShippablePath(m.path)) continue;
    if (isPlatformBinary(m.name) || NAME_NOISE.test(m.name.toLowerCase())) continue;
    const card = { ...m, store, source: `${store}/${m.path}`, sourceSha256: sha256(row.text) };
    // Vendored copies: the scope owner (kb/package-owners.json) publishes it; elsewhere it is a copy.
    const scope = m.name.startsWith('@') ? `${m.name.split('/')[0].toLowerCase()}/*` : null;
    const owner = owners[m.name.toLowerCase()] || (scope && owners[scope]) || null;
    const prev = byName.get(m.name);
    const better = !prev
      || (owner && prev.store !== owner && store === owner)
      || (!(owner && prev.store === owner) && m.path.length < prev.path.length);
    if (better) byName.set(m.name, card);
  }
  // Collapse each family to its preferred variant, keeping siblings as variants.
  const families = new Map();
  for (const card of byName.values()) {
    const key = `${card.store}:${familyKey(card.name)}`;
    const list = families.get(key) || [];
    list.push(card);
    families.set(key, list);
  }
  const cards = [];
  for (const [key, list] of families) {
    list.sort((a, b) => preference(a) - preference(b) || a.name.localeCompare(b.name));
    const [lead, ...rest] = list;
    const keywords = [...new Set(list.flatMap((c) => c.keywords))].sort();
    cards.push({
      id: lead.name,
      family: key.split(':')[1],
      kind: lead.kind,
      store: lead.store,
      version: lead.version,
      description: lead.description,
      keywords,
      source: lead.source,
      sourceSha256: lead.sourceSha256,
      variants: rest.map((c) => c.name).sort(),
    });
  }
  cards.sort((a, b) => a.id.localeCompare(b.id));
  return cards;
}

/** Stream every manifest passage from <kb>/<store>.passages.jsonl, cheap-prefiltered by substring. */
export async function* manifestPassages(kbDir, stores) {
  for (const store of stores) {
    const file = path.join(kbDir, `${store}.passages.jsonl`);
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      const manifest = line.includes('"text":"npm package: ') || line.includes('"text":"Rust crate / manifest: ');
      // README passages ride along (first chunk per path only): a package directory's own README is
      // the manifest's richer, still-grounded description of WHAT IT IS FOR.
      if (!manifest && !/"path":"[^"]*README\.md"/i.test(line)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row?.text === 'string') yield { store, text: row.text, path: row.path, readme: !manifest };
    }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** The corpus identity this snapshot was derived from, so a reader can tell how old it is. */
function corpusIdentity(kbDir) {
  const src = readJson(path.join(kbDir, 'SOURCE.json'), {});
  return { builtUtc: src.builtUtc || null, releaseTag: src.releaseTag || null };
}

/** The package directory's own README, first prose only (no code, badges, tables), capped. */
export function readmeExcerpt(text, limit = 700) {
  const out = [];
  let fenced = false;
  for (const raw of String(text || '').split('\n')) {
    const t = raw.trim();
    if (t.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || !t || /^(#|<|\||!\[|\[!\[|---|>)/.test(t)) continue;
    out.push(t.replace(/\*\*|`/g, ''));
    if (out.join(' ').length > limit) break;
  }
  return out.join(' ').replace(/\s+/g, ' ').slice(0, limit).trim();
}

export function attachReadme(card, readmes) {
  const dir = path.posix.dirname(card.source);
  const text = readmes.get(`${dir}/README.md`) || readmes.get(`${dir}/readme.md`);
  const excerpt = text ? readmeExcerpt(text) : '';
  return excerpt.length >= 80 ? { ...card, readme: excerpt, readmeSource: `${dir}/README.md` } : card;
}

/** Store → ingest tier from data/registry.tiers.json (T0 = flagship … T3 = archive), lowercased. */
export function storeTiers(registry) {
  const out = {};
  for (const [tier, v] of Object.entries(registry?.tiers || {})) {
    for (const r of v?.repos || []) out[String(r.repo || r.name || '').toLowerCase()] = tier;
  }
  return out;
}

export async function generate({ kbDir, cardsMd, privateStores, owners, tiers = {} }) {
  const publicStores = publicStoresFrom(cardsMd, privateStores);
  const stores = [...publicStores].filter((s) => fs.existsSync(path.join(kbDir, `${s}.passages.jsonl`)));
  const rows = [];
  for await (const row of manifestPassages(kbDir, stores)) rows.push(row);
  const manifests = rows.filter((r) => !r.readme);
  const readmes = new Map();
  for (const r of rows) if (r.readme && !readmes.has(`${r.store}/${r.path}`)) readmes.set(`${r.store}/${r.path}`, r.text);
  const cards = buildCards(manifests, { publicStores, owners }).map((card) => attachReadme(card, readmes));
  // Pre-compute the hook's scoring tokens with the hook's OWN tokenizer (imported, not copied), so a
  // cold UserPromptSubmit process does not re-tokenize every card on every prompt.
  const { cardTokenSets, TOKENIZER_VERSION } = await import('../plugin/scripts/package-recommender.mjs');
  return {
    schema: SCHEMA,
    tokenizer: TOKENIZER_VERSION,
    derivedFrom: { ...corpusIdentity(kbDir), manifestPassages: manifests.length, readmePassages: readmes.size, stores: stores.length },
    grounding: 'Every field is copied from a manifest passage of a public store; see source + sourceSha256. t/s are derived scoring tokens.',
    cards: deriveProducts(cards, { productNames: publicStores }).map((card) => ({ ...card, tier: tiers[card.store] || null, ...cardTokenSets(card) })),
  };
}

/** Days between the snapshot's source corpus build and `now`; null when the snapshot carries none. */
export function snapshotAgeDays(doc, now = Date.now()) {
  const t = Date.parse(doc?.derivedFrom?.builtUtc || '');
  return Number.isFinite(t) ? (now - t) / 86_400_000 : null;
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  // STALENESS CHECK, no corpus needed (ADR-093 rev 2: the cards ship as a snapshot because sealing them
  // into the nightly corpus would change the sealed inputs' contract). Run at release:
  //   node scripts/package-cards.mjs --max-age-days 14   → exit 1 when the snapshot's corpus is older.
  if (process.argv.includes('--max-age-days')) {
    const snap = readJson(arg('--out', DEFAULT_OUT), null);
    const age = snapshotAgeDays(snap);
    const max = Number(arg('--max-age-days', '14'));
    console.log(`[package-cards] snapshot corpus ${snap?.derivedFrom?.builtUtc || 'unknown'} — ${age === null ? 'age unknown' : `${age.toFixed(1)} days old`} (limit ${max})`);
    process.exit(age !== null && age <= max ? 0 : 1);
  }
  const { storeRoot } = await import('../kb/store-root.mjs');
  const kbDir = arg('--kb', storeRoot());
  const out = arg('--out', DEFAULT_OUT);
  const cardsMd = fs.readFileSync(arg('--cards', path.join(ROOT, 'kb', 'capability-cards.md')), 'utf8');
  const privateStores = readJson(path.join(ROOT, 'kb', 'PRIVATE-STORES.json'), {}).privateStores || [];
  const owners = Object.fromEntries(Object.entries(readJson(path.join(ROOT, 'kb', 'package-owners.json'), {}))
    .filter(([k, v]) => !k.startsWith('/') && typeof v === 'string').map(([k, v]) => [k.toLowerCase(), v]));
  const tiers = storeTiers(readJson(path.join(ROOT, 'data', 'registry.tiers.json'), {}));
  const doc = await generate({ kbDir, cardsMd, privateStores, owners, tiers });
  // One card per line: compact enough to keep the hook's cold parse small, line-diffable in review.
  const { cards, ...header } = doc;
  const text = `${JSON.stringify(header).slice(0, -1)},"cards":[\n${cards.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`;
  console.log(`[package-cards] ${doc.cards.length} cards (${doc.cards.filter((c) => c.readme).length} with README) from ${doc.derivedFrom.manifestPassages} manifest passages in ${doc.derivedFrom.stores} public stores (corpus ${doc.derivedFrom.builtUtc || 'unknown'})`);
  if (process.argv.includes('--check')) {
    const prev = readJson(out, null);
    const ids = (d) => (d?.cards || []).map((c) => `${c.id}@${c.sourceSha256}`).join('\n');
    if (ids(prev) !== ids(doc)) { console.error(`[package-cards] ${out} is stale against ${kbDir}`); process.exit(1); }
    console.log('[package-cards] snapshot current');
  } else if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, out);
    console.log(`[package-cards] wrote ${out} (${text.length} bytes)`);
  }
  if (process.argv.includes('--embed')) {
    // The semantic lane's RVF beside the card file (ADR-093 rev 2). Needs the bge-base embedder:
    // KB_MODEL_CACHE + XENOVA_PATH (or a resolvable @xenova/transformers). Ids index the card array,
    // and package-cards.rvf.meta.json binds the vectors to these exact card bytes.
    const { buildCardIndex } = await import('../kb/package-cards-index.mjs');
    const t0 = Date.now();
    const r = await buildCardIndex(path.dirname(out));
    console.log(`[package-cards] embedded ${r.vectors} vectors into ${r.rvf} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
