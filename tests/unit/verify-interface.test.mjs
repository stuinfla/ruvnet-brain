// tests/unit/verify-interface.test.mjs — the gate that stops me guessing at a CLI's flags.
//
// WHY (2026-07-13). Stuart: "Why are you still so fascinated with efficiency that you won't take the
// split second to check you're making the call the right way? EFFECTIVE WINS OVER EFFICIENCY EVERY
// SINGLE TIME. Stop skipping steps. You are destroying your credibility."
//
// He is describing a mechanical defect, not a mood. I reported AgentDB BROKEN THREE TIMES. It was
// never broken:
//   1. I called `ruflo memory search "query"` POSITIONALLY. The CLI wants `-q`. Empty result → I
//      declared the product broken to his face.
//   2. My canary test then "failed" because MY OWN grep filtered the rows out.
//   3. My broken-state test printed nothing because I set the test up wrong.
// Every one was MY defect, reported as a PRODUCT defect. Cost: hours of his time, and his trust.
//
// THE GAP: the brain holds 2GB of rUv's SOURCE. It does NOT hold a compiled CLI's runtime flags —
// `-q` lives in `--help` output, not in the indexed corpus. I ground FACTS in the brain and never
// ground INTERFACES in the tool. A rule would not fix that (I ignored rules all night). A wall does.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/verify-interface.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

function run(command, { optedIn = true, home = null } = {}) {
  const h = home || fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
  if (optedIn) {
    fs.mkdirSync(path.join(h, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude/model-router/profile.json'), '{}');
  }
  const r = spawnSync('bash', [GATE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { ...process.env, HOME: h },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '', home: h };
}

describe.skipIf(!hasBash || process.platform === 'win32')('verify-interface.sh — you may not call a tool whose interface you have not read', () => {
  it('BLOCKS the EXACT call that started this: ruflo memory search, with the help unread', () => {
    const r = run('npx ruflo@latest memory search -q test');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED — you have not read the interface/);
    expect(r.stderr).toMatch(/ruflo memory search --help/); // it tells me EXACTLY what to run
  });

  it('ALWAYS allows reading the help — and records it, so the next call goes through', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
    expect(run('npx ruflo@latest memory search --help', { home }).status).toBe(0);
    // My FIRST version used a different (weaker) regex on the help-recording path — it did not absorb
    // `@latest`, so nothing was recorded and the next call was STILL blocked. The break-test caught it.
    // Two regexes for one concept is how you get a gate that never opens.
    expect(run('npx ruflo@latest memory search -q test', { home }).status).toBe(0);
  });

  it('granularity matches the mistake: reading `memory search` help does NOT unlock `memory distill`', () => {
    // `ruflo memory --help` lists subcommands but never shows search's `-q` — the exact flag I guessed
    // wrong. So the stamp must be per-subcommand, not per-tool.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
    run('npx ruflo@latest memory search --help', { home });
    expect(run('npx ruflo@latest memory distill run', { home }).status).toBe(2);
  });

  it('does NOT tax ordinary work — a gate that annoys you gets switched off, and then protects nothing', () => {
    for (const cmd of ['git status', 'npm test', 'ls -la', 'node scripts/falsify.mjs', 'sqlite3 db "SELECT 1"']) {
      expect(run(cmd).status, `${cmd} must pass untouched`).toBe(0);
    }
  });

  it('never touches a user who did not opt in — consent is the default', () => {
    expect(run('npx ruflo@latest memory search -q test', { optedIn: false }).status).toBe(0);
  });

  it('FAILS OPEN on garbage — a blocking hook must never brick a session', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
    fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{}');
    const r = spawnSync('bash', [GATE], { input: 'not json', env: { ...process.env, HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('uses BASH BUILTINS ONLY — no python3/jq/cat: a hook that can BLOCK must depend on nothing', () => {
    const src = fs.readFileSync(GATE, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    for (const bin of ['python3', 'jq', '$(cat', '| grep', '| sed']) {
      expect(src, `verify-interface.sh must not depend on ${bin}`).not.toContain(bin);
    }
  });

  it('NO REGEX FALLBACK: which tool, which subcommand come from the shared classifier, never a pattern', () => {
    // This assertion REPLACES the old `expect(src).toMatch(/BASH_REMATCH/)`, which pinned the
    // opposite design — back then MATCH_RE, a bash regex over the command string, decided which CLI
    // and which subcommand were being invoked, and only JSON payload parsing had moved to node (#13).
    // MATCH_RE is what #12, #41 and #44 each patched in turn, so the invariant is now inverted: the
    // gate must ask hook-input.mjs for EXECUTABLE STRUCTURE and must keep no second, string-shaped
    // path to the same answer. A second path is exactly how this defect class survived four fixes.
    const src = fs.readFileSync(GATE, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(src, 'the gate must consume the shared classifier').toContain('hook-input.mjs');
    expect(src, 'via the invocations verb — the structural question').toMatch(/invocations/);
    expect(src, 'MATCH_RE was the regex fallback; it must not come back').not.toContain('MATCH_RE');
    expect(src, 'no BASH_REMATCH capture of a tool name from the command string').not.toContain('BASH_REMATCH');
    // Subcommand levels are derived from already-parsed argv tokens ($F), not re-matched from $CMD.
    expect(src).toMatch(/\$\{F\[/);
    // Exactly ONE bash regex may remain, and it is the fail-OPEN opt-out token, whose worst failure
    // is letting a command through — never deciding that an invocation happened.
    const rematches = src.split('\n').filter((l) => l.includes('=~'));
    expect(rematches, `unexpected regex match(es): ${JSON.stringify(rematches)}`).toHaveLength(1);
    expect(rematches[0]).toContain('RUVNET_SKIP_INTERFACE_CHECK');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Regression tests for issues #12 and #13 (github.com/stuinfla/ruvnet-brain), filed by a real user
// this gate blocked mid-session — including a `git commit` whose message merely mentioned a tool
// name. Both issues are about the SAME gate but different layers: #13 is what the gate is GIVEN
// (payload parsing), #12 is what it MATCHES against once it has the real command.
describe.skipIf(!hasBash || process.platform === 'win32')('verify-interface.sh — issue #13: JSON payload parsing, not a truncating regex', () => {
  it('quoted commands parse in full: a real invocation AFTER a quoted argument is still seen and blocked', () => {
    // The OLD field() regex — "([^"]*)" — cannot cross a `"`, and a JSON-escaped `\"` still contains
    // a literal `"` byte in the raw text. So `field(command)` on this payload used to truncate at the
    // very first quote, capturing only `echo ` — the entire tail, including the real `ruflo memory
    // search` invocation after `&&`, was NEVER SEEN by the gate. That is issue #13's false negative:
    // the exact call this gate exists to catch sailed through unchecked. With real JSON parsing the
    // full string survives, and the invocation after `&&` is still at command position (issue #12's
    // anchor), so it correctly blocks.
    const r = run('echo "a quoted note" && ruflo memory search -q x');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED — you have not read the interface for: ruflo memory search/);
  });

  it('malformed JSON (truncated, not just non-JSON garbage) FAILS OPEN, not just totally-invalid input', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
    fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{}');
    const truncated = '{"tool_name":"Bash","tool_input":{"command":"ruflo memory search';
    const r = spawnSync('bash', [GATE], { input: truncated, env: { ...process.env, HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
});

describe.skipIf(!hasBash || process.platform === 'win32')('verify-interface.sh — issue #12: word-boundary command-position matching, and a working override', () => {
  it('does NOT block a different binary that merely shares a hyphenated prefix: ruflo-source-patch', () => {
    // The OLD version-suffix class `[@a-z0-9.-]*` absorbed an arbitrary hyphenated tail, not just
    // `@latest` — so `ruflo-source-patch adr-index status` (a DIFFERENT binary, its own CLI) was
    // misread as `ruflo` with subcommand `adr-index status`, and the gate demanded `ruflo adr-index
    // status --help` — a command that does not exist. The fix requires an explicit `@` for the
    // version suffix, so `ruflo-source-patch` no longer matches `ruflo` at all.
    const r = run('ruflo-source-patch adr-index status');
    expect(r.status).toBe(0);
  });

  it('does NOT block prose that merely mentions a tool name — it is not at command position', () => {
    const r = run('git commit -m "explained how ruflo memory search returns results for this query"');
    expect(r.status).toBe(0);
  });

  it('DOES block a real, direct invocation of the exact gated CLI with no --help read', () => {
    const r = run('ruflo memory search -q x');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BLOCKED — you have not read the interface for: ruflo memory search/);
    expect(r.stderr).toMatch(/ruflo memory search --help/);
  });

  it('the documented override actually works: RUVNET_SKIP_INTERFACE_CHECK=1 prefixed on the command', () => {
    // The OLD check read `RUVNET_SKIP_INTERFACE_CHECK` from the HOOK PROCESS's own environment — but
    // a PreToolUse hook only ever receives the proposed command as JSON on stdin and never executes
    // it, so setting the var "on the command" (exactly what the block message instructed) had zero
    // effect. The fix checks the COMMAND STRING itself for the token.
    const r = run('RUVNET_SKIP_INTERFACE_CHECK=1 ruflo memory search -q x');
    expect(r.status).toBe(0);
  });

  it('the block message documents an override that actually works, on the command string', () => {
    const r = run('ruflo memory search -q x');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/RUVNET_SKIP_INTERFACE_CHECK=1 ruflo memory search/);
  });

  it('still recognizes a real npx-wrapped invocation as command position (no regression)', () => {
    const r = run('npx ruflo@latest memory search -q test');
    expect(r.status).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Issue #41 (residual of #12): the command-position anchor `(^|[;&|(\n])` was matched against the RAW
// command, so a separator character INSIDE a quoted string (a grep pattern's regex alternation, a
// commit message, an awk program) was misread as a real shell separator. Fixed by matching against a
// quote-masked skeleton (shellSkeleton() in hook-input.mjs) instead. This is the reporter's own probe
// table, ported verbatim (github.com/sparkling, issue #41): 4 false positives now must be ALLOWED, 2
// controls stay allowed (they always were — they isolate the mechanism), and 2 true positives must
// STILL BLOCK — the fix must not widen the gate, only stop it firing on quoted content.
describe.skipIf(!hasBash || process.platform === 'win32')('verify-interface.sh — issue #41: quote-masked command-position matching', () => {
  describe('FALSE POSITIVES — a separator char inside quotes must no longer trigger the block', () => {
    it.each([
      ['regex alternation before tool name', 'grep -E "foo|ruflo init" file.txt'],
      ['same, inside a longer pattern', 'grep -nE "^CLI=|ruflo init|npx" script.sh'],
      ['commit message containing a pipe', 'git commit -m "handle a|ruflo init edge case"'],
      ['awk program with alternation', 'awk "/x|ruflo memory search/ {print}" f'],
    ])('%s: %s', (_label, cmd) => {
      const r = run(cmd);
      expect(r.status, `expected ALLOWED (0), got ${r.status}\nstderr: ${r.stderr}`).toBe(0);
    });
  });

  describe('CONTROLS — identical apart from no separator char before the name inside quotes', () => {
    it.each([
      ['prose, no separator', 'grep -E "foo ruflo init" file.txt'],
      ['echo mentioning the tool', 'echo "run ruflo init to start"'],
    ])('%s: %s', (_label, cmd) => {
      const r = run(cmd);
      expect(r.status, `expected ALLOWED (0), got ${r.status}\nstderr: ${r.stderr}`).toBe(0);
    });
  });

  describe('TRUE POSITIVES — real, unquoted invocations must STILL block (the fix must not widen the gate)', () => {
    it.each([
      ['real invocation', 'ruflo init --force'],
      ['real invocation after a real pipe', 'echo hi | ruflo memory search'],
    ])('%s: %s', (_label, cmd) => {
      const r = run(cmd);
      expect(r.status, `expected BLOCKED (2), got ${r.status}\nstderr: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED — you have not read the interface/);
    });
  });

  it('the help-recording branch does not record a bogus stamp for a tool name that only appears inside quotes', () => {
    // The help-recording branch (~line 143) shares MATCH_RE with the blocking branch, and its own
    // exit code is always 0 either way — the observable bug here is a SPURIOUS CACHE STAMP, not a
    // wrong exit code. `grep -E "foo|ruflo init" file.txt --help` ends in a real `--help` (so it
    // enters the recording branch) but the `|` before `ruflo init` is inside the quoted pattern, not
    // a real shell separator. Before the fix this recorded a "ruflo init help was read" stamp for a
    // command that never actually read ruflo's help — which would then let a REAL `ruflo init`
    // invocation slip past the gate unread.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
    const stamp = path.join(home, '.cache/ruvnet-brain/help-read/ruflo.init');

    run('grep -E "foo|ruflo init" file.txt --help', { home });
    expect(fs.existsSync(stamp), 'must NOT record a stamp from a quoted mention').toBe(false);

    // Prove the false-positive fix did not also break real coverage: a genuine invocation with no
    // help read yet still blocks —
    expect(run('ruflo init --force', { home }).status).toBe(2);
    // — and the stamping mechanism itself still works for a REAL help read (this isn't testing a
    // feature that's simply broken end-to-end):
    run('ruflo init --help', { home });
    expect(fs.existsSync(stamp), 'a REAL help read must still be recorded').toBe(true);
    expect(run('ruflo init --force', { home }).status).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Issue #44 (github.com/sparkling again, fourth precise report on this file — after #41's false
// POSITIVE, this is a false NEGATIVE in the same matcher). #41 fixed the gate by matching a
// quote-masked SKELETON instead of the raw command. That was right, and it opened a hole: a
// DEFINITE invocation nested inside a literal shell payload (`bash -lc '…'`), a backtick
// substitution, or a `$(…)` inside double quotes is *inside quotes*, so the skeleton masks it away
// and the gate never sees it. The gate exists to stop me invoking a CLI whose flags I am guessing
// at — and `bash -lc 'ruflo memory search -q x'` invokes it just as surely as typing it bare.
//
// RED-FIRST — verbatim output of THIS block run against the pre-fix gate (3.9.84-dev, commit
// 3501ef4), captured with both source files checked back out to HEAD. The only edit is that the
// prefix every FAIL line shares — `tests/unit/verify-interface.test.mjs > verify-interface.sh —
// issue #44: definite invocations nested in shell payloads and command substitutions > ` — is
// elided to `…`; nothing else is changed. (The two heredoc FALSE-POSITIVE lines were a
// PRE-EXISTING false positive, not one this change introduced: a heredoc body line beginning with
// a tool name already blocked before #44 existed. They are red here because recursing into `$( … )`
// without teaching the lexer about heredocs would have made that worse, not better.)
//
//   ⎯⎯⎯⎯⎯⎯ Failed Tests 13 ⎯⎯⎯⎯⎯⎯⎯
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > literal bash -lc payload (reporter case 1): bash -lc 'ruflo memory search -q x'
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > backtick substitution (reporter case 2): x=`ruflo memory search -q x`
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > $() inside double quotes (reporter case 3): printf '%s\n' "$(ruflo memory search -q x)"
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > sh -c with a double-quoted payload: sh -c "ruflo memory search -q x"
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > bash -ic (interactive flag cluster): bash -ic 'ruflo memory search -q x'
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > absolute path to the shell: /bin/bash -c 'ruflo memory search -q x'
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > $() inside double quotes, mid-sentence: echo "result: $(ruflo memory search -q x) done"
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > backtick inside double quotes: echo "result: `ruflo memory search -q x`"
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > two levels of nesting: bash -c 'sh -c "ruflo memory search -q x"'
//   FAIL  … > BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK) > $() nested inside a bash -c payload: bash -lc 'echo $(ruflo memory search -q x)'
//   FAIL  … > FALSE-POSITIVE GUARDS — widening the gate must not cost us #41 back (must stay ALLOWED) > heredoc prose whose line starts with the tool name: cat <<'EOF'
//   FAIL  … > FALSE-POSITIVE GUARDS — widening the gate must not cost us #41 back (must stay ALLOWED) > heredoc prose containing a literal $() example: cat <<'EOF'
//   FAIL  … > THE GATE MUST STILL OPEN — a stamped interface unlocks the nested forms too > reading the help INSIDE a nested payload records the stamp (or the gate could never open)
//
//   Test Files  1 failed (1)
//        Tests  13 failed | 44 passed (57)
//
//   …and the shared shape of all ten BYPASS failures, verbatim (the gate returned 0 — ALLOWED —
//   on a definite invocation, so there is no stderr to show; that empty `stderr:` line IS the bug):
//
//   AssertionError: expected BLOCKED (2), got 0
//   stderr: : expected +0 to be 2 // Object.is equality
//
describe.skipIf(!hasBash || process.platform === 'win32')('verify-interface.sh — issue #44: definite invocations nested in shell payloads and command substitutions', () => {
  describe("BYPASSES — the reporter's three, plus the same mechanism's near neighbours (must BLOCK)", () => {
    it.each([
      ['literal bash -lc payload (reporter case 1)', "bash -lc 'ruflo memory search -q x'"],
      ['backtick substitution (reporter case 2)', 'x=`ruflo memory search -q x`'],
      ['$() inside double quotes (reporter case 3)', 'printf \'%s\\n\' "$(ruflo memory search -q x)"'],
      ['sh -c with a double-quoted payload', 'sh -c "ruflo memory search -q x"'],
      ['bash -ic (interactive flag cluster)', "bash -ic 'ruflo memory search -q x'"],
      ['absolute path to the shell', "/bin/bash -c 'ruflo memory search -q x'"],
      ['$() inside double quotes, mid-sentence', 'echo "result: $(ruflo memory search -q x) done"'],
      ['backtick inside double quotes', 'echo "result: `ruflo memory search -q x`"'],
      ['two levels of nesting', 'bash -c \'sh -c "ruflo memory search -q x"\''],
      ['$() nested inside a bash -c payload', "bash -lc 'echo $(ruflo memory search -q x)'"],
    ])('%s: %s', (_label, cmd) => {
      const r = run(cmd);
      expect(r.status, `expected BLOCKED (2), got ${r.status}\nstderr: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED — you have not read the interface for: ruflo memory search/);
    });
  });

  describe('CONTROLS — already correct before the fix; the fix must not regress them (must BLOCK)', () => {
    it.each([
      ['direct invocation', 'ruflo memory search -q x'],
      ['pipeline invocation', 'echo hi | ruflo memory search -q x'],
      ['unquoted $() assignment', 'x=$(ruflo memory search -q x)'],
      ['npx-wrapped invocation', 'npx ruflo@latest memory search -q test'],
    ])('%s: %s', (_label, cmd) => {
      const r = run(cmd);
      expect(r.status, `expected BLOCKED (2), got ${r.status}\nstderr: ${r.stderr}`).toBe(2);
    });
  });

  describe('FALSE-POSITIVE GUARDS — widening the gate must not cost us #41 back (must stay ALLOWED)', () => {
    it.each([
      // #41's family — prose that merely mentions a tool.
      ['prose in a commit message', 'git commit -m "explained how ruflo memory search returns rows"'],
      ['prose in an echo', 'echo "run ruflo init to start"'],
      ['separator inside a quoted regex', 'grep -E "foo|ruflo init" file.txt'],
      // #12's family — the name as a SUBSTRING of a different word or a different binary.
      ['tool name as a substring of another word', 'echo ruflowers memory search'],
      ['a different, hyphen-prefixed binary', 'my-ruflo memory search -q x'],
      ['a different, hyphen-suffixed binary', 'ruflo-source-patch adr-index status'],
      // NEW with this fix: the executable is DYNAMIC, so there is nothing definite to ground.
      ['dynamic executable name', '$TOOL memory search -q x'],
      ['eval of a variable', 'eval "$cmd"'],
      ['bash -c of a variable', 'bash -c "$cmd"'],
      // Single quotes suppress BOTH substitution forms — this is literal text, not a command node.
      ['$() inside SINGLE quotes is literal text', "printf '%s' '$(ruflo memory search -q x)'"],
      ['backticks inside SINGLE quotes are literal text', "printf '%s' '`ruflo memory search -q x`'"],
      // Heredocs. A body line starting with the tool name looks exactly like command position to a
      // line-anchored regex, and a quoted-delimiter body suppresses substitution entirely — so
      // recursing into `$(…)` without heredoc awareness would INVENT a false positive here.
      ['heredoc prose whose line starts with the tool name',
        "cat <<'EOF'\nruflo memory search is the command you want\nEOF"],
      ['heredoc prose containing a literal $() example',
        "cat <<'EOF'\nresult=$(ruflo memory search -q x)\nEOF"],
      ['heredoc prose containing a literal backtick example',
        "cat <<'EOF'\nuse `ruflo memory search -q x` here\nEOF"],
      // LIVE CAPTURE 2026-07-27, in no issue: the maintainer was blocked mid-session writing this
      // exact text into a heredoc body. A tool name at the START OF A LINE is indistinguishable from
      // command position to anything line-anchored — the same class as #12/#41 from the false-positive
      // side, and the fifth instance in 14 days. Both delimiter forms, because an UNQUOTED delimiter
      // is where a naive "substitution happens here, so recurse" reading would go wrong.
      ['LIVE 07-27: product prose in a heredoc body (quoted delimiter)',
        "cat <<'EOF'\nagentic-qe integration plan\nEOF"],
      ['LIVE 07-27: product prose in a heredoc body (unquoted delimiter)',
        'cat <<EOF\nagentic-qe integration plan\nEOF'],
      ['LIVE 07-27: the same prose mid-paragraph, multi-line body',
        'cat > plan.md <<EOF\n# Plan\nWe should write the agentic-qe integration plan first.\nThen ruflo memory search is worth a look.\nEOF'],
    ])('%s: %s', (_label, cmd) => {
      const r = run(cmd);
      expect(r.status, `expected ALLOWED (0), got ${r.status}\nstderr: ${r.stderr}`).toBe(0);
    });

    it('LIVE 07-27 control: the SAME words as a real command still BLOCK (the allow must not be blanket)', () => {
      // A false-positive fix that also stopped finding real invocations would pass every ALLOW case
      // above and protect nothing. `agentic-qe` is in the managed TOOLS list, so the bare command
      // must still block — that is what makes the heredoc ALLOW meaningful rather than vacuous.
      const r = run('agentic-qe integration plan');
      expect(r.status, `expected BLOCKED (2), got ${r.status}\nstderr: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED — you have not read the interface for: agentic-qe integration plan/);
    });

    it('a real command AFTER a heredoc body still blocks — masking the body must not mask the script', () => {
      const r = run("cat <<'EOF'\njust prose in here\nEOF\nruflo memory search -q x");
      expect(r.status, `expected BLOCKED (2), got ${r.status}\nstderr: ${r.stderr}`).toBe(2);
    });
  });

  describe('THE GATE MUST STILL OPEN — a stamped interface unlocks the nested forms too', () => {
    it('a legitimately-stamped invocation passes in every nested form', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
      expect(run('ruflo memory search --help', { home }).status).toBe(0);
      for (const cmd of [
        'ruflo memory search -q x',
        "bash -lc 'ruflo memory search -q x'",
        'x=`ruflo memory search -q x`',
        'printf \'%s\\n\' "$(ruflo memory search -q x)"',
      ]) {
        expect(run(cmd, { home }).status, `${cmd} must be ALLOWED once the help is stamped`).toBe(0);
      }
    });

    it('reading the help INSIDE a nested payload records the stamp (or the gate could never open)', () => {
      // The lesson already written into this file in blood: "Two regexes for one concept is how you
      // get a gate that never opens." Same shape here — if the blocking branch learns to see nested
      // invocations but the help-recording branch does not, a user whose whole workflow is
      // `bash -lc '…'` is walled out permanently with no way through.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
      const stamp = path.join(home, '.cache/ruvnet-brain/help-read/ruflo.memory.search');
      run("bash -lc 'ruflo memory search --help'", { home });
      expect(fs.existsSync(stamp), 'a help read inside a nested payload must be recorded').toBe(true);
      expect(run("bash -lc 'ruflo memory search -q x'", { home }).status).toBe(0);
    });

    it('a stamp is NOT recorded from a tool name that only appears as nested PROSE', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
      const stamp = path.join(home, '.cache/ruvnet-brain/help-read/ruflo.memory.search');
      run('bash -lc \'echo "ruflo memory search is the command" --help\'', { home });
      expect(fs.existsSync(stamp), 'nested prose must NOT stamp').toBe(false);
    });
  });

  it('STILL FAILS OPEN on garbage — recursion must not turn a parse miss into a block', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-'));
    fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{}');
    for (const bad of ['not json', '{"tool_name":"Bash","tool_input":{"command":"bash -c \'ruflo memory', '']) {
      const r = spawnSync('bash', [GATE], { input: bad, env: { ...process.env, HOME: home }, encoding: 'utf8' });
      expect(r.status, `payload ${JSON.stringify(bad)} must fail open`).toBe(0);
    }
  });
});
