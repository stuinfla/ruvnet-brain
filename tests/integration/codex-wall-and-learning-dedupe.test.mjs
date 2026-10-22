// Second 4.7.0 review (N1, N2, N3, N5). Each case fails on the code before this change:
//   N2  the REAL Codex path (codex-hook-adapter → hook-shim → decision-gate) refuses an Add-File patch that
//       creates an outbox module; the adapter rewrites apply_patch into an Edit, which the wall used to skip
//   N3  an apply_patch hunk with no (or non-matching) context is judged, not dropped
//   N1  one learning row per (session, tool, action): 20 identical observations = 1 stored row, 0 ledger rows
//   N5  a body the Codex wrapper kills leaves a hook-failures row
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, tmp } from '../helpers/continuity-fixture.mjs';
import { slowRuflo, ledgerRows, storedRows } from '../helpers/slow-ruflo.mjs';
import { proposedChanges, substitutionVerdict } from '../../plugin/scripts/substitution-wall.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ADAPTER = path.join(ROOT, 'plugin/scripts/codex-hook-adapter.mjs');
const WRAPPER = path.join(ROOT, 'plugin/scripts/codex-hook-wrapper.mjs');
const LEARN = path.join(ROOT, 'plugin/scripts/learn-capture.mjs');
const posix = process.platform !== 'win32';
const OUTBOX = "import fs from 'node:fs';\nconst OUTBOX = '.swarm/outbox.jsonl';\nexport function put(r) { const fd = fs.openSync(OUTBOX, 'a'); fs.writeSync(fd, JSON.stringify(r)); fs.fsyncSync(fd); fs.closeSync(fd); }\nexport function replay(send) { for (const l of fs.readFileSync(OUTBOX, 'utf8').split('\\n')) if (l) send(JSON.parse(l)); }\n";
const plus = (body) => body.split('\n').map((l) => `+${l}`).join('\n');
afterEach(() => cleanup());

describe('N2: the wall judges apply_patch on the real Codex adapter path', () => {
  const repo = () => {
    const dir = fs.realpathSync.native(tmp('n2-repo-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"ruvnet-brain"}');
    fs.mkdirSync(path.join(dir, 'plugin', 'scripts'), { recursive: true });
    spawnSync('git', ['-C', dir, 'init', '-q']);
    return dir;
  };
  const fire = (dir, file, body) => spawnSync(process.execPath, [ADAPTER, 'decision-gate', 'write'], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, RUVNET_BRAIN_HOME: path.join(dir, 'bh'), RUVNET_BRAIN_STATE_DIR: path.join(dir, 'st'), RUVNET_SUBSTITUTION_WALL: '' },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', session_id: 'n2', cwd: dir,
      tool_input: { command: `*** Begin Patch\n*** Add File: ${file}\n${plus(body)}\n*** End Patch\n` } }),
  });
  it('an Add-File patch creating an outbox module exits 2 with the wall refusal', () => {
    const r = fire(repo(), 'plugin/scripts/x-outbox.mjs', OUTBOX);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED — plugin\/scripts\/x-outbox\.mjs rebuilds rUv's storage/);
  });
  it('an ordinary patch passes', () => {
    const r = fire(repo(), 'plugin/scripts/x-plain.mjs', 'export const x = 1;\n');
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('N3: context-free and non-matching hunks are judged, never dropped', () => {
  for (const [name, header] of [['no context', '@@'], ['non-matching context', '@@\n this line is not in the file']]) {
    it(`${name}: a hunk that adds a whole outbox module is refused`, () => {
      const patch = `*** Begin Patch\n*** Update File: plugin/scripts/y.mjs\n${header}\n${plus(OUTBOX)}\n*** End Patch`;
      const [c] = proposedChanges({ tool_name: 'apply_patch', tool_input: { command: patch } }, () => 'export const a = 1;\n');
      expect(c.after).not.toBe(c.before);
      expect(substitutionVerdict({ path: c.file, content: c.after, before: c.before }).verdict).toBe('refuse');
    });
  }
});

describe('N1: learning rows are bounded by distinct (session, tool, action) pairs', () => {
  const learner = (opts) => {
    const home = fs.realpathSync.native(tmp('n1-home-'));
    fs.mkdirSync(path.join(home, '.claude', 'global-memory', '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db'), '');
    fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}');
    const stubDir = tmp('n1-ruflo-'); const stub = slowRuflo(stubDir, opts); const brainHome = tmp('n1-bh-');
    const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, RUFLO_BIN: stub.bin, RUVNET_LEARNING_SCOPE: 'user',
      RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain') };
    const fire = () => spawnSync(process.execPath, [LEARN], { env, encoding: 'utf8', timeout: 20_000,
      input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'n1', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } }) });
    return { stub, stubDir, brainHome, fire };
  };
  it.skipIf(!posix)('the same action 20 times in one session stores one row and writes no ledger row', () => {
    const l = learner();
    for (let i = 0; i < 20; i += 1) expect(l.fire().status).toBe(0);
    const rows = Object.keys(storedRows(l.stubDir)).filter((k) => k.startsWith('learning-observations/'));
    expect(rows).toHaveLength(1);
    // The first call reached ruflo; the 19 identical ones were coalesced by the parent's marker (2026-10-21) — before
    // that every one spawned a ruflo that then refused the duplicate. ruflo's own --no-upsert dedupe remains the backstop.
    expect(l.stub.calls().filter((c) => c.argv[1] === 'store')).toHaveLength(1);
    expect(ledgerRows(l.brainHome)).toEqual([]);
  }, 120_000);
  it.skipIf(!posix)('a real refusal still writes a learn-capture ledger row', () => {
    const l = learner({ refuse: true });
    expect(l.fire().status).toBe(0);
    expect(ledgerRows(l.brainHome).map((r) => r.hook)).toEqual(['learn-capture']);
  }, 30_000);
});

describe('N5: a body the Codex wrapper kills is a ledger row, not silence', () => {
  it.skipIf(!posix)('a 5 s body under a 300 ms wrapper budget leaves killed-by-codex-wrapper', () => {
    const brainHome = fs.realpathSync.native(tmp('n5-bh-'));
    const scripts = path.join(brainHome, 'versions', 'v1', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'codex-hook-adapter.mjs'), 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);\n');
    fs.copyFileSync(path.join(ROOT, 'plugin/scripts/hook-failures.mjs'), path.join(scripts, 'hook-failures.mjs'));
    fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({ codeRoot: 'versions/v1' }));
    const r = spawnSync(process.execPath, [WRAPPER, 'decision-gate', 'write'], { encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, RUVNET_BRAIN_HOME: brainHome, RUVNET_CODEX_HOOK_TIMEOUT_MS: '300' },
      input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: os.tmpdir() }) });
    expect(r.status).toBe(0); // fails open
    expect(ledgerRows(brainHome)).toEqual([expect.objectContaining({ hook: 'decision-gate', event: 'write', error: 'killed-by-codex-wrapper', limitMs: 300 })]);
  }, 30_000);
});
