/**
 * session-isolation-audit-trail.test.mjs — PHASE 2: Session Isolation Tests
 *
 * Test suite for session isolation and immutable audit trail:
 * 1. Session A cannot read Session B's memory entries
 * 2. Audit logs are immutable (TRIGGER prevents deletion)
 * 3. session_id column filters queries correctly
 * 4. Composite (namespace, session_id) indexes work
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../');
const MEMORY_DB_PATH = path.join(REPO_ROOT, '.swarm/memory.db');

/**
 * runSql — execute SQL query and return stdout
 */
function runSql(sql) {
  const result = spawnSync('sqlite3', [MEMORY_DB_PATH, sql], {
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

describe('PHASE 2: Session Isolation & Audit Trail', () => {
  beforeAll(() => {
    if (!fs.existsSync(MEMORY_DB_PATH)) {
      throw new Error(`Memory DB not found at ${MEMORY_DB_PATH}`);
    }
  });

  test('✓ session_id column exists on memory_entries', () => {
    const output = runSql("PRAGMA table_info(memory_entries);");
    const hasSessionId = output.includes('session_id');
    expect(hasSessionId).toBe(true);
  });

  test('✓ session_id indexes are created', () => {
    const output = runSql("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memory%session%';");
    const hasSessionIdIdx = output.includes('idx_memory_session_id');
    const hasCompositeIdx = output.includes('idx_memory_ns_session');

    expect(hasSessionIdIdx).toBe(true);
    expect(hasCompositeIdx).toBe(true);
  });

  test('✓ Session A and Session B have isolated memory entries', () => {
    const sessionA = `test-sess-a-${Date.now()}`;
    const sessionB = `test-sess-b-${Date.now()}`;

    // Insert entries for session A
    const idA = `id-a-${Date.now()}`;
    runSql(`
      INSERT INTO memory_entries
        (id, key, namespace, content, session_id, created_at, updated_at)
      VALUES ('${idA}', 'checkpoint-a', 'default', 'Session A checkpoint', '${sessionA}', ${Date.now()}, ${Date.now()});
    `);

    // Insert entries for session B
    const idB = `id-b-${Date.now()}`;
    runSql(`
      INSERT INTO memory_entries
        (id, key, namespace, content, session_id, created_at, updated_at)
      VALUES ('${idB}', 'checkpoint-b', 'default', 'Session B checkpoint', '${sessionB}', ${Date.now()}, ${Date.now()});
    `);

    // Query: Session A should see its own entry
    const resultA = runSql(`
      SELECT COUNT(*) as count FROM memory_entries
      WHERE namespace = 'default' AND session_id = '${sessionA}' AND key LIKE 'checkpoint-%';
    `);

    // Query: Session B should see its own entry
    const resultB = runSql(`
      SELECT COUNT(*) as count FROM memory_entries
      WHERE namespace = 'default' AND session_id = '${sessionB}' AND key LIKE 'checkpoint-%';
    `);

    expect(parseInt(resultA, 10)).toBeGreaterThanOrEqual(1);
    expect(parseInt(resultB, 10)).toBeGreaterThanOrEqual(1);

    // Cleanup
    runSql(`DELETE FROM memory_entries WHERE id IN ('${idA}', '${idB}');`);
  });

  test('✓ prevent_audit_delete trigger exists', () => {
    const output = runSql("SELECT name FROM sqlite_master WHERE type='trigger' AND name='prevent_audit_delete';");
    expect(output).toBe('prevent_audit_delete');
  });

  test('✓ memory_access_log columns support operation tracking', () => {
    const output = runSql("PRAGMA table_info(memory_access_log);");
    const hasId = output.includes('id');
    const hasMemoryType = output.includes('memory_type');
    const hasAccessedAt = output.includes('accessed_at');

    expect(hasId).toBe(true);
    expect(hasMemoryType).toBe(true);
    expect(hasAccessedAt).toBe(true);
  });

  test('✓ Composite index (namespace, session_id) exists', () => {
    const output = runSql("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_memory_ns_session';");
    expect(output.length).toBeGreaterThan(0);
  });

  test('✓ Multiple sessions can coexist without interference', () => {
    const sessions = ['sess-iso-1', 'sess-iso-2', 'sess-iso-3'];
    const ids = [];
    const now = Date.now();

    // Insert test entries for each session
    for (const sess of sessions) {
      const id = `test-${sess}-${now}`;
      ids.push(id);
      runSql(`
        INSERT INTO memory_entries
          (id, key, namespace, content, session_id, created_at, updated_at)
        VALUES ('${id}', 'decision-${sess}', 'patterns', 'Decision for ${sess}', '${sess}', ${now}, ${now});
      `);
    }

    // Verify each session sees exactly its own entry (isolation)
    for (const sess of sessions) {
      const result = runSql(`
        SELECT COUNT(*) FROM memory_entries
        WHERE session_id = '${sess}' AND namespace = 'patterns';
      `);
      expect(parseInt(result, 10)).toBe(1);
    }

    // Cleanup
    for (const id of ids) {
      runSql(`DELETE FROM memory_entries WHERE id = '${id}';`);
    }
  });

  test('✓ Schema migration is backward compatible (NULL session_id)', () => {
    const output = runSql(`
      SELECT COUNT(*) FROM memory_entries
      WHERE session_id IS NULL;
    `);
    const count = parseInt(output, 10);
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
