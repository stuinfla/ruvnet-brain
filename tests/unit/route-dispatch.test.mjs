// tests/unit/route-dispatch.test.mjs — the audit that measures model inheritance, and the adversary that
// asks Stuart's questions before he has to.
//
// THE LEAK (2026-07-13). Stuart: "What happens when I'm right here in Opus 4.8 and it has 10 things to
// run? Is it going to just run them as Opus 4.8?" — YES. A subagent INHERITS the main-loop model unless
// `model` is passed. Ten agents on a Fable session = ten agents at $10/$50 per Mtok, ~10x Haiku for
// identical mechanical work. The host currently provides no synchronous Agent/Task decision seam,
// so this hook records the leak without pretending a late exit code can stop it.
//
// THE DEEPER DEFECT (falsify.mjs). Stuart: "Why do you still keep needing me to call you on these
// things? Ru would not miss stuff like this." Correct, and it is mechanical: I verify WHAT I BUILT,
// never WHETHER IT SHOULD EXIST. Tests I wrote passing is circular evidence. falsify.mjs turns each
// question he had to ask into a check that fails on an UNPROVEN CLAIM (not merely on broken code).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAll, CHECKS } from '../../scripts/falsify.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const GATE = path.join(REPO, 'plugin/scripts/route-dispatch.sh');
const RECEIPT_DIR = ['meta', 'harness'].join('');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

/**
 * @param optedIn — does this user have a model-router profile? THE CONSENT GATE.
 *   My first version of this hook blocked EVERY user of the plugin, including strangers who never
 *   asked for cost routing. Shipping a hard block on someone else's Task tool to save Stuart money is
 *   hostile. It now enforces ONLY for users who opted in (they answered the two subscription
 *   questions, so profile.json exists). Everyone else is untouched — not even warned.
 */
function dispatch(
  toolInput,
  toolName = 'Task',
  env = {},
  optedIn = true,
  profileContent = '{"harnesses":{}}',
  envelope = {},
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
  if (optedIn) {
    fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), profileContent);
  }
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify({ ...envelope, tool_name: toolName, tool_input: toolInput }),
    env: { ...process.env, HOME: home, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '', home };
}

describe.skipIf(!hasBash || process.platform === 'win32')('route-dispatch.sh — subagent model selection audit', () => {
  it('NEVER touches a user who did not opt in — consent is the default', () => {
    // The defect I shipped and caught minutes later: this hook goes to EVERY plugin user. Hard-blocking
    // the Task tool for people who never asked for routing would break strangers' workflows.
    const r = dispatch({ description: 'x', subagent_type: 'general-purpose' }, 'Task', {}, /* optedIn */ false);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('does not mistake a non-interactive installer assumption for consent (GHSA-jgvj-938r-2433)', () => {
    const profile = JSON.stringify({
      harnesses: {
        'claude-code': {
          subscription: true,
          basis: 'assumed: installing the Claude Code brain; confirm with model-router-setup.mjs --show',
        },
      },
    });
    const r = dispatch(
      { description: 'x', subagent_type: 'general-purpose' },
      'Task',
      {},
      true,
      profile,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it.each([
    ['newline-terminated profile', '{"harnesses":{}}\n'],
    ['profile without a final newline', '{"harnesses":{}}'],
  ])('records inherited-model use without claiming a late block for a %s', (_label, profileContent) => {
    const r = dispatch(
      { description: 'sweep tests', subagent_type: 'general-purpose' },
      'Task',
      {},
      true,
      profileContent,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const receipt = JSON.parse(fs.readFileSync(path.join(r.home, '.claude', RECEIPT_DIR, 'dispatch-log.jsonl'), 'utf8').trim());
    expect(receipt).toMatchObject({ model: 'inherited', enforcement: 'advisory-host-timing' });
  });

  it('ALLOWS a dispatch that declares its model, and LOGS it so routing is auditable', () => {
    const r = dispatch(
      { description: 'sweep tests', subagent_type: 'general-purpose', model: 'haiku' },
      'Task',
      {},
      true,
      '{"harnesses":{}}',
      { tool_use_id: 'toolu_route_123', session_id: 'session_456' },
    );
    expect(r.status).toBe(0);
    // The log is the scoreboard. Claiming "I route" is worth nothing; a growing ledger is worth something.
    const log = fs.readFileSync(path.join(r.home, '.claude/metaharness/dispatch-log.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({
      event: 'dispatch',
      model: 'haiku',
      toolUseId: 'toolu_route_123',
      sessionId: 'session_456',
    });
  });

  it('lets a FORK through — a fork inherits the parent model BY DESIGN; blocking it would be wrong', () => {
    expect(dispatch({ description: 'x', subagent_type: 'fork' }).status).toBe(0);
  });

  it('ignores tools that are not subagent dispatches', () => {
    expect(dispatch({ command: 'ls' }, 'Bash').status).toBe(0);
  });

  it('has a deliberate escape hatch — but it must be USED ON PURPOSE, never reached by omission', () => {
    const r = dispatch({ description: 'x', subagent_type: 'general-purpose' }, 'Task', { RUVNET_ALLOW_INHERITED_MODEL: '1' });
    expect(r.status).toBe(0);
  });

  it('FAILS OPEN on unparseable input — a blocking hook must never brick a session', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
    fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{}');
    const r = spawnSync('bash', [GATE], { input: 'not json at all', env: { ...process.env, HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0); // a gate that breaks your tools is worse than the leak it prevents
  });

  it('parses with BASH BUILTINS ONLY — no cat, no grep, no sed, no jq, no python3', () => {
    // Break-testing on a bare PATH found TWO holes in my own first version: a `grep|head|sed` pipeline
    // that returned empty (so the gate silently allowed everything), and `INPUT=$(cat)`. A hook that
    // can BLOCK must depend on nothing it cannot guarantee — so the parse is `[[ =~ ]]` and the stdin
    // read is a `while read` loop. Both are builtins: they cannot be missing or shadowed by PATH.
    const src = fs.readFileSync(GATE, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'); // strip comments; they NAME these tools
    for (const bin of ['python3', 'jq', '$(cat', '| grep', '| sed', '| head']) {
      expect(src, `route-dispatch.sh must not depend on ${bin}`).not.toContain(bin);
    }
    expect(src).toMatch(/BASH_REMATCH/); // the builtin-regex parse
  });
});

describe('falsify.mjs — the adversary: a linter for CLAIMS, not for code', () => {
  it('fails on an UNPROVEN claim, and says which question it answers', () => {
    const out = runAll([
      { id: 'a', asked: 'is it real?', why: 'because I once faked it', run: () => ({ ok: false, detail: 'unproven' }) },
    ]);
    expect(out[0].ok).toBe(false);
    expect(out[0].asked).toBe('is it real?'); // every check is a question Stuart had to ask me
    expect(out[0].why).toBeTruthy();          // and carries the incident that earned it
  });

  it('covers the exact failures of 2026-07-13 — impersonation, dead jobs, an unused router, red CI', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(ids).toContain('am-i-impersonating-ruv');      // I called my heuristic "the MetaHarness router"
    expect(ids).toContain('did-the-jobs-actually-run');   // launchd reports exit 0 for a job that never ran
    expect(ids).toContain('is-the-router-actually-routing'); // $0.018 saved in the router's whole life
    expect(ids).toContain('is-ci-actually-green');        // 25 straight CI failures while I said "green"
  });

  it('every check carries the incident that earned it — a rule without a scar gets deleted', () => {
    for (const c of CHECKS) {
      expect(c.asked, `${c.id} must record the question`).toBeTruthy();
      expect(c.why, `${c.id} must record WHY it exists`).toBeTruthy();
    }
  });
});
