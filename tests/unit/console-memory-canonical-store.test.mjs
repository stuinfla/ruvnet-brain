// console-memory-canonical-store.test.mjs — the Memory-quality card scores the CANONICAL project
// store, and names any second store it did not score.
//
// THE LIE (console audit 2026-09-11): the card rendered "15,824 entries, 100% embedded" for
// ruvnet-brain. That count is `.swarm/agentdb-memory.db` — the MCP coordination store the global
// CLAUDE.md warns is a DIFFERENT container — chosen by resolveMemoryDb() because it was the larger
// file. The canonical `.swarm/memory.db` (`ruflo memory store`'s target) held 5 rows. The #127 fix
// that introduced the two-name rule was right that the name is not a constant; picking by SIZE was
// the wrong tiebreak once both files hold rows.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APP_JS, scratch, seedMemoryDb } from './helpers/console-child.mjs';
import { resolveMemoryDb, probeMemory, memoryStores } from '../../scripts/onboarding-console.mjs';

let tmp;
beforeEach(() => { tmp = scratch('console-memory-'); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const canonical = () => path.join(tmp, '.swarm', 'memory.db');
const coordination = () => path.join(tmp, '.swarm', 'agentdb-memory.db');

describe('Fix 2 — Memory quality is scored on the canonical store, never the bigger file', () => {
  it('both stores populated (the owner’s machine): canonical wins even when the coordination store is larger', () => {
    seedMemoryDb(canonical(), 5, { checkpoint: true });
    seedMemoryDb(coordination(), 200);
    expect(fs.statSync(coordination()).size).toBeGreaterThan(fs.statSync(canonical()).size); // precondition: size would pick the wrong one
    expect(resolveMemoryDb(tmp)).toBe(canonical());
    const probes = probeMemory(tmp);
    expect(probes.liveness.status).toBe('ok');
    expect(probes.liveness.detail).toContain('5 entries');
    expect(probes.liveness.detail).toContain('memory.db');
    expect(probes.liveness.detail).not.toContain('200 entries');
  });

  it('memoryStores() reports BOTH files with their row counts so the page can say which one it scored', () => {
    seedMemoryDb(canonical(), 5);
    seedMemoryDb(coordination(), 200);
    const s = memoryStores(tmp);
    expect(s.canonical.rows).toBe(5);
    expect(s.canonical.path.endsWith('.swarm/memory.db')).toBe(true);
    expect(s.coordination.rows).toBe(200);
    expect(s.coordination.path.endsWith('.swarm/agentdb-memory.db')).toBe(true);
    expect(s.scored).toBe(s.canonical.path);
  });

  // The two cases #127 was fixed for must keep working: the reporter's live data sat in
  // agentdb-memory.db while memory.db was absent or empty.
  it('#127 — canonical absent: the coordination store is the only store, so it is scored', () => {
    seedMemoryDb(coordination(), 31);
    expect(resolveMemoryDb(tmp)).toBe(coordination());
  });
  it('#127 — canonical present but EMPTY: falls through to the store that actually holds rows', () => {
    seedMemoryDb(canonical(), 0);
    seedMemoryDb(coordination(), 31);
    expect(resolveMemoryDb(tmp)).toBe(coordination());
  });
  it('neither present: returns the canonical path so the "absent" message names the right file', () => {
    expect(resolveMemoryDb(tmp)).toBe(canonical());
  });

  it('the page names the unscored coordination store instead of silently folding it in', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    expect(src).toContain('stores.coordination');
    expect(src).toContain('not scored');
  });
});
