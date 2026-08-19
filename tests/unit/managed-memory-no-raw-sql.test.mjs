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
 * WHY THE OLD GUIDANCE EXISTED, AND WHY IT NO LONGER SHOULD. On 2026-08-13 a write printed
 * `[OK] Data stored successfully` and persisted nothing for three days, and raw SQL is what
 * exposed it. That justification is dead on evidence, not opinion — checked live on ruflo 3.38.12:
 *   · a round-trip returns the stored VALUE  (`ruflo memory retrieve -k … --path …`)
 *   · a missing key answers `[WARN] Key not found` — the exact 2026-08-13 signature
 *   · a damaged store answers `[ERROR] file is not a database`, NOT a false success
 *   · rUv closed it upstream in v3.32.34: "No manual SQL is required", bridge FAILS CLOSED.
 * The load-bearing half of the old rule was "exact-key round trip", never "through SQL". The round
 * trip is kept; the instrument changes. NOTE the sharp edge, measured: the CLI exits 0 even on
 * `[ERROR]`, so the proof is the returned VALUE in stdout — never the exit status.
 *
 * ══ WHY THIS GUARD IS BLOCK-SHAPED, AND NOT LINE-SHAPED ══════════════════════════════════════
 * The first version of this test scanned LINE BY LINE. Measured against the real unfixed files at
 * 93d6725, it reported ZERO offenders — it could not fail on the defect it was written to catch.
 * The reason is structural: the shipped defect wrapped across four lines, with the store path on
 * one line and the SQL verb on the next, so no single line ever contained both tokens. Its
 * "teeth" case only proved the regex matched a hand-written one-line string the file never held.
 * A guard that cannot fail is worthless, and this repo has shipped several. So: instructions are
 * scanned as BLOCKS (a bullet plus its wrapped continuation), and `line-shaped scan` below is a
 * standing regression test that keeps anyone from "simplifying" it back.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** Ruflo/AgentDB owns these. UNRELATED APPLICATION DATABASES ARE DELIBERATELY OUT OF SCOPE — the
 *  report grants that exception in terms, and a rule that banned sqlite3 everywhere would be wrong
 *  (this project's own storage guidance says plain SQLite is fine for simple non-knowledge apps). */
const MANAGED = /(\.swarm\/(agentdb-)?memory\.db|user-memory\.db|\.claude-flow\/[a-z-]*\.db|global-memory|agentdb|memory_entries)/i;
const RAWREAD = /\bsqlite3?\b|\bexact SQL row\b|\braw SQL\b|\bSELECT\s+(?:count\(|\*)/gi;
const MTIME = /\bmtime\b|\bDB\/WAL\b|\bWAL state\b/gi;
const INSPECT = /\b(confirm|verify|check|query|inspect|read|open|run|against|probe|prove)\b/i;
const NEG = /\bnever\b|\bnot\b|\bno\b|\bneither\b|prohibit|instead of|rather than|refus|forbid|don't|avoid/i;
const CLAUSE = 70;

/** One INSTRUCTION BLOCK = a bullet/heading plus the lines it wraps onto. */
export function blocks(text) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push(cur.join(' ')); cur = []; } };
  for (const line of text.split('\n')) {
    if (!line.trim()) { flush(); continue; }
    if (/^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s)/.test(line)) flush();
    cur.push(line.trim());
  }
  flush(); return out;
}

/**
 * Is the token used AFFIRMATIVELY? Judged in its own ~70-char clause, so that
 *   "NEVER open a Ruflo/AgentDB-managed store with `sqlite3`"      → prohibition, clean
 *   "then confirm the exact row through SQLite"                    → instruction, VIOLATION
 * A block cannot launder a live instruction by carrying a disclaimer further away: the pre-fix
 * playbook said "…through SQLite. A semantic-search miss, DB/WAL mtime … proves neither…", and a
 * window wide enough to reach that "neither" was measured swallowing the real defect.
 */
function affirmative(block, re) {
  re.lastIndex = 0; let m;
  while ((m = re.exec(block)) !== null) {
    const w = block.slice(Math.max(0, m.index - CLAUSE), m.index + m[0].length + CLAUSE);
    if (!NEG.test(w)) return true;
  }
  return false;
}

export function scanText(text) {
  const hits = [];
  for (const b of blocks(text)) {
    if (!MANAGED.test(b)) continue;
    if (INSPECT.test(b) && affirmative(b, RAWREAD)) hits.push(b.slice(0, 160));
    else if (affirmative(b, MTIME)) hits.push(b.slice(0, 160));
  }
  return hits;
}

/**
 * DISCOVERED, NOT ALLOWLISTED. The first version hardcoded three files; the report's own criterion
 * is "prompts, playbooks, skills, adapters, and host instructions". A three-name allowlist means a
 * NEW skill can reintroduce the bypass and stay green forever — which is how this repo has
 * repeatedly shipped the same defect four files apart.
 */
const walkMd = (dir, acc = []) => {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, acc);
    else if (/\.md$/.test(e.name)) acc.push(path.relative(ROOT, p));
  }
  return acc;
};
const INJECTED_PROMPTS = [
  'plugin/scripts/ground-ruvnet.sh',   // injected on EVERY engaged turn — highest-traffic surface
  'plugin/scripts/session-start.sh',
  'plugin/scripts/anticipate.sh',
  'plugin/scripts/hijack-ruvnet.sh',   // the boundary's own refusal text
];
const surfaces = () => [
  ...walkMd(path.join(ROOT, 'plugin/skills')),
  ...walkMd(path.join(ROOT, 'plugin/commands')),
  ...INJECTED_PROMPTS,
  'AGENTS.md',
].filter((f) => fs.existsSync(path.join(ROOT, f)));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The EXACT bytes that shipped at 93d6725, wrapping preserved — this is the fixture that the
 *  line-based guard could not fail on. Do not reflow it. */
const SHIPPED_PLAYBOOK = `- Diagnose memory only through one canonical absolute path: store a unique key with
  \`ruflo memory store --path <project>/.swarm/memory.db\`, retrieve that exact key with the same
  \`--path\`, then confirm the exact row through SQLite. A semantic-search miss, DB/WAL mtime,
  daemon startup, or \`[OK] Data stored successfully\` alone proves neither failure nor success.`;
const SHIPPED_SKILL = "probe it live, behind the scenes, instantly** — `agent_list` / `memory_stats` / `system_health`, a test `memory_store` write followed by checking `.swarm/memory.db`'s mtime actually moved, installed package versions vs the npm registry";
const SHIPPED_GROUND = '- MEMORY DIAGNOSIS: never infer a broken write from DB/WAL mtime, semantic-search misses, daemon startup, or the CLI success line. Prove it against ONE canonical absolute path: unique-key `ruflo memory store --path <project>/.swarm/memory.db` → exact-key `ruflo memory retrieve --path ...` → exact SQL row. Only then call it miswired.';

describe('issue #140 — no shipped instruction opens a managed store with raw SQL', () => {
  it('discovers a real surface set, including every skill and the injected prompts', () => {
    const s = surfaces();
    // Without this, a rename makes every assertion below vacuously true.
    expect(s.length, 'surface discovery returned nothing — the scan is vacuous').toBeGreaterThan(10);
    for (const must of ['plugin/skills/ruvnet-brain/PLAYBOOK.md', 'plugin/skills/ruvnet-brain/SKILL.md', 'plugin/scripts/ground-ruvnet.sh']) {
      expect(s, `${must} must be scanned — it is a cited offender`).toContain(must);
    }
  });

  it('TEETH: fires on all three shipped defects, including the one nobody reported', () => {
    // Proven against the real pre-fix bytes, not a hand-written approximation.
    expect(scanText(SHIPPED_PLAYBOOK), 'playbook "confirm the exact row through SQLite"').not.toEqual([]);
    expect(scanText(SHIPPED_SKILL), 'skill "mtime actually moved"').not.toEqual([]);
    expect(scanText(SHIPPED_GROUND), 'ground-ruvnet "-> exact SQL row"').not.toEqual([]);
  });

  it('REGRESSION: a line-shaped scan cannot see the playbook defect — that is why this is block-shaped', () => {
    // The defect wraps across four lines; the store path and the SQL verb never share one.
    const lineScan = (t) => t.split('\n').filter((l) => /sqlite/i.test(l) && MANAGED.test(l)).length;
    expect(lineScan(SHIPPED_PLAYBOOK), 'a per-line scan reports the unfixed playbook as clean').toBe(0);
    expect(scanText(SHIPPED_PLAYBOOK).length, 'the block-shaped scan catches it').toBeGreaterThan(0);
  });

  it('no shipped instruction surface tells an agent to SQL or stat a managed store', () => {
    const offenders = [];
    for (const rel of surfaces()) for (const hit of scanText(read(rel))) offenders.push(`${rel}: ${hit}`);
    expect(offenders, 'issue #140: route these through `ruflo memory store` -> `ruflo memory retrieve '
      + '-k <key> --path <store>` and read the returned VALUE (stdout, not the exit code — it is 0 '
      + 'even on [ERROR]); `agentdb_health` for health. rUv v3.32.34: "No manual SQL is required."').toEqual([]);
  });

  it('PRESERVES THE EXCEPTION: unrelated application SQLite databases are not in scope', () => {
    // The report grants this explicitly. A guard that banned sqlite3 everywhere would be a
    // different, wrong rule — and one people would rightly route around.
    for (const ok of [
      'Use sqlite3 to inspect your application database at ./data/app.db — that is your data.',
      'SQLite is fine for a simple app; run `sqlite3 /tmp/myapp.db "SELECT * FROM users"` to check rows.',
      'Open the build cache with sqlite3 build/cache.db and verify the row count.',
    ]) expect(scanText(ok), `must not flag an application DB: ${ok}`).toEqual([]);
  });

  it('CATCHES the reporter\'s own path and its rephrasings', () => {
    for (const bad of [
      '- Verify the write by running sqlite3 ~/.claude-flow/user-memory.db "SELECT * FROM memory_entries"',
      '- Confirm the exact row through SQLite against <project>/.swarm/memory.db',
      "- Check that .swarm/memory.db's mtime actually moved after the store.",
    ]) expect(scanText(bad), `must flag a managed-store instruction: ${bad}`).not.toEqual([]);
  });

  it('positively prescribes the structured replacement, including NON-DEFAULT stores', () => {
    // Removing bad guidance without supplying the good one leaves an agent to improvise, which is
    // how it reached for sqlite3 in the first place. The reporter's store was USER-level
    // (~/.claude-flow/user-memory.db), so a project-only example is not enough.
    const pb = read('plugin/skills/ruvnet-brain/PLAYBOOK.md');
    expect(pb, 'the structured retrieve').toMatch(/ruflo memory retrieve/);
    expect(pb, 'the prohibition, in terms').toMatch(/NEVER open a Ruflo\/AgentDB-managed store/);
    expect(pb, 'the structured health tool').toMatch(/agentdb_health/);
    expect(pb, 'a user-level / non-default store must have a named structured route').toMatch(/user-memory\.db|non-default/i);
    expect(pb, 'and the managed-CLI route for interfaces the MCP tools do not cover').toMatch(/ruvnet_cli_help/);
  });

  it('BOTH HOSTS: Claude and Codex read the same scanned skill payload', () => {
    // "Packed-install proof covers both Claude Code and Codex copies." Both manifests resolve to
    // ./skills/, so one fix covers both — but that must be asserted, not assumed, or a future
    // divergence ships a clean Claude copy and a poisoned Codex one.
    const claude = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
    const codex = JSON.parse(read('plugin/.codex-plugin/plugin.json'));
    expect(codex.skills, 'Codex skills root').toBe('./skills/');
    expect(claude.skills ?? './skills/', 'Claude skills root').toBe('./skills/');
    // …and the directory both point at is the one this test scanned.
    expect(fs.existsSync(path.join(ROOT, 'plugin/skills/ruvnet-brain/PLAYBOOK.md'))).toBe(true);
  });

  it('THE BOUNDARY NAMES THE PRECISE SUBSTITUTE, not a guessed project path', () => {
    // ADR-063's refusal returns to the model as the reason. The reporter was at a USER-level store;
    // a refusal that hardcodes <project>/.swarm/memory.db sends them to the wrong file.
    const hijack = read('plugin/scripts/hijack-ruvnet.sh');
    expect(hijack, 'must offer retrieve, not only search/store').toMatch(/ruflo memory retrieve/);
    expect(hijack, 'must echo the store the caller actually targeted').toMatch(/_target_store|\$_store/);
  });
});
