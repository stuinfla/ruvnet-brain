// lesson-migrate-agentdb.mjs is a one-time reconciliation tool between the two AgentDB stores and
// the one plugin lesson store. It reports done() when --dry-run --json says every source row is
// already merged/bridged (result: 'skipped-idempotent'). This is a drift canary, not a scheduled
// job: it should stay green, and if a future lesson-store change reintroduces an unreconciled row,
// this is the test that catches it.
//
// Moved from tests/unit/ on 2026-10-01: it reads the developer's real ~/.claude/global-memory and
// project AgentDB stores through the real ruflo CLI, so it is a MACHINE diagnostic, not a hermetic
// code test. In the full suite it failed in every environment but the owner's own (no ruflo, or a
// clean HOME: "ruflo memory list failed"). Run it by hand:
//   npx vitest run --config tests/diagnostics/vitest.config.mjs lesson-migrate-agentdb
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('lesson-migrate-agentdb.mjs', () => {
  // Real ruflo CLI reads against two AgentDB stores; 20s (vitest's default) is not always enough
  // under load. 90s of test-level headroom around a 60s process timeout is the actual bound.
  it('--dry-run --json emits pure JSON on stdout (no trailing human text)', () => {
    const r = spawnSync(process.execPath, ['scripts/lesson-migrate-agentdb.mjs', '--dry-run', '--json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  }, 90_000);

  it('the two AgentDB lesson stores are fully reconciled into the one plugin store (0 pending rows)', () => {
    const r = spawnSync(process.execPath, ['scripts/lesson-migrate-agentdb.mjs', '--dry-run', '--json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const pending = parsed.table.filter((row) => row.result !== 'skipped-idempotent');
    expect(pending, `${pending.length} lesson row(s) not yet merged/bridged into the one store`).toEqual([]);
  }, 90_000);
});
