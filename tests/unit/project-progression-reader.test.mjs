import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProgressionReaderUnavailable,
  canonicalReaderSupported,
  expectedSchemaFingerprint,
  openProgressionReader,
  withProgressionReader,
} from '../../plugin/scripts/project-progression-reader.mjs';

const NAMESPACE = 'project-progression';
const roots = [];

function temporaryRoot() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-reader-')));
  roots.push(root);
  return root;
}

/**
 * A fixture database in the real `memory_entries` shape. Written with node:sqlite in WRITE mode on
 * purpose: this is a throwaway fixture, never a canonical store, so it does not touch the rule that
 * `ruflo memory store` is the only writer of a real memory.db (proved separately, against the real
 * CLI, in tests/integration/project-progression-reader-identity.test.mjs).
 */
function fixtureStore(rows, { extraColumn = null, userVersion = null } = {}) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const file = path.join(temporaryRoot(), 'memory.db');
  const database = new DatabaseSync(file);
  database.exec(`CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY, key TEXT, namespace TEXT, content TEXT, type TEXT, embedding BLOB,
    embedding_model TEXT, embedding_dimensions INTEGER, tags TEXT, metadata TEXT, owner_id TEXT,
    created_at INTEGER, updated_at INTEGER, expires_at INTEGER, last_accessed_at INTEGER,
    access_count INTEGER, status TEXT, provenance_type TEXT${extraColumn ? `, ${extraColumn} TEXT` : ''})`);
  const insert = database.prepare(
    'INSERT INTO memory_entries (id, key, namespace, content, status) VALUES (?, ?, ?, ?, ?)',
  );
  rows.forEach((row, index) => {
    insert.run(`entry_${index}`, row.key, row.namespace ?? NAMESPACE, row.content, row.status ?? null);
  });
  if (userVersion !== null) database.exec(`PRAGMA user_version = ${userVersion}`);
  database.close();
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('canonical progression reader', () => {
  it('is supported on this Node build', () => {
    expect(canonicalReaderSupported()).toBe(true);
  });

  it('enumerates every active row in the namespace, sorted, and nothing else', () => {
    const file = fixtureStore([
      { key: 'bravo', content: '{"eventKey":"bravo"}' },
      { key: 'alpha', content: '{"eventKey":"alpha"}', status: 'active' },
      { key: 'foreign', content: '{}', namespace: 'other-namespace' },
      { key: 'tombstoned', content: '{}', status: 'deleted' },
    ]);
    const reader = openProgressionReader(file);
    try {
      expect(reader.listKeys(NAMESPACE)).toEqual(['alpha', 'bravo']);
    } finally { reader.close(); }
  });

  it('returns the exact stored bytes for an exact key, and null for an absent one', () => {
    const content = '{"eventKey":"alpha","payloadDigest":"' + 'a'.repeat(64) + '"}';
    const file = fixtureStore([{ key: 'alpha', content }]);
    const reader = openProgressionReader(file);
    try {
      expect(reader.readContent(NAMESPACE, 'alpha')).toBe(content);
      expect(reader.readContent(NAMESPACE, 'absent')).toBeNull();
      expect(reader.readContent('other-namespace', 'alpha')).toBeNull();
    } finally { reader.close(); }
  });

  it('refuses to pick a winner when two active rows claim one key', () => {
    const file = fixtureStore([
      { key: 'alpha', content: '{"eventKey":"alpha","v":1}' },
      { key: 'alpha', content: '{"eventKey":"alpha","v":2}' },
    ]);
    const reader = openProgressionReader(file);
    try {
      expect(() => reader.listKeys(NAMESPACE)).toThrow(/duplicate progression key/);
      expect(() => reader.readContent(NAMESPACE, 'alpha')).toThrow(/duplicate progression key/);
    } finally { reader.close(); }
  });

  it('refuses a truncated enumeration rather than returning a partial one', () => {
    const file = fixtureStore([
      { key: 'alpha', content: '{}' }, { key: 'bravo', content: '{}' }, { key: 'charlie', content: '{}' },
    ]);
    const reader = openProgressionReader(file);
    try {
      expect(() => reader.listKeys(NAMESPACE, { maxEntries: 2 })).toThrow(/exceeds its bound/);
      expect(reader.listKeys(NAMESPACE, { maxEntries: 3 })).toHaveLength(3);
    } finally { reader.close(); }
  });

  it('reports UNAVAILABLE — never a verdict — for anything it cannot read authoritatively', () => {
    const root = temporaryRoot();
    const absent = path.join(root, 'missing.db');
    expect(() => openProgressionReader(absent)).toThrow(ProgressionReaderUnavailable);

    // An encrypted image (CLAUDE_FLOW_ENCRYPT_AT_REST) carries the vault's "RFE1" magic, not the
    // SQLite header. It must route to the CLI, which holds the key, rather than fail the restore.
    const encrypted = path.join(root, 'encrypted.db');
    fs.writeFileSync(encrypted, Buffer.concat([Buffer.from('RFE1'), Buffer.alloc(64, 7)]));
    expect(() => openProgressionReader(encrypted)).toThrow(/not a plain SQLite image/);

    const garbage = path.join(root, 'fixture-only.db');
    fs.writeFileSync(garbage, 'fixture-only');
    expect(() => openProgressionReader(garbage)).toThrow(/not a plain SQLite image/);

    expect(() => openProgressionReader(root)).toThrow(/not a regular file/);

    // A real SQLite file that is not this schema is a fallback, not a crash.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const foreign = path.join(root, 'foreign.db');
    const database = new DatabaseSync(foreign);
    database.exec('CREATE TABLE unrelated (id TEXT)');
    database.close();
    expect(() => openProgressionReader(foreign)).toThrow(/schema mismatch/);
  });

  it('pins the fingerprint measured on the real ruflo store', () => {
    const fingerprint = expectedSchemaFingerprint();
    expect(fingerprint.userVersion).toBe(0);
    expect(fingerprint.columns).toEqual([...fingerprint.columns].sort());
    // Every column this module filters on or reads must be part of what it pins.
    expect(fingerprint.columns).toEqual(expect.arrayContaining(['key', 'namespace', 'content', 'status']));
  });

  it('REFUSES a drifted schema rather than reporting zero rows', () => {
    const rows = [{ key: 'alpha', content: '{"eventKey":"alpha"}' }];
    // Control: the identical rows ARE readable when the fingerprint matches, so the refusals below
    // are caused by the drift and by nothing else.
    const matching = openProgressionReader(fixtureStore(rows));
    try { expect(matching.listKeys(NAMESPACE)).toEqual(['alpha']); } finally { matching.close(); }

    // A column ruflo might add tomorrow. The rows are still selectable — that is exactly the danger,
    // because a reader that shrugged would return a confident answer about a table it has not seen.
    expect(() => openProgressionReader(fixtureStore(rows, { extraColumn: 'tier' })))
      .toThrow(/schema fingerprint mismatch: memory_entries columns differ \(unexpected tier\)/);

    // A migration that bumps user_version: same rows, same columns, different schema generation.
    expect(() => openProgressionReader(fixtureStore(rows, { userVersion: 7 })))
      .toThrow(/schema fingerprint mismatch: user_version 7 is not 0/);

    // And the refusal is the fallback signal, never a restore-killing error.
    expect(withProgressionReader(fixtureStore(rows, { extraColumn: 'tier' }), () => 'unreachable'))
      .toEqual({ ok: false, reason: expect.stringMatching(/columns differ/) });
  });

  it('withProgressionReader reports fallback for unavailability and serves an available store', () => {
    const root = temporaryRoot();
    const garbage = path.join(root, 'fixture-only.db');
    fs.writeFileSync(garbage, 'fixture-only');
    expect(withProgressionReader(garbage, () => 'unreachable'))
      .toEqual({ ok: false, reason: expect.stringMatching(/not a plain SQLite image/) });

    const file = fixtureStore([{ key: 'alpha', content: '{"eventKey":"alpha"}' }]);
    expect(withProgressionReader(file, (reader) => reader.listKeys(NAMESPACE)))
      .toEqual({ ok: true, value: ['alpha'] });
  });

  it('propagates a structural error through withProgressionReader instead of hiding it as a fallback', () => {
    const file = fixtureStore([{ key: 'alpha', content: '{}' }, { key: 'alpha', content: '{}' }]);
    expect(() => withProgressionReader(file, (reader) => reader.listKeys(NAMESPACE)))
      .toThrow(/duplicate progression key/);
  });
});
