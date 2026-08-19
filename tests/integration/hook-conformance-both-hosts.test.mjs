import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBash } from '../../plugin/scripts/hook-shim-bash.mjs';

/**
 * EVERY HOOK, BOTH HOSTS, IN A PROJECT THAT IS NOT THIS ONE.
 *
 * THE COMPLAINT THAT CAUSED THIS, from the owner, 2026-08-13: "When I opened up RuvNet Brain in
 * another project, I got a ton of hook errors." Two adversarial audits reproduced the causes, and
 * the standing instruction that followed is why this is a test rather than another promise:
 * *always check all the sets of hooks before you put something in production, for both Codex and
 * Claude Code — every single time, without fail.*
 *
 * WHAT THE AUDITS FOUND, all of it in hooks that had passing tests:
 *   · `git push` REFUSED on any machine without `ruflo` — a spawn ENOENT scored as "your memory
 *     store is broken", telling strangers to rebuild a package they never installed.
 *   · `.swarm/`, `.claude-flow/` and a 1.5MB database file planted in an unrelated user's repo.
 *   · decision-gate straddling its own 5s host timeout — 6 of 14 measured runs over the limit,
 *     including a plain `ls -la` at 5109ms, which the host renders as a failed hook.
 *   · this repo's open PRs injected into OTHER projects' Stop events as "work you committed to".
 *   · three policies wired for Claude Code and unreachable on Codex, with no stated reason.
 *
 * NOT ONE was catchable by the existing suite, because every test ran the hooks INSIDE this repo,
 * on this machine, on one host. The tests proved the hooks work where they were written. That is
 * the gap, and it is the same shape as every other defect found that day: a check pointed one
 * surface away from where the failure happens.
 *
 * SO THE RULES HERE ARE ABOUT RESTRAINT, NOT CAPABILITY. In a project this plugin does not own, a
 * hook must exit 0 or 2 (2 only for a deliberate refusal it explains), write NOTHING to stderr,
 * create NOTHING in the working tree, and finish inside the host's own timeout. A hook that cannot
 * meet that in a stranger's repo is not shippable, however well it behaves here.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const BASH = resolveBash();
const gated = BASH ? it : it.skip;

/** A project this plugin has never seen: no git, no kb, no .swarm, no docs/adr, no evals. */
function strangerProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stranger-'));
  fs.writeFileSync(path.join(d, 'index.js'), '// somebody else\n');
  return d;
}

/** Every command both manifests register, with the event it fires on. */
export function hookCommands() {
  const out = [];
  for (const [host, file] of [['claude-code', 'hooks.json'], ['codex', 'codex-hooks.json']]) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', file), 'utf8'));
    for (const [event, groups] of Object.entries(m.hooks ?? {})) {
      for (const g of groups ?? []) for (const h of g.hooks ?? []) {
        if (h.command) out.push({ host, event, command: h.command, timeout: h.timeout });
      }
    }
  }
  return out;
}

/** A payload shaped the way the hosts actually send them. */
const payloadFor = (event) => JSON.stringify({
  session_id: `conformance-${Math.random().toString(16).slice(2)}`,
  hook_event_name: event,
  prompt: 'add a helper to index.js',
  tool_name: 'Bash',
  tool_input: { command: 'ls -la', file_path: 'index.js' },
  tool_response: { success: true },
});

function fire({ command, event, cwd }) {
  const started = Date.now();
  const r = spawnSync(BASH, ['-c', command], {
    cwd,
    input: payloadFor(event),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
      RUVNET_BRAIN_PROJECT_DIR: cwd,
      RUVNET_CONFIG_ROOT: path.join(cwd, '.conformance-config'), // keep real ledgers untouched
      // TEST THE PAYLOAD BEING SHIPPED, NOT THE COPY ALREADY INSTALLED HERE.
      //
      // hook-shim resolves the Stable Spine (ADR-023) from $RUVNET_BRAIN_HOME/active.json and
      // dispatches THAT generation — so without this the gate measured the spine at 4.0.52-dev and
      // reported defects already fixed in the working tree as still present. A conformance gate that
      // grades the installed copy answers "is this machine currently OK", when the question a commit
      // needs answered is "is what I am about to ship OK". Pointing it at an empty home forces the
      // frozen-plugin fallback, which is exactly the path a fresh install takes.
      RUVNET_BRAIN_HOME: path.join(cwd, '.conformance-home'),
    },
  });
  return { ...r, ms: Date.now() - started };
}

describe('every registered hook behaves in a project this plugin does not own', () => {
  const commands = hookCommands();

  it('finds hooks in BOTH manifests, or this whole file is vacuous', () => {
    const byHost = commands.reduce((a, c) => ({ ...a, [c.host]: (a[c.host] ?? 0) + 1 }), {});
    expect(byHost['claude-code'] ?? 0, 'no Claude Code hooks found — the manifest path is wrong').toBeGreaterThan(5);
    expect(byHost.codex ?? 0, 'no Codex hooks found — Codex is not being checked at all').toBeGreaterThan(3);
  });

  gated('TEETH: no hook writes to stderr or fails in a stranger project', () => {
    // stderr is what a host renders as "hook error". This is the owner's literal complaint.
    const offenders = [];
    for (const c of commands) {
      const dir = strangerProject();
      try {
        const r = fire({ ...c, cwd: dir });
        const err = String(r.stderr || '').trim();
        if (err && r.status !== 2) offenders.push(`${c.host}/${c.event}: STDERR "${err.slice(0, 90)}"`);
        if (r.status !== 0 && r.status !== 2) offenders.push(`${c.host}/${c.event}: exit ${r.status}`);
        if (r.error) offenders.push(`${c.host}/${c.event}: ${r.error.message.slice(0, 80)}`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    expect(offenders, 'these emit noise or fail in a project that is not ruvnet-brain — a host '
      + 'renders that to the user as a hook error').toEqual([]);
  }, 600_000);

  gated('TEETH: no hook creates anything in a stranger working tree', () => {
    // Measured 2026-08-13: hooks planted .swarm/, .claude-flow/ and a 1.5MB database file in
    // unrelated repos. ADR-058 D5: never touch what we do not own.
    const offenders = [];
    for (const c of commands) {
      const dir = strangerProject();
      try {
        const before = fs.readdirSync(dir).sort().join(',');
        fire({ ...c, cwd: dir });
        const after = fs.readdirSync(dir).filter((n) => !n.startsWith('.conformance-')).sort().join(',');
        if (after !== before) offenders.push(`${c.host}/${c.event}: left behind ${after}`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    expect(offenders, 'these mutate a project the plugin does not own').toEqual([]);
  }, 600_000);

  gated('TEETH: every hook finishes well inside its own declared timeout', () => {
    // decision-gate measured 5109ms on a plain `ls -la` against a 5s manifest timeout — the host
    // kills it and shows a hook error. A budget that can be exceeded silently fails open without
    // saying so, which is how this stayed invisible.
    const offenders = [];
    for (const c of commands) {
      const dir = strangerProject();
      try {
        const r = fire({ ...c, cwd: dir });
        const budget = (c.timeout ?? 30) * 1000;
        if (r.ms > budget * 0.8) offenders.push(`${c.host}/${c.event}: ${r.ms}ms of a ${budget}ms budget`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    expect(offenders, 'these run too close to the host timeout that kills them; the host reports '
      + 'the kill as a hook error, intermittently, on ordinary tool calls').toEqual([]);
  }, 600_000);
});

describe('the two hosts do not silently diverge', () => {
  it('a policy reachable on Claude Code is reachable on Codex, or declared absent', () => {
    // Three policies added 2026-08-13 route through decision-gate for Claude Code, while
    // codex-hooks.json invokes individual policies and never calls the gate — so they exist on one
    // host only. A capability present on one host and absent on the other is a legitimate decision;
    // undeclared, it is a bug wearing a decision's clothes.
    const cc = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'hooks.json'), 'utf8');
    const cx = fs.readFileSync(path.join(ROOT, 'plugin', 'hooks', 'codex-hooks.json'), 'utf8');
    expect(
      /decision-gate/.test(cc) && !/decision-gate/.test(cx),
      'Claude Code routes PreToolUse through decision-gate and Codex does not, so every policy in '
      + 'the gate registry is unreachable on Codex. Either wire decision-gate into codex-hooks.json, '
      + 'or record there why each policy is deliberately Claude-Code-only.',
    ).toBe(false);
  });
});
