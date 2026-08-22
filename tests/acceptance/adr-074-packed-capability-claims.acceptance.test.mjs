import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
let fixture;

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.error?.message}`);
  }
  return result;
}

function stopCommand(payload, host) {
  const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'plugin', 'hooks',
    host === 'codex' ? 'codex-hooks.json' : 'hooks.json'), 'utf8'));
  return manifest.hooks.Stop[0].hooks[0].command;
}

function installPackedHostFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-074-packed-'));
  const packDir = path.join(root, 'pack');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const versionRoot = path.join(brainHome, 'versions', 'candidate');
  const capabilityRoot = path.join(home, 'capabilities');
  for (const directory of [packDir, project, path.dirname(versionRoot), capabilityRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const packed = checked('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
  const tarball = path.join(packDir, JSON.parse(packed.stdout)[0].filename);
  checked('tar', ['-xzf', tarball, '-C', packDir]);
  const payload = path.join(packDir, 'package');
  fs.cpSync(path.join(payload, 'plugin'), versionRoot, { recursive: true });
  fs.copyFileSync(
    path.join(payload, 'plugin', 'scripts', 'codex-hook-wrapper.mjs'),
    path.join(brainHome, 'codex-hook.mjs'),
  );
  fs.writeFileSync(path.join(brainHome, 'active.json'), JSON.stringify({
    generation: 'candidate',
    version: JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8')).version,
    codeRoot: 'versions/candidate',
  }));

  const skill = path.join(capabilityRoot, 'ruflo', 'ruflo-adr', '0.4.1', 'skills', 'adr-verify', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: adr-verify\ndescription: packed fixture\n---\n');
  const signals = path.join(root, 'signals');
  fs.mkdirSync(signals, { recursive: true });
  fs.writeFileSync(path.join(signals, 'open.json'), '{}\n');

  return {
    root,
    payload,
    project,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_PLUGIN_ROOT: path.join(payload, 'plugin'),
      RUVNET_BRAIN_HOME: brainHome,
      RUVNET_HOOK_HOST: 'claude',
      RUVNET_CAPABILITY_ROOTS: capabilityRoot,
      RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(root, 'live-evidence.jsonl'),
      RUVNET_EVIDENCE_FILE: path.join(root, 'source-evidence.jsonl'),
      RUVNET_WORK_LEDGER: path.join(root, 'ledger.json'),
      RUVNET_OPEN_ISSUES_FILE: path.join(signals, 'open.json'),
      RUVNET_CI_STATUS_FILE: path.join(signals, 'ci.json'),
      RUVNET_CONTINUATION_COOLDOWN_MS: '1',
    },
  };
}

async function seedPackedClaimEvidence() {
  fs.writeFileSync(fixture.env.RUVNET_EVIDENCE_FILE, `${JSON.stringify({
    v: 1,
    id: 'packed-grounding-1',
    ts: new Date().toISOString(),
    query: 'Can Ruflo orchestrate agents?',
    repos: 1,
    sources: [{
      repo: 'ruflo', path: 'src/swarm/coordinator.ts', sha: 'a'.repeat(64), enforceable: true,
      packages: [], origins: [], posture: [], negatives: [], symbols: [{ name: 'orchestrate', pkg: 'ruflo' }],
      claimBinding: { method: 'tight-source-token-pair', query: 'Can Ruflo orchestrate agents?' },
    }],
  })}\n`);
  const evidence = await import(pathToFileURL(path.join(
    fixture.payload, 'plugin', 'scripts', 'capability-claim-evidence.mjs',
  )).href);
  evidence.recordManagedCliObservation({
    toolName: 'ruvnet_cli_help', executable: 'ruflo', argv: ['--help'],
    execution: { code: 0, stdout: 'ruflo v3.38.16', stderr: '', error: null },
    env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: fixture.env.RUVNET_CAPABILITY_LIVE_EVIDENCE },
  });
  evidence.recordManagedCliObservation({
    toolName: 'ruvnet_cli_run', executable: 'ruflo', argv: ['doctor'],
    execution: { code: 0, stdout: 'All checks passed. System healthy.', stderr: '', error: null },
    env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: fixture.env.RUVNET_CAPABILITY_LIVE_EVIDENCE },
  });
}

function firePacked(host, lastAssistantMessage) {
  const input = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: `packed-${host}-${Date.now()}`,
    stop_hook_active: false,
    last_assistant_message: lastAssistantMessage,
    cwd: fixture.project,
  });
  return spawnSync(stopCommand(fixture.payload, host), {
    cwd: fixture.project,
    shell: true,
    input,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...fixture.env,
      RUVNET_HOOK_HOST: host === 'codex' ? 'codex' : 'claude',
    },
  });
}

beforeAll(async () => {
  fixture = installPackedHostFixture();
  await seedPackedClaimEvidence();
}, 120_000);
afterAll(() => fs.rmSync(fixture.root, { recursive: true, force: true }), 120_000);

describe('ADR-074 packed capability-claim enforcement', () => {
  it.each(['claude', 'codex'])('blocks the exact false installed-capability claim through packed %s wiring', (host) => {
    const result = firePacked(host, 'Ruflo ADR Verify is not installed.');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    const reason = host === 'codex'
      ? output.reason
      : output.hookSpecificOutput?.additionalContext;
    expect(host === 'codex' ? output.decision : output.hookSpecificOutput?.hookEventName)
      .toBe(host === 'codex' ? 'block' : 'Stop');
    expect(reason).toContain('ruflo-adr:adr-verify');
    expect(reason).toContain(path.join(fixture.env.RUVNET_CAPABILITY_ROOTS,
      'ruflo', 'ruflo-adr', '0.4.1', 'skills', 'adr-verify', 'SKILL.md'));
  });

  it.each(['claude', 'codex'])('stays silent through packed %s wiring when the claim matches the inventory', (host) => {
    const result = firePacked(host, 'Ruflo ADR Verify is installed.');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
  });

  it.each(['claude', 'codex'])('binds behavior claims to full-SHA source evidence through packed %s wiring', (host) => {
    const accepted = firePacked(host, `Ruflo can orchestrate agents through ${host}.`);
    expect(accepted.status).toBe(0);
    expect(accepted.stderr).toBe('');
    expect(accepted.stdout).toBe('');

    const unknown = firePacked(host, `Ruflo can encrypt databases through ${host}.`);
    expect(unknown.status).toBe(0);
    expect(unknown.stderr).toBe('');
    expect(unknown.stdout).toContain('behavior claim');
    expect(unknown.stdout).toContain('UNKNOWN');
  });

  it.each(['claude', 'codex'])('binds current version and health to fresh live evidence through packed %s wiring', (host) => {
    expect(firePacked(host, `Ruflo current version is 3.38.16 on ${host}.`).stdout).toBe('');
    const mismatch = firePacked(host, `Ruflo current version is 3.37.0 on ${host}.`);
    expect(mismatch.status).toBe(0);
    expect(mismatch.stderr).toBe('');
    expect(mismatch.stdout).toContain('live current version is 3.38.16');

    expect(firePacked(host, `Ruflo is healthy on ${host}.`).stdout).toBe('');
    const contradicted = firePacked(host, `Ruflo is unhealthy on ${host}.`);
    expect(contradicted.status).toBe(0);
    expect(contradicted.stderr).toBe('');
    expect(contradicted.stdout).toContain('contradicts fresh typed evidence');
  });

  it.each(['claude', 'codex'])('keeps latest-version claims UNKNOWN through packed %s wiring without registry proof', (host) => {
    const result = firePacked(host, `Ruflo 3.38.16 is the latest version on ${host}.`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('latest-version claim');
    expect(result.stdout).toContain('UNKNOWN');
  });
});
