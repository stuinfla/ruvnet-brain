import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE END-TO-END PROOF ADR-066 OWED (its own honesty boundary called this out).
 *
 * Every other test in this repo covers ONE hop: the bridge builds a lesson, the store ranks it, the
 * gate composes a decision, the runtime writes an envelope. Each passed while the chain as a whole
 * was never once exercised — and this project's entire history is hops that work individually and a
 * chain that does not (ADR-066's own measurement: two stores, both excellent, connected by nothing).
 *
 * So this walks the WHOLE path with real processes and no mocks:
 *
 *   a tagged AgentDB row
 *     -> lesson-bridge --apply      (reads the store, writes lessons.json)
 *       -> lesson-gate              (ranks it, decides it applies at write-code)
 *         -> unprompted-runtime     (the ADR-040 chokepoint, sole writer of user bytes)
 *           -> decision-gate        (the ADR-067 chokepoint, sole author of a refusal)
 *             -> the model's additionalContext
 *
 * If any hop stops carrying the lesson, this goes red and names the hop. That is the difference
 * between "the bridge is wired" as a claim and as a fact.
 *
 * HERMETIC: its own HOME, its own config root, its own sqlite store. It reads nothing from the
 * maintainer's machine, so it asserts a property of the PRODUCT rather than of one laptop
 * (lesson-hermetic-fixtures-own-every-input).
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const BRIDGE = path.join(ROOT, 'plugin', 'scripts', 'lesson-bridge.mjs');
const GATE = path.join(ROOT, 'plugin', 'scripts', 'decision-gate.mjs');

/** node:sqlite is absent on Node 20 (CI's `check` job) — skip loudly rather than fail the suite. */
const sqlite = await (async () => {
  try { return (process.getBuiltinModule?.('node:sqlite')) ?? (await import('node:sqlite')); }
  catch { return null; }
})();
const withSqlite = sqlite ? describe : describe.skip;

const STATEMENT = 'NEVER SHIP A GUARD YOU HAVE NOT WATCHED FAIL ON BROKEN CODE.';
let home; let configRoot; let globalDb;

/** An AgentDB-shaped global store holding one tagged lesson — tags in the shape ruflo persists. */
function seedGlobalStore(file, { tags }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default', content TEXT NOT NULL,
    tags TEXT, metadata TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    provenance_type TEXT DEFAULT 'unknown', UNIQUE(namespace, key))`);
  db.prepare('INSERT INTO memory_entries (id,key,namespace,content,tags,provenance_type,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('1', 'lesson-e2e-proof', 'global', `${STATEMENT} Recorded by the end-to-end proof.`,
      JSON.stringify(tags.split(',')), 'user_claim', 1754800000000);
  db.close();
}

const env = (extra = {}) => ({
  ...process.env,
  HOME: home,
  RUVNET_CONFIG_ROOT: configRoot,
  RUVNET_GLOBAL_MEMORY_DB: globalDb,
  RUVNET_PROJECT_MEMORY_DB: path.join(home, 'no-project-store.db'),
  RUVNET_LESSON_GATE_STATE: path.join(configRoot, 'gate-state.json'),
  ...extra,
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'));
  configRoot = path.join(home, '.config', 'ruvnet-brain');
  globalDb = path.join(home, 'global-memory', 'memory.db');
  fs.mkdirSync(configRoot, { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** Fire the REAL decision gate the way PreToolUse does, and return its forwarded advisory text. */
function fireWrite(sessionId = 'e2e') {
  const payload = JSON.stringify({
    session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: ROOT,
    tool_input: { file_path: path.join(home, 'ordinary.mjs'), content: 'x' },
  });
  const r = spawnSync(process.execPath, [GATE, 'write'], { input: payload, encoding: 'utf8', env: env(), timeout: 40_000 });
  let context = '';
  try { context = JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.additionalContext || ''; } catch { context = ''; }
  return { code: r.status, context, stderr: r.stderr || '' };
}

withSqlite('a tagged AgentDB row reaches the model, through every real hop', () => {
  it('bridges, ranks, and is delivered as additionalContext at the write-code decision point', () => {
    seedGlobalStore(globalDb, { tags: 'trigger:write-code,enforce:inject,severity:high' });

    // HOP 1-2: the bridge reads the store and writes the lesson the gate reads.
    // timeout is load-bearing, not decorative: execFileSync with none blocks the WHOLE main thread
    // synchronously, so vitest's own it(...) timeout can never fire (it needs a free event loop) —
    // this is what turned a hang into two silent 6h GitHub Actions job-ceiling kills (2026-08-10).
    const applied = execFileSync(process.execPath, [BRIDGE, '--apply'], { encoding: 'utf8', env: env(), timeout: 40_000 });
    expect(applied, 'the bridge must report what it installed').toMatch(/applied: store/);
    const store = JSON.parse(fs.readFileSync(path.join(configRoot, 'lessons.json'), 'utf8'));
    expect(store.lessons.map((l) => l.id)).toContain('G-e2e-proof');

    // HOP 3-5: gate -> runtime -> chokepoint -> the model's context.
    const { code, context } = fireWrite();
    expect(code, 'an ordinary write must still be allowed').toBe(0);
    expect(context, 'the lesson did not survive the chain to the model').toContain(STATEMENT);
  }, 60_000);

  it('TEETH: an UNTAGGED row travels no further than the store — the chain is genuinely load-bearing', () => {
    // Without this, the assertion above could pass on a chain that delivers everything regardless of
    // whether the bridge ran at all — the fixture would not be falsifying its own choice.
    seedGlobalStore(globalDb, { tags: 'severity:high' });   // no trigger: → must not bridge
    execFileSync(process.execPath, [BRIDGE, '--apply'], { encoding: 'utf8', env: env(), timeout: 40_000 });
    const store = JSON.parse(fs.readFileSync(path.join(configRoot, 'lessons.json'), 'utf8'));
    expect(store.lessons.map((l) => l.id)).not.toContain('G-e2e-proof');
    expect(fireWrite('e2e-untagged').context).not.toContain(STATEMENT);
  }, 60_000);

  it('TEETH: a lesson tagged for a DIFFERENT moment does not fire at this one', () => {
    // Proves the trigger is load-bearing rather than decorative — a chain that delivered every lesson
    // at every decision point would pass the first case and be useless.
    seedGlobalStore(globalDb, { tags: 'trigger:ship,enforce:inject,severity:high' });
    execFileSync(process.execPath, [BRIDGE, '--apply'], { encoding: 'utf8', env: env(), timeout: 40_000 });
    const store = JSON.parse(fs.readFileSync(path.join(configRoot, 'lessons.json'), 'utf8'));
    expect(store.lessons.map((l) => l.id), 'it must still bridge').toContain('G-e2e-proof');
    expect(fireWrite('e2e-ship').context, 'but must not speak at write-code').not.toContain(STATEMENT);
  }, 60_000);
});
