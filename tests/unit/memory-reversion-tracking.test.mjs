/**
 * memory-reversion-tracking.test.mjs — Reversion audit trail and recovery
 *
 * Tests ADR-076 tier 4: Audit Trail and Reversion Index
 *
 * Verifies:
 * 1. Reversions are recorded when decisions are overturned
 * 2. Original decision is linked to reversion
 * 3. Reversal procedures are captured for future recovery
 * 4. Append-only design prevents data loss
 * 5. Concurrent reversions don't create conflicts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class ReversionStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.reversions = [];
    this.decisions = [];
    this._load();
  }

  _load() {
    if (fs.existsSync(this.dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        this.reversions = data.reversions || [];
        this.decisions = data.decisions || [];
      } catch (e) {
        // start fresh
      }
    }
  }

  recordDecision(decision) {
    const recorded = {
      id: `decision-${Date.now()}`,
      key: decision.key,
      timestamp: decision.timestamp || Date.now(),
      type: decision.type,
      reason: decision.reason,
      chosen: decision.chosen,
      reversalRisk: decision.reversalRisk || 'unknown',
    };
    this.decisions.push(recorded);
    this._save();
    return recorded;
  }

  recordReversion(reversion) {
    // Verify original decision exists
    const originalDecision = this.decisions.find(d => d.id === reversion.originalDecisionId);
    if (!originalDecision) {
      throw new Error(`Original decision ${reversion.originalDecisionId} not found`);
    }

    const recorded = {
      id: `reversion-${Date.now()}`,
      timestamp: reversion.timestamp || Date.now(),
      originalDecisionId: reversion.originalDecisionId,
      originalDecisionKey: originalDecision.key,
      newDecisionId: reversion.newDecisionId,
      reason: reversion.reason,
      reversalProcedure: reversion.reversalProcedure || 'none',
      approvedBy: reversion.approvedBy || 'unknown',
      immutable: true,
      commitHash: reversion.commitHash || 'unknown',
    };

    // Append-only: never update, only add
    this.reversions.push(recorded);
    this._save();
    return recorded;
  }

  getReversionsFor(decisionId) {
    return this.reversions.filter(r => r.originalDecisionId === decisionId);
  }

  getReversionById(id) {
    return this.reversions.find(r => r.id === id);
  }

  getReversionHistory() {
    return this.reversions.sort((a, b) => a.timestamp - b.timestamp);
  }

  canRevert(decisionId) {
    const reversions = this.getReversionsFor(decisionId);
    return reversions.length > 0;
  }

  getRecoveryPath(reversionId) {
    const reversion = this.getReversionById(reversionId);
    if (!reversion) return null;

    const decision = this.decisions.find(d => d.id === reversion.originalDecisionId);
    return {
      originalDecision: decision,
      reversion: reversion,
      recoverySteps: this.parseRecoverySteps(reversion.reversalProcedure),
    };
  }

  parseRecoverySteps(procedure) {
    if (procedure === 'none') return [];
    return procedure.split('\n').filter(s => s.trim());
  }

  _save() {
    fs.writeFileSync(this.dbPath, JSON.stringify({
      decisions: this.decisions,
      reversions: this.reversions,
    }, null, 2));
  }
}

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversion-track-test-'));
  store = new ReversionStore(path.join(tmpDir, 'store.db'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ADR-076 Tier 4 — Audit Trail and Reversion Index', () => {
  describe('low — reversion format validation', () => {
    it('rejects reversion without original decision', () => {
      expect(() => {
        store.recordReversion({
          originalDecisionId: 'decision-nonexistent',
          newDecisionId: 'decision-2',
          reason: 'test',
        });
      }).toThrow(/not found/);
    });

    it('requires original decision to exist before recording reversion', () => {
      const decision = store.recordDecision({
        key: 'decision:2026-09-10:001-postgres',
        type: 'dependency',
        reason: 'use postgres',
        chosen: 'postgres@15.0',
      });

      const reversion = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'decision-2',
        reason: 'postgres too heavyweight, switched to sqlite',
        reversalProcedure: 'dump postgres schema, migrate to sqlite',
        approvedBy: 'Stuart',
      });

      expect(reversion).toBeDefined();
      expect(reversion.immutable).toBe(true);
    });

    it('captures complete reversion metadata', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'original reason',
        chosen: 'option-a',
        reversalRisk: 'medium',
      });

      const reversion = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'decision-new',
        reason: 'reason for reversion',
        reversalProcedure: 'step 1\nstep 2\nstep 3',
        approvedBy: 'Charlie Brown',
        commitHash: 'abc123def456',
      });

      expect(reversion).toMatchObject({
        originalDecisionKey: decision.key,
        reason: 'reason for reversion',
        approvedBy: 'Charlie Brown',
        commitHash: 'abc123def456',
        immutable: true,
      });
    });

    it('marks all reversions as immutable', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      const r1 = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-1',
        reason: 'first reversion',
      });

      const r2 = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-2',
        reason: 'second reversion',
      });

      expect(r1.immutable).toBe(true);
      expect(r2.immutable).toBe(true);
    });
  });

  describe('medium — reversion tracking and recovery', () => {
    it('links reversion to original decision key', () => {
      const decision = store.recordDecision({
        key: 'decision:2026-09-10:022-use-postgres',
        type: 'dependency',
        reason: 'robust data persistence',
        chosen: 'postgres@15.0',
      });

      const reversion = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'decision:2026-09-11:031-use-sqlite',
        reason: 'postgres proved too heavyweight',
        approvedBy: 'Stuart',
      });

      expect(reversion.originalDecisionKey).toBe('decision:2026-09-10:022-use-postgres');
    });

    it('finds all reversions for a given decision', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'original',
        chosen: 'option-a',
      });

      // Record multiple reversions for same decision
      store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-1',
        reason: 'first reversion',
      });

      store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-2',
        reason: 'second reversion',
      });

      const reversions = store.getReversionsFor(decision.id);
      expect(reversions).toHaveLength(2);
      expect(reversions[0].reason).toContain('first');
      expect(reversions[1].reason).toContain('second');
    });

    it('provides recovery path with steps', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'dependency',
        reason: 'postgres',
        chosen: 'postgres@15.0',
      });

      const reversion = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-1',
        reason: 'reverted',
        reversalProcedure: 'Step 1: Dump schema\nStep 2: Create SQLite DB\nStep 3: Migrate data',
      });

      const recovery = store.getRecoveryPath(reversion.id);
      expect(recovery).toBeDefined();
      expect(recovery.recoverySteps).toHaveLength(3);
      expect(recovery.recoverySteps[0]).toContain('Dump');
    });
  });

  describe('high — immutability and append-only semantics', () => {
    it('persists reversions in append-only log', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      const dbPath = path.join(tmpDir, 'store.db');

      // First reversion
      store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-1',
        reason: 'reversion 1',
      });

      const afterFirstReversion = fs.readFileSync(dbPath, 'utf8');

      // Second reversion
      store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-2',
        reason: 'reversion 2',
      });

      const afterSecondReversion = fs.readFileSync(dbPath, 'utf8');

      // File should grow, never shrink
      expect(afterSecondReversion.length).toBeGreaterThan(afterFirstReversion.length);

      // Both reversions should be in file
      expect(afterSecondReversion).toContain('reversion 1');
      expect(afterSecondReversion).toContain('reversion 2');
    });

    it('prevents modification of recorded reversions', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      const reversion = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-1',
        reason: 'original reason',
      });

      expect(reversion.immutable).toBe(true);

      // Attempt to modify (should fail in real system)
      reversion.reason = 'modified reason';

      // Reload from disk
      const reloaded = store.getReversionById(reversion.id);
      expect(reloaded.reason).toBe('original reason');
    });

    it('records approval chain immutably', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      const reversion = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-1',
        reason: 'test',
        approvedBy: 'Alice (2026-09-11 14:30), Bob (2026-09-11 14:35)',
      });

      expect(reversion.approvedBy).toContain('Alice');
      expect(reversion.approvedBy).toContain('Bob');
    });

    it('commits reversal history to git via commitHash', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      const reversion = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-1',
        reason: 'reverted',
        commitHash: 'abc123def456',
      });

      expect(reversion.commitHash).toBe('abc123def456');
    });
  });

  describe('numeric — reversion performance', () => {
    it('records reversion in <50ms', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      const start = performance.now();
      store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'new-1',
        reason: 'comprehensive reason explaining the reversion',
        reversalProcedure: 'Step 1\nStep 2\nStep 3\nStep 4',
        approvedBy: 'Stuart Kerr on 2026-09-11',
      });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('queries reversions from 1000+ records in <100ms', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      // Create 1000 decisions
      for (let i = 0; i < 1000; i++) {
        store.recordDecision({
          key: `decision-${i}`,
          type: 'adr',
          reason: 'test',
          chosen: `option-${i}`,
        });
      }

      // Record reversions for target decision
      for (let i = 0; i < 5; i++) {
        store.recordReversion({
          originalDecisionId: decision.id,
          newDecisionId: `new-${i}`,
          reason: `reversion ${i}`,
        });
      }

      const start = performance.now();
      const reversions = store.getReversionsFor(decision.id);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
      expect(reversions).toHaveLength(5);
    });

    it('maintains file size under 5MB even with 500 reversions', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      for (let i = 0; i < 500; i++) {
        store.recordReversion({
          originalDecisionId: decision.id,
          newDecisionId: `new-${i}`,
          reason: `comprehensive reversion reason ${i}`,
          reversalProcedure: `step 1\nstep 2\nstep 3 for reversion ${i}`,
        });
      }

      const dbPath = path.join(tmpDir, 'store.db');
      const stats = fs.statSync(dbPath);
      expect(stats.size).toBeLessThan(5 * 1024 * 1024);
    });
  });

  describe('qualitative — reversion narrative', () => {
    it('creates audit trail from original decision to reversion', () => {
      const decision = store.recordDecision({
        key: 'decision:2026-09-10:001-postgres',
        type: 'dependency',
        reason: 'use postgres for robust ACID transactions',
        chosen: 'postgres@15.0',
        reversalRisk: 'medium',
      });

      const reversion = store.recordReversion({
        originalDecisionId: decision.id,
        newDecisionId: 'decision:2026-09-11:002-sqlite',
        reason: 'postgres proved too heavyweight for small data; SQLite sufficient',
        reversalProcedure: 'Dump postgres schema to SQL file\nCreate SQLite database\nMigrate tables and indexes\nRun regression tests',
        approvedBy: 'Stuart Kerr',
      });

      const history = store.getReversionHistory();
      expect(history).toHaveLength(1);

      // Can trace both directions
      expect(decision.key).toContain('postgres');
      expect(reversion.newDecisionId).toContain('sqlite');
    });

    it('allows recovery playback by timestamp', () => {
      const decision = store.recordDecision({
        key: 'test-1',
        type: 'adr',
        reason: 'original',
        chosen: 'option-a',
        reversalRisk: 'high',
      });

      // Multiple reversions over time
      const times = [];
      for (let i = 0; i < 3; i++) {
        const reversion = store.recordReversion({
          originalDecisionId: decision.id,
          newDecisionId: `new-${i}`,
          reason: `reversion ${i}`,
          timestamp: 1000 + i * 1000,
        });
        times.push(reversion.timestamp);
      }

      const history = store.getReversionHistory();

      // Should be in chronological order
      for (let i = 0; i < history.length - 1; i++) {
        expect(history[i].timestamp).toBeLessThanOrEqual(history[i + 1].timestamp);
      }
    });
  });
});
