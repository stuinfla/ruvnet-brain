// hook-input.test.mjs — the ONE parser every PreToolUse gate uses (ADR-0021). The whole reason it
// exists is that a bash `"([^"]*)"` regex truncates any command containing a quote, so the known-bad
// fixture below IS the bug: a command whose interesting part sits AFTER an embedded quote. A real JSON
// parser returns the whole string; the old regex returned everything up to the first `"` and the gate
// failed open on it.
import { describe, it, expect } from 'vitest';
import { parseHookEvent, toolName, commandOf, field, commandNodes, findInvocations } from '../../plugin/scripts/hook-input.mjs';

describe('hook-input — the shared PreToolUse payload parser (ADR-0021)', () => {
  it('KNOWN-BAD (the #13 fail-open): a command with embedded quotes is returned WHOLE, not truncated', () => {
    // The bash `"([^"]*)"` regex truncates this at the first `"` — so `vercel --prod` (the part a
    // gate must see) vanished and the wall failed open. The parser must round-trip the whole command,
    // backslash-escapes and all — it is the real command the user typed.
    const command = 'git commit -m "fix: \\"quoted\\" thing" && vercel --prod';
    const ev = parseHookEvent(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }));
    const cmd = commandOf(ev);
    expect(cmd).toContain('vercel --prod'); // the old regex NEVER saw this — the whole point
    expect(cmd).toContain('"fix:');
    expect(cmd).toBe(command); // round-trips WHOLE, not truncated at the first quote
  });

  it('extracts tool_name', () => {
    expect(toolName(parseHookEvent('{"tool_name":"Bash","tool_input":{}}'))).toBe('Bash');
    expect(toolName(parseHookEvent('{"tool_input":{}}'))).toBe('');
  });

  it('reads tool_input.command (Claude Code shape) and the top-level .command fallback', () => {
    expect(commandOf(parseHookEvent('{"tool_input":{"command":"ls -la"}}'))).toBe('ls -la');
    expect(commandOf(parseHookEvent('{"command":"pwd"}'))).toBe('pwd'); // legacy/fallback
  });

  it('FAILS OPEN: bad JSON → null event → empty strings, never a throw', () => {
    expect(parseHookEvent('not json at all')).toBeNull();
    expect(parseHookEvent('')).toBeNull();
    expect(() => commandOf(null)).not.toThrow();
    expect(commandOf(null)).toBe('');
    expect(toolName(null)).toBe('');
  });

  it('missing / wrong-typed fields → "" (never undefined, never a crash)', () => {
    expect(commandOf(parseHookEvent('{"tool_input":{"command":42}}'))).toBe(''); // non-string command
    expect(commandOf(parseHookEvent('{"tool_input":{}}'))).toBe('');
    expect(field(parseHookEvent('{"tool_input":{"file_path":"/a/b.js"}}'), 'tool_input.file_path')).toBe('/a/b.js');
    expect(field(parseHookEvent('{}'), 'tool_input.file_path')).toBe('');
  });

  it('a command that merely MENTIONS a marker inside a quoted arg is still returned verbatim (parsing ≠ policy)', () => {
    // The parser does not judge; it just returns the true command. Command-position policy lives in
    // the gate. This proves the parser does not itself mangle quoted content.
    const ev = parseHookEvent(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo "run: ruflo memory search foo"' } }));
    expect(commandOf(ev)).toBe('echo "run: ruflo memory search foo"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// commandNodes / findInvocations — the CLASSIFIER that replaced shellSkeleton + shellScanUnits.
//
// Those two helpers answered a STRING question ("mask the quoted bytes, then regex the result for
// command position"). Every invariant they protected is real; each one is re-expressed below against
// the question the gate now actually asks — WHICH EXECUTABLES DOES THIS COMMAND RUN? — and each test
// names the assertion it carries forward, so nothing the old suite guarded is now unguarded.
//
// Two old assertions were about the MASK, not about an invariant, and are stated structurally here
// instead: "quote characters survive, content is masked" is really "a quoted region is exactly ONE
// argument whose bytes are preserved as data", and every `skel.length === cmd.length` offset check is
// really "the surrounding script is unaffected". Byte offsets were a property of the mask; there is no
// mask any more, and asserting them would be pinning an implementation again — which is precisely
// what made these tests die when the implementation was replaced.

const exes = (cmd) => commandNodes(cmd).map((n) => (n.dynamic ? '<dynamic>' : n.exe));
const invoked = (cmd, tools = 'ruflo') => findInvocations(cmd, tools).map((i) => [i.tool, ...i.args].join(' '));

describe('commandNodes — quoted DATA never becomes a command (was: shellSkeleton, issue #41)', () => {
  it('(was: empty in, empty out) nothing to run yields no nodes, and never a throw', () => {
    expect(commandNodes('')).toEqual([]);
    expect(commandNodes(null)).toEqual([]);
    expect(commandNodes(undefined)).toEqual([]);
    expect(commandNodes(42)).toEqual([]);
  });

  it('(was: no quotes passes through byte-identical) a plain command is ONE node, argv word-for-word', () => {
    expect(commandNodes('ruflo memory search -q x')).toEqual([
      { assigns: [], dynamic: false, exe: 'ruflo', argv: ['ruflo', 'memory', 'search', '-q', 'x'] },
    ]);
  });

  it('THE BUG (issue #41): a `|` inside a quoted grep pattern is an ARGUMENT, not a command boundary', () => {
    // `grep -E "foo|ruflo init" file.txt` — the reporter's case. The old raw-CMD anchor read that `|`
    // as a real shell separator and misread `ruflo init` as command position, blocking an ordinary
    // read-only search. The masking fix hid the `|`; the parser never sees a separator there at all,
    // because the whole quoted region is ONE WORD. Both halves of the invariant, structurally:
    const cmd = 'grep -E "foo|ruflo init" file.txt';
    expect(commandNodes(cmd)).toHaveLength(1);                     // ONE command node — no boundary
    expect(commandNodes(cmd)[0].exe).toBe('grep');                 // …and it is grep
    expect(commandNodes(cmd)[0].argv).toEqual(['grep', '-E', 'foo|ruflo init', 'file.txt']);
    expect(invoked(cmd)).toEqual([]);                              // ruflo is NOT an invoked executable
  });

  it('(was: quote chars survive, content masked) a quoted region is ONE argument, bytes preserved', () => {
    // Old form asserted `echo "___" '___'`. The invariant underneath is that quoted text is a single
    // opaque DATA argument — separators inside it are content, and the content is not mangled.
    expect(commandNodes(`echo "a|b" 'c;d'`)).toEqual([
      { assigns: [], dynamic: false, exe: 'echo', argv: ['echo', 'a|b', 'c;d'] },
    ]);
  });

  it('(was: a real unquoted separator survives the mask) a real separator DOES split commands', () => {
    // The other side of #41: masking must not blind the gate to genuine command position.
    expect(exes('echo hi | ruflo memory search')).toEqual(['echo', 'ruflo']);
    expect(invoked('echo hi | ruflo memory search')).toEqual(['ruflo memory search']);
    for (const sep of [';', '&&', '||', '|', '&', '\n']) {
      expect(exes(`echo hi ${sep} ruflo init`), `separator ${JSON.stringify(sep)}`).toEqual(['echo', 'ruflo']);
    }
  });

  it('(was: escaped quote does not close the quote) the #13 fixture is ONE node, content intact', () => {
    // An escaped `\"` is a literal `"` byte in the raw text but must not end the quoted region. If it
    // did, the tail would be re-read as shell code and `quoted` / `thing` would surface as commands.
    const cmd = 'git commit -m "fix: \\"quoted\\" thing"';
    expect(commandNodes(cmd)).toHaveLength(1);
    expect(commandNodes(cmd)[0].argv).toEqual(['git', 'commit', '-m', 'fix: "quoted" thing']);
    expect(exes(cmd)).toEqual(['git']); // nothing after the quote became a command
  });

  it('(was: single quotes take no escapes) a backslash inside single quotes is ordinary content', () => {
    // `'a\|b'` is 4 literal characters (a, \, |, b) — real shell semantics: single quotes have no
    // escapes at all, so the backslash must NOT be consumed the way it is inside double quotes.
    const argv = commandNodes("echo 'a\\|b'")[0].argv;
    expect(argv).toEqual(['echo', 'a\\|b']);
    expect(argv[1]).toHaveLength(4);
  });

  it('(was: unterminated quote masks to end) an unclosed quote terminates and stays DATA', () => {
    expect(() => commandNodes('echo "never closes')).not.toThrow();
    expect(commandNodes('echo "never closes')).toEqual([
      { assigns: [], dynamic: false, exe: 'echo', argv: ['echo', 'never closes'] },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Issue #44: masking alone was not enough. A DEFINITE command node nested inside a literal
// `bash -lc '…'` payload, a backtick substitution, or a `$( … )` inside double quotes is *inside
// quotes* — masked out, invisible to any gate matching on the masked text. The parser recurses into
// exactly those, and into nothing else: a nested node is a command only when its EXECUTABLE is
// LITERAL, which is the line that keeps this from becoming #41 again.
describe('commandNodes — nested commands are commands (was: shellScanUnits, issue #44)', () => {
  it('(was: unit 0 is the top-level skeleton) top-level nodes come first, and simple stays simple', () => {
    expect(commandNodes('ls -la')).toHaveLength(1);
    expect(exes("bash -lc 'ruflo memory search -q x'")).toEqual(['bash', 'ruflo']); // top level, then nested
  });

  it('DEFINITE nested nodes are found: sh -c payloads, backticks, $() — including inside "…"', () => {
    expect(invoked("bash -lc 'ruflo memory search -q x'")).toEqual(['ruflo memory search -q x']);
    expect(invoked('sh -c "ruflo memory search -q x"')).toEqual(['ruflo memory search -q x']);
    expect(invoked("bash -ic 'ruflo init'")).toEqual(['ruflo init']);
    expect(invoked("/bin/bash -c 'ruflo init'")).toEqual(['ruflo init']);
    expect(invoked("bash --login -c 'ruflo init'")).toEqual(['ruflo init']);
    expect(invoked('x=`ruflo memory search -q x`')).toEqual(['ruflo memory search -q x']);
    expect(invoked('x=$(ruflo memory search -q x)')).toEqual(['ruflo memory search -q x']);
    expect(invoked(`printf '%s' "$(ruflo memory search -q x)"`)).toEqual(['ruflo memory search -q x']);
    expect(invoked('echo "out: `ruflo init`"')).toEqual(['ruflo init']);
    expect(invoked('diff <(ruflo init) f')).toEqual(['ruflo init']); // process substitution
  });

  it('a leading assignment does not hide the executable behind it', () => {
    expect(commandNodes('FOO=1 ruflo init')[0]).toMatchObject({ assigns: ['FOO=1'], exe: 'ruflo' });
    expect(invoked('FOO=1 ruflo init')).toEqual(['ruflo init']);
  });

  it('recurses: a payload inside a payload is still a definite command', () => {
    expect(invoked(`bash -c 'sh -c "ruflo init"'`)).toEqual(['ruflo init']);
    expect(invoked("bash -lc 'echo $(ruflo init)'")).toEqual(['ruflo init']);
  });

  it('DATA is never promoted: single quotes and heredoc bodies suppress both substitution forms', () => {
    expect(invoked(`printf '%s' '$(ruflo init)'`)).toEqual([]);
    expect(invoked(`printf '%s' '\`ruflo init\`'`)).toEqual([]);
    expect(invoked("cat <<'EOF'\nruflo init is the command\nEOF")).toEqual([]);
    expect(invoked("cat <<'EOF'\nx=$(ruflo init)\nEOF")).toEqual([]);
    expect(invoked('cat <<-EOF\n\tx=`ruflo init`\nEOF')).toEqual([]);
    expect(invoked('echo hi <<< "ruflo init"')).toEqual([]);       // herestring is DATA
    expect(invoked('ls # ruflo init')).toEqual([]);                // comment is DATA
  });

  it('LIVE CAPTURE 2026-07-27: PRODUCT PROSE in a heredoc body is DATA, not an invocation', () => {
    // Not in any issue: the maintainer was blocked mid-session because the words "agentic-qe
    // integration plan" appeared inside a heredoc body he was writing. Same class as #12/#41 seen
    // from the false-positive side — a tool NAME at the start of a line looks exactly like command
    // position to anything line-anchored. The parser never asks: a heredoc body is skipped whole.
    const cmd = "cat <<'EOF'\nagentic-qe integration plan\nEOF";
    expect(exes(cmd)).toEqual(['cat']);
    expect(invoked(cmd, 'agentic-qe')).toEqual([]);
    expect(invoked('cat <<EOF\nagentic-qe integration plan\nEOF', 'agentic-qe')).toEqual([]); // unquoted delimiter too
    // …and the identical text as a REAL command is still found. Prose vs invocation is the whole job;
    // a test that only proved the ALLOW half would pass on a parser that found nothing at all.
    expect(invoked('agentic-qe integration plan', 'agentic-qe')).toEqual(['agentic-qe integration plan']);
  });

  it('a heredoc consumes its BODY, not the rest of the script', () => {
    expect(exes("cat <<'EOF'\nprose\nEOF\nruflo init")).toEqual(['cat', 'ruflo']);
    expect(invoked("cat <<'EOF'\nprose\nEOF\nruflo init")).toEqual(['ruflo init']);
  });

  it('a DYNAMIC executable stays opaque — nothing to ground, so the caller fails open', () => {
    // #12's lesson, kept: a name that is not in the text cannot be classified. `dynamic: true` is the
    // parser SAYING SO, and `exe` is '' rather than a half-word that could be mistaken for a literal.
    expect(commandNodes('$TOOL memory search -q x')[0]).toMatchObject({ dynamic: true, exe: '' });
    expect(invoked('$TOOL memory search -q x')).toEqual([]);
    expect(invoked('bash -c "$cmd"')).toEqual([]);
    expect(invoked('eval "$cmd"')).toEqual([]);
    // An argument whose text is not fully known is reported as '' too — never a partial token.
    expect(commandNodes('ruflo memory search -q "$Q"')[0].argv).toEqual(['ruflo', 'memory', 'search', '-q', '']);
  });

  it('$(( … )) is ARITHMETIC, not a command substitution', () => {
    expect(exes('echo $((1+2))')).toEqual(['echo']);
    expect(exes('echo $((1<<2))')).toEqual(['echo']);              // and its `<<` is not a heredoc
    expect(invoked('echo $((1+2)) && ruflo init')).toEqual(['ruflo init']); // the script still parses on
  });

  it('TERMINATES and stays bounded on hostile input — unclosed quotes, unclosed subs, deep nesting', () => {
    expect(() => commandNodes('bash -c "ruflo init')).not.toThrow();
    expect(() => commandNodes('x=$(y=$(z=$(echo')).not.toThrow();
    expect(() => commandNodes('cat <<EOF\nnever terminated')).not.toThrow();
    const deep = 'bash -c '.repeat(40) + 'ruflo init';
    expect(() => commandNodes(deep)).not.toThrow();
    const bomb = '$('.repeat(300) + 'ruflo init';
    const t0 = Date.now();
    expect(() => commandNodes(bomb)).not.toThrow();
    expect(Date.now() - t0, 'a parser a hostile command can hang is a denial of service on the shell').toBeLessThan(2000);
    expect(commandNodes(bomb).length).toBeLessThanOrEqual(256);    // MAX_NODES — output stays bounded
  });
});

// findInvocations is what every gate actually calls; commandNodes is the structure underneath it.
// These are #12's invariants — the ones about WHICH BINARY a name refers to — restated on the API
// that now decides it.
describe('findInvocations — the name must be the EXECUTABLE, and the right binary (issue #12)', () => {
  it('npx/bunx/pnpx wrappers are transparent and an explicit @version is stripped', () => {
    expect(invoked('npx ruflo@latest memory search -q x')).toEqual(['ruflo memory search -q x']);
    expect(invoked('npx -y ruflo@3.28.0 init')).toEqual(['ruflo init']);
    expect(invoked('bunx ruflo init')).toEqual(['ruflo init']);
    expect(invoked('/usr/local/bin/ruflo init')).toEqual(['ruflo init']); // a path still names the binary
  });

  it('a DIFFERENT binary sharing a prefix or suffix is NOT the managed tool', () => {
    expect(invoked('ruflo-source-patch adr-index status')).toEqual([]);
    expect(invoked('my-ruflo memory search -q x')).toEqual([]);
    expect(invoked('echo ruflowers memory search')).toEqual([]);
  });

  it('an empty or unknown tool list finds nothing, and never throws', () => {
    expect(findInvocations('ruflo init', '')).toEqual([]);
    expect(findInvocations('ruflo init', [])).toEqual([]);
    expect(findInvocations('ruflo init', 'agentic-qe')).toEqual([]);
    expect(() => findInvocations(null, 'ruflo')).not.toThrow();
  });
});
