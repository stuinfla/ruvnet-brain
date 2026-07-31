import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE_SCRIPTS = path.join(ROOT, 'plugin/scripts');
const roots = [];

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function makeFixture(configure = () => {}) {
  // macOS exposes /var through /private/var. Use one canonical spelling so a lexical path emitted
  // by the shell and a realpath emitted by Node are not mistaken for a behavioral difference.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-parity-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const plugin = path.join(root, 'plugin');
  const scripts = path.join(plugin, 'scripts');
  const cache = path.join(home, '.cache/ruvnet-brain');
  const state = path.join(home, '.config/ruvnet-brain');
  const detachLog = path.join(root, 'detach.jsonl');
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(SOURCE_SCRIPTS, scripts, { recursive: true });
  write(path.join(plugin, '.claude-plugin/plugin.json'), {
    version: '4.0.2-test',
    updated: '2026-07-31',
  });
  // Maintenance dispatch is part of the observable contract, but the parity test must not launch
  // real network/update work. This sibling has the same CLI boundary and records the exact request.
  write(path.join(scripts, 'detach.mjs'), `
    import fs from 'node:fs';
    fs.appendFileSync(process.env.RUVNET_PARITY_DETACH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
  `);
  configure({ root, home, project, plugin, scripts, cache, state, detachLog });
  return { root, home, project, plugin, scripts, cache, state, detachLog };
}

function childEnv(f) {
  return {
    ...process.env,
    HOME: f.home,
    USERPROFILE: f.home,
    XDG_CACHE_HOME: path.join(f.home, '.cache'),
    RUVNET_BRAIN_HOME: f.cache,
    RUVNET_BRAIN_STATE_DIR: f.state,
    RUVNET_BRAIN_METER: '1',
    RUVNET_PARITY_DETACH_LOG: f.detachLog,
    CLAUDE_PLUGIN_ROOT: f.plugin,
    CLAUDE_PROJECT_DIR: f.project,
    RUVNET_HOOK_HOST: 'claude',
  };
}

function runShell(f) {
  return spawnSync('bash', [path.join(f.scripts, 'session-start.sh')], {
    cwd: f.project,
    env: childEnv(f),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runCore(f) {
  const core = path.join(f.scripts, 'session-start-core.mjs');
  const source = `
    import { runSessionStart } from ${JSON.stringify(new URL(`file://${core}`).href)};
    let output = '';
    let errors = '';
    const result = await runSessionStart({
      stdout: { write(chunk) { output += String(chunk); return true; } },
      stderr: { write(chunk) { errors += String(chunk); return true; } },
    });
    process.stdout.write(output);
    process.stderr.write(errors);
    if (!result || result.ok !== true || result.outputBytes !== Buffer.byteLength(output)) process.exit(91);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: f.project,
    env: childEnv(f),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function normalize(text, f) {
  return String(text || '')
    .replaceAll(f.root, '<ROOT>')
    .replaceAll(f.home, '<HOME>')
    .replaceAll(f.project, '<PROJECT>')
    .replaceAll(f.plugin, '<PLUGIN>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ISO_TIME>')
    .replace(/\b\d{10,13}\b/g, '<EPOCH>')
    .replace(/\r\n/g, '\n');
}

function filesUnder(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(absolute, base, out);
    else if (entry.isFile()) out[path.relative(base, absolute)] = fs.readFileSync(absolute, 'utf8');
  }
  return out;
}

function observableState(f) {
  const state = filesUnder(f.home);
  for (const [name, value] of Object.entries(state)) state[name] = normalize(value, f);
  const project = filesUnder(f.project);
  for (const [name, value] of Object.entries(project)) project[name] = normalize(value, f);
  return {
    home: state,
    project,
    detach: fs.existsSync(f.detachLog)
      ? fs.readFileSync(f.detachLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
        const argv = JSON.parse(line).map((value) => (
          value === 'node' || value === process.execPath ? '<NODE>' : normalize(value, f)
        ));
        return JSON.stringify(argv);
      })
      : [],
  };
}

function parity(configure) {
  const shellFixture = makeFixture(configure);
  const coreFixture = makeFixture(configure);
  const shell = runShell(shellFixture);
  const core = runCore(coreFixture);
  expect(shell.status, shell.stderr).toBe(0);
  expect(core.status, core.stderr).toBe(0);
  expect(normalize(core.stdout, coreFixture)).toBe(normalize(shell.stdout, shellFixture));
  expect(normalize(core.stderr, coreFixture)).toBe(normalize(shell.stderr, shellFixture));
  expect(observableState(coreFixture)).toEqual(observableState(shellFixture));
  return { output: normalize(core.stdout, coreFixture), state: observableState(coreFixture) };
}

function healthyKb({ cache }) {
  write(path.join(cache, 'kb/public.big.rvf'), 'rvf');
  write(path.join(cache, 'kb/node_modules/@xenova/transformers/package.json'), '{}');
  write(path.join(cache, 'kb/SOURCE.json'), { releaseTag: 'brain-test' });
}

function warmed({ cache }) {
  healthyKb({ cache });
  for (const name of [
    '.console-offered', '.router-profile-nudged', '.last-major-milestone',
    '.last-announced-version', '.star-ask-shown',
  ]) write(path.join(cache, name), name.includes('major') ? '4.x' : name.includes('announced') ? '4.0.2-test' : '1');
  write(path.join(cache, '.seed-attempted'), String(Math.floor(Date.now() / 1000)));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('host-neutral SessionStart core parity with the shell host surface', () => {
  it('matches first-run stdout, one-time stamps, token ledger, and maintenance dispatch', () => {
    const result = parity((f) => {
      healthyKb(f);
      write(path.join(f.project, 'package.json'), '{}');
      write(path.join(f.home, '.config/ruvnet-brain/settings.json'), {
        settings: {
          newProjectDefaults: true,
          learningScope: 'project',
          autoApply: false,
          advocacy: 4,
        },
      });
    });
    expect(result.output).toContain('FIRST LOAD: offer the Console once');
    expect(result.output).toContain('RuvNet Brain v4.0.2-test — active this session');
    expect(Object.keys(result.state.home)).toContain('.cache/ruvnet-brain/.console-offered');
    expect(Object.keys(result.state.home)).toContain('.cache/ruvnet-brain/token-ledger.jsonl');
    expect(Object.keys(result.state.project)).toContain('.swarm/ruvnet-brain-settings.json');
    expect(result.state.detach.join('\n')).toContain('first-session-worker.mjs');
  });

  it('matches alarms, issue/signal transitions, grounding state, and update notices', () => {
    const now = new Date().toISOString();
    const result = parity((f) => {
      warmed(f);
      write(path.join(f.cache, 'health.json'), { status: 'down', error: 'reader failed' });
      write(path.join(f.cache, 'open-issues.json'), {
        at: now,
        issues: [{ number: 77, title: 'search is red', ageHours: 4, breach: false }],
      });
      write(path.join(f.cache, 'external-signals/pending.jsonl'), '{"key":"x"}\n');
      write(path.join(f.cache, 'external-signals/ci-status.json'), {
        'repo@deadbeef': {
          repo: 'example/repo', ref: 'deadbeef', state: 'resolved',
          conclusion: 'failure', workflowName: 'ci', checkedAt: now,
        },
      });
      write(path.join(f.cache, 'install-state.json'), { grounding: 'unproven', reason: 'offline', at: now });
      write(path.join(f.project, '.ruvnet-brain/nightly-failure.json'), { failed: true });
      write(path.join(f.cache, '.last-update-check'), '1');
      write(path.join(f.cache, '.auto-update-pref'), 'no');
      write(path.join(f.cache, '.last-version-check.log'), '9.9.9\n');
    });
    expect(result.output).toContain('HEALTH ALARM');
    expect(result.output).toContain('NIGHTLY FAILED');
    expect(result.output).toContain('open issues');
    expect(result.output).toContain('EXTERNAL SIGNAL: CI is RED');
    expect(result.output).toContain('grounding not yet PROVEN');
    expect(result.output).toContain('update available, auto-update not enabled');
    expect(Object.keys(result.state.home)).toContain('.cache/ruvnet-brain/external-signals/surfaced.json');
    expect(result.state.detach.join('\n')).toContain('host-update.mjs');
  });

  it('matches OFF behavior with an absent KB: one state line, no advertising, offers unconsumed', () => {
    const result = parity((f) => {
      write(path.join(f.state, 'brain-off'), { since: '2026-07-30', reason: 'pause' });
      write(path.join(f.cache, '.last-update-check'), '1');
    });
    expect(result.output.match(/brain OFF by your setting/g)).toHaveLength(1);
    expect(result.output).toContain('disabled by choice');
    expect(result.output).not.toContain('RuvNet Brain active');
    expect(result.output).not.toContain('standing build playbook');
    expect(Object.keys(result.state.home)).not.toContain('.cache/ruvnet-brain/.console-offered');
  });

  it('matches OFF behavior with real breakage: alarms remain live while advertising remains silent', () => {
    const result = parity((f) => {
      write(path.join(f.state, 'brain-off'), { since: '2026-07-30' });
      write(path.join(f.cache, 'kb/public.big.rvf'), 'rvf');
      write(path.join(f.cache, 'health.json'), { status: 'down', error: 'reader failed' });
      write(path.join(f.cache, '.last-update-check'), String(Math.floor(Date.now() / 1000)));
    });
    expect(result.output).toContain('HEALTH ALARM');
    expect(result.output).toContain('brain OFF by your setting');
    expect(result.output).not.toContain('RuvNet Brain active');
    expect(result.output).not.toContain('standing build playbook');
  });
});

describe('hook-shim SessionStart authority selection', () => {
  it('selects the native Node core on every platform without reaching Bash resolution or a Bash spawn', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-win32-selection-'));
    roots.push(root);
    const scripts = path.join(root, 'plugin/scripts');
    const home = path.join(root, 'home');
    fs.mkdirSync(scripts, { recursive: true });

    const original = fs.readFileSync(path.join(SOURCE_SCRIPTS, 'hook-shim.mjs'), 'utf8');
    const importLine = "import { resolveBash, skipNoBash } from './hook-shim-bash.mjs';";
    expect(original).toContain(importLine);
    const instrumented = original
      .replace(importLine, `
        const resolveBash = () => { throw new Error('BASH_RESOLUTION_REACHED'); };
        const skipNoBash = () => { throw new Error('BASH_SKIP_REACHED'); };
      `);
    write(path.join(scripts, 'hook-shim.mjs'), instrumented);
    write(path.join(scripts, 'session-start-core.mjs'),
      "process.stdout.write('NATIVE_SESSION_CORE\\n');\n");

    const result = spawnSync(process.execPath, [path.join(scripts, 'hook-shim.mjs'), 'session-start'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        RUVNET_BRAIN_HOME: path.join(home, '.cache/ruvnet-brain'),
        RUVNET_BRAIN_STATE_DIR: path.join(home, '.config/ruvnet-brain'),
        CLAUDE_PLUGIN_ROOT: path.join(root, 'plugin'),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('NATIVE_SESSION_CORE\n');
    expect(result.stderr).not.toContain('BASH_RESOLUTION_REACHED');
    expect(result.stderr).not.toContain('BASH_SKIP_REACHED');
  });
});
