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
    // `.swarm/` IS THE OPT-IN, so the test must opt in like a real project does. This line used to
    // be absent and the assertion still passed, because the hook created `.swarm/` itself — which
    // is exactly the trespass ADR-058 D5 removed on 2026-08-14 after the conformance gate caught
    // PreCompact, PostToolUse and SessionEnd each planting a `.swarm/` directory, plus a receipt
    // nobody asked for, in every unrelated repository the owner opened.
    fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
    expect(writeSessionSnapshot(project, 'PreCompact')).toBe(true);
    expect(inspectSessionSnapshots(project)).toMatchObject({ kind: 'canonical', fresh: true });

    const hooks = JSON.parse(fs.readFileSync(path.resolve('plugin/hooks/hooks.json'), 'utf8')).hooks;
    const command = hooks.PreCompact.flatMap((group) => group.hooks)
      .find((hook) => hook.command.includes('session-snapshot PreCompact'));
    expect(command?.command).toMatch(/\|\| true$/);
  });

  it('TEETH: writes NOTHING into a project that never opted in — no .swarm, no receipt', () => {
    // The D5 behaviour had NO test. The hook refusing to conjure `.swarm/` is the entire fix from
    // 2026-08-14, and nothing anywhere asserted it — so a future edit could silently restore the
    // trespass and every suite would stay green. `.swarm` is Ruflo's own convention: its presence
    // is the project's opt-in, its absence is a project that has not adopted the brain. Writing a
    // receipt into a store that exists is participation; creating the store is trespass.
    const stranger = temporary();
    const before = fs.readdirSync(stranger);
    expect(writeSessionSnapshot(stranger, 'PreCompact'), 'must refuse, not create').toBe(false);
    expect(fs.readdirSync(stranger), 'left something behind in a stranger project').toEqual(before);
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
