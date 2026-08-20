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

/**
 * MEASURED in CI 2026-08-20 (run 32351326320): `learn-flush` is DETACHED by design
 * (`codex-hook-wrapper.mjs`'s `DETACHED_HOOKS` — it must outlive its parent because Codex hard-caps
 * SessionEnd at 3s while a real flush needs up to 18s), which the spine fixture below makes reachable
 * for the first time. The detached child can still be writing under `RUVNET_BRAIN_HOME` after `fire()`
 * returns, racing this cleanup's `rmSync` and intermittently throwing `ENOTEMPTY` — a
 * test-fixture-lifecycle race, not a product defect (a real install's `~/.cache/ruvnet-brain` is never
 * deleted out from under a running hook). `fs.rmSync`'s own retry option exists for exactly this
 * transient-EBUSY/ENOTEMPTY class; use it rather than widening what the assertions tolerate.
 *
 * A first pass budgeted 500ms total (maxRetries:5 × retryDelay:100) and still hit ENOTEMPTY in CI
 * (run 32371674603) — nowhere near covering `codex-hooks.json`'s own documented worst case for THIS
 * hook: "measured 18342/18347/18384 ms with a real queue and real ruflo". `RM_OPTS` keeps that short
 * budget as the general safety net (every other hook is fully synchronous by the time `fire()`
 * returns, so it never needs more); `RM_OPTS_LEARN_FLUSH` is scoped to the one command that is
 * DETACHED by design, with a ceiling comfortably above the documented worst case.
 */
const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const RM_OPTS_LEARN_FLUSH = { recursive: true, force: true, maxRetries: 60, retryDelay: 500 };
const rmOptsFor = (command) => (command.includes('learn-flush') ? RM_OPTS_LEARN_FLUSH : RM_OPTS);

/** A project this plugin has never seen: no git, no kb, no .swarm, no docs/adr, no evals. */
function strangerProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stranger-'));
  fs.writeFileSync(path.join(d, 'index.js'), '// somebody else\n');
  return d;
}

/**
 * MEASURED 2026-08-20: pointing `RUVNET_BRAIN_HOME` at an empty directory (below) is correct — it
 * keeps real ledgers untouched — but it also means every Codex hook command hits TWO independent,
 * undocumented silent-exit branches (`codex-hooks.json`'s trampoline has no installed
 * `codex-hook.mjs`; `codex-hook-wrapper.mjs` has no resolvable spine) before ever reaching
 * `codex-hook-adapter.mjs` or a shared hook body. Claude Code hits an analogous gap and recovers via
 * `hook-shim.mjs`'s LOUD frozen fallback, straight to `${CLAUDE_PLUGIN_ROOT}` (the real checkout, no
 * install required). Codex has no such fallback — it depends on an installed Stable Spine, full
 * stop — so without this fixture every "no stderr / no artifacts / within timeout" assertion below
 * was passing by construction for Codex, never by measurement: the hook never ran.
 *
 * Installs a minimal, REAL Stable Spine (ADR-023) so a Codex-host `fire()` reaches the same shared
 * hook bodies Claude Code already exercises here. Same fixture shape as
 * `tests/unit/codex-lifecycle-hooks.test.mjs`'s `installGeneration()` helpers, generalized to a full
 * `plugin/` copy because this file sweeps every hook rather than one at a time. Test-only: no
 * production file is read from anywhere but the real checkout, and nothing here is imported by
 * shipped code.
 */
function installCodexSpine(brainHome) {
  const version = 'conformance';
  const codeRoot = path.join(brainHome, 'versions', version);
  fs.mkdirSync(codeRoot, { recursive: true });
  fs.cpSync(path.join(ROOT, 'plugin'), codeRoot, { recursive: true });
  fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({
    generation: version, version, codeRoot: `versions/${version}`,
  }));
  fs.copyFileSync(
    path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'),
    path.join(brainHome, 'codex-hook.mjs'),
  );
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

function fire({ command, event, cwd, host }) {
  const started = Date.now();
  const brainHome = path.join(cwd, '.conformance-home');
  // Claude Code reaches its real hook bodies via the frozen fallback below with nothing further
  // needed. Codex has no such fallback (see installCodexSpine's docstring) — it must find a real
  // spine at RUVNET_BRAIN_HOME or every hook silently no-ops. Build one per call so each stranger
  // project stays isolated, matching every other root here.
  if (host === 'codex') installCodexSpine(brainHome);
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
      // frozen-plugin fallback on Claude Code, which is exactly the path a fresh install takes — and,
      // as of tonight, a real (also freshly-built) spine on Codex, for the same reason.
      RUVNET_BRAIN_HOME: brainHome,
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
      } finally { fs.rmSync(dir, rmOptsFor(c.command)); }
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
      } finally { fs.rmSync(dir, rmOptsFor(c.command)); }
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
      } finally { fs.rmSync(dir, rmOptsFor(c.command)); }
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
