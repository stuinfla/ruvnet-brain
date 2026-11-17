// manifest.json (RECIPE-FINAL 2.3): per source its commit, counts and hashes, the recipe version, the
// sources carried at their last good state, and everything excluded or screened, so a reader can see
// what is and is not in the pack. No clock, no host and no folder path: the same inputs give the same
// bytes.
import { sha256 } from '../contract/home.mjs';

const hashOf = (rows) => sha256(rows.map((r) => r.hash).join('\n'));

/** The manifest's part for one source, from its snapshot and extract result (both may then be dropped). */
export function sourcePart({ snap, carried, out }, s) {
  const repo = snap.meta.repo;
  const tag = (list) => list.map((x) => ({ repo, ...x }));
  return {
    source: {
      repo,
      commit: snap.meta.commit,
      date: snap.meta.date,
      contentHash: snap.contentHash,
      files: snap.docs.length,
      passages: out.passages.length,
      passagesHash: hashOf(out.passages),
      skipped: snap.skipped.length,
      truncated: snap.truncated.length,
      history: out.history
        ? {
            owner: out.history.owner,
            units: out.history.rows.length,
            byKind: Object.fromEntries(s.history.kinds.map((k) => [k, out.history.rows.filter((r) => r.kind === k).length])),
            dropped: out.history.dropped,
            unitsHash: hashOf(out.history.rows),
          }
        : null,
      carried,
    },
    skipped: tag(snap.skipped),
    truncated: tag(snap.truncated),
    secrets: out.screened.secrets,
    hostile: out.screened.hostile,
  };
}

/** parts: sourcePart() per source, in source order. */
export function manifestOf(parts, { recipe, recipeHash, s }) {
  const sources = parts.map((p) => p.source);
  return {
    schema: 'ruvnet-brain/build-manifest',
    version: 1,
    recipe: {
      id: recipe.id,
      version: recipe.version,
      hash: recipeHash,
      chunker: { name: s.chunker.name, version: s.chunker.version },
      tokenEstimator: recipe.units.passage.symbolChunker.tokenEstimator,
    },
    sources,
    carried: sources.filter((x) => x.carried).map((x) => x.repo),
    counts: {
      files: sources.reduce((n, x) => n + x.files, 0),
      passages: sources.reduce((n, x) => n + x.passages, 0),
      history: sources.reduce((n, x) => n + (x.history?.units ?? 0), 0),
    },
    skipped: parts.flatMap((p) => p.skipped),
    truncated: parts.flatMap((p) => p.truncated),
    screened: {
      secrets: parts.flatMap((p) => p.secrets),
      hostile: parts.flatMap((p) => p.hostile),
    },
  };
}
