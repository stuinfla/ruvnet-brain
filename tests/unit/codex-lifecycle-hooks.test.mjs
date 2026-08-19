import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs');
const ADAPTER = path.join(ROOT, 'plugin', 'scripts', 'codex-hook-adapter.mjs');
const HOOKS = path.join(ROOT, 'plugin', 'hooks', 'codex-hooks.json');
const CLAUDE_HOOKS = path.join(ROOT, 'plugin', 'hooks', 'hooks.json');
const MANIFEST = path.join(ROOT, 'plugin', '.codex-plugin', 'plugin.json');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-codex-hooks-'));
  const brain = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(path.join(brain, 'versions'), { recursive: true });
  return { home, brain };
}

process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { serverDependencies } = await import(new URL('../../bin/install.mjs', import.meta.url).href);

function installGeneration(brain, version, shimSource) {
  const scripts = path.join(brain, 'versions', version, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  // Same rule as every other isolated-copy fixture: carry the adapter's REAL imports, derived.
  fs.copyFileSync(ADAPTER, path.join(scripts, 'codex-hook-adapter.mjs'));
  for (const dep of serverDependencies(ADAPTER)) {
    const target = path.resolve(scripts, dep.spec);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.copyFileSync(dep.from, target); } catch { /* a generation fixture may stub it instead */ }
  }
  fs.writeFileSync(path.join(scripts, 'hook-shim.mjs'), shimSource);
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({
    generation: version,
    version,
    codeRoot: `versions/${version}`,
  }));
}

function installGroundingGeneration(brain, version) {
  const scripts = path.join(brain, 'versions', version, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of [
    'codex-hook-adapter.mjs',
    'hook-shim.mjs',
    'hook-shim-bash.mjs',
    'ground-before-write.sh',
    'grounding-substance.mjs',
    'hook-input.mjs',
  ]) {
    fs.copyFileSync(path.join(ROOT, 'plugin', 'scripts', file), path.join(scripts, file));
  }
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({
    generation: version,
    version,
    codeRoot: `versions/${version}`,
  }));
}

function installInterfaceGeneration(brain, version) {
  const scripts = path.join(brain, 'versions', version, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const file of [
    'codex-hook-adapter.mjs',
    'hook-shim.mjs',
    'hook-shim-bash.mjs',
    'verify-interface.sh',
    'hook-input.mjs',
    'gate-receipt.sh',
  ]) {
    fs.copyFileSync(path.join(ROOT, 'plugin', 'scripts', file), path.join(scripts, file));
  }
  fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({
    generation: version,
    version,
    codeRoot: `versions/${version}`,
  }));
}

function fire(home, id, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [WRAPPER, id], {
    cwd: ROOT,
    // os.homedir() follows USERPROFILE on Windows, so HOME alone does not isolate the wrapper there.
    // The explicit product override is the portable contract and prevents a CI runner's real
    // preinstalled generation from leaking onboarding/health output into these fixture assertions.
    env: { ...process.env, HOME: home, RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'), ...extraEnv },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 4_000,
  });
}

function manifestHandlers() {
  const hooks = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group) =>
    group.hooks.map((hook) => ({ event, ...hook }))));
}

function fireRegistered(command, home, payload, extraEnv = {}) {
  return spawnSync(command, {
    cwd: ROOT,
    shell: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'),
      RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
      ...extraEnv,
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 2_000,
  });
}

// The property under test is "finishes after one complete JSON value WITHOUT waiting for stdin EOF".
// A hook that waits for EOF here never finishes at all, so any finite cap proves it — the cap is a
// liveness bound, not a latency budget, and tuning it down does not make the test stricter.
//
// It was 2000ms, which made it fail on machine LOAD rather than on behaviour: this file spawns every
// registered handler concurrently, and when a second vitest suite runs beside it the spawns queue.
// MEASURED 2026-08-14 on an idle machine, 5 rounds × 16 concurrent handlers = 80 samples: max 1197ms,
// nothing above 2000ms — and 1 failure in 3 runs once other suites were running. 6000ms is 5× the
// measured worst case and still infinitely short of "waits for EOF".
function fireRegisteredHeldOpen(command, home, payload, limitMs = 6_000) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ROOT,
      shell: true,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: path.join(home, '.codex'),
        RUVNET_BRAIN_HOME: path.join(home, '.cache', 'ruvnet-brain'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ completed: false, stdout, stderr });
    }, limitMs);
    child.on('exit', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ completed: true, status, signal, stdout, stderr });
    });
    child.stdin.write(JSON.stringify(payload));
    // Deliberately keep stdin open: Codex can retain the pipe after one complete JSON value.
  });
}

describe('Codex lifecycle hook packaging', () => {
  it('ships a Codex manifest and schema-valid hook source without Claude-only metadata', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const hooks = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
    const projectHooks = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex', 'hooks.json'), 'utf8'));

    expect(manifest.hooks).toBe('./hooks/codex-hooks.json');
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(hooks._note).toBeUndefined();
    expect(projectHooks._note).toBeUndefined();
    expect(hooks.hooks.SessionStart).toBeTruthy();
    expect(hooks.hooks.Stop).toBeTruthy();
    // PreToolUse refusal is ONE registration per sub-event on BOTH hosts (ADR-067). Asserting the
    // gate rather than a policy name is the point: this file used to name `ground-before-write`
    // directly, which is exactly the pattern that let identifier-preflight, degradation-watch and
    // adr-currency ship to Claude Code and never reach Codex — a manifest that lists policies one by
    // one has to be edited for each new one, and nothing failed when it wasn't.
    expect(JSON.stringify(hooks.hooks.PreToolUse)).toContain(' decision-gate write');
    expect(JSON.stringify(hooks.hooks.PreToolUse)).toContain(' decision-gate bash');
    expect(JSON.stringify(hooks.hooks.PostToolUse)).toContain('grounding-stamp');
    expect(hooks.hooks.PostToolUse.some((group) =>
      group.matcher?.includes('search_ruvnet')
      && group.hooks.some((hook) => hook.command.includes(' grounding-stamp')))).toBe(true);
  });

  it('registers successful-search stamping on both first-class hosts', () => {
    for (const hookFile of [CLAUDE_HOOKS, HOOKS]) {
      const hooks = JSON.parse(fs.readFileSync(hookFile, 'utf8')).hooks;
      expect(hooks.PostToolUse.some((group) =>
        group.matcher?.includes('search_ruvnet')
        && group.hooks.some((hook) => hook.command.includes(' grounding-stamp'))),
      `${path.basename(hookFile)} must connect a successful search to the write-time grounding wall`).toBe(true);
    }
  });

  it('gives UserPromptSubmit hooks twice the unprompted runtime deadline on both hosts', () => {
    const runtime = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'unprompted-runtime.mjs'), 'utf8');
    const deadlineMs = Number(runtime.match(/RUVNET_UNPROMPTED_TIMEOUT_MS\) \|\| (\d+)/)?.[1]);
    expect(deadlineMs).toBeGreaterThan(0);

    for (const hookFile of [CLAUDE_HOOKS, HOOKS]) {
      const hooks = JSON.parse(fs.readFileSync(hookFile, 'utf8')).hooks;
      for (const group of hooks.UserPromptSubmit ?? []) {
        for (const hook of group.hooks ?? []) {
          expect(
            hook.timeout * 1_000,
            `${path.basename(hookFile)} UserPromptSubmit "${hook.command}" has no cold/contended headroom`,
          ).toBeGreaterThanOrEqual(deadlineMs * 2);
          expect(hook.timeout).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it('matches the raw Codex tool names before the adapter normalizes them', () => {
    const hooks = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
    const groupsFor = (event, hookId) => hooks[event].filter((group) =>
      group.hooks.some((hook) => hook.command.includes(` ${hookId}`)));

    // EVERY loop below asserts a group was FOUND first. The previous version iterated
    // `groupsFor(...)` directly, so when the policies it named moved behind decision-gate the loops
    // ran zero times and the test went green by having nothing left to check — a test that cannot
    // fail is the defect this whole area keeps producing.
    const requireGroups = (event, hookId) => {
      const found = groupsFor(event, hookId);
      expect(found.length, `${event} registers no ${hookId} — nothing is being checked here`)
        .toBeGreaterThan(0);
      return found;
    };

    // The write-class gate must see Codex's own patch tool; the bash-class gate must see all three
    // spellings of its exec tool. The adapter normalizes AFTER the matcher has already selected, so
    // a matcher written in Claude's vocabulary simply never fires on Codex.
    for (const group of requireGroups('PreToolUse', 'decision-gate write')) {
      expect(group.matcher).toMatch(/apply_patch/);
    }
    for (const group of requireGroups('PreToolUse', 'decision-gate bash')) {
      expect(group.matcher).toMatch(/exec_command/);
      expect(group.matcher).toMatch(/functions\\\.exec_command/);
      expect(group.matcher).toMatch(/functions__exec_command/);
    }
    for (const group of requireGroups('PostToolUse', 'learn-capture')) {
      expect(group.matcher).toMatch(/exec_command/);
      expect(group.matcher).toMatch(/functions\\\.exec_command/);
      expect(group.matcher).toMatch(/apply_patch/);
    }
    for (const group of requireGroups('PreToolUse', 'verify-interface')) {
      expect(group.matcher).toMatch(/exec_command/);
      expect(group.matcher).toMatch(/functions\\\.exec_command/);
    }
    for (const group of requireGroups('PostToolUse', 'md-stamp')) {
      expect(group.matcher).toMatch(/apply_patch/);
    }
    for (const group of requireGroups('PostToolUse', 'routing-outcome')) {
      expect(group.matcher).toMatch(/spawn_agent/);
    }
    for (const group of requireGroups('PreToolUse', 'route-dispatch')) {
      expect(group.matcher).toMatch(/spawn_agent/);
    }
  });

  it('uses one generation-independent entrypoint for every Codex hook', () => {
    const hooks = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
    const handlers = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));

    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      expect(handler.command).toContain("p.join(b,'codex-hook.mjs')");
      expect(handler.command).toContain('process.env.CODEX_HOME');
      expect(handler.command).toContain('process.exit(r.status===2?2:0)');
      expect(handler.command).not.toMatch(/PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|plugins\/cache/);
    }
  });

  it('respects the host SessionEnd cap, and DETACHES the work that cannot fit inside it', () => {
    // THE ASSERTION THIS REPLACES WAS `SessionEnd[0].hooks[0].timeout <= 3` with no stated reason,
    // so it read as tidiness and was removed on the way to raising the budget to 30s. It was not
    // tidiness. MEASURED 2026-08-14 on a LIVE Codex 0.147.0 session, which prints it itself:
    //
    //     warning: clamping SessionEnd hook timeout to 3s in .../hooks.json
    //
    // SessionEnd is hard-capped. A 30 in this file is not a longer budget, it is a number the host
    // silently corrects — and the same run confirmed the cap applies to the whole registration.
    //
    // learn-flush needs 18s (18342/18347/18384 ms measured with a real queue and real ruflo). Under
    // the old 2250ms wrapper budget it was SIGKILLed: exit 0, 2760ms, ZERO bytes out, ZERO bytes of
    // stderr, queue unchanged at 10 lines. Silent total failure, every Codex session.
    //
    // The cap governs how long the host WAITS, not how long work may take, so the wrapper detaches.
    // Measured after the fix: hook returned in 200ms, queue 10 -> 2 twenty-five seconds later.
    const codex = JSON.parse(fs.readFileSync(HOOKS, 'utf8')).hooks;
    const wrapper = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'), 'utf8');
    const detached = wrapper.match(/DETACHED_HOOKS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
    expect(detached, 'the wrapper declares no detached hooks').toBeTruthy();

    const flush = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'learn-flush.mjs'), 'utf8');
    const deadlineMs = Number(flush.match(/LEARN_FLUSH_DEADLINE_MS\) \|\| (\d+)_?(\d*)/)
      ?.slice(1).join('') || 0);
    expect(deadlineMs, 'learn-flush.mjs no longer declares a deadline').toBeGreaterThan(0);

    for (const handler of (codex.SessionEnd ?? []).flatMap((g) => g.hooks ?? [])) {
      expect(handler.timeout, `SessionEnd "${handler.command.slice(-30)}" asks for `
        + `${handler.timeout}s; the host clamps SessionEnd to 3s and says so in a warning`)
        .toBeLessThanOrEqual(3);
      const id = handler.command.match(/" \d+ ([a-z][a-z0-9-]+)/)?.[1];
      // Anything that cannot finish inside the cap must be detached, or the host kills it and the
      // wrapper reports nothing — which is indistinguishable from the work having been done.
      if (id === 'learn-flush') {
        expect(detached, `${id} needs ${deadlineMs}ms and SessionEnd is capped at 3s, so it must be `
          + 'in the wrapper DETACHED_HOOKS set or its work is silently discarded').toContain(id);
      }
    }

    // Claude Code has no such cap, so there the budget must simply exceed the work.
    const claude = JSON.parse(fs.readFileSync(CLAUDE_HOOKS, 'utf8')).hooks;
    const ccFlush = (claude.SessionEnd ?? []).flatMap((g) => g.hooks ?? [])
      .find((h) => h.command.includes(' learn-flush'));
    expect(ccFlush, 'Claude Code does not register learn-flush').toBeTruthy();
    expect(ccFlush.timeout * 1_000, 'Claude Code kills learn-flush before its own deadline')
      .toBeGreaterThan(deadlineMs);

    // The Codex chain nests budgets; each outer one must outlive the one it supervises, or the inner
    // deadline is decorative. host timeout > inline `node -e` timeout > wrapper budget.
    for (const [event, groups] of Object.entries(codex)) {
      for (const handler of groups.flatMap((g) => g.hooks ?? [])) {
        const inlineMs = Number(handler.command.match(/" (\d+) [a-z-]+/)?.[1]);
        expect(inlineMs, `${event}: no inline budget parsed`).toBeGreaterThan(0);
        expect(handler.timeout * 1_000, `${event}: inline budget ${inlineMs}ms is not inside the `
          + `${handler.timeout}s host registration`).toBeGreaterThan(inlineMs);
      }
    }
  });

  it('every literal registered command is silent and fail-open when the stable wrapper is absent', () => {
    const { home } = fixture();
    for (const handler of manifestHandlers()) {
      const result = fireRegistered(handler.command, home, {
        session_id: 'codex-missing-wrapper',
        hook_event_name: handler.event,
        cwd: ROOT,
      });
      expect(result.error, `${handler.event}: ${result.error?.message}`).toBeUndefined();
      expect(result.signal, `${handler.event}: signal`).toBeNull();
      expect(result.status, `${handler.event}: ${result.stderr}`).toBe(0);
      expect(result.stdout, `${handler.event}: stdout`).toBe('');
      expect(result.stderr, `${handler.event}: stderr`).toBe('');
    }
  });

  it('all literal registered commands finish after one complete JSON value even when stdin stays open', async () => {
    const { home, brain } = fixture();
    installGeneration(brain, 'v1', 'process.exit(0);');
    fs.copyFileSync(WRAPPER, path.join(brain, 'codex-hook.mjs'));

    const results = await Promise.all(manifestHandlers().map(async (handler) => ({
      event: handler.event,
      result: await fireRegisteredHeldOpen(handler.command, home, {
        session_id: 'codex-held-open',
        hook_event_name: handler.event,
        cwd: ROOT,
      }),
    })));

    expect(results).toHaveLength(16);
    for (const { event, result } of results) {
      expect(result.completed, `${event}: waited for stdin EOF`).toBe(true);
      expect(result.signal, `${event}: signal`).toBeNull();
      expect(result.status, `${event}: ${result.stderr}`).toBe(0);
      expect(result.stderr, `${event}: stderr`).toBe('');
    }
  });

  it('literal registered commands resolve the stable wrapper beside an isolated CODEX_HOME', () => {
    const loginHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-login-home-'));
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-codex-home-'));
    const codexHome = path.join(isolatedRoot, '.codex');
    const brain = path.join(isolatedRoot, '.cache', 'ruvnet-brain');
    fs.mkdirSync(codexHome, { recursive: true });
    installGeneration(brain, 'v1', 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("isolated codex home"));');
    fs.copyFileSync(WRAPPER, path.join(brain, 'codex-hook.mjs'));
    const command = manifestHandlers().find(({ event }) => event === 'SessionStart').command;

    const result = fireRegistered(command, loginHome, {
      session_id: 'codex-isolated-home',
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: ROOT,
    }, {
      CODEX_HOME: codexHome,
      RUVNET_BRAIN_HOME: '',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe('isolated codex home');
  });

  it('installer places the stable wrapper outside every versioned plugin cache', async () => {
    const { wireCodexHost } = await import('../../bin/install.mjs');
    const { home } = fixture();
    const codexDir = path.join(home, '.codex');
    const wrapperPath = path.join(home, '.cache', 'ruvnet-brain', 'codex-hook.mjs');
    fs.mkdirSync(codexDir, { recursive: true });

    const result = wireCodexHost({
      codexDir,
      configPath: path.join(codexDir, 'config.toml'),
      serverDir: path.join(home, '.cache', 'ruvnet-brain', 'mcp'),
      hookWrapperSource: WRAPPER,
      hookWrapperPath: wrapperPath,
      announce: false,
    });

    expect(result.hookWrapperPath).toBe(wrapperPath);
    expect(fs.readFileSync(wrapperPath, 'utf8')).toBe(fs.readFileSync(WRAPPER, 'utf8'));
    expect(wrapperPath).not.toMatch(/plugins[\\/]cache|versions[\\/]/);
  });
});

describe('Codex lifecycle adapter', () => {
  it('fails open and silent when an advisory adapter crashes', () => {
    const { home, brain } = fixture();
    const scripts = path.join(brain, 'versions', 'v1', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'codex-hook-adapter.mjs'), 'process.stderr.write("adapter exploded"); process.exit(1);');
    fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ version: 'v1', codeRoot: 'versions/v1' }));

    const result = fire(home, 'session-start', { hook_event_name: 'SessionStart', cwd: ROOT });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('times out a hung advisory adapter inside the host deadline and fails open silently', () => {
    const { home, brain } = fixture();
    const scripts = path.join(brain, 'versions', 'v1', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'codex-hook-adapter.mjs'), 'setInterval(() => {}, 1000);');
    fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ version: 'v1', codeRoot: 'versions/v1' }));
    const started = Date.now();

    const result = fire(home, 'session-start', { hook_event_name: 'SessionStart', cwd: ROOT }, {
      RUVNET_CODEX_HOOK_TIMEOUT_MS: '75',
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('preserves an intentional blocking exit 2 while failing other wrapper errors open', () => {
    const { home, brain } = fixture();
    installGeneration(brain, 'v1', 'process.stderr.write("policy refusal"); process.exit(2);');

    const blocked = fire(home, 'ground-before-write', { hook_event_name: 'PreToolUse', cwd: ROOT });
    expect(blocked.status).toBe(2);
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr).toBe('policy refusal');

    const advisory = fire(home, 'session-start', { hook_event_name: 'SessionStart', cwd: ROOT });
    expect(advisory.status).toBe(0);
    expect(advisory.stdout).toBe('');
    expect(advisory.stderr).toBe('');
  });

  it('wraps bracket-prefixed SessionStart text in the exact Codex context envelope', () => {
    const { home, brain } = fixture();
    installGeneration(brain, 'v1', 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("[RuvNet Brain start]"));');

    const result = fire(home, 'session-start', {
      session_id: 'codex-a',
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: ROOT,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '[RuvNet Brain start]',
      },
    });
  });

  it('maps Codex PLUGIN_ROOT to the Claude-compatible variable used by shared hooks', () => {
    const { home, brain } = fixture();
    installGeneration(
      brain,
      'v1',
      'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write(process.env.CLAUDE_PLUGIN_ROOT || "missing"));',
    );
    const pluginRoot = path.join(home, '.codex', 'plugins', 'ruvnet-brain');

    const result = fire(home, 'session-start', {
      session_id: 'codex-plugin-root',
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: ROOT,
    }, { PLUGIN_ROOT: pluginRoot });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: pluginRoot,
      },
    });
  });

  it('translates the Claude Stop continuation envelope into Codex block plus reason', () => {
    const { home, brain } = fixture();
    installGeneration(
      brain,
      'v1',
      'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"Stop",additionalContext:"Finish the open work."}})));',
    );

    const result = fire(home, 'continuation-gate', {
      session_id: 'codex-stop',
      turn_id: 'turn-1',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Done.',
      cwd: ROOT,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      decision: 'block',
      reason: 'Finish the open work.',
    });
  });

  it('wraps bracket-prefixed UserPromptSubmit text as valid Codex JSON', () => {
    const { home, brain } = fixture();
    installGeneration(brain, 'v1', 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("[RuvNet Brain grounding] use RVF"));');

    const result = fire(home, 'ground-ruvnet', {
      session_id: 'codex-prompt',
      turn_id: 'turn-2',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'How should vectors be stored?',
      cwd: ROOT,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '[RuvNet Brain grounding] use RVF',
      },
    });
  });

  it('normalizes apply_patch into the shared Edit contract without losing patch bytes', () => {
    const { home, brain } = fixture();
    installGeneration(
      brain,
      'v1',
      'let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>process.stdout.write(raw));',
    );
    const patch = '*** Begin Patch\n*** Update File: /tmp/project/src/rvf.ts\n@@\n-old\n+new\n*** End Patch\n';

    const result = fire(home, 'ground-before-write', {
      session_id: 'codex-patch',
      turn_id: 'turn-patch',
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: patch },
      cwd: '/tmp/project',
    });
    const normalized = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(normalized.tool_name).toBe('Edit');
    expect(normalized.tool_input.file_path).toBe('/tmp/project/src/rvf.ts');
    expect(normalized.tool_input.new_string).toBe(patch);
  });

  it.each(['exec_command', 'functions.exec_command', 'functions__exec_command'])(
    'normalizes %s into the shared Bash contract without losing Codex fields',
    (toolName) => {
      const { home, brain } = fixture();
      installGeneration(
        brain,
        'v1',
        'let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>process.stdout.write(raw));',
      );
      const command = 'ruflo memory search "the prior decision" --limit 10';

      const result = fire(home, 'verify-interface', {
        session_id: 'codex-exec',
        turn_id: 'turn-exec',
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: {
          cmd: command,
          justification: 'Recall project memory before deciding',
        },
        cwd: ROOT,
      });
      const normalized = JSON.parse(result.stdout);

      expect(result.status).toBe(0);
      expect(normalized.tool_name).toBe('Bash');
      expect(normalized.tool_input.command).toBe(command);
      expect(normalized.tool_input.cmd).toBe(command);
      expect(normalized.tool_input.justification).toBe('Recall project memory before deciding');
    },
  );

  it('advises without blocking an unverified Ruflo command through the real Codex exec_command boundary', () => {
    const { home, brain } = fixture();
    installInterfaceGeneration(brain, 'v1');
    const profile = path.join(home, '.claude', 'model-router', 'profile.json');
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(profile, '{}');

    const result = fire(home, 'verify-interface', {
      session_id: 'codex-interface-wall',
      turn_id: 'turn-interface-wall',
      hook_event_name: 'PreToolUse',
      tool_name: 'exec_command',
      tool_input: {
        cmd: 'ruflo memory search "the prior decision" --limit 10',
      },
      cwd: ROOT,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('ruvnet_cli_help');
    expect(result.stdout).toContain('ruvnet_cli_run');
  });

  it('blocks the founding remote-import contradiction through the installed Codex boundary', () => {
    const { home, brain } = fixture();
    installGroundingGeneration(brain, 'v1');
    const project = path.join(home, 'project');
    const profile = path.join(home, '.claude', 'model-router', 'profile.json');
    const evidence = path.join(home, 'evidence.jsonl');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.mkdirSync(path.join(brain, 'grounded'), { recursive: true });
    fs.writeFileSync(profile, '{}');
    fs.writeFileSync(path.join(brain, 'grounded', 'rvf'), '');
    fs.writeFileSync(path.join(brain, 'grounded', 'ruvector'), '');
    fs.writeFileSync(evidence, `${JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      query: 'rvf browser local',
      sources: [{
        repo: 'ruvector',
        path: 'examples/rvf/scripts/rvf-browser.html',
        packages: [{
          name: '@ruvector/rvf-wasm',
          install: 'npm install @ruvector/rvf-wasm',
          manager: 'npm',
        }],
        posture: ['No backend required.', 'entirely in the browser'],
        enforceable: true,
      }],
    })}\n`);
    const target = path.join(project, 'src', 'rvf.ts');
    const patch = `*** Begin Patch
*** Add File: ${target}
+import { RvfDatabase } from "https://esm.sh/@ruvector/rvf-wasm";
*** End Patch
`;

    const result = fire(home, 'ground-before-write', {
      session_id: 'codex-fourth-wall',
      turn_id: 'turn-fourth-wall',
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: patch },
      cwd: project,
    }, {
      MODEL_ROUTER_PROFILE: profile,
      RUVNET_EVIDENCE_FILE: evidence,
      RUVNET_BRAIN_STATE_DIR: path.join(home, 'brain-state'),
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('GROUNDING-NET (D1)');
    expect(result.stderr).toContain('ruvector/examples/rvf/scripts/rvf-browser.html');
    expect(result.stderr).toContain('npm install @ruvector/rvf-wasm');
    expect(result.stderr).toContain('https://esm.sh/@ruvector/rvf-wasm');
  });

  it('normalizes spawn_agent into the shared Agent routing contract', () => {
    const { home, brain } = fixture();
    installGeneration(
      brain,
      'v1',
      'let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>process.stdout.write(raw));',
    );

    const result = fire(home, 'route-dispatch', {
      session_id: 'codex-agent',
      turn_id: 'turn-agent',
      hook_event_name: 'PreToolUse',
      tool_name: 'spawn_agent',
      tool_input: {
        message: 'Review the storage boundary',
        agent_type: 'system-architect',
        task_name: 'storage_review',
      },
      cwd: ROOT,
    });
    const normalized = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(normalized.tool_name).toBe('Agent');
    expect(normalized.tool_input.description).toBe('Review the storage boundary');
    expect(normalized.tool_input.subagent_type).toBe('system-architect');
  });

  it('resolves the active generation on every invocation after the old one is removed', () => {
    const { home, brain } = fixture();
    installGeneration(brain, 'v1', 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("generation one"));');
    expect(JSON.parse(fire(home, 'session-start', {
      session_id: 'codex-upgrade',
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: ROOT,
    }).stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'generation one',
      },
    });

    installGeneration(brain, 'v2', 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("generation two"));');
    fs.rmSync(path.join(brain, 'versions', 'v1'), { recursive: true });

    const result = fire(home, 'session-start', {
      session_id: 'codex-upgrade',
      hook_event_name: 'SessionStart',
      source: 'resume',
      cwd: ROOT,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'generation two',
      },
    });
  });
});
