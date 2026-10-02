// continuity-fixture.mjs — disposable projects, stores and a scriptable ruflo for the continuity tests.
//
// Everything lives under mkdtemp: a git repo with an EMPTY global/system git config (so a developer's
// gitignore or identity can never make a test pass), a SQLite store with ruflo's memory_entries shape
// (the 18 columns project-progression-reader.mjs pins), and a FAKE ruflo that behaves like the real one
// on the two calls the journal makes — including the real refusal text ruflo prints while another
// process holds the store's native WAL sidecars (ruflo memory-initializer.ts walRefusalError).
// No fixture text comes from a real session: every decision, lesson and command is synthetic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { DatabaseSync } = await import('node:sqlite');
export const WAL_REFUSAL_TEXT = '[ERROR] Failed to store: active native WAL connection — refusing an unsafe sql.js whole-image write';

const roots = [];
export function cleanup() { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); }
export function tmp(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

export function gitEnv(home) {
  const empty = path.join(home, 'empty-gitconfig');
  fs.writeFileSync(empty, '');
  return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
}

export function git(dir, env, ...args) { return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim(); }

export function commit(dir, env, file, message) {
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  git(dir, env, 'add', file);
  git(dir, env, 'commit', '-q', '-m', message);
  return git(dir, env, 'rev-parse', 'HEAD');
}

/** A git project that has adopted the store: `.swarm/memory.db` is a real (empty) ruflo-shaped SQLite. */
export function adoptedProject({ home = tmp('cont-home-') } = {}) {
  const dir = tmp('cont-project-');
  const env = gitEnv(home);
  git(dir, env, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, '.swarm'), { mode: 0o700 });
  createStore(path.join(dir, '.swarm', 'memory.db'));
  return { dir, home, env };
}

export function createStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT, content TEXT,
    type TEXT, embedding TEXT, embedding_model TEXT, embedding_dimensions INTEGER, tags TEXT, metadata TEXT, owner_id TEXT,
    created_at INTEGER, updated_at INTEGER, expires_at INTEGER, last_accessed_at INTEGER, access_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active', provenance_type TEXT)`);
  db.close();
}

/**
 * A fake `ruflo` on disk. `refusals` is how many store calls print the WAL refusal and exit 1 before
 * stores start succeeding (a file the test can rewrite mid-run). Every call is logged.
 */
export function fakeRuflo({ refusals = 0 } = {}) {
  const dir = tmp('cont-ruflo-');
  const counter = path.join(dir, 'refusals');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(counter, String(refusals));
  const bin = path.join(dir, 'ruflo');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const a = process.argv.slice(2);
const flag = (n) => a[a.indexOf(n) + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a.slice(0, 2), key: flag('--key'), at: Date.now() }) + '\\n');
const db = flag('--path');
if (a[0] === 'memory' && a[1] === 'store') {
  const left = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) || 0;
  if (left > 0) { fs.writeFileSync(${JSON.stringify(counter)}, String(left - 1)); console.error(${JSON.stringify(WAL_REFUSAL_TEXT)}); process.exit(1); }
  const d = new DatabaseSync(db);
  const hit = d.prepare('SELECT 1 FROM memory_entries WHERE namespace=? AND key=?').all(flag('--namespace'), flag('--key'));
  if (hit.length) { console.error('[ERROR] key exists'); process.exit(1); }
  d.prepare("INSERT INTO memory_entries (id, namespace, key, content, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
    .run(flag('--namespace') + ':' + flag('--key'), flag('--namespace'), flag('--key'), flag('--value'), Date.now());
  d.close();
  console.log('[OK] Data stored successfully');
  process.exit(0);
}
if (a[0] === 'memory' && a[1] === 'retrieve') {
  const d = new DatabaseSync(db, { readOnly: true });
  const row = d.prepare('SELECT content FROM memory_entries WHERE namespace=? AND key=?').get(flag('--namespace'), flag('--key'));
  if (!row) { console.log('[WARN] Key not found'); process.exit(1); }
  process.stdout.write(row.content);
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  return { bin, counter, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

export function rows(file, namespace) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT key, content FROM memory_entries WHERE namespace=? ORDER BY key').all(namespace); } finally { db.close(); }
}

/** A synthetic Claude JSONL turn. */
export function transcript(dir, { user, assistant = [], tools = [] }) {
  const recs = [{ type: 'user', message: { role: 'user', content: user } }];
  tools.forEach((t, i) => {
    recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tu-${i}`, name: t.name, input: t.input }] } });
    recs.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${i}`, content: t.result, is_error: Boolean(t.isError) }] } });
  });
  for (const text of assistant) recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const file = path.join(dir, `transcript-${recs.length}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  fs.writeFileSync(file, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}
