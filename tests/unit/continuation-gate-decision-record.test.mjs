// ADR-106: a turn that CREATED an ADR in an adopted project must append its AgentDB decision record.
// Driven through the REAL Stop gate process with a REAL JSONL transcript in a REAL git repo.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, tmp } from '../helpers/continuity-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = path.join(ROOT, 'plugin/scripts/continuation-gate.mjs');
afterEach(() => cleanup());

let seq = 0;
const rec = (o) => JSON.stringify(o);
const user = (text) => rec({ type: 'user', message: { role: 'user', content: text } });
function step(name, input, { result = {}, isError = false } = {}) {
  seq += 1; const id = `t${seq}`;
  return [rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] }, toolUseResult: result })];
}
function transcript(dir, ...steps) {
  const file = path.join(dir, `t-${seq}-${Math.random().toString(16).slice(2)}.jsonl`);
  fs.writeFileSync(file, [user('write the ADR for the store layout'), ...steps.flat()].join('\n') + '\n');
  return file;
}
function fire(p, transcriptPath, { host = 'claude', extraEnv = {} } = {}) {
  const r = spawnSync(process.execPath, [GATE], {
    cwd: p.dir, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'Stop', cwd: p.dir, session_id: 's1', stop_hook_active: false,
      last_assistant_message: 'I wrote the ADR.', transcript_path: transcriptPath }),
    env: { ...p.env, USERPROFILE: p.home, RUVNET_HOOK_HOST: host, RUVNET_WORK_LEDGER: path.join(p.home, 'ledger.json'),
      RUVNET_OPEN_ISSUES_FILE: path.join(p.home, 'none.json'), RUVNET_CI_STATUS_FILE: path.join(p.home, 'none.json'),
      RUVNET_CAPABILITY_ROOTS: path.join(p.home, 'caps'), RUVNET_CAPABILITY_LIVE_EVIDENCE: path.join(p.home, 'live.jsonl'),
      RUVNET_EVIDENCE_FILE: path.join(p.home, 'ev.jsonl'), RUVNET_CONTINUATION_COOLDOWN_MS: '1', ...extraEnv },
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe('Stop: decision-record integrity', () => {
  it('asks ONCE for the record when an ADR was created and no --record ran after it', () => {
    const p = adoptedProject();
    const adr = path.join(p.dir, 'docs/adr/0001-layout.md');
    const out = fire(p, transcript(p.dir, step('Write', { file_path: adr, content: '# x' }, { result: { type: 'create' } })));
    const envelope = JSON.parse(out);
    expect(envelope.decision).toBe('block');
    expect(envelope.reason).toMatch(/without appending its AgentDB decision record/);
    expect(envelope.reason).toContain('0001-layout.md');
    expect(envelope.reason).toMatch(/decision-record\.mjs.*--record/);
  });

  it('is satisfied by a later successful --record, and ignores updates and unadopted projects', () => {
    const p = adoptedProject();
    const adr = path.join(p.dir, 'docs/adr/0001-layout.md');
    const created = step('Write', { file_path: adr, content: '# x' }, { result: { type: 'create' } });
    const recorded = step('Bash', { command: 'node "/x/plugin/scripts/decision-record.mjs" --record --what a' });
    expect(fire(p, transcript(p.dir, created, recorded))).toBe('');
    expect(fire(p, transcript(p.dir, step('Write', { file_path: adr, content: '# y' }, { result: { type: 'update' } })))).toBe('');
    const failedRecord = step('Bash', { command: 'node decision-record.mjs --record --what a' }, { isError: true });
    expect(fire(p, transcript(p.dir, created, failedRecord))).toMatch(/decision record/);
    fs.rmSync(path.join(p.dir, '.swarm', 'memory.db'));
    expect(fire(p, transcript(p.dir, created))).toBe('');
  });

  it('claims nothing on Codex (rollout not parsed) and honors the opt-out', () => {
    const p = adoptedProject();
    const t = transcript(p.dir, step('Write', { file_path: path.join(p.dir, 'docs/adr/0002.md'), content: '#' }, { result: { type: 'create' } }));
    expect(fire(p, t, { host: 'codex' })).toBe('');
    expect(fire(p, t, { extraEnv: { RUVNET_DECISION_RECORD_CHECK: 'off' } })).toBe('');
  });
});
