import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  appendObservation,
  findDispatchDecision,
  observationFrom,
} from '../../plugin/scripts/routing-outcome-capture.mjs';
import { fireHook } from '../../scripts/selfcheck.mjs';

const REAL_SHAPE = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Task',
  tool_use_id: 'toolu_example',
  session_id: 'session_example',
  tool_input: {
    description: 'Investigate test failures root cause',
    prompt: 'Read the actual source and identify why the tests fail.',
    subagent_type: 'researcher',
    model: 'claude-sonnet-4-6',
  },
  tool_response: {
    status: 'completed',
    agentId: 'agent_example',
    content: [{ type: 'text', text: 'Analysis complete.' }],
  },
};
const SHIM = path.resolve(import.meta.dirname, '../../plugin/scripts/hook-shim.mjs');
const REPO = path.resolve(import.meta.dirname, '../..');
const PLUGIN = path.join(REPO, 'plugin');

describe('routing outcome capture uses the verified Task PostToolUse shape', () => {
  it('records host completion as an unverified observation, never a training score', () => {
    const row = observationFrom(REAL_SHAPE, '2026-07-28T00:00:00.000Z');
    expect(row).toMatchObject({
      schema: 'dispatch-observation-v1',
      model: 'claude-sonnet-4-6',
      success: true,
      hostStatus: 'completed',
      verified: false,
      toolUseId: 'toolu_example',
    });
    expect(row.taskHash).toMatch(/^[a-f0-9]{24}$/);
    expect(row).not.toHaveProperty('embedding');
    expect(row).not.toHaveProperty('scores');
  });

  it('ignores unrouted, unknown-status, and unrelated events', () => {
    expect(observationFrom({ ...REAL_SHAPE, tool_input: { description: 'no model' } })).toBeNull();
    expect(observationFrom({ ...REAL_SHAPE, tool_response: { status: 'running' } })).toBeNull();
    expect(observationFrom({ ...REAL_SHAPE, tool_name: 'Bash' })).toBeNull();
  });

  it('appends one parseable JSONL row without exposing the prompt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-routing-observation-'));
    const file = path.join(dir, 'outcomes.jsonl');
    try {
      const row = observationFrom(REAL_SHAPE, '2026-07-28T00:00:00.000Z');
      expect(appendObservation(row, file)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(saved.taskHash).toBe(row.taskHash);
      expect(JSON.stringify(saved)).not.toContain(REAL_SHAPE.tool_input.prompt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('joins the PostToolUse observation to its PreToolUse dispatch declaration by tool-use id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-routing-join-'));
    const file = path.join(dir, 'dispatch-log.jsonl');
    try {
      fs.writeFileSync(file, [
        JSON.stringify({ event: 'dispatch', toolUseId: 'other', model: 'haiku' }),
        JSON.stringify({
          event: 'dispatch',
          toolUseId: 'toolu_example',
          sessionId: 'session_example',
          model: 'claude-sonnet-4-6',
        }),
      ].join('\n'));
      const decision = findDispatchDecision('toolu_example', file);
      const row = observationFrom(REAL_SHAPE, '2026-07-28T00:00:00.000Z', decision);
      expect(row).toMatchObject({
        decisionLinked: true,
        decisionModel: 'claude-sonnet-4-6',
        decisionModelMatch: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs through the registered hook-shim boundary and writes the linked observation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-routing-shim-'));
    const outcomes = path.join(dir, 'routing-outcomes.jsonl');
    const dispatches = path.join(dir, 'dispatch-log.jsonl');
    fs.writeFileSync(dispatches, JSON.stringify({
      event: 'dispatch',
      toolUseId: 'toolu_example',
      model: 'claude-sonnet-4-6',
    }) + '\n');
    try {
      const result = spawnSync(process.execPath, [SHIM, 'routing-outcome'], {
        input: JSON.stringify(REAL_SHAPE),
        env: {
          ...process.env,
          HOME: dir,
          MODEL_ROUTER_OUTCOMES: outcomes,
          MODEL_ROUTER_DISPATCH_LOG: dispatches,
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(JSON.parse(fs.readFileSync(outcomes, 'utf8'))).toMatchObject({
        schema: 'dispatch-observation-v1',
        decisionLinked: true,
        decisionModelMatch: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the explicit observer exits when its caller leaves stdin open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-routing-held-'));
    const command = `node ${JSON.stringify(path.join(PLUGIN, 'scripts/routing-outcome-capture.mjs'))}`;

    try {
      const measurement = await fireHook({
        command,
        event: 'PostToolUse',
        regime: 'held',
        timeoutSec: 1,
        graceMs: 100,
        cwd: REPO,
        env: {
          RUVNET_BRAIN_HOME: path.join(dir, 'brain-home'),
          RUVNET_BRAIN_STATE_DIR: path.join(dir, 'brain-state'),
        },
      });

      expect(measurement.timedOut, measurement.stderr).toBe(false);
      expect(measurement.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not use the Windows-blocking synchronous stdin reader', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-routing-win32-stdin-'));
    const preload = path.join(dir, 'block-sync-stdin.mjs');
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      'const original = fs.readFileSync;',
      'fs.readFileSync = function (file, ...args) {',
      '  if (file === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
      '  return original.call(this, file, ...args);',
      '};',
      '',
    ].join('\n'));
    const body = path.join(PLUGIN, 'scripts/routing-outcome-capture.mjs');
    const command = `"${process.execPath}" --import "${preload}" "${body}" || true`;

    try {
      const measurement = await fireHook({
        command,
        event: 'PostToolUse',
        regime: 'held',
        timeoutSec: 1,
        graceMs: 100,
        cwd: REPO,
      });
      expect(measurement.timedOut, measurement.stderr).toBe(false);
      expect(measurement.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
