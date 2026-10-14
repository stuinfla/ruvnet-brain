// tests/unit/substitution-wall.test.mjs — the write-time wall: "if you are rebuilding rUv's storage, stop
// and call his tool". Positive fixtures are the REAL persistence modules that shipped in 4.6.4 (the
// 2026-10-12 incident: a 3.38 GB outbox, queues, replay workers in front of `ruflo memory store`);
// negative fixtures are real KEEP modules. The old gate reported "none" on every one of them.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { substitutionVerdict, message, inScope } from '../../plugin/scripts/substitution-wall.mjs';
import { audit, storageAudit } from '../../scripts/no-silent-substitution.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHIPPED = '845d55bd'; // origin/main = 4.6.4, where every positive fixture below still existed

/** A positive fixture is the file AS SHIPPED in 4.6.4 (pinned commit), never the working tree: a module rewritten
 *  to call ruflo must stop refusing, and that must not flip this fixture. Null on a shallow clone. */
function shipped(rel) {
  const r = spawnSync('git', ['-C', ROOT, 'show', `${SHIPPED}:${rel}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/** The real file: from disk, else from the 4.6.4 commit (it may since have been deleted), else null. */
function real(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { /* deleted since 4.6.4 */ }
  const r = spawnSync('git', ['-C', ROOT, 'show', `${SHIPPED}:${rel}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

const REPLACE = ['project-progression-outbox', 'project-capture-queue', 'session-snapshot-hook', 'turn-transport-journal',
  'continuity-journal', 'learning-queue', 'turn-outcome-capture'].map((n) => `plugin/scripts/${n}.mjs`);
const KEEP = ['lesson-store', 'lesson-gate', 'lesson-provenance', 'decision-record', 'hook-shim', 'hook-input', 'grounding-substance',
  'grounding-turn-evidence', 'continuation-gate', 'duplicate-gate', 'decision-outcomes', 'learning-store', 'routing-outcome-capture', 'decision-gate'].map((n) => `plugin/scripts/${n}.mjs`);

describe('substitution-wall — refuses the real hand-built transports (positive fixtures)', () => {
  it('refuses a minimal synthetic outbox + replay transport (always runs, independent of git history)', () => {
    const content = "import fs from 'node:fs';\nconst OUTBOX = '.swarm/outbox.jsonl';\nexport function enqueue(row) { const fd = fs.openSync(OUTBOX, 'a'); fs.writeSync(fd, JSON.stringify(row) + '\\n'); fs.fsyncSync(fd); fs.closeSync(fd); }\nexport function replay(send) { for (const line of fs.readFileSync(OUTBOX, 'utf8').split('\\n')) if (line) send(JSON.parse(line)); }\n";
    const v = substitutionVerdict({ path: 'plugin/scripts/x-outbox.mjs', content });
    expect(v.verdict, v.signals.join(',')).toBe('refuse');
  });
  for (const rel of REPLACE) {
    const src = shipped(rel);
    it.skipIf(src === null)(`refuses ${rel}${src === null ? ' (commit 845d55bd unavailable — shallow clone)' : ''} as shipped in 4.6.4`, () => {
      const v = substitutionVerdict({ path: rel, content: src });
      expect(v.verdict, v.signals.join(',')).toBe('refuse');
      expect(v.signals).toEqual(expect.arrayContaining(['persist', 'transport']));
    });
  }
});

describe('substitution-wall — never refuses real KEEP modules (negative fixtures)', () => {
  for (const rel of KEEP) {
    it(`does not refuse ${rel}`, () => {
      const src = real(rel);
      expect(src, `${rel} must exist`).not.toBeNull();
      expect(substitutionVerdict({ path: rel, content: src }).verdict).not.toBe('refuse');
    });
  }
});

const OUTBOX = `import fs from 'node:fs';
export function appendSnapshot(dir, rec) {
  const fd = fs.openSync(dir + '/.swarm/state-outbox.jsonl', 'a');
  fs.writeSync(fd, JSON.stringify(rec) + '\\n'); fs.fsyncSync(fd); fs.closeSync(fd);
}`;

describe('substitution-wall — the rules', () => {
  it('a comment that DESCRIBES an outbox is not one', () => {
    const v = substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: `// the old outbox journal used fsyncSync and appendFileSync\nexport const a = 1;` });
    expect(v.verdict).toBe('pass');
  });
  it('the only persistence being an argv to ruflo passes (exception E)', () => {
    const src = "import { spawnSync } from 'node:child_process';\nspawnSync('ruflo', ['memory', 'store', '-k', key, '--value', v]);";
    expect(substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: src }).verdict).toBe('pass');
  });
  it('a HAND-ROLLED disclosure header does NOT lift a storage refusal', () => {
    const v = substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: `/* HAND-ROLLED: ruflo is slow. REAL TOOL: ruflo memory store */\n${OUTBOX}` });
    expect(v.verdict).toBe('refuse');
    expect(message('plugin/scripts/x.mjs', v)).toMatch(/does NOT lift this[\s\S]*substitutionAllow/);
  });
  it('the refusal names the signals and the rUv tool to call', () => {
    const text = message('plugin/scripts/x.mjs', substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: OUTBOX }));
    expect(text).toMatch(/signals: durable, memorySink, persist, transport/);
    expect(text).toMatch(/ruflo memory store\|retrieve\|search/);
  });
  it('an owner allowlist entry downgrades to warn; nothing else does', () => {
    expect(substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: OUTBOX, allow: ['plugin/scripts/x.mjs'] }).verdict).toBe('warn');
  });
  it('RATCHET: editing known debt without a new signal warns; adding a signal refuses', () => {
    expect(substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: `${OUTBOX}\n// trimmed`, before: OUTBOX }).verdict).toBe('warn');
    const grown = `${OUTBOX}\nfs.openSync(lockPath, 'wx');`;
    expect(substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: grown, before: OUTBOX }).verdict).toBe('refuse');
  });
  it('writing rUv\'s memory_entries table directly is refused', () => {
    const src = "import { DatabaseSync } from 'node:sqlite';\nconst db = new DatabaseSync(p + '/.swarm/memory.db');\ndb.prepare('INSERT INTO memory_entries (key) VALUES (?)').run(k);";
    expect(substitutionVerdict({ path: 'scripts/x.mjs', content: src }).verdict).toBe('refuse');
  });
  it('scope: tests, docs and other trees are never judged', () => {
    for (const p of ['tests/unit/x.test.mjs', 'docs/x.md', 'kb/x.mjs', 'plugin/scripts/x.test.mjs']) expect(inScope(p)).toBe(false);
    expect(substitutionVerdict({ path: 'tests/unit/x.mjs', content: OUTBOX }).verdict).toBe('pass');
  });
});

/** A throwaway repo with one script and an (optionally) empty ratchet config. */
function repoWith(name, body, config = { substitutionBaseline: [], stateFiles: [], maxUnbounded: 0 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-'));
  fs.mkdirSync(path.join(root, 'plugin', 'scripts'), { recursive: true }); fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ruvnet-brain' }));
  fs.writeFileSync(path.join(root, 'config', 'state-files.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'plugin', 'scripts', name), body);
  return root;
}

describe('CI gate — the storage class the old gate did not have', () => {
  it('the OLD rule (package-name capabilities) reports nothing on the real outbox — the gap', () => {
    const root = repoWith('project-progression-outbox.mjs', real('plugin/scripts/project-progression-outbox.mjs') ?? OUTBOX);
    expect(audit(root)).toHaveLength(0);
    const { violations } = storageAudit(root);
    expect(violations.map((v) => v.capability)).toContain('storage/queue/journal');
  });
  it('an appended file that is not registered with a bound fails the ratchet', () => {
    const { violations } = storageAudit(repoWith('ledger.mjs', "import fs from 'node:fs';\nfs.appendFileSync('x-ledger.jsonl', 'a');"));
    expect(violations.find((v) => v.capability === 'state-file ratchet')?.why).toMatch(/x-ledger\.jsonl/);
  });
  it('the live repo is inside its ratchet: no NEW transport, no unregistered append target', () => {
    const { violations } = storageAudit();
    expect(violations, violations.map((v) => `${v.file}: ${v.why}`).join('\n')).toHaveLength(0);
  });
});

describe('decision-gate integration — the policy is composed into the ONE PreToolUse decision', () => {
  const GATE = path.join(ROOT, 'plugin', 'scripts', 'decision-gate.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-home-'));
  const fire = (cwd, file, content) => spawnSync(process.execPath, [GATE, 'write'], {
    input: JSON.stringify({ session_id: 'wall-test', hook_event_name: 'PreToolUse', tool_name: 'Write', cwd, tool_input: { file_path: file, content } }),
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain'), RUVNET_DECISION_TRACE: '1' },
  });
  const wallMs = (stderr) => JSON.parse(/\[decision-gate\] write \d+ms budget=\d+ms (\[.*\])/.exec(stderr)?.[1] || '[]').find((t) => t.id === 'substitution-wall');

  it('REFUSES a new outbox module in this repo, with the wall\'s own words', () => {
    const r = fire(ROOT, 'plugin/scripts/new-state-outbox.mjs', OUTBOX);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/rebuilds rUv's storage/);
    expect(wallMs(r.stderr)?.code).toBe(2);
  });
  it('WARNS (never refuses) the same content in a project that is not this repo', () => {
    const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-stranger-'));
    const r = fire(stranger, 'scripts/state-outbox.mjs', OUTBOX);
    expect(wallMs(r.stderr)?.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/substitution-wall/);
  });
  it('allows an ordinary script, and the wall stays far inside the 2000 ms budget', () => {
    const r = fire(ROOT, 'scripts/hello.mjs', 'export const hello = () => 1;\n');
    const t = wallMs(r.stderr);
    expect(t?.code).toBe(0);
    expect(t.ms).toBeLessThan(500);
  });
});
