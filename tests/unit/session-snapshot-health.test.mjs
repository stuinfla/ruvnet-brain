import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SNAPSHOT_SCHEMA,
  SNAPSHOT_VERSION,
  createSessionSnapshot,
  inspectSessionSnapshots,
} from '../../scripts/session-snapshot-contract.mjs';
import { writeSessionSnapshot } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { probeMemory } from '../../scripts/onboarding-console.mjs';

const temps = [];
const temporary = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-snapshot-health-'));
  temps.push(value);
  return value;
};
const NOW = Date.parse('2026-08-02T18:00:00.000Z');

afterEach(() => {
  for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('issue #85 — versioned compaction snapshot contract', () => {
  it('ships a PreCompact producer that writes the same canonical receipt the Console validates', () => {
    const project = temporary();
    expect(writeSessionSnapshot(project, 'PreCompact')).toBe(true);
    expect(inspectSessionSnapshots(project)).toMatchObject({ kind: 'canonical', fresh: true });

    const hooks = JSON.parse(fs.readFileSync(path.resolve('plugin/hooks/hooks.json'), 'utf8')).hooks;
    const command = hooks.PreCompact.flatMap((group) => group.hooks)
      .find((hook) => hook.command.includes('session-snapshot PreCompact'));
    expect(command?.command).toMatch(/\|\| true$/);
  });

  it('accepts a fresh canonical receipt with the documented schema', () => {
    const project = temporary();
    fs.mkdirSync(path.join(project, '.swarm'));
    const receipt = createSessionSnapshot({ event: 'PreCompact', capturedAt: new Date(NOW).toISOString() });
    fs.writeFileSync(path.join(project, '.swarm', 'agentdb-sessions.jsonl'), `${JSON.stringify(receipt)}\n`);

    expect(receipt).toMatchObject({ schema: SNAPSHOT_SCHEMA, version: SNAPSHOT_VERSION });
    expect(inspectSessionSnapshots(project, { now: NOW })).toMatchObject({ kind: 'canonical', fresh: true });
  });

  it.each(['.claude', '.claude-flow'])('accepts a fresh structurally valid %s legacy Ruflo session', (root) => {
    const project = temporary();
    const dir = path.join(project, root, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session-ok.json'), JSON.stringify({
      id: 'session-ok',
      startedAt: new Date(NOW - 1000).toISOString(),
      endedAt: new Date(NOW).toISOString(),
      context: { project: 'fixture' },
      metrics: { tasks: 1 },
    }));
    expect(inspectSessionSnapshots(project, { now: NOW })).toMatchObject({ kind: 'legacy', fresh: true });
    expect(probeMemory(project).compactionSurvival).toMatchObject({ status: 'ok', artifact: 'legacy' });
  });

  it('reports absent, malformed, and stale artifacts without false ok', () => {
    const absent = temporary();
    expect(inspectSessionSnapshots(absent, { now: NOW })).toMatchObject({ kind: 'absent', fresh: false });

    const malformed = temporary();
    fs.mkdirSync(path.join(malformed, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(malformed, '.claude', 'sessions', 'session-bad.json'), '{}');
    expect(inspectSessionSnapshots(malformed, { now: NOW })).toMatchObject({ kind: 'malformed', fresh: false });

    const stale = temporary();
    fs.mkdirSync(path.join(stale, '.swarm'));
    const receipt = createSessionSnapshot({ event: 'PreCompact', capturedAt: '2026-06-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(stale, '.swarm', 'agentdb-sessions.jsonl'), `${JSON.stringify(receipt)}\n`);
    expect(inspectSessionSnapshots(stale, { now: NOW })).toMatchObject({ kind: 'canonical', fresh: false });
  });
});
