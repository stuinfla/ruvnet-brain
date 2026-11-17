// Keyword lane, kind "fts5-bm25": FTS5 + bm25 on Node's built-in SQLite, opened read-only, writes
// nothing. One implementation serves every keyword index a recipe names (passages, history, ...):
// the recipe's lane entry says which pack file (`role`), the field weights and the candidate depth.
// The pack format (written by packages/builder/store.mjs): table `units` (one row per passage or
// history item: id, repo, path, kind, start_line, end_line, header, text, standing, date, commit_id,
// flag, ...) and a contentless fts5(subject, body) whose rowid is units.id, holding the tokens of
// analyse() from ../analyse.mjs. The retrieval run's measured index has the same columns under the
// table name `p` with row id `rid`; it is read the same way (the development-score test opens it).
// Ranking: bm25, then repo, path, first line, row id, so equal scores order the same in every process.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queryTerms } from '../analyse.mjs';

const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const OPTIONAL = ['header', 'kind', 'standing', 'date', 'commit_id', 'flag'];

export function open(packDir, pack, recipe, spec) {
  const role = spec.role ?? `${spec.name}-db`;
  const file = pack.files.find((f) => f.role === role);
  if (!file) throw new Error(`the pack lists no ${role} file`);
  const db = new DatabaseSync(path.join(packDir, file.path), { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name));
    const [t, id] = tables.has('units') ? ['units', 'id'] : tables.has('p') ? ['p', 'rid'] : [];
    if (!t || !tables.has('fts')) throw new Error(`${file.path} holds no keyword index this engine reads`);
    const f = columns(db, 'fts');
    if (!f.has('subject') || !f.has('body')) throw new Error(`${file.path} has no subject and body fields to search`);
    const c = columns(db, t);
    const cols = [`x.${id} AS id`, 'x.repo', 'x.path', 'x.start_line', 'x.end_line', 'x.text', ...OPTIONAL.map((n) => (c.has(n) ? `x.${n} AS ${n}` : `NULL AS ${n}`))].join(', ');
    const w = spec.weights ?? {};
    const [ws, wb] = [Number(w.subject ?? 1), Number(w.body ?? 1)];
    if (!Number.isFinite(ws) || !Number.isFinite(wb)) throw new Error('field weights must be numbers');
    return {
      db,
      analyser: recipe.analyser,
      depth: spec.depth ?? 100,
      unit: spec.unit ?? 'passage',
      stmt: db.prepare(`SELECT ${cols}, bm25(fts, ${ws}, ${wb}) AS score FROM fts JOIN ${t} x ON x.${id} = fts.rowid
        WHERE fts MATCH ? ORDER BY score ASC, x.repo ASC, x.path ASC, x.start_line ASC, x.${id} ASC LIMIT ?`),
      fileStmt: db.prepare(`SELECT ${cols} FROM ${t} x WHERE x.repo = ? AND x.path = ? ORDER BY x.start_line ASC, x.${id} ASC`),
    };
  } catch (e) {
    db.close();
    throw e;
  }
}

export function close(lane) {
  lane.db.close();
}

/** Ranked candidate passages (up to the lane's depth) for `query`. */
export function search(lane, query) {
  const terms = queryTerms(query, lane.analyser);
  if (!terms.length) return { rows: [], emptyReason: 'the question has no searchable words once common words are removed' };
  const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
  const rows = lane.stmt.all(match, lane.depth);
  if (rows.length) return { rows, emptyReason: null };
  // Name the question's own words (not their stems) that were searched for.
  const said = [...new Set(String(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && queryTerms(w, lane.analyser).length))];
  return { rows, emptyReason: `no ${lane.unit} in this pack contains any of: ${said.join(', ')}` };
}

/** Every passage of one file, in line order (for excerpt windows). */
export function fileRows(lane, repo, file) {
  return lane.fileStmt.all(repo, file);
}
