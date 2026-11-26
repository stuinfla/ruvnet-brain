import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryEntryIndexes, getRsiStats, rollbackRsiLearned } from '../../kb/rsi-retrieval-loop.mjs';

describe('kb/rsi-retrieval-loop', () => {
  it('returns empty array gracefully when entry index files are absent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-loop-test-'));
    try {
      const hits = await queryEntryIndexes({ dir: tmp, queryVec: new Float32Array(768), RvfDatabase: {} });
      expect(hits).toEqual([]);
      const stats = getRsiStats(tmp);
      expect(stats.baseEntries).toBe(0);
      expect(stats.learnedEntries).toBe(0);
      expect(stats.rollbackAvailable).toBe(false);
      const rb = rollbackRsiLearned(tmp);
      expect(rb.ok).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
