import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordManagedCliObservation } from '../../plugin/scripts/capability-claim-evidence.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = path.join(ROOT, 'plugin/scripts/continuation-gate.mjs');
let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-capability-truth-'));
  const skill = path.join(home, 'capabilities/ruflo/ruflo-adr/0.4.1/skills/adr-verify/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: adr-verify\ndescription: fixture\n---\n');
  fs.mkdirSync(path.join(home, 'signals'), { recursive: true });
  fs.writeFileSync(path.join(home, 'signals/open.json'), '{}\n');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function run(lastAssistantMessage, { malformed = false } = {}) {
  if (malformed) {
    const skill = path.join(home, 'capabilities/ruflo/ruflo-adr/0.4.1/skills/adr-verify/SKILL.md');
    fs.writeFileSync(skill, '# no front matter\n');
  }
  const result = spawnSync(process.execPath, [GATE], {
    cwd: ROOT,
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'capability-truth-test',
      stop_hook_active: false,
      last_assistant_message: lastAssistantMessage,
    }),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RUVNET_HOOK_HOST: 'codex',
      RUVNET_WORK_LEDGER: path.join(home, 'ledger.json'),
      RUVNET_OPEN_ISSUES_FILE: path.join(home, 'signals/open.json'),
      RUVNET_CI_STATUS_FILE: path.join(home, 'signals/ci.json'),
      RUVNET_CAPABILITY_ROOTS: path.join(home, 'capabilities'),
      RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(home, 'live-evidence.jsonl'),
      RUVNET_EVIDENCE_FILE: path.join(home, 'source-evidence.jsonl'),
      RUVNET_CONTINUATION_COOLDOWN_MS: '1',
    },
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('continuation gate capability truth', () => {
  it('forces correction when the final answer denies an installed RuvNet skill', () => {
    const output = run('Ruflo ADR Verify is not installed.');
    expect(output).toContain('additionalContext');
    expect(output).toContain('ruflo-adr:adr-verify');
    expect(output).toContain('contradicts the sealed');
  });

  it('stays silent when the installed capability statement matches the receipt', () => {
    expect(run('Ruflo ADR Verify is installed.')).toBe('');
  });

  it('forces UNKNOWN instead of allowing an absence claim from an incomplete inventory', () => {
    const output = run('Ruflo ADR Create is not installed.', { malformed: true });
    expect(output).toContain('additionalContext');
    expect(output).toContain('UNKNOWN');
    expect(output).toContain('inventory is incomplete');
  });

  it('forces UNKNOWN for a behavior claim without exact source evidence and allows the bound claim', () => {
    expect(run('Ruflo can orchestrate agents.')).toContain('behavior claim');
    fs.writeFileSync(path.join(home, 'source-evidence.jsonl'), `${JSON.stringify({
      v: 1,
      id: 'grounding-1',
      ts: new Date().toISOString(),
      query: 'Can Ruflo orchestrate agents?',
      repos: 1,
      sources: [{
        repo: 'ruflo', path: 'src/swarm/coordinator.ts', sha: 'a'.repeat(64), enforceable: true,
        packages: [], origins: [], posture: [], negatives: [], symbols: [{ name: 'orchestrate', pkg: 'ruflo' }],
        claimBinding: { method: 'tight-source-token-pair', query: 'Can Ruflo orchestrate agents?' },
      }],
    })}\n`);
    expect(run('Ruflo can orchestrate agents.')).toBe('');
  });

  it('binds a current-version claim to a fresh managed-CLI receipt and rejects a mismatch', () => {
    const evidence = path.join(home, 'live-evidence.jsonl');
    recordManagedCliObservation({
      toolName: 'ruvnet_cli_help', executable: 'ruflo', argv: ['--help'],
      execution: { code: 0, stdout: 'ruflo v3.38.16', stderr: '', error: null },
      env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: evidence, RUVNET_HOOK_HOST: 'codex' },
    });
    expect(run('Ruflo current version is 3.38.16.')).toBe('');
    const output = run('Ruflo current version is 3.37.0.');
    expect(output).toContain('current-version claim');
    expect(output).toContain('live current version is 3.38.16');
  });

  it('binds health claims and keeps latest-version UNKNOWN without a registry receipt', () => {
    const evidence = path.join(home, 'live-evidence.jsonl');
    recordManagedCliObservation({
      toolName: 'ruvnet_cli_run', executable: 'ruflo', argv: ['doctor'],
      execution: { code: 0, stdout: 'All checks passed. System healthy.', stderr: '', error: null },
      env: { RUVNET_CAPABILITY_LIVE_EVIDENCE: evidence },
    });
    expect(run('Ruflo is healthy.')).toBe('');
    expect(run('Ruflo is unhealthy.')).toContain('contradicts fresh typed evidence');
    const latest = run('Ruflo 3.38.16 is the latest version.');
    expect(latest).toContain('latest-version claim');
    expect(latest).toContain('UNKNOWN');
  });
});
