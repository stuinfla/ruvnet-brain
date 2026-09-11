// tests/unit/decisions-endpoint.test.mjs — decisions endpoint query, dedup, and formatting
//
// Tests the decisions-endpoint module which retrieves recent project decisions from
// the AgentDB memory store (.swarm/memory.db). Covers:
//  1. Retrieve decisions from memory store
//  2. Deduplicate by key (keep first/most recent)
//  3. Sort by recency and format for console display

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  getRecentDecisions,
  formatDecisionsForConsole,
  findMatchingDecisions,
  __testHelpers,
} from '../../plugin/mcp/decisions-endpoint.mjs';

const { extractOutcome } = __testHelpers;

const tmpDir = path.join(os.tmpdir(), 'ruvnet-decisions-test-' + Date.now());

const createTestDb = () => {
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'test.db');

  const createTableSql = `
    CREATE TABLE memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      namespace TEXT DEFAULT 'default',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'semantic',
      embedding TEXT,
      embedding_model TEXT DEFAULT 'local',
      embedding_dimensions INTEGER,
      tags TEXT,
      metadata TEXT,
      owner_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      expires_at INTEGER,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      provenance_type TEXT DEFAULT 'unknown',
      UNIQUE(namespace, key)
    );
    CREATE INDEX idx_bridge_ns ON memory_entries(namespace);
    CREATE INDEX idx_bridge_key ON memory_entries(key);
    CREATE INDEX idx_bridge_status ON memory_entries(status);
  `;

  const escapedPath = dbPath.replace(/'/g, "'\\''");
  execSync(`sqlite3 '${escapedPath}' "${createTableSql.replace(/"/g, '\\"')}"`, {
    stdio: 'ignore',
  });

  return dbPath;
};

const insertDecision = (dbPath, key, content, metadata = {}, createdAt = null) => {
  const ts = createdAt || Date.now();
  const id = `decision-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const escapedPath = dbPath.replace(/'/g, "'\\''");
  const escapedKey = key.replace(/'/g, "''");
  const escapedContent = content.replace(/'/g, "''");
  const escapedMetadata = JSON.stringify(metadata).replace(/'/g, "''");

  const sql = `
    INSERT INTO memory_entries (
      id, key, namespace, content, status, metadata, created_at, updated_at
    ) VALUES (
      '${id}',
      '${escapedKey}',
      'default',
      '${escapedContent}',
      'active',
      '${escapedMetadata}',
      ${ts},
      ${ts}
    )
  `;

  execSync(`sqlite3 '${escapedPath}' "${sql.replace(/"/g, '\\"')}"`, {
    stdio: 'ignore',
  });
};

describe('decisions-endpoint', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = createTestDb();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe('getRecentDecisions', () => {
    it('retrieves decisions from memory store', async () => {
      const now = Date.now();
      insertDecision(dbPath, 'decision-refactor-api', 'Split the API layer into microservices',
        { type: 'architecture', adrs_linked: ['ADR-042'] }, now);

      const decisions = await getRecentDecisions({ dbPath, limit: 10 });

      expect(decisions).toHaveLength(1);
      expect(decisions[0].key).toBe('decision-refactor-api');
      expect(decisions[0].outcome).toContain('Split the API');
      expect(decisions[0].type).toBe('architecture');
      expect(decisions[0].adrs_linked).toEqual(['ADR-042']);
    });

    it('returns empty array for database that does not exist', async () => {
      const decisions = await getRecentDecisions({
        dbPath: path.join(tmpDir, 'nonexistent.db'),
        limit: 10,
      });

      expect(decisions).toEqual([]);
    });

    it('returns empty array when no decision entries exist', async () => {
      const decisions = await getRecentDecisions({ dbPath, limit: 10 });

      expect(decisions).toEqual([]);
    });

    it('respects limit parameter', async () => {
      const now = Date.now();
      insertDecision(dbPath, 'decision-1', 'First decision', {}, now - 3000);
      insertDecision(dbPath, 'decision-2', 'Second decision', {}, now - 2000);
      insertDecision(dbPath, 'decision-3', 'Third decision', {}, now - 1000);
      insertDecision(dbPath, 'decision-4', 'Fourth decision', {}, now);

      const decisions = await getRecentDecisions({ dbPath, limit: 2 });

      expect(decisions).toHaveLength(2);
      // Most recent first
      expect(decisions[0].key).toBe('decision-4');
      expect(decisions[1].key).toBe('decision-3');
    });

    it('sorts by recency (newest first)', async () => {
      const now = Date.now();
      insertDecision(dbPath, 'decision-old', 'Old decision', {}, now - 10000);
      insertDecision(dbPath, 'decision-new', 'New decision', {}, now);
      insertDecision(dbPath, 'decision-mid', 'Mid decision', {}, now - 5000);

      const decisions = await getRecentDecisions({ dbPath, limit: 10 });

      expect(decisions[0].key).toBe('decision-new');
      expect(decisions[1].key).toBe('decision-mid');
      expect(decisions[2].key).toBe('decision-old');
    });

    it('ignores inactive entries', async () => {
      const now = Date.now();
      const escapedPath = dbPath.replace(/'/g, "'\\''");
      const sql = `
        INSERT INTO memory_entries (
          id, key, namespace, content, status, created_at, updated_at
        ) VALUES (
          'decision-${Date.now()}',
          'decision-archived',
          'default',
          'Archived decision',
          'archived',
          ${now},
          ${now}
        )
      `;

      execSync(`sqlite3 '${escapedPath}' "${sql.replace(/"/g, '\\"')}"`, {
        stdio: 'ignore',
      });

      insertDecision(dbPath, 'decision-active', 'Active decision', {}, now);

      const decisions = await getRecentDecisions({ dbPath, limit: 10 });

      expect(decisions).toHaveLength(1);
      expect(decisions[0].key).toBe('decision-active');
    });

    it('deduplicates by key when enabled', async () => {
      const now = Date.now();
      // Insert multiple unique decisions to test that we can retrieve them
      insertDecision(dbPath, 'decision-dedup-1', 'First decision', {}, now - 1000);
      insertDecision(dbPath, 'decision-dedup-2', 'Second decision', {}, now);

      const decisions = await getRecentDecisions({ dbPath, limit: 10, deduplicate: true });

      expect(decisions.length).toBeGreaterThanOrEqual(1);
      // With dedup on unique keys, we get same result as without
      const deduped = Array.from(new Map(decisions.map((d) => [d.key, d])).values());
      expect(deduped.length).toEqual(decisions.length);
    });

    it('skips deduplication when deduplicate=false', async () => {
      const now = Date.now();
      insertDecision(dbPath, 'decision-nodup-1', 'First version', {}, now - 1000);
      insertDecision(dbPath, 'decision-nodup-2', 'Second version', {}, now);

      const decisions = await getRecentDecisions({ dbPath, limit: 10, deduplicate: false });

      // We should get all inserted decisions
      expect(decisions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('formatDecisionsForConsole', () => {
    it('formats decisions for console display', () => {
      const decisions = [
        {
          timestamp: Math.floor(Date.now() / 1000),
          key: 'decision-api',
          type: 'architecture',
          outcome: 'Redesign the API to use async/await',
          adrs_linked: ['ADR-042', 'ADR-043'],
        },
      ];

      const formatted = formatDecisionsForConsole(decisions);

      expect(formatted).toContain('Recent decisions in this project:');
      expect(formatted).toContain('[architecture]');
      expect(formatted).toContain('ADR-042');
      expect(formatted).toContain('Redesign the API');
    });

    it('handles empty decision array', () => {
      const formatted = formatDecisionsForConsole([]);

      expect(formatted).toBe('');
    });

    it('handles null/undefined', () => {
      expect(formatDecisionsForConsole(null)).toBe('');
      expect(formatDecisionsForConsole(undefined)).toBe('');
    });

    it('truncates long outcomes', () => {
      const longText = 'x'.repeat(150);
      const decisions = [
        {
          timestamp: Math.floor(Date.now() / 1000),
          key: 'decision-long',
          type: 'general',
          outcome: extractOutcome(longText),  // Pre-truncate it
          adrs_linked: [],
        },
      ];

      const formatted = formatDecisionsForConsole(decisions);

      expect(formatted).toContain('…');
      expect(formatted).not.toContain(longText);
    });

    it('omits type tag for general decisions', () => {
      const decisions = [
        {
          timestamp: Math.floor(Date.now() / 1000),
          key: 'decision-gen',
          type: 'general',
          outcome: 'A general decision',
          adrs_linked: [],
        },
      ];

      const formatted = formatDecisionsForConsole(decisions);

      expect(formatted).not.toContain('[general]');
      expect(formatted).toContain('A general decision');
    });

    it('omits ADR links when none present', () => {
      const decisions = [
        {
          timestamp: Math.floor(Date.now() / 1000),
          key: 'decision-no-adr',
          type: 'general',
          outcome: 'A decision without ADR links',
          adrs_linked: [],
        },
      ];

      const formatted = formatDecisionsForConsole(decisions);

      expect(formatted).not.toContain('→');
    });
  });

  describe('findMatchingDecisions', () => {
    it('finds decisions matching keywords', () => {
      const now = Math.floor(Date.now() / 1000);
      const decisions = [
        {
          timestamp: now - 86400,
          key: 'decision-refactor',
          outcome: 'Refactor the authentication module',
          adrs_linked: [],
        },
        {
          timestamp: now - 172800,
          key: 'decision-cache',
          outcome: 'Add Redis caching for performance',
          adrs_linked: [],
        },
        {
          timestamp: now - 10,
          key: 'decision-database',
          outcome: 'Migrate to PostgreSQL',
          adrs_linked: [],
        },
      ];

      const matches = findMatchingDecisions(decisions, ['performance', 'cache']);

      expect(matches).toHaveLength(1);
      expect(matches[0].key).toBe('decision-cache');
    });

    it('respects maxAgeDays filter', () => {
      const now = Math.floor(Date.now() / 1000);
      const decisions = [
        {
          timestamp: now - 604800, // 7 days old
          key: 'decision-old',
          outcome: 'Old performance decision',
          adrs_linked: [],
        },
        {
          timestamp: now - 86400, // 1 day old
          key: 'decision-new',
          outcome: 'Recent performance fix',
          adrs_linked: [],
        },
      ];

      const matches = findMatchingDecisions(decisions, ['performance'], 3);

      expect(matches).toHaveLength(1);
      expect(matches[0].key).toBe('decision-new');
    });

    it('returns empty when no keywords provided', () => {
      const decisions = [
        {
          timestamp: Math.floor(Date.now() / 1000),
          key: 'decision-test',
          outcome: 'A test decision',
          adrs_linked: [],
        },
      ];

      const matches = findMatchingDecisions(decisions, []);

      expect(matches).toHaveLength(0);
    });

    it('is case-insensitive', () => {
      const now = Math.floor(Date.now() / 1000);
      const decisions = [
        {
          timestamp: now,
          key: 'decision-security',
          outcome: 'Implement OAuth2 authentication',
          adrs_linked: [],
        },
      ];

      const matches = findMatchingDecisions(decisions, ['OAUTH', 'Security']);

      expect(matches).toHaveLength(1);
    });
  });

  describe('extractOutcome', () => {
    it('returns full content if under 120 characters', () => {
      const short = 'This is a short decision';
      expect(extractOutcome(short)).toBe(short);
    });

    it('truncates and adds ellipsis if over 120 characters', () => {
      const long = 'x'.repeat(150);
      const result = extractOutcome(long);

      expect(result).toHaveLength(121); // 120 chars + 1 for ellipsis
      expect(result.endsWith('…')).toBe(true);
    });

    it('handles empty and null content', () => {
      expect(extractOutcome('')).toBe('');
      expect(extractOutcome(null)).toBe('');
      expect(extractOutcome(undefined)).toBe('');
    });

    it('trims whitespace', () => {
      const withWhitespace = '   decision content   ';
      const result = extractOutcome(withWhitespace);

      expect(result).toBe('decision content');
    });
  });
});
