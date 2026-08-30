import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GROUND = path.join(ROOT, 'plugin/scripts/ground-ruvnet.sh');
const SHIM = path.join(ROOT, 'plugin/scripts/hook-shim.mjs');
const SHIM_BASH = path.join(ROOT, 'plugin/scripts/hook-shim-bash.mjs');
const ADAPTER = path.join(ROOT, 'plugin/scripts/codex-hook-adapter.mjs');
const ADAPTER_EVENTS = path.join(ROOT, 'plugin/scripts/codex-hook-events.mjs');
// THE BLOCK'S IDENTITY, not its full sentence. This was the entire headline verbatim — a copy of a
// product string living in a test — so issue #138's rewording ("switched OFF" -> "is NOT running",
// because a settings entry is not the daemon's environment) made this count 0 and read as "the
// advisory stopped firing". It had not; only the copy had changed. Anchoring on the stable prefix
// keeps the CADENCE property under test without pinning the wording it is indifferent to.
const MARKER = '[RuvNet Brain — the self-learning flywheel';
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

let home;
let projects;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'flywheel-cadence-'));
  projects = [path.join(home, 'project-a'), path.join(home, 'project-b')];
  for (const project of projects) {
    fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
  }
  fs.mkdirSync(path.join(home, '.cache', 'ruvnet-brain'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.cache', 'ruvnet-brain', '.stack-versions-checked'),
    new Date().toISOString(),
  );
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function env(project, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    CLAUDE_PROJECT_DIR: project,
    RUVNET_BRAIN_METER: '0',
    RUVNET_FLYWHEEL_DATE: '2026-07-28',
    RUFLO_HARNESS_LOOP: '',
    ...extra,
  };
}

function claude(project, extra = {}) {
  return spawnSync('bash', [GROUND], {
    cwd: project,
    env: env(project, extra),
    input: JSON.stringify({ prompt: 'hello' }),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function seedCodexGeneration() {
  const root = path.join(home, '.cache', 'ruvnet-brain', 'versions', 'test');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const source of [GROUND, SHIM, SHIM_BASH, ADAPTER, ADAPTER_EVENTS]) {
    fs.copyFileSync(source, path.join(root, 'scripts', path.basename(source)));
  }
  fs.writeFileSync(path.join(home, '.cache', 'ruvnet-brain', 'active.json'), JSON.stringify({
    generation: 1,
    version: 'test',
    codeRoot: 'versions/test',
  }));
  return path.join(root, 'scripts', 'codex-hook-adapter.mjs');
}

function codex(project, extra = {}) {
  const adapter = seedCodexGeneration();
  return spawnSync(process.execPath, [adapter, 'ground-ruvnet'], {
    cwd: project,
    env: env(project, extra),
    input: JSON.stringify({
      session_id: 'codex-flywheel',
      turn_id: 'turn-1',
      hook_event_name: 'UserPromptSubmit',
      cwd: project,
      prompt: 'hello',
    }),
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function count(output) {
  return output.split(MARKER).length - 1;
}

describe.skipIf(!hasBash || process.platform === 'win32')('flywheel advisory cadence', () => {
  it('emits exactly once per project and local calendar day', () => {
    const first = claude(projects[0]);
    const second = claude(projects[0]);
    const nextDay = claude(projects[0], { RUVNET_FLYWHEEL_DATE: '2026-07-29' });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(nextDay.status).toBe(0);
    expect(count(first.stdout)).toBe(1);
    expect(count(second.stdout)).toBe(0);
    expect(count(nextDay.stdout)).toBe(1);
  });

  it('keeps different project roots independent and stays silent when enabled', () => {
    expect(count(claude(projects[0]).stdout)).toBe(1);
    expect(count(claude(projects[1]).stdout)).toBe(1);
    expect(count(claude(projects[1], { RUFLO_HARNESS_LOOP: '1', RUVNET_FLYWHEEL_DATE: '2026-07-29' }).stdout)).toBe(0);
  });

  it('makes concurrent first claims atomic', async () => {
    const fire = () => new Promise((resolve, reject) => {
      const child = spawn('bash', [GROUND], {
        cwd: projects[0],
        env: env(projects[0]),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout }));
      child.stdin.end(JSON.stringify({ prompt: 'hello' }));
    });
    const results = await Promise.all(Array.from({ length: 8 }, fire));

    expect(results.every((r) => r.status === 0)).toBe(true);
    expect(results.reduce((total, r) => total + count(r.stdout), 0)).toBe(1);
  });

  it('uses the same claim through the Codex lifecycle adapter', () => {
    const first = codex(projects[0]);
    const second = codex(projects[0]);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(count(first.stdout)).toBe(1);
    expect(count(second.stdout)).toBe(0);
    expect(() => JSON.parse(first.stdout)).not.toThrow();
  });
});
