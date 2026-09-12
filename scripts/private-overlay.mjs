#!/usr/bin/env node
// private-overlay.mjs — stamp pre-built PRIVATE stores into a live brain root so the product's own
// updater preserves them.
//
//   node scripts/private-overlay.mjs --root <kbDir> --from <sidecarDir> --store <name> [--store ...]
//                                    [--dry-run] [--force] [--alias <name>=<nick,nick>] [--card <name>=<file>]
//
// WHY THIS FILE EXISTS (measured 2026-09-11/12). kb/forge-update.mjs preserves exactly one thing
// across a public bundle apply: SOURCE.json store entries flagged `updateManaged:false`
// (capturePrivateOverlayState, kb/forge-update.mjs:356-358) — the capture then needs a matching
// RVF-GENERATIONS.json row with a `file` (:369-372) and picks up `## <name>` cards and alias rows
// (:402-408). restoreTreeExact (:570-591) deletes every name the bundle lacks. Nothing anywhere
// WROTE that flag: forge-refresh's writeSourceManifest records public repos only, and
// ingest-repo.mjs builds from a git checkout with a canonical URL. So private stores that arrive as
// pre-built sidecars had no writer, sat in the root unflagged, and 0 of 8 survived the 2026-09-10
// tree replacement. This is that writer. It ADDS entries and never rebuilds top-level identity:
// the live ledger's brainVersion/releaseTag/sourceSnapshot are checked against COVERAGE.json by
// plugin/scripts/coverage-integrity.mjs, so writeRvfGeneration (which restamps the repo's version)
// is deliberately not reused here — only sha256File is.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256File } from './rvf-generation.mjs';

export const REQUIRED_SIDECARS = ['.big.rvf', '.big.rvf.embed.json', '.big.rvf.idmap.json', '.meta.json', '.passages.jsonl'];
export const OPTIONAL_SIDECARS = ['.symbols.json', '-primer.md'];
export const RECEIPT_FILE = 'private-overlay-receipt.json';
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const REGISTRY_FILES = ['SOURCE.json', 'RVF-GENERATIONS.json', 'repo-aliases.json', 'capability-cards.md'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const isRegular = (file) => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
function writeAtomic(file, content) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}
function copyAtomic(from, to) {
  const temp = `${to}.tmp-${process.pid}`;
  fs.copyFileSync(from, temp);
  fs.renameSync(temp, to);
}

/** `## name` → full section text, same parse as kb/forge-update.mjs cardSections. */
function cardSections(markdown) {
  const sections = new Map();
  const matches = [...String(markdown || '').matchAll(/^## ([^\n]+)\n/gm)];
  for (let index = 0; index < matches.length; index++) {
    const end = matches[index + 1]?.index ?? markdown.length;
    sections.set(matches[index][1].trim(), markdown.slice(matches[index].index, end).trimEnd());
  }
  return sections;
}

/** First prose section of a generated primer, flattened, so the card is grounded in the store's own text. */
function primerSummary(text) {
  const section = String(text).split(/^## /m)[1];
  if (!section) return '';
  const plain = section.split('\n').slice(1).join('\n')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*[-*]\s+/gm, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= 600) return plain;
  return `${plain.slice(0, plain.lastIndexOf(' ', 600))} …`;
}

/** Facts the store's own meta.json states — used only when no primer exists; never invented prose. */
function metaFacts(meta) {
  const parts = [];
  if (typeof meta.description === 'string' && meta.description.trim()) parts.push(meta.description.trim());
  const census = meta.census || meta.corpusCounts;
  if (census && typeof census === 'object' && !Array.isArray(census)) {
    parts.push(`corpus census: ${Object.entries(census).map(([kind, count]) => `${kind} ${count}`).join(', ')}`);
  }
  if (Array.isArray(meta.meetings) && meta.meetings.length) parts.push(`meetings: ${meta.meetings.join('; ')}`);
  if (Array.isArray(meta.sources) && meta.sources.length) parts.push(`sources: ${meta.sources.join(', ')}`);
  if (Number.isInteger(meta.passages)) parts.push(`${meta.passages} passages`);
  return parts.length ? `Private store (not in any public bundle). ${parts.join('. ')}.` : '';
}

function cardFor({ from, name, meta, cardFile }) {
  if (cardFile) return { origin: `file:${cardFile}`, text: `## ${name}\n${fs.readFileSync(cardFile, 'utf8').trim()}` };
  const primer = path.join(from, `${name}-primer.md`);
  if (isRegular(primer)) {
    const body = primerSummary(fs.readFileSync(primer, 'utf8'));
    if (body) {
      return { origin: 'primer', text: `## ${name}\n${body}\n(Auto-derived from the store's own primer; a hand-written card saying when to reach for it, and when not to, would be better.)` };
    }
  }
  const facts = metaFacts(meta);
  if (facts) {
    return { origin: 'meta.json', text: `## ${name}\n${facts}\n(Auto-derived from the store's own meta.json — the sidecar set has no primer; a hand-written card saying when to reach for it would be better.)` };
  }
  throw new Error(`${name}: no card source — add ${name}-primer.md to ${from}, or pass --card ${name}=<file>`);
}

function planStore({ root, from, name, force, aliases, cardFile }) {
  if (!NAME_RE.test(name)) throw new Error(`invalid store name: ${name}`);
  const missing = REQUIRED_SIDECARS.filter((suffix) => !isRegular(path.join(from, name + suffix)));
  if (missing.length) throw new Error(`${name}: missing sidecar(s) in ${from}: ${missing.map((suffix) => name + suffix).join(', ')}`);
  const files = [...REQUIRED_SIDECARS, ...OPTIONAL_SIDECARS].map((suffix) => name + suffix)
    .filter((file) => isRegular(path.join(from, file)));
  const embed = readJson(path.join(from, `${name}.big.rvf.embed.json`));
  if (typeof embed.model !== 'string' || !embed.model.trim() || !Number.isInteger(embed.dimensions) || embed.dimensions <= 0) {
    throw new Error(`${name}: ${name}.big.rvf.embed.json lacks a model string / integer dimensions`);
  }
  let meta;
  try { meta = readJson(path.join(from, `${name}.meta.json`)); } catch (error) { throw new Error(`${name}: ${name}.meta.json is unreadable: ${error.message}`); }
  if (!meta || typeof meta !== 'object') meta = {};
  const builtUtc = [meta.builtUtc, meta.generated, embed.generated]
    .find((value) => typeof value === 'string' && Number.isFinite(Date.parse(value))) || new Date().toISOString();
  const copies = [];
  for (const file of files) {
    const source = path.join(from, file);
    const target = path.join(root, file);
    if (!fs.existsSync(target)) { copies.push(file); continue; }
    if (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile()) throw new Error(`${name}: ${target} is not a regular file — refusing to write through it`);
    if (sha256File(target) === sha256File(source)) continue;
    if (!force) throw new Error(`${name}: ${target} already exists with different bytes — pass --force to overwrite it`);
    copies.push(file);
  }
  const rvf = path.join(from, `${name}.big.rvf`);
  const card = cardFor({ from, name, meta, cardFile });
  return {
    name, files, copies, card, aliases,
    generation: { file: `${name}.big.rvf`, sha256: sha256File(rvf), bytes: fs.statSync(rvf).size, model: embed.model, dimensions: embed.dimensions, sourceCommit: null, builtUtc },
    source: { kbName: name, updateManaged: false, builtUtc, sourceCommit: null, sourceRepo: 'private', canonicalManifestUrl: null },
  };
}

/**
 * Add private stores to a live brain root. Idempotent; refuses before writing anything; snapshots
 * every registry it is about to change to `<file>.pre-overlay-<epoch>` first; temp+rename writes.
 */
export function applyPrivateOverlay({ root, from, stores, dryRun = false, force = false, aliases = {}, cards = {}, now = Date.now }) {
  root = path.resolve(String(root || ''));
  from = path.resolve(String(from || ''));
  if (!Array.isArray(stores) || !stores.length) throw new Error('at least one --store <name> is required');
  if (!isRegular(path.join(root, 'SOURCE.json'))) throw new Error(`${root} is not a brain root (no SOURCE.json)`);
  if (!isRegular(path.join(root, 'RVF-GENERATIONS.json'))) throw new Error(`${root} has no RVF-GENERATIONS.json — refusing to invent a ledger identity`);
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) throw new Error(`--from ${from} is not a directory`);
  const source = readJson(path.join(root, 'SOURCE.json'));
  if (!source.stores || typeof source.stores !== 'object' || Array.isArray(source.stores)) throw new Error('SOURCE.json stores must be an object keyed by store name');
  const ledger = readJson(path.join(root, 'RVF-GENERATIONS.json'));
  if (!ledger.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) throw new Error('RVF-GENERATIONS.json stores must be an object keyed by store name');
  const fenceFile = path.join(root, 'PRIVATE-STORES.json');
  const fence = new Set((isRegular(fenceFile) ? readJson(fenceFile).privateStores || [] : []).map((name) => String(name).toLowerCase()));
  const aliasFile = path.join(root, 'repo-aliases.json');
  const currentAliases = isRegular(aliasFile) ? readJson(aliasFile) : {};
  const cardsFile = path.join(root, 'capability-cards.md');
  const currentCards = isRegular(cardsFile) ? fs.readFileSync(cardsFile, 'utf8') : '';

  const nextSource = { ...source, stores: { ...source.stores } };
  const nextLedger = { ...ledger, stores: { ...ledger.stores } };
  const nextAliases = { ...currentAliases };
  let nextCards = currentCards;
  const receipt = {
    schemaVersion: 1, kind: 'ruvnet-brain-private-overlay-receipt', at: new Date(now()).toISOString(),
    root, from, dryRun, force, stores: [],
  };
  const plans = stores.map((name) => planStore({ root, from, name, force, aliases: aliases[name], cardFile: cards[name] }));
  for (const plan of plans) {
    const { name } = plan;
    if (!fence.has(name.toLowerCase())) {
      throw new Error(`${name}: not listed in ${fenceFile} — the coverage validator would count it as an unclassified PUBLIC store; add it to PRIVATE-STORES.json first`);
    }
    const existing = source.stores[name];
    if (existing && existing.updateManaged !== false) throw new Error(`${name}: SOURCE.json already lists this name as an update-managed (public) store — refusing to shadow it`);
    const changes = [];
    if (!sameJson(existing, plan.source)) { nextSource.stores[name] = plan.source; changes.push('SOURCE.json'); }
    if (!sameJson(ledger.stores[name], plan.generation)) { nextLedger.stores[name] = plan.generation; changes.push('RVF-GENERATIONS.json'); }
    if (Array.isArray(plan.aliases) && plan.aliases.length && !sameJson(currentAliases[name], plan.aliases)) {
      nextAliases[name] = plan.aliases; changes.push('repo-aliases.json');
    }
    if (!cardSections(nextCards).has(name)) {
      nextCards = `${nextCards.trimEnd()}${nextCards.trim() ? '\n\n' : ''}${plan.card.text}\n`;
      changes.push('capability-cards.md');
    }
    receipt.stores.push({
      name, changes, copied: plan.copies, card: cardSections(currentCards).has(name) ? 'existing' : plan.card.origin,
      sha256: plan.generation.sha256, bytes: plan.generation.bytes, model: plan.generation.model,
      dimensions: plan.generation.dimensions, builtUtc: plan.generation.builtUtc,
    });
  }
  if (dryRun) return receipt;

  const changed = new Set(receipt.stores.flatMap((entry) => entry.changes));
  const epoch = now();
  receipt.snapshots = [];
  // Snapshot ONLY registries this run rewrites, before the first write. SOURCE.json and
  // RVF-GENERATIONS.json are always paired: the flag and the row are one fact in two files.
  const snapshotTargets = changed.size ? new Set([...changed, 'SOURCE.json', 'RVF-GENERATIONS.json']) : new Set();
  for (const file of REGISTRY_FILES) {
    if (!snapshotTargets.has(file) || !isRegular(path.join(root, file))) continue;
    const snapshot = path.join(root, `${file}.pre-overlay-${epoch}`);
    if (fs.existsSync(snapshot)) throw new Error(`snapshot already exists: ${snapshot}`);
    fs.copyFileSync(path.join(root, file), snapshot);
    receipt.snapshots.push(path.basename(snapshot));
  }
  // Bytes first, then the ledger row, then aliases/cards, then the SOURCE flag LAST: a crash before
  // the flag leaves extra files the coverage validator already tolerates (private fence), never a
  // flag that points at a missing artifact.
  for (const plan of plans) for (const file of plan.copies) copyAtomic(path.join(from, file), path.join(root, file));
  if (changed.has('RVF-GENERATIONS.json')) writeAtomic(path.join(root, 'RVF-GENERATIONS.json'), jsonText(nextLedger));
  if (changed.has('repo-aliases.json')) writeAtomic(aliasFile, jsonText(nextAliases));
  if (changed.has('capability-cards.md')) writeAtomic(cardsFile, nextCards);
  if (changed.has('SOURCE.json')) writeAtomic(path.join(root, 'SOURCE.json'), jsonText(nextSource));
  writeAtomic(path.join(root, RECEIPT_FILE), jsonText(receipt));
  return receipt;
}

function parseArgs(argv) {
  const options = { stores: [], aliases: {}, cards: {}, dryRun: false, force: false };
  const pair = (value, flag) => {
    const index = String(value).indexOf('=');
    if (index <= 0) throw new Error(`${flag} expects <name>=<value>`);
    return [value.slice(0, index), value.slice(index + 1)];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const next = () => { if (argv[index + 1] == null) throw new Error(`${flag} needs a value`); return argv[++index]; };
    if (flag === '--root') options.root = next();
    else if (flag === '--from') options.from = next();
    else if (flag === '--store') options.stores.push(next());
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--force') options.force = true;
    else if (flag === '--alias') { const [name, list] = pair(next(), flag); options.aliases[name] = list.split(',').map((s) => s.trim()).filter(Boolean); }
    else if (flag === '--card') { const [name, file] = pair(next(), flag); options.cards[name] = path.resolve(file); }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!options.root || !options.from || !options.stores.length) {
    throw new Error('usage: private-overlay.mjs --root <kbDir> --from <sidecarDir> --store <name> [--store ...] [--dry-run] [--force] [--alias name=a,b] [--card name=file]');
  }
  return options;
}

function main() {
  let receipt;
  try {
    receipt = applyPrivateOverlay(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[private-overlay] REFUSED — nothing written: ${error.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
