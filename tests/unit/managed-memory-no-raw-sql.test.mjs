import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ISSUE #140 (@sparkling) — NO SHIPPED INSTRUCTION MAY TELL AN AGENT TO SQL A MANAGED STORE.
 *
 * The report, with exact citations: the Brain's own playbook said "confirm the exact row through
 * SQLite" and its skill said to check "`.swarm/memory.db`'s mtime actually moved". A real agent
 * followed that guidance during an unrelated documentation task and ran read-only SQLite against
 * `~/.claude-flow/user-memory.db`, bypassing the managed boundary ADR-063 and `hijack-ruvnet`
 * exist to enforce. The reporter's phrase for it: "an instruction-level contradiction".
 *
 * The mtime line was worse than reported — it contradicted this project's OWN standing lesson,
 * which states in terms that a DB/WAL mtime is not evidence of anything.
 *
 * WHY THE OLD GUIDANCE EXISTED, AND WHY IT NO LONGER SHOULD. On 2026-08-13 a write printed
 * `[OK] Data stored successfully` and persisted nothing for three days, and raw SQL was what
 * exposed it. That justification is now dead on two counts, both checked rather than assumed:
 *   · rUv closed it upstream in v3.32.34 — "No manual SQL is required", and the bridge FAILS
 *     CLOSED, reporting the native error instead of a misleading fallback.
 *   · The incident itself proves retrieve was always sufficient: it answered `Key not found` on
 *     exactly the writes that had evaporated.
 * Verified live on ruflo 3.38.12: the round-trip returns the stored VALUE, and a damaged store
 * answers `[ERROR] no such table` rather than a false success.
 *
 * A SWEEP, NOT A SPOT-FIX. The report cited two files; this scan found a third — the prompt
 * `ground-ruvnet.sh` injects on every engaged turn, which is the highest-traffic instruction
 * surface in the product. Fixing only what was reported is how this repo has repeatedly shipped
 * the same defect four files apart.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** Surfaces whose text becomes INSTRUCTIONS to a model. Internal implementation is out of scope. */
const INSTRUCTION_SURFACES = [
  'plugin/skills/ruvnet-brain/PLAYBOOK.md',
  'plugin/skills/ruvnet-brain/SKILL.md',
  'plugin/scripts/ground-ruvnet.sh',
];

/** A managed store — Ruflo/AgentDB owns these. Unrelated application databases are NOT in scope. */
const MANAGED = /(\.swarm\/memory\.db|user-memory\.db|global-memory|agentdb|memory_entries)/i;

/**
 * The defect is an instruction to INSPECT a managed store with SQL — not any co-occurrence of the
 * two words. `ground-ruvnet.sh` carries a substitution table reading "agent memory (Redis/SQLite
 * glue) -> AgentDB", which tells the model to use AgentDB INSTEAD of SQLite: the opposite of the
 * defect, and a blunter scan flagged it. A guard that fires on the fix is one people delete.
 */
const INSPECTS = /\b(confirm|verify|check|query|inspect|read|open|select|run|against)\b/i;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('no shipped instruction tells an agent to open a managed store with raw SQL', () => {
  it('finds the surfaces to scan at all', () => {
    // Without this a renamed file makes every assertion below vacuously true.
    for (const rel of INSTRUCTION_SURFACES) {
      expect(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing — the scan list is stale`).toBe(true);
    }
  });

  it('TEETH: no instruction surface pairs sqlite with a managed store', () => {
    const offenders = [];
    for (const rel of INSTRUCTION_SURFACES) {
      for (const line of read(rel).split('\n')) {
        // A line that FORBIDS raw SQL necessarily mentions both; that is the fix, not the defect.
        if (/\bNEVER\b|\bnever\b|prohibited|must not/.test(line)) continue;
        if (/sqlite/i.test(line) && MANAGED.test(line) && INSPECTS.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 96)}`);
      }
    }
    expect(offenders, 'issue #140: route these through `ruflo memory store` -> `ruflo memory '
      + 'retrieve --path ...` (the returned VALUE is the proof), or `agentdb_health` for health. '
      + 'rUv v3.32.34: "No manual SQL is required."').toEqual([]);
  });

  it('TEETH: no instruction surface offers a DB/WAL mtime as evidence', () => {
    // The reporter caught this in SKILL.md, and it contradicted our own standing lesson.
    const offenders = [];
    for (const rel of INSTRUCTION_SURFACES) {
      for (const line of read(rel).split('\n')) {
        if (/never|not evidence|unrelated to your write/i.test(line)) continue;
        if (/mtime/i.test(line) && MANAGED.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 96)}`);
      }
    }
    expect(offenders, 'an mtime moves for reasons unrelated to your write and proves nothing').toEqual([]);
  });

  it('the playbook positively prescribes the structured replacement', () => {
    // Removing bad guidance without supplying the good one leaves an agent to improvise, which is
    // how it reached for sqlite3 in the first place.
    const pb = read('plugin/skills/ruvnet-brain/PLAYBOOK.md');
    expect(pb).toMatch(/ruflo memory retrieve/);
    expect(pb, 'must say plainly that raw SQL on a managed store is out').toMatch(/NEVER open a Ruflo\/AgentDB-managed store/);
    expect(pb, 'and point at the structured health tool').toMatch(/agentdb_health/);
  });

  it('TEETH: the detector fires on the exact lines that shipped', () => {
    // Proven by mutation — a scan that cannot fail on the original defect is not a scan.
    const shipped = 'retrieve that exact key with the same `--path`, then confirm the exact row through SQLite against .swarm/memory.db';
    expect(/sqlite/i.test(shipped) && MANAGED.test(shipped)).toBe(true);
    const shippedMtime = "a test `memory_store` write followed by checking `.swarm/memory.db`'s mtime actually moved";
    expect(/mtime/i.test(shippedMtime) && MANAGED.test(shippedMtime)).toBe(true);
    // …and NOT on the corrected forms, or the guard becomes noise people route around.
    const fixed = 'NEVER open a Ruflo/AgentDB-managed store with `sqlite3` — issue #140';
    expect(/\bNEVER\b/.test(fixed), 'a prohibition must not read as a violation').toBe(true);
    // …and NOT on the substitution table, which points AWAY from SQLite.
    const table = '- agent memory (Redis/SQLite glue) -> AgentDB · token compression -> SynthLang';
    expect(INSPECTS.test(table), 'a mapping is not an instruction to inspect').toBe(false);
  });
});
