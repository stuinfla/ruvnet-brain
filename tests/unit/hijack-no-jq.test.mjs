// tests/unit/hijack-no-jq.test.mjs — the action-level interceptor must not depend on `jq`.
//
// THE DEFECT (reproduced live 2026-07-27 before the fix): plugin/scripts/hijack-ruvnet.sh opened with
//     command -v jq >/dev/null 2>&1 || { exit 0; }   # need jq for safe JSON; stay silent if absent.
// On any machine without jq — a fresh corporate laptop, a hardened CI image, a slim container — that
// line silently disabled THE ENTIRE ACTION-LEVEL INTERCEPTOR. The product's central promise, gone,
// with zero notice to the user. Measured: identical payload, jq on PATH -> advisory emitted; jq
// removed from PATH -> ABSOLUTELY NOTHING, exit 0. Indistinguishable from "nothing was wrong".
//
// Silent-off is scored equal to crashing (DDD-0013, External-Signal invariant 6): a capability that
// cannot function must SAY so. node IS guaranteed in Claude Code's environment — verify-interface.sh
// already depends on exactly that — so the JSON work moved into the shared parser (hook-input.mjs
// `payloadOf` / `preToolUseEnvelope`) and the dependency is gone rather than made conditional.
//
// A LESSON THIS TEST ENCODES: jq was used TWICE — once to PARSE the event, once to EMIT the reply.
// Removing only the parse half left the hook reaching a correct verdict and then dying at
// "jq: command not found" on the emit. Both halves or neither. The no-jq case below would have
// passed a naive "did it stop crashing" check and still shipped a mute interceptor.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
// WINDOWS (CI run on 3aa228b, windows-unit red): this suite builds a synthetic PATH by symlinking
// /bin and /usr/bin, and fires the hook with a bare `sh`. None of that exists on a Windows runner, so
// every case failed against a product that is fine on that platform.
//
// The guard tests THE THINGS THIS FILE ACTUALLY USES — a POSIX shell on PATH and a real /bin — not a
// neighbouring fact like `process.platform`. That distinction is not pedantry: earlier today a guard
// here asked "is bash on PATH" while the test hardcoded /bin/bash, GitHub's Windows runner ships Git
// Bash so the guard answered TRUE, and the skip never fired. Check the door you actually walk through.
//
// The jq dependency this suite guards is a POSIX-shell concern by nature; on Windows the hook is
// dispatched through hook-shim.mjs, which is covered by the packed-registration battery instead.
const hasPosixShell = spawnSync('sh', ['-c', 'exit 0']).status === 0 && fs.existsSync('/bin');


const HOOK = path.join(REPO, 'plugin/scripts/hijack-ruvnet.sh');

/** A PATH containing every real binary EXCEPT jq — the stranger's machine, reproduced. */
function pathWithoutJq() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nojq-'));
  for (const d of ['/bin', '/usr/bin']) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (n === 'jq') continue;                                  // the ONE thing withheld
      try { fs.symlinkSync(path.join(d, n), path.join(dir, n)); } catch { /* dupe */ }
    }
  }
  const node = process.execPath;                                 // node is guaranteed by contract
  try { fs.symlinkSync(node, path.join(dir, 'node')); } catch { /* already linked */ }
  return dir;
}

const fire = (payload, env) => spawnSync('sh', [HOOK], {
  input: JSON.stringify(payload), encoding: 'utf8', timeout: 20_000,
  env: { ...process.env, ...(env || {}) },
});

const VECTOR_STORE = { tool_name: 'Write', tool_input: { content: 'import pinecone\nidx = pinecone.Index("x")' } };
const INNOCENT = { tool_name: 'Write', tool_input: { content: 'def add(a, b):\n    return a + b\n' } };

describe.skipIf(!hasPosixShell)('hijack-ruvnet.sh — the interceptor survives a machine without jq', () => {
  it('CONTROL: with a normal PATH it fires on a generic vector store', () => {
    const r = fire(VECTOR_STORE);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('RuvNet Brain — guidance');
    expect(r.stdout).not.toMatch(/hijack/i);
  });

  it('THE FIX: with jq ABSENT from PATH it STILL fires — this returned empty before', () => {
    const dir = pathWithoutJq();
    try {
      expect(spawnSync('sh', ['-c', 'command -v jq'], { env: { PATH: dir }, encoding: 'utf8' }).status)
        .not.toBe(0);                                            // the harness really has no jq
      const r = fire(VECTOR_STORE, { PATH: dir });
      expect(r.status).toBe(0);
      // KNOWN-BAD: before the fix this stdout was '' — byte-for-byte silence on a real violation.
      expect(r.stdout).toContain('RuvNet Brain — guidance');
      expect(r.stdout).not.toMatch(/hijack/i);
      expect(r.stdout).toContain('RuVector');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('BOTH HALVES: the reply is well-formed JSON without jq, not just non-empty', () => {
    // Removing jq from the PARSE half alone left the EMIT half dying on `jq -n --arg`. A test that
    // only asserted "not empty" would have missed nothing here — but one that never parses the
    // output would miss a malformed envelope, which Claude Code drops silently.
    const dir = pathWithoutJq();
    try {
      const r = fire(VECTOR_STORE, { PATH: dir });
      const parsed = JSON.parse(r.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      // NOT 'defer' (fixed 2026-09-25): see hijack-no-defer.test.mjs for why. permissionDecision
      // must be absent entirely — advisory-only, per this hook's own header contract.
      expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(parsed.hookSpecificOutput.additionalContext).toContain('RuVector');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('SILENCE IS STILL SILENCE: innocent code fires nothing, with or without jq', () => {
    // The fix must not have bought its reliability by becoming trigger-happy. A gate that cries wolf
    // gets switched off, and then protects nothing — this hook's own header says so.
    expect(fire(INNOCENT).stdout).toBe('');
    const dir = pathWithoutJq();
    try { expect(fire(INNOCENT, { PATH: dir }).stdout).toBe(''); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the jq guard is GONE from the source, not merely bypassed', () => {
    const src = fs.readFileSync(HOOK, 'utf8');
    const live = src.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(live.join('\n')).not.toMatch(/command -v jq/);        // no conditional resurrection
    expect(live.join('\n')).not.toMatch(/^\s*jq\s/m);            // no jq invocation anywhere
  });
});
