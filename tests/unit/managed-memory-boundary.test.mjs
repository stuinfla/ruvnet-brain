import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HIJACK = path.join(ROOT, 'plugin', 'scripts', 'hijack-ruvnet.sh');

/**
 * ADR-063 / issue #103 — the managed-memory boundary is ENFORCEABLE, opt-in, and default-off.
 *
 * The reporter measured a long Codex session: 59 shell calls went straight at Ruflo-managed memory
 * stores, the Brain prevented NONE, and 49 did not even ask for read-only. The advisory was
 * neutered five independent ways — hijack-ruvnet's hardcoded `defer`, the shim's advisory mode,
 * `|| true` on the registration, the Codex adapter deleting permissionDecision, and the 1–5 dial
 * being speech-only — each sufficient on its own, so fixing any one changed nothing.
 *
 * The property that matters most here is the FIRST case: a user who changes nothing must see
 * byte-identical behaviour. This repo has already shipped three gates that could never pass; a gate
 * that merely nags is a nuisance, one that BLOCKS is an outage.
 */
let home;
const run = (boundary, command) => {
  fs.writeFileSync(
    path.join(home, '.config', 'ruvnet-brain', 'settings.json'),
    JSON.stringify({ version: 1, settings: { managedMemoryBoundary: boundary } }),
  );
  const r = spawnSync('bash', [HIJACK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 't' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin') },
  });
  return { code: r.status, err: `${r.stderr || ''}` };
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-boundary-'));
  fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('ADR-063 — managed-memory boundary', () => {
  it('THE DEFAULT REFUSES NOTHING — a user who changes nothing is unaffected', () => {
    expect(run('advise', "sqlite3 .swarm/memory.db 'SELECT 1'").code, 'read at default').toBe(0);
    expect(run('advise', "sqlite3 .swarm/memory.db 'DELETE FROM memory_entries'").code, 'even a WRITE at default').toBe(0);
  });

  it('read-only allows reads and refuses writes', () => {
    expect(run('read-only', "sqlite3 .swarm/memory.db 'SELECT 1'").code).toBe(0);
    const w = run('read-only', "sqlite3 .swarm/memory.db 'DELETE FROM memory_entries'");
    expect(w.code, 'a write behind Ruflo is what corrupts a store').toBe(2);
    // stderr returns to the model, so a refusal that only says "no" burns a turn. The reporter's
    // nine failures were an agent GUESSING schema it should never have needed to guess.
    expect(w.err).toMatch(/ruflo memory (search|store)/);
  });

  it('block refuses any direct access, read included', () => {
    expect(run('block', "sqlite3 .swarm/memory.db 'SELECT 1'").code).toBe(2);
  });

  it('TEETH: an UNMANAGED database is never this rule\'s business, even at block', () => {
    // Refusing every sqlite3 call would be the same over-firing defect in a new coat.
    expect(run('block', "sqlite3 /tmp/scratch.sqlite 'DROP TABLE t'").code).toBe(0);
  });

  it('TEETH: prose is never refused — enforcement rides on the #102 invocation matcher', () => {
    // A boundary built on a prose matcher would refuse someone for writing a sentence, and this is
    // the sanctioned tool besides.
    expect(run('block', "ruflo memory search 'sqlite3 memory'").code).toBe(0);
  });

  it('an unreadable or absent setting degrades to advise, never to a refusal', () => {
    fs.rmSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), { force: true });
    const r = spawnSync('bash', [HIJACK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: "sqlite3 .swarm/memory.db 'DELETE FROM x'" }, session_id: 't' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(r.status, 'a hook that cannot read a preference must never refuse because of it').toBe(0);
  });
});
