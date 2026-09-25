// tests/unit/hijack-no-defer.test.mjs — the action-level interceptor must never ask Claude Code to
// defer the tool call it is advising on.
//
// THE DEFECT (fixed 2026-09-25). hijack-ruvnet.sh hardcoded `DECISION="defer"` and its header
// comment described that as "WITHOUT blocking the call" — a stronger 'ask', not a pause. Claude
// Code's own hooks reference says otherwise: "'defer' is for integrations that run `claude -p` as a
// subprocess ... Claude Code honors this value only in non-interactive mode with the -p flag." In
// that mode `defer` does not "advise and continue" — it PAUSES the tool call. The process exits
// immediately with `stop_reason:"tool_deferred"`, `result:""`, and the tool never runs, unless the
// calling process implements the documented resume protocol (`claude -p --resume <id>` with the
// answer in `updatedInput`). hijack-ruvnet.sh never did.
//
// Measured live with a single `claude -p "run: echo hi" --output-format json` run each way, in a
// throwaway project whose only PreToolUse hook printed this envelope for Bash:
//   - permissionDecision:"defer"   -> Bash never ran; stop_reason:"tool_deferred"; result:""
//   - additionalContext only       -> Bash ran normally; stop_reason:"end_turn"; real output back
// Any -p/subprocess caller that fires this hook on a matching Write/Edit/Bash — including Claude
// Code's own headless/background-agent invocations — got the tool call silently abandoned: no
// tool_result, no error, no notice, indistinguishable from the agent going idle.
//
// THE FIX has two halves, same lesson as hijack-no-jq.test.mjs: hijack-ruvnet.sh's own DECISION is
// now `""`, but the shared emitter (`hook-input.mjs` preToolUseEnvelope) used to default a falsy
// `decision` to `'defer'` too (`String(decision || 'defer')` — `''` is falsy in JS), which would
// have silently reintroduced defer for ANY caller passing `''`. Both halves are covered below.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { preToolUseEnvelope } from '../../plugin/scripts/hook-input.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const hasPosixShell = spawnSync('sh', ['-c', 'exit 0']).status === 0 && fs.existsSync('/bin');
const HOOK = path.join(REPO, 'plugin/scripts/hijack-ruvnet.sh');

const fire = (payload) => spawnSync('sh', [HOOK], {
  input: JSON.stringify(payload), encoding: 'utf8', timeout: 20_000,
});

const VECTOR_STORE = { tool_name: 'Write', tool_input: { content: 'import pinecone\nidx = pinecone.Index("x")' } };
// Category 2 (embedding APIs) ERE regression: an 'n' between "openai" and "embedding" used to defeat
// the `[^\n]*` bracket-expression bug (POSIX ERE has no `\n` escape inside `[...]`, so `[^\n]` means
// "not backslash, not the letter n" — any 'n' in between ends the match early). Fixed alongside defer
// because it was in the same file and the same class of bug the header already documents for
// Category 4 (issue #102); this occurrence was missed at the time.
const EMBEDDING_API_ERE_REGRESSION = { tool_name: 'Write', tool_input: { content: 'resp = call_openai_new_embedding_endpoint(text)' } };
const INNOCENT = { tool_name: 'Write', tool_input: { content: 'def add(a, b):\n    return a + b\n' } };

describe.skipIf(!hasPosixShell)('hijack-ruvnet.sh — never asks Claude Code to defer', () => {
  it('a triggered advisory carries additionalContext but no permissionDecision at all', () => {
    const r = fire(VECTOR_STORE);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('RuVector');
  });

  it('REGRESSION (Category 2 ERE, issue #102-class): an "n" between openai and embedding still matches', () => {
    const r = fire(EMBEDDING_API_ERE_REGRESSION);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('ONNX');
    expect(parsed.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });

  it('no trigger, no opinion: stdout stays empty, exactly as before this fix', () => {
    expect(fire(INNOCENT).stdout).toBe('');
  });

  it('the source no longer hardcodes DECISION="defer"', () => {
    const src = fs.readFileSync(HOOK, 'utf8');
    const live = src.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(live.join('\n')).not.toMatch(/DECISION="defer"/);
  });
});

describe('preToolUseEnvelope — the shared PreToolUse emitter (hook-input.mjs)', () => {
  it('KNOWN-BAD (the defer default): an empty/undefined decision must NOT become "defer"', () => {
    for (const decision of ['', undefined, null]) {
      const env = JSON.parse(preToolUseEnvelope(decision, 'advisory text'));
      expect(env.hookSpecificOutput).not.toHaveProperty('permissionDecision');
      expect(env.hookSpecificOutput.additionalContext).toBe('advisory text');
    }
  });

  it('an explicit decision is still honored — this is an opt-out of the bad DEFAULT, not a removed capability', () => {
    for (const decision of ['defer', 'deny', 'ask', 'allow']) {
      const env = JSON.parse(preToolUseEnvelope(decision, 'ctx'));
      expect(env.hookSpecificOutput.permissionDecision).toBe(decision);
    }
  });

  it('always names the event and never throws on a missing additionalContext', () => {
    const env = JSON.parse(preToolUseEnvelope());
    expect(env.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(env.hookSpecificOutput.additionalContext).toBe('');
    expect(env.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  });
});
