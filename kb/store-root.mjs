/**
 * store-root.mjs — THE canonical answer to "where does the knowledge live?".
 *
 * WHY. Measured 2026-08-13: SEVEN expressions resolved the store root across 29 call sites —
 * `path.join(ROOT, 'kb')` (11x), `~/.cache/ruvnet-brain/kb` (6x), `KB_DIR || process.cwd()` (2x),
 * and four more. Nobody had decided which was authoritative, so every component answered locally,
 * correctly for itself, and the seam was owned by no one.
 *
 * The cost, 2026-08-12: three repos were ingested, each printed `roundtrip 3/3 PASS` and "searchable
 * now", and search found none of them. Ingest wrote one root; the retriever read another. Both were
 * right about their own path. `KB_DIR || process.cwd()` is the sharpest form of the bug: WHICH BRAIN
 * YOU GET DEPENDS ON WHERE YOU ARE STANDING.
 *
 * THE DECISION: retrieval's path wins, because retrieval is the only consumer whose answer a user
 * ever sees. A write that does not land where the reader looks is a rehearsal, not a write.
 *
 *     ~/.cache/ruvnet-brain/kb   canonical — ingest writes here, retrieval reads here, install
 *                                materialises here, a release is a snapshot OF here.
 *     <repo>/kb                  a gitignored BUILD WORKSPACE, never a second brain.
 *
 * Env overrides stay (fixtures and dev checkouts need them) but resolve in ONE place, so "which root
 * am I using" has exactly one answer every component can print and compare.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Precedence, highest first. Named so `explain()` can say WHY a caller got the root it got. */
const SOURCES = [
  ['RUVNET_BRAIN_KB', (env) => env.RUVNET_BRAIN_KB],
  ['KB_DIR', (env) => env.KB_DIR],
];

export const DEFAULT_ROOT = (home = os.homedir()) => path.join(home, '.cache', 'ruvnet-brain', 'kb');

/**
 * The one store root. Every reader, writer, installer and doctor must call this.
 *
 * Note what it does NOT do: fall back to `process.cwd()`. That fallback made the root depend on the
 * caller's working directory, so one command answered differently from two shells.
 */
export function storeRoot(env = process.env, home = os.homedir()) {
  for (const [, read] of SOURCES) {
    const v = read(env);
    if (typeof v === 'string' && v.trim()) return path.resolve(v.trim());
  }
  return DEFAULT_ROOT(home);
}

/** Which source won — a diagnostic must be answerable, not inferred. */
export function explain(env = process.env, home = os.homedir()) {
  for (const [name, read] of SOURCES) {
    const v = read(env);
    if (typeof v === 'string' && v.trim()) return { root: path.resolve(v.trim()), source: name };
  }
  return { root: DEFAULT_ROOT(home), source: 'default' };
}

/** Store names present at a root, suffixes stripped and deduped. */
export function storesAt(root = storeRoot()) {
  try {
    return [...new Set(fs.readdirSync(root)
      .filter((f) => f.endsWith('.rvf'))
      .map((f) => f.replace(/\.big\.rvf$|\.rvf$/, '')))].sort();
  } catch { return []; }
}

/**
 * Capability-card names at a root.
 *
 * A card is what lets the router reach a store from a DESCRIPTION rather than a name. Without one a
 * store is dark: built, byte-verified, and unreachable unless the user already knows to name it.
 */
export function cardsAt(root = storeRoot()) {
  try {
    const raw = fs.readFileSync(path.join(root, 'capability-cards.md'), 'utf8');
    return [...raw.matchAll(/^##\s+(\S+)\s*$/gm)].map((m) => m[1]).sort();
  } catch { return []; }
}

/**
 * Stores that exist but cannot be routed to by description — THE ACCEPTANCE QUESTION THE BUILD
 * NEVER ASKED.
 *
 * The existing corpus check proves a store is VALID ("roundtrip 3/3 PASS"), which answers "did I
 * write it correctly?". The only question a user's answer depends on is "can it be FOUND?", and
 * nothing measured it. Measured 2026-08-13: 29 of 65 built stores were dark, including the harness
 * generator, the gists store, and ruvnet itself — and a query that NAMED the harness generator
 * routed elsewhere entirely, returning THIN evidence from a primer in a secondary store.
 *
 * BYTE-VERIFICATION IS NOT DELIVERY.
 */
export function darkStores(root = storeRoot()) {
  const cards = new Set(cardsAt(root));
  return storesAt(root).filter((s) => !cards.has(s));
}

/** One line every component can print, so two components can be compared instead of guessed about. */
export function describe(env = process.env, home = os.homedir()) {
  const { root, source } = explain(env, home);
  const stores = storesAt(root);
  const dark = darkStores(root);
  return `${root} (via ${source}) — ${stores.length} store(s), ${stores.length - dark.length} routable, ${dark.length} dark`;
}
