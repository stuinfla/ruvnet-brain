import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { policiesFor } from '../../plugin/scripts/decision-gate.mjs';
import { CONTEXT_EVENTS as ADAPTER_CONTEXT_EVENTS, ALL_HOST_EVENTS } from '../../plugin/scripts/codex-hook-events.mjs';
import { continuityRegistrations } from '../../plugin/scripts/continuity-hook-policy.mjs';

// DERIVED, not hand-listed (tests/unit/entrypoint-guard-safety.test.mjs's "no fixture hand-lists the
// imports of a script it isolates" sweep, 2026-08-12): a second literal `copyFileSync` naming the
// adapter's new sibling is exactly the shape that guard exists to catch. `serverDependencies()` walks
// the adapter's real import graph instead, so a future import is carried into the sandbox for free.
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { serverDependencies } = await import(new URL('../../bin/install.mjs', import.meta.url).href);

/**
 * CODEX AND CLAUDE CODE ARE ONE PRODUCT, OR THE SECOND HOST IS A DECORATION.
 *
 * THE DEFECT THIS FILE EXISTS FOR, found by two independent adversarial audits on 2026-08-13:
 * identifier-preflight, degradation-watch and adr-currency were added to decision-gate's registry
 * and shipped. Claude Code routes PreToolUse through that gate, so all three went live there.
 * codex-hooks.json listed policies ONE BY ONE and never called the gate, so all three were
 * unreachable on Codex — with no stated reason, no failing test, and nothing on any surface saying
 * a capability existed on one host only.
 *
 * The shape is not "someone forgot". It is that the two manifests were written in different
 * vocabularies and nothing ever compared them, so the only thing standing between a policy and
 * silent host-absence was whoever last edited a JSON file remembering to edit the other one too.
 *
 * SO THE ASSERTIONS BELOW ARE DERIVED, NEVER LISTED. The policy set comes from decision-gate's own
 * registry (import, not a copy) and the hook set comes from the two manifests (read, not a copy). A
 * new policy or a new hook is covered the moment it is added, which is the only way this stays true.
 *
 * ABSENCE IS ALLOWED — SILENCE IS NOT. A capability Codex genuinely cannot host is a legitimate
 * decision, and a "DECLARED ABSENT — <hook>" block in codex-hooks.json's `description` is where it is
 * recorded, with the host fact behind it (that string is the ONLY place it can live — see below). A
 * declaration is checked in both directions: it must name something Claude
 * Code really registers and Codex really does not, so the escape hatch cannot become a place to
 * park things by writing a sentence.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLAUDE_HOOKS = path.join(ROOT, 'plugin', 'hooks', 'hooks.json');
const CODEX_HOOKS = path.join(ROOT, 'plugin', 'hooks', 'codex-hooks.json');
const ADAPTER = path.join(ROOT, 'plugin', 'scripts', 'codex-hook-adapter.mjs');

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** The hook ids a manifest actually registers, derived from the commands themselves. */
function hookIds(file) {
  const manifest = read(file);
  const ids = new Set();
  for (const groups of Object.values(manifest.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        // Both manifests end their command with `<hook-id> [sub-event]`, the Codex one after the
        // inline wrapper body and the Claude one after hook-shim.mjs.
        const m = String(hook.command).match(/(?:hook-shim\.mjs"?|"\s*\d+)\s+([a-z][a-z0-9-]+)/);
        if (m) ids.add(m[1]);
      }
    }
  }
  return ids;
}

/**
 * Run the adapter against a stub hook body. The stub stands in for hook-shim.mjs, which the adapter
 * resolves as its own sibling — so the fixture is a directory holding both.
 */
function runAdapter({ shim, payload, args = ['probe'], env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-'));
  fs.copyFileSync(ADAPTER, path.join(dir, 'codex-hook-adapter.mjs'));
  for (const dep of serverDependencies(ADAPTER)) {
    const target = path.resolve(dir, dep.spec);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dep.from, target);
  }
  fs.writeFileSync(path.join(dir, 'hook-shim.mjs'), shim);
  try {
    return spawnSync(process.execPath, [path.join(dir, 'codex-hook-adapter.mjs'), ...args], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 15_000,
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const ECHO_PAYLOAD = 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>process.stdout.write(raw));';

describe('both hosts carry the same constrained continuity policy', () => {
  it('ships exactly the declared continuity plane on each host', () => {
    for (const [file, host] of [[CLAUDE_HOOKS, 'claude'], [CODEX_HOOKS, 'codex']]) {
      const expected = continuityRegistrations(host);
      expect(Object.keys(read(file).hooks).sort()).toEqual([...new Set(expected.map((s) => s.event))].sort());
      expect(hookIds(file)).toEqual(new Set(expected.map((s) => s.id)));
    }
  });

  it('keeps each host manifest schema-valid and explicit about retired legacy gates', () => {
    for (const file of [CLAUDE_HOOKS, CODEX_HOOKS]) {
      const doc = read(file);
      expect(Object.keys(doc).sort()).toEqual(['description', 'hooks']);
      expect(doc.description).toMatch(/legacy.*remain retired/i);
    }
  });
});

/**
 * DECISION-GATE'S WRITE ROUTE AND GROUNDING-STAMP ON CODEX (measured live 2026-09-12).
 *
 * The 2026-09-11 "not proven" claim for Codex PreToolUse/PostToolUse was measured with
 * `codex exec "reply OK"` — a prompt that never invokes a tool, so of course neither event fired.
 * A real probe (a prompt that actually calls `apply_patch`, and a second that calls this repo's own
 * `search_ruvnet` MCP server) against codex-cli 0.154.0 fired both events with real payloads — see
 * continuity-hook-policy.mjs's header for the full transcript shape. This block is the fail-first
 * proof: before that measurement these hosts arrays were `['claude']` only and every assertion here
 * was red (continuityRegistrations('codex') carried neither id; codex-hooks.json had no PreToolUse
 * or PostToolUse key at all).
 */
describe('decision-gate write route and grounding-stamp are registered on Codex (2026-09-12)', () => {
  it('the continuity policy grants Codex both PreToolUse decision-gate and PostToolUse grounding-stamp', () => {
    const codexRegs = continuityRegistrations('codex');
    expect(codexRegs.find((r) => r.event === 'PreToolUse' && r.id === 'decision-gate'),
      'a real apply_patch write was measured live 2026-09-12 (codex-cli 0.154.0) to fire PreToolUse — '
      + 'decision-gate must be reachable there, matching Claude').toBeTruthy();
    expect(codexRegs.find((r) => r.event === 'PostToolUse' && r.id === 'grounding-stamp'),
      'a real MCP search_ruvnet call was measured live 2026-09-12 to fire PostToolUse — grounding-stamp '
      + 'must be reachable there too').toBeTruthy();
  });

  it('the shared decision-gate matcher recognizes apply_patch without dropping any Claude write tool', () => {
    const spec = continuityRegistrations().find((r) => r.event === 'PreToolUse' && r.id === 'decision-gate');
    expect(spec.hosts.slice().sort()).toEqual(['claude', 'codex']);
    const re = new RegExp(spec.matcher);
    for (const claudeTool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(re.test(claudeTool), `matcher stopped matching Claude's ${claudeTool}`).toBe(true);
    }
    expect(re.test('apply_patch'), "matcher must recognize Codex's real raw tool_name for a write, "
      + 'measured live 2026-09-12 (codex-cli 0.154.0)').toBe(true);
    // Anchored, not a substring net — a tool merely containing the word must not slip through.
    expect(re.test('not_apply_patch_at_all')).toBe(false);
    expect(re.test('apply_patched')).toBe(false);
  });

  it('grounding-stamp keeps byte-identical matchers on both hosts — Codex needed no change', () => {
    const spec = continuityRegistrations().find((r) => r.event === 'PostToolUse' && r.id === 'grounding-stamp');
    expect(spec.hosts.slice().sort()).toEqual(['claude', 'codex']);
    // Real MCP tool_name observed live 2026-09-12 for this repo's own search_ruvnet server.
    expect(new RegExp(spec.matcher).test('mcp__ruvnet_brain__search_ruvnet')).toBe(true);
  });

  it('codex-hooks.json actually registers both with the exact policy-declared matcher', () => {
    const doc = read(CODEX_HOOKS);
    const preSpec = continuityRegistrations('codex').find((r) => r.event === 'PreToolUse' && r.id === 'decision-gate');
    const postSpec = continuityRegistrations('codex').find((r) => r.event === 'PostToolUse' && r.id === 'grounding-stamp');

    const preGroup = (doc.hooks.PreToolUse ?? []).find((g) => g.matcher === preSpec.matcher
      && (g.hooks ?? []).some((h) => /(?:^|[\s"'])decision-gate write(?:$|[\s"'])/.test(String(h.command))));
    expect(preGroup, 'no PreToolUse group in codex-hooks.json registers "decision-gate write" under '
      + `the policy matcher ${JSON.stringify(preSpec.matcher)}`).toBeTruthy();

    const postGroup = (doc.hooks.PostToolUse ?? []).find((g) => g.matcher === postSpec.matcher
      && (g.hooks ?? []).some((h) => /(?:^|[\s"'])grounding-stamp(?:$|[\s"'])/.test(String(h.command))));
    expect(postGroup, 'no PostToolUse group in codex-hooks.json registers "grounding-stamp" under '
      + `the policy matcher ${JSON.stringify(postSpec.matcher)}`).toBeTruthy();
  });

  it('hook-contracts.json states both as dual-host, matching the policy exactly', () => {
    const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hook-contracts.json'), 'utf8'));
    for (const [event, id] of [['PreToolUse', 'decision-gate'], ['PostToolUse', 'grounding-stamp']]) {
      const spec = continuityRegistrations().find((r) => r.event === event && r.id === id);
      const owner = contracts._eventOwners.find((row) => row.event === event && row.owner === id);
      expect(owner, `${event}:${id} missing from hook-contracts.json _eventOwners`).toBeTruthy();
      expect(owner.hosts.slice().sort()).toEqual(spec.hosts.slice().sort());
      const contract = contracts.contracts.find((row) => row.event === event && row.id === id);
      expect(contract, `${event}:${id} missing from hook-contracts.json contracts`).toBeTruthy();
      expect(contract.hosts.slice().sort()).toEqual(spec.hosts.slice().sort());
      expect(contract.matcher).toBe(spec.matcher);
    }
  });
});

// Historical adapter-parity proof retained for the dormant compatibility library. It is not a
// product acceptance gate because neither host registers these adapters automatically.
describe.skip('retired: the Codex manifest cannot silently lose a policy the gate owns', () => {
  it('routes PreToolUse refusal through decision-gate on BOTH hosts', () => {
    const cc = fs.readFileSync(CLAUDE_HOOKS, 'utf8');
    const cx = fs.readFileSync(CODEX_HOOKS, 'utf8');
    for (const sub of ['write', 'bash']) {
      expect(cc, `Claude Code stopped routing PreToolUse "${sub}" through decision-gate`)
        .toContain(`decision-gate ${sub}`);
      expect(cx, `Codex does not route PreToolUse "${sub}" through decision-gate, so every policy `
        + 'in the gate registry is unreachable there').toContain(`decision-gate ${sub}`);
    }
  });

  it('wires the gate for EVERY sub-event Claude Code gates, not just the ones that existed today', () => {
    // Derived from the Claude manifest, never listed here. The first version of this test required
    // codex-hooks.json to ENUMERATE the gate's policies, and within the hour a policy was added to
    // the registry and the enumeration went stale — which is the very maintenance burden that made
    // the three 2026-08-13 policies Codex-invisible in the first place. Naming things by hand is the
    // bug; a test that demands it by hand is the bug with a green tick next to it.
    //
    // The right invariant is about the MECHANISM: a sub-event routed through the gate on one host is
    // routed through it on the other. Policies then travel for free, forever.
    // From the COMMANDS, not the file text: both manifests carry prose that mentions the gate, and
    // matching that would assert against documentation instead of against what runs.
    const commandsOf = (file) => Object.values(read(file).hooks ?? {})
      .flatMap((groups) => (groups ?? []).flatMap((g) => (g.hooks ?? []).map((h) => String(h.command))));
    const subEvents = [...new Set(commandsOf(CLAUDE_HOOKS)
      .flatMap((c) => [...c.matchAll(/decision-gate (\w+)/g)].map((m) => m[1])))];
    const cx = commandsOf(CODEX_HOOKS).join('\n');
    expect(subEvents.length, 'Claude Code routes nothing through decision-gate — nothing to compare')
      .toBeGreaterThan(1);
    const missing = subEvents.filter((s) => !cx.includes(`decision-gate ${s}`));
    expect(missing, 'Claude Code gates these PreToolUse sub-events and Codex does not, so every '
      + 'policy the gate holds for them is unreachable on Codex').toEqual([]);

    // And the registry must be non-empty for each, or the gate is a pass-through and the parity is
    // real but worthless. Imported from decision-gate.mjs so it tracks the live registry.
    for (const sub of subEvents) {
      expect(policiesFor(sub).length, `decision-gate has no policies for "${sub}"`).toBeGreaterThan(0);
    }
  });
});

describe.skip('retired: every Claude Code hook is registered on Codex or declared absent with a host reason', () => {
  it('has no undeclared divergence in either direction', () => {
    const claude = hookIds(CLAUDE_HOOKS);
    const codex = hookIds(CODEX_HOOKS);
    expect(claude.size, 'no Claude hook ids parsed — the derivation is broken').toBeGreaterThan(8);
    expect(codex.size, 'no Codex hook ids parsed — the derivation is broken').toBeGreaterThan(8);

    // The declaration lives in `description`, because MEASURED on a live Codex 0.147.0 session that
    // is the only key besides `hooks` this file may carry: an extra top-level object produced
    // `unknown field \`hostParity\`, expected \`description\` or \`hooks\`` and Codex dropped the
    // ENTIRE manifest — every hook off, on one warning line. So the record is prose, and this reads it.
    const description = String(read(CODEX_HOOKS).description ?? '');
    // decision-gate subsumes the individual refusal policies on both hosts, so a policy id is
    // "registered" wherever the gate is.
    const gatePolicies = new Set([...policiesFor('write'), ...policiesFor('bash')].map((p) => p.id));
    const reachable = (ids) => new Set([...ids, ...(ids.has('decision-gate') ? gatePolicies : [])]);

    const onCodex = reachable(codex);
    const onClaude = reachable(claude);

    const undeclared = [...onClaude].filter((id) => !onCodex.has(id)
      && !new RegExp(`DECLARED ABSENT — ${id}\\b`).test(description));
    expect(undeclared, 'these run on Claude Code and not on Codex, with nothing in '
      + 'codex-hooks.json hostParity.declaredAbsent saying why').toEqual([]);
  });

  it('rejects a declaration that does not describe a real divergence', () => {
    // The escape hatch must cost as much as the wiring, or it becomes the cheaper option.
    const claude = hookIds(CLAUDE_HOOKS);
    const codex = hookIds(CODEX_HOOKS);
    const description = String(read(CODEX_HOOKS).description ?? '');
    const declared = [...description.matchAll(/DECLARED ABSENT — ([a-z][a-z0-9-]+)([\s\S]*?)(?=\n\n|$)/g)];
    expect(declared.length, 'no declaration parsed — either none exists or the format drifted and '
      + 'this check has quietly stopped checking').toBeGreaterThan(0);
    for (const [, hook, reason] of declared) {
      expect(claude.has(hook), `"${hook}" is declared absent but Claude Code does not register it `
        + 'either — the declaration describes nothing').toBe(true);
      expect(codex.has(hook), `"${hook}" is declared absent but Codex registers it`).toBe(false);
      expect(reason.trim().length, `"${hook}" is declared absent with no host reason`)
        .toBeGreaterThan(60);
    }
  });

  it('carries ONLY the two top-level keys Codex will accept', () => {
    // MEASURED on a live Codex 0.147.0 session, and the reason this assertion exists at all: a third
    // top-level key made Codex log `unknown field \`hostParity\`, expected \`description\` or
    // \`hooks\`` and discard the entire manifest — all 16 hooks off, no error, no exit code, one
    // warning line. The blast radius of the tidy-metadata habit is every hook on the host.
    expect(Object.keys(read(CODEX_HOOKS)).sort()).toEqual(['description', 'hooks']);
  });
});

describe('the adapter emits output Codex will accept, per event', () => {
  /**
   * MEASURED AGAINST THE HOST, NOT THE COMMENTS. Codex 0.147.0 parses hook stdout and says so:
   * "hook returned invalid post-tool-use JSON output". The events that may carry prose are exactly
   * the ones whose output schema defines a *HookSpecificOutputWire. signal-watch.mjs prints one
   * plain advisory LINE on PostToolUse, and before this fix the adapter passed it through raw.
   *
   * DERIVED, not hand-copied (Dream Cycle 2026-08-30). This block used to carry its own 4-item
   * CONTEXT_EVENTS array — a second, independent copy of the adapter's real 6-item set, silently
   * missing `PermissionRequest` and `SubagentStart`, so this "per event" proof never once ran for
   * either. Same for NO_CONTEXT_EVENTS: hand-listing 2 of the host's actual 4 no-context,
   * non-Stop events (`PostCompact`, `SubagentStop` had zero coverage). Reading both from the
   * adapter's own exports and the host's full event catalogue means a future event added to either
   * side is exercised the moment it exists, the same discipline this file's own header already
   * states for policy ids and hook ids above.
   */
  const CONTEXT_EVENTS = [...ADAPTER_CONTEXT_EVENTS];
  const NO_CONTEXT_EVENTS = ALL_HOST_EVENTS.filter((e) => e !== 'Stop' && !ADAPTER_CONTEXT_EVENTS.has(e));

  it.each(CONTEXT_EVENTS)('wraps a body\'s plain text in a valid %s envelope', (event) => {
    const r = runAdapter({
      shim: 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("[RuvNet Brain] a plain line"));',
      payload: { session_id: 'p', hook_event_name: event, cwd: os.tmpdir() },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(() => JSON.parse(r.stdout), `${event}: "${r.stdout}" is not JSON, which Codex reports as `
      + 'an invalid hook output').not.toThrow();
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: event, additionalContext: '[RuvNet Brain] a plain line' },
    });
  });

  it.each(NO_CONTEXT_EVENTS)('drops a body\'s plain text on %s, which has nowhere to put it', (event) => {
    // session-end.command.output does not exist in the Codex schema set and pre-compact.command
    // .output has no additionalContext. Emitting an envelope here would trade a silent no-op for a
    // host error, so the only correct output is none.
    const r = runAdapter({
      shim: 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("chatter"));',
      payload: { session_id: 'p', hook_event_name: event, cwd: os.tmpdir() },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout, `${event} accepts no output; anything here is a host error`).toBe('');
  });

  it.each(NO_CONTEXT_EVENTS)('drops a body\'s JSON envelope on %s too, not only unparseable prose', (event) => {
    // Dream Cycle 2026-08-25: the test above only ever fed the adapter TEXT that fails JSON.parse.
    // A body that happens to emit VALID JSON — e.g. a stray hookSpecificOutput.additionalContext
    // envelope — skips the `!parsed` guard entirely and fell through to a verbatim stdout write,
    // even though this event's own Codex schema has nowhere for that envelope to go (same "no
    // additionalContext at all" / "output does not exist" fact the prose test above already states).
    // No shipped hook body constructs that today, but nothing stopped one from starting to.
    const r = runAdapter({
      shim: 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:"leaked"}})));',
      payload: { session_id: 'p', hook_event_name: event, cwd: os.tmpdir() },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout, `${event} accepts no output; a JSON envelope here is as much a host error as prose`).toBe('');
  });

  it('strips every permissionDecision Codex rejects, and keeps deny', () => {
    // The wire enum has allow/deny/ask and Codex accepts one: "PreToolUse hook returned unsupported
    // permissionDecision:allow" / ":ask". The shared bodies also speak "defer", which is in no enum.
    for (const decision of ['defer', 'allow', 'ask']) {
      const r = runAdapter({
        shim: `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"${decision}"}})));`,
        payload: { session_id: 'p', hook_event_name: 'PreToolUse', cwd: os.tmpdir() },
      });
      expect(r.status).toBe(0);
      expect(r.stdout, `permissionDecision:${decision} reached the host`).not.toContain(decision);
    }
    const kept = runAdapter({
      shim: 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"no"}})));',
      payload: { session_id: 'p', hook_event_name: 'PreToolUse', cwd: os.tmpdir() },
    });
    expect(JSON.parse(kept.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('a multi-file Codex patch is shown to the walls file by file', () => {
  const patch = (...files) => `*** Begin Patch\n${files
    .map((f) => `*** Update File: ${f}\n@@\n-old\n+new`).join('\n')}\n*** End Patch\n`;
  const payloadFor = (...files) => ({
    session_id: 'multi',
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: patch(...files) },
    cwd: os.tmpdir(),
  });

  it('shows both move source and destination to pre-tool policies for a raw namespaced patch', () => {
    const r = runAdapter({
      shim: 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(raw).tool_input.file_path));',
      payload: {
        ...payloadFor(), tool_name: 'functions.apply_patch',
        tool_input: '*** Begin Patch\n*** Update File: /tmp/before.md\n*** Move to: /tmp/after.md\n@@\n-old\n+new\n*** End Patch',
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split('\n'))
      .toEqual(['/tmp/before.md', '/tmp/after.md']);
  });

  it('exposes EVERY file, not just the first', () => {
    // Every write policy reads a single tool_input.file_path (protect-brain-state.sh, ground-before-
    // write.sh, adr-currency-gate.mjs). The adapter used to parse one file out of the patch, so on a
    // three-file patch two files were never shown to any wall. This assertion fails on that code.
    const r = runAdapter({
      shim: 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(raw).tool_input.file_path));',
      payload: payloadFor('/tmp/a.ts', '/tmp/b.ts', '/tmp/c.ts'),
    });
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout).hookSpecificOutput.additionalContext.split('\n');
    expect(seen).toEqual(['/tmp/a.ts', '/tmp/b.ts', '/tmp/c.ts']);
  });

  it('REFUSES when a wall objects to a file that is not the first one', () => {
    // The teeth. A gate that only ever sees file 1 cannot refuse file 3, and would exit 0 here.
    const r = runAdapter({
      shim: 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{'
        + 'const f=JSON.parse(raw).tool_input.file_path;'
        + 'if(f==="/tmp/c.ts"){process.stderr.write("BLOCKED — /tmp/c.ts is governed");process.exit(2);}'
        + 'process.exit(0);});',
      payload: payloadFor('/tmp/a.ts', '/tmp/b.ts', '/tmp/c.ts'),
    });
    expect(r.status, 'the third file in the patch was never gated').toBe(2);
    expect(r.stderr).toContain('BLOCKED — /tmp/c.ts is governed');
  });

  it('leaves a single-file patch byte-identical to the one-run path', () => {
    const r = runAdapter({ shim: ECHO_PAYLOAD, payload: payloadFor('/tmp/only.ts') });
    const out = JSON.parse(r.stdout);
    expect(out.tool_name).toBe('Edit');
    expect(out.tool_input.file_path).toBe('/tmp/only.ts');
    expect(out.tool_input.new_string).toBe(patch('/tmp/only.ts'));
  });

  it('stops and ALLOWS rather than being killed mid-fan-out', () => {
    // The wrapper SIGKILLs at its budget and a kill prints nothing, so the adapter must stop itself.
    // decision-gate's own rule: a blown budget allows and says nothing.
    const started = Date.now();
    const r = runAdapter({
      shim: 'const t=Date.now();while(Date.now()-t<400);process.exit(0);',
      payload: payloadFor('/tmp/a.ts', '/tmp/b.ts', '/tmp/c.ts', '/tmp/d.ts', '/tmp/e.ts', '/tmp/f.ts'),
      env: { RUVNET_CODEX_BUDGET_MS: '900' },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(Date.now() - started, 'the fan-out ignored its budget').toBeLessThan(3_000);
  });
});
