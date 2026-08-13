import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, identifierIn } from '../../plugin/scripts/identifier-preflight.mjs';

/**
 * AN UNVERIFIED IDENTIFIER FAILS SILENTLY, AND SILENCE IS WHAT COSTS.
 *
 * 2026-08-13: `codex exec --model gpt-5.6` launched a 50-minute adversarial audit. The model is
 * `gpt-5.6-sol`, sitting in ~/.codex/config.toml. codex printed `ERROR: 400 … not supported` and
 * EXITED 0, into a redirected file. No exit code, no exception, no output on screen — the loss
 * surfaced only when the owner asked why the result was late.
 *
 * The typo is a two-second fix. The defect is that nothing checked before committing fifty minutes.
 *
 * The design constraints below come from an adversarial review of a SIBLING hook shipped hours
 * earlier the same day, which turned a missing `sqlite3` into "the memory store is not durably
 * persisting writes". A fabricated diagnosis is worse than no check: it spends the credibility the
 * whole channel runs on. So every case here is as much about what this must NOT refuse.
 */
const cfg = (model) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  fs.mkdirSync(path.join(d, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(d, '.codex', 'config.toml'), `model = "${model}"\nmodel_reasoning_effort = "medium"\n`);
  return d;
};

describe('a known-wrong identifier is refused, with the right answer attached', () => {
  it('TEETH: the exact command that cost 50 minutes', () => {
    const r = check('codex exec --model gpt-5.6 --sandbox read-only "audit"', { home: cfg('gpt-5.6-sol') });
    expect(r.verdict).toBe('wrong');
    expect(r.value).toBe('gpt-5.6');
    // A wall that reports a problem without the fix is one people route around.
    expect(r.reason, 'the refusal must hand over the correct name').toContain('gpt-5.6-sol');
  });

  it('the correct identifier passes', () => {
    // Without this the "fix" could be "always refuse", which is a different defect wearing the
    // same shape — and the one that gets a guard deleted within a week.
    expect(check('codex exec --model gpt-5.6-sol "audit"', { home: cfg('gpt-5.6-sol') }).verdict).toBe('ok');
  });

  it('reads the short flag too, since that is how it will be typed next time', () => {
    expect(check('codex exec -m gpt-5.6 "x"', { home: cfg('gpt-5.6-sol') }).verdict).toBe('wrong');
  });

  it('TEETH: a DIFFERENT model is unknown, not wrong — a config value is a default, not an allowlist', () => {
    // An audit called the first version a false-refusal waiting to happen, and it was right: an
    // account may accept several models, so refusing everything but the configured one would block
    // legitimate work. Only a NEAR MISS is knowably wrong, because that is a typo rather than a
    // choice — which is exactly the failure this file was built for (`gpt-5.6` for `gpt-5.6-sol`).
    const home = cfg('gpt-5.6-sol');
    for (const other of ['o3', 'gpt-5.1-codex', 'claude-opus-5']) {
      expect(check(`codex exec --model ${other} "x"`, { home }).verdict, `${other} must pass`).toBe('unknown');
    }
    // …while truncations and punctuation slips of the configured name are still caught.
    for (const typo of ['gpt-5.6', 'gpt56sol', 'gpt-5.6-sol-extra']) {
      expect(check(`codex exec --model ${typo} "x"`, { home }).verdict, `${typo} must be caught`).toBe('wrong');
    }
  });
});

describe('it fails OPEN — an unknown is never a refusal', () => {
  it('TEETH: no config on this machine yields UNKNOWN, not a fabricated verdict', () => {
    // The sibling hook's exact bug: an absent tool became a confident claim about a different
    // subsystem. Anything this cannot positively resolve must allow, silently.
    const r = check('codex exec --model whatever "x"', { home: path.join(os.tmpdir(), 'no-such-home-xyz') });
    expect(r.verdict).toBe('unknown');
    expect(r.reason, 'an unknown must carry no refusal text at all').toBeUndefined();
  });

  it('a config with no model line is unknown, not wrong', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
    fs.mkdirSync(path.join(d, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(d, '.codex', 'config.toml'), 'approval_policy = "never"\n');
    expect(check('codex exec --model x "y"', { home: d }).verdict).toBe('unknown');
  });

  it('commands with no identifier, and other CLIs, are not-applicable', () => {
    const home = cfg('gpt-5.6-sol');
    for (const cmd of ['ls -la', 'git push origin main', 'npm test', 'codex exec "no flag here"']) {
      expect(check(cmd, { home }).verdict, `${cmd} must not be refused`).not.toBe('wrong');
    }
  });

  it('TEETH: a flag inside a QUOTED prompt is an argument, not an invocation', () => {
    // `codex exec "explain the --model gpt-5.6 error"` must NOT be refused — that is asking ABOUT
    // the mistake, and a wall that blocks the question blocks the fix. An adversarial review found
    // a sibling fix greping raw command text the same day, so that `grep -n "npm publish" docs/`
    // fired ship lessons. Executable position is the truth-maker; a prompt is always quoted.
    const home = cfg('gpt-5.6-sol');
    expect(identifierIn('grep -rn "gpt-5.6" docs/'), 'a bare mention is not an invocation').toBeNull();
    expect(identifierIn('echo "we used --model gpt-5.6 yesterday"')).toBeNull();
    expect(identifierIn('codex exec "explain the --model gpt-5.6 error"'),
      'the flag is inside the PROMPT, so it commits to nothing').toBeNull();
    // …while the real invocation, whose flag sits outside any quotes, is still caught.
    expect(check('codex exec --model gpt-5.6 "audit this"', { home }).verdict).toBe('wrong');
  });
});
