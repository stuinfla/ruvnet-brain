// Review M6 (4.7.0): the wall must see Codex's apply_patch and NotebookEdit, know the pending/flush/retry
// forms of a transport, and REFUSE an edit to a known-debt file that adds a new transport word.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { substitutionVerdict, proposedChanges, transportTerms } from '../../plugin/scripts/substitution-wall.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WALL = path.join(ROOT, 'plugin/scripts/substitution-wall.mjs');
const OUTBOX = "import fs from 'node:fs';\nconst OUTBOX = '.swarm/outbox.jsonl';\nexport function put(r) { const fd = fs.openSync(OUTBOX, 'a'); fs.writeSync(fd, JSON.stringify(r)); fs.fsyncSync(fd); fs.closeSync(fd); }\nexport function replay(send) { for (const l of fs.readFileSync(OUTBOX, 'utf8').split('\\n')) if (l) send(JSON.parse(l)); }\n";
// The shape decision-record.mjs had at db1c5a2f: an fsynced pending directory and a --flush replay.
const PENDING = "import fs from 'node:fs';\nconst pendingDir = (db) => db + '.decision-records-pending';\nexport function keep(db, e) { const fd = fs.openSync(pendingDir(db) + '/' + e.key, 'w'); fs.writeSync(fd, JSON.stringify(e)); fs.fsyncSync(fd); fs.closeSync(fd); }\nexport function flushPending(db, store) { for (const n of fs.readdirSync(pendingDir(db))) store(JSON.parse(fs.readFileSync(n, 'utf8'))); }\nif (process.argv.includes('--flush')) flushPending(process.argv[2], () => {});\n";

function repo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wall-codex-')));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"ruvnet-brain"}');
  fs.mkdirSync(path.join(dir, 'plugin', 'scripts'), { recursive: true });
  return dir;
}
const runWall = (payload) => spawnSync(process.execPath, [WALL], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, RUVNET_SUBSTITUTION_WALL: '' } });

describe('the wall judges Codex apply_patch and NotebookEdit', () => {
  it('an apply_patch that adds an outbox transport is refused (exit 2); on db1c5a2f it passed unexamined', () => {
    const dir = repo();
    const patch = `*** Begin Patch\n*** Add File: plugin/scripts/x-outbox.mjs\n${OUTBOX.split('\n').map((l) => `+${l}`).join('\n')}\n*** End Patch\n`;
    const r = runWall({ tool_name: 'apply_patch', cwd: dir, tool_input: { command: patch } });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED — plugin\/scripts\/x-outbox\.mjs/);
  });
  it('an apply_patch Update hunk is applied to the file on disk before judging', () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'plugin/scripts/y.mjs'), "import fs from 'node:fs';\nexport const a = 1;\n");
    const patch = "*** Begin Patch\n*** Update File: plugin/scripts/y.mjs\n@@\n import fs from 'node:fs';\n-export const a = 1;\n+export const a = 2;\n*** End Patch";
    const [c] = proposedChanges({ tool_name: 'apply_patch', tool_input: { command: patch } }, (p) => fs.readFileSync(path.join(dir, p), 'utf8'));
    expect(c).toEqual({ file: 'plugin/scripts/y.mjs', before: "import fs from 'node:fs';\nexport const a = 1;\n", after: "import fs from 'node:fs';\nexport const a = 2;\n" });
  });
  it('NotebookEdit yields its new source for judging (.ipynb itself is outside the code scope)', () => {
    expect(proposedChanges({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/x/n.ipynb', new_source: 'print(1)' } }, () => null))
      .toEqual([{ file: '/x/n.ipynb', before: null, after: 'print(1)' }]);
  });
});

describe('transport vocabulary: the storage forms of pending / flush / retry', () => {
  it('refuses the fsynced pending directory + --flush replay shape (it only warned before)', () => {
    const v = substitutionVerdict({ path: 'plugin/scripts/dr.mjs', content: PENDING });
    expect(v.verdict, v.signals.join(',')).toBe('refuse');
  });
  it('a bare status word is not a transport', () => {
    expect([...transportTerms("const status = 'pending'; const retry = 2;")]).toEqual([]);
  });
});

describe('a known-debt file that gains a NEW transport word is refused, not warned', () => {
  it('adding pendingDir to an existing outbox module refuses; an unchanged-vocabulary edit still warns', () => {
    const grown = `${OUTBOX}export const pendingDir = '.swarm/pending';\n`;
    expect(substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: grown, before: OUTBOX }).verdict).toBe('refuse');
    const same = OUTBOX.replace('JSON.stringify(r)', 'JSON.stringify({ r })');
    expect(substitutionVerdict({ path: 'plugin/scripts/x.mjs', content: same, before: OUTBOX }).verdict).toBe('warn');
  });
});
