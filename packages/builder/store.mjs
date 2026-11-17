// Writes a unit store, the one pack format the engine's keyword lane reads: one SQLite file with
// table `units` (one row per passage or history item) and an FTS5 table `fts` over two fields,
// subject (header + label line + repeated signature rows) and body (the text). Both fields hold the
// tokens of the engine's own analyse() (stemmed, identifiers also split into their words), so the
// index and the question are cut by the same function. The FTS table is contentless (the text lives
// once, in `units`), with deletes allowed. Rows are inserted in the order given, so the same units
// give the same bytes.
import { DatabaseSync } from 'node:sqlite';
import { analyse } from '../engine/analyse.mjs';

export const COLUMNS = ['uid', 'store', 'repo', 'path', 'kind', 'lang', 'symbol', 'start_line', 'end_line', 'piece', 'header', 'label', 'text', 'hash', 'tokens', 'standing', 'date', 'commit_id', 'ref', 'title', 'flag', 'flag_rule'];

/** rows: [{ ...COLUMNS, subject }]; `tokenizer` is the recipe's FTS5 tokenizer string, `analyser` the
 *  recipe's analyser. */
export function writeStore(file, rows, { tokenizer, analyser }) {
  if (!/^[a-z0-9_ ]+$/.test(tokenizer)) throw new Error(`analyser.fts5Tokenizer "${tokenizer}" is not a plain tokenizer name`);
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode = OFF;
      CREATE TABLE units (id INTEGER PRIMARY KEY, ${COLUMNS.map((c) => `${c} ${['start_line', 'end_line', 'piece', 'tokens'].includes(c) ? 'INTEGER' : 'TEXT'}`).join(', ')});
      CREATE VIRTUAL TABLE fts USING fts5(subject, body, content='', contentless_delete=1, tokenize='${tokenizer}');`);
    const insU = db.prepare(`INSERT INTO units (id, ${COLUMNS.join(', ')}) VALUES (?, ${COLUMNS.map(() => '?').join(', ')})`);
    const insF = db.prepare('INSERT INTO fts (rowid, subject, body) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    rows.forEach((r, i) => {
      insU.run(i + 1, ...COLUMNS.map((c) => r[c] ?? null));
      insF.run(i + 1, analyse(r.subject ?? '', analyser), analyse(r.text, analyser));
    });
    db.exec('CREATE INDEX units_store_path ON units (store, path)');
    db.exec('CREATE INDEX units_repo_path ON units (repo, path)');
    db.exec('COMMIT');
    db.exec("INSERT INTO fts (fts) VALUES ('optimize')");
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}
