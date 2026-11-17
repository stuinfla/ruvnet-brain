// Keyword lane: FTS5 + bm25 on Node's built-in SQLite. Opened read-only; writes nothing.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queryTerms } from '../analyse.mjs';

export function open(packDir, pack, recipe) {
  const file = pack.files.find((f) => f.role === 'lexical-db');
  if (!file) throw new Error('the pack lists no lexical-db file');
  const db = new DatabaseSync(path.join(packDir, file.path), { readOnly: true });
  db.prepare('SELECT count(*) AS n FROM units').get();
  const stmt = db.prepare(`
    SELECT u.repo, u.path, u.start_line, u.end_line, u.hash, u.standing, u.date, u.commit_id, u.text, bm25(fts) AS score
    FROM fts JOIN units u ON u.id = fts.rowid
    WHERE fts MATCH ?
    ORDER BY score ASC, u.repo ASC, u.path ASC, u.start_line ASC
    LIMIT ?`);
  return { db, stmt, analyser: recipe.analyser };
}

export function close(lane) {
  lane.db.close();
}

/** Best passage per file, distinct text, ranked by bm25 then repo, path, line (deterministic). */
export function search(lane, query, maxItems) {
  const terms = queryTerms(query, lane.analyser);
  if (!terms.length) return { items: [], emptyReason: 'the question has no searchable words once common words are removed' };
  const match = terms.map((t) => `"${t}"`).join(' OR ');
  const items = [];
  const seenFiles = new Set();
  const seenText = new Set();
  for (const r of lane.stmt.all(match, maxItems * 20)) {
    const file = `${r.repo}/${r.path}`;
    if (seenFiles.has(file) || seenText.has(r.hash)) continue;
    seenFiles.add(file);
    seenText.add(r.hash);
    items.push({
      repo: r.repo,
      path: r.path,
      lines: { start: r.start_line, end: r.end_line },
      hash: r.hash,
      standing: r.standing,
      date: r.date,
      commit: r.commit_id,
      score: r.score,
      excerpt: r.text,
    });
    if (items.length >= maxItems) break;
  }
  return { items, emptyReason: items.length ? null : `no passage in this pack contains any of: ${terms.join(', ')}` };
}
