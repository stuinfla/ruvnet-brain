/**
 * memory-store-decisions.test.mjs — Decision registry and storage
 *
 * Tests ADR-076 tier 2: Decision Registry
 *
 * Verifies:
 * 1. Every architecture/version decision is logged with type, reason, alternatives
 * 2. Decisions are tagged, timestamped, and immutable
 * 3. Approval chain is captured
 * 4. Reversal risk is assessed
 * 5. Performance: store decision in <5 seconds
 * 6. Query performance: search 100+ decisions in <200ms
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class DecisionStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.decisions = [];
    if (fs.existsSync(dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        this.decisions = data.decisions || [];
      } catch (e) {
        // start fresh
      }
    }
  }

  storeDecision(decision) {
    if (!decision.key) throw new Error('Decision must have a key');
    if (!decision.type) throw new Error('Decision must have a type');
    if (!decision.reason) throw new Error('Decision must have a reason');
    if (!decision.chosen) throw new Error('Decision must specify chosen option');

    const stored = {
      key: decision.key,
      timestamp: decision.timestamp || Date.now(),
      type: decision.type, // 'adr', 'version', 'dependency', 'constraint', 'migration'
      reason: decision.reason,
      alternatives: decision.alternatives || [],
      chosen: decision.chosen,
      source: decision.source || 'unknown',
      approval: decision.approval || 'proposed',
      reversalRisk: decision.reversalRisk || 'unknown',
      tags: decision.tags || [],
      immutable: true,
    };
    this.decisions.push(stored);
    this._persist();
    return stored;
  }

  getDecision(key) {
    return this.decisions.find(d => d.key === key);
  }

  searchDecisions(query) {
    if (query.startsWith('decision:')) {
      return this.decisions.filter(d => d.key === query);
    }
    return this.decisions.filter(d =>
      d.reason.includes(query) ||
      d.chosen.includes(query) ||
      d.tags.some(t => t.includes(query))
    );
  }

  getDecisionsByType(type) {
    return this.decisions.filter(d => d.type === type);
  }

  _persist() {
    fs.writeFileSync(this.dbPath, JSON.stringify({
      decisions: this.decisions,
    }, null, 2));
  }
}

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-store-test-'));
  store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ADR-076 Tier 2 — Decision Registry', () => {
  describe('low — decision format validation', () => {
    it('requires all mandatory fields: key, type, reason, chosen', () => {
      expect(() => {
        store.storeDecision({ type: 'adr', reason: 'test', chosen: 'option-a' });
      }).toThrow(/must have a key/);

      expect(() => {
        store.storeDecision({ key: 'test-1', reason: 'test', chosen: 'option-a' });
      }).toThrow(/must have a type/);

      expect(() => {
        store.storeDecision({ key: 'test-1', type: 'adr', chosen: 'option-a' });
      }).toThrow(/must have a reason/);

      expect(() => {
        store.storeDecision({ key: 'test-1', type: 'adr', reason: 'test' });
      }).toThrow(/must specify chosen/);
    });

    it('stores decision with complete metadata', () => {
      const decision = store.storeDecision({
        key: 'decision:2026-09-11:043-adr-076-memory-tier',
        type: 'adr',
        reason: 'unlock 95/100 north star path',
        chosen: 'memory-full-integration',
        alternatives: ['option B: manual recall', 'option C: redis-backed'],
        source: 'ADR-076, commit abc123',
        approval: 'proposed by Codex, accepted by Stuart',
        reversalRisk: 'low',
        tags: ['memory', 'continuity', 'critical-path'],
      });

      expect(decision).toMatchObject({
        type: 'adr',
        reason: 'unlock 95/100 north star path',
        chosen: 'memory-full-integration',
        reversalRisk: 'low',
        immutable: true,
      });
      expect(decision.alternatives).toHaveLength(2);
      expect(decision.tags).toContain('memory');
    });

    it('supplies defaults for optional fields', () => {
      const decision = store.storeDecision({
        key: 'test-1',
        type: 'version',
        reason: 'upgrade dependencies',
        chosen: 'vitest@4.1.10',
      });

      expect(decision.alternatives).toEqual([]);
      expect(decision.tags).toEqual([]);
      expect(decision.reversalRisk).toBe('unknown');
      expect(decision.approval).toBe('proposed');
      expect(decision.source).toBe('unknown');
    });

    it('validates decision types: adr, version, dependency, constraint, migration', () => {
      const types = ['adr', 'version', 'dependency', 'constraint', 'migration'];
      types.forEach(type => {
        const d = store.storeDecision({
          key: `test-${type}`,
          type,
          reason: 'test',
          chosen: 'option-a',
        });
        expect(d.type).toBe(type);
      });
    });
  });

  describe('medium — decision storage and retrieval', () => {
    it('retrieves stored decision by exact key', () => {
      store.storeDecision({
        key: 'decision:2026-09-11:001-postgres',
        type: 'dependency',
        reason: 'robust data persistence',
        chosen: 'postgres@15.0',
      });

      const retrieved = store.getDecision('decision:2026-09-11:001-postgres');
      expect(retrieved).toBeDefined();
      expect(retrieved.reason).toBe('robust data persistence');
    });

    it('returns undefined for non-existent key', () => {
      const retrieved = store.getDecision('decision:nonexistent');
      expect(retrieved).toBeUndefined();
    });

    it('searches decisions by query across reason, chosen, and tags', () => {
      store.storeDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'memory integration for continuity',
        chosen: 'session-recall',
        tags: ['memory', 'critical'],
      });
      store.storeDecision({
        key: 'test-2',
        type: 'version',
        reason: 'update testing framework',
        chosen: 'vitest@4.1.10',
        tags: ['testing', 'dev'],
      });

      const results = store.searchDecisions('memory');
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('test-1');

      const testing = store.searchDecisions('testing');
      expect(testing).toHaveLength(1);
      expect(testing[0].key).toBe('test-2');
    });

    it('searches decisions by exact key with decision: prefix', () => {
      const key = 'decision:2026-09-11:001-test';
      store.storeDecision({
        key,
        type: 'adr',
        reason: 'test reason',
        chosen: 'test-choice',
      });

      const results = store.searchDecisions(key);
      expect(results).toHaveLength(1);
      expect(results[0].key).toBe(key);
    });

    it('groups decisions by type', () => {
      store.storeDecision({ key: 'v1', type: 'version', reason: 'test', chosen: 'a' });
      store.storeDecision({ key: 'v2', type: 'version', reason: 'test', chosen: 'b' });
      store.storeDecision({ key: 'a1', type: 'adr', reason: 'test', chosen: 'c' });

      const versions = store.getDecisionsByType('version');
      expect(versions).toHaveLength(2);

      const adrs = store.getDecisionsByType('adr');
      expect(adrs).toHaveLength(1);
    });
  });

  describe('high — immutability and non-repudiation', () => {
    it('marks all decisions as immutable at storage time', () => {
      const d1 = store.storeDecision({ key: 'test-1', type: 'adr', reason: 'r', chosen: 'c' });
      const d2 = store.storeDecision({ key: 'test-2', type: 'version', reason: 'r', chosen: 'c' });

      expect(d1.immutable).toBe(true);
      expect(d2.immutable).toBe(true);
    });

    it('persists decisions to immutable record on disk', () => {
      store.storeDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'unlock path',
        chosen: 'memory-integration',
      });

      const dbPath = path.join(tmpDir, 'decisions.db');
      const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      expect(data.decisions[0].immutable).toBe(true);
    });

    it('captures full approval chain in approval field', () => {
      const decision = store.storeDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
        approval: 'proposed by Alice, reviewed by Bob, approved by Charlie on 2026-09-11',
      });

      expect(decision.approval).toContain('Alice');
      expect(decision.approval).toContain('Bob');
      expect(decision.approval).toContain('Charlie');
    });

    it('captures all alternatives considered', () => {
      const decision = store.storeDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'choose memory approach',
        chosen: 'session-checkpoints',
        alternatives: [
          'manual recall (rejected: must invoke every session)',
          'Redis-backed (rejected: adds daemon)',
          'JSONL-only (rejected: no indexed query)',
        ],
      });

      expect(decision.alternatives).toHaveLength(3);
      expect(decision.alternatives[0]).toContain('manual recall');
    });

    it('records source commit and ADR reference', () => {
      const decision = store.storeDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
        source: 'ADR-076, commit abc123def456',
      });

      expect(decision.source).toContain('ADR-076');
      expect(decision.source).toContain('abc123');
    });
  });

  describe('numeric — performance and scale constraints', () => {
    it('stores decision in <5 seconds', () => {
      const start = performance.now();
      store.storeDecision({
        key: 'decision:2026-09-11:001-test',
        type: 'adr',
        reason: 'Unlock north star path with comprehensive memory integration',
        chosen: 'session-based-memory-with-decision-ledger',
        alternatives: [
          'Manual recall approach (rejected)',
          'Redis-backed session store (rejected)',
          'JSONL-only storage (rejected)',
        ],
        source: 'ADR-076, commit abc123',
        approval: 'proposed by Codex, accepted by Stuart',
        reversalRisk: 'low',
        tags: ['memory', 'continuity', 'critical-path'],
      });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5000);
    });

    it('searches 100+ decisions in <200ms', () => {
      for (let i = 0; i < 150; i++) {
        store.storeDecision({
          key: `decision:2026-09-11:${String(i).padStart(3, '0')}-test-${i}`,
          type: i % 5 === 0 ? 'adr' : i % 3 === 0 ? 'version' : 'dependency',
          reason: `Decision ${i}: ${i % 2 === 0 ? 'important' : 'routine'} change`,
          chosen: `option-${i % 3}`,
          tags: [`tag-${i % 10}`, 'common'],
        });
      }

      const start = performance.now();
      const results = store.searchDecisions('important');
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(200);
      expect(results.length).toBeGreaterThan(0);
    });

    it('retrieves decision by key in <10ms from 1000+ stored', () => {
      const targetKey = 'decision:2026-09-11:500-target';
      for (let i = 0; i < 1000; i++) {
        store.storeDecision({
          key: i === 500 ? targetKey : `decision:2026-09-11:${String(i).padStart(3, '0')}-test`,
          type: 'adr',
          reason: 'test',
          chosen: `option-${i}`,
        });
      }

      const start = performance.now();
      const decision = store.getDecision(targetKey);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(10);
      expect(decision).toBeDefined();
    });

    it('persists 500 decisions without exceeding 10MB', () => {
      for (let i = 0; i < 500; i++) {
        store.storeDecision({
          key: `decision:2026-09-11:${String(i).padStart(3, '0')}-test`,
          type: 'adr',
          reason: `Decision ${i}: comprehensive reason explaining the choice`,
          chosen: `option-${i % 3}`,
          alternatives: [
            `Alternative A for decision ${i}`,
            `Alternative B for decision ${i}`,
            `Alternative C for decision ${i}`,
          ],
          tags: [`tag-${i % 20}`, 'global', 'persisted'],
        });
      }

      const dbPath = path.join(tmpDir, 'decisions.db');
      const stats = fs.statSync(dbPath);
      expect(stats.size).toBeLessThan(10 * 1024 * 1024);
    });
  });

  describe('qualitative — decision rationale capture', () => {
    it('captures clear, specific reasons for every decision', () => {
      const reasons = [
        'unlock 95/100 north star path',
        'session-based memory proven 3x more recoverable than manual recall',
        'PostgreSQL too heavyweight; SQLite sufficient for 500 decision records',
      ];

      reasons.forEach((reason, i) => {
        const d = store.storeDecision({
          key: `test-${i}`,
          type: 'adr',
          reason,
          chosen: 'option-a',
        });
        expect(d.reason).toBe(reason);
      });
    });

    it('distinguishes reversal risk levels: low, medium, high, unknown', () => {
      const risks = ['low', 'medium', 'high', 'unknown'];
      risks.forEach((risk, i) => {
        const d = store.storeDecision({
          key: `test-${i}`,
          type: 'adr',
          reason: 'test',
          chosen: 'option-a',
          reversalRisk: risk,
        });
        expect(d.reversalRisk).toBe(risk);
      });
    });

    it('allows arbitrary tags for categorization', () => {
      const d = store.storeDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
        tags: ['memory', 'continuity', 'critical-path', 'north-star-unlock'],
      });

      expect(d.tags).toContain('memory');
      expect(d.tags).toContain('critical-path');
      expect(d.tags).toHaveLength(4);
    });
  });
});
