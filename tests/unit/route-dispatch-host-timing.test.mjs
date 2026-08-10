import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const HOOKS_PATH = path.join(REPO, 'plugin/hooks/hooks.json');
const ROUTE_DISPATCH = path.join(REPO, 'plugin/scripts/route-dispatch.sh');
const RECEIPT_DIR = ['meta', 'harness'].join('');

function optedInHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'route-timing-'));
  fs.mkdirSync(path.join(home, '.claude/model-router'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/model-router/profile.json'), '{"harnesses":{}}');
  return home;
}

function missingModelPayload() {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: 'toolu_issue_84',
    session_id: 'session_issue_84',
    tool_input: { description: 'bounded timing probe', subagent_type: 'general-purpose' },
  });
}

function registeredRouteHook() {
  const hooks = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8')).hooks.PreToolUse;
  const matches = hooks.flatMap((group, groupIndex) =>
    (group.hooks || []).map((hook, hookIndex) => ({ group, hook, groupIndex, hookIndex })),
  ).filter(({ hook }) => hook.command.includes('hook-shim.mjs\" route-dispatch'));
  expect(matches).toHaveLength(1);
  return matches[0];
}

function hookEnv(home) {
  return {
    ...process.env,
    HOME: home,
    CLAUDE_PLUGIN_ROOT: path.join(REPO, 'plugin'),
    RUVNET_BRAIN_HOME: path.join(home, '.cache/ruvnet-brain'),
  };
}

function runRegistered(input, home) {
  const { hook } = registeredRouteHook();
  return spawnSync('/bin/sh', ['-c', hook.command], {
    cwd: REPO,
    input,
    encoding: 'utf8',
    timeout: hook.timeout * 1_000,
    env: hookEnv(home),
  });
}

function spawnRegistered(input, home, { closeInput = true } = {}) {
  const { hook } = registeredRouteHook();
  const child = spawn('/bin/sh', ['-c', hook.command], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: hookEnv(home),
  });
  if (closeInput) child.stdin.end(input);
  else child.stdin.write(input);
  return child;
}

function waitFor(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

describe.skipIf(process.platform === 'win32')('issue #84 — Agent/Task host timing contract', () => {
  it('registers route-dispatch as advisory without changing adjacent hook registrations', () => {
    const hooks = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8')).hooks.PreToolUse;
    const { group, hook, groupIndex } = registeredRouteHook();

    expect(group.matcher).toBe('^(Task|Agent)$');
    expect(hook.command).toMatch(/route-dispatch \|\| true$/);
    expect(hook.timeout).toBe(5);
    // ADJACENCY BY INDEX WAS THE WRONG ASSERTION. It pinned the POSITION of two unrelated
    // registrations, so it broke the moment ADR-067 consolidated them — reporting a neighbour change
    // as if this hook had regressed. The property it meant to protect is that registering
    // route-dispatch did not disturb the OTHER PreToolUse entries, which is about their continued
    // existence and shape, not their array index.
    const others = hooks.filter((_, i) => i !== groupIndex);
    expect(others.length, 'route-dispatch must not be the only PreToolUse registration').toBeGreaterThan(0);
    for (const g of others) {
      expect(g.matcher, 'every sibling matcher must still be anchored or explicitly allowlisted').toBeTruthy();
      for (const h of g.hooks) {
        expect(h.command, 'a sibling must still dispatch through the shim').toMatch(/hook-shim\.mjs/);
        expect(h.timeout, 'and keep a bounded prompt-path timeout').toBeLessThanOrEqual(5);
      }
    }
  });

  it('returns before its declared timeout and never claims a late block', () => {
    const home = optedInHome();
    const started = performance.now();
    const result = runRegistered(missingModelPayload(), home);
    const elapsedMs = performance.now() - started;

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(elapsedMs).toBeLessThan(1_000);

    const receipt = JSON.parse(fs.readFileSync(
      path.join(home, '.claude', RECEIPT_DIR, 'dispatch-log.jsonl'),
      'utf8',
    ).trim());
    expect(receipt).toMatchObject({
      event: 'dispatch',
      model: 'inherited',
      enforcement: 'advisory-host-timing',
      toolUseId: 'toolu_issue_84',
      sessionId: 'session_issue_84',
    });
  });

  it('cannot delay tool completion or consume foreign hook processes', async () => {
    const home = optedInHome();
    const foreign = spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("foreign-ok"), 80)']);
    const ours = spawnRegistered(missingModelPayload(), home);
    const tool = spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("tool-complete"), 20)']);

    // Attach every close listener immediately. Short-lived siblings may exit while the
    // tool promise is awaited; attaching later loses their close event and creates a false timeout.
    const foreignDone = waitFor(foreign);
    const oursDone = waitFor(ours);
    const toolResult = await waitFor(tool);
    const toolEndedAt = performance.now();
    const [ourResult, foreignResult] = await Promise.all([oursDone, foreignDone]);
    const hooksCheckedAt = performance.now();

    expect(toolResult).toMatchObject({ status: 0, stdout: 'tool-complete', stderr: '' });
    expect(ourResult).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(foreignResult).toMatchObject({ status: 0, stdout: 'foreign-ok', stderr: '' });
    expect(toolEndedAt).toBeLessThan(hooksCheckedAt);
  });

  it('finishes with a held-open stdin stream instead of reaching the host timeout', async () => {
    const home = optedInHome();
    const child = spawnRegistered(missingModelPayload(), home, { closeInput: false });

    const watchdog = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('registered route-dispatch reached the 1s compatibility watchdog'));
      }, 1_000);
      timer.unref();
    });
    const result = await Promise.race([waitFor(child), watchdog]);

    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('the script itself is advisory when invoked without the shim', () => {
    const home = optedInHome();
    const result = spawnSync('bash', [ROUTE_DISPATCH], {
      input: missingModelPayload(),
      encoding: 'utf8',
      timeout: 5_000,
      env: { ...process.env, HOME: home },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
