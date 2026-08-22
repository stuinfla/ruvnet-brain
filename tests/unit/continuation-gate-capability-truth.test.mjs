import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
