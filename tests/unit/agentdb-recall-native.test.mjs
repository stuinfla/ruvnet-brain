// tests/unit/agentdb-recall-native.test.mjs — the broad native recall engine of 4.6.4 was replaced on
// 2026-10-12 by exact reads of the latest checkpoint and the lesson keys plus ONE `ruflo memory search`
// (owner ruling: our hooks only CALL rUv's tools; the many-reader engine with its own native read path is
// gone). The capabilities below no longer exist. They are listed as todos so the loss is a register that
// stays visible in the suite, not an erasure. Restore them by extending the single ruflo search, never by
// rebuilding a reader beside rUv's.
import { describe, it } from 'vitest';

describe('LOST vs 4.6.4 — native recall engine', () => {
  it.todo('prunes empty namespaces and reads exact values without additional CLI boots or mutation');
  it.todo('delivers exact curated records within 600 bytes when ranked search is hung');
  it.todo('delivers exact curated records within 600 bytes when ranked search is below threshold');
  it.todo('does not report ok-empty when the curated state read is unavailable but ranked search succeeded empty');
});
