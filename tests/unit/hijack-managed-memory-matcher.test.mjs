import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HIJACK = path.join(ROOT, 'plugin', 'scripts', 'hijack-ruvnet.sh');

/**
 * Issue #102 — the managed-memory advisory must fire on an INVOCATION, not on prose.
 *
 * The matcher was:
 *   'redis[^\n]*(memory|embedding)|sqlite[^\n]*(memory|vector)|mem0|zep[- ]memory'
 *
 * `[^\n]` is not "any character except newline" in POSIX ERE — there is no \n escape inside a
 * bracket expression, so the set is {backslash, n} negated. Every common sqlite3 flag contains an
 * n (-json, -column, -readonly, -line), so each one ended the match before it could reach
 * `memory`: the exact invocations most worth catching were the ones that slipped through.
 *
 * It is also grep-dependent. Measured 2026-08-05: ugrep 7.5.0 on macOS treats \n as a newline
 * escape and DOES match `sqlite3 -json …`; the reporter's grep does not. A matcher whose verdict
 * depends on which grep is installed is not a matcher, which is why these cases run the REAL hook
 * rather than re-implementing the regex here.
 *
 * The second half is false positives: it classified a flat payload string, so `ruflo memory search
 * "sqlite3 memory"` — prose invoking no SQLite — tripped the advisory, firing at someone already
 * using the sanctioned tool. That teaches people to ignore the advisory, which is worse than silence.
 */
function fires(payload) {
  const r = spawnSync('bash', [HIJACK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: payload }, session_id: 'test' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin') },
  });
  return `${r.stdout || ''}`.includes('durable agent memory use AgentDB');
}

describe('issue #102 — managed-memory advisory fires on invocations, not prose', () => {
  it('fires on a direct sqlite3 call against a managed store, plain or flagged', () => {
    // The plain form always worked. The flagged forms are the reported bug: each flag carries an
    // `n`, which is what broke the old bracket expression.
    expect(fires("sqlite3 .swarm/memory.db 'SELECT 1'"), 'plain').toBe(true);
    expect(fires("sqlite3 -json .swarm/memory.db 'SELECT 1'"), '-json was silent').toBe(true);
    expect(fires("sqlite3 -readonly .swarm/memory.db 'SELECT 1'"), '-readonly was silent').toBe(true);
    expect(fires("sqlite3 -column .swarm/memory.db '.tables'"), '-column').toBe(true);
    expect(fires("sqlite3 -line ~/.cache/ruvnet-brain/agentdb.db '.schema'"), '-line').toBe(true);
  });

  it('stays SILENT on prose that merely mentions sqlite and memory', () => {
    // The reported false positive: this IS the sanctioned tool. Firing here trains people to
    // ignore the advisory, which costs more than the advisory ever gains.
    expect(fires("ruflo memory search 'sqlite3 memory'"), 'the sanctioned tool must not be scolded').toBe(false);
    expect(fires("echo 'we used to keep memory in sqlite'")).toBe(false);
    expect(fires('git commit -m "docs: explain why sqlite memory glue is discouraged"')).toBe(false);
  });

  it('TEETH: still catches the invocation when it is not first on the line', () => {
    // A command after a separator is still an invocation. Without this the fix would be trivially
    // evaded by `cd /tmp && sqlite3 …`, and the test above would not notice.
    expect(fires("cd /tmp && sqlite3 .swarm/memory.db 'SELECT 1'"), 'after &&').toBe(true);
    expect(fires("ls; sqlite3 .swarm/memory.db '.tables'"), 'after ;').toBe(true);
  });

  it('TEETH: a sqlite3 call against an UNmanaged database is not this rule\'s business', () => {
    // The advisory is about Ruflo-managed stores. Scolding every sqlite3 use would be the same
    // over-firing defect in a new coat.
    expect(fires("sqlite3 /tmp/scratch.sqlite 'SELECT 1'")).toBe(false);
  });
});
