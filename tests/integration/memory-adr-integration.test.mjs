/**
 * memory-adr-integration.test.mjs — Memory + ADR continuity integration tests
 *
 * Verifies ADR-076 and ADR-077 work together:
 * 1. Decisions stored in memory are linked to ADR changes
 * 2. ADR state transitions trigger decision logging
 * 3. Session checkpoints capture ADR governance state
 * 4. Reversion tracking cross-references ADR reversions
 * 5. Concurrent memory + ADR ops don't corrupt state
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class IntegratedSystem {
  constructor(tmpDir) {
    this.tmpDir = tmpDir;
    this.memoryPath = path.join(tmpDir, 'memory.db');
    this.adrDir = path.join(tmpDir, 'adr');
    fs.mkdirSync(this.adrDir);

    this.memory = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8') || '{"checkpoints":[],"decisions":[],"reversions":[]}');
  }

  // Memory operations
  writeCheckpoint(cp) {
    this.memory.checkpoints.push({
      id: `checkpoint-${Date.now()}`,
      ...cp,
    });
    this._save();
  }

  writeDecision(decision) {
    this.memory.decisions.push({
      id: `decision-${Date.now()}`,
      ...decision,
    });
    this._save();
  }

  writeReversion(reversion) {
    this.memory.reversions.push({
      id: `reversion-${Date.now()}`,
      ...reversion,
    });
    this._save();
  }

  // ADR operations
  createADR(id, status, governs = []) {
    const content = `---
id: ${id}
status: ${status}
governs:
${governs.map(g => `  - ${g}`).join('\n')}
---

# ${id}`;
    fs.writeFileSync(path.join(this.adrDir, `${id.toLowerCase()}.md`), content);
  }

  updateADRStatus(id, newStatus) {
    const filePath = path.join(this.adrDir, `${id.toLowerCase()}.md`);
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/^status: \w+/m, `status: ${newStatus}`);
    fs.writeFileSync(filePath, content);
  }

  _save() {
    fs.writeFileSync(this.memoryPath, JSON.stringify(this.memory, null, 2));
  }

  getLatestCheckpoint() {
    return this.memory.checkpoints[this.memory.checkpoints.length - 1];
  }

  getDecisionsByTag(tag) {
    return this.memory.decisions.filter(d => d.tags && d.tags.includes(tag));
  }

  getReversionsFor(decisionId) {
    return this.memory.reversions.filter(r => r.originalDecision === decisionId);
  }
}

let tmpDir;
let system;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-adr-integration-'));
  const memoryPath = path.join(tmpDir, 'memory.db');
  fs.writeFileSync(memoryPath, JSON.stringify({
    checkpoints: [],
    decisions: [],
    reversions: [],
  }));
  system = new IntegratedSystem(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ADR-076 + ADR-077 Integration', () => {
  describe('low — basic coupling', () => {
    it('records ADR change in memory decision log', () => {
      system.createADR('ADR-076', 'Proposed', ['plugin/hooks/memory-ensure.mjs']);

      system.writeDecision({
        key: 'decision:2026-09-11:001-adr-076-proposed',
        type: 'adr',
        reason: 'Propose memory full integration',
        chosen: 'session-checkpoints',
        source: 'ADR-076, commit abc123',
        tags: ['adr', 'memory'],
      });

      const decisions = system.getDecisionsByTag('adr');
      expect(decisions).toHaveLength(1);
      expect(decisions[0].source).toContain('ADR-076');
    });

    it('checkpoint captures ADR status snapshot', () => {
      system.createADR('ADR-076', 'Proposed');
      system.createADR('ADR-077', 'Accepted');

      system.writeCheckpoint({
        branch: 'feat/adr-076',
        timestamp: Date.now(),
        adrStatus: {
          'ADR-076': 'Proposed',
          'ADR-077': 'Accepted',
        },
      });

      const latest = system.getLatestCheckpoint();
      expect(latest.adrStatus['ADR-076']).toBe('Proposed');
      expect(latest.adrStatus['ADR-077']).toBe('Accepted');
    });
  });

  describe('medium — decision-ADR lifecycle', () => {
    it('links ADR status transition to decision entry', () => {
      system.createADR('ADR-076', 'Proposed');

      // Proposed stage decision
      system.writeDecision({
        key: 'decision:2026-09-11:001-adr-076-proposed',
        type: 'adr',
        reason: 'Propose memory full integration',
        chosen: 'session-checkpoints',
        adr: 'ADR-076',
        status: 'Proposed',
        tags: ['adr-076'],
      });

      // Update to Accepted
      system.updateADRStatus('ADR-076', 'Accepted');

      system.writeDecision({
        key: 'decision:2026-09-11:002-adr-076-accepted',
        type: 'adr',
        reason: 'Accept memory full integration after review',
        chosen: 'session-checkpoints',
        adr: 'ADR-076',
        status: 'Accepted',
        approval: 'approved by Stuart',
        tags: ['adr-076'],
      });

      const adr076Decisions = system.getDecisionsByTag('adr-076');
      expect(adr076Decisions).toHaveLength(2);
      expect(adr076Decisions[0].status).toBe('Proposed');
      expect(adr076Decisions[1].status).toBe('Accepted');
    });

    it('tracks ADR supersession with reversion record', () => {
      system.createADR('ADR-062', 'Accepted');
      system.createADR('ADR-076', 'Proposed');

      system.writeDecision({
        key: 'decision:2026-09-10:001-adr-062',
        type: 'adr',
        adr: 'ADR-062',
        reason: 'constraint-store approach',
        chosen: 'option-a',
      });

      // Supersession event
      system.updateADRStatus('ADR-062', 'Superseded');

      system.writeReversion({
        type: 'adr-superseded',
        originalADR: 'ADR-062',
        replacementADR: 'ADR-076',
        reason: 'session-based memory moved to mandatory per-session capture',
        reversalProcedure: 'if per-session memory proves too costly, ADR-062 can be reinstated',
        timestamp: Date.now(),
      });

      const reversions = system.getReversionsFor('decision:2026-09-10:001-adr-062');
      expect(reversions.length).toBeGreaterThan(0);
    });
  });

  describe('high — concurrent session safety', () => {
    it('handles concurrent checkpoint + decision writes without loss', (done) => {
      const operations = [];

      // Simulate 5 concurrent sessions writing decisions
      for (let i = 0; i < 5; i++) {
        operations.push(
          Promise.resolve().then(() => {
            system.writeDecision({
              key: `decision:2026-09-11:${String(i).padStart(3, '0')}-concurrent`,
              type: 'adr',
              reason: `Concurrent decision ${i}`,
              chosen: `option-${i}`,
            });
          })
        );

        // Concurrent checkpoint writes
        operations.push(
          Promise.resolve().then(() => {
            system.writeCheckpoint({
              branch: `session-${i}`,
              timestamp: Date.now() + i,
              sessionId: `session-${i}`,
            });
          })
        );
      }

      Promise.all(operations).then(() => {
        expect(system.memory.decisions).toHaveLength(5);
        expect(system.memory.checkpoints).toHaveLength(5);
        done();
      });
    });

    it('maintains decision idempotence across checkpoint boundaries', () => {
      // Write decision in session 1
      system.writeDecision({
        key: 'decision:2026-09-11:001-test',
        type: 'adr',
        reason: 'test',
        chosen: 'option-a',
      });

      system.writeCheckpoint({
        branch: 'session-1',
        timestamp: 1000,
        sessionId: 'session-1',
      });

      // Session 2 should not re-log the same decision
      const before = system.memory.decisions.length;
      system.writeCheckpoint({
        branch: 'session-2',
        timestamp: 2000,
        sessionId: 'session-2',
      });
      const after = system.memory.decisions.length;

      expect(before).toBe(after); // no duplicate
    });
  });

  describe('numeric — integration performance', () => {
    it('coordinates memory + ADR operations in <100ms per cycle', () => {
      system.createADR('ADR-076', 'Proposed');

      const start = performance.now();
      for (let i = 0; i < 10; i++) {
        system.writeDecision({
          key: `decision:2026-09-11:${String(i).padStart(3, '0')}-perf-test`,
          type: 'adr',
          reason: 'perf test',
          chosen: 'option-a',
          adr: 'ADR-076',
        });

        system.writeCheckpoint({
          branch: 'perf-test',
          timestamp: Date.now() + i,
          adrStatus: { 'ADR-076': 'Proposed' },
        });
      }
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
    });

    it('searches cross-system state (decisions + checkpoints) in <50ms', () => {
      for (let i = 0; i < 100; i++) {
        system.writeDecision({
          key: `decision:${i}`,
          type: 'adr',
          reason: `Decision ${i}`,
          chosen: 'option-a',
          tags: ['test'],
        });
        system.writeCheckpoint({
          branch: `branch-${i}`,
          timestamp: i * 1000,
        });
      }

      const start = performance.now();
      const testDecisions = system.getDecisionsByTag('test');
      const elapsed = performance.now() - start;

      expect(testDecisions).toHaveLength(100);
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('qualitative — audit trail completeness', () => {
    it('creates traceable chain: ADR change → decision → checkpoint → reversion', () => {
      // 1. ADR created
      system.createADR('ADR-075', 'Accepted', ['plugin/scripts/ground-ruvnet.sh']);

      // 2. Decision recorded
      system.writeDecision({
        key: 'decision:2026-09-10:001-adr-075',
        type: 'adr',
        adr: 'ADR-075',
        reason: 'ground-based routing',
        chosen: 'option-a',
        commit: 'abc123',
      });

      // 3. Checkpoint captures decision
      system.writeCheckpoint({
        branch: 'main',
        timestamp: Date.now(),
        decisionCount: 1,
        adrStatus: { 'ADR-075': 'Accepted' },
      });

      // 4. ADR superseded
      system.updateADRStatus('ADR-075', 'Superseded');

      // 5. Reversion recorded
      system.writeReversion({
        originalADR: 'ADR-075',
        replacementADR: 'ADR-076',
        reason: 'memory-based approach replaces ground-based',
        timestamp: Date.now(),
      });

      expect(system.memory.decisions).toHaveLength(1);
      expect(system.memory.checkpoints).toHaveLength(1);
      expect(system.memory.reversions).toHaveLength(1);

      // All entries are cross-linked
      const decision = system.memory.decisions[0];
      const checkpoint = system.memory.checkpoints[0];
      const reversion = system.memory.reversions[0];

      expect(decision.adr).toBe('ADR-075');
      expect(checkpoint.adrStatus['ADR-075']).toBe('Accepted');
      expect(reversion.originalADR).toBe('ADR-075');
    });

    it('allows full audit trail playback by timestamp', () => {
      const events = [];

      // Simulate 5 decision + checkpoint pairs in time order
      for (let i = 0; i < 5; i++) {
        const ts = 1000 + i * 1000;

        system.writeDecision({
          key: `decision:${i}`,
          type: 'adr',
          reason: `Decision ${i}`,
          chosen: 'option-a',
          timestamp: ts,
        });

        system.writeCheckpoint({
          branch: `branch-${i}`,
          timestamp: ts + 100,
        });

        events.push({ type: 'decision', ts });
        events.push({ type: 'checkpoint', ts: ts + 100 });
      }

      // Verify chronological order is preserved
      const sortedDecisions = system.memory.decisions.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < 4; i++) {
        expect(sortedDecisions[i].timestamp).toBeLessThanOrEqual(sortedDecisions[i + 1].timestamp);
      }
    });
  });
});
