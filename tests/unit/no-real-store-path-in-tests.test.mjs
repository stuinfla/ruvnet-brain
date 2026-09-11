// no-real-store-path-in-tests.test.mjs — no test may REACH the real project memory store.
//
// Measured 2026-09-11: `.swarm/memory.db` was destroyed twice in one day. `scripts/performance-baseline.mjs`
// ran `fs.unlinkSync('.swarm/memory.db')` ten times "to force cold-start" (2,155 rows gone at 14:37), and
// `tests/integration/session-isolation-audit-trail.test.mjs` built `path.join(REPO_ROOT, '.swarm/memory.db')`
// and ran INSERT/DELETE through sqlite3 against it on every run. Both were green. A test that touches the
// developer's live store is not a test; it is a routine that happens to assert.
//
// THE RULE: a test may NAME '.swarm/memory.db' as data — a command string under test, a contract fixture
// value, a corpus passage (17 files do, legitimately). It may not CONSTRUCT that path from an anchor that
// resolves to the real checkout, cwd, or home, and it may not run a filesystem or sqlite operation against
// the literal. Fixtures live under mkdtemp.
//
// Proved by breaking: the detector is run against the two real offending lines before it is run against
// the tree, and must flag both — and must NOT flag the three legitimate data shapes.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = path.resolve(fileURLToPath(import.meta.url));

// A — the store path built from an anchor that resolves to the real checkout / cwd / home.
const ANCHORED = /(REPO_ROOT|\bREPO\b|\bROOT\b|__dirname|process\.cwd\(\)|homedir\(\))[^\n;]*(['"`][^'"`]*\.swarm[^'"`]*['"`][^\n;]*['"`]?memory\.db|\.swarm\/memory\.db)/;
// B — a filesystem or sqlite operation whose DIRECT argument is the literal relative path. The literal
// as a path.join() segment on a tmp dir (`path.join(dir, '.swarm/memory.db')`) is a fixture and is legal;
// only the bare literal as the operand reaches the real cwd store.
const DIRECT_OP = /(fs\.(unlink|rm|writeFile|appendFile|open|truncate|copyFile|rename)Sync?\(\s*['"`]\.swarm\/memory\.db['"`]|spawnSync\(\s*['"`]sqlite3['"`]\s*,\s*\[\s*['"`]\.swarm\/memory\.db|execSync\(\s*['"`]sqlite3\s+\.swarm\/memory\.db)/;

export function offendingLines(source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    if (ANCHORED.test(line) || DIRECT_OP.test(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures' && entry.name !== 'node_modules') yield* walk(p);
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      yield p;
    }
  }
}

describe('no test may reach the real project memory store', () => {
  it('the detector flags the two real offenders and none of the data shapes (guard proved by breaking)', () => {
    expect(offendingLines("const MEMORY_DB_PATH = path.join(REPO_ROOT, '.swarm/memory.db');")).toHaveLength(1);
    expect(offendingLines("fs.unlinkSync('.swarm/memory.db'); // force cold-start")).toHaveLength(1);
    expect(offendingLines("const db = path.join(os.homedir(), '.swarm', 'memory.db');")).toHaveLength(1);
    expect(offendingLines('const cmd = \'ruflo memory search -q "x" --path .swarm/memory.db\';')).toEqual([]);
    expect(offendingLines("canonicalAgentDbPath: '/repo/.swarm/memory.db',")).toEqual([]);
    expect(offendingLines("const db = path.join(tmp, '.swarm', 'memory.db');")).toEqual([]);
    expect(offendingLines("fs.writeFileSync(path.join(dir, '.swarm/memory.db'), 'x');")).toEqual([]);
    expect(offendingLines("spawnSync('sqlite3', ['.swarm/memory.db', sql]);")).toHaveLength(1);
  });

  it('tests/ contains no anchored store path and no direct operation on the literal', () => {
    const hits = [];
    for (const file of walk(path.join(ROOT, 'tests'))) {
      if (path.resolve(file) === SELF) continue;
      for (const o of offendingLines(fs.readFileSync(file, 'utf8'))) {
        hits.push(`${path.relative(ROOT, file)}:${o.line}: ${o.text}`);
      }
    }
    expect(hits, 'fixtures only — never the real store').toEqual([]);
  });

  it('no script deletes a memory store by literal name', () => {
    const hits = [];
    for (const dir of ['scripts', 'plugin/scripts', 'bin', 'kb']) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (/(unlink|rm)Sync\([^)]*memory\.db['"`]/.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
